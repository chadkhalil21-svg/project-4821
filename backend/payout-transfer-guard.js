'use strict';

/**
 * Cross-system Operator payout guard.
 *
 * A Stripe idempotency key alone is NOT a permanent exactly-once guarantee.
 * A Firestore transaction records an attempt before Stripe is contacted. Once
 * an attempt is recorded, ONLY reconciliation can complete it: absence of a
 * transfer is never permission to create a second transfer automatically.
 *
 * Legacy Travels lacking payoutLedgerVersion are NOT silently marked safe.
 * Their source-of-truth Stripe transfers require a separate historical census.
 */
const VERSION = 1;
const uncertain = (code = 'payout_reconciliation_required') => ({
  ok: false, code, retryable: false, unconfirmed: true,
  error: 'Operator transfer requires verified reconciliation before another payment attempt.',
});
const groupFor = (rideId) => 'ar_travel_' + String(rideId || '');

function checkTransfer(transfer, { rideId, paymentIntentId, operatorStripeAccount, chargeId, amountCents, group }) {
  return !!transfer && typeof transfer.id === 'string' &&
    transfer.currency === 'usd' &&
    transfer.transfer_group === group &&
    transfer.destination === operatorStripeAccount &&
    transfer.source_transaction === chargeId &&
    transfer.amount === amountCents &&
    transfer.metadata?.rideId === rideId &&
    transfer.metadata?.paymentIntentId === paymentIntentId &&
    transfer.reversed !== true && Number(transfer.amount_reversed || 0) === 0;
}

async function transferOnce({
  db, rideId, paymentIntentId, expectedUid, operatorStripeAccount, chargeId,
  amountCents, platformTake, paidWith, findTransfers, createTransfer, now = Date.now(),
}) {
  if (!db || typeof db.runTransaction !== 'function' || !/^[a-f0-9]{40}$/.test(String(rideId || '')) ||
    !paymentIntentId || !expectedUid || !operatorStripeAccount || !chargeId ||
    !Number.isSafeInteger(amountCents) || amountCents <= 0 ||
    typeof findTransfers !== 'function' || typeof createTransfer !== 'function')
    return uncertain('payout_authority_missing');

  const ref = db.collection('rides').doc(rideId);
  const ledgerRef = db.collection('payout_ledger').doc(rideId);
  const group = groupFor(rideId);
  let initial;
  try {
    initial = await db.runTransaction(async tx => {
      const rideSnap = await tx.get(ref);
      const ride = rideSnap.exists ? rideSnap.data() || {} : null;
      if (!ride || ride.status !== 'completed' ||
        ride.payoutLedgerVersion !== VERSION ||
        ride.paymentIntentId !== paymentIntentId ||
        ride.travelerUid !== String(expectedUid) || !ride.operatorId)
        return { code: 'legacy_or_invalid_payout' };
      const ledgerSnap = await tx.get(ledgerRef);
      const ledger = ledgerSnap.exists ? ledgerSnap.data() || {} : null;
      if (ledger && (ledger.paymentIntentId !== paymentIntentId ||
        ledger.accountId !== operatorStripeAccount || ledger.chargeId !== chargeId ||
        ledger.amountCents !== amountCents || ledger.operatorId !== ride.operatorId))
        return { code: 'payout_identity_conflict' };
      if (ride.transferId) {
        if (ledger?.transferId && ledger.transferId !== ride.transferId)
          return { code: 'payout_identity_conflict' };
        return { already: ride.transferId, amountCents: Number(ride.operatorPaidCents) || amountCents };
      }
      if (ledger) return { newAttempt: false };
      tx.create(ledgerRef, {
        version: VERSION, rideId, operatorId: ride.operatorId, paymentIntentId,
        accountId: operatorStripeAccount, chargeId, amountCents, group,
        state: 'unconfirmed', startedAt: now,
      });
      return { newAttempt: true };
    });
  } catch {
    return uncertain('payout_ledger_unavailable');
  }

  if (initial.code) return uncertain(initial.code);
  if (initial.already) return {
    ok: true, alreadySettled: true, transferId: initial.already,
    amountCents: initial.amountCents, operatorGets: initial.amountCents,
    platformTake, paidWith,
  };

  // Read-only Stripe verification MUST happen before a new payout, too.
  // A timeout or ambiguous transfer identity must never authorize money.
  let existing;
  try {
    const found = await findTransfers(group);
    if (!found || !Array.isArray(found.data) || found.has_more ||
      found.data.length > 1) return uncertain('payout_provider_ambiguous');
    existing = found.data[0] || null;
  } catch {
    return uncertain('payout_provider_unavailable');
  }
  if (existing && !checkTransfer(existing, {
    rideId, paymentIntentId, operatorStripeAccount, chargeId, amountCents, group,
  })) return uncertain('payout_provider_mismatch');

  // If a previous attempt was initiated, the only safe automatic action is
  // verifying an existing Stripe transfer, never creating another one.
  if (!existing && !initial.newAttempt) return uncertain('payout_attempt_unconfirmed');

  let transfer = existing;
  if (!transfer) {
    try {
      transfer = await createTransfer(group);
    } catch {
      // Stripe may have completed the transfer before the request timed out.
      return uncertain('payout_creation_unconfirmed');
    }
    if (!checkTransfer(transfer, {
      rideId, paymentIntentId, operatorStripeAccount, chargeId, amountCents, group,
    })) return uncertain('payout_created_identity_unconfirmed');
  }

  try {
    const done = await db.runTransaction(async tx => {
      const [rideSnap, ledgerSnap] = await Promise.all([tx.get(ref), tx.get(ledgerRef)]);
      if (!rideSnap.exists || !ledgerSnap.exists) return false;
      const ride = rideSnap.data() || {}, ledger = ledgerSnap.data() || {};
      if (ride.status !== 'completed' || ride.paymentIntentId !== paymentIntentId ||
        ride.operatorId !== ledger.operatorId ||
        ledger.accountId !== operatorStripeAccount || ledger.chargeId !== chargeId ||
        ledger.amountCents !== amountCents ||
        (ride.transferId && ride.transferId !== transfer.id) ||
        (ledger.transferId && ledger.transferId !== transfer.id)) return false;
      tx.set(ledgerRef, {
        state: 'transferred', transferId: transfer.id, verifiedAt: Date.now(),
      }, { merge: true });
      tx.set(ref, {
        transferId: transfer.id, operatorPaidCents: amountCents,
        platformTakeCents: platformTake, payoutPending: false,
        payoutBlockedReason: null, needsPayout: false,
        settledAt: Date.now(), ...(paidWith ? { paidWith } : {}),
      }, { merge: true });
      return true;
    });
    if (!done) return uncertain('payout_reconciliation_conflict');
  } catch {
    // Reconciliation on a later attempt will rediscover the Stripe transfer.
    return uncertain('payout_record_unconfirmed');
  }
  return { ok: true, transferId: transfer.id, amountCents,
    operatorGets: amountCents, platformTake, paidWith, reconciled: !!existing };
}
module.exports = { transferOnce, checkTransfer, groupFor, VERSION };
