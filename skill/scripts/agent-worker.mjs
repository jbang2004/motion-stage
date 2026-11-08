import {createDeepSeekEvents} from './deepseek-events.mjs';
import {probeProvider,providerCommand,providerInfo} from './agent-providers.mjs';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {ROOT,atomic,inside} from './core.mjs';
import {resolveExecutable,commandSpec,spawnOwnedProcess} from './platform-runtime.mjs';
import {createExecution} from './execution-runtime.mjs';
import {listQueuedJobSummaries} from './job-index.mjs';
import {recordProviderSession,claimJob,completeJob,failJob,getJob,updateJobProgress,updateJobActivity,interruptJob,reconcileExecutions} from './jobs.mjs';

export async function probeCodex(){
 let executable,launch;
 try{executable=await resolveExecutable('codex',{explicit:process.env.CODEX_EXECUTABLE});launch=await commandSpec(executable,['--version'],{kind:'codex'});}catch(e){return {available:false,error:e.message};}
 return new Promise(ok=>{let out='',ended=false;const done=v=>{if(!ended){ended=true;clearTimeout(timer);ok(v);}};
  const child=spawn(launch.command,launch.args,{stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
  const timer=setTimeout(()=>{child.kill();done({available:false,error:'Codex 检测超时，请在终端运行 codex --version。'});},8000);
  child.stdout.on('data',b=>out+=b);child.on('error',()=>done({available:false,error:'未找到 Codex CLI。安装并登录后，可重新连接；离线查看和本地微调仍可使用。'}));
  child.on('exit',code=>done(code===0?{available:true,version:out.trim(),executable}:{available:false,error:'Codex CLI 无法启动，请在终端检查登录和安装状态。'}));
 });
}
const sleep=(ms,signal)=>new Promise(r=>{if(signal?.aborted)return r();const t=setTimeout(end,ms);function end(){clearTimeout(t);signal?.removeEventListener('abort',end);r();}signal?.addEventListener('abort',end,{once:true});});
const schema={type:'object',additionalProperties:false,required:['status','summary','candidate','reason'],properties:{status:{type:'string',enum:['complete','needs-input']},summary:{type:'string'},candidate:{type:'string'},reason:{type:'string'}}};
const visibleText=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,500);

async function runAgent(work,job,{signal,onState,timeoutMs=600000,provider='codex'}={}){
 const dir=await inside(work,job.outputDirectory||`jobs/${job.id}/agent-output`);await mkdir(dir,{recursive:true});
 const schemaPath=join(dir,'result.schema.json'),resultPath=join(dir,'result.json'),progressPath=join(dir,'progress.json');await atomic(schemaPath,schema);
 const lease=job.lease?.token||job.lease;
 const source=job.inputs?.[job.slot||job.context?.slot||'baseline']||job.asset;
 if(!source?.file)throw Error('任务缺少固定的输入模型；请重新提交。');
 const sourcePath=await inside(work,source.file),taskPath=await inside(work,job.taskFile||`jobs/${job.id}/task.md`);
 const prompt=[
 'Use the motion-stage skill to complete this one explicit animation/model feedback task.',
 `Read the skill at ${join(ROOT,'SKILL.md')}, and the immutable task at ${taskPath}. Historical documents may retain old absolute paths after a move; use the current frozen input path in this prompt and relative file references in the current workspace.`,
 `Your frozen input GLB is ${sourcePath}. The task version is ${source.sha256}.`,
 `Your writable output directory is ${dir}. Write a new self-contained ${source.clips?.length?'animated ':''}GLB named candidate.glb here. ${source.clips?.length?'Preserve the required clips.':'This input is static: do not invent a skeleton or animation unless the task explicitly requires one.'}`,
 ...(job.projectContextFile?[`Read the frozen project/context packet at ${await inside(work,job.projectContextFile)} and its explanation at ${await inside(work,job.projectContextMarkdown)}. Follow the selected source SHA and parent lineage. Preserve carried user requirements and accepted properties; completed historical goals are background, do not apply them again. Project code/source/history entries include evidence and confidence: candidate links need verification. Do not use another character's history. If a new request clearly changes an old requirement, explain it; if materially ambiguous ask for clarification. Validate inherited requirements and state any unverified parts in audit.json. Project source files are read-only; put code patches, native edits and all candidates in this task output directory for review.`]:[]),
 'Read context.json beside task.md, including asset identities, exact clip seconds, view and selection. Read any user clarifications in task.md/context.json. Interpret free text as the user goal; preserve the task scope and invariants.',
 `At meaningful execution transitions, overwrite ${progressPath} with a JSON object {"phase":"reading|editing|checking|exporting","message":"one concise user-facing Chinese sentence about what you are actually doing"}. Use exactly one phase value. Report reading while inspecting sources, editing while making changes, checking while actually validating, exporting when preparing the deliverable. You may return to editing after a failed check. Do not invent percentages, completed checks or a time estimate. Do not write reasoning, raw commands or secrets into this file. This file is displayed live to the user.`,
 `For inspection or a strictly appropriate explicit swing-amplitude edit, import inspectAsset/editGlb from ${join(ROOT,'scripts/asset-tools.mjs')} in a Node script. Read that module's API before use. These are data tools, not automatic artistic fixes.`,
 source.capabilities?.preview==='curves'?'This input is an inspection GLB envelope for sampled curves, not a character. Inspect extras.motionStudio (resource sampled-tracks-v1), with SCALAR float accessors for times and flattened values. Keep its schema, clip names, durations and untouched tracks. Do not invent nodes, a skeleton or a body. Frozen raw JSON provenance is upstream; return an edited self-contained envelope GLB.':'Use the actual authored hierarchy for skeleton/node resources; never infer skin deformation from a meshless preview.',
 'Use the smallest appropriate authoring tool. Direct GLB curve edits do not require Blender; use Blender when native-source editing, baking or conversion actually needs it. Do not train a model or use paid external generation. Do not overwrite any input, production game, tool source or installed skill. Do not start other agents. Do not change unrelated animations, topology, skin, materials or timing unless explicitly required.',
 'Use lightweight verification: check the requested change and relevant preserved data at the captured pose, meaningful extrema and scope/loop boundaries. Choose samples for this task; routine curve edits do not need a dense full-clip sweep. The parent completion code checks the GLB container, embedded data ranges, readable finite float values, animation structure/times and required clip names, plus current input identity. Do not duplicate these checks or claim they prove naturalness or collision-free continuous motion.',
 'Reuse the studio for user playback/comparison. Do not build a separate renderer, export comparison videos, launch a browser or external player, or try an independent importer just for routine verification. Deeper verification is warranted only by this task\'s actual export/bake risk or an explicit user request. Record optional verification failures and limitations. Retry at most once only for a diagnosed transient failure with a concrete correction. Missing tools, denied access or unsupported formats end that optional path; do not build an alternative verification pipeline. Finish with the ready candidate and state unchecked scope. A tool required to author the requested repair is not optional.',
 'When legs, arms or rotation curves change, run motion-feedback.mjs motion-check with --baseline-file set to the frozen input GLB above, --file set to your candidate, and --clip set to the frozen task clip. This reads files without taking a workspace write lock in the worker sandbox. Investigate new and worsened warnings; missing coverage is unverified. Put the returned report in audit.motionChecks.',
 'Write a short audit.json object with actual task-specific checks, sampled times and limitations when feasible. This optional report is not a completion gate. Once the candidate and task-specific checks are ready, return the final JSON immediately. Never return an unfinished or copied original as an improved candidate.',
 'If authoring needs an unavailable source/tool, incompatible skeleton mapping, clarification or unsupported transformation, return needs-input and explain it instead of inventing success. An unavailable optional playback or verification tool alone is not a reason for needs-input.',
 'Return the required JSON: status, summary, candidate (candidate.glb only if actually created), reason (empty on success). The parent worker handles version validation and installation into the candidate slot; do not do that yourself.',
 ...(provider==='deepseek'?[`The final reply must be ONLY a JSON object matching ${JSON.stringify(schema)}. Do not include prose outside JSON. Your task is already claimed by the parent worker: do not claim, complete or modify workspace job metadata yourself.`]:[]),
 ].join('\n');
 await writeFile(join(dir,'prompt.txt'),prompt);
 await atomic(progressPath,{phase:'reading',message:'读取修改要求、观察截图与角色数据。'});
 const images=[];
 for(const ref of [job.screenshot,job.preview,job.context?.snapshot,job.evidence?.snapshot].filter(x=>typeof x==='string')){
  try{const p=await inside(work,ref);if((await stat(p)).isFile()&&/\.png$/i.test(p)){images.push(p);break;}}catch{}
 }
 const launch=await providerCommand(provider,{dir,schemaPath,resultPath,schema,images});let structuredResult,providerError='',deepseek;
 const executionStarted=Date.now(),initialProgress=await readFile(progressPath,'utf8');
 await new Promise((ok,no)=>{
  if(signal?.aborted)return no(Error('用户已断开 Agent，任务停止。'));
  const execution=spawnOwnedProcess(launch.command,launch.args,{cwd:dir,stdio:['pipe','pipe','pipe'],windowsHide:true}),child=execution.child;
  let finished=false,finishing=false,stderr='',buffer='',log='',timedOut=false,lastProgress=initialProgress,readingProgress=false,updates=Promise.resolve(),stopping=Promise.resolve();
  const enqueue=fn=>{updates=updates.then(fn).catch(()=>{});};
  const activity=message=>enqueue(async()=>{
   const j=await updateJobActivity(work,job.id,{lease,message});onState?.({state:'running',jobId:job.id,lastActivityAt:j.lastActivityAt,activity:j.activity});
  });
  if(provider==='deepseek')deepseek=createDeepSeekEvents({onSession:sessionId=>enqueue(()=>recordProviderSession(work,job.id,{lease,provider,sessionId})),onActivity:activity});
  const pullProgress=async()=>{
   if(readingProgress||finished)return;readingProgress=true;
   try{
    const file=await inside(work,(job.outputDirectory||`jobs/${job.id}/agent-output`)+'/progress.json');if((await stat(file)).size>4096)return;
    const raw=await readFile(file,'utf8');if(raw===lastProgress)return;
    const p=JSON.parse(raw);if(!p||typeof p!=='object')return;
    // The system seed is already skipped; subsequent file changes are explicit agent reports.
    const source='agent';
    await updateJobProgress(work,job.id,{lease,phase:p.phase,message:p.message,source});lastProgress=raw;
   }catch{}finally{readingProgress=false;}
  };
  const progressTimer=setInterval(()=>enqueue(pullProgress),500);
  enqueue(pullProgress);
  const abort=()=>{stopping=execution.stop().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;abort();},timeoutMs);
  child.once('commandExit',()=>clearTimeout(timer));
  const finish=async(code,error)=>{
   if(finished||finishing)return;finishing=true;
   clearInterval(progressTimer);clearTimeout(timer);signal?.removeEventListener('abort',abort);
   await stopping;
   if(buffer.trim()){try{receive(JSON.parse(buffer));}catch{}}buffer='';
   // Drain actual activity and the final stage report before any terminal job state.
   await updates;await pullProgress();finished=true;
   try{await writeFile(join(dir,'events.jsonl'),log);await writeFile(join(dir,'stderr.txt'),stderr);}catch(e){return no(Error('无法保存 Agent 执行日志：'+e.message));}
   if(signal?.aborted)return no(Error('用户已断开 Agent，任务停止。'));
   if(timedOut)return no(Error(providerInfo(provider).label+' 执行超时。任务现场已保存，可在任务列表中检查后重试。'));
   if(error||code!==0)return no(Error((deepseek?.error||stderr.trim()||error?.message||providerInfo(provider).label+' 执行失败，请检查登录、额度或任务输出。').slice(-1500)));
   ok();
  };
  const receive=e=>{
   if(deepseek){const safe=deepseek.receive(e);if(safe)log=(log+JSON.stringify(safe)+'\n').slice(-8*1024*1024);return;}
   if(provider==='claude'){if(e.type==='result'){if(e.is_error){providerError=visibleText(e.result||e.errors?.join(' '));stderr+='\n'+providerError;}else structuredResult=e.structured_output;}return;}
   if(e.type==='error')stderr+='\n'+(e.message||'Codex error');
   if(e.type==='turn.failed')stderr+='\n'+(e.error?.message||'Codex turn failed');
   const i=e.item;
   if(e.type==='turn.started')activity('Agent 已开始处理，正在理解修改要求。');
   if(e.type==='item.started'&&i?.type==='command_execution')activity('正在运行本地处理命令。');
   if(e.type==='item.completed'&&i?.type==='command_execution')activity(i.exit_code===0?'本地命令已完成，Agent 正在分析结果。':'本地命令返回问题，Agent 正在检查原因。');
   if(e.type==='item.started'&&i?.type==='mcp_tool_call')activity('正在调用制作工具。');
   if(e.type==='item.completed'&&i?.type==='mcp_tool_call')activity('制作工具已返回，Agent 正在检查结果。');
   // Only user-visible messages; reasoning and command/output bodies are never surfaced.
   if(e.type==='item.completed'&&i?.type==='agent_message'){
    const value=visibleText(i.text);if(value&&!value.startsWith('{'))activity(value);
   }
  };
  child.stdout.on('data',b=>{if(!deepseek)log=(log+b).slice(-8*1024*1024);buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{receive(JSON.parse(line));}catch{}}});
  child.stderr.on('data',b=>stderr=(stderr+b).slice(-64000));child.on('error',e=>finish(null,e));child.on('close',code=>{const result=execution.result;finish(result?result.code:code,result?.error?Error(result.error):null);});child.stdin.on('error',()=>{});child.stdin.end(prompt);
 });
 if(deepseek){structuredResult=deepseek.result();await atomic(resultPath,structuredResult);}
 if(provider==='claude'){if(!structuredResult)throw Error(providerError||'Claude Code 未返回有效结果，请检查任务日志中的登录、权限或执行错误');await atomic(resultPath,structuredResult);}
 let result;try{if((await stat(resultPath)).mtimeMs<executionStarted-100)throw Error('old result');result=JSON.parse(await readFile(resultPath,'utf8'));}catch{throw Error(providerInfo(provider).label+' 未返回有效的新结果；请查看保存的任务输出。');}
 if(!result||!['complete','needs-input'].includes(result.status))throw Error(providerInfo(provider).label+' 返回了无效的任务结果状态。');
 if(result.status==='needs-input')return{status:'needs-input',error:result.reason||result.summary||'需要补充信息'};
 if(result.candidate!=='candidate.glb')throw Error('Agent 返回了任务输出目录之外的候选，未载入。');
 const candidatePath=await inside(dir,'candidate.glb'),candidateStat=await stat(candidatePath);
 if(!candidateStat.isFile()||candidateStat.mtimeMs<executionStarted-100)throw Error(providerInfo(provider).label+' 未生成本次执行的新候选；旧文件保留但未载入。');
 let audit=null;
 try{
  const file=await inside(dir,'audit.json'),s=await stat(file);
  if(!s.isFile()||s.mtimeMs<executionStarted-100||s.size>512*1024)throw Error('invalid audit file');
  const value=JSON.parse(await readFile(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid audit');audit=value;
 }catch(e){if(e.code!=='ENOENT')audit={limitations:['可选检查报告无效或不属于本次执行，已忽略；候选仍须通过程序必要校验。']};}
 return {status:'complete',candidatePath,audit,summary:result.summary||'候选已生成，请在相同时间与镜头下评审。'};
}

export async function startWorker(work,{once=false,signal,pollMs=1000,onState,timeoutMs,provider='codex'}={}){
 await reconcileExecutions(work);const probe=provider==='codex'?await probeCodex():await probeProvider(provider);if(!probe.available)throw Error(probe.error);
 const instance=await createExecution(work);
 try{
 onState?.({state:'connected',provider});
 while(!signal?.aborted){
  await reconcileExecutions(work);const queued=await listQueuedJobSummaries(work);let next,claimed;
  for(const candidate of queued.filter(j=>(j.provider||'codex')===provider)){
   if(signal?.aborted)break;
   // Reserve the worker before the asynchronous claim so switching cannot interrupt it.
   onState?.({state:'claiming'});
   try{claimed=await claimJob(work,candidate.id,{owner:provider+'-cli',execution:instance.record});next=candidate;break;}
   catch{onState?.({state:'connected'});}
  }
  if(!claimed){if(once)break;await sleep(pollMs,signal);continue;}
  onState?.({state:'running',jobId:next.id,startedAt:claimed.claimedAt});
  const lease=claimed.lease?.token||claimed.lease;
  const runAbort=new AbortController(),forward=()=>runAbort.abort();signal?.addEventListener('abort',forward,{once:true});if(signal?.aborted)runAbort.abort();
  // Each state read takes the workspace lock. Keep at most one in flight and await it before
  // returning, so a stopped worker never touches the workspace afterwards.
  let checking=null;const check=setInterval(()=>{if(checking)return;checking=(async()=>{try{const j=await getJob(work,next.id,{raw:true});if(j.state!=='running'||j.lease!==lease)runAbort.abort();}catch{runAbort.abort();}})().finally(()=>{checking=null;});},750);
  try{
   const result=await runAgent(work,claimed,{signal:runAbort.signal,onState,timeoutMs,provider});
   if(runAbort.signal.aborted)throw Error('任务已停止，候选未载入。');
   if(result.status==='needs-input')await failJob(work,next.id,{lease,error:result.error,state:'needs-input'});
   else{
    await updateJobProgress(work,next.id,{lease,phase:'exporting',message:'核对输入版本，载入独立候选供你比较。',source:'system'});
    await completeJob(work,next.id,{lease,candidatePath:result.candidatePath,summary:result.summary,audit:result.audit});
   }
  }catch(e){
   try{const current=await getJob(work,next.id,{raw:true});if(current.state==='running'&&current.lease===lease){
    if(signal?.aborted)await interruptJob(work,next.id,{lease,reason:'执行宿主已断开；现场和产物已保留，可检查后重新执行。'});
    else await failJob(work,next.id,{lease,error:e.message,state:/login|auth|credential|sign.in|quota|limit|登录|额度|凭据/i.test(e.message)?'needs-input':/超时/.test(e.message)?'interrupted':'failed'});
   }}catch{}
  }finally{clearInterval(check);await checking;signal?.removeEventListener('abort',forward);onState?.({state:signal?.aborted?'disconnected':'connected',provider,jobId:null,activity:null,startedAt:null});}
  if(once)break;
 }
 }finally{await instance.close();await reconcileExecutions(work);}
}
