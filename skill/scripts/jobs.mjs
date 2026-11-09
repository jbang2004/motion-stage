import {providerInfo} from './agent-providers.mjs';
import {normalizeCaller,assertCaller,callerLabel} from '../assets/viewer/caller.mjs';
import {readFile,readdir,mkdir,stat,lstat} from 'node:fs/promises';
import {resolve,basename,relative,sep,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {ROOT,json,atomic,inside,withWorkspaceLock,glbInfo,importAsset,sha,readProject,modelSlots,setModelSlots,stageAsset,commitWorkspace,readWorkspaceJSON,projectView} from './core.mjs';
import {freezeTaskContext,readTaskContext,contextDrift,assembleTaskContext} from './task-context.mjs';
import {getProjectLink} from './project-context.mjs';
import {sourceForTask} from './source-dependencies.mjs';
import {createCurveResource} from './curve-resources.mjs';
import {validateCandidate} from './candidate-validation.mjs';
import {compareCandidate} from './candidate-diff.mjs';
import {executionHealth} from './execution-runtime.mjs';
import {readJobIndex} from './job-index.mjs';
import {undoGuard,appendUndo,advanceUndo} from './undo.mjs';
import {sideConflict,SIDE_NAMES} from '../assets/viewer/body-side.mjs';
import {validateFeedbackPoints} from '../assets/viewer/feedback-points.mjs';
import {validateFootRepair} from '../assets/viewer/foot-repair.mjs';

const ID=/^[a-f0-9-]{36}$/;
const finalStates=new Set(['complete','failed','cancelled','stale']);
const progressPhases=new Set(['reading','editing','checking','exporting']);
const clean=j=>{const d=structuredClone(j);delete d.lease;delete d.completionReceipt;return d;};
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
function claimCommand(work,j){return `node ${quote(resolve(ROOT,'scripts/motion-feedback.mjs'))} claim --workspace ${quote(resolve(work))} --job ${j.id}${j.caller?` --caller ${quote(j.caller.client)} --session ${quote(j.caller.sessionId)}`:''}`;}
function jobId(id){if(!ID.test(id||''))throw Error('无效任务 ID');return id;}
async function jobFile(work,id){return inside(work,'jobs/'+jobId(id)+'/job.json');}
async function rawJob(work,id){const j=await readWorkspaceJSON(work,'jobs/'+jobId(id)+'/job.json');j.taskPath=await inside(work,j.taskFile||'jobs/'+jobId(id)+'/task.md');j.agentCommand=`node ${quote(resolve(ROOT,'scripts/motion-feedback.mjs'))} job --workspace ${quote(resolve(work))} --job ${j.id}`;j.claimCommand=claimCommand(work,j);j.executionPaths={workspace:resolve(work),source:j.inputs?.[j.slot]?.file?await inside(work,j.inputs[j.slot].file):null,context:await inside(work,'jobs/'+jobId(id)+'/context.json'),projectContext:j.projectContextFile?await inside(work,j.projectContextFile):null,outputDirectory:await inside(work,j.outputDirectory||'jobs/'+jobId(id)+'/agent-output')};return j;}
async function saveJob(work,j){j.updatedAt=new Date().toISOString();await atomic(await jobFile(work,j.id),j);return j;}
function event(j,state,message){j.state=state;(j.events??=[]).push({state,message,at:new Date().toISOString()});}
function text(value,label,max=12000){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'不能为空，且不能超过 '+max+' 字符');return value.trim();}
const activeStates=new Set(['queued','running','needs-input']);
function requireLease(j,lease){if(j.state!=='running'||!lease||lease!==j.lease)throw Error('任务状态或执行租约不匹配');}
export async function updateJobProgress(work,id,{lease,phase,message,source='agent'}={}){return withWorkspaceLock(work,async()=>{
 await reconcileExecutions(work,{id});const j=await rawJob(work,id);requireLease(j,lease);
 if(!progressPhases.has(phase))throw Error('无效进度阶段');
 if(!['agent','system'].includes(source))throw Error('无效进度来源');
 const entry={phase,message:text(message,'进度说明',500),source,at:new Date().toISOString()};
 j.progress=entry;j.lastActivityAt=entry.at;j.progressEvents=[...(j.progressEvents||[]),entry].slice(-80);
 await saveJob(work,j);return clean(j);
});}
export async function recordProviderSession(work,id,{lease,provider,sessionId}={}){return withWorkspaceLock(work,async()=>{
 const j=await rawJob(work,id);requireLease(j,lease);
 if(provider!==j.provider||typeof sessionId!=='string'||!/^session-[A-Za-z0-9-]{1,100}$/.test(sessionId))throw Error('后台执行会话标识无效');
 if(j.providerSession&&j.providerSession.sessionId!==sessionId)throw Error('后台执行会话已经绑定');
 j.providerSession={provider,sessionId,attemptId:j.attemptId};await saveJob(work,j);return clean(j);
});}
export async function updateJobActivity(work,id,{lease,message}={}){return withWorkspaceLock(work,async()=>{
 await reconcileExecutions(work,{id});const j=await rawJob(work,id);requireLease(j,lease);
 j.activity={message:text(message,'活动说明',500),at:new Date().toISOString(),source:'system'};j.lastActivityAt=j.activity.at;
 await saveJob(work,j);return clean(j);
});}
async function verifyInputs(work,j,onSource){
 const cfg=await readProject(work),heads=modelSlots(cfg,j.assetId||cfg.legacyAssetId);
 if(j.modelRevision!==undefined&&j.modelRevision!==(cfg.models[j.assetId||cfg.legacyAssetId]?.headRevision||0))return false;
 for(const slot of ['baseline','candidate']){
  const frozen=j.inputs[slot],current=heads[slot];
  if((frozen?.sha256||null)!==(current?.sha256||null))return false;
  if(frozen){const b=await readFile(await inside(work,frozen.file));if(sha(b)!==frozen.sha256)throw Error('任务源文件已损坏：'+slot);if(slot===j.slot)onSource?.(b);}
 }
 return true;
}
export async function listJobs(work,{raw=false}={}){return withWorkspaceLock(work,async()=>{
 await reconcileExecutions(work);
 const dir=await inside(work,'jobs');let files;try{files=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return[];throw e;}
 const jobs=[];for(const f of files)if(f.isDirectory()&&ID.test(f.name)){try{jobs.push(await rawJob(work,f.name));}catch(e){if(e.code!=='ENOENT')throw e;}}
 jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return raw?jobs:jobs.map(clean);
});}
// The listing an agent reads to pick a task: one summary per job (state,
// request, model, clip, progress) instead of every frozen detail. `job` reads one.
export async function listJobSummaries(work){return withWorkspaceLock(work,async()=>{
 let index=await readJobIndex(work);if((await reconcileExecutions(work,{index})).changed)index=await readJobIndex(work);
 return index.rows.map(({detailRevision,summaryOnly,...row})=>row);
});}
export async function getJob(work,id,{raw=false}={}){return withWorkspaceLock(work,async()=>{await reconcileExecutions(work,{id});const j=await rawJob(work,id);if(j.state==='running'&&j.execution)j.executionHealth={...j.executionHealth,...await executionHealth(work,j.execution)};return raw?j:clean(j);});}
// Recovery is serialized with claims/completion. Heartbeats live outside this lock so
// a busy workspace never masquerades as an unresponsive execution host.
export async function reconcileExecutions(work,{index,id}={}){return withWorkspaceLock(work,async()=>{
 const rows=id?[{id}]:((index||await readJobIndex(work)).rows.filter(j=>j.state==='running'));let changed=false;
 for(const row of rows){
  let j;try{j=await rawJob(work,row.id);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(j.state!=='running'||!j.execution)continue;
  const health=await executionHealth(work,j.execution);
  if(health.status==='dead'){
   j.executionHealth={status:'dead',reason:health.reason,observedAt:new Date().toISOString()};j.error=health.reason;j.interruptedAt=new Date().toISOString();j.finishedAt=j.interruptedAt;
   event(j,'interrupted',health.reason);delete j.lease;await saveJob(work,j);changed=true;
  }else if(j.executionHealth?.status!==health.status){j.executionHealth={status:health.status,...(health.reason?{reason:health.reason}:{}),observedAt:new Date().toISOString()};await saveJob(work,j);changed=true;}
 }
 return {changed};
});}
export async function assertModelAvailable(work,assetId,excludeId){
 const index=await readJobIndex(work);if((await reconcileExecutions(work,{index})).changed)return assertModelAvailable(work,assetId,excludeId);
 const busy=index.rows.find(j=>j.id!==excludeId&&(j.assetId||'legacy')===(assetId||'legacy')&&activeStates.has(j.state));
 if(busy)throw Object.assign(Error('这个模型已有'+({'queued':'排队中','running':'执行中','needs-input':'等待补充'}[busy.state])+'的任务（'+busy.id+'）。请先处理、补充或取消该任务，再提交当前草稿；草稿尚未提交。'),{code:'MODEL_JOB_ACTIVE',jobId:busy.id});
}
export async function interruptJob(work,id,{lease,reason='用户中断了执行；现场和产物已保留，可检查后重新执行或取消。'}={}){return withWorkspaceLock(work,async()=>{
 const j=await rawJob(work,id);if(j.state==='interrupted')return clean(j);if(j.state!=='running')throw Error('只有执行中的任务可以中断');
 if(lease!==undefined)requireLease(j,lease);
 j.error=text(reason,'中断说明');j.interruptedAt=new Date().toISOString();j.finishedAt=j.interruptedAt;event(j,'interrupted',j.error);delete j.lease;await saveJob(work,j);return clean(j);
});}
export async function retryJob(work,id){return withWorkspaceLock(work,async()=>{
 await reconcileExecutions(work);const j=await rawJob(work,id);if(!['interrupted','failed'].includes(j.state))throw Error('只有中断或失败的任务可以重新执行；等待补充的任务请先回复。');
 await assertModelAvailable(work,j.assetId,j.id);
 if(!await verifyInputs(work,j)){event(j,'stale','原任务版本已变化，请保留产物并基于当前版本重新提交');await saveJob(work,j);throw Error('任务已过期，不能重放旧意见；请基于当前版本重新提交。');}
 const drift=await contextDrift(work,j);if(drift.status==='changed'){j.contextDrift=drift;event(j,'stale','关联制作源或代码已变化，请重新提交');await saveJob(work,j);throw Error('项目上下文已变化，不能重新执行旧任务。');}
 (j.attempts??=[]).push({execution:j.execution||null,attemptId:j.attemptId||null,providerSession:j.providerSession||null,outputDirectory:j.outputDirectory||null,claimedAt:j.claimedAt,finishedAt:j.finishedAt,state:j.state,error:j.error||null});
 delete j.execution;delete j.executionHealth;delete j.lease;delete j.error;delete j.finishedAt;delete j.activity;delete j.progress;delete j.lastActivityAt;delete j.outputDirectory;delete j.attemptId;delete j.providerSession;delete j.interruptedAt;
 event(j,'queued','用户明确重新执行；旧现场和产物保留在先前执行目录。');await saveJob(work,j);return clean(j);
});}
export async function restoreJob(work,id,{checkpointId,expectedRevision}={}){return withWorkspaceLock(work,async()=>{
 const j=await rawJob(work,id),cfg=await readProject(work),assetId=j.assetId||cfg.legacyAssetId;
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==(cfg.revision||0))throw Error('当前预览版本已变化，请刷新后再恢复已认可版本。');
 await assertModelAvailable(work,assetId);
 const review=(j.reviews||[]).findLast(r=>r.decision==='accept-candidate'&&r.checkpointFile&&(!checkpointId||r.id===checkpointId));
 if(!review)throw Error('没有找到这个任务已由用户认可的检查点。');
 if(j.reviews.at(-1)?.decision!=='accept-candidate')throw Error('该候选后续已有其他评审决定，请重新确认认可后再恢复。');
 const point=await json(await inside(work,review.checkpointFile));
 if(point.jobId!==j.id||point.assetId!==assetId||point.id!==review.id||point.status!=='user-accepted-preview'||point.installed!==false||point.asset?.sha256!==review.assets?.candidate?.sha256)throw Error('已认可检查点身份不一致，未恢复。');
 const bytes=await readFile(await inside(work,point.asset.file));if(sha(bytes)!==point.asset.sha256)throw Error('已认可检查点文件校验失败，未恢复。');
 const staged=await stageAsset(work,'candidate',bytes,point.asset.label||'已认可版本',{assetId,activate:false,source:point.asset.source});
 const restore={id:randomUUID(),checkpointId:point.id,asset:staged.asset,previous:modelSlots(cfg,assetId).candidate||null,at:new Date().toISOString()};
 (j.restores??=[]).push(restore);j.updatedAt=restore.at;
 await commitWorkspace(work,{'project.json':staged.project,['jobs/'+j.id+'/job.json']:j});
 return {project:projectView(staged.project,assetId),job:clean(j)};
});}
export async function jobArtifacts(work,id){
 const j=await getJob(work,id),base='jobs/'+jobId(id)+'/agent-output',files=[];
 async function visit(dir){let entries;try{entries=await readdir(await inside(work,dir),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const entry of entries){if(files.length>=2000)return;const file=dir+'/'+entry.name;if(entry.isSymbolicLink())continue;if(entry.isDirectory())await visit(file);else if(entry.isFile()){const info=await lstat(await inside(work,file));files.push({file,size:info.size,modifiedAt:info.mtime.toISOString()});}}
 }
 await visit(base);
 for(const name of ['candidate.glb','audit.json']){const file='jobs/'+jobId(id)+'/'+name;try{const info=await lstat(await inside(work,file));if(info.isFile()&&!info.isSymbolicLink())files.push({file,size:info.size,modifiedAt:info.mtime.toISOString()});}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {jobId:j.id,outputDirectory:j.outputDirectory||null,files};
}
export async function validateJobs(work){
 const rows=await listJobs(work),checked=new Map();
 async function asset(a){
  if(!a||typeof a.file!=='string'||!/^assets\/[a-f0-9]{64}\.glb$/.test(a.file)||!/^[a-f0-9]{64}$/.test(a.sha256||''))throw Error('任务资产身份无效');
  const key=a.file+'|'+a.sha256;if(!checked.has(key)){const b=await readFile(await inside(work,a.file));if(sha(b)!==a.sha256)throw Error('任务引用的资产已变化：'+a.file);checked.set(key,glbInfo(b));}return checked.get(key);
 }
 for(const j of rows){
  jobId(j.id);if(j.version!==2||!['queued','running','needs-input','complete','failed','cancelled','stale','interrupted'].includes(j.state))throw Error('任务状态无效：'+j.id);
  text(j.request,'任务要求');if(!['baseline','candidate'].includes(j.slot))throw Error('任务版本槽无效');
  for(const a of Object.values(j.inputs||{}))await asset(a);
  const info=await asset(j.inputs?.[j.slot]),clip=info.clips.find(c=>c.name===j.clip);
  if(info.clips.length&&!clip)throw Error('任务动作不属于冻结源文件：'+j.id);
  if(!j.scope||!Number.isFinite(j.scope.start)||!Number.isFinite(j.scope.end)||j.scope.start<0||j.scope.end<j.scope.start||j.scope.end>(clip?.duration||0)+.001)throw Error('任务时间范围无效：'+j.id);
  await readFile(await inside(work,j.taskFile));const context=await json(await inside(work,'jobs/'+j.id+'/context.json'));
  const points=validateFeedbackPoints(j.feedbackPoints,{sha:j.inputs[j.slot].sha256,clip:j.clip,duration:clip?.duration||0,scope:j.scope});
  if(!isDeepStrictEqual(points,context.feedbackPoints??[]))throw Error('任务反馈标记与冻结现场不一致：'+j.id);
  if(j.footRepair||context.footRepair){
   validateFootRepair(j.footRepair,{sha:j.inputs[j.slot].sha256,clip:j.clip,duration:clip?.duration||0,scope:j.scope});
   if(!isDeepStrictEqual(j.footRepair,context.footRepair))throw Error('脚滑诊断与冻结现场不一致：'+j.id);
  }
  if(j.projectContextFile)await readTaskContext(work,j);
  if(j.screenshot){const b=await readFile(await inside(work,j.screenshot));if(b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('任务截图无效：'+j.id);}
  if(j.state==='complete'){await asset(j.candidate);text(j.summary,'完成说明');}
  for(const r of j.reviews||[]){if(!['accept-candidate','keep-baseline','revise'].includes(r.decision)||!r.assets?.candidate)throw Error('任务评审缺少候选身份：'+j.id);for(const a of Object.values(r.assets))if(a)await asset(a);if(r.recordFile){const record=await json(await inside(work,r.recordFile));if(record.jobId!==j.id||record.id!==r.id||record.decision!==r.decision)throw Error('任务决定记录不一致：'+j.id);}if(r.checkpointFile){const point=await json(await inside(work,r.checkpointFile));if(point.jobId!==j.id||point.asset?.sha256!==r.assets.candidate.sha256||point.status!=='user-accepted-preview'||point.installed!==false)throw Error('已验收检查点身份不一致：'+j.id);}}
  for(const g of j.integrations||[]){if(typeof g.recordFile!=='string'||!/^integrations\/[a-f0-9-]{36}\.json$/.test(g.recordFile))throw Error('任务接入记录无效：'+j.id);const record=await json(await inside(work,g.recordFile));if(record.id!==g.id||record.kind!=='candidate'||record.jobId!==j.id||record.checkpointId!==g.checkpointId)throw Error('任务接入记录不一致：'+j.id);}
 }
 return {jobs:rows,jobsCount:rows.length,assetVersionsChecked:checked.size};
}
export async function inspectSlot(work,slot='baseline',assetId){
 if(!['baseline','candidate'].includes(slot))throw Error('无效版本槽');const cfg=await readProject(work),a=modelSlots(cfg,assetId)[slot];if(!a)throw Error('尚未载入该版本');
 const bytes=await readFile(await inside(work,a.file));if(sha(bytes)!==a.sha256)throw Error('资产校验失败');
 const {inspectAsset}=await import('./asset-tools.mjs');return {...inspectAsset(bytes),asset:a,slot,source:a.source||null};
}
// Measured motion checks on a workspace version or an explicit GLB (for example a candidate
// still in a job's output directory). With a baseline, findings are marked new/existing/resolved.
async function verifiedMotionBytes(work,asset){
 const bytes=await readFile(await inside(work,asset.file));
 if(sha(bytes)!==asset.sha256)throw Error('资产校验失败');
 return bytes;
}

export async function checkMotionSlot(work,{slot='baseline',assetId,file,baselineSlot,baselineFile,jobId,...options}={}){
 let frozen,job;
 if(jobId){
  if(!work)throw Error('--job 需要 --workspace');
  if(baselineSlot||baselineFile)throw Error('--job 已固定本轮输入，不能再指定比较基准');
  job=await getJob(work,jobId);frozen=job.inputs[job.slot];
  if(assetId&&assetId!==job.assetId)throw Error('检查模型与任务不一致');
  assetId=job.assetId;options.clip??=job.clip;
  if(options.clip!==job.clip)throw Error('检查动作与任务不一致');
  if(!file){if(!job.candidate)throw Error('请用 --file 指定本轮候选');file=await inside(work,job.candidate.file);}
 }
 const load=async(s,f)=>{
  if(f)return readFile(resolve(f));if(!work)throw Error('需要 --workspace 或 --file');
  if(!['baseline','candidate'].includes(s))throw Error('无效版本槽');const cfg=await readProject(work),a=modelSlots(cfg,assetId)[s];if(!a)throw Error('尚未载入该版本');
  return verifiedMotionBytes(work,a);
 };
 const {checkMotion,compareMotionChecks}=await import('./motion-checks.mjs');
 const result=checkMotion(await load(slot,file),options);
 if(frozen){const bytes=await verifiedMotionBytes(work,frozen);return {...compareMotionChecks(checkMotion(bytes,options),result),jobId:job.id,assetId:job.assetId,scope:job.scope};}
 if(!baselineSlot&&!baselineFile)return result;
 return compareMotionChecks(checkMotion(await load(baselineSlot,baselineFile),options),result);
}

export async function diagnoseFootSlip(work,{assetId,clip,versions,jobId}={}){
 const requested=Object.entries(versions||{});
 if(typeof assetId!=='string'||!assetId||typeof clip!=='string'||!clip||
    !requested.length||requested.some(([slot,hash])=>!['baseline','candidate'].includes(slot)||typeof hash!=='string'||!(/^[a-f0-9]{64}$/.test(hash))))throw Error('脚滑检查需要当前模型、动作和版本。');
 let assets;
 if(jobId){
  const job=await getJob(work,jobId);
  const jobAssetId=job.assetId||(await readProject(work)).legacyAssetId;
  if(job.state!=='complete'||jobAssetId!==assetId)throw Error('脚滑检查与归档任务不一致。');
  assets={baseline:job.inputs[job.slot||'baseline'],candidate:job.candidate};
 }else assets=modelSlots(await readProject(work),assetId);
 const inputs=requested.map(([slot,hash])=>{
  const asset=assets[slot];
  if(asset?.sha256!==hash)throw Error('观察版本已变化，请重新打开动作后检查。');
  const clips=asset.clips.filter(c=>c.name===clip);
  if(clips.length!==1||!clips[0].duration)throw Error('请在可比较的版本上选择同一个有效动作。');
  if(clips[0].duration>120)throw Error('界面脚滑检查支持 120 秒以内的动作。');
  return [slot,asset];
 });
 const fps=30,{checkMotion}=await import('./motion-checks.mjs'),reports=[];
 for(const [slot,asset] of inputs){
  const bytes=await verifiedMotionBytes(work,asset);
  reports.push({slot,...checkMotion(bytes,{clip,fps,checks:['footSlip']})});
 }
 return {clip,fps,reports};
}

const sideNote=c=>`左右提示：要求写的是${SIDE_NAMES[c.requested]}侧，页面选中的却是角色${SIDE_NAMES[c.picked]}侧的 ${c.bone}${c.inferred?'（由点击位置推断）':''}。左右按角色自身朝向；用户可能按画面方向描述。先结合截图与文字确定是哪一侧；仍不确定时用 needs-input 询问，不要两侧都改。`;
function feedbackSection(points){
 if(!points?.length)return '';
 return '本轮反馈标记（按编号逐条处理；每条的镜头与部位见 context.json）：\n'+points.map((p,i)=>
  (i+1)+'. '+p.time.toFixed(3)+' 秒 · '+(p.target?.bone||p.target?.mesh||'整个动作')+'\n   '+p.note.replaceAll('\n','\n   ')
 ).join('\n')+'\n\n';
}
function footRepairSection(repair){
 if(!repair)return '';
 const motion=repair.runtime
  ?'模拟角色移动：每动画秒沿 '+repair.runtime.direction+' 移动 '+repair.runtime.speed+' 场景单位。修改前模拟漂移 '+repair.before.simulated+' 场景单位。'
  :'模拟角色移动速度未填写。原地动作先核对游戏跑速、播放倍率和前进方向。';
 return '## 脚滑修复证据\n\n脚节点 '+repair.foot+'（索引 '+repair.nodeIndex+'），着地观测区间 '+repair.time.join('–')+' 秒。修改前素材漂移 '+repair.before.raw+' 场景单位。'+motion+'\n使用相同脚节点和观测区间评估候选。将实际修改限制在任务范围内，利用观测区间外的预留帧平滑衔接。保留根位移、其他动作及非目标肢体。\n\n';
}
function makeTask(j,work){return `# 动作修改任务 ${j.id}\n\n路径说明：绝对路径记录创建时的位置。工程搬迁后，以 CLI job 返回的 executionPaths 为当前入口，相对资产路径仍以当前工作区为根。\n\n处理来源：${callerLabel(j.caller)}${j.caller?'；会话 '+j.caller.sessionId+'；仅路由绑定，不代表已唤醒客户端。':''}\n\n用户要求：\n${j.request}\n\n${feedbackSection(j.feedbackPoints)}${footRepairSection(j.footRepair)}${j.clarifications?.length?"补充说明：\n"+j.clarifications.map(c=>"- "+c.message).join("\n")+"\n\n":""}${j.lockOtherClips?'保护范围：仅允许修改当前动作。其他动作不得新增、删除或修改轨道。\n':''}保留条件：\n${j.preserve||'用户未额外指定；保留任务范围外的数据，先判断责任层。'}\n\n冻结源文件：${resolve(work,j.inputs[j.slot].file)}\n源文件 SHA-256：${j.inputs[j.slot].sha256}\n模型 ID：${j.assetId||'legacy'}\n模型版本修订：${j.modelRevision??'旧任务'}\n版本槽：${j.slot}\n动作：${j.clip||'静态模型'}\n查看时刻：${j.context.time??0} 秒。审阅帧号仅为 UI 步进单位，不是源 Blender 帧号。\n预览外观：${j.context?.appearance?.mode==='project'?'项目适配包 '+j.context.appearance.bundle:'中性检查'}\n范围：${JSON.stringify(j.scope)}\n目标：${JSON.stringify(j.target)}\n${j.sideConflict?sideNote(j.sideConflict)+'\n':''}上下文：${resolve(work,'jobs',j.id,'context.json')}\n${j.projectContextFile?'项目与连续修改上下文：'+resolve(work,j.projectContextFile)+'\n说明：'+resolve(work,j.projectContextMarkdown)+'\n':''}${j.screenshot?'观察截图：'+resolve(work,j.screenshot)+'\n':''}\n此任务由页面中的明确提交产生。界面选区本身不扩大修改授权。观察截图、来源映射、身体部位、时间和镜头必须结合起来解释；屏幕点不等于已确认骨骼。\n\n## 执行与回传\n\n先读取本 Skill 的 SKILL.md 和任务 context.json。检查源资产内部骨架、静止姿势、权重、动作曲线或制作源；选择实际负责的层。先 claim，保留返回的 lease。所有候选和脚本放在 claim 返回的 executionPaths.outputDirectory 中；每次执行目录独立，保留原始资产及旧产物。无法唯一确定意图时标记 needs-input，并给用户一个具体问题。\n\nCLI：\n${claimCommand(work,j)} --owner agent\n（--owner 可换成你的 Agent 名称，例如 claude-code、codex；只用于记录谁领取了任务。）\n\n修改完成后验证目标变化和保护范围，另存自包含 candidate.glb。回传：\nnode ${quote(resolve(ROOT,'scripts/motion-feedback.mjs'))} complete --workspace ${quote(work)} --job ${j.id} --lease CLAIM_RETURNED_LEASE --candidate /absolute/path/candidate.glb --summary '实际修改和验证范围'\n\n只在实际执行并检查后标记完成。若已由 worker claim，使用它给出的租约，不重复 claim。技术检查不代表用户艺术认可；回传候选不安装正式游戏。\n`;
}
export async function createJob(work,input){return withWorkspaceLock(work,async()=>{
 const cfg=await readProject(work),ctx=structuredClone(input.context||{}),assetId=input.assetId||ctx.assetId||cfg.activeAssetId,heads=modelSlots(cfg,assetId),slot=input.slot||ctx.slot||(ctx.displayMode==='comparison'?'candidate':'baseline'),a=heads[slot];
 if(input.assetId&&ctx.assetId&&input.assetId!==ctx.assetId)throw Error('任务与观察现场属于不同模型，请重新定位');
 if(!a)throw Error('先载入角色');
 await assertModelAvailable(work,assetId);
 const asset=ctx.asset||ctx.slots?.[slot]||ctx.comparison?.slots?.[slot];
 if(!asset||asset.sha256!==a.sha256||asset.file!==a.file)throw Error('反馈的资产版本已变化，请刷新并重新定位');
 const clip=ctx.clip??ctx.slots?.[slot]?.clip??'';const c=a.clips.find(x=>x.name===clip);
 if(a.clips.length&&!c)throw Error('动作不属于当前版本');
 if(input.lockOtherClips!==undefined&&typeof input.lockOtherClips!=='boolean')throw Error('锁定其他动作的设置无效');
 if(input.lockOtherClips&&!c)throw Error('请先选择本轮要修改的动作');
 const time=Number(ctx.time??ctx.slots?.[slot]?.time??0);if(!Number.isFinite(time)||time<0||time>(c?.duration||0)+.001)throw Error('无效反馈时刻');
 if(ctx.slots)for(const s of ['baseline','candidate']){const seen=ctx.slots[s],cur=heads[s];if(seen&&(!cur||cur.sha256!==seen.sha256||cur.file!==seen.file))throw Error('对照版本已变化，请刷新');}
 if(ctx.fps!==undefined&&(!Number.isFinite(ctx.fps)||ctx.fps<1||ctx.fps>240))throw Error('无效审阅帧率');
 if(JSON.stringify(ctx).length>150000)throw Error('反馈上下文过大，请使用截图附件');
 const scope={start:0,end:c?.duration||0,wholeClip:true,...input.scope};
 if(!Number.isFinite(scope.start)||!Number.isFinite(scope.end)||scope.start<0||scope.end<scope.start||scope.end>(c?.duration||0)+.001)throw Error('时间范围无效');
 const feedbackPoints=validateFeedbackPoints(input.feedbackPoints,{sha:a.sha256,clip,duration:c?.duration||0,scope});
 const footRepair=validateFootRepair(input.footRepair,{sha:a.sha256,clip,duration:c?.duration||0,scope});
 if(footRepair){
  if(input.executor==='local')throw Error('脚滑修复需要由 Agent 处理。');
  const {measureFootRepair}=await import('./motion-checks.mjs');
  footRepair.before=measureFootRepair(await verifiedMotionBytes(work,a),footRepair);
 }
 if(feedbackPoints.length&&input.executor==='local')throw Error('本地微调只处理一个数值调整，请单独提交反馈标记。');
 const blankRequest=input.request===undefined||typeof input.request==='string'&&!input.request.trim();
 const pointOnly=!footRepair&&feedbackPoints.length>0&&blankRequest;
 const request=pointOnly?'按本轮的 '+feedbackPoints.length+' 条反馈标记调整动作。':footRepair&&blankRequest?'检查并修复诊断区间的脚底滑动。':text(input.request,'修改要求');
 const target=footRepair?{bone:footRepair.foot,nodeIndex:footRepair.nodeIndex,inferred:true}:pointOnly?{}:structuredClone(input.target||ctx.selection||{});
 if(target.nodeIndex!==undefined&&(!Number.isSafeInteger(target.nodeIndex)||target.nodeIndex<0||target.nodeIndex>=100000))throw Error('目标节点索引无效');
 if(target.bone&&typeof target.bone!=='string'||target.mesh&&typeof target.mesh!=='string')throw Error('目标格式无效');
 if(JSON.stringify(target).length>10000)throw Error('目标上下文过大');
 if(target.point&&(!Array.isArray(target.point)||target.point.length!==3||!target.point.every(Number.isFinite)))throw Error('目标点必须是三个有限数值');
 await mkdir(await inside(work,'jobs'),{recursive:true});const id=randomUUID(),dir=await inside(work,'jobs/'+id);await mkdir(dir,{recursive:false});
 const inputs=structuredClone(heads);for(const head of Object.values(inputs))if(head.source)head.source=sourceForTask(head.source);
 const caller=input.executor!=='local'&&input.delivery==='chat'?normalizeCaller(input.caller):null;
 const provider=input.delivery==='chat'||input.executor==='local'?null:providerInfo(input.provider||'codex').id;
 const now=new Date().toISOString(),j={version:2,id,assetId,caller,provider,modelRevision:cfg.models[assetId]?.headRevision||0,state:'queued',executor:input.executor==='local'?'local':'agent',delivery:input.delivery==='chat'?'chat':'worker',request,preserve:typeof input.preserve==='string'?input.preserve.slice(0,12000):'',slot,clip,time,target,scope,context:{...ctx,assetId,time},inputs,source:sourceForTask(a.source)||null,createdAt:now,updatedAt:now,events:[],artisticDecision:null,parentJobId:input.parentJobId||null};
 if(feedbackPoints.length){j.feedbackPoints=feedbackPoints;j.pointOnly=pointOnly;}
 if(footRepair)j.footRepair=footRepair;
 j.claimCommand=claimCommand(work,j);
 if(input.lockOtherClips||footRepair)j.lockOtherClips=true;
 if(j.parentJobId&&!ID.test(j.parentJobId))throw Error('无效的父任务标识');
 const side=target.bone?sideConflict(j.request,target.bone):null;if(side)j.sideConflict={requested:side.requested,picked:side.picked,bone:side.bone,inferred:Boolean(target.inferred)};
 event(j,'queued','已记录；等待已连接的 Agent 或手动领取');j.taskFile='jobs/'+id+'/task.md';j.taskPath=resolve(work,j.taskFile);j.agentCommand=`node ${quote(resolve(ROOT,'scripts/motion-feedback.mjs'))} job --workspace ${quote(work)} --job ${id}`;
 if(input.screenshot){
  if(typeof input.screenshot!=='string'||!/^data:image\/png;base64,/.test(input.screenshot))throw Error('截图需要 PNG data URL');
  const bytes=Buffer.from(input.screenshot.split(',')[1],'base64');if(bytes.length>6*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('截图无效或超过 6MB');
  j.screenshot='jobs/'+id+'/view.png';await atomic(await inside(work,j.screenshot),bytes);
 }
 await freezeTaskContext(work,j);
 await atomic(resolve(dir,'context.json'),{version:2,jobId:id,assetId:j.assetId,caller:j.caller,request:j.request,target,scope,...(feedbackPoints.length?{feedbackPoints}:{}),...(footRepair?{footRepair}:{}),lockOtherClips:j.lockOtherClips===true,context:j.context,inputs:j.inputs,source:j.source,screenshot:j.screenshot||null,projectContextFile:j.projectContextFile,projectContextSha256:j.projectContextSha256});
 await atomic(j.taskPath,makeTask(j,work));await saveJob(work,j);return clean(j);
});}
export async function claimJob(work,id,{owner='agent',execution,caller}={}){return withWorkspaceLock(work,async()=>{
 await reconcileExecutions(work);
 const j=await rawJob(work,id);if(!['queued','needs-input'].includes(j.state))throw Error('任务不能重复领取：'+j.state);
 assertCaller(j.caller,caller);
 const conflict=(await readJobIndex(work)).rows.find(row=>row.id!==j.id&&row.assetId===(j.assetId||'legacy')&&['running','needs-input'].includes(row.state));if(conflict)throw Object.assign(Error('这个模型的另一任务正在执行或等待补充（'+conflict.id+'），请先处理该任务。'),{code:'MODEL_JOB_ACTIVE',jobId:conflict.id});
 if(!await verifyInputs(work,j)){event(j,'stale','资产版本已变化，需要重新提交');await saveJob(work,j);throw Error('任务已过期：当前资产版本不同');}
 if(!j.projectContextFile){await freezeTaskContext(work,j);await atomic(j.taskPath,makeTask(j,work));}
 const drift=await contextDrift(work,j);if(drift.status==='changed'){j.contextDrift=drift;event(j,'stale','关联的制作源或代码已变化，需要在当前版本重新提交');await saveJob(work,j);throw Error('项目上下文已过期，未开始修改');}
 if(j.outputDirectory)(j.attempts??=[]).push({execution:j.execution||null,attemptId:j.attemptId||null,providerSession:j.providerSession||null,outputDirectory:j.outputDirectory,claimedAt:j.claimedAt,finishedAt:j.finishedAt,state:j.state,error:j.error||null});
 delete j.providerSession;
 j.attemptId=randomUUID();j.outputDirectory='jobs/'+j.id+'/agent-output/'+j.attemptId;j.executionPaths.outputDirectory=await inside(work,j.outputDirectory);
 if(execution){const health=await executionHealth(work,execution);if(health.status!=='alive')throw Error('自动执行实例不可用，请重新连接执行器');j.execution=structuredClone(execution);j.executionHealth={status:'alive',observedAt:new Date().toISOString()};}else{delete j.execution;delete j.executionHealth;}
 await mkdir(await inside(work,j.outputDirectory),{recursive:true});delete j.interruptedAt;
 j.lease=randomUUID();j.owner=String(owner).slice(0,100);j.claimedAt=new Date().toISOString();j.progress={phase:'reading',message:'已领取任务，正在读取修改要求与观察现场。',source:'system',at:j.claimedAt};j.progressEvents=[j.progress];j.lastActivityAt=j.claimedAt;delete j.activity;delete j.error;delete j.finishedAt;event(j,'running','执行者 '+j.owner+' 已领取任务');return saveJob(work,j);
});}
export async function completeJob(work,id,{lease,candidatePath,summary,audit=null}={}){return withWorkspaceLock(work,async()=>{
 await reconcileExecutions(work,{id});const j=await rawJob(work,id);
 if(j.state==='complete'&&lease&&j.completionReceipt?.leaseSha256===sha(Buffer.from(lease))){
  if(sha(await readFile(resolve(candidatePath)))!==j.candidate.sha256)throw Error('重复回传与已提交的候选不同');
  return clean(j);
 }
 if(j.state!=='running'||!lease||lease!==j.lease)throw Error('任务状态或执行租约不匹配');
 let sourceBytes;
 if(!await verifyInputs(work,j,bytes=>{sourceBytes=bytes;})){event(j,'stale','执行期间版本已变化，候选保留但未替换当前预览');await saveJob(work,j);throw Error('任务已过期，未替换候选');}
 const drift=await contextDrift(work,j);if(drift.status==='changed'){j.contextDrift=drift;event(j,'stale','关联的制作源或代码已变化，候选保留在任务输出，未替换当前预览');await saveJob(work,j);throw Error('项目上下文已变化，需要重新核验');}
 const candidateStat=await stat(resolve(candidatePath));if(!candidateStat.isFile()||candidateStat.size>200*1024*1024)throw Error('候选需要是不超过 200 MB 的普通 GLB 文件');
 const bytes=await readFile(resolve(candidatePath));text(summary,'完成说明');
 const validation=validateCandidate(bytes,j.inputs[j.slot].clips||[],j.inputs[j.slot].capabilities),info=glbInfo(bytes);
 if(info.sha256===j.inputs[j.slot].sha256)throw Error('没有生成修改后的候选：文件与源版本完全相同');
 j.candidateDiff=compareCandidate(sourceBytes,bytes,{clip:j.clip,lockOtherClips:j.lockOtherClips});
 if(j.footRepair){
  const {measureFootRepair,checkMotion,compareMotionChecks}=await import('./motion-checks.mjs');
  try{j.footRepairResult={after:measureFootRepair(bytes,j.footRepair,{candidate:true})};}
  catch(error){j.footRepairResult={reason:error.message};}
  try{
   const options={clip:j.clip};
   j.footRepairResult.motionChecks=compareMotionChecks(checkMotion(sourceBytes,options),checkMotion(bytes,options));
  }catch(error){j.footRepairResult.motionCheckError=error.message;}
 }
 const beforeUndo=await undoGuard(work,j.assetId||'legacy');
 const upstream=j.source||j.inputs[j.slot].source;
 const staged=await stageAsset(work,'candidate',bytes,basename(candidatePath),{assetId:j.assetId||(await readProject(work)).legacyAssetId,activate:false,derivedByJobId:j.id,...(upstream?{source:{...upstream,derivedFromAssetSha256:j.inputs[j.slot].sha256,nativeSourceAtAssetSha256:upstream.nativeSourceAtAssetSha256||upstream.previewSha256||j.inputs[j.slot].sha256,nativeSourceSynchronized:false,derivedByJobId:j.id}}:{})});
 j.candidate=staged.asset;j.summary=summary;j.audit=audit;j.validation=validation;j.contextVerification=drift;j.automaticArtisticApproval=false;
 j.completionReceipt={leaseSha256:sha(Buffer.from(lease))};event(j,'complete','候选已回传，等待用户比较');j.finishedAt=new Date().toISOString();j.updatedAt=j.finishedAt;delete j.lease;
 const changes={'project.json':staged.project,['jobs/'+j.id+'/job.json']:j};await advanceUndo(work,changes,j.assetId||'legacy',beforeUndo);await commitWorkspace(work,changes);return clean(j);
});}

export async function failJob(work,id,{lease,error,state='failed'}={}){return withWorkspaceLock(work,async()=>{
 await reconcileExecutions(work,{id});const j=await rawJob(work,id);if(j.state!=='running'||lease!==j.lease)throw Error('任务状态或执行租约不匹配');if(!['failed','needs-input','interrupted'].includes(state))throw Error('无效失败状态');
 j.error=text(error,'错误或问题');event(j,state,j.error);j.finishedAt=new Date().toISOString();if(state==='interrupted')j.interruptedAt=j.finishedAt;delete j.lease;await saveJob(work,j);return clean(j);
});}
export async function cancelJob(work,id){return withWorkspaceLock(work,async()=>{
 const j=await rawJob(work,id);if(finalStates.has(j.state))throw Error('已结束的任务不能取消');event(j,'cancelled','用户停止了此任务');j.finishedAt=new Date().toISOString();delete j.lease;await saveJob(work,j);return clean(j);
});}

export async function replyJob(work,id,{message}={}){return withWorkspaceLock(work,async()=>{
 const j=await rawJob(work,id);if(j.state!=='needs-input')throw Error('只有等待补充的任务可以继续');
 const reply=text(message,'补充说明',12000);
 if(!await verifyInputs(work,j)){event(j,'stale','素材版本已变化，请在当前版本重新提出修改');await saveJob(work,j);throw Error('任务已过期，未继续旧版本修改');}
 const drift=await contextDrift(work,j);if(drift.status==='changed'){j.contextDrift=drift;event(j,'stale','等待补充期间关联制作源或代码已变化，请基于当前资料重新提交');await saveJob(work,j);throw Error('项目上下文已变化，补充说明未替换原任务制作源');}
 const entry={message:reply,at:new Date().toISOString()};(j.clarifications??=[]).push(entry);
 await freezeTaskContext(work,j);
 const contextPath=await inside(work,'jobs/'+j.id+'/context.json'),context=await json(contextPath);context.clarifications=j.clarifications;context.projectContextFile=j.projectContextFile;context.projectContextSha256=j.projectContextSha256;
 delete j.error;delete j.finishedAt;event(j,'queued','已收到补充说明，等待 Agent 继续处理');j.updatedAt=new Date().toISOString();await commitWorkspace(work,{['jobs/'+j.id+'/context.json']:context,[j.taskFile]:makeTask(j,work),['jobs/'+j.id+'/job.json']:j});return clean(j);
});}

async function restoreReviewAsset(work,cfg,assetId,source){
 const bytes=await readFile(await inside(work,source.file));if(sha(bytes)!==source.sha256)throw Error('版本内容已变化，未恢复');
 const project=structuredClone(cfg),asset={...structuredClone(source),assetId};project.models[assetId].headRevision=(project.models[assetId].headRevision||0)+1;
 setModelSlots(project,assetId,{...modelSlots(project,assetId),candidate:asset});return {project,asset};
}
const reviewOwner=asset=>asset?.derivedByJobId||asset?.source?.derivedByJobId;
const sameReviewAsset=(left,right)=>left?.sha256===right?.sha256&&reviewOwner(left)===reviewOwner(right);
export async function reviewJob(work,id,{decision,outcome='',decisionId}={},internal={}){return withWorkspaceLock(work,async()=>{
 const j=await rawJob(work,id);if(j.state!=='complete')throw Error('尚无完成的候选');if(!['accept-candidate','keep-baseline','revise'].includes(decision))throw Error('无效评审决定');
 if(decisionId){jobId(decisionId);const prior=j.reviews?.find(r=>r.id===decisionId);if(prior){if(prior.decision!==decision||prior.outcome!==String(outcome).slice(0,8000))throw Error('相同决定 ID 不能用于不同评审');return clean(j);}}
 if(decision==='accept-candidate'){
  if(j.lockOtherClips&&j.candidateDiff?.protection!=='verified')throw Error(j.candidateDiff?.protection==='violated'?'候选改动了锁定的其他动作，不能采用这版。':'锁定的其他动作尚未验证，不能采用这版。');
  const d=await contextDrift(work,j);if(d.status==='changed')throw Error('关联制作源或代码已变化，请重新核验后再接受候选');
 }
 const cfgBefore=await readProject(work),assetId=j.assetId||cfgBefore.legacyAssetId;
 await assertModelAvailable(work,assetId);
 const headsBefore=modelSlots(cfgBefore,assetId),beforeGuard=await undoGuard(work,assetId),priorDecision=j.reviews?.at(-1)?.decision||'revise';
 const currentCandidate=headsBefore.candidate,owner=reviewOwner(currentCandidate);
 const ownsCandidate=currentCandidate?.sha256===j.candidate.sha256&&(!owner||owner===j.id);
 const sameBaseline=headsBefore.baseline?.sha256===j.inputs.baseline?.sha256;
 const ownsHead=sameBaseline&&(ownsCandidate||j.restoredSource&&sameReviewAsset(currentCandidate,j.restoredSource));
 const beforeAsset=ownsHead&&decision==='accept-candidate'&&priorDecision!=='accept-candidate'?j.inputs[j.slot]:headsBefore.candidate;
 delete j.restoredSource;
 const r={id:decisionId||randomUUID(),decision,outcome:String(outcome).slice(0,8000),assets:{baseline:j.inputs[j.slot],candidate:j.candidate,original:j.inputs.baseline},at:new Date().toISOString(),projectContextFile:j.projectContextFile||null};
 if(internal.recovery)r.recovery=internal.recovery;
 r.recordFile='decisions/'+r.id+'.json';const changes={};
 if(decision==='accept-candidate'){r.checkpointFile='checkpoints/'+r.id+'.json';changes[r.checkpointFile]={version:1,id:r.id,jobId:j.id,assetId:j.assetId||'legacy',status:'user-accepted-preview',installed:false,clip:j.clip,scope:j.scope,asset:j.candidate,source:j.inputs[j.slot],projectContextFile:j.projectContextFile||null,outcome:r.outcome,acceptedAt:r.at};}
 if(decision==='keep-baseline'){
  if(ownsCandidate&&sameBaseline){
   const source=j.inputs[j.slot],bytes=await readFile(await inside(work,source.file));if(sha(bytes)!==source.sha256)throw Error('本轮修改前的版本已损坏，未回退');
   const staged=await restoreReviewAsset(work,cfgBefore,assetId,source);
   j.restoredSource=staged.asset;changes['project.json']=staged.project;
  }
 }
 const restore=internal.restoreAsset||(decision==='accept-candidate'&&ownsHead?j.candidate:null);
 if(restore&&!sameReviewAsset(modelSlots(changes['project.json']||cfgBefore,assetId).candidate,restore)){const staged=await restoreReviewAsset(work,changes['project.json']||cfgBefore,assetId,restore);changes['project.json']=staged.project;if(!sameReviewAsset(restore,j.candidate))j.restoredSource=staged.asset;}
 changes[r.recordFile]={version:1,jobId:j.id,assetId:j.assetId||'legacy',...r};
 (j.reviews??=[]).push(r);j.artisticDecision=decision;j.updatedAt=new Date().toISOString();changes['jobs/'+j.id+'/job.json']=j;
 if(internal.finish)await internal.finish(changes);
 else if(['accept-candidate','keep-baseline'].includes(decision))await appendUndo(work,changes,{assetId,beforeGuard,kind:'review',jobId:j.id,label:decision==='accept-candidate'?'采用这版':'不用这版',before:{decision:priorDecision,asset:beforeAsset},after:{decision,asset:modelSlots(changes['project.json']||cfgBefore,assetId).candidate}});
 await commitWorkspace(work,changes);return clean(j);
});}

export async function localEditJob(work,id,{bone,factor=.7,offset,start,end}={}){
 const existing=await getJob(work,id),claim=await claimJob(work,id,{owner:'local-quaternion-tool'});
 try{
  const {editGlb}=await import('./asset-tools.mjs'),source=existing.inputs[existing.slot];const bytes=await readFile(await inside(work,source.file));
  await updateJobProgress(work,id,{lease:claim.lease,phase:'reading',message:'检查选中骨骼的动画曲线与时间范围。',source:'system'});
  const inspector=(await import('./asset-tools.mjs')).inspectAsset(bytes);const selected=existing.target.nodeIndex!==undefined?inspector.bones.find(b=>b.nodeIndex===existing.target.nodeIndex)?.nodeIndex:undefined;if(existing.target.nodeIndex!==undefined&&selected===undefined)throw Error('所选节点不属于此版本的可编辑骨架，未改用同名骨骼');
  await updateJobProgress(work,id,{lease:claim.lease,phase:'editing',message:'应用指定的局部旋转调整。',source:'system'});
  const range=existing.scope.wholeClip?{}:{start:offset?existing.scope.start:start??existing.scope.start,end:offset?existing.scope.end:end??existing.scope.end};
  const result=editGlb(bytes,{clip:existing.clip,bone:selected??bone??existing.target.bone,factor:Number(factor),offset,...range});
  if(!result.report.changedKeyframes)throw Error('本次参数没有改变关键帧；请选择有摆动的骨骼和有效范围');
  await updateJobProgress(work,id,{lease:claim.lease,phase:'checking',message:'检查关键帧变化和保护范围，准备独立候选。',source:'system'});
  const path=await inside(work,'jobs/'+id+'/local-candidate.glb');await atomic(path,result.bytes);await atomic(await inside(work,'jobs/'+id+'/local-audit.json'),result.report);
  const report=result.report,change=offset?'绕自身 '+report.axis.toUpperCase()+' 轴旋转 '+report.degrees+'°':'摆幅调整为原来的 '+Math.round(report.factor*100)+'%';
  const summary=report.bone+'在'+(existing.scope.wholeClip?'整个动作':'所选区间')+change+'。';
  return await completeJob(work,id,{lease:claim.lease,candidatePath:path,summary,audit:report});
 }catch(e){const current=await getJob(work,id);if(current.state==='running')await failJob(work,id,{lease:claim.lease,error:e.message});throw e;}
}
export async function importFile(work,slot,path,{label,fps,...options}={}){
 const sourcePath=resolve(path),sourceStat=await stat(sourcePath),signature=s=>[s.size,s.mtimeMs,s.ctimeMs,s.ino,s.dev].join(':'),sourceSignature=signature(sourceStat),bytes=await readFile(sourcePath),name=label||basename(sourcePath),link=await getProjectLink(work),rel=link?relative(link.root,sourcePath):null,ownRel=relative(resolve(work),sourcePath),owned=ownRel!== '..'&&!ownRel.startsWith('..'+sep)&&!isAbsolute(ownRel),provenance=!owned&&rel&&!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)?{projectRelativePath:rel.split(sep).join('/')}:{};
 if(signature(await stat(sourcePath))!==sourceSignature)throw Error('读取期间源文件发生变化，请重新导入');
 if(name.toLowerCase().endsWith('.json'))return importCurveBytes(work,slot,bytes,name,{...options,provenance});
 if(!name.toLowerCase().endsWith('.fbx'))return importAsset(work,slot,bytes,name,{...options,source:{...provenance,previewSha256:sha(bytes),format:'glb',originalName:basename(sourcePath),sha256:sha(bytes),timeMapping:'glTF seconds; authored FPS/start frame unknown unless supplied'}});
 const file='sources/'+sha(bytes)+'.fbx';await atomic(await inside(work,file),bytes);
 const {convertFbx}=await import('./asset-tools.mjs');const result=await convertFbx(sourcePath,await inside(work,'conversions/'+randomUUID()),{...(fps===undefined?{}:{fps})});
 if(result.source.sha256!==sha(bytes)||signature(await stat(sourcePath))!==sourceSignature)throw Error('转换期间原始 FBX 发生变化，未替换当前版本');
 const dependencies=[];
 for(const image of result.report.externalImages||[]){
  const imagePath=provenance.projectRelativePath?await inside(link.root,relative(link.root,image.path)):image.path;
  if(sha(await readFile(imagePath))!==image.sha256)throw Error('转换期间贴图发生变化，未替换当前版本');
  if(provenance.projectRelativePath)dependencies.push({projectRelativePath:relative(link.root,imagePath).split(sep).join('/'),sha256:image.sha256});
 }
 const converted=await readFile(result.glbPath);
 return withWorkspaceLock(work,async()=>{
  if(sha(await readFile(sourcePath))!==sha(bytes)||signature(await stat(sourcePath))!==sourceSignature)throw Error('等待提交期间原始 FBX 发生变化，未替换当前版本');
  for(const image of result.report.externalImages||[])if(sha(await readFile(provenance.projectRelativePath?await inside(link.root,relative(link.root,image.path)):image.path))!==image.sha256)throw Error('等待提交期间贴图发生变化，未替换当前版本');
  return importAsset(work,slot,converted,name,{...options,locked:true,source:{...result.source,...provenance,dependencies,dependencyKind:'consumed-images-v1',previewSha256:sha(converted),file,format:'fbx',originalName:name,conversionReport:result.report}});
 });
}
async function importCurveBytes(work,slot,bytes,name,{provenance={},...options}={}){
 if(bytes.length>50*1024*1024)throw Error('采样动作 JSON 超过 50 MB');
 const preview=createCurveResource(bytes),file='sources/'+sha(bytes)+'.json';await atomic(await inside(work,file),bytes);
 return importAsset(work,slot,preview,name,{...options,source:{...provenance,format:'sampled-tracks-v1',sha256:sha(bytes),previewSha256:sha(preview),file,originalName:name}});
}
export async function importBytes(work,slot,bytes,name='model.glb',options={}){
 if(name.toLowerCase().endsWith('.json'))return importCurveBytes(work,slot,bytes,name,options);
 if(!name.toLowerCase().endsWith('.fbx'))return importAsset(work,slot,bytes,name,options);
 const dir=await inside(work,'incoming');await mkdir(dir,{recursive:true});const path=resolve(dir,sha(bytes)+'.fbx');await atomic(path,bytes);return importFile(work,slot,path,{label:name,...options});
}

export async function getJobProjectContext(work,id){return readTaskContext(work,await rawJob(work,id));}
export async function previewProjectContext(work,input={}){const cfg=await readProject(work),assetId=input.assetId||cfg.activeAssetId,heads=modelSlots(cfg,assetId);const slot=input.slot||'baseline';if(!['baseline','candidate'].includes(slot)||!heads[slot])throw Error('先选择角色版本');return assembleTaskContext(work,{...input,assetId,slot,clip:input.clip||heads[slot].clips?.[0]?.name||'',inputs:heads,source:heads[slot].source||null,request:String(input.request||''),context:input.context||{},target:input.target||{}},{preview:true});}
