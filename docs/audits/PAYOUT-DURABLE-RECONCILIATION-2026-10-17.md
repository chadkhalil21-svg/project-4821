# Operator payout safety proposal — 17 October 2026
Status: **draft, not commissioned, not deployed**, no real money actions.

## Financial problem
The previous three payment entry points called Stripe transfers with a stable idempotency key but only recorded the transfer in Firestore afterward. Stripe may prune the key after 24 hours. A transfer that executed while the Firestore update failed could then be repeated, and the app-open `/operator/settle-pending` query scanned all historical Travels.

## Proposed safeguards
- Every *new* Travel is marked `payoutLedgerVersion:1` at authoritative creation time. Old records are not retroactively marked safe.
- Every transfer enters a Firestore `payout_ledger/{rideId}` transaction *before* the provider call. The first claimant alone may call create. Others may reconcile using Stripe's `transfer_group` and full matching Stripe metadata, destination, exact source charge and amount.
- Once a claim exists, no later request creates a second transfer, even after >24 hours. If Stripe is unavailable, an API call timed out, the history conflicts or reconciliation is inconclusive, the Transfer is **unconfirmed** and must be reviewed. False negatives mean delayed payment, never a double payout.
- Both ledger and Travel record are updated atomically on Stripe-confirmed success. A crash after Stripe success but before the database transaction can recover the *same* Stripe transfer.
- Operator-app startup makes a read-only bounded (100-record) historical census; it no longer runs a write-heavy, unbounded transfer batch. Any unreviewed old history or incomplete page is explicitly **unconfirmed**, not a false zero debt.
- Normal background settlement still reviews `needsPayout` flags in limited pages and uses the shared payment guard.

## Required commissioning before merge or rollout
1. Inspect the actual production Stripe account and Firebase project using authorized, read-only access. These identities have not been confirmed against each other.
2. Complete the historical `payout-recovery-census.js` across **every page** and reconcile every old missing transferId with Stripe transfers (including payments predating `transfer_group`). Proof of *zero debt* requires both full census and Stripe reconciliation. Do not automatically retry any old record.
3. Verify new payout ledger Firestore rules (server-only Admin writes), indices, test-mode Stripe transfers, concurrent and crashed transactions, live server compatibility with the app and account changes.
4. Verify server safety, reimbursement, transfers and receipts against sandbox only, twice. No production card charge, payout, backfill write, billing change or market activation is performed by this draft.
5. Only then carefully merge to `release/current`, re-run exact-head checks, deploy when Render build capacity allows, and complete real-device Travel checks.

## Limitations
This is deliberately conservative: if an attempt failed before Stripe received it, automatic retry remains paused for human reconciliation. This is necessary until a source-of-truth mechanism can prove definitively that Stripe did not execute. Stripe transfer ID alone is not proof of bank deposit.

Source: https://docs.stripe.com/api/idempotent_requests, https://docs.stripe.com/api/transfers/list, https://docs.stripe.com/api/transfers/create; https://firebase.google.com/docs/firestore/transactions, https://firebase.google.com/docs/firestore/pricing.
