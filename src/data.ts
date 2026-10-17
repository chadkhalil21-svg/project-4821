import { t } from './i18n';
// Demo data — Miami operating market (platform is national by design; market code MIA).

// `cost` is the travel fare in dollars, BEFORE the platform fee. It is a placeholder until the
// server quotes the trip: the price the traveler actually pays always comes from the server
// (see src/backend/fares.ts), never from this file.
//
// `lat`/`lng` are filled in once we've geocoded the place. When they're present the server
// prices the trip by real distance; without them it falls back to its named-place table.
export type Place = {
  name: string;
  short: string;
  cost: number;
  meta: string;
  lat?: number;
  lng?: number;
  /**
   * A place run by a public authority we do not yet hold a permit for. It stays in this list —
   * it is a real place, past travels went there, and the permits are being applied for — but it
   * is NOT offered as somewhere to go. See BOOKABLE_PLACES below.
   *
   * MIRRORS backend/fees.js: the unpermitted records in GOVERNMENT_FEES and every entry of
   * RESTRICTED_PLACES. The server refuses these by geofence whatever the app sends, so this
   * flag is not the gate — it exists so a traveler is never offered something that will then
   * be refused. permits.test.js fails if the two lists disagree.
   */
  permitRequired?: true;
};
export type DepPlace = {
  name: string;
  short: string;
  lat?: number;
  lng?: number;
  /**
   * True only when these coordinates came from the device's own position.
   *
    */
  resolved?: boolean;
};

/** A government per-trip fee inside the price: what it is, who receives it, how much. */
export type FeeLine = { id?: string; name: string; payee: string; cents: number };

export type Trip = {
  arr: string;
  dep: string;
  cost: number;
  proc: number;
  total: number;
  opRev: number;
  pay: string;
  no: string;
  date: string;
  subPrefix: string;
  operator?: string; // the matched operator's name, when known (real rides)
  /** Road miles and boarding-to-completion minutes, for the receipt (Fla. Stat. 627.748(6)). */
  miles?: number;
  minutes?: number;
  /** A refund Patron Support actually issued on this travel, in cents. */
  creditCents?: number;
  /** Government fees inside the total (an airport pickup fee, say). Never our own fee. */
  feeLines?: FeeLine[];
  /** The day the server emailed this receipt to the traveler; absent when it did not. */
  emailed?: string;
};

// Destination names that shipped before 15 Aug 2026, mapped to what they are called now.
//
// Renaming a place does NOT rewrite history: a trip in Firestore keeps the arrival name it
// was booked under, and it must — a receipt has to say what it said on the day. But the
// home screen finds SUGGESTED TRAVEL by matching a past arrival against the bookable list,
// so the rename silently emptied that section for anyone with older trips. Resolve through
// here before matching, and never delete a row: each one is somebody's travel history.
const LEGACY_PLACE_NAMES: Record<string, string> = {
  // Both old airport labels now resolve to the full name. Chad, 15 Aug: "MIA already
  // means Miami International Airport, so 'MIA Airport' is technically redundant and
  // slightly informal." Trips booked under either label read correctly in Recent Travel
  // and the Travel Log without touching a single stored record.
  'Miami Airport': 'Miami International Airport',
  'MIA Airport': 'Miami International Airport',
  'Miami Airport, Terminal D': 'Miami International Airport',
  'Port of Miami': 'PortMiami',
};

/** The current name for a destination recorded at any point in the app's history. */
export function canonicalPlaceName(recorded: string): string {
  return LEGACY_PLACE_NAMES[recorded] ?? recorded;
}

/**
 * A stored location, tidied for display.
 *
 * Apple's geocoder answers with the parcel it matched, not the address a person would
 * write, so trips came back labelled "17810–17824 SW 292 St" — a block range and an
 * un-ordinalised street. Chad, 15 Aug: "That looks like geocoder output rather than a
 * location American Rider has deliberately presented… An institutional interface should
 * feel like it knows where the travel occurred."
 *
 * This narrows the range to its first number and restores the ordinal suffix. It does NOT
 * invent detail: we cannot know which door of a block a traveler stood at, so it prefers
 * the honest low end over a plausible-looking guess. Named pickups ("Home — Brickell City
 * Centre") never match the range pattern and pass through untouched.
 *
 * The real fix is upstream — store the address the traveler actually chose instead of the
 * geocoder's echo. Until then this stops the raw string reaching the screen.
 */
// "Home", "Work" and "Current location" are UI words that happen to sit in seed data;
// the place beside them is a proper noun and stays. Translating the label here rather
// than in the data keeps the place records language-neutral.
const PLACE_LABELS: Record<string, string> = {
  Home: 'traveler.placeHome',
  Work: 'traveler.placeWork',
  'Current location': 'traveler.placeCurrent',
};

export function prettyPlace(recorded: string): string {
  if (!recorded) return recorded;
  let s = canonicalPlaceName(recorded).trim();
  const labelled = s.match(/^([^—]+?)\s+—\s+(.+)$/);
  if (labelled && PLACE_LABELS[labelled[1]]) {
    return `${t(PLACE_LABELS[labelled[1]])} — ${labelled[2]}`;
  }
  // "17810–17824 SW 292 St" → "17810 SW 292 St" (en dash, em dash or hyphen)
  s = s.replace(/^(\d+)\s*[–—-]\s*\d+\b/, '$1');
  // "SW 292 St" → "SW 292nd St" — a street number with no ordinal reads as machine output
  s = s.replace(/\b(\d+)\s+(St|Ave|Ct|Ter|Pl|Rd|Dr)\b/g, (_m, n: string, kind: string) => {
    const num = Number(n);
    const tens = num % 100;
    const suffix =
      tens >= 11 && tens <= 13
        ? 'th'
        : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[num % 10] ?? 'th';
    return `${n}${suffix} ${kind}`;
  });
  return s;
}

// Named saved/example pickups carry their own coordinates. Device “Current location” is
// deliberately absent from this static collection: it may only come from src/location.ts
// after the device establishes a real position and a human-readable pickup place.
export const DEP_PLACES: DepPlace[] = [
  { name: 'Home — Brickell City Centre', short: 'Brickell', lat: 25.7689, lng: -80.1935 },
  { name: 'Work — Coral Gables', short: 'Coral Gables', lat: 25.7215, lng: -80.2684 },
  { name: 'Wynwood', short: 'Wynwood', lat: 25.801, lng: -80.1994 },
  { name: 'South Beach', short: 'South Beach', lat: 25.7826, lng: -80.1341 },
  { name: 'PortMiami · Cruise Terminal', short: 'PortMiami', lat: 25.7785, lng: -80.1687 },
];

// Where exactly to stand at big venues — shown on the ride screen while the operator is
// heading over, keyed by the pickup's `short` name. Airports and stadiums have designated
// rideshare zones and a bad meeting spot wastes everyone's time.
// ⚠️ These are sensible defaults, NOT verified venue data. Before production use, someone must
// confirm each one on the ground (venues move their rideshare zones around).
// NO OPERATOR IS NAMED HERE. Two of these read "Meet Miguel…" and "…ready for Miguel" —
// the demo operator, printed to every traveler whichever operator dispatch actually matched.
// Guidance about a place must not assert who is driving.
// KEYS, NOT SENTENCES — this module is evaluated at import, before the stored language
// is read, so a sentence here would pin every traveler to the default locale. Screens
// translate at render. Place NAMES stay as they are: they are proper nouns.
export const VENUE_NOTES: Record<string, string> = {
  // KEYED BY `short`. If the place's short name changes, this key changes with it or the
  // note silently stops matching and no one notices — it just never appears.
  'Miami International Airport':
    'traveler.venueMIA',
  'Fort Lauderdale Airport':
    'traveler.venueFLL',
  'Hard Rock Stadium':
    'traveler.venueHardRock',
  Aventura:
    'traveler.venueAventura',
  'Kaseya Center':
    'traveler.venueKaseya',
  Bayside: 'traveler.venueBayside',
  'PortMiami':
    'traveler.venuePortMiami',
  'Convention Center':
    'traveler.venueConvention',
};

// Fare model (ONE all-in price for the traveler): the operator keeps 99% of the fare
// (1% coordination commission, no cap). American Rider adds the smallest whole-cent
// per-Travel Platform Fee that satisfies the current cost model, with a $2.00 minimum.
// platformFee() mirrors backend/economics.js; the server remains authoritative. The fee
// absorbs payment-processing cost, so the traveler is never shown a separate "processing"
// line. Total charged = fare + platformFee(fare).
// PROC_* below is our INTERNAL processing cost (not added on top, not shown to travelers).
// Travel classes (the web demo's Travel Options). ⚠️ MIRROR of backend/fares.js
// TRAVEL_CLASSES — the server is the authority; these exist so screens can DISPLAY
// per-class prices with the same math the server will charge.
export const TRAVEL_CLASSES = [
  { key: 'standard', label: 'Standard', sub: 'traveler.classStandardSub', mult: 1.0, extraCents: 0, bookable: true },
  // NOT BOOKABLE — nothing behind them yet. Kept in the list so pricing, receipts
  // and the Travel Log still resolve any travel already booked under one.
  //   premium    — "Highest-rated operators", and no operator carries a rating at all
  //   shared     — there is no pooling; it was a private travel at a 32% discount, which the
  //                operator absorbed out of their 99%
  //   accessible — no operator declares it and nothing verifies a ramp
  // Restore each ALONGSIDE the thing it promises: a real rating, real pooling, a verified
  // accessible vehicle. Founders' decision, 18 Aug 2026.
  { key: 'premium', label: 'Premium', sub: 'traveler.classPremiumSub', mult: 1.42, extraCents: 0, bookable: false },
  { key: 'shared', label: 'Shared', sub: 'traveler.classSharedSub', mult: 0.68, extraCents: 0, bookable: false },
  { key: 'large', label: 'Large Vehicle', sub: 'traveler.classLargeSub', mult: 1.55, extraCents: 0, bookable: true },
  { key: 'accessible', label: 'Accessible', sub: 'traveler.classAccessibleSub', mult: 1.0, extraCents: 0, bookable: false },
  { key: 'pet', label: 'Pet Friendly', sub: 'traveler.classPetSub', mult: 1.0, extraCents: 300, bookable: true },
] as const;

/**
 * The class key a traveler chose ('large'), as operators declare it ('Large Vehicle').
 *
 * Dispatch matches against the `classes` array on an operator record, which holds labels.
 * The app carries keys. Nothing translated between them, so dispatch was called with a
 * hardcoded 'Standard' and the class a traveler paid for was discarded on the way.
 */
export const operatorClassFor = (key: string): string =>
  (TRAVEL_CLASSES.find((t) => t.key === key) ?? TRAVEL_CLASSES[0]).label;

/** What a traveler may actually choose. See the bookable flags above for why. */
// `permitRequired` above is still read — by permits.test.js, which checks that nothing the app
// KNOWS about is a place the server would refuse, and by anyone reading this list to understand
// why an airport is here but not offered. The BOOKABLE_PLACES filter that stood here for an
// hour on 20 Sept 2026 is gone: both screens now ask the server what can be booked from where
// the traveler is standing (backend/places.js), which fixes the same fault and the larger one
// behind it. A filtered copy of a list nobody reads any more is dead code, and dead code in a
// pricing file is how the next person learns the wrong rule.

export const BOOKABLE_CLASSES = TRAVEL_CLASSES.filter((t) => t.bookable);

/** The catalogue key for each class's name — the render site calls t() on it. Written out
 *  (not built) so the unused-key gate can see every key. The English `label` stays for
 *  operator and server surfaces, which speak ARTS. */
export const CLASS_NAME_KEYS: Record<string, string> = {
  standard: 'traveler.classStandardName',
  premium: 'traveler.classPremiumName',
  shared: 'traveler.classSharedName',
  large: 'traveler.classLargeName',
  accessible: 'traveler.classAccessibleName',
  pet: 'traveler.classPetName',
};
export const classNameKey = (key: string) => CLASS_NAME_KEYS[key] ?? CLASS_NAME_KEYS.standard;

export const applyClassCents = (cents: number, key: string) => {
  const cls = TRAVEL_CLASSES.find((t) => t.key === key) ?? TRAVEL_CLASSES[0];
  return Math.round(cents * cls.mult) + cls.extraCents;
};

// Qualifying commercial insurers — real quote links, shown on the economics screen and
// the operator qualification's Commercial Insurance step. We verify coverage, never sell it.
// THE REFERRED BROKER — the insurance step done inside the platform rather than by sending
// an operator away with homework.
//
// An operator told "go and buy commercial coverage, then come back" mostly does not come
// back. The three INSURERS links below are national quote pages: better than nothing, and
// nobody there knows what American Rider is or what our operators need. A named broker who
// has agreed to quote our people is a different thing — one call, someone expecting them.
//
// AMERICAN RIDER TAKES NO SHARE. No commission, no referral fee, no margin on the premium.
// That is stated on the screen because an operator being sent to a broker by the company
// that profits from their fares is entitled to know whether we are being paid to send them.
// We are not, and if that ever changes the sentence has to change with it.
//
// `null` until a broker is actually engaged (Chad, from Monday 31 Aug 2026). The screen shows
// nothing rather than a placeholder: a referral to nobody is worse than no referral.
export type Broker = {
  name: string;
  /** What they are, in the operator's terms. Not marketing copy. */
  note: string;
  phone: string;
  /** Florida agency licence number, so an operator can verify them at the state themselves. */
  license?: string;
  url?: string;
  /** Plain-language hours. An operator ringing a closed office reads it as us wasting them. */
  hours?: string;
  /** Written enquiries. An operator who cannot ring during office hours still has a route in. */
  email?: string;
};

// ENGAGED 20 SEPT 2026 (Chad). Until today this was `null` and the whole recommended-broker
// block was absent, which was right while no broker existed — a referral to nobody is worse
// than no referral.
//
// THE LICENCE NUMBER AND THE NAME ARE NOT THE ONES WE WERE GIVEN, AND THAT IS THE POINT.
// The screen invites the operator to check the licence at the Florida Department of Financial
// Services themselves (`insVerifyLicence`), so the number printed here has to survive that
// check. It was run, on 20 Sept 2026, against licenseesearch.fldfs.com:
//
//   L084885  →  "No Licensee found".
//   L084884  →  GARZOR INSURANCE LLC, 4369 Hunters Park Lane, Orlando FL 32837.
//
// One digit. Printing the number as given would have handed every operator a licence number
// that the state says does not exist — from the one screen whose whole job is to stop them
// being sold the wrong policy. The legal name is LLC, not "Inc.", and the state has no record
// at the Thorpe Road address we were given. Searching the firm name returns three records
// (L084884 and L087775 for GARZOR INSURANCE LLC, L112737 for GARZOR RISK UNDERWRITERS LLC);
// L084884 is the one whose number matches what we were given to a digit, and it is the one
// used here. All three carry the same garzorinsurance.com contact address, so the agency is
// real — it is the identifiers that were wrong.
//
// Public contact number and commercial-quotes@ email were cross-checked against the
// agency's own contact page on 16 Oct 2026, not against the state's licence register.
// The insurance options are neutral: this historical agency record is not a preferred
// provider and is not displayed in the comparison choices.
export const BROKER: Broker | null = {
  name: 'Garzor Insurance LLC',
  note: 'traveler.brokerGarzorNote',
  phone: '(321) 206-8035',
  email: 'commercial-quotes@garzorinsurance.com',
  license: 'L084884',
  hours: 'traveler.brokerGarzorHours',
};

// WHO APPEARS HERE, AND WHO WAS TAKEN OFF (Chad, 20 Sept 2026).
//
// STATE FARM WAS REMOVED. It and Allstate generally exclude for-hire and livery use from their
// standard commercial lines, so an operator who rings them is sent away — or worse, sold a
// policy that does not cover the thing they are about to do. A name on this list is a claim
// that the call is worth making.
//
// `secondary: true` holds a row behind "Compare more options", so the screen does not present
// five names as five equal answers. Progressive is the only one shown beside Garzor: an
// established carrier writing for-hire livery in 43 states.
//
// `unverified: true` prints that we have not checked the agency's licence ourselves. Two of
// these are local shops an operator may well prefer, and the honest thing is to list them with
// what we do and do not know about them rather than to leave them out or to imply a check we
// have not made. Insurify is not an insurer at all and says so.
export const INSURERS: {
  name: string;
  note: string;
  url?: string;
  phone?: string;
  secondary?: boolean;
  unverified?: boolean;
  states?: string[];
}[] = [
  // ONE-FORM COMPARISON FIRST. Stanford's marketplace research points to reducing search
  // friction while preserving seller price competition. This service sends one livery
  // application to three specialist agents in the operator's state; it is not an insurer.
  {
    name: 'Limousine Insurance HQ',
    note: 'traveler.insurerLimoHQNote',
    url: 'https://www.limousineinsurancehq.com/',
  },
  // Florida is a specialty-agent state for Progressive livery. The operator is sent to the
  // livery product, not to a personal rideshare endorsement.
  {
    name: 'Progressive Commercial',
    note: 'traveler.insurerProgressiveNote',
    url: 'https://www.progressivecommercial.com/commercial-auto-insurance/livery-insurance/',
  },
  // Miami-based Florida livery specialist: black car, executive sedan, SUV, limo and shuttle.
  {
    name: 'American US Insurance',
    note: 'traveler.insurerAmericanUSNote',
    url: 'https://amerinsured.com/business-insurance/limo-insurance',
    states: ['FL'],
    secondary: true,
  },
  // Florida passenger-transport specialist. Publicly states it shops livery programs and
  // represents Progressive among other markets.
  {
    name: 'Transportation Insurance of Central Florida',
    note: 'traveler.insurerTICFNote',
    url: 'https://www.ticfinsurance.com/',
    states: ['FL'],
    secondary: true,
  },
  // All-50-state commercial agency with livery / black-car / limousine specialty markets.
  {
    name: 'Casurance',
    note: 'traveler.insurerCasuranceNote',
    url: 'https://casurance.com/livery-insurance',
    secondary: true,
  },
  // General commercial marketplace. Included as a broad-market cross-check, not as proof that
  // every quoted carrier will write Florida TNC/livery. The operator must still apply the
  // policy-standard checklist before binding.
  {
    name: 'Insureon',
    note: 'traveler.insurerInsureonNote',
    url: 'https://www.insureon.com/livery-business-insurance',
    secondary: true,
  },
];

export const APP_FEE = 2.5;

// Internal economics constants. The server remains authoritative; these mirror
// backend/economics.js so local display fallbacks cannot quote a different amount.
// Stripe's $2 monthly active-account cost is recovered separately from low-volume Operators
// and waived at 20 completed Travels; it is not a Traveler transaction cost.
const CARD_BPS_DOMESTIC = 290;
const CARD_BPS_INTERNATIONAL = 440;
const STRIPE_FIXED_CENTS = 30;
const CONNECT_VARIABLE_BPS = 50;
const CONNECT_FIXED_ALLOWANCE_CENTS = 6;
const CONTINGENCY_RESERVE_CENTS = 25;
const OPERATING_OVERHEAD_ALLOWANCE_CENTS = 25;
const MIN_PLATFORM_CONTRIBUTION_CENTS = 75;

/** Unknown is intentionally international-safe; first-time foreign cards are not subsidized. */
export function isDomesticCard(cardCountry?: string | null): boolean {
  return String(cardCountry || '').trim().toUpperCase() === 'US';
}

const ceilBps = (cents: number, bps: number) =>
  cents > 0 && bps > 0 ? Math.ceil((cents * bps) / 10000) : 0;

/**
 * The smallest whole-cent fee that preserves the complete unit-economic invariant.
 *
 * This is NOT "$2 or a percentage". It directly funds card processing on the whole charge,
 * both variable Connect charges, the per-payout fixed Connect allowance, 25c contingency,
 * 25c operating/infrastructure allowance and at least 75c of platform contribution.
 *
 * Government fees and tolls remain pass-throughs to their beneficiaries. Their induced
 * payment-processing cost is recovered in this fee instead of being silently subsidized.
 */
export function platformFee(
  travelCost: number,
  cardCountry?: string | null,
  governmentFee = 0,
  toll = 0,
  transactionCount = 1,
): number {
  const fareCents = Math.max(0, Math.round(travelCost * 100));
  const governmentCents = Math.max(0, Math.round(governmentFee * 100));
  const tollCents = Math.max(0, Math.round(toll * 100));
  const units = Math.max(1, Math.trunc(transactionCount || 1));
  const commission = Math.floor(fareCents * 0.01);
  const operatorGets = fareCents - commission + tollCents;
  const bps = isDomesticCard(cardCountry) ? CARD_BPS_DOMESTIC : CARD_BPS_INTERNATIONAL;

  const sufficient = (feeCents: number) => {
    const travelerPays = fareCents + feeCents + governmentCents + tollCents;
    const stripe = ceilBps(travelerPays, bps) + STRIPE_FIXED_CENTS * units;
    const connectVariable = ceilBps(operatorGets, CONNECT_VARIABLE_BPS);
    const contribution =
      commission + feeCents -
      stripe -
      connectVariable -
      CONNECT_FIXED_ALLOWANCE_CENTS * units -
      CONTINGENCY_RESERVE_CENTS * units -
      OPERATING_OVERHEAD_ALLOWANCE_CENTS * units;
    return contribution >= MIN_PLATFORM_CONTRIBUTION_CENTS * units;
  };

  let lo = Math.round(APP_FEE * 100);
  if (sufficient(lo)) return lo / 100;
  lo += 1;
  let hi = Math.max(400, Math.ceil(fareCents * 0.10) + 500);
  while (!sufficient(hi)) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sufficient(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo / 100;
}

/**
 * Recover the fare from an all-in fare+platform-fee total. Pass-throughs are not part of this
 * inversion; receipts know them explicitly and must remove them before calling this helper.
 */
export function fareFromTotal(total: number, cardCountry?: string | null): number {
  if (total <= 0) return 0;
  let lo = 0;
  let hi = total;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (mid + platformFee(mid, cardCountry) > total) hi = mid;
    else lo = mid;
  }
  return Math.round(lo * 100) / 100;
}

// Legacy demo-only internal estimates. They are not used to price a live Travel.
export const PROC_ACH = 0.25;
export const PROC_CARD = 0.74;
export const procFor = (pay: string) => (pay === 'ach' ? PROC_ACH : PROC_CARD);// The coordination commission: a flat 1% of the travel fare. NO CAP.
//
// This capped at $1 until 16 Aug 2026 — as does the founders' web demo, whose own
// coord() is Math.min(0.01*c, 1). Chad corrected it: "there is no 1 dollar cap, it is
// just a 1% + $1.50 amount." The demo is the reference for how the app LOOKS; the fare
// model is a business fact, and on a business fact the founders outrank the prototype.
//
// It matters most on long travel: a $120 journey was commissioned $1.00 and is now $1.20.
// backend/payments.js carries the same change — the two must never disagree.
// Convert the Fare to integer cents before applying 1%: float-first math incorrectly
// gave 28c instead of 29c commission on a $29 Fare (and other exact-dollar fares).
// The server remains authoritative and uses floor(fareCents * 0.01).
export const coordinationFee = (cost: number) => {
  const fareCents = Math.max(0, Math.round(cost * 100));
  return Math.floor(fareCents / 100) / 100;
};

// Payment method names in the demo's exact lettering.
// THE INVENTED ACCOUNT NUMBERS ARE GONE — 17 Aug 2026. These read
// "Bank Account · ACH ····4417" and "Visa ····8802": digits nobody owns, printed on Wallet,
// Travel Confirmation, the receipt and the profile as a record of the traveler's own
// accounts. Fabricated financial detail is the worst thing to put on a money screen.
//
// These are now generic, and they are only ever a PLACEHOLDER: the moment a travel is paid,
// the label is replaced with the method Stripe actually charged, read back from the
// confirmed PaymentIntent (see methodLabel in src/backend/payments.ts).
export const PAY_FRIENDLY: Record<string, string> = {
  ach: 'Bank account',
  apple: 'Apple Pay',
  gpay: 'Google Pay',
  card: 'Card',
};

// PAY_NOTES held "Demo payment — nothing real is charged yet" against every method. That
// sentence becomes false the moment a live Stripe key is installed, and a payment note is
// the worst place in the app for a stale claim. Whether money is real is now answered by the
// server's own key mode — see paymentModeNote() in src/state/PaymentConfigContext.tsx — so
// there is nothing left to keep in step by hand.

export const PAY_ORDER = ['ach', 'apple', 'gpay', 'card'] as const;

// Patron Support categories.
//
// THESE USED TO CARRY THEIR OWN ANSWERS. Each row held a `title` and `body` written months
// in advance — "Adjustment issued — $1.15 · The route deviated 0.8 miles from the optimal
// path" — which the app displayed 1.9 seconds after the row was tapped, before the traveler
// had said a word and without reading anything about their travel. It also credited nobody:
// the $1.15 was a sentence, not a refund.
//
// A category is now what it should always have been: a heading over a box the traveler
// writes in. The answer comes from the server (backend/support.js), which reads what they
// wrote against the recorded facts of that travel and either explains, refunds inside a
// server-enforced cap, or files the case to a person.
//
// `route` sends a category somewhere else entirely — a lost item needs its own flow, not a
// paragraph. `alwaysHuman` says so on screen BEFORE the traveler writes: the server enforces
// it regardless (backend/support.js ALWAYS_HUMAN), and someone reporting a safety incident
// should not have to wonder whether a machine is about to answer them.
export const ISSUES: Record<
  string,
  { label: string; prompt: string; route?: string; alwaysHuman?: boolean }
> = {
  fare: {
    label: 'traveler.incorrectTravelCost',
    prompt: 'traveler.promptFare',
  },
  lost: {
    label: 'traveler.lostItem',
    prompt: '',
    route: '/lost',
  },
  route: {
    label: 'traveler.routeConcern',
    prompt: 'traveler.promptRoute',
  },
  cancel: {
    label: 'traveler.cancellation',
    prompt: 'traveler.promptCancel',
  },
  safety: {
    label: 'traveler.safetyTopic',
    prompt: 'traveler.promptSafety',
    alwaysHuman: true,
  },
};

// The demo's phase register. Index = internal ride status 0..5.
export const STATUS_LABELS = [
  'Travel Confirmed',
  'Operator En Route',
  'Operator Arrived',
  'Traveler Onboard',
  'Arrival', // the demo's 4th phase title; the sub carries "Approaching your destination."
  'Travel Complete',
];


// PAST_TRIPS_SEED and PRE_CREDITED are deleted, not left unused. Three fabricated journeys
// — June 28, June 21 and June 14, with amounts, travel numbers and a "$1.15 credit" on one
// — were merged into every account as travels that person had taken and paid for, and a
// receipt could be opened for any of them. Travel history comes from the records now.
