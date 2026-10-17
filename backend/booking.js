const { createHash } = require('node:crypto');
const { matchOperator, distanceMiles } = require('./matching');
const { ageOn, MIN_AGE, MAX_AGE } = require('./family');
const { marketFor } = require('./markets');

const deny = (status, code, error) => ({ status, body: { ok: false, code, error } });
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const bookingId = (uid, key) => digest(`ar-booking-v1:${uid}:${key}`).slice(0, 40);

/** Persist the server's quote and party BEFORE giving the device a payment secret. */
async function prepareBooking({ db, uid, key, fingerprint, record, now = Date.now() }) {
  if (typeof key !== 'string' || !/^[\w-]{16,100}$/.test(key)) {
    return deny(400, 'booking_key_required', 'A booking key is required');
  }
  const id = bookingId(uid, key);
  const ref = db.collection('rides').doc(id);
  return db.runTransaction(async (tx) => {
    const account = await tx.get(db.collection('account_closures').doc(String(uid)));
    if(account.exists&&account.data()?.closingAt)
      return deny(409,'account_closing','Account closure is in progress');
    const snap = await tx.get(ref);
    if (snap.exists) {
      const previous = snap.data();
      if (previous.travelerUid !== String(uid) || previous.bookingFingerprint !== fingerprint) {
        return deny(409, 'booking_conflict', 'This booking key belongs to a different Travel');
      }
      return { status: 200, body: { rideId: id, tripNo: previous.tripNo, status: previous.status, reused: true } };
    }
    // A Smart second car may consume the paid first Travel exactly once.
    // Use the original Travel as the single authority: one indexed document read,
    // one atomic update, no new collection or background cleanup. Concurrent
    // bookings on other phones cannot both claim the same first Travel.
    let firstRef = null;
    if (record.journey) {
      const firstId = String(record.journey.leg1RideId || '');
      if (!/^[a-f0-9]{40}$/.test(firstId) || firstId === id) {
        return deny(409, 'smart_continuation_invalid', 'The first Travel cannot be verified');
      }
      firstRef = db.collection('rides').doc(firstId);
      const firstSnap = await tx.get(firstRef);
      const first = firstSnap.exists ? firstSnap.data() : null;
      const completedAt = first?.completedAt;
      if (!first || first.travelerUid !== String(uid) ||
          first.tripNo !== record.journey.journeyNo ||
          first.status !== 'completed' || !first.paymentIntentId ||
          !Number.isSafeInteger(completedAt) || completedAt > now ||
          now - completedAt > 48 * 60 * 60 * 1000 ||
          first.journey || first.journeyNo ||
          first.refundId || first.refundPending ||
          Number(first.travelCostCents) !== Number(record.journey.leg1FareCents)) {
        return deny(409, 'smart_continuation_invalid', 'The completed first Travel is no longer valid');
      }
      if (first.smartContinuationRideId) {
        return deny(409, 'smart_continuation_exists', 'The first Travel already has its second car reserved');
      }
    }
    tx.create(ref, {
      ...record,
      travelerUid: String(uid),
      bookingFingerprint: fingerprint,
      // Only newly created Travels may initiate the durable guarded transfer path.
      // Legacy history must first be checked against Stripe, never silently re-keyed.
      payoutLedgerVersion: 1,
      status: 'awaiting_payment',
      createdAt: now,
      statusAt: now,
    });
    if (firstRef) tx.update(firstRef, { smartContinuationRideId: id, smartContinuationAt: now });
    return { status: 201, body: { rideId: id, tripNo: record.tripNo, status: 'awaiting_payment', reused: false } };
  });
}

/** A Stripe success is necessary but not sufficient: the PI must belong to this exact priced Travel. */
function paymentMatches(ride, payment, uid, rideId) {
  return !!payment && payment.status === 'succeeded' &&
    payment.metadata?.uid === String(uid) &&
    payment.metadata?.rideId === String(rideId) &&
    payment.id === String(ride.paymentIntentId || '') &&
    Number(payment.amount_received) === Number(ride.costCents) &&
    Number(payment.amount_received) > 0 &&
    payment.currency === 'usd';
}

/**
 * Bind one verified paid Travel to one still-available Operator in one Firestore transaction.
 * A simultaneous Traveler cannot reserve that Operator; a retry cannot create a new Travel.
 * `payment` is a freshly retrieved provider object (not the mobile app's claim).
 */
async function assignPaidTravel({ db, uid, rideId, payment, candidate, now = Date.now(), requireScreening = true }) {
  const ref = db.collection('rides').doc(String(rideId));
  const opRef = candidate ? db.collection('operators').doc(String(candidate.operator.id)) : null;
  return db.runTransaction(async (tx) => {
    const account = await tx.get(db.collection('account_closures').doc(String(uid)));
    if(account.exists&&account.data()?.closingAt)
      return deny(409,'account_closing','Account closure is in progress');
    const rideSnap = await tx.get(ref);
    if (!rideSnap.exists) return deny(404, 'no_travel', 'No such Travel');
    const ride = rideSnap.data();
    if (String(ride.travelerUid) !== String(uid)) return deny(403, 'not_yours', 'This Travel belongs to another Traveler');
    // County service comes from configured geography; payment and individual Operator
    // eligibility remain checked below within this same assignment transaction.
    const market = marketFor({ lat: ride.pickupLat, lng: ride.pickupLng });
    if (market?.status !== 'active')
      return deny(409, 'outside_market', 'Travel is not available from this pickup');
    if (ride.party?.teen && (!ride.teenPickup?.required || !/^[0-9a-f]{64}$/.test(String(ride.teenPickup.hash || '')))) {
      return deny(409, 'teen_pin_unavailable', 'Teen pickup code has not been securely prepared');
    }
    if (ride.party?.teen && !ride.party.continuedFromJourneyNo) {
      const linkId = String(ride.party.familyLinkId || '');
      if (!linkId) return deny(409, 'family_authorization_required', 'Family authorization is not available');
      const linkSnap = await tx.get(db.collection('family_links').doc(linkId));
      const link = linkSnap.exists ? linkSnap.data() : null;
      const age = ageOn(link?.teenDob, now);
      if (!link || link.status !== 'active' || age === null || age < MIN_AGE || age > MAX_AGE ||
          String(link.guardianUid) !== String(ride.party.guardianUid) ||
          String(link.teenUid) !== String(ride.party.teenUid)) {
        return deny(409, 'family_authorization_revoked', 'Family authorization is no longer active');
      }
    }
    if (ride.status === 'assigned' && ride.operatorId && !ride.releasedAt) {
      if (!paymentMatches(ride, payment, uid, rideId)) return deny(409, 'payment_unconfirmed', 'Payment is not confirmed for this Travel');
      return { status: 200, body: { rideId, tripNo: ride.tripNo, matched: operatorView(ride), reused: true } };
    }
    const released = ride.status === 'assigned' && !!ride.releasedAt;
    if (!released && !['awaiting_payment', 'awaiting_assignment'].includes(ride.status)) {
      return deny(409, 'travel_not_dispatchable', 'This Travel cannot be dispatched');
    }
    if (!paymentMatches(ride, payment, uid, rideId)) {
      return deny(409, 'payment_unconfirmed', 'Payment is not confirmed for this Travel');
    }
    if (!candidate) {
      if (released) return deny(409, 'reoffer_pending', 'A released offer awaits another Operator');
      tx.update(ref, { status: 'awaiting_assignment', paidAt: ride.paidAt || now, statusAt: now });
      return { status: 200, body: { rideId, tripNo: ride.tripNo, matched: null, paymentConfirmed: true } };
    }
    const opSnap = await tx.get(opRef);
    const op = opSnap.exists ? opSnap.data() : null;
    const from = { lat: Number(ride.pickupLat), lng: Number(ride.pickupLng) };
    let queueAfterRideId = null;
    let queueEligible = false;
    if (op?.currentRideId && !op.nextRideId) {
      const activeRef = db.collection('rides').doc(String(op.currentRideId));
      const activeSnap = await tx.get(activeRef);
      const active = activeSnap.exists ? activeSnap.data() || {} : {};
      const here = { lat: Number(op.lat), lng: Number(op.lng) };
      const destination = { lat: Number(active.destinationLat), lng: Number(active.destinationLng) };
      queueEligible = active.status === 'onboard' &&
        Number.isFinite(here.lat) && Number.isFinite(here.lng) &&
        Number.isFinite(destination.lat) && Number.isFinite(destination.lng) &&
        distanceMiles(here, destination) <= 3;
      if (queueEligible) queueAfterRideId = String(op.currentRideId);
    }
    const valid = op && matchOperator(
      [{ ...op, id: opRef.id, queueEligible }], from, ride.travelClass || 'Standard',
      { requireScreening, now, allowQueued: true, travelMinutes: ride.routedMinutes ?? null },
    );
    if (!valid || String(valid.operator.id) !== String(candidate.operator.id)) {
      return deny(409, 'operator_unavailable', 'That Operator is no longer available');
    }
    const fields = {
      status: 'assigned', statusAt: now, paidAt: ride.paidAt || now,
      operatorId: opRef.id, operatorName: op.name || '', operatorCar: op.car || '',
      operatorPlate: op.plate || '', operatorLat: Number(op.lat), operatorLng: Number(op.lng),
      operatorEtaMin: valid.etaMin, operatorMiles: valid.miles, operatorDemo: false,
      offeredAt: now, notifiedOperatorAt: null, releasedAt: null, releasedReason: null,
      ...(queueAfterRideId ? { queuedAfterRideId: queueAfterRideId } : {}),
      ...(released ? { declinedBy: [...new Set([...(Array.isArray(ride.declinedBy) ? ride.declinedBy : []), String(ride.operatorId)])] } : {}),
    };
    if (released && ride.operatorId && String(ride.operatorId) !== opRef.id) {
      const oldRef = db.collection('operators').doc(String(ride.operatorId));
      const oldSnap = await tx.get(oldRef);
      if (oldSnap.exists) {
        const old = oldSnap.data() || {};
        if (String(old.currentRideId || '') === String(rideId)) {
          tx.update(oldRef, { currentRideId: null, reservedAt: null });
        } else if (String(old.nextRideId || '') === String(rideId)) {
          tx.update(oldRef, { nextRideId: null, nextReservedAt: null });
        }
      }
    }
    tx.update(opRef, queueAfterRideId
      ? { nextRideId: String(rideId), nextReservedAt: now }
      : { currentRideId: String(rideId), reservedAt: now });
    tx.update(ref, fields);
    return { status: 200, body: { rideId, tripNo: ride.tripNo, matched: operatorView(fields) } };
  });
}

function operatorView(ride) {
  return {
    id: String(ride.operatorId), name: ride.operatorName || '',
    car: ride.operatorCar || '', plate: ride.operatorPlate || '',
    lat: Number(ride.operatorLat), lng: Number(ride.operatorLng),
    etaMin: Number(ride.operatorEtaMin) || 0, miles: Number(ride.operatorMiles) || 0,
    demo: ride.operatorDemo === true,
  };
}

module.exports = { bookingId, prepareBooking, paymentMatches, assignPaidTravel };
