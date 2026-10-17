const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const reserve = read('app/reserve.tsx');
assert.match(reserve, /ride\.setQuotedFareCents\(null\);[\s\S]*ride\.setQuotedFeeLines\(\[\]\);[\s\S]*ride\.setTripCoords\(null\);/);
assert.match(reserve, /const authoritativePriceReady = ride\.quotedFareCents != null &&/);
assert.match(reserve, /ride\.quotedTotalCents != null && ride\.quotedForClass===ride\.travelClass/);
assert.match(reserve, /authoritativePriceReady&&key===ride\.travelClass&&ride\.quotedTotalCents!==null/);
assert.match(reserve, /!authoritativePriceReady \? \(/); // The total must not print a provisional figure.
assert.doesNotMatch(reserve, /const baseCents = ride\.quotedFareCents \?\? Math\.round\(ride\.arrival\.cost \* 100\)/);

const ride = read('app/ride.tsx');
const cancelCalls = [...ride.matchAll(/ride\.cancelRide\(\)/g)];
assert.ok(cancelCalls.length >= 2, 'both cancellation surfaces remain covered');
assert.equal((ride.match(/await ride\.cancelRide\(\)/g) || []).length,
  cancelCalls.length, 'every visible cancellation awaits authority before navigating');
assert.match(ride, /if \(ok\) router\.dismissTo\('\/'\)/);
assert.match(ride, /if \(await ride\.cancelRide\(\)\) router\.dismissTo\('\/'\)/);

const support = read('src/state/RideContext.tsx');
assert.match(support, /submitIssue\([\s\S]*?\.catch\(\(\) => \{[\s\S]*?setIssueState\('describing'\)/);
const issues = read('app/issues.tsx');
assert.match(issues, /if \(!await ride\.submitDescription\(draft\)\) setSubmissionFailed\(true\)/);
assert.match(issues, /submissionFailed && <Text/);

const pickup = read('app/operator/pickup.tsx');
assert.doesNotMatch(pickup, /op\.cancelOp\(\)/);
assert.match(pickup, /const ok = await op\.confirmArrival\(\)/);
assert.match(pickup, /const ok = await op\.beginTrip\(active\.teen \? pickupEntry : undefined\)/,
  'Operator must submit private Teen code before requesting Travel progression');
const trip = read('app/operator/trip.tsx');
assert.match(trip, /const ok = await op\.completeOp\(\)/);
assert.match(trip, /disabled=\{completing\}/);
const communicate = read('app/operator/communicate.tsx');
assert.match(communicate, /if \(!text \|\| !tripNo \|\| sendingRef\.current\) return/);
assert.match(communicate, /disabled=\{sending \|\| !draft\.trim\(\) \|\| !tripNo\}/);
const home = read('app/index.tsx');
assert.match(home, /if \(!await ride\.cancelScheduled\(\)\) setScheduledCancelError/);
assert.match(home, /disabled=\{cancellingScheduled\}/);
const operatorHome = read('app/operator/index.tsx');
assert.match(operatorHome, /if \(await op\.acceptRequest\(request\)\) \{\s*dismissAccepted\(\)/,
  'server accepts before the offer sheet is visually dismissed');
assert.doesNotMatch(operatorHome, /closeRequest\(\);[\s\S]{0,220}op\.acceptRequest/,
  'accept cannot lapse an offer before the authoritative transition');
assert.match(operatorHome, /if \(acceptingRef\.current\) return/);
const commissioned = read('app/operator/commissioned.tsx');
assert.match(commissioned, /if \(!op\.ready \|\| op\.verification !== 'commissioned'\)/,
  'the commissioned title is unreachable until server qualification resolves');
const economics = read('app/operator/economics.tsx');
assert.match(economics, /EXAMPLE_FARES = \[20, 50\]/, 'individual Travel examples are realistic arithmetic, not forecasts');
assert.match(economics, /operator\.econAccountCostNote/, 'Operator sees separate account charges before setup');
assert.match(economics, /const commission = coordinationFee\(example\)/);
assert.match(economics, /const retained = fare == null \? null : fare - coordinationFee\(fare\)/);
assert.match(economics, /operator\.econRetainedIllustration/);
const qualification = read('app/operator/qualify.tsx');
assert.match(operatorHome, /router.replace\(op.verification === 'pending' \? '\/operator\/review' : '\/operator\/economics'/,
  'new Operators still see their economic scenario before registration');
assert.match(qualification, /QUAL_DOCS.map\(\(d, i\)/,
  'the short compliance checklist remains available in open counties');
assert.match(qualification, /operator.econTitle/,
  'Operator can revisit economics whenever needed without rereading a long preamble');
const insurance = read('app/operator/insurance.tsx');
assert.match(insurance, /const policyApproved = liveStatus\?\.documentApproved === true/,
  'original document approval must be read from authenticated server, not stale phone cache');
assert.match(insurance, /const current = policyApproved && liveStatus\?\.ok === true/,
  'a document alone cannot display current independently verified coverage');
assert.match(insurance, /const expiring = coverageDaysLeft != null && coverageDaysLeft <= 30/);
assert.match(insurance, /const canUpload = !policyApproved \|\| expiring/,
  'renewal and replacement must remain possible before expiry');
assert.match(insurance, /\{policyApproved && <>/,
  'server-reviewed insurance must let the Operator request independent status confirmation');
assert.ok(insurance.indexOf('operator.insRequirementsHeadline') < insurance.indexOf('operator.coverageOnFile')
  && insurance.indexOf('operator.insOwnBroker') < insurance.indexOf('operator.insCompareDisclosure'),
  'show essential coverage requirements first; own-broker and comparison paths remain visible');
assert.match(insurance, /showLegalDetails/,
  'the statutory details must remain available without crowding the initial screen');
for (const authority of ['insFloridaLawBody', 'insARPolicyBody', 'insBrokerDecisionBody', 'insARVerificationBody']) {
  assert.ok(insurance.includes(authority), `${authority} must remain distinct`);
}
const florida = require('./insurance-jurisdictions').forState('FL');
assert.match(florida.script, /American Rider's current onboarding policy/);
assert.match(florida.script, /the driver, the company, or both/);
assert.doesNotMatch(florida.script, /lowest-cost policy/);
const emergency = read('app/emergency.tsx');
assert.match(emergency, /try \{\s*const result = await alertEmergency/);
assert.match(emergency, /catch \{[\s\S]*?state: 'failed'[\s\S]*?finally \{\s*alertBusy\.current = false/,
  'a thrown emergency request must preserve the retry action');
console.log('PASS transient UI/authority boundary invariants');
