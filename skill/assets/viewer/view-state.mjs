// UI requests and draft storage share one identity boundary. Selecting another
// model invalidates old responses immediately, before any I/O completes.
export function createViewState(assetId=null){
 let generation=0,loadGeneration=0,mutationGeneration=0,selectedAssetId=assetId||null,loadedAssetId=null;
 let controller=new AbortController();
 const capture=()=>Object.freeze({generation,loadGeneration,mutationGeneration,assetId:selectedAssetId,signal:controller.signal});
 const isCurrent=(ticket,responseAssetId=selectedAssetId)=>Boolean(ticket&&ticket.generation===generation&&(selectedAssetId===null||responseAssetId===selectedAssetId)&&(ticket.assetId===null||ticket.assetId===selectedAssetId));
 const isCurrentMutation=(ticket,responseAssetId=selectedAssetId)=>isCurrent(ticket,responseAssetId)&&ticket.mutationGeneration===mutationGeneration;
 const isUnchanged=(ticket,responseAssetId=selectedAssetId)=>isCurrentMutation(ticket,responseAssetId)&&ticket.loadGeneration===loadGeneration;
 return {
  capture,isCurrent,isCurrentMutation,isUnchanged,
  select(id){controller.abort();controller=new AbortController();generation++;loadGeneration++;mutationGeneration++;selectedAssetId=id||null;loadedAssetId=null;return capture();},
  // Foreground writes invalidate snapshots fetched before the operation, even
  // when the selected model and loaded geometry have not changed.
  beginMutation(ticket=capture()){
   if(!isUnchanged(ticket))return null;
   mutationGeneration++;return capture();
  },
  beginLoad(ticket=capture()){
   if(!isCurrentMutation(ticket))return null;
   loadGeneration++;return capture();
  },
  markLoaded(ticket,id){
   if(!id||!isUnchanged(ticket,id))return false;
   selectedAssetId=id;loadedAssetId=id;return true;
  },
  get loadedAssetId(){return loadedAssetId;},
  persistableAssetId(state){
   if(!state.ready||state.loading||state.switching||state.capturing||!state.paths?.workspace||!loadedAssetId||loadedAssetId!==selectedAssetId||state.project?.activeAssetId!==loadedAssetId)return null;
   // Old records can omit assetId on slot metadata. Once a slot supplies it,
   // its identity must agree even when another model has identical bytes.
   if(Object.values(state.models||{}).some(model=>model?.meta?.assetId&&model.meta.assetId!==loadedAssetId))return null;
   return loadedAssetId;
  }
 };
}

export function draftStorageKey(workspace,assetId){return 'motion-atelier:'+workspace+':'+assetId;}

// Browser storage is optional. Keep a snapshot per view/workspace/model before
// attempting persistence so failed transitions can restore the latest session
// draft even when storage is full, disabled, or still contains an older draft.
const sessionDrafts=new WeakMap();
const draftStorage=storage=>typeof storage==='function'?storage():storage;

export function saveViewDraft(storage,view,state,getDraft){
 const assetId=view.persistableAssetId(state);if(!assetId)return false;
 try{
  const draft=getDraft();if(draft?.context?.assetId!==assetId)return false;
  const key=draftStorageKey(state.paths.workspace,assetId),raw=JSON.stringify({...draft,assetId,version:1});
  let memory=sessionDrafts.get(view);if(!memory){memory=new Map();sessionDrafts.set(view,memory);}memory.set(key,raw);
  draftStorage(storage).setItem(key,raw);return true;
 }catch{return false;}
}

export function readViewDraft(storage,{workspace,assetId,view}){
 if(!workspace||!assetId)return null;
 try{
  const key=draftStorageKey(workspace,assetId),memory=sessionDrafts.get(view)?.get(key);
  const persistent=memory===undefined?draftStorage(storage):null;
  const raw=memory??(persistent.getItem(key)||(assetId==='legacy'?persistent.getItem('motion-atelier:'+workspace):null));
  const draft=JSON.parse(raw||'null');if(!draft||typeof draft!=='object'||Array.isArray(draft))return null;
  if(draft.assetId&&draft.assetId!==assetId||draft.context?.assetId&&draft.context.assetId!==assetId)return null;
  return draft;
 }catch{return null;}
}

