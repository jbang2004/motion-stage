// Game-integration hand-off. Accepting a candidate or adopting an action never
// writes game files; an agent does that only when the user asks, then records
// what it changed here. integrations/<id>.json is append-only evidence.
import {createReadStream} from 'node:fs';
import {readdir,stat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {relative,sep,isAbsolute} from 'node:path';
import {inside,readProject,modelSlots,withWorkspaceLock,readWorkspaceJSON,commitWorkspace} from './core.mjs';
import {getProjectLink} from './project-context.mjs';
import {readJobIndex} from './job-index.mjs';
import {jobAncestors} from './job-lineage.mjs';
import {readTaskContext} from './task-context.mjs';
import {readMotionLibrary,findAdoptedAction,exportAdoptedAction} from './motion-library.mjs';

const UUID=/^[a-f0-9-]{36}$/,MAX_FILES=100,BUSY='这个模型还有未完成的修改任务；现在改游戏文件会让那条任务过期，先问用户。';
const text=(value,label,max=4000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'不能为空，且不能超过 '+max+' 字符');return value.trim();};
async function fileSha(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
async function readRecords(work){
 let names=[];try{names=(await readdir(await inside(work,'integrations'))).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n));}catch(e){if(e.code!=='ENOENT')throw e;}
 const rows=[];for(const n of names)rows.push(await readWorkspaceJSON(work,'integrations/'+n));return rows.sort((a,b)=>a.at.localeCompare(b.at));
}
const brief=r=>({id:r.id,at:r.at,files:r.files.map(f=>f.path),summary:r.summary,gameChecked:Boolean(r.gameCheck)});
async function gameFile(link,path,{original,candidate}){
 if(!link?.exists||!path)return null;
 try{const file=await inside(link.root,path),info=await stat(file);if(!info.isFile())return {path,state:'missing'};const digest=await fileSha(file);return {path,sha256:digest,state:digest===candidate?'candidate':digest===original?'original':'changed'};}
 catch(e){if(e.code==='ENOENT'||/outside/i.test(e.message))return {path,state:'missing'};throw e;}
}
async function references(work,job){
 try{const p=(await readTaskContext(work,job)).projectContext||{},pick=kind=>f=>({kind,path:f.relativePath,confidence:f.confidence,why:f.why||undefined});
  return [...(p.sources||[]).map(pick('source')),...(p.code||[]).map(pick('code'))].filter(f=>f.path).sort((a,b)=>(a.confidence==='linked'?0:1)-(b.confidence==='linked'?0:1)).slice(0,12);}
 catch{return [];}
}
function candidateHint(e){
 if(e.status==='withdrawn')return '用户之后改了决定，不要接入；需要时请用户重新认可。';
 if(e.status==='superseded')return '这一版之后又认可了基于它的修改，接入最新那一版即可。';
 const g=e.game,notes=[];
 if(e.status==='integrated'){notes.push('已记录接入；只有用户要求重新接入时才再处理。');if(e.changedSinceIntegration)notes.push(`接入后游戏里的 ${g.modelFile} 又被改动过，和记录时不同。`);return notes.join('');}
 if(!g.modelFile)notes.push('这个模型不是从游戏工程打开的，先向用户确认游戏里对应的文件。');
 else if(g.composite)notes.push(`组合角色：动作「${e.clip}」归 ${g.clipOwner||g.modelFile} 所有，改那个来源，不要用整个组合 GLB 替换模型。`);
 else if(g.format&&g.format!=='glb')notes.push(`游戏用的是 ${g.format.toUpperCase()} 源文件，候选 GLB 不能直接替换；在制作源里重放这次修改，再按项目流程导出。`);
 else if(g.file?.state==='original')notes.push(`游戏里的 ${g.modelFile} 还是导入时的版本，可以用候选替换。`);
 else if(g.file?.state==='candidate')notes.push('游戏文件已经和候选一致，确认游戏内效果后记录接入。');
 else if(g.file?.state==='changed')notes.push(`游戏里的 ${g.modelFile} 在导入后已被改动，直接替换会丢掉那些改动；先比较，或在制作源里重放修改。`);
 else notes.push(`游戏里找不到 ${g.modelFile}，先确认这个模型现在从哪里加载。`);
 // The model file itself and other exported formats are not authoring sources.
 const native=e.references.filter(r=>r.kind==='source'&&r.confidence==='linked'&&r.path!==g.modelFile&&!/\.(glb|gltf)$/i.test(r.path)).map(r=>r.path);
 if(native.length)notes.push(`项目里关联了制作源 ${native.join('、')}：只替换导出文件的话，下次从制作源导出会丢掉这次修改。`);
 if(e.otherBranches.length)notes.push('同一模型还有另一条已认可版本不在这条修改链上，接入前请用户确认用哪一版。');
 if(e.activeJobs)notes.push(BUSY);
 return notes.join('');
}
async function candidateEntries(work,link,cfg,records,index){
 const entries=[];
 for(const row of index.rows){
  if(!row.review)continue;
  const j=await readWorkspaceJSON(work,'jobs/'+row.id+'/job.json'),accepted=(j.reviews||[]).findLast(r=>r.decision==='accept-candidate'&&r.checkpointFile);if(!accepted)continue;
  const point=await readWorkspaceJSON(work,accepted.checkpointFile);
  if(point.id!==accepted.id||point.jobId!==j.id||point.asset?.sha256!==j.candidate?.sha256)throw Error('已认可检查点身份不一致：'+accepted.id);
  const source=[point.asset.source,point.source?.source,j.inputs?.baseline?.source].find(s=>s?.projectRelativePath)||null,owner=source?.assembly?.clips?.[point.clip];
  const game={modelFile:source?.projectRelativePath||null,format:source?.format||null,composite:Boolean(source?.assembly),clipOwner:source?.assembly?(owner?.file||source.projectRelativePath):null,file:source?.assembly||source?.format!=='glb'?null:await gameFile(link,source?.projectRelativePath,{original:source?.sha256,candidate:point.asset.sha256})};
  const mine=records.filter(r=>r.kind==='candidate'&&r.jobId===j.id),recorded=mine.flatMap(r=>r.files).filter(f=>f.path===game.modelFile).at(-1);
  entries.push({kind:'candidate',checkpointId:point.id,jobId:j.id,assetId:point.assetId,model:cfg.models[point.assetId]?.name||null,clip:point.clip,scope:point.scope,request:j.request,acceptedAt:point.acceptedAt,
   candidate:{file:await inside(work,point.asset.file),sha256:point.asset.sha256,label:point.asset.label},withdrawn:j.reviews.at(-1)?.decision!=='accept-candidate',lineage:jobAncestors(index.rows,j),
   activeJobs:index.counts[point.assetId]?.active||0,game,references:await references(work,j),projectContextFile:j.projectContextFile?await inside(work,j.projectContextFile):null,integrations:mine.map(brief),changedSinceIntegration:Boolean(recorded&&game.file?.sha256&&recorded.sha256!==game.file.sha256)});
 }
 const peers=e=>entries.filter(x=>x!==e&&x.assetId===e.assetId&&!x.withdrawn);
 for(const e of entries){const newer=peers(e).find(x=>x.lineage.has(e.jobId));if(newer)e.supersededBy=newer.checkpointId;}
 for(const e of entries){
  e.status=e.withdrawn?'withdrawn':e.supersededBy?'superseded':e.integrations.length?'integrated':'pending';
  e.otherBranches=e.withdrawn||e.supersededBy?[]:peers(e).filter(x=>!x.supersededBy&&!x.lineage.has(e.jobId)&&!e.lineage.has(x.jobId)).map(x=>x.checkpointId);
 }
 for(const e of entries){e.hint=candidateHint(e);delete e.withdrawn;delete e.lineage;}
 return entries;
}
function actionHint(e){
 if(e.status==='superseded')return '同名动作之后又收录了新版本，接入最新那一版。';
 if(e.modelChanged)return '角色模型在收录后已更新，这条收录固定在旧模型上；请在动作库对当前模型重新试播并收录，再导出。';
 const ways=[e.game.modelFile?`用 export-action 导出合好这段动作的角色 GLB，替换 ${e.game.modelFile}`:'用 export-action 导出合好这段动作的角色 GLB，先向用户确认游戏里对应的模型文件',e.motion.sourceFile?`或让游戏直接从 ${e.motion.sourceFile} 加载片段「${e.clip}」`:''].filter(Boolean);
 return ways.join('，')+`。游戏代码按片段名「${e.clip}」引用这段动作。`+(e.status==='integrated'?'已记录接入；只有用户要求重新接入时才再处理。':e.activeJobs?BUSY:'');
}
async function actionEntries(cfg,lib,records,index){
 const entries=[];
 for(const [assetId,actions] of Object.entries(lib.characters||{}))for(const a of actions){
  const r=a.recipe,head=modelSlots(cfg,assetId)[r.slot],version=lib.packs.find(p=>p.id===r.packId)?.versions.find(v=>v.id===r.versionId),mine=records.filter(x=>x.kind==='action'&&x.actionId===a.id).map(brief),latest=actions.filter(x=>x.name===a.name).at(-1);
  const e={kind:'action',actionId:a.id,assetId,model:cfg.models[assetId]?.name||null,name:a.name,number:a.number,clip:r.clip,adoptedAt:a.createdAt,status:latest.id!==a.id?'superseded':mine.length?'integrated':'pending',modelChanged:head?.sha256!==r.modelSha,activeJobs:index.counts[assetId]?.active||0,
   motion:{pack:r.packName,version:r.versionNumber,sourceFile:version?.source?.file||null,mappingId:r.mappingId||null},game:{modelFile:head?.sha256===r.modelSha?head.source?.projectRelativePath||null:null,format:head?.sha256===r.modelSha?head.source?.format||null:null},integrations:mine};
  e.hint=actionHint(e);entries.push(e);
 }
 return entries;
}
export async function integrationStatus(work){return withWorkspaceLock(work,async()=>{
 const [link,cfg,lib,records,index]=await Promise.all([getProjectLink(work),readProject(work),readMotionLibrary(work),readRecords(work),readJobIndex(work)]);
 const candidates=await candidateEntries(work,link,cfg,records,index),actions=await actionEntries(cfg,lib,records,index),pending=[...candidates,...actions].filter(e=>e.status==='pending').length;
 return {project:link?{name:link.name,root:link.root,available:link.exists}:null,pending,candidates,actions,
  next:!link?.exists?'工作区没有关联可用的游戏项目；接入前先用 project-open 关联项目。':pending?'只接入用户这次要求的条目。改完游戏文件并在游戏里检查后，用 integrate 记录改了哪些文件。':'没有等待接入的认可候选或收录动作。'};
});}
export async function projectFiles(link,files){
 const list=[...new Set((Array.isArray(files)?files:[files]).filter(f=>typeof f==='string'&&f.trim()).map(f=>f.trim()))];
 if(!list.length||list.length>MAX_FILES)throw Error(`请列出这次接入改动的游戏文件（1 到 ${MAX_FILES} 个）`);
 const out=new Map();
 for(const f of list){
  // An absolute path may reach the project through a symlinked prefix (macOS /var).
  let file;try{file=await inside(link.root,isAbsolute(f)?await realpath(f).catch(()=>f):f);}catch{throw Error('文件不在关联的游戏项目里：'+f);}
  const info=await stat(file).catch(e=>{throw e.code==='ENOENT'?Error('找不到游戏文件：'+f):e;});if(!info.isFile())throw Error('不是普通文件：'+f);
  const path=relative(link.root,file).split(sep).join('/');if(!out.has(path))out.set(path,{path,sha256:await fileSha(file),bytes:info.size});
 }
 return [...out.values()];
}
// Recording is evidence of what an agent already changed in the game; it
// modifies no game file and never stands in for the user's in-game check.
export async function recordIntegration(work,{checkpointId,actionId,files,summary,gameCheck}={}){
 if(Boolean(checkpointId)===Boolean(actionId))throw Error('请指定一个已认可检查点（--checkpoint）或一条收录动作（--action）');
 summary=text(summary,'接入说明');gameCheck=gameCheck===undefined||gameCheck===null||gameCheck===''?null:text(gameCheck,'游戏内检查');
 const link=await getProjectLink(work);if(!link?.exists)throw Error('工作区没有关联可用的游戏项目，无法记录接入；先用 project-open 关联项目。');
 const changed=await projectFiles(link,files);
 return withWorkspaceLock(work,async()=>{
  const id=randomUUID(),at=new Date().toISOString(),record={version:1,id,at,project:{id:link.id,name:link.name},summary,gameCheck},changes={};let original=null;
  if(checkpointId){
   if(!UUID.test(checkpointId))throw Error('无效检查点 ID');
   const point=await readWorkspaceJSON(work,'checkpoints/'+checkpointId+'.json').catch(e=>{throw e.code==='ENOENT'?Error('没有找到这个已认可检查点，请用 integrations 查看'):e;});
   if(!UUID.test(point.jobId||''))throw Error('已认可检查点身份不一致，未记录。');
   const j=await readWorkspaceJSON(work,'jobs/'+point.jobId+'/job.json');
   if(point.status!=='user-accepted-preview'||point.asset?.sha256!==j.candidate?.sha256||!j.reviews?.some(r=>r.id===point.id))throw Error('已认可检查点身份不一致，未记录。');
   if(j.reviews.at(-1).decision!=='accept-candidate')throw Error('该候选后续已有其他评审决定，请让用户重新确认认可后再接入。');
   original=[point.asset.source,point.source?.source,j.inputs?.baseline?.source].find(s=>s?.projectRelativePath)?.sha256||null;
   Object.assign(record,{kind:'candidate',checkpointId:point.id,jobId:j.id,assetId:point.assetId,clip:point.clip,asset:{file:point.asset.file,sha256:point.asset.sha256},files:changed.map(f=>({...f,matches:f.sha256===point.asset.sha256?'candidate':f.sha256===original?'original':null}))});
   (j.integrations??=[]).push({id,recordFile:'integrations/'+id+'.json',checkpointId:point.id,at,files:changed.map(f=>f.path),gameChecked:Boolean(gameCheck)});j.updatedAt=at;changes['jobs/'+j.id+'/job.json']=j;
  }else{
   const lib=await readMotionLibrary(work),found=findAdoptedAction(lib,actionId);if(!found)throw Error('没有找到这条收录动作，请用 integrations 查看');
   const head=modelSlots(await readProject(work),found.assetId)[found.action.recipe.slot];original=head?.sha256===found.action.recipe.modelSha?head.source?.sha256||null:null;
   let exported=null;try{exported=(await exportAdoptedAction(work,{actionId})).sha256;}catch{}
   Object.assign(record,{kind:'action',actionId,assetId:found.assetId,name:found.action.name,clip:found.action.recipe.clip,recipe:found.action.recipe,files:changed.map(f=>({...f,matches:exported&&f.sha256===exported?'export':f.sha256===original?'original':null}))});
  }
  if(original&&record.files.every(f=>f.matches==='original'))throw Error('列出的游戏文件还是导入时的原版，没有接入任何改动。');
  changes['integrations/'+id+'.json']=record;await commitWorkspace(work,changes);return record;
 });
}
