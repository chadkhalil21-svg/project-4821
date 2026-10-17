'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const policyPath=path.resolve(__dirname,'../src/tripPositionPolicy.ts');
const telemetry=fs.readFileSync(path.resolve(__dirname,'../src/backend/telemetry.ts'),'utf8');
assert.match(telemetry,/shouldPublishTripPosition\(/);
assert.match(telemetry,/SAMPLE_EVERY_MS = 15_000/);
assert.match(telemetry,/updateDoc\(doc\(db, 'rides', rideId\)/);
const probe=`
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
(async()=>{
 const p=await import(pathToFileURL(process.argv[1]).href);
 assert.equal(p.MOVING_REPORT_MS,30000);
 assert.equal(p.STATIONARY_REPORT_MS,60000);
 assert.equal(p.MOVEMENT_RADIUS_MI,0.03);
 const should=p.shouldPublishTripPosition;
 assert.equal(should({elapsedMs:0,moved:false,hasPublished:false}),true);
 assert.equal(should({elapsedMs:15000,moved:true,hasPublished:true}),false);
 assert.equal(should({elapsedMs:30000,moved:true,hasPublished:true}),true);
 assert.equal(should({elapsedMs:30000,moved:false,hasPublished:true}),false);
 assert.equal(should({elapsedMs:60000,moved:false,hasPublished:true}),true);
 assert.equal(should({elapsedMs:Infinity,moved:false,hasPublished:true}),false);
 function count(hours, moving){
  let writes=0,last=-1;
  for(let ms=0;ms<hours*3600000;ms+=15000){
   if(should({elapsedMs:ms-last,moved:moving,hasPublished:last>=0})){writes++;last=ms;}
  }
  return writes;
 }
 assert.equal(count(1,true),120,'moving 60min: 120 writes vs old 240');
 assert.equal(count(1,false),60,'stationary 60min: 60 freshness writes');
 console.log('PASS automatic GPS publication: 30s moving / 60s stopped / no manual action');
})().catch(e=>{console.error(e);process.exitCode=1});
`;
const result=spawnSync(process.execPath,['--experimental-strip-types','-e',probe,policyPath],{encoding:'utf8'});
assert.equal(result.status,0,result.stderr||result.stdout);
console.log(result.stdout.trim());
