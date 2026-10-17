// American Rider — core payment logic. Production Travel payments use separate charges and transfers.
// This is the money math + Stripe calls. The HTTP server (server.js) exposes it to the app.
//
// The traveler is charged ONE all-in price, split automatically:
//   Traveler charge → American Rider's platform PaymentIntent.
//   On completed Travel, an explicit source_transaction transfer sends 99% of fare + tolls
//   to the Operator. American Rider retains the 1% commission + dynamically sufficient platform fee.
//   A government fee (fees.js — an airport's or a port's per-pickup charge) is added to what
//   the traveler pays and held whole for remittance: it is neither the operator's nor ours.
//
// The secret key is read from an environment variable — it NEVER lives in this file or the repo.
//   e.g.  STRIPE_SECRET_KEY=sk_test_...   (test)   →   sk_live_...   (real, much later)

const Stripe = require('stripe');
const { readKey, hasInvalidHeaderChars, describeInvalidChars } = require('./env');
const {
  MIN_PLATFORM_FEE_CENTS,
  isDomesticCard,
  commissionCents,
  minimumPlatformFeeCents,
  economicsFor,
} = require('./economics');

// Create the Stripe client only when a payment actually needs it. This lets the server boot
// (and serve /health and /quote) even before a secret key is configured — the newer Stripe SDK
// throws immediately if constructed without a key.
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    // readKey() strips stray whitespace/newlines/quotes — see env.js for why that matters.
    const key = readKey('STRIPE_SECRET_KEY');
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set — add it to backend/.env');
    if (hasInvalidHeaderChars(key)) {
      throw new Error('STRIPE_SECRET_KEY contains characters that cannot be sent in a request header (' + describeInvalidChars(key).join(', ') + ') — re-paste it without line breaks or special characters');
    }
    // Free-tier hosting is slow to wake and can drop the first connection, so give Stripe a
    // longer window and more retries than the defaults. Stripe's API is idempotent for
    // retried requests, so this cannot double-charge a traveler.
    _stripe = Stripe(key, { timeout: 30000, maxNetworkRetries: 4 });
  }
  return _stripe;
}

// ——— THE PLATFORM FEE: ONE ECONOMIC INVARIANT, NOT A PERCENTAGE TABLE ———————————
//
// The server computes the smallest whole-cent fee that covers:
//   * Stripe card processing on the ENTIRE traveler charge;
//   * both variable Stripe Connect charges on money sent to the operator;
//   * a conservative fixed Connect allowance;
//   * the 25c contingency reserve;
//   * the audited operating/infrastructure allowance; and
//   * the minimum platform contribution target.
//
// Government fees and toll reimbursements are pass-throughs to their beneficiaries, but they
// are not free to process. Their induced Stripe/Connect cost is therefore recovered here.
//
// US-issued cards use the domestic processing rate. Every other card, INCLUDING UNKNOWN,
// uses the international-safe rate. A first foreign card is never deliberately under-priced.
//
// Charges and settlement are USD-only; there is no ordinary Stripe FX branch in this
// formula. If a future product permits non-USD presentment/settlement, that must add an
// explicit FX cost before it may be enabled.
//
// backend/economics.js is canonical. src/data.ts mirrors the same integer-cent formula only
// for local display fallback; server quotes remain authoritative.

function platformFeeCents(
  travelCostCents,
  cardCountry,
  governmentFeeCents = 0,
  tollCents = 0,
  transactionCount = 1,
) {
  return minimumPlatformFeeCents({
    travelCostCents,
    governmentFeeCents,
    tollCents,
    cardCountry,
    transactionCount,
  });
}

// ——— CHARGEBACK DEFENCE ————————————————————————————————————————————————————————
// A disputed payment can reverse fare and add dispute cost. The per-Travel contingency reserve
// is therefore an explicit modeled allocation and must be recalibrated from actual loss data.
//
// The largest single cause of disputes is not fraud, it is "I do not recognise this
// charge": a bank statement showing an unfamiliar string weeks after the travel. So every
// charge carries a descriptor naming the company, and the metadata below is the evidence
// Stripe asks for if a dispute is opened anyway — the travel number, the route and the
// operator, all of which prove a service was actually delivered.
//
// 22 characters is Stripe's limit for the descriptor.
const STATEMENT_DESCRIPTOR = 'AMERICAN RIDER';

// Build the money breakdown for a ride. All values in integer cents (no float rounding bugs).
// ONE PLATFORM FEE PER SMART TRAVEL JOURNEY. A journey is two car travels around a transit
// leg. Leg 1 is charged exactly as any travel. Leg 2 names leg 1 (`journey.leg1FareCents`)
// and pays only the difference between the fee on the COMBINED car fare and the fee leg 1
// already carried — never below zero. src/state/RideContext.tsx `feeFor` shows the traveler
// the same arithmetic; the two must never disagree.
function journeyFeeCents(
  travelCostCents,
  journey,
  cardCountry,
  governmentFeeCents = 0,
  tollCents = 0,
) {
  const leg1 = Number(journey?.leg1FareCents);
  if (!Number.isFinite(leg1) || leg1 <= 0) {
    return platformFeeCents(travelCostCents, cardCountry, governmentFeeCents, tollCents, 1);
  }

  const leg1Government = Math.max(0, Number(journey?.leg1GovernmentFeeCents) || 0);
  const leg1Toll = Math.max(0, Number(journey?.leg1TollCents) || 0);

  // Smart Travel uses two separately charged car legs. The total journey fee therefore funds
  // TWO fixed payment/Connect/reserve/overhead units, then leg 2 pays only the amount not
  // already carried by leg 1.
  const combined = platformFeeCents(
    leg1 + travelCostCents,
    cardCountry,
    leg1Government + governmentFeeCents,
    leg1Toll + tollCents,
    2,
  );
  const alreadyPaid = platformFeeCents(
    leg1,
    cardCountry,
    leg1Government,
    leg1Toll,
    1,
  );
  return Math.max(0, combined - alreadyPaid);
}

// A government fee line as fees.js writes it. Anything else — a negative, a fraction, a line
// with no payee — is not a fee and is dropped rather than charged.
const feeLine = (l) =>
  l && Number.isInteger(l.cents) && l.cents > 0 && typeof l.payee === 'string' && l.payee
    ? { id: String(l.id || ''), name: String(l.name || l.id || ''), payee: l.payee, cents: l.cents, ...(l.end ? { end: l.end } : {}) }
    : null;

/**
 * The money breakdown for a travel.
 *   governmentFees  fees.governmentFeesFor() lines, or nothing. They are added to what the
 *                   traveler pays and to nothing else: not the operator's 99% (the operator
 *                   does not drive them) and not platformTake (we do not keep them).
 *                   passThroughCents is the amount held for remittance; feeLines says to whom.
 */
function quote(travelCostCents, journey, governmentFees, cardCountry, tollCents) {
  const commission = commissionCents(travelCostCents);
  const feeLines = (Array.isArray(governmentFees) ? governmentFees : []).map(feeLine).filter(Boolean);
  const governmentFeeCents = feeLines.reduce((sum, l) => sum + l.cents, 0);
  const tolls = Number.isInteger(tollCents) && tollCents > 0 ? tollCents : 0;

  // The platform fee is computed AFTER pass-throughs are known, because Stripe processes the
  // whole traveler charge and Connect processes the toll reimbursement. A $2 airport fee or
  // a $5 toll is economically neutral only when its induced transaction cost is funded here.
  const appFee = journeyFeeCents(
    travelCostCents,
    journey,
    cardCountry,
    governmentFeeCents,
    tolls,
  );
  const platformTake = commission + appFee;

  // ——— TOLLS (Chad, 20 Sept 2026) ———————————————————————————————————————————————
  // A THIRD KIND OF MONEY, and it behaves like neither of the other two.
  //
  //   the platform fee   the traveler pays it, WE keep it, never itemised
  //   a government fee   the traveler pays it, a PUBLIC BODY is owed it, itemised
  //   a toll             the traveler pays it, the OPERATOR is reimbursed it, itemised
  //
  // Until today a toll came out of the operator's 99%: the Rickenbacker Causeway and every
  // expressway toll was a cost of doing the travel, borne by the person driving it. Uber and
  // Lyft both add tolls to the fare, so the operator was absorbing something no competitor
  // asks their drivers to absorb.
  //
  // ON TOP OF THE 99%, NOT INSIDE IT. The commission is 1% of the travel fare and a toll is
  // not fare, so no commission is taken on it and it is added to operatorGets whole. The
  // platform's take is identical with tolls and without — which is the test of whether this is
  // a pass-through or a quiet margin.
  const operatorGets = travelCostCents - commission + tolls; // 99% of the fare, plus the toll back

  const travelerPays = travelCostCents + appFee + governmentFeeCents + tolls; // the ONE all-in price
  return {
    travelerPays,
    operatorGets,
    platformTake,
    commission,
    appFee,
    governmentFeeCents,
    tollCents: tolls,
    // What is collected from the traveler and owed onward rather than kept: the public bodies
    // AND the operator's toll. remittance.js sums the fee lines by payee; the toll is settled
    // through the operator's own transfer, which is why it is counted here but not a fee line.
    passThroughCents: governmentFeeCents + tolls,
    feeLines,
    // Internal audit data. /fare-quote does not expose this field; tests and Ops can prove the
    // selected fee still preserves the invariant when any cost constant changes.
    _economics: journey && Number(journey.leg1FareCents) > 0
      ? economicsFor({
          travelCostCents: Number(journey.leg1FareCents) + travelCostCents,
          platformFeeCents: platformFeeCents(
            Number(journey.leg1FareCents) + travelCostCents,
            cardCountry,
            Math.max(0, Number(journey.leg1GovernmentFeeCents) || 0) + governmentFeeCents,
            Math.max(0, Number(journey.leg1TollCents) || 0) + tolls,
            2,
          ),
          governmentFeeCents: Math.max(0, Number(journey.leg1GovernmentFeeCents) || 0) + governmentFeeCents,
          tollCents: Math.max(0, Number(journey.leg1TollCents) || 0) + tolls,
          cardCountry,
          transactionCount: 2,
        })
      : economicsFor({
          travelCostCents,
          platformFeeCents: appFee,
          governmentFeeCents,
          tollCents: tolls,
          cardCountry,
          transactionCount: 1,
        }),
  };
}

// REAL APP FLOW: create a PaymentIntent and hand its client secret back to the app. The app
// then collects the traveler's card on the phone (Stripe's PaymentSheet) and confirms it there,
// so the card details never touch our server. This is the safe, standard mobile flow.
/**
 * One Stripe Customer per traveler, so saved cards survive between travels.
 *
 * Keyed on the Firebase uid in metadata rather than on email: an email can change hands, a
 * uid cannot, and this is the record a refund's ownership check ultimately rests on.
 */
async function customerForTraveler({ uid, email }) {
  const stripe = getStripe();
  const found = await stripe.customers.search({
    query: `metadata['uid']:'${String(uid).replace(/'/g, '')}'`,
    limit: 1,
  });
  if (found.data[0]) return found.data[0];
  return stripe.customers.create({ email: email || undefined, metadata: { uid: String(uid) } });
}

// ——— THE TRAVELER'S SAVED PAYMENT METHODS ———————————————————————————————————————————
// Read from Stripe's record of the Customer, never typed into the app. The app shows exactly
// these rows (Chad, 14 Sept 2026: the screen must carry real payment management, not text).

/** One saved method as the app shows it: brand, last four, expiry, the wallet it came through
 *  (Apple Pay, Google Pay) and whether it is the one charged when the traveler is not asked. */
function describePaymentMethod(pm, defaultId) {
  if (!pm || typeof pm !== 'object') return null;
  const card = pm.card || null;
  const wallet = card && card.wallet && typeof card.wallet.type === 'string' ? card.wallet.type : null;
  return {
    id: String(pm.id || ''),
    type: String(pm.type || ''),
    brand: card ? String(card.brand || '') : '',
    last4: card ? String(card.last4 || '') : '',
    expMonth: card && Number.isInteger(card.exp_month) ? card.exp_month : null,
    expYear: card && Number.isInteger(card.exp_year) ? card.exp_year : null,
    // THE ISSUING COUNTRY, WHICH DECIDES THE FEE SCHEDULE (Chad, 20 Sept 2026). Stripe writes
    // it as a two-letter code the moment the card is attached, so for anybody who has paid
    // before it is known long before we quote — which is the whole reason the quote can carry
    // a card-aware fee without the price moving under the traveler.
    //
    // It is NOT shown to the traveler anywhere. It selects a schedule; it is not a label.
    country: card && typeof card.country === 'string' ? card.country.toUpperCase() : null,
    wallet,
    isDefault: !!defaultId && String(pm.id) === String(defaultId),
  };
}

/**
 * The issuing country of the traveler's DEFAULT card, or null when they have none on file.
 * This is what quote() is given, and what decides which of the two fee schedules applies.
 *
 * null is not an error and is not a failure to look: a traveler on their first travel has no
 * default. The canonical economics treats null as international-safe, so returning null rather
 * than guessing domestic keeps a Stripe outage or first Travel from being deliberately under-priced.
 */
async function defaultCardCountry({ uid, email }) {
  try {
    const methods = await listPaymentMethods({ uid, email });
    const chosen = methods.find((m) => m.isDefault) || methods[0] || null;
    return chosen && chosen.country ? chosen.country : null;
  } catch {
    return null;
  }
}

/**
 * What paid for a travel, read from the charge Stripe recorded — never from the phone. A card
 * gives its brand and last four and the wallet it came through; a bank account its last four.
 * null when the intent's charge is not expanded or carries no method details: the traveler's
 * record then says "Not recorded" rather than naming the method their app has selected today.
 */
function paidWithFromIntent(pi) {
  const charge = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const details = charge && charge.payment_method_details;
  if (!details || typeof details !== 'object') return null;
  const type = String(details.type || '');
  const card = details.card && typeof details.card === 'object' ? details.card : null;
  const bank = details.us_bank_account && typeof details.us_bank_account === 'object' ? details.us_bank_account : null;
  const wallet = card && card.wallet && typeof card.wallet.type === 'string' ? card.wallet.type : null;
  const brand = card && card.brand != null ? String(card.brand) : '';
  const last4 = card && card.last4 != null ? String(card.last4) : bank && bank.last4 != null ? String(bank.last4) : '';
  // The bank's own name, as Stripe records it ("JPMORGAN CHASE BANK, NA"); null for a card.
  const bankName = bank && bank.bank_name != null && String(bank.bank_name) ? String(bank.bank_name) : null;
  if (!type && !brand && !last4) return null;
  return { type, brand, last4, wallet, bank: bankName };
}

/** The Customer's chosen default, as an id — Stripe returns it as an id or an expanded object. */
function defaultMethodId(customer) {
  const d = customer && customer.invoice_settings ? customer.invoice_settings.default_payment_method : null;
  if (!d) return null;
  return typeof d === 'string' ? d : String(d.id || '') || null;
}

/** The method to charge when the traveler is not asked: their default, else the most recent. */
async function savedPaymentMethodFor(customer) {
  const stripe = getStripe();
  const methods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 20 });
  const defaultId = defaultMethodId(customer);
  return methods.data.find((m) => m.id === defaultId) || methods.data[0] || null;
}

async function listPaymentMethods({ uid, email }) {
  const stripe = getStripe();
  const customer = await customerForTraveler({ uid, email });
  const methods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 20 });
  const defaultId = defaultMethodId(customer);
  return methods.data.map((m) => describePaymentMethod(m, defaultId)).filter(Boolean);
}

/** What the PaymentSheet needs to save a card without charging it: a SetupIntent, the
 *  Customer, and a short-lived key that lets the phone read that Customer's methods. */
async function createSetupIntent({ uid, email }) {
  const stripe = getStripe();
  const customer = await customerForTraveler({ uid, email });
  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customer.id },
    { apiVersion: '2024-06-20' },
  );
  const si = await stripe.setupIntents.create({
    customer: customer.id,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: { product: 'American Rider saved method', uid: uid || '' },
  });
  return { clientSecret: si.client_secret, setupIntentId: si.id, customerId: customer.id, ephemeralKeySecret: ephemeralKey.secret };
}

/** A method may be changed only by the traveler it is attached to. Anything else is refused
 *  before Stripe is asked to do anything with it. */
async function ownedPaymentMethod(customer, paymentMethodId) {
  const stripe = getStripe();
  const id = String(paymentMethodId || '');
  if (!/^pm_[A-Za-z0-9]+$/.test(id)) return { error: 'bad_id' };
  const pm = await stripe.paymentMethods.retrieve(id).catch(() => null);
  if (!pm || pm.customer !== customer.id) return { error: 'not_yours' };
  return { pm };
}

async function setDefaultPaymentMethod({ uid, email, paymentMethodId }) {
  const stripe = getStripe();
  const customer = await customerForTraveler({ uid, email });
  const owned = await ownedPaymentMethod(customer, paymentMethodId);
  if (owned.error) return { ok: false, code: owned.error };
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: owned.pm.id } });
  return { ok: true };
}

async function detachPaymentMethod({ uid, email, paymentMethodId }) {
  const stripe = getStripe();
  const customer = await customerForTraveler({ uid, email });
  const owned = await ownedPaymentMethod(customer, paymentMethodId);
  if (owned.error) return { ok: false, code: owned.error };

  // Stripe's default is a separate Customer pointer, not a reason to lock
  // a Traveler into keeping a card. Advance it to another already-saved card
  // (or clear it) before detaching so an off-session payment cannot reference
  // a method no longer attached to this Customer.
  const wasDefault = defaultMethodId(customer) === owned.pm.id;
  if (wasDefault) {
    const saved = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 20 });
    const replacement = saved.data.find(m => m.id !== owned.pm.id);
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: replacement ? replacement.id : '' },
    });
  }
  try {
    await stripe.paymentMethods.detach(owned.pm.id);
  } catch (err) {
    // Best-effort compensation if Stripe refused detachment. Retain the
    // original error: the actual method may still be usable.
    if (wasDefault) {
      try {
        await stripe.customers.update(customer.id, {
          invoice_settings: { default_payment_method: owned.pm.id },
        });
      } catch { /* recovery failure is handled as an operational incident */ }
    }
    throw err;
  }
  return { ok: true };
}

/**
 * The idempotency options for one travel's charge, or `undefined` when it cannot be made safe.
 *
 * Returns `undefined` rather than a weaker key when there is no Travel Number: a key that is
 * not specific to one travel is worse than none, because Stripe would replay a DIFFERENT
 * traveler's intent for a matching uid and amount.
 */
function idempotencyForTravel(kind, uid, tripNo, amountCents) {
  if (!uid || !tripNo) return undefined;
  return { idempotencyKey: `ar_${kind}_${uid}_${tripNo}_${amountCents}` };
}

async function createPaymentIntent({ travelCostCents, uid, email, tripNo, rideId, dep, dest, journey, governmentFees, cardCountry, tollCents = 0 }) {
  const stripe = getStripe();
  const q = quote(travelCostCents, journey, governmentFees, cardCountry, tollCents);

  // The PaymentSheet needs all three: a customer, a short-lived key that lets the phone read
  // that customer's saved cards, and the intent itself.
  const customer = await customerForTraveler({ uid, email });
  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customer.id },
    { apiVersion: '2024-06-20' },
  );

  const params = {
    amount: q.travelerPays, // traveler is charged the all-in price
    currency: 'usd',
    customer: customer.id,
    automatic_payment_methods: { enabled: true },
    // STRIPE SENDS THE RECEIPT. Free, no vendor, no domain, no signup — and until this line
    // existed a traveler completed a journey, was charged, and received nothing they could
    // keep. It is a payment receipt rather than a Travel Receipt: it carries the amount, the
    // date, the card and the description below, but not the route, the operator or the 99%.
    // Worse than the one backend/email.js builds, and infinitely better than silence, so it
    // stands until americanrider.app is verified and then runs alongside it.
    //
    // NOTE: Stripe only sends these automatically in LIVE mode. In test mode the receipt is
    // there to be sent by hand from the dashboard, which is how we check what it looks like.
    receipt_email: email || undefined,
    // Keep the card on file so the next travel is one tap.
    setup_future_usage: 'off_session',
    // `uid` is what lets a later refund prove the payment belongs to the person asking for
    // it — see refundTravel. Stamp it at the only moment we know it for certain.
    statement_descriptor_suffix: STATEMENT_DESCRIPTOR,
    // Dispute evidence, stamped at the moment we know it is true.
    // WHAT THE TRAVELER READS ON THE RECEIPT AND THE STATEMENT. The route, not just a
    // number: "American Rider · Brickell to Miami International Airport · AR-2048-MIA" tells
    // somebody what they paid for three weeks later. A bare travel number does not.
    description: ['American Rider', dep && dest ? `${dep} to ${dest}` : null, tripNo || null]
      .filter(Boolean)
      .join(' · '),
    // `travelCostCents` is stamped here because the operator's 99% is calculated from it at
    // settlement, hours later. Reading it back off Stripe's own record means the transfer
    // cannot be talked into a different number by whatever calls /travel/settle.
    metadata: {
      product: 'American Rider travel',
      uid: uid || '',
      tripNo: tripNo || '',
      // The travel record this pays for, from the server's own lookup (travelmoney.js).
      rideId: rideId || '',
      travelCostCents: String(travelCostCents),
      // WHAT AMERICAN RIDER ACTUALLY RETAINS on this travel — the 1% commission plus the
      // platform fee. Stamped for the same reason travelCostCents is: a refund issued hours
      // later needs to know how much of this money is still ours before it gives any back, and
      // the only trustworthy record of that is Stripe's own. Without it every refund reads as
      // wholly out of pocket — the safe direction, but not the true one. See refundTravel().
      platformTake: String(q.platformTake),
      // Held for a public body, not ours. The remittance ledger and a refund both read it here.
      governmentFeeCents: String(q.governmentFeeCents),
      tollCents: String(q.tollCents),
      // Leg 2 of a Smart Travel journey records leg 1's Travel Number: the reason its fee
      // is not the standard one is then readable on Stripe's own record.
      journeyNo: journey?.journeyNo || '',
    },
  };
  // NO `transfer_data` HERE — deliberately. See transferToOperator below for why the split
  // happens at completion instead of at payment.
  //
  // KEYED, like every other money call in this file. Without a key, a traveler who double-taps
  // Confirm Travel — or a client that retries after a timeout on a slow network — gets a
  // SECOND PaymentIntent for the same travel. The payment sheet then holds two live secrets
  // for one journey, and confirming the older one charges a second time for a travel that was
  // already paid for. Transfers, tips, scheduled travel and screening were all keyed; the
  // traveler's own fare, the largest and most frequent charge we make, was not.
  //
  // The amount is IN the key, as it is in `ar_tip_` and `ar_fixed_`: Stripe replays the first
  // response for a repeated key, so a re-quote at a different price must be allowed to create
  // its own intent rather than silently return the old amount.
  //
  // No tripNo, no key. A Travel Number is what makes the key specific to one travel; keying on
  // uid and amount alone would make two genuinely different travels at the same fare collide,
  // and the second traveler would be handed the first one's intent.
  const pi = await stripe.paymentIntents.create(
    params,
    idempotencyForTravel('travel', uid, tripNo, params.amount),
  );
  return {
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    customerId: customer.id,
    ephemeralKeySecret: ephemeralKey.secret,
    breakdown: q,
  };
}

// LOCAL TEST FLOW: charge a Stripe test card server-side, in one call, so the whole thing can be
// proven from a terminal without a phone. NOT used by the real app (the app uses the flow above).
//   travelCostCents        e.g. 2450  ($24.50 travel cost)
//   operatorStripeAccount  the operator's connected account id (acct_...) — optional
//   travelerPaymentMethod  a Stripe test payment method (defaults to the test Visa)
/**
 * Continue an EXISTING, still-unpaid intent for the same travel and the same price — a retry of
 * the same payment — without creating a PaymentIntent (travelmoney.js payForTravel checks the
 * travel's record first; audit of f6ef88d). Returns the same body createPaymentIntent returns,
 * or null when the intent is paid, cancelled, someone else's, another travel's, or for a
 * different amount — in which case the caller refuses.
 */
const RESUMABLE = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
async function resumePaymentIntent({ paymentIntentId, uid, rideId, email, travelCostCents, journey, governmentFees, cardCountry, tollCents = 0 }) {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!pi || pi.metadata?.uid !== String(uid) || pi.metadata?.rideId !== String(rideId)) return null;
  if (!RESUMABLE.includes(pi.status)) return null;
  const q = quote(travelCostCents, journey, governmentFees, cardCountry, tollCents);
  if (pi.amount !== q.travelerPays) return null;
  const customer = await customerForTraveler({ uid, email });
  const ephemeralKey = await stripe.ephemeralKeys.create({ customer: customer.id }, { apiVersion: '2024-06-20' });
  return {
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    customerId: customer.id,
    ephemeralKeySecret: ephemeralKey.secret,
    breakdown: q,
    resumed: true,
  };
}

/** Never offer a paid Travel on a phone's assertion. Retrieve the exact intent from Stripe. */
async function verifiedTravelPayment(paymentIntentId) {
  if (!paymentIntentId || typeof paymentIntentId !== 'string') return null;
  return getStripe().paymentIntents.retrieve(paymentIntentId);
}

async function cancelUnpaidIntent({ paymentIntentId, uid, rideId }) {
  try {
    const pi = await verifiedTravelPayment(paymentIntentId);
    if (!pi || pi.metadata?.uid !== String(uid) || pi.metadata?.rideId !== String(rideId)) {
      return { ok: false, reason: 'Payment ownership could not be verified' };
    }
    if (pi.status === 'succeeded') return { ok: false, reason: 'Payment succeeded; refund required' };
    if (pi.status === 'canceled') return { ok: true };
    if (pi.status === 'processing') return { ok: false, reason: 'Payment is processing; refund reconciliation required' };
    const cancelled = await getStripe().paymentIntents.cancel(pi.id, { cancellation_reason: 'requested_by_customer' });
    return { ok: cancelled.status === 'canceled', reason: cancelled.status };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

async function chargeRide({ travelCostCents, travelerPaymentMethod, uid, tripNo, governmentFees, cardCountry, tollCents = 0 }) {
  const stripe = getStripe();
  const q = quote(travelCostCents, undefined, governmentFees, cardCountry, tollCents);
  const params = {
    amount: q.travelerPays,
    currency: 'usd',
    payment_method: travelerPaymentMethod || 'pm_card_visa',
    payment_method_types: ['card'],
    confirm: true,
    // Same stamp as createPaymentIntent, and for the same reason: a refund must be able to
    // prove ownership from Stripe's record rather than from a request body.
    // Same stamp as the real flow, so a transfer made against a terminal-created charge is
    // calculated from exactly the same recorded fare.
    metadata: {
      product: 'American Rider travel',
      uid: uid || '',
      tripNo: tripNo || '',
      travelCostCents: String(travelCostCents),
      // WHAT AMERICAN RIDER ACTUALLY RETAINS on this travel — the 1% commission plus the
      // platform fee. Stamped for the same reason travelCostCents is: a refund issued hours
      // later needs to know how much of this money is still ours before it gives any back, and
      // the only trustworthy record of that is Stripe's own. Without it every refund reads as
      // wholly out of pocket — the safe direction, but not the true one. See refundTravel().
      platformTake: String(q.platformTake),
      // Held for a public body, not ours. The remittance ledger and a refund both read it here.
      governmentFeeCents: String(q.governmentFeeCents),
      tollCents: String(q.tollCents),
    },
  };
  // Keyed for the same reason as createPaymentIntent above. This route is test-mode only
  // (`/charge-ride` refuses a live key), but it confirms immediately — so an unkeyed retry here
  // is a straight double charge rather than an orphaned intent.
  const paymentIntent = await stripe.paymentIntents.create(
    params,
    idempotencyForTravel('charge', uid, tripNo, params.amount),
  );
  // Test charges deliberately do not transfer funds. Settlement exercises the same separate-transfer path as production.
  return {
    paymentIntentId: paymentIntent.id,
    status: paymentIntent.status,
    amountCents: paymentIntent.amount,
    breakdown: q,
  };
}

/**
 * How much of a payment can still be returned, and why not when the answer is none.
 *
 * Separated from refundTravel so a cancellation can ask "what is there to give back?" without
 * naming an amount it guessed. The ownership check is the same one and rests on Stripe's copy
 * of the intent, never on the request body.
 */
// Only the Charge has the cumulative refunded cents. PaymentIntent does not.
function refundBalanceFromVerifiedIntent(pi) {
  const charge = pi?.latest_charge;
  const charged = Number(pi?.amount_received);
  const refunded = charge && typeof charge === 'object' ? charge.amount_refunded : NaN;
  if (pi?.status !== 'succeeded' || !charge || typeof charge !== 'object' ||
      (charge.payment_intent && charge.payment_intent !== pi.id) ||
      !Number.isSafeInteger(charged) || charged <= 0 ||
      !Number.isSafeInteger(refunded) || refunded < 0 || refunded > charged) {
    return { ok: false, cents: 0, alreadyRefunded: 0,
      reason: 'Verified Stripe charge and refund history unavailable', retryable: true };
  }
  return { ok: true, cents: charged - refunded, alreadyRefunded: refunded };
}

async function refundableFor({ paymentIntentId, expectUid }) {
  if (!paymentIntentId) return { cents: 0, reason: 'no payment on record' };
  try {
    const pi = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    if (expectUid && pi.metadata?.uid !== String(expectUid)) {
      return { cents: 0, reason: 'that payment belongs to a different account' };
    }
    if (pi.status !== 'succeeded') return { cents: 0, reason: `payment is ${pi.status}`, retryable: pi.status === 'processing' };
    const balance = refundBalanceFromVerifiedIntent(pi);
    if (!balance.ok) return { cents: 0, reason: balance.reason, retryable: true };
    return { cents: balance.cents, reason: balance.cents > 0 ? null : 'nothing left to refund' };
  } catch (e) {
    return { cents: 0, reason: e.message, retryable: true };
  }
}

// Give money back.
//
// WHY THIS EXISTS: Patron Support could decide "credit" and the traveler was shown an amount
// and told it had been credited to their payment method — while nothing was refunded. A
// decision is not a refund. This is the mechanism behind the sentence.
//
// Returns { ok, refundId, amountCents } or { ok:false, error }. The caller must NOT tell the
// traveler money moved unless ok is true; server.js routes a failed refund to a person.
async function refundTravel({ paymentIntentId, amountCents, expectUid, idempotencyKey = null }) {
  if (!paymentIntentId) return { ok: false, error: 'no payment on record for that travel' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'refund amount must be a positive whole number of cents' };
  }
  try {
    // WHOSE PAYMENT IS THIS? The app sends the PaymentIntent id, and the app is a program
    // on a stranger's phone. Without this check a signed-in traveler could name ANOTHER
    // traveler's PaymentIntent and have us refund against it — they would gain nothing, but
    // American Rider would lose the money, once per request, for as long as they cared to
    // keep asking. Stripe's own copy of the intent is the only trustworthy record of who
    // paid, so the ownership test and the ceiling both come from there, never from the body
    // of the request.
    const pi = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    if (expectUid && pi.metadata?.uid !== expectUid) {
      return { ok: false, error: 'that payment belongs to a different account' };
    }
    if (pi.status !== 'succeeded') {
      return { ok: false, error: `payment is ${pi.status}, not a completed charge` };
    }
    // Never refund more than was actually taken, whatever the request claimed the travel cost.
    const balance = refundBalanceFromVerifiedIntent(pi);
    if (!balance.ok) return { ok: false, error: balance.reason, retryable: true };
    const { alreadyRefunded } = balance;
    if (amountCents > balance.cents) {
      return { ok: false, error: `only ${balance.cents}c of that payment remains refundable` };
    }

    // ——— WHAT THIS REFUND ACTUALLY COSTS US ———————————————————————————————————
    //
    // ASKED BY ADRIAN, 20 SEPT 2026: "regarding the refunds you mentioned, we are protected,
    // right? we don't want to lose." Partly. Everything above stops a refund being larger than
    // the payment, or aimed at somebody else's payment, or issued twice. None of it touches
    // the real exposure, which is this:
    //
    //   THE OPERATOR HAS ALREADY BEEN PAID. 99% of the fare left for their Connect account
    //   when the travel completed. A refund to the traveler does NOT reverse that transfer,
    //   so past the point where our own retained take runs out, every cent refunded is money
    //   American Rider has already paid away and is now paying a second time.
    //
    // On a $9.03 travel we retain about $1.58. Refund the whole $9.03 and roughly $7.45 of it
    // is ours, gone. The support resolver's $45 ceiling was set against the SIZE OF A FARE,
    // which is the wrong quantity — it measures what the traveler might reasonably be owed,
    // not what we can absorb.
    //
    // This does not decide the policy. It MEASURES it, and hands the number back, so a caller
    // can refuse before issuing rather than discover the cost in a month-end total. Reversing
    // the operator's transfer is deliberately NOT done here: it takes money from somebody who
    // may have done nothing wrong, and that is a person's judgement, never a model's.
    const platformHeld = Number(pi.metadata?.platformTake) || 0;
    const stillOurs = Math.max(0, platformHeld - alreadyRefunded);
    const outOfPocketCents = Math.max(0, amountCents - stillOurs);

    const refund = await getStripe().refunds.create({
      payment_intent: paymentIntentId,
      amount: amountCents,
      metadata: {
        product: 'American Rider travel',
        reason: 'Patron Support adjustment',
        // Stamped on the refund itself so the cost is legible in Stripe, not only in our logs.
        outOfPocketCents: String(outOfPocketCents),
      },
    }, idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : undefined);
    // 'pending' is a normal ACH outcome and still means the refund is real and issued.
    const ok = refund.status === 'succeeded' || refund.status === 'pending';
    return ok
      ? { ok: true, refundId: refund.id, amountCents: refund.amount, status: refund.status, outOfPocketCents }
      : { ok: false, error: `refund ${refund.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- OPERATOR PAYOUTS (Stripe Connect) ---------------------------------------------------
//
// WHY THIS IS THE REAL BLOCKER, not a nicety. Every screen in this product says the operator
// keeps 99% of the fare. That happens through `transfer_data.destination` on the charge — and
// destination needs a connected account id (`acct_...`) that belongs to the operator. Nothing
// created one. So with a live key and no Connect account, American Rider would collect the
// whole fare and the operator would receive nothing automatically, which is not a bug in a
// payout system, it is the company's central promise not happening.
//
// Express accounts: Stripe hosts the identity check and the bank details, which means this
// server never sees an operator's SSN or account number. That is the correct division.

/** Create (or reuse) the operator's connected account. Keyed on their Firebase uid. */
async function connectAccountFor({ uid, email, existingAccountId }) {
  const stripe = getStripe();
  if (existingAccountId) {
    try {
      return await stripe.accounts.retrieve(existingAccountId);
    } catch {
      // Deleted or from the other mode — fall through and make a fresh one.
    }
  }
  return stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: email || undefined,
    business_type: 'individual',
    capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
    metadata: { uid: String(uid) },
  });
}

/** The Stripe-hosted onboarding link the operator completes. Single use, short lived. */
async function connectOnboardingLink({ accountId, returnUrl, refreshUrl }) {
  return getStripe().accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    return_url: returnUrl,
    refresh_url: refreshUrl,
  });
}

/**
 * Can this operator actually be paid?
 *
 * `payoutsEnabled` is Stripe's answer, not ours. An operator who has started onboarding but
 * not finished it has an account id and cannot receive money — treating the id alone as
 * "done" would put us right back to charging travelers for a split that cannot happen.
 */
async function connectAccountStatus(accountId) {
  if (!accountId) return { exists: false, payoutsEnabled: false, chargesEnabled: false, due: [] };
  try {
    const a = await getStripe().accounts.retrieve(accountId);
    return {
      exists: true,
      accountId: a.id,
      payoutsEnabled: !!a.payouts_enabled,
      chargesEnabled: !!a.charges_enabled,
      due: a.requirements?.currently_due || [],
    };
  } catch (e) {
    return { exists: false, payoutsEnabled: false, chargesEnabled: false, due: [], error: e.message };
  }
}

/** A single-use link into an Express operator's own Stripe dashboard. */
async function connectDashboardLink(accountId) {
  const link = await getStripe().accounts.createLoginLink(accountId);
  return link.url;
}

// ---- PAYING THE OPERATOR: separate charges and transfers ---------------------------------
//
// WHY THE SPLIT MOVED OFF THE CHARGE. A destination charge divides the money at the instant
// the traveler pays, which requires knowing the operator at that instant. We do not. Dispatch
// matches asynchronously — the app asked for the money and started looking for a driver on the
// next line — an operator can be reassigned, and a travel can be cancelled after payment.
// Charging first and refusing to charge at all were the only two options, and the code chose
// to refuse: with a live key and no connected account it returned 409 and took nothing, so
// every booking would have failed the day real money was switched on.
//
// It is also the wrong risk posture. A destination charge sends the operator's 99% before the
// traveler's money has settled. An ACH that later fails, or a disputed card, would mean money
// paid out that was never received — recoverable only by clawing back an operator's earnings,
// which is exactly the thing this company should never do.
//
// So: the platform takes the whole fare, and the 99% moves when the travel is COMPLETE and we
// know who drove. `source_transaction` ties the transfer to that one charge, which makes
// Stripe hold it until those specific funds are available. An ACH that never settles produces
// a transfer that never fires — no clawback, because nothing left.
//
// The operator is never worse off: same 99%, paid on completion instead of on booking.
async function transferToOperator({
  paymentIntentId,
  operatorStripeAccount,
  expectedUid,
  expectedTripNo,
  rideId,
}) {
  const stripe = getStripe();
  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  } catch (e) {
    return { ok: false, code: 'no_payment', error: e.message };
  }

  // OWNERSHIP. The caller hands us a PaymentIntent id; without these two checks anyone could
  // hand us somebody else's and have its 99% sent to an account of their choosing. The uid on
  // the intent was stamped by this server at creation and cannot be edited from a phone.
  if (expectedUid && pi.metadata?.uid !== String(expectedUid)) {
    return { ok: false, code: 'not_your_payment', error: 'That payment belongs to another traveler' };
  }
  if (expectedTripNo && pi.metadata?.tripNo && pi.metadata.tripNo !== String(expectedTripNo)) {
    return { ok: false, code: 'wrong_travel', error: 'That payment belongs to another travel' };
  }
  if (pi.status !== 'succeeded') {
    // Includes ACH still clearing. Not an error — settle again once it lands.
    return { ok: false, code: 'not_settled', error: `Payment is ${pi.status}`, retryable: true };
  }
  // The method that paid, for the traveler's own record. Read here because this is the one
  // place the charge is already in hand; the settle routes write it onto the travel, and the
  // receipt and the Travel Log print it instead of whatever the phone has selected today.
  const paidWith = paidWithFromIntent(pi);

  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (!chargeId) return { ok: false, code: 'no_charge', error: 'Payment has no charge to draw from', paidWith };

  // The operator's share is derived from the fare STRIPE recorded, never from the request.
  const travelCostCents = Number(pi.metadata?.travelCostCents || 0);
  if (!travelCostCents) {
    return { ok: false, code: 'no_fare_on_record', error: 'That payment predates fare stamping', paidWith };
  }
  const recordedTollCents = Math.max(0, Number(pi.metadata?.tollCents || 0));
  // Settlement needs only the operator side. Do NOT re-price the platform fee here: the
  // issuing-country schedule was fixed at quote/payment time and is stamped on Stripe.
  const recordedCommission = commissionCents(travelCostCents);
  const q = {
    operatorGets: travelCostCents - recordedCommission + recordedTollCents,
    platformTake: Math.max(0, Number(pi.metadata?.platformTake || 0)),
  };

  // One durable attempt per new Travel. If the process crashes after Stripe
  // executes but before Firestore confirms, subsequent requests reconcile,
  // never issue another payout based only on a possibly-expired idempotency key.
  const { adminDb } = require('./firebase-admin');
  const { transferOnce } = require('./payout-transfer-guard');
  return transferOnce({
    db: adminDb(), rideId, paymentIntentId: pi.id, expectedUid,
    operatorStripeAccount, chargeId, amountCents: q.operatorGets,
    platformTake: q.platformTake, paidWith,
    findTransfers: (group) => stripe.transfers.list({ transfer_group: group, limit: 2 }),
    createTransfer: (group) => stripe.transfers.create({
      amount: q.operatorGets, currency: 'usd',
      destination: operatorStripeAccount,
      source_transaction: chargeId,
      transfer_group: group,
      description: `American Rider travel ${expectedTripNo || ''}`.trim(),
      metadata: {
        tripNo: expectedTripNo || '', rideId,
        paymentIntentId: pi.id, travelCostCents: String(travelCostCents),
      },
    }, { idempotencyKey: `ar_transfer_${rideId}` }),
  });
}

/**
 * Move a fixed amount to an operator, drawn from a specific charge.
 *
 * Used for the arrival fee on a cancellation, where the sum is a flat figure rather than a
 * share of a fare. `source_transaction` ties it to the traveler's own charge, so it waits for
 * those funds exactly as a settlement does, and the idempotency key makes a repeated
 * cancellation request pay once.
 */
async function transferFixed({ paymentIntentId, operatorStripeAccount, amountCents, reference }) {
  if (!(amountCents > 0)) return { ok: false, error: 'nothing to transfer' };
  const stripe = getStripe();
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
    if (!chargeId) return { ok: false, error: 'payment has no charge to draw from' };
    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency: 'usd',
        destination: operatorStripeAccount,
        source_transaction: chargeId,
        description: `American Rider ${reference || 'operator payment'}`.trim(),
        metadata: { reference: reference || '', paymentIntentId: pi.id },
      },
      { idempotencyKey: `ar_fixed_${pi.id}_${amountCents}` },
    );
    return { ok: true, transferId: transfer.id, amountCents: transfer.amount };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Diagnostic: can THIS server actually reach Stripe? Makes the cheapest real API call there
// is and reports how long it took. Returns no account details and no key material, so it is
// safe to expose. Exists because "payment failed" on a phone cannot distinguish between a
// declined card and a server that has no route to Stripe at all — and those need opposite fixes.
async function pingStripe() {
  const started = Date.now();
  try {
    const bal = await getStripe().balance.retrieve();
    return { ok: true, ms: Date.now() - started, livemode: bal.livemode };
  } catch (e) {
    // The SDK's own message ("An error occurred with our connection to Stripe") hides WHY.
    // e.detail holds the underlying Node error, whose .code is the thing worth seeing:
    // ENOTFOUND = DNS failed, ECONNREFUSED = blocked, ETIMEDOUT = hung, CERT_* = TLS.
    const under = e.detail || e.cause || null;
    return {
      ok: false,
      ms: Date.now() - started,
      type: e.type || null,
      code: e.code || null,
      message: e.message,
      underlying: under ? { code: under.code || null, errno: under.errno || null, syscall: under.syscall || null, message: under.message || String(under) } : null,
    };
  }
}

// Raw network probe, bypassing the Stripe SDK entirely: can this host resolve and reach
// api.stripe.com at all? Separates "Stripe SDK problem" from "this container has no route out".
async function probeNetwork() {
  const dns = require('node:dns').promises;
  const https = require('node:https');
  const out = {};

  try {
    const t = Date.now();
    const addrs = await dns.lookup('api.stripe.com', { all: true });
    out.dns = { ok: true, ms: Date.now() - t, families: addrs.map((a) => a.family) };
  } catch (e) {
    out.dns = { ok: false, code: e.code || null, message: e.message };
  }

  out.https = await new Promise((resolve) => {
    const t = Date.now();
    const req = https.get('https://api.stripe.com/healthcheck', { timeout: 15000 }, (res) => {
      res.resume();
      resolve({ ok: true, ms: Date.now() - t, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - t, code: e.code || null, message: e.message }));
  });

  return out;
}

/**
 * Charge a scheduled travel against the card already on file, with nobody holding the phone.
 *
 * A reservation made at 11pm for 6:30am cannot ask for a card at 6:30am — the traveler is
 * asleep. The card kept by `setup_future_usage: 'off_session'` on their previous travel is
 * charged directly, exactly as the gratuity is.
 *
 * ORDER MATTERS AND IS THE CALLER'S JOB. Match an operator FIRST, charge second, write the
 * travel third. Charging first would take money for a journey that may have nobody to drive
 * it; writing first would send an operator to a journey nobody has paid for.
 *
 * The idempotency key is the reservation id, so two overlapping sweeps — or a sweep that
 * times out and is retried — charge the traveler exactly once.
 *
 * Metadata matches createPaymentIntent field for field, deliberately: settlement reads
 * `travelCostCents` and `uid` back off Stripe's own record hours later, and a scheduled
 * travel must settle through the same path as any other.
 */
async function chargeScheduledTravel({ travelCostCents, uid, email, tripNo, reservationId, rideId, dep, dest, governmentFees, cardCountry, tollCents = 0 }) {
  const stripe = getStripe();
  const q = quote(travelCostCents, undefined, governmentFees, cardCountry, tollCents);
  try {
    const customer = await customerForTraveler({ uid, email });
    const pm = await savedPaymentMethodFor(customer);
    if (!pm) {
      return { ok: false, code: 'no_saved_card', error: 'No card on file for this traveler' };
    }
    const pi = await stripe.paymentIntents.create(
      {
        amount: q.travelerPays,
        currency: 'usd',
        customer: customer.id,
        payment_method: pm.id,
        off_session: true,
        confirm: true,
        statement_descriptor_suffix: STATEMENT_DESCRIPTOR,
        receipt_email: email || undefined,
        description: ['American Rider', dep && dest ? `${dep} to ${dest}` : null, tripNo || null]
          .filter(Boolean)
          .join(' · '),
        metadata: {
          product: 'American Rider travel',
          uid: uid || '',
          tripNo: tripNo || '',
          rideId: rideId || '',
          travelCostCents: String(travelCostCents),
          // What American Rider retains — see the note at the other intent-creation sites. A
          // scheduled travel is refunded by exactly the same path, so it needs exactly this.
          platformTake: String(q.platformTake),
          // Held for a public body, not ours. The remittance ledger and a refund both read it here.
          governmentFeeCents: String(q.governmentFeeCents),
          tollCents: String(q.tollCents),
          scheduled: 'true',
        },
      },
      { idempotencyKey: `ar_sched_${reservationId}` },
    );
    // A card that needs the traveler present (3-D Secure) returns requires_action here. That
    // is not a failure of ours and must not be reported as one: the reservation is held and
    // the traveler is asked to confirm, rather than being told their card was declined.
    if (pi.status !== 'succeeded') {
      return {
        ok: false,
        code: pi.status === 'requires_action' ? 'requires_action' : pi.status,
        error: pi.status === 'requires_action'
          ? 'Your bank needs you to confirm this payment'
          : `Payment is ${pi.status}`,
        paymentIntentId: pi.id,
      };
    }
    return { ok: true, paymentIntentId: pi.id, chargedCents: q.travelerPays, breakdown: q };
  } catch (e) {
    return { ok: false, code: e.code || 'charge_failed', error: e.message };
  }
}

/**
 * A PaymentIntent for the operator's screening fee.
 *
 * NOT A TRAVEL. It carries no travelCostCents and no operator share, so it can never be
 * mistaken for a fare by the settlement path — which reads travelCostCents off Stripe's own
 * record and would otherwise try to pay somebody 99% of a background check.
 *
 * A PASS-THROUGH, and the metadata says so in Stripe's own record. American Rider keeps none
 * of it: the amount is what the screening company bills us, and if that changes this changes
 * with it. See backend/screening.js.
 */
async function createScreeningIntent({ amountCents, uid, email }) {
  const stripe = getStripe();
  const customer = await customerForTraveler({ uid, email });
  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customer.id },
    { apiVersion: '2024-06-20' },
  );
  const pi = await stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: 'usd',
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
      setup_future_usage: 'off_session',
      statement_descriptor_suffix: STATEMENT_DESCRIPTOR,
      receipt_email: email || undefined,
      // "Paid at cost" on the receipt as well as on the screen. An operator handing over
      // $47.49 should be able to see, weeks later, that none of it was ours.
      description: 'American Rider · operator screening, paid at cost',
      metadata: {
        product: 'American Rider operator screening',
        passThrough: 'true',
        uid: uid || '',
      },
    },
    // THE AMOUNT IS IN THE KEY. Without it, an operator who is first quoted the full $47.49
    // and later only the $17.50 driving history would be handed back the first intent — and
    // charged the larger figure for the smaller thing.
    { idempotencyKey: `ar_screening_${uid}_${amountCents}` },
  );
  return {
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    customerId: customer.id,
    ephemeralKeySecret: ephemeralKey.secret,
    amountCents,
  };
}

// EVERY function server.js names must appear here. // arrival fee both threw ReferenceError on the first line that mattered — the two paths that
// move money to an operator outside a completed travel, dead from the day they shipped.

/**
 * Where an operator's 99% is sent. Lives here, not in server.js, because the settlement sweep
 * needs it too and a route file cannot be required from a sweep without a cycle.
 *
 * The account is looked up from the operator's OWN record and never accepted from a request:
 * a phone that could name the destination could name its own.
 */
async function operatorPayoutAccount(db, operatorId) {
  if (!operatorId) return { accountId: null, reason: 'no operator on the travel' };
  // A real operator's fleet id IS their uid, so the payout account is one read away.
  const user = await db.collection('users').doc(String(operatorId)).get();
  if (user.exists && user.data()?.stripeAccountId) {
    return { accountId: user.data().stripeAccountId, uid: String(operatorId) };
  }
  // Fall back to the fleet document, which may carry the uid separately.
  const op = await db.collection('operators').doc(String(operatorId)).get();
  const uid = op.exists ? op.data()?.uid : null;
  if (uid) {
    const u2 = await db.collection('users').doc(String(uid)).get();
    if (u2.exists && u2.data()?.stripeAccountId) return { accountId: u2.data().stripeAccountId, uid };
  }
  return { accountId: null, reason: 'that operator has no payout account' };
}

/** Charge the separate monthly Operator active-account cost off-session.
 * The amount is already grossed up by operatorfees.js so the $2 Stripe Connect cost and only
 * its collection cost are recovered. This never touches the Operator's 99% Travel Fare. */
async function chargeOperatorAccountFee({ uid, email, month, amountCents }) {
  const stripe = getStripe();
  const customer = await customerForTraveler({ uid, email });
  const pm = await savedPaymentMethodFor(customer);
  if (!pm) return { ok: false, code: 'no_payment_method', error: 'No saved payment method for the Operator account fee.' };
  try {
    const pi = await stripe.paymentIntents.create({
      amount: Math.max(0, Math.trunc(Number(amountCents) || 0)),
      currency: 'usd',
      customer: customer.id,
      payment_method: pm.id,
      confirm: true,
      off_session: true,
      statement_descriptor_suffix: STATEMENT_DESCRIPTOR,
      receipt_email: email || undefined,
      description: `American Rider · Operator account cost · ${month}`,
      metadata: {
        product: 'American Rider operator account cost',
        uid: String(uid || ''),
        month: String(month || ''),
        passThrough: 'true',
      },
    }, { idempotencyKey: `ar_operator_account_${uid}_${month}_${amountCents}` });
    if (pi.status !== 'succeeded') {
      return { ok: false, code: pi.status, error: `Payment is ${pi.status}`, paymentIntentId: pi.id };
    }
    return { ok: true, paymentIntentId: pi.id };
  } catch (e) {
    return { ok: false, code: e?.code || 'charge_failed', error: e?.message || String(e) };
  }
}

module.exports = {
  operatorPayoutAccount,
  quote, commissionCents, platformFeeCents, isDomesticCard, defaultCardCountry, journeyFeeCents, createPaymentIntent, resumePaymentIntent, verifiedTravelPayment, cancelUnpaidIntent, chargeRide, refundTravel,
  MIN_PLATFORM_FEE_CENTS,
  customerForTraveler, connectAccountFor, connectOnboardingLink, connectAccountStatus,
  transferToOperator, paidWithFromIntent, refundableFor, connectDashboardLink, pingStripe, probeNetwork,
  transferFixed, chargeScheduledTravel, createScreeningIntent, chargeOperatorAccountFee,
  describePaymentMethod, listPaymentMethods, createSetupIntent, setDefaultPaymentMethod, detachPaymentMethod,
  // Exported under an underscored name for idempotency.test.js only. It is an internal detail
  // of how a charge is keyed, not part of the module's interface.
  __idempotencyForTravel: idempotencyForTravel,
  __refundBalanceFromVerifiedIntent: refundBalanceFromVerifiedIntent,
};
