const assert=require('node:assert/strict');const fs=require('node:fs');
const G=require('./geooperators');
assert.equal(G.encodeGeohash(25.7617,-80.1918,7).length,7);
for(const t of G.TIERS)assert.ok(G.prefixes({lat:25.7617,lng:-80.1918},t).length<=9);
for(const p of [{lat:25.7617,lng:-80.1918},{lat:61.2181,lng:-149.9003},{lat:64.1466,lng:-21.9426},{lat:0.1,lng:179.99}]){
  for(const t of G.TIERS){const ps=G.prefixes(p,t);assert.ok(ps.length>=4&&ps.length<=9);assert.ok(ps.every(x=>x.length===t.precision));}
}
const b=G.decodeBounds(G.encodeGeohash(61.2181,-149.9003,5));assert.ok(b&&b.lat[0]<=61.2181&&b.lat[1]>=61.2181&&b.lng[0]<=-149.9003&&b.lng[1]>=-149.9003);
assert.equal(G.PER_PREFIX_LIMIT,40);assert.equal(G.SATURATION_LIMIT,120);
const server=fs.readFileSync(__dirname+'/server.js','utf8'),sched=fs.readFileSync(__dirname+'/scheduler.js','utf8'),mon=fs.readFileSync(__dirname+'/monitor.js','utf8');
assert.ok(server.includes('geohash: encodeGeohash(lat, lng)'));
assert.ok(server.includes('nearbyOperatorCandidates(db, pickup'));
assert.ok(!server.includes("collection('operators').where('available', '==', true).get()"));
assert.ok(!sched.includes("collection('operators').get()"));
assert.ok(!mon.includes("collection('operators').get()"));

(async()=>{
  const calls=[];
  const docsByPrecision={5:[{id:'inner-ineligible',data:()=>({lat:25.76,lng:-80.19,available:true})}],4:[{id:'outer-eligible',data:()=>({lat:25.80,lng:-80.22,available:true})}]};
  const db={collection:()=>({where:()=>({orderBy:()=>({startAt:(prefix)=>({endAt:()=>({limit:()=>({get:async()=>{calls.push(prefix);return {docs:docsByPrecision[prefix.length]||[]};}})})})})})})};
  const rows=await G.nearbyOperatorCandidates(db,{lat:25.7617,lng:-80.1918});
  assert.ok(rows.some(x=>x.id==='inner-ineligible')&&rows.some(x=>x.id==='outer-eligible'),'candidate retrieval widens even when the inner tier is non-empty');
  assert.ok(calls.some(x=>x.length===5)&&calls.some(x=>x.length===4),'both bounded tiers are queried');
  const limits=[], offsets=[];
  // A saturated geohash cell contains 120 distinct Operators; the second page
  // must begin AFTER the first 40 even if every document shares the same geohash.
  const all=Array.from({length:120},(_,i)=>({id:'s'+i,data:()=>({lat:25.76,lng:-80.19,available:true})}));
  const db2={collection:()=>({where:()=>({orderBy:()=>({startAt:()=>({endAt:()=>({
    limit(n){limits.push(n);return {get:async()=>({docs:all.slice(0,n)})};},
    startAfter(doc){offsets.push(doc.id);return {limit(n){limits.push(n);return {get:async()=>({docs:all.slice(all.findIndex(x=>x.id===doc.id)+1,all.findIndex(x=>x.id===doc.id)+1+n)})};}};},
  })})})})})};
  const saturated=await G.nearbyOperatorCandidates(db2,{lat:25.7617,lng:-80.1918});
  assert.ok(limits.includes(40)&&limits.includes(80),'saturated cell fetches 40 + 80 nonoverlapping records');
  assert.ok(!limits.includes(120),'overlapping second page would double-charge first 40');
  assert.ok(offsets.length>0&&offsets.every(id=>id==='s39'),'second page starts after first page');
  assert.equal(saturated.length,120,'preserves all 120 distinct candidate identities');
  console.log('all bounded-geographic dispatch tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
