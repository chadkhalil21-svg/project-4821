'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=(p)=>fs.readFileSync(path.join(__dirname,p),'utf8');
const payments=src('payments.js'),booking=src('booking.js'),
 server=src('server.js'),scheduled=src('scheduler.js'),money=src('travelmoney.js');
for(let pass=0;pass<2;pass++){
 assert.match(booking,/payoutLedgerVersion: 1/,'new booking must be payout-ledger versioned');
 const transferStart=payments.indexOf('async function transferToOperator(');
 const transferEnd=payments.indexOf('async function transferFixed(',transferStart);
 assert(transferStart>=0&&transferEnd>transferStart,'Stripe transfer function must exist');
 const transfer=payments.slice(transferStart,transferEnd);
 assert.match(transfer,/return transferOnce\(/,'all Operator share transfers must use durable guard');
 assert.match(transfer,/stripe\.transfers\.list\(\{ transfer_group: group, limit: 2 \}\)/);
 assert.match(transfer,/stripe\.transfers\.create\(/);
 assert.match(transfer,/transfer_group: group/);
 assert.match(scheduled,/const out = await transferToOperator\(/);
 assert.match(money,/await deps\.transferToOperator\(/);
 const recover=server.match(/app\.post\('\/operator\/settle-pending'[\s\S]*?\n\}\);/)?.[0];
 assert(recover,'Operator recovery route present');
 assert.match(recover,/censusOperatorPage\(/);
 assert.match(recover,/pageSize: 100/);
 assert.doesNotMatch(recover,/transferToOperator\(/,'app-open recovery must not transfer money');
 assert.doesNotMatch(recover,/collection\('rides'\)\.where\('operatorId', '==', uid\)\.get\(\)/,
  'unbounded history query prohibited');
 assert.match(recover,/payout_reconciliation_required/);
}
console.log('PASS twice: all Operator fare transfers use guarded method and app-open is bounded/read-only');
