'use strict';
// Offline, twice-run contract checks for the pre-qualification Operator Economics screen.
// The display is an illustration, never a live quote, payout, or income guarantee.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { commissionCents, MIN_PLATFORM_FEE_CENTS, minimumPlatformFeeCents } = require('./economics');

const source = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const screen = source('app/operator/economics.tsx');
const clientMath = source('src/data.ts');

const requiredKeys = [
  'econTitle', 'econIntro', 'econShare', 'econFee', 'econExamples',
  'econPlatformFeeTitle', 'econPlatformFeeDetail',
  'econExampleFare', 'econOperatorRetains', 'econAmericanRiderShare',
  'econYourScenario', 'econWeeklyInput', 'econAmountPlaceholder',
  'econInvalid', 'econRetainedIllustration', 'econProjectionNote',
  'econCostsHeading', 'econAccountCostNote', 'econShowAccountTerms',
  'econHideAccountTerms', 'econDisclaimer', 'activeAccountCostBody',
  'econReviewRequirements',
];

for (let pass = 0; pass < 2; pass++) {
  assert.match(screen, /const EXAMPLE_FARES = \[20, 50\]/, 'use everyday per-Travel fare examples');
  assert.match(screen, /<Num size=\{46\} weight="600" style=\{styles\.heroPercent\}>99%<\/Num>/,
    'make the exact 99% share the principal visual');
  assert.match(screen, /coordinationFee\(example\)/, 'use existing canonical 1% client display helper');
  assert.match(screen, /t\('operator\.econPlatformFeeTitle', \{ amount: fmt\(APP_FEE\) \}\)/,
    'display minimum Platform Fee from shared app constant, not a hardcoded stale amount');
  assert.match(screen, /t\('operator\.econPlatformFeeDetail'\)/,
    'explain what the Traveler Platform Fee funds without altering the fare split');
  assert.ok(screen.indexOf('operator.econPlatformFeeTitle') < screen.indexOf('operator.econExamples'),
    'minimum Platform Fee is visible before any Fare examples');
  assert.match(clientMath, /export const APP_FEE = 2\.5;/,
    'minimum Fee shown to Operators must use the app shared 2.50 floor');
  assert.equal(MIN_PLATFORM_FEE_CENTS, 250,
    'authoritative server minimum Platform Fee is $2.50');
  assert.equal(minimumPlatformFeeCents({travelCostCents: 2000, cardCountry: 'US'}), 250,
    'example $20 Fare uses the actual minimum $2.50 processing-based Fee');
  assert.match(screen, /coordinationFee\(fare\)/, 'use the same commission rule for scenarios');
  assert.match(screen, /weeklyFare\.trim\(\)\.replace\(',', '\.'\)/, 'accept comma decimal input');
  assert.match(screen, /!valid/, 'reject invalid weekly-fare input');
  assert.match(screen, /accessibilityLabel=\{t\('operator\.econWeeklyInput'\)\}/,
    'preserve explicit accessible calculator label');
  assert.match(screen, /accessibilityRole="alert"/, 'read input errors to assistive technology');
  assert.match(screen, /accessibilityState=\{\{ expanded: showAccountTerms \}\}/,
    'announce current account-term disclosure state');
  assert.match(screen, /minHeight: 44/, 'account-term disclosure is touch accessible');
  assert.match(screen, /t\('operator\.econAccountCostNote'\)/, 'display a cost warning without hiding it');
  assert.match(screen, /t\('operator\.activeAccountCostBody'\)/,
    'reuse the existing live-policy copy and avoid duplicated obsolete fee terms');
  assert.match(screen, /t\('operator\.econProjectionNote'\)/,
    'make 52-week assumptions and missing expenses explicit');
  assert.match(screen, /estimateNote: \{ color: colors\.ink2/,
    'weekly-projection limitations have readable text contrast');
  assert.match(screen, /disclaimer: \{ color: colors\.ink2/,
    'financial warnings have readable text contrast');
  assert.match(screen, /t\('operator\.econDisclaimer'\)/,
    'do not promise Travel volume or profit');
  assert.ok(screen.indexOf('operator.fareResearchLink') > screen.indexOf('operator.econDisclaimer'),
    'optional market research must not interrupt the principal economics and expenses');
  assert.doesNotMatch(screen, /fetch\(|axios\(|getDocs\(/,
    'an informational calculator must not create unnecessary database requests');

  assert.match(clientMath, /const fareCents = Math\.max\(0, Math\.round\(cost \* 100\)\);/,
    'app commission converts input Fare to integer cents');
  assert.match(clientMath, /return Math\.floor\(fareCents \/ 100\) \/ 100;/,
    'app commission uses whole-cent 1% flooring to match the server');
  for (const fareCents of [2900, 5800, 11600, 20500, 20700, 23200, 41000, 43900]) {
    const fareDollars = fareCents / 100;
    const clientFeeCents = Math.floor(Math.max(0, Math.round(fareDollars * 100)) / 100);
    assert.equal(clientFeeCents, commissionCents(fareCents),
      'round-number fare must never misstate the Operator share by a cent');
  }
  for (let fareCents = 1; fareCents <= 200000; fareCents++) {
    const clientFeeCents = Math.floor(Math.round((fareCents / 100) * 100) / 100);
    assert.equal(clientFeeCents, commissionCents(fareCents),
      'every Fare cent through $2,000 must display the canonical Operator share');
  }
  for (const fareCents of [1, 99, 100, 2000, 5000, 100000, 100000000]) {
    const feeCents = commissionCents(fareCents);
    assert.equal(feeCents, Math.floor(fareCents * 0.01));
    assert.equal(fareCents - feeCents, fareCents - Math.floor(fareCents / 100),
      'operator examples must mirror the server 99% entitlement in integer cents');
  }

  // An aggregate weekly estimate is not a statement of exact paid per-Travel commissions.
  // The actual $20.99 x 100 case has 20c commission per Travel, whereas flooring a
  // single weekly 1% calculation would assess $20.99 instead of $20.00.
  const individualFareCents = 2099, weeklyTravels = 100;
  const weeklyFareCents = individualFareCents * weeklyTravels;
  const actualCommissionCents = commissionCents(individualFareCents) * weeklyTravels;
  const scenarioCommissionCents = commissionCents(weeklyFareCents);
  assert.equal(actualCommissionCents, 2000);
  assert.equal(scenarioCommissionCents, 2099);
  assert.equal(scenarioCommissionCents - actualCommissionCents, 99);
  assert.match(source('src/i18n/en.ts'),
    /econProjectionNote:[^\n]*rounded down for each Travel/,
    'weekly calculator must disclose per-Travel cent rounding rather than imply an exact payout');

  for (const language of ['en', 'es', 'fr', 'it', 'de']) {
    const locale = source('src/i18n/' + language + '.ts');
    for (const key of requiredKeys) {
      assert.match(locale, new RegExp('^\\s*' + key + ':', 'm'), language + ': ' + key);
    }
    assert.match(locale, /econPlatformFeeTitle:[^\n]*%\{amount\}/,
      language + ': Fee amount is localized through the shared constant');
    assert.match(locale, /econAccountCostNote:[^\n]*2\s*\$|econAccountCostNote:[^\n]*\$2/,
      language + ': $2 separate account cost must be visible');
  }
}
console.log('PASS twice: Operator Economics screen, 99% arithmetic, real-sized examples, accessible disclosure and five locales and cent-precise app/server display parity; no network or billing change.');
