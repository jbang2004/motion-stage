export function createUndoControls({api,getTarget,onApplied,onError,begin=()=>true,isCurrent=()=>true,documentRef=globalThis.document}){
 let state=null,busy=false,sequence=0;
 const buttons={undo:['undoAction','taskUndoAction'].map(id=>documentRef.getElementById(id)).filter(Boolean),redo:['redoAction','taskRedoAction'].map(id=>documentRef.getElementById(id)).filter(Boolean)};
 function draw(){const target=getTarget();for(const [direction,list]of Object.entries(buttons))for(const b of list){const entry=state?.assetId===target.assetId?state[direction]:null,label=(direction==='undo'?'撤销':'重做')+(entry?.label||'');if(!b.dataset.compact)b.textContent=label;b.title=state?.reason||label;b.setAttribute('aria-label',label);b.disabled=busy||target.blocked||!entry||Boolean(state.reason);}}
 async function refresh(){const ticket=++sequence,target=getTarget();if(!target.assetId){state=null;draw();return;}try{const value=await api('/api/undo','GET',undefined,{assetId:target.assetId});if(ticket===sequence&&target.assetId===getTarget().assetId){state=value;draw();}}catch{if(ticket===sequence){state=null;draw();}}return state;}
 async function run(direction='undo',expected=null){const target=getTarget(),entry=state?.[direction];if(busy||target.blocked||state?.reason||state?.assetId!==target.assetId||!entry)return;if(expected&&(expected.assetId!==target.assetId||expected.id!==entry.id))return;
  const ticket=begin();if(!ticket)return;busy=true;draw();try{const result=await api('/api/undo','POST',{assetId:target.assetId,direction,expectedRevision:state.revision,entryId:entry.id});if(getTarget().assetId===target.assetId&&isCurrent(ticket))await onApplied(result,ticket);}catch(e){onError(e);}finally{busy=false;await refresh();}
 }
 for(const [direction,list]of Object.entries(buttons))for(const b of list)b.onclick=()=>run(direction);
 return {refresh,draw,run,current:()=>state};
}
