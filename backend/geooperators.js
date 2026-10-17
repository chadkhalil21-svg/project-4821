// Bounded geographic Operator retrieval for dispatch.
//
// Firestore has no native radius query. Operators store a geohash; dispatch queries bounded
// neighboring geohash cells and matching.js remains the exact distance/eligibility authority.
// Cell centers are derived from the geohash's actual decoded bounds, not fixed degree offsets,
// so the neighborhood construction remains valid across latitudes and the antimeridian.
const BASE32='0123456789bcdefghjkmnpqrstuvwxyz';
const PER_PREFIX_LIMIT=40;
const SATURATION_LIMIT=120;
const TIERS=Object.freeze([{precision:5},{precision:4}]);

function encodeGeohash(lat,lng,precision=7){
  lat=Number(lat);lng=Number(lng);
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return null;
  let latR=[-90,90],lngR=[-180,180],even=true,bit=0,ch=0,out='';
  while(out.length<precision){
    const r=even?lngR:latR, v=even?lng:lat, mid=(r[0]+r[1])/2;
    if(v>=mid){ch|=1<<(4-bit);r[0]=mid;}else r[1]=mid;
    even=!even;
    if(bit<4)bit++;else{out+=BASE32[ch];bit=0;ch=0;}
  }
  return out;
}
function decodeBounds(hash){
  let lat=[-90,90],lng=[-180,180],even=true;
  for(const ch of String(hash||'')){
    const n=BASE32.indexOf(ch); if(n<0)return null;
    for(let mask=16;mask;mask>>=1){
      const r=even?lng:lat,mid=(r[0]+r[1])/2;
      if(n&mask)r[0]=mid;else r[1]=mid;
      even=!even;
    }
  }
  return {lat,lng};
}
function wrapLng(lng){while(lng>180)lng-=360;while(lng<-180)lng+=360;return lng;}
function prefixes(point,tier){
  const center=encodeGeohash(point?.lat,point?.lng,tier.precision); if(!center)return [];
  const b=decodeBounds(center); if(!b)return [];
  const latSpan=b.lat[1]-b.lat[0],lngSpan=b.lng[1]-b.lng[0],set=new Set();
  for(const dy of [-1,0,1])for(const dx of [-1,0,1]){
    const lat=Math.max(-89.999999,Math.min(89.999999,Number(point.lat)+dy*latSpan));
    set.add(encodeGeohash(lat,wrapLng(Number(point.lng)+dx*lngSpan),tier.precision));
  }
  return [...set].filter(Boolean);
}
async function queryTier(db,point,tier,{excludeIds=new Set(),limitPerPrefix=PER_PREFIX_LIMIT,saturationLimit=SATURATION_LIMIT}={}){
  const out=new Map();
  await Promise.all(prefixes(point,tier).map(async prefix=>{
    const base=db.collection('operators').where('available','==',true)
      .orderBy('geohash').startAt(prefix).endAt(prefix+'\uf8ff');
    const first=await base.limit(limitPerPrefix).get();
    // A saturated cell must retain the first page and fetch only the NEXT records.
    // Re-running a larger overlapping query billed the first 40 documents twice.
    // Snapshot cursors preserve ties when many Operators share the same geohash.
    const docs=[...first.docs];
    if(first.docs.length===limitPerPrefix && saturationLimit>limitPerPrefix){
      const last=first.docs[first.docs.length-1];
      const next=await base.startAfter(last).limit(saturationLimit-limitPerPrefix).get();
      docs.push(...next.docs);
    }
    for(const d of docs){
      if(excludeIds.has(String(d.id)))continue;
      const x={id:d.id,...d.data()};
      if(Number.isFinite(Number(x.lat))&&Number.isFinite(Number(x.lng)))out.set(String(d.id),x);
    }
  }));
  return [...out.values()];
}
// Return the union of bounded tiers. Do not stop merely because an inner tier contains records:
// those records can all fail screening, insurance, presence, class or commissioning gates. The
// exact matcher chooses the nearest eligible Operator from the bounded union.
async function nearbyOperatorCandidates(db,point,opts={}){
  if(!encodeGeohash(point?.lat,point?.lng,1))return [];
  const all=new Map();
  for(const tier of TIERS)for(const row of await queryTier(db,point,tier,opts))all.set(String(row.id),row);
  return [...all.values()];
}
module.exports={encodeGeohash,decodeBounds,nearbyOperatorCandidates,prefixes,TIERS,PER_PREFIX_LIMIT,SATURATION_LIMIT};
