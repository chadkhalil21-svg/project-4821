'use strict';
const assert=require('node:assert/strict');
const {transferOnce,groupFor}=require('./payout-transfer-guard');

const RIDE='a'.repeat(40), PI='pi_safe_1', ACCOUNT='acct_1', CHARGE='ch_1', UID='traveler_1';
function setup({legacy=false}={}){
 const state=new Map();
 state.set('rides/'+RIDE,{status:'completed',payoutLedgerVersion:legacy?undefined:1,
   operatorId:'op_1',travelerUid:UID,paymentIntentId:PI});
 let chain=Promise.resolve(),failCommit=false;
 const db={
  collection(col){return {doc(id){const key=col+'/'+id;return {key};}};},
  runTransaction(fn){
   const run=async()=>{
    const writes=[];
    const tx={
     async get(ref){const v=state.get(ref.key);return {exists:!!v,data:()=>v?{...v}:null};},
     create(ref,v){writes.push(['create',ref.key,v]);},
     set(ref,v,opt){writes.push(['set',ref.key,v,opt]);},
    };
    const result=await fn(tx);
    if(failCommit && writes.some(x=>x[1]==='rides/'+RIDE)){
      failCommit=false;throw Error('Firestore write lost after provider succeeded');
    }
    for(const [op,key,value,opts] of writes){
      if(op==='create'&&state.has(key))throw Error('duplicate claim');
      state.set(key,opts?.merge?{...state.get(key),...value}:{...value});
    }
    return result;
   };
   const p=chain.then(run,run);chain=p.catch(()=>{});return p;
  },
  failNextFinalize(){failCommit=true;},
  state,
 };
 let transfers=[],created=0,reads=0,timeoutAfterCreate=false,timeoutBeforeCreate=false;
 function transfer(group){
  return {id:'tr_'+(created+1),currency:'usd',amount:1740,destination:ACCOUNT,
    transfer_group:group,source_transaction:CHARGE,reversed:false,amount_reversed:0,
    metadata:{rideId:RIDE,paymentIntentId:PI}};
 }
 const args={
  db,rideId:RIDE,paymentIntentId:PI,operatorStripeAccount:ACCOUNT,
  chargeId:CHARGE,expectedUid:UID,amountCents:1740,platformTake:250,
  async findTransfers(group){reads++;return {data:transfers.filter(t=>t.transfer_group===group),has_more:false};},
  async createTransfer(group){
   if(timeoutBeforeCreate){timeoutBeforeCreate=false;throw Error('network failed before execution');}
   const v=transfer(group);created++;transfers.push(v);
   if(timeoutAfterCreate){timeoutAfterCreate=false;throw Error('network failed after execution');}
   return v;
  },
 };
 return {db,args,get created(){return created;},get reads(){return reads;},
  get transfers(){return transfers;},transfer,timeoutAfter(){timeoutAfterCreate=true;},
  timeoutBefore(){timeoutBeforeCreate=true;},failCommit:()=>db.failNextFinalize()};
}
async function once(label,fn){await fn();console.log('PASS '+label);}
async function all(){
 await once('new complete Travel pays exactly once',async()=>{
   const x=setup();const a=await transferOnce(x.args),b=await transferOnce(x.args);
   assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(x.created,1);
   assert.equal(x.db.state.get('payout_ledger/'+RIDE).transferId,'tr_1');
   assert.equal(x.db.state.get('rides/'+RIDE).transferId,'tr_1');
 });
 await once('old history without ledger marker cannot pay automatically',async()=>{
   const x=setup({legacy:true}),out=await transferOnce(x.args);
   assert.equal(out.code,'legacy_or_invalid_payout');assert.equal(x.created,0);
 });
 await once('timeout after Stripe success requires reconciliation, no repeat transfer',async()=>{
   const x=setup();x.timeoutAfter();
   const a=await transferOnce(x.args),b=await transferOnce(x.args);
   assert.equal(a.unconfirmed,true);assert.equal(b.ok,true);assert.equal(b.reconciled,true);
   assert.equal(x.created,1);
 });
 await once('timeout before Stripe creation cannot cause an unverified retry',async()=>{
   const x=setup();x.timeoutBefore();
   const a=await transferOnce(x.args),b=await transferOnce(x.args);
   assert.equal(a.unconfirmed,true);assert.equal(b.code,'payout_attempt_unconfirmed');
   assert.equal(x.created,0);
 });
 await once('Firestore commit loss after Stripe success recovers via provider',async()=>{
   const x=setup();x.failCommit();
   const a=await transferOnce(x.args);assert.equal(a.code,'payout_record_unconfirmed');
   assert.equal(x.db.state.get('rides/'+RIDE).transferId,undefined);
   const b=await transferOnce(x.args);assert.equal(b.ok,true);assert.equal(b.reconciled,true);
   assert.equal(x.created,1);
 });
 await once('concurrent settlement requests never create two transfers',async()=>{
   const x=setup();const [a,b]=await Promise.all([transferOnce(x.args),transferOnce(x.args)]);
   assert.equal(x.created,1);assert.ok(a.ok||b.ok);
   const later=await transferOnce(x.args);assert.equal(later.ok,true);
 });
 await once('stale unfinished claim older than 24h never retries',async()=>{
   const x=setup();x.timeoutBefore();await transferOnce(x.args);
   x.args.now+=48*60*60_000;const out=await transferOnce(x.args);
   assert.equal(out.code,'payout_attempt_unconfirmed');assert.equal(x.created,0);
 });
 await once('changed Stripe payout account does not redirect historical transfer',async()=>{
   const x=setup();x.timeoutBefore();await transferOnce(x.args);
   const r=await transferOnce({...x.args,operatorStripeAccount:'acct_attacker'});
   assert.equal(r.code,'payout_identity_conflict');assert.equal(x.created,0);
 });
 await once('wrong provider transfer identity fails closed',async()=>{
   const x=setup();x.transfers.push({...x.transfer(groupFor(RIDE)),id:'tr_unmatched',amount:17});
   const r=await transferOnce(x.args);
   assert.equal(r.code,'payout_provider_mismatch');assert.equal(x.created,0);
 });
 await once('provider pages not exhaustive cannot authorize transfer',async()=>{
   const x=setup();x.args.findTransfers=async()=>({has_more:true,data:[]});
   const r=await transferOnce(x.args);assert.equal(r.code,'payout_provider_ambiguous');
   assert.equal(x.created,0);
 });
 await once('invalid record cannot authorize transfer',async()=>{
   const x=setup();x.db.state.get('rides/'+RIDE).status='cancelled';
   const r=await transferOnce(x.args);assert.equal(r.code,'legacy_or_invalid_payout');
   assert.equal(x.created,0);
 });
 await once('database unavailable before ledger creation makes no transfer',async()=>{
   const x=setup();x.db.runTransaction=async()=>{throw Error('quota exceeded');};
   const r=await transferOnce(x.args);assert.equal(r.code,'payout_ledger_unavailable');assert.equal(x.created,0);
 });
}
(async()=>{await all();await all();console.log('PASS twice: durable guarded payout and crash-safe Stripe reconciliation')})().catch(e=>{console.error(e);process.exitCode=1;});
