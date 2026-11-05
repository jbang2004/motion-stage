// Pure evidence classifier; it never infers retirement from a failure URL alone
// or from a model selection which happens after the failure event.
export function classifyRequestFailure({url,method,errorText,owner,failureSelection,baseURL,closing=false}){
 if(!['net::ERR_ABORTED','net::ERR_CANCELED'].includes(errorText)||method!=='GET')return null;
 let parsed;try{parsed=new URL(url);}catch{return null;}
 if(parsed.origin!==baseURL||!owner||!Number.isSafeInteger(owner.epoch)||owner.epoch<1||!owner.assetId||!failureSelection)return null;
 const session=['/api/session','/api/studio'].includes(parsed.pathname),glb=/^\/workspace\/assets\/[a-f0-9]{64}\.glb$/.test(parsed.pathname);
 if(!session&&!glb)return null;
 if(session&&parsed.searchParams.get('assetId')!==owner.assetId||glb&&owner.referrerAssetId!==owner.assetId)return null;
 const obsolete=Number.isSafeInteger(failureSelection.epoch)&&owner.epoch<failureSelection.epoch;
 if(obsolete)return glb?'obsolete-selection-glb-aborted':'obsolete-selection-api-aborted';
 // An explicit browser close can cancel the current poll, but it does not make
 // a current GLB a successfully loaded or subsequently selected-away resource.
 return session&&closing&&owner.epoch===failureSelection.epoch?'browser-cleanup-api-aborted':null;
}
