import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRequestFailure} from './browser-smoke.network.mjs';
const baseURL='http://127.0.0.1:12345',glb=baseURL+'/workspace/assets/'+'a'.repeat(64)+'.glb';
const a={epoch:1,assetId:'A',referrerAssetId:'A'},b={epoch:2,assetId:'B'},newA={epoch:3,assetId:'A'};
const classify=extra=>classifyRequestFailure({url:glb,method:'GET',errorText:'net::ERR_ABORTED',owner:a,failureSelection:b,baseURL,...extra});
test('only a GLB owned by an epoch already retired when failure occurred is allowed',()=>{
 assert.equal(classify(), 'obsolete-selection-glb-aborted');
 assert.equal(classify({failureSelection:a}),null);
 assert.equal(classify({failureSelection:a,closing:true}),null);
 assert.equal(classify({failureSelection:newA}),'obsolete-selection-glb-aborted');
});
test('unknown ownership, mismatched referrer, transport errors and non-resource paths stay failures',()=>{
 for(const extra of [{owner:null},{owner:{...a,referrerAssetId:'B'}},{errorText:'net::ERR_CONNECTION_RESET'},{errorText:'some unrelated cancellation'},{method:'POST'},{url:baseURL+'/not-a-glb'},{url:'https://outside.invalid/workspace/assets/'+'a'.repeat(64)+'.glb'}])assert.equal(classify(extra),null,JSON.stringify(extra));
});
test('session/studio aborts require matching asset identity and a retired epoch or explicit cleanup',()=>{
 for(const endpoint of ['session','studio']){
  const url=baseURL+'/api/'+endpoint+'?assetId=A';
  assert.equal(classify({url}),'obsolete-selection-api-aborted');
  assert.equal(classify({url,failureSelection:a}),null);
  assert.equal(classify({url,failureSelection:a,closing:true}),'browser-cleanup-api-aborted');
  assert.equal(classify({url:baseURL+'/api/'+endpoint+'?assetId=B'}),null);
 }
});
