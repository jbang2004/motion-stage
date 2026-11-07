import {randomUUID} from 'node:crypto';
import {readProject,modelSlots,readWorkspaceJSON,withWorkspaceLock,commitWorkspace,sha,projectView} from './core.mjs';
import {readJobIndex,activeJobStates} from './job-index.mjs';

const file=id=>{if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id||'')||['__proto__','prototype','constructor'].includes(id))throw Error('无效模型 ID');return 'undo/'+id+'.json';};
const empty=()=>({version:1,revision:0,undo:[],redo:[],guard:null});
async function read(work,id){try{return await readWorkspaceJSON(work,file(id));}catch(e){if(e.code==='ENOENT')return empty();throw e;}}
async function library(work){try{return await readWorkspaceJSON(work,'motion-library.json');}catch(e){if(e.code==='ENOENT')return {version:1,revision:0,packs:[],mappings:[],characters:{}};throw e;}}
// Guard only this model. Viewing another model or changing a shared pack does not
// invalidate undo. External head/review/action changes do; never overwrite them.
export async function undoGuard(work,id,changes={}){
 file(id);const cfg=changes['project.json']||await readProject(work),lib=changes['motion-library.json']||await library(work);
 const rows=(await readJobIndex(work)).rows.filter(j=>j.assetId===id),reviews=[];
 for(const row of rows){const changed=changes['jobs/'+row.id+'/job.json'],review=changed?changed.reviews?.at(-1):row.review;if(review)reviews.push([row.id,review.id||review.at]);}
 reviews.sort((a,b)=>a[0].localeCompare(b[0]));const heads=modelSlots(cfg,id);
 return sha(Buffer.from(JSON.stringify([cfg.models[id]?.headRevision,heads.baseline?.sha256,heads.candidate?.sha256,reviews,lib.characters[id]||[]])));
}
export async function appendUndo(work,changes,{assetId,beforeGuard,...entry}){
 const h=await read(work,assetId);if(h.guard!==beforeGuard)h.undo=[];
 h.undo.push({id:randomUUID(),...entry});h.undo=h.undo.slice(-50);h.redo=[];h.revision++;h.guard=await undoGuard(work,assetId,changes);changes[file(assetId)]=h;
}
// A completed candidate is a preview, not a new user decision. Advance the
// guarded head in the same transaction so accepted rounds remain undoable.
export async function advanceUndo(work,changes,assetId,beforeGuard){
 const h=await read(work,assetId);if(!h.revision)return;
 if(h.guard!==beforeGuard)h.undo=[];h.redo=[];h.revision++;h.guard=await undoGuard(work,assetId,changes);changes[file(assetId)]=h;
}
async function status(work,id){
 const h=await read(work,id),busy=(await readJobIndex(work)).rows.some(j=>j.assetId===id&&activeJobStates.has(j.state));
 const changed=h.guard&&h.guard!==await undoGuard(work,id);
 const reason=busy?'先停止或完成当前任务':changed?'版本已变化，请从当前版本继续':'';
 const item=e=>e?{id:e.id,label:e.label,kind:e.kind,jobId:e.jobId}:null;
 return {assetId:id,revision:h.revision,undo:item(h.undo.at(-1)),redo:item(h.redo.at(-1)),reason};
}
export const undoStatus=(work,id)=>withWorkspaceLock(work,()=>status(work,id));
export async function applyUndo(work,{assetId,direction='undo',expectedRevision,entryId}={}){return withWorkspaceLock(work,async()=>{
 if(!['undo','redo'].includes(direction))throw Error('无效撤销方向');const s=await status(work,assetId),h=await read(work,assetId),entry=h[direction].at(-1);
 if(s.reason)throw Error(s.reason);if(!entry||expectedRevision!==h.revision||entryId!==entry.id)throw Error('撤销记录已变化，请刷新后重试');
 const target=entry[direction==='undo'?'before':'after'],changes={};let job;
 const finish=async changes=>{h[direction].pop();h[direction==='undo'?'redo':'undo'].push(entry);h.revision++;h.guard=await undoGuard(work,assetId,changes);changes[file(assetId)]=h;};
 if(entry.kind==='review'){
  const {reviewJob}=await import('./jobs.mjs');job=await reviewJob(work,entry.jobId,{decision:target.decision,outcome:(direction==='undo'?'撤销':'重做')+entry.label},{restoreAsset:target.asset,finish,recovery:{direction,label:entry.label}});
 }else if(entry.kind==='actions'){
  const lib=await library(work);lib.characters[assetId]=structuredClone(target);lib.revision++;changes['motion-library.json']=lib;await finish(changes);await commitWorkspace(work,changes);
 }else throw Error('不支持的撤销记录');
 return {assetId,job,project:projectView(await readProject(work),assetId),history:await status(work,assetId),message:(direction==='undo'?'已撤销':'已重做')+entry.label};
});}
