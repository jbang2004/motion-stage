import {readFile} from 'node:fs/promises';
import {parseGlb,encodeGlb,animationAccessorReader} from './asset-tools.mjs';
import {clipChanges,editedClips} from './candidate-diff.mjs';
import {atomic,inside,sha,glbInfo,modelSlots,readWorkspaceJSON} from './core.mjs';

// WHEN THE GAME'S MODEL CHANGES UNDER A CHARACTER (a source refresh: the delivery CLI, the page's button, the watcher) the work
// done on the old version is sorted clip by clip, not thrown away whole and not left looking current:
//   - every task of the character made on an older source gets `sourceUpdate`: its clip in the new source is 'unchanged',
//     'changed', 'removed' or 'unverified' (never taken as the same). A queued or waiting task whose clip is not unchanged
//     is stale at once (its request was about a motion that is no longer there); one whose clip is unchanged is stale too
//     (its frozen inputs are the old file) but says it can be submitted again as it is.
//   - the candidate: each clip it changed against its own source is carried onto the new source when that clip is unchanged
//     there (spliceClips: the candidate's tracks for it, decoded, written into the new file); a clip changed or removed in the
//     new source is not carried (the old pair stays in the model's revisions). The task that made the candidate keeps the pair
//     it now belongs to (`sourceUpdate.rebased`), so the page can open it against the new source.
// Nothing here is a running task's: a source refresh refuses while one runs (jobs.mjs assertModelAvailable).

const activeStates=new Set(['queued','running','needs-input']);
const REASON={
 unchanged:'游戏源文件已更新，这个动作没有变化。',
 changed:'游戏源文件已更新，这个动作已被新版本替换。',
 removed:'游戏源文件已更新，这个动作已从角色中删除。',
 unverified:'游戏源文件已更新，无法确认这个动作是否变化。',
};
export function sourceUpdateReason(status){return REASON[status]||REASON.unverified;}

/** One version of a model with the named clips of another put in it: each clip's channels, by the target nodes' names, its
 *  keys decoded (compressed tracks too) and written plain. Throws if a clip or a target node is not in both. */
export function spliceClips(baseBytes,fromBytes,names){
 const base=parseGlb(baseBytes),from=parseGlb(fromBytes,{copy:false}),read=animationAccessorReader(from.doc,from.bin);
 const doc=base.doc,nodes=new Map(),twice=new Set();
 (doc.nodes||[]).forEach((n,i)=>{if(!n.name)return;if(nodes.has(n.name))twice.add(n.name);nodes.set(n.name,i);});
 const parts=[base.bin];let length=base.bin.length;
 const pad=()=>{const p=(4-length%4)%4;if(p){parts.push(Buffer.alloc(p));length+=p;}};
 const write=(rows,type)=>{
  pad();const width=rows[0]?.length||1,data=Buffer.alloc(rows.length*width*4);
  rows.forEach((row,i)=>row.forEach((v,j)=>data.writeFloatLE(v,(i*width+j)*4)));
  (doc.bufferViews??=[]).push({buffer:0,byteOffset:length,byteLength:data.length});parts.push(data);length+=data.length;
  const accessor={bufferView:doc.bufferViews.length-1,componentType:5126,count:rows.length,type};
  if(type==='SCALAR'){accessor.min=[Math.min(...rows.map(r=>r[0]))];accessor.max=[Math.max(...rows.map(r=>r[0]))];}
  (doc.accessors??=[]).push(accessor);return doc.accessors.length-1;
 };
 const types={1:'SCALAR',2:'VEC2',3:'VEC3',4:'VEC4'};
 for(const name of names){
  const src=(from.doc.animations||[]).find(a=>a.name===name),at=(doc.animations||[]).findIndex(a=>a.name===name);
  if(!src)throw Error('候选里没有动作：'+name);
  if(at<0)throw Error('新源文件里没有动作：'+name);
  const out={...src,samplers:[],channels:[]},inputs=new Map();
  for(const channel of src.channels||[]){
   const node=from.doc.nodes?.[channel.target?.node]?.name;
   if(!node||!nodes.has(node)||twice.has(node))throw Error('新源文件里找不到唯一的骨骼：'+(node||'?'));
   const sampler=src.samplers[channel.sampler];
   if(!inputs.has(sampler.input))inputs.set(sampler.input,write(read(sampler.input),'SCALAR'));
   const values=read(sampler.output);
   out.samplers.push({input:inputs.get(sampler.input),output:write(values,types[values[0]?.length||1]),interpolation:sampler.interpolation||'LINEAR'});
   out.channels.push({sampler:out.samplers.length-1,target:{...channel.target,node:nodes.get(node)}});
  }
  doc.animations[at]=out;
 }
 pad();const bin=Buffer.concat(parts);
 if(doc.buffers?.[0])doc.buffers[0].byteLength=bin.length;else doc.buffers=[{byteLength:bin.length}];
 return encodeGlb(doc,bin,base.extra);
}

async function bytesOf(work,asset){
 const b=await readFile(await inside(work,asset.file));if(sha(b)!==asset.sha256)throw Error('版本文件已损坏：'+asset.file);return b;
}

/**
 * Sorts the work of a character done on its old source (inside the workspace lock, before the new source is put in).
 * `cfg` the project (its heads still the old ones), `assetId`, `newBytes` the new source's preview bytes. Returns
 * { jobs: changed job records (to be written), carry: { bytes, clips, jobId } | null (the candidate on the new source),
 *   report: { tasks: [{ id, clip, status }], carried: [...], dropped: [{ clip, status }] } }.
 */
export async function sortSourceUpdate(work,cfg,assetId,newBytes,jobs){
 const heads=modelSlots(cfg,assetId),newSha=sha(newBytes),report={tasks:[],carried:[],dropped:[]};
 const cache=new Map(),bytes=async a=>{if(!cache.has(a.sha256))cache.set(a.sha256,await bytesOf(work,a));return cache.get(a.sha256);};
 const verdicts=new Map(),verdict=async(source,clips)=>{
  const key=source.sha256,want=clips.filter(c=>!verdicts.get(key)?.has(c));
  if(!verdicts.has(key))verdicts.set(key,new Map());
  if(want.length){let found;try{found=clipChanges(await bytes(source),newBytes,want);}catch{found=new Map(want.map(c=>[c,'unverified']));}for(const [c,s] of found)verdicts.get(key).set(c,s);}
  return verdicts.get(key);
 };
 const changed=[],at=new Date().toISOString();
 for(const j of jobs){
  if((j.assetId||'legacy')!==assetId||j.state==='running')continue;
  const source=j.inputs?.[j.slot]||j.inputs?.baseline;
  if(!source?.sha256||!j.clip||j.sourceUpdate?.source?.sha256===newSha)continue;
  if(source.sha256===newSha)continue;
  const status=(await verdict(source,[j.clip])).get(j.clip)||'unverified';
  j.sourceUpdate={status,clip:j.clip,at,reason:sourceUpdateReason(status),from:{sha256:source.sha256},source:{sha256:newSha}};
  if(activeStates.has(j.state)){
   j.state='stale';(j.events??=[]).push({state:'stale',message:status==='unchanged'?REASON.unchanged+'任务仍按旧版本冻结，可在新版本上重新提交。':sourceUpdateReason(status)+'这条修改不再适用。',at});
  }
  j.updatedAt=at;changed.push(j);report.tasks.push({id:j.id,clip:j.clip,status});
 }
 // the candidate: what it changed against its own source, carried where that clip is unchanged in the new source
 let carry=null;
 const cand=heads.candidate,base=heads.baseline;
 if(cand&&base&&cand.sha256!==base.sha256){
  const from=cand.derivedFrom||base;let edits;
  try{edits=editedClips(await bytes(from),await bytes(cand));}catch{edits={clips:[],complete:false};}
  const names=edits.clips.filter(c=>c.status==='changed').map(c=>c.name);
  const unsure=!edits.complete||edits.clips.some(c=>c.status!=='changed');
  const states=names.length?await verdict(from,names):new Map();
  const keep=unsure?[]:names.filter(n=>states.get(n)==='unchanged');
  for(const n of names)if(!keep.includes(n))report.dropped.push({clip:n,status:unsure?'unverified':states.get(n)});
  if(keep.length){
   try{carry={bytes:spliceClips(newBytes,await bytes(cand),keep),clips:keep,jobId:cand.derivedByJobId||null};glbInfo(carry.bytes);report.carried=keep;}
   catch(error){carry=null;for(const n of keep)report.dropped.push({clip:n,status:'unverified',error:error.message});}
  }
 }
 return {jobs:changed,carry,report};
}

/** Writes what sortSourceUpdate found, after the new baseline is in: the jobs, and the carried candidate as the model's
 *  candidate (its owner's `sourceUpdate.rebased` naming the new pair). `stage` is core.mjs stageAsset. */
export async function applySourceUpdate(work,cfg,assetId,sorted,stage){
 const heads=modelSlots(cfg,assetId);let project=cfg;
 if(sorted.carry){
  const staged=await stage(work,'candidate',sorted.carry.bytes,'沿用候选 · '+sorted.carry.clips.join('、'),{project:cfg,assetId,activate:cfg.activeAssetId===assetId,
   ...(sorted.carry.jobId?{derivedByJobId:sorted.carry.jobId}:{})});
  project=staged.project;const head=modelSlots(project,assetId).candidate;
  head.derivedFrom={file:heads.baseline.file,sha256:heads.baseline.sha256};head.carried={clips:sorted.carry.clips,at:new Date().toISOString()};
  const owner=sorted.jobs.find(j=>j.id===sorted.carry.jobId);
  if(owner)owner.sourceUpdate.rebased={baseline:{file:heads.baseline.file,sha256:heads.baseline.sha256},candidate:{file:head.file,sha256:head.sha256}};
 }
 for(const j of sorted.jobs)await atomic(await inside(work,'jobs/'+j.id+'/job.json'),j);
 return project;
}

/** The jobs of the workspace as stored (for sorting under the lock). */
export async function storedJobs(work,ids){
 const out=[];for(const id of ids){try{out.push(await readWorkspaceJSON(work,'jobs/'+id+'/job.json'));}catch(e){if(e.code!=='ENOENT')throw e;}}return out;
}
