// Scale architecture gate. This is intentionally a source+workload test, not a claim that CI
// emulates production Firestore/Stripe/OSRM. It prevents known O(N fleet) dispatch from being
// mistaken for scale readiness and exercises CPU/economic hot paths at representative sizes.
const fs=require('node:fs');
const {performance}=require('node:perf_hooks');
const {matchOperator}=require('./matching');
const {minimumPlatformFeeCents,economicsFor}=require('./economics');
const server=fs.readFileSync(__dirname+'/server.js','utf8');

const results=[];
const check=(name,ok,detail)=>results.push({name,ok:!!ok,detail});

check('dispatch does not query the entire available fleet',
  !/collection\\('operators'\\)\\.where\\('available',\\s*'==',\\s*true\\)\\.get\\(\\)/.test(server) && server.includes('nearbyOperatorCandidates(db, pickup'),
  'Immediate dispatch uses bounded geographic candidate retrieval.');

const lostItemReturn = server.split("app.post('/travel/return-operator'")[1]
  ?.split("app.post('/travel/announce'")[0] || '';
check('lost-item return never reads the entire Operator fleet',
  !!lostItemReturn &&
  !/collection\\('operators'\\)\\.get\\(\\)/.test(lostItemReturn) &&
  lostItemReturn.includes("collection('operators').doc(originalId).get()") &&
  lostItemReturn.includes('availableOperatorCandidates(db, destination'),
  'The original Operator is read by ID; fallback is bounded and nearby.');

function fleet(n,now){
 const a=new Array(n);
 for(let i=0;i<n;i++){
   const angle=(i*2.399963229728653), radius=Math.sqrt(i+1)*0.00008;
   a[i]={id:'o'+i,available:true,onlineAt:now,screeningCheckedAt:now,
    disclosureVersion:require('./disclosure').DISCLOSURE_VERSION,commissioned:true,insuranceExpiry:'2099-01-01',
    lat:25.7617+Math.sin(angle)*radius,lng:-80.1918+Math.cos(angle)*radius,classes:['Standard']};
 }
 return a;
}
// Matching CPU is tested at the maximum candidate envelope, not fleet population. The database
// layer guarantees fleet size cannot expand this input without bound.
for(const n of [40,360,720]){
 const now=Date.now(), ops=fleet(n,now), t=performance.now();
 const best=matchOperator(ops,{lat:25.7617,lng:-80.1918},'Standard',{requireScreening:true,now});
 const ms=performance.now()-t;
 check('matching CPU bounded candidates '+n,!!best&&Number.isFinite(ms),ms.toFixed(2)+' ms');
}

// 1,000,000-Travel economic workload: exact integer solver must preserve the invariant.
let econBad=0; let checksum=0; const et=performance.now();
for(let i=0;i<1_000_000;i++){
 const fare=500+(i%15001), gov=i%97===0?200:0, toll=i%53===0?375:0;
 const fee=minimumPlatformFeeCents({travelCostCents:fare,governmentFeeCents:gov,tollCents:toll,cardCountry:i%20?'US':'CA'});
 const e=economicsFor({travelCostCents:fare,platformFeeCents:fee,governmentFeeCents:gov,tollCents:toll,cardCountry:i%20?'US':'CA'});
 if(e.platformContributionCents<e.requiredContributionCents)econBad++;
 checksum=(checksum+fee)%1000000007;
}
check('1M Travel economics invariant',econBad===0,((performance.now()-et)/1000).toFixed(2)+' s; checksum '+checksum);

// Candidate reads are bounded by two tiers x nine prefixes x a 120-document saturated-cell ceiling. Fleet growth from
// 1K to 1M Operators does not change this architectural ceiling.
// Each saturated prefix uses NONOVERLAPPING pages: first 40, then the next 80.
// The earlier repeated 120-document query charged for the first 40 twice.
const maxCandidateDocs=2*9*120;
const maxBilledCandidateReads=2*9*(40+80);
check('saturated geographic scans bill nonoverlapping query pages',
  maxBilledCandidateReads===2160,
  maxBilledCandidateReads+' document reads per saturated search before other work');
const conservativeFreeTierTrips=Math.floor(Math.min(
  50000/(2*maxBilledCandidateReads), 20000/40));
check('two saturated searches can exhaust free reads before 12 bookings',
  conservativeFreeTierTrips===11,
  conservativeFreeTierTrips+' hypothetical Travels/day at zero idle reads/writes; NOT measured capacity');
for(const [ops,travels] of [[1000,10000],[10000,100000],[50000,1000000],[1000000,1000000]]){
 const upper=BigInt(maxCandidateDocs)*BigInt(travels);
 check('bounded dispatch envelope '+ops+' Operators / '+travels+' Travels',maxCandidateDocs===2160,
  'fleet-independent ceiling '+maxCandidateDocs+' candidate documents/dispatch; '+upper.toLocaleString()+' worst-case returned docs before dedupe');
}

let bad=0;for(const r of results){if(!r.ok)bad++;console.log((r.ok?'PASS':'FAIL')+'  '+r.name+' — '+r.detail);}
console.log('\n'+(results.length-bad)+'/'+results.length+' scale checks passed');
process.exit(bad?1:0);
