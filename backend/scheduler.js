// American Rider — the clock behind scheduled travel.
//
// WHAT WAS WRONG, FOR THREE WEEKS. A traveler could reserve travel for 6:30 AM. The
// reservation was written to `scheduled_rides`, read back on the next launch, and shown on
// the home screen. Nothing anywhere ever read that collection again. No operator was told, no
// travel was created, and at 6:30 AM precisely nothing happened. The reservation was a note
// to self with a receipt-like appearance — the app remembered the appointment and the company
// did not keep it.
//
// This file is the half that was missing. It wakes up, finds reservations that are nearly
// due, matches an operator, takes the money, and creates the travel — the same `rides`
// document the live booking path creates, so everything downstream (the operator's inbox, the
// traveler's live screen, settlement, the receipt) works with no further change.
//
// ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER
//   1. claim   — mark the reservation as being worked on, so two sweeps cannot both take it
//   2. match   — find an operator BEFORE any money moves
//   3. charge  — off-session, against the card on file, keyed on the reservation id
//   4. write   — create the travel only once someone is coming AND it has been paid for
// Charging before matching would take money for a journey with nobody to drive it. Writing
// before charging would send an operator to a journey nobody has paid for. Neither is
// recoverable by an apology.
//
// WHERE IT RUNS. An in-process interval, plus POST /scheduled/sweep so an external pinger can
// drive it. On a free Render instance the process sleeps when idle and an interval sleeps with
// it, so the ping is not a nicety — it is what makes the free tier work at all. See
// docs/SCHEDULED-TRAVEL.md.
const { nearbyOperatorCandidates } = require('./geooperators');
const { matchOperator, etaMinutes, coverageLapsed } = require('./matching');
const { screeningReady } = require('./screening');
const { adminDb, adminStatus } = require('./firebase-admin');
const { chargeScheduledTravel, verifiedTravelPayment, quote, operatorPayoutAccount, connectAccountStatus } = require('./payments');
const { bookingId, prepareBooking, assignPaidTravel } = require('./booking');
const { createHash, randomUUID } = require('node:crypto');
const { assessOperator } = require('./qualification');
const { fileTicket } = require('./tickets');
const { notify } = require('./push');
const { activeFamilyLink } = require('./family');
const { provisionTeenPin } = require('./teenpickup');
const { readKey } = require('./env');

// How far ahead a reservation enters consideration. Inside this window it is looked at on
// every sweep; outside it, it is not read at all.
const WINDOW_MS = 25 * 60 * 1000;

// Padding on top of the matched operator's own ETA. An operator 4 minutes away and an
// operator 15 minutes away must not be dispatched at the same moment — the point of a
// scheduled travel is that the car is there AT the appointed time, not that it sets off then.
const ARRIVAL_BUFFER_MIN = 3;

// How long past the appointed time we keep trying before telling the traveler plainly that
// nobody could be found. A reservation that quietly stays "reserved" forever is the same
// defect as the one this file exists to fix.
const GRACE_MS = 10 * 60 * 1000;

// A claim that is never released — a crash between claim and write — must not strand the
// reservation. Anything claimed longer ago than this is treated as unclaimed again.
const CLAIM_STALE_MS = 3 * 60 * 1000;

// coverageLapsed used to be DEFINED here, under a comment saying it mirrored dispatch.ts.
// It now lives in matching.js beside the dispatch rules it belongs to — see the note there
// for what mirroring cost us in monitor.js.

/**
 * One pass over everything due.
 *
 * Returns a report rather than logging and forgetting, so /scheduled/sweep can answer with it
 * and the founders can see what the clock actually did.
 *
 * Never throws. A sweep that dies takes every later sweep with it when it runs on an interval.
 */
async function sweepScheduled({ now = Date.now(), checkMarket } = {}) {
  const db = adminDb();
  if (!db) return { ok: false, reason: adminStatus().reason, considered: 0 };

  const liveMoney = String(readKey('DEPLOYMENT_MODE') || '').toLowerCase() === 'production' ||
    /^(sk|rk)_live_/.test(readKey('STRIPE_SECRET_KEY') || '');
  const admitted = async (pickup) => {
    if (!liveMoney) return true;
    if (typeof checkMarket !== 'function') return false;
    try { return (await checkMarket(pickup)) === 'active'; }
    catch { return false; }
  };

  const report = { ok: true, considered: 0, dispatched: [], waiting: 0, failed: [] };
  if (!await recoverStaleClaims(db, now, report)) return { ...report, ok: false };

  let due;
  try {
    // Status + due time uses the declared composite index. Without the index, return a loud
    // failure; an arbitrary first 100 reserved records can starve the actually due bookings.
    const snap = await db
      .collection('scheduled_rides')
      .where('status', '==', 'reserved')
      .orderBy('atMs', 'asc')
      .limit(RESERVED_SCAN_LIMIT)
      .get();
    if (snap.docs.length >= RESERVED_SCAN_LIMIT) report.overCapacity = true;
    due = snap.docs.filter((d) => {
      const r = d.data();
      return typeof r.atMs === 'number' && r.atMs - now <= WINDOW_MS;
    });
  } catch (e) {
    return { ok: false, reason: `could not read reservations: ${e.message}`, considered: 0 };
  }

  if (!due.length) return report;
  report.considered = due.length;

  // Candidate retrieval is geographic and bounded per reservation. Reading the entire fleet
  // once was cheaper than once per reservation, but still O(fleet) and therefore not scalable.
  const taken = new Set();

  for (const docSnap of due) {
    const r = docSnap.data();
    const id = docSnap.id;
    const late = now > r.atMs + GRACE_MS;

    const pickup = { lat: Number(r.pickupLat), lng: Number(r.pickupLng) };
    const havePickup = Number.isFinite(pickup.lat) && Number.isFinite(pickup.lng);

    // A reservation written before this file existed has no pickup on it and cannot be
    // dispatched. Said plainly on the record rather than retried forever.
    if (!havePickup) {
      await close(db, id, 'unmatched', 'This reservation was made before automatic dispatch and has no pickup on it.');
      report.failed.push({ id, reason: 'no pickup coordinates' });
      continue;
    }

    if (!await admitted(pickup)) {
      // Keep the reservation visible and uncharged. Closure/refunds and already-running rides
      // continue independently; a lapse must never be reported as "no Operator available".
      await touch(db, id, { lastSweepAt: now, lastSweepResult: 'market admission unavailable' });
      report.failed.push({ id, reason: 'market admission unavailable; no charge requested' });
      continue;
    }

    let fleet = [];
    try {
      fleet = await nearbyOperatorCandidates(db, pickup, { excludeIds: taken });
    } catch (e) {
      report.failed.push({ id, reason: `could not read nearby Operators: ${e.message}` });
      continue;
    }
    const match = matchOperator(
      fleet,
      pickup,
      r.travelClass || 'Standard',
      // The screening gate: once a provider is live, only operators with a recorded pass.
      { requireScreening: screeningReady() },
    );

    if (!match) {
      if (late) {
        await close(db, id, 'unmatched', 'No operator was available at the time you reserved.');
        await notify({
          uid: r.travelerUid,
          kind: 'scheduled_failed',
          title: 'No operator was available',
          body: `Your ${r.time || ''} ${r.period || ''} travel could not be filled. Nothing was charged.`.replace(/\s+/g, ' ').trim(),
          data: { screen: '/', tripNo: r.tripNo || '' },
        });
        report.failed.push({ id, reason: 'nobody available' });
      } else {
        await touch(db, id, { lastSweepAt: now, lastSweepResult: 'no operator available' });
        report.waiting++;
      }
      continue;
    }

    // THE DISPATCH MOMENT. Not "when the travel is due" — when this operator has to leave in
    // order to be there when it is due.
    const leaveBy = r.atMs - (match.etaMin + ARRIVAL_BUFFER_MIN) * 60 * 1000;
    if (now < leaveBy && !late) {
      await touch(db, id, {
        lastSweepAt: now,
        lastSweepResult: `holding — nearest operator is ${match.etaMin} min away`,
      });
      report.waiting++;
      continue;
    }

    // ---- 1. Claim it. -----------------------------------------------------------------
    const claimed = await claim(db, id, now);
    if (!claimed) {
      report.waiting++;
      continue;
    }

    // Family authorization is revalidated at dispatch time, not trusted from reservation time.
    if (r.party?.teen === true) {
      const link = await activeFamilyLink({ id: r.party.familyLinkId, guardianUid: r.party.guardianUid, now: Date.now() });
      if (!link || String(link.teenUid) !== String(r.party.teenUid)) {
        await touchClaimed(db, id, claimed, {status:'unmatched',claimedAt:null,claimNonce:null,
          closedReason:'Family authorization is no longer active.',closedAt:Date.now()});
        report.failed.push({ id, reason: 'Family authorization revoked or expired' });
        continue;
      }
    }

    // Re-run the same authoritative duty assessment used by immediate Travel immediately
    // before money moves. Matching fields are only a candidate filter; they are not proof that
    // documents, screening, disclosure, account state and Stripe payouts still stand.
    try {
      const [userSnap, opSnap] = await Promise.all([
        db.collection('users').doc(String(match.operator.id)).get(),
        db.collection('operators').doc(String(match.operator.id)).get(),
      ]);
      const user = userSnap.exists ? userSnap.data() : null;
      const payout = await connectAccountStatus(user?.stripeAccountId || null);
      const assessment = assessOperator({
        user,
        fleet: opSnap.exists ? opSnap.data() : null,
        context: 'accept',
        liveMoney: true,
        account: { disabled: false },
        payouts: { enabled: !!payout.payoutsEnabled },
        now,
      });
      if (!assessment.eligible) {
        const first = assessment.blockers[0];
        await touchClaimed(db, id, claimed, { status:'reserved', claimedAt: null, claimNonce:null,
          lastSweepAt: now, lastSweepResult: `operator ineligible: ${first.code}` });
        await db.collection('operators').doc(String(match.operator.id)).set(
          { available: false, offDutyReason: first.code, offDutyAt: now },
          { merge: true },
        );
        report.waiting++;
        continue;
      }
    } catch (e) {
      await touchClaimed(db, id, claimed, { status:'reserved', claimedAt: null, claimNonce:null,
        lastSweepAt: now, lastSweepResult: 'operator eligibility unavailable' });
      report.failed.push({ id, reason: `operator eligibility unavailable: ${e.message}` });
      continue;
    }

    // ---- 2. Prepare one immutable Travel BEFORE moving money. ------------------------
    const fareCents = Number(r.travelCostCents);
    if (!Number.isFinite(fareCents) || fareCents <= 0) {
      await touchClaimed(db,id,claimed,{status:'unmatched',claimedAt:null,claimNonce:null,
        closedReason:'This reservation has no price on it and cannot be dispatched.',closedAt:Date.now()});
      report.failed.push({ id, reason: 'no fare on the reservation' });
      continue;
    }
    const tollCents = Math.max(0, Number(r.tollCents) || 0);
    const billed = quote(fareCents, undefined, Array.isArray(r.feeLines) ? r.feeLines : [],
      r.cardCountry || null, tollCents).travelerPays;
    if (Number(r.costCents) !== billed) {
      await touchClaimed(db,id,claimed,{status:'price_changed',claimedAt:null,claimNonce:null,
        closedReason:'The saved fare is no longer the quoted total. No charge was made.',closedAt:Date.now()});
      report.failed.push({ id, reason: 'scheduled price changed before charge' });
      continue;
    }
    const bookingKey = `scheduled-${id}`.padEnd(16, '_');
    const rideId = bookingId(r.travelerUid, bookingKey);
    const fingerprint = createHash('sha256').update(JSON.stringify({ reservationId: id,
      atMs: r.atMs, tripNo: r.tripNo, billed })).digest('hex');
    let prepared;
    try {
      prepared = await prepareBooking({ db, uid: r.travelerUid, key: bookingKey,
        fingerprint, now, record: {
          tripNo: r.tripNo || '', travelerName: r.travelerName || '', party: r.party || null,
          travelerEmail: r.travelerEmail || '', dep: r.dep || '', dest: r.dest || '',
          pickupLat: pickup.lat, pickupLng: pickup.lng,
          destinationLat: r.destinationLat == null ? null : Number(r.destinationLat),
          destinationLng: r.destinationLng == null ? null : Number(r.destinationLng),
          travelClass: r.travelClass || 'Standard', travelCostCents: fareCents, costCents: billed,
          miles: Number.isFinite(Number(r.miles)) ? Number(r.miles) : null,
          governmentFeeCents: Number(r.governmentFeeCents) || 0, tollCents,
          feeLines: Array.isArray(r.feeLines) ? r.feeLines : [], cardCountry: r.cardCountry || null,
          scheduledFor: r.atMs, reservationId: id,
        } });
      if (prepared.status !== 201 && prepared.status !== 200) throw new Error(prepared.body.code || 'booking not prepared');
      if (prepared.body.status === 'cancelled' || prepared.body.status === 'expired') {
        throw new Error('This scheduled booking is already closed');
      }
    } catch (e) {
      await touchClaimed(db,id,claimed,{ status: 'needs_attention', claimedAt: null,claimNonce:null,
        dispatchError: `Booking could not be staged before charge: ${e.message}` });
      report.failed.push({ id, reason: `booking prepare failed; no charge: ${e.message}` });
      continue;
    }
    const rideRef = db.collection('rides').doc(rideId);
    if (r.party?.teen) {
      try { await provisionTeenPin({ rideRef, rideId, party: r.party, now }); }
      catch (e) {
        await touchClaimed(db,id,claimed,{status:'needs_attention',claimedAt:null,claimNonce:null,rideId,
          dispatchError:`Teen pickup protection unavailable before charge: ${e.message}`});
        report.failed.push({id,reason:'Teen pickup protection unavailable; no charge'});
        continue;
      }
    }

    // ---- 3. Off-session charge with a stable provider idempotency key. ----------------
    if (!await admitted(pickup) || !await stillClaimed(db,id,claimed,r.party)) {
      await touchClaimed(db,id,claimed,{status:'unmatched',claimedAt:null,claimNonce:null,
        closedReason:'Reservation, Family authorization or market admission changed before charge.',closedAt:Date.now()});
      report.failed.push({id,reason:'reservation, Family authorization or market admission changed; no charge requested'});
      continue;
    }
    const paid = await chargeScheduledTravel({
      travelCostCents: fareCents, uid: r.travelerUid, email: r.travelerEmail || '',
      tripNo: r.tripNo || '', reservationId: id, rideId, dep: r.dep || '', dest: r.dest || '',
      governmentFees: Array.isArray(r.feeLines) ? r.feeLines : [],
      cardCountry: r.cardCountry || null, tollCents,
    });
    if (!paid.ok) {
      await touchClaimed(db,id,claimed,{
        status: late ? 'payment_failed' : 'reserved', claimedAt: null,claimNonce:null,
        lastSweepAt: now, paymentError: paid.error || 'Payment failed',
        paymentErrorCode: paid.code || 'charge_failed',
      });
      if (late) await notify({ uid: r.travelerUid, kind: 'scheduled_failed',
        title: 'Payment could not be taken',
        body: 'Your scheduled travel was not dispatched. Update your payment method to book again.',
        data: { screen: '/wallet', tripNo: r.tripNo || '' } });
      report.failed.push({ id, reason: paid.code || 'charge failed' });
      continue;
    }

    // ---- 4. Attach the provider charge, verify it and atomically reserve the Operator. ----
    try {
      if (Number(paid.chargedCents) !== billed) throw new Error('Provider amount differs from reserved price');
      // If this write fails, Stripe's payment_intent.succeeded webhook uses rideId metadata to
      // attach the charge to this already-existing ride; booking recovery then refunds it.
      await rideRef.set({ paymentIntentId: paid.paymentIntentId }, { merge: true });
      if (!await admitted(pickup) || !await stillClaimed(db,id,claimed,r.party)) {
        throw new Error('Reservation, Family authorization or market admission changed after charge; refund is owed');
      }
      const payment = await verifiedTravelPayment(paid.paymentIntentId);
      const assigned = await assignPaidTravel({ db, uid: r.travelerUid, rideId,
        payment, candidate: match, now:Date.now(), requireScreening: screeningReady() });
      if (assigned.status !== 200 || !assigned.body.matched) {
        throw new Error(assigned.body.code || 'Paid Travel could not reserve Operator');
      }
      taken.add(match.operator.id);
      // Transition the reservation before notifications. A push outage cannot transform a
      // correctly paid/assigned ride into a duplicate charge on a later sweep.
      const finished = await touchClaimed(db,id,claimed,{
        status: 'dispatched', claimedAt: null, claimNonce:null, rideId, operatorId: assigned.body.matched.id,
        operatorName: assigned.body.matched.name || '', etaMin: assigned.body.matched.etaMin,
        paymentIntentId: paid.paymentIntentId, chargedCents: paid.chargedCents,
        dispatchedAt: now, paymentError: null,
      });
      if (!finished) throw new Error('Reservation changed after assignment; Operations reconciliation required');
      report.dispatched.push({ id, rideId, tripNo: r.tripNo || '',
        operator: assigned.body.matched.name, etaMin: assigned.body.matched.etaMin });
      try {
        const teenPickup = await provisionTeenPin({ rideRef, rideId, party: r.party || null, now });
        if (teenPickup.required && r.party?.teenUid) await notify({ uid: r.party.teenUid,
          kind: 'teen_pickup_code', title: 'Your pickup code',
          body: `Give ${teenPickup.pin} to your Operator after confirming the vehicle and Operator.`,
          data: { screen: '/ride', rideId, tripNo: r.tripNo || '' } });
        if (teenPickup.required && r.party?.guardianUid && r.party.guardianUid !== r.party.teenUid) {
          await notify({ uid: r.party.guardianUid, kind: 'guardian_travel',
            title: 'Teen Travel assigned', body: `${r.party.travelerName || 'Teen Traveler'}'s scheduled Travel has been assigned.`,
            data: { screen: '/family', rideId, tripNo: r.tripNo || '' } });
        }
        await notify({ uid: assigned.body.matched.id, kind: 'travel_assigned',
          title: 'Scheduled travel assigned', body: `${r.dep || 'Pickup'} to ${r.dest || 'destination'}. Open to accept.`,
          data: { screen: '/operator', rideId, tripNo: r.tripNo || '' } });
        await rideRef.set({ notifiedOperatorAt: Date.now() }, { merge: true });
        await notify({ uid: r.travelerUid, kind: 'operator_assigned',
          title: 'Your operator is on the way',
          body: `${assigned.body.matched.name || 'An operator'} is ${assigned.body.matched.etaMin} minutes from ${r.dep || 'your pickup'}.`,
          data: { screen: '/ride', rideId, tripNo: r.tripNo || '' } });
      } catch (e) {
        report.failed.push({ id, reason: `assigned, but notification/PIN needs attention: ${e.message}` });
      }
    } catch (e) {
      // The charge cannot vanish into a case alone: a durable ride was staged BEFORE charging.
      // The webhook can attach its PI if this write failed; booking recovery then refunds.
      await touchClaimed(db,id,claimed,{ status: 'needs_attention', claimedAt: null,claimNonce:null, rideId,
        paymentIntentId: paid.paymentIntentId, chargedCents: paid.chargedCents,
        dispatchError: e.message, dispatchErrorAt: now });
      let caseNo = null;
      try {
        const filed = await fileTicket({ uid: r.travelerUid, email: r.travelerEmail || '',
          kind: 'support', reason: 'Scheduled travel charged but not dispatched',
          trip: r.tripNo || '', description:
            `Scheduled Travel ${r.tripNo || '(no number)'} charged ${paid.chargedCents} cents ` +
            `(${paid.paymentIntentId}) but dispatch failed: ${e.message}. Ride ${rideId}. REFUND IS OWED.` });
        caseNo = filed?.caseNo || null;
        if (caseNo) await touch(db, id, { caseNo });
      } catch { /* the reservation and staged ride both retain the obligation */ }
      report.failed.push({ id, reason: `charged but not dispatched: ${e.message}`, paid: true, caseNo });
    }
  }

  return report;
}

/**
 * Take the reservation, but only if it is still there to take.
 *
 * A compare-and-set inside a transaction. Two server instances, or an interval overlapping a
 * manual sweep, would otherwise both charge the same traveler and dispatch two operators to
 * one pickup.
 */
async function claim(db, id, now) {
  const ref = db.collection('scheduled_rides').doc(id);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const r = snap.data();
      if (r.status !== 'reserved') return false;
      const held = Number(r.claimedAt) || 0;
      if (held && now - held < CLAIM_STALE_MS) return false; // somebody else has it
      const nonce=randomUUID();
      tx.update(ref, { status:'dispatching',claimedAt:now,claimNonce:nonce });
      return nonce;
    });
  } catch {
    return false;
  }
}

async function stillClaimed(db,id,nonce,party){
 const snap=await db.collection('scheduled_rides').doc(id).get();
 const r=snap.exists?snap.data():null;
 if(!r||r.status!=='dispatching'||r.claimNonce!==nonce||r.cancelRequestedAt)return false;
 if(party?.teen){
  const link=await activeFamilyLink({id:party.familyLinkId,guardianUid:party.guardianUid,now:Date.now()});
  if(!link||String(link.teenUid)!==String(party.teenUid))return false;
 }
 return true;
}

async function touchClaimed(db,id,nonce,fields){
 const ref=db.collection('scheduled_rides').doc(id);
 return db.runTransaction(async tx=>{
  const snap=await tx.get(ref);const r=snap.exists?snap.data():null;
  if(!r||r.status!=='dispatching'||r.claimNonce!==nonce)return false;
  tx.update(ref,fields);return true;
 });
}

// Only a claim that never staged a Travel can be safely retried. An already-assigned ride
// is reconstructed; ambiguous staged money goes to Operations and booking refund recovery.
async function recoverStaleClaims(db,now,report){
 try{
  const q=await db.collection('scheduled_rides').where('status','==','dispatching')
    .where('claimedAt','<=',now-CLAIM_STALE_MS).limit(25).get();
  report.staleClaims=q.docs.length;
  for(const d of q.docs){
   await db.runTransaction(async tx=>{
    const ref=db.collection('scheduled_rides').doc(d.id);
    const snap=await tx.get(ref);const r=snap.exists?snap.data():null;
    if(!r||r.status!=='dispatching'||Number(r.claimedAt)>now-CLAIM_STALE_MS)return;
    const bookingKey=`scheduled-${d.id}`.padEnd(16,'_');
    const rideId=bookingId(r.travelerUid,bookingKey);
    const rideSnap=await tx.get(db.collection('rides').doc(rideId));
    if(!rideSnap.exists){
     tx.update(ref,{status:'reserved',claimedAt:null,claimNonce:null,
       lastSweepResult:'Recovered abandoned claim before payment'});return;
    }
    const ride=rideSnap.data();
    if(['assigned','accepted','arrived','onboard','completed'].includes(ride.status)&&ride.paymentIntentId){
     tx.update(ref,{status:'dispatched',rideId,paymentIntentId:ride.paymentIntentId,
       operatorId:ride.operatorId||null,operatorName:ride.operatorName||'',
       claimedAt:null,claimNonce:null,dispatchedAt:ride.offeredAt||now,
       lastSweepResult:'Recovered already-paid assigned Travel'});return;
    }
    tx.update(ref,{status:'needs_attention',rideId,paymentIntentId:ride.paymentIntentId||null,
      claimedAt:null,claimNonce:null,dispatchError:'Stale claim with staged Travel: verify charge/refund before retry'});
   });
  }
  return true;
 }catch(e){report.failed.push({reason:`stale scheduled claims could not be reconciled: ${e.message}`});return false;}
}

/** Write to the reservation. Never throws — a lost note must not stop the sweep. */
async function touch(db, id, fields) {
  try {
    await db.collection('scheduled_rides').doc(id).set(fields, { merge: true });
  } catch {
    /* deliberate: see above */
  }
}

/** End the reservation with a reason the traveler can be shown verbatim. */
async function close(db, id, status, reason) {
  const ref=db.collection('scheduled_rides').doc(id);
  await db.runTransaction(async tx=>{
   const snap=await tx.get(ref);
   if(snap.exists&&snap.data().status==='reserved')
    tx.update(ref,{status,claimedAt:null,claimNonce:null,closedAt:Date.now(),closedReason:reason});
  });
}

// The interval that drives this lives in server.js, next to the route monitor, because the
// two run on the same tick and a free-tier ping has to drive both.
module.exports = { sweepScheduled, sweepSettlements, WINDOW_MS, ARRIVAL_BUFFER_MIN, GRACE_MS };

// ---- SETTLEMENT, SWEPT ---------------------------------------------------------------------
//
// A completed travel that has been paid for must reach the operator's bank whether or not
// anybody is still holding a phone. Until 29 Aug 2026 nothing guaranteed that: the traveler's
// app posted /travel/settle at the end of the journey, and if it had lost the thread by then
// — matchedOp nulled, app closed, backgrounded past a timer — the fare simply stayed in the
// platform balance. Silently. AR-2109-MIA was charged $19.44, driven by Marcus Reyes to
// completion, and produced no transfer and no receipt.
//
// This is the backstop, and it settles on the SERVER'S evidence rather than the app's:
//
//   status 'completed'  — the operator said so, and that write is what ends a journey
//   paymentIntentId     — now stamped on the travel by /create-payment-intent
//   no transferId       — not already settled
//
// Idempotent by transferId, so it can run every minute forever. transferToOperator re-checks
// the traveler's uid against Stripe's own metadata before a cent moves, so sweeping changes
// only WHEN an operator is paid, never WHO may be.
// A ceiling on one tick, not an expected size. Ordinarily this query matches nothing, because
// the flag is cleared as each travel is paid; the limit exists so a backlog cannot turn one
// sweep into a bill.
const SETTLE_SCAN_LIMIT = 25;

// Reservations examined per tick, for the same reason. A ceiling on the read bill, not a
// judgement about how many reservations may exist.
const RESERVED_SCAN_LIMIT = 100;

async function sweepSettlements({ now = Date.now(), limit = 25 } = {}) {
  const db = adminDb();
  if (!db) return { ok: false, reason: 'no database' };
  const { transferToOperator } = require('./payments');

  let settled = 0;
  let centsPaid = 0;
  const blocked = [];
  try {
    // READS ONLY WHAT OWES SOMEBODY MONEY. This scanned every completed travel, then the
    // newest 200 — and 200 reads a minute is 288,000 a day against a 50,000/day allowance,
    // for a database with 166 writes in it. The read bill for finding nothing was about to
    // be the reason to start paying.
    //
    // `needsPayout` is set when the operator completes the travel (see operatorInbox.ts) and
    // cleared here once paid, so a quiet minute costs nothing at all.
    const snap = await db
      .collection('rides')
      .where('needsPayout', '==', true)
      .limit(SETTLE_SCAN_LIMIT)
      .get();
    const owed = [];
    const unsettleable = [];
    snap.forEach((d) => {
      const x = d.data() || {};
      if (x.transferId) return; // already paid; the flag is cleared below
      // SETTLEMENT FOLLOWS COMPLETION, here as at /travel/settle (travelmoney.js). The rules let
      // only the operator set needsPayout, and only with status 'completed' — checked again
      // rather than trusted.
      if (x.status !== 'completed') {
        unsettleable.push({ rideId: d.id, tripNo: x.tripNo || d.id, reason: `status is ${x.status || 'unknown'}, not completed` });
        return;
      }
      // A FLAG THAT CANNOT BE ACTED ON MUST NOT BE READ FOREVER. Without a payment or an
      // operator there is nothing this sweep can ever do, so leaving needsPayout set would
      // buy the same futile document read every minute until someone noticed. It goes to a
      // person instead — which is the honest answer, because somebody may still be owed.
      if (!x.paymentIntentId || !x.operatorId) {
        unsettleable.push({ rideId: d.id, tripNo: x.tripNo || d.id });
        return;
      }
      owed.push({ rideId: d.id, ...x });
    });

    for (const u of unsettleable) {
      const why = u.reason || 'no payment or operator recorded — needs a person';
      blocked.push({ tripNo: u.tripNo, reason: why });
      await db.collection('rides').doc(u.rideId).set(
        {
          needsPayout: false,
          payoutPending: true,
          payoutBlockedReason: why,
          payoutCheckedAt: now,
        },
        { merge: true },
      );
    }

    for (const ride of owed.slice(0, limit)) {
      // An operator with no payout account yet is RECORDED as owed, never dropped. They
      // finish onboarding, and the next sweep pays them for work already done.
      const { accountId, reason } = await operatorPayoutAccount(db, ride.operatorId);
      if (!accountId) {
        blocked.push({ tripNo: ride.tripNo || ride.rideId, reason });
        await db.collection('rides').doc(ride.rideId).set(
          { payoutPending: true, payoutBlockedReason: reason, payoutCheckedAt: now },
          { merge: true },
        );
        continue;
      }
      const out = await transferToOperator({
        paymentIntentId: ride.paymentIntentId,
        operatorStripeAccount: accountId,
        expectedUid: String(ride.travelerUid),
        expectedTripNo: ride.tripNo || null,
        rideId: ride.rideId,
      });
      if (out.ok) {
        settled += 1;
        centsPaid += out.amountCents;
        await db.collection('rides').doc(ride.rideId).set(
          {
            transferId: out.transferId,
            operatorPaidCents: out.amountCents,
            payoutPending: false,
            payoutBlockedReason: null,
            settledAt: now,
            settledBy: 'sweep',
            needsPayout: false,
          },
          { merge: true },
        );
      } else {
        blocked.push({ tripNo: ride.tripNo || ride.rideId, reason: out.error || out.code });
        await db.collection('rides').doc(ride.rideId).set(
          { payoutPending: true, payoutBlockedReason: out.error || out.code,
            payoutCheckedAt: now,
            // A provider-ambiguous or legacy payout must not be re-attempted
            // every minute. Human reconciliation remains visible through
            // payoutPending and the historical ledger census.
            ...(out.unconfirmed ? { needsPayout: false, payoutReconciliationNeeded: true } : {}),
          },
          { merge: true },
        );
      }
    }
    return { ok: true, considered: owed.length, settled, centsPaid, blocked };
  } catch (e) {
    // Loudly. The whole point of this sweep is that nobody is watching.
    console.error('[sweep] settlement failed:', e.message);
    return { ok: false, reason: e.message, settled, centsPaid, blocked };
  }
}
