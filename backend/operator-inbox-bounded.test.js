'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../src/backend/operatorInbox.ts'),'utf8');
const indices=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../firestore.indexes.json'),'utf8'));
assert.match(src,/where\('operatorId', '==', uid\)/);
assert.match(src,/where\('status', 'in', \['assigned', 'accepted', 'arrived', 'onboard'\]\)/);
assert.match(src,/limit\(MAX_ACTIVE_INBOX \+ 1\)/);
assert.match(src,/snap\.docs\.length > MAX_ACTIVE_INBOX/);
assert.match(src,/onError\?\.\(t\('traveler\.errReadTravel'\)\)/);
assert(indices.indexes.some(i=>i.collectionGroup==='rides' &&
 i.fields?.some(f=>f.fieldPath==='operatorId') &&
 i.fields?.some(f=>f.fieldPath==='status')),
 'Composite Firestore Operator status index must be declared; commissioning separately required');
console.log('PASS bounded active Operator inbox with overflow visibility and declared index');
