import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,atomic,json,importAsset} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import * as jobs from '../jobs.mjs';
import {startWorker} from '../agent-worker.mjs';

// Independent contract checks. The worker fixture is an offline executable;
// it tests observed events and lease handling, never model or artistic quality.
async function fixture(run){
 const work=await mkdtemp(join(tmpdir(),'motion-progress-'));
 try{
  await atomic(join(work,'project.json'),{version:2,title:'Independent progress QA',slots:{}});
  await atomic(join(work,'feedback.json'),{version:1,notes:[]});
  const base=await buildDemo(false);await importAsset(work,'baseline',base,'base.glb');await importAsset(work,'candidate',base,'base.glb');
  const create=async()=>{const p=await json(join(work,'project.json'));return jobs.createJob(work,{request:'缩小左臂摆动，保持腿与另一只手。',slot:'baseline',target:{bone:'LeftArm'},scope:{start:0,end:1,wholeClip:true},context:{asset:p.slots.baseline,slot:'baseline',clip:'Run',time:.25,fps:30}});};
  await run(work,create);
 }finally{await rm(work,{recursive:true,force:true});}
}
const stamp=value=>assert.ok(Number.isFinite(Date.parse(value)),'expected a server timestamp');
const jobBytes=(work,id)=>readFile(join(work,'jobs',id,'job.json'),'utf8');
async function rejectedWithoutMutation(work,id,fn){const before=await jobBytes(work,id);await assert.rejects(fn);assert.equal(await jobBytes(work,id),before);}

test('progress is durable, bounded, truthful about its phase and lease redacted',()=>fixture(async(work,create)=>{
 const job=await create();await rejectedWithoutMutation(work,job.id,()=>jobs.updateJobProgress(work,job.id,{lease:'unclaimed',phase:'editing',message:'not started'}));
 const claim=await jobs.claimJob(work,job.id,{owner:'independent-progress-test'});
 assert.equal(claim.progress.phase,'reading');assert.equal(claim.progress.source,'system');assert.equal(claim.progressEvents.length,1);stamp(claim.lastActivityAt);
 const beforeInputs=claim.inputs;
 let saved=await jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'editing',message:'  收小左臂曲线。  '});
 assert.equal(saved.state,'running');assert.deepEqual(saved.inputs,beforeInputs);assert.equal(saved.progress.message,'收小左臂曲线。');assert.equal(saved.progress.source,'agent');assert.equal('lease' in saved,false);assert.deepEqual(saved.progressEvents.at(-1),saved.progress);assert.equal(saved.lastActivityAt,saved.progress.at);stamp(saved.progress.at);
 for(const bad of [{phase:'complete'},{phase:'waiting'},{phase:'reading',message:''},{phase:'reading',message:'   '},{phase:'editing',message:'x'.repeat(501)},{phase:'editing',message:42},{phase:'editing',source:'timer'}]){
  await rejectedWithoutMutation(work,job.id,()=>jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'editing',message:'valid',...bad}));
 }
 await jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'checking',message:'x'.repeat(500),source:'system'});
 saved=await jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'editing',message:'检查后继续调整。'});
 assert.equal(saved.progress.phase,'editing','a real correction may return from checking to editing');
 for(let i=0;i<84;i++)saved=await jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'checking',message:'真实检查 '+i});
 assert.equal(saved.progressEvents.length,80);assert.equal(saved.progressEvents[0].message,'真实检查 4');assert.equal(saved.progressEvents.at(-1).message,'真实检查 83');
 assert.deepEqual((await jobs.getJob(work,job.id)).progress,saved.progress);
 assert.equal(Object.hasOwn(saved.progress,'percent'),false);assert.equal(Object.hasOwn(saved.progress,'percentage'),false);
}));

test('local activity does not invent a new work phase or leak the lease',()=>fixture(async(work,create)=>{
 const job=await create(),claim=await jobs.claimJob(work,job.id);await jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'editing',message:'调整左臂。'});
 const before=await jobs.getJob(work,job.id),saved=await jobs.updateJobActivity(work,job.id,{lease:claim.lease,message:'  正在运行本地处理命令  ',source:'agent'});
 assert.deepEqual(saved.progress,before.progress);assert.deepEqual(saved.progressEvents,before.progressEvents);
 assert.equal(saved.activity.message,'正在运行本地处理命令');assert.equal(saved.activity.source,'system');assert.equal(saved.lastActivityAt,saved.activity.at);stamp(saved.activity.at);assert.equal('lease' in saved,false);
 await rejectedWithoutMutation(work,job.id,()=>jobs.updateJobActivity(work,job.id,{lease:'old-lease',message:'late activity'}));
 await jobs.cancelJob(work,job.id);
 await rejectedWithoutMutation(work,job.id,()=>jobs.updateJobActivity(work,job.id,{lease:claim.lease,message:'cancelled process activity'}));
}));

test('all ended states reject late progress, and reclaim starts an honest new attempt',()=>fixture(async(work,create)=>{
 for(const state of ['cancelled','failed','needs-input','complete','stale']){
  const job=await create(),claim=await jobs.claimJob(work,job.id);
  await jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'editing',message:'只属于旧一轮的编辑。'});
  if(state==='cancelled')await jobs.cancelJob(work,job.id);
  if(['failed','needs-input'].includes(state))await jobs.failJob(work,job.id,{lease:claim.lease,state,error:'独立测试：需要确认角色自身左臂。'});
  if(['complete','stale'].includes(state)){
   const output=join(work,'candidate.glb');await writeFile(output,await buildDemo(true));
   if(state==='stale'){
    const p=await json(join(work,'project.json')),changed=await buildDemo(p.slots.candidate.sha256===p.slots.baseline.sha256);
    await importAsset(work,'candidate',changed,'new preview');
    await assert.rejects(jobs.completeJob(work,job.id,{lease:claim.lease,candidatePath:output,summary:'stale test output'}));
   }else{
    const done=await jobs.completeJob(work,job.id,{lease:claim.lease,candidatePath:output,summary:'技术候选已导出，等待用户审阅。'});
    assert.equal(done.artisticDecision,null);assert.equal(done.automaticArtisticApproval,false);
   }
  }
  assert.equal((await jobs.getJob(work,job.id)).state,state);
  for(const update of [()=>jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'exporting',message:'late phase'}),()=>jobs.updateJobActivity(work,job.id,{lease:claim.lease,message:'late command'})])await rejectedWithoutMutation(work,job.id,update);
  if(state==='needs-input'){
   const retry=await jobs.claimJob(work,job.id);assert.notEqual(retry.lease,claim.lease);assert.equal(retry.progressEvents.length,1);assert.equal(retry.progress.phase,'reading');assert.equal(retry.progress.source,'system');assert.equal(retry.progressEvents.some(e=>e.message.includes('旧一轮')),false);
   await rejectedWithoutMutation(work,job.id,()=>jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'editing',message:'old worker'}));await jobs.cancelJob(work,job.id);
  }
 }
}));

test('clarification replies update the actual frozen task, and reject a changed source',()=>fixture(async(work,create)=>{
 const job=await create(),claim=await jobs.claimJob(work,job.id);
 await rejectedWithoutMutation(work,job.id,()=>jobs.replyJob(work,job.id,{message:'running task cannot be replied to'}));
 await jobs.failJob(work,job.id,{lease:claim.lease,state:'needs-input',error:'这里的左臂是角色自身左侧吗？'});
 const originalTask=await readFile(join(work,job.taskFile),'utf8'),originalContext=await readFile(join(work,'jobs',job.id,'context.json'),'utf8'),originalJob=await jobBytes(work,job.id);
 const migrated=await mkdtemp(join(tmpdir(),'motion-progress-moved-'));
 try{
  await cp(work,migrated,{recursive:true});
  const migrationAnswer='迁移副本确认角色自身左臂；此答复只属于副本。';
  const movedReply=await jobs.replyJob(migrated,job.id,{message:migrationAnswer});
  assert.equal(movedReply.state,'queued');assert.notEqual(movedReply.taskPath,job.taskPath);
  assert.ok((await readFile(join(migrated,job.taskFile),'utf8')).includes(migrationAnswer));
  assert.ok(JSON.stringify(await json(join(migrated,'jobs',job.id,'context.json'))).includes(migrationAnswer));
  assert.equal(await readFile(join(work,job.taskFile),'utf8'),originalTask);
  assert.equal(await readFile(join(work,'jobs',job.id,'context.json'),'utf8'),originalContext);
  assert.equal(await jobBytes(work,job.id),originalJob,'replying to a copied workspace must not mutate the original job');
 }finally{await rm(migrated,{recursive:true,force:true});}
 const answer='确认角色自身左上臂，整个动作，保留右臂和脚步。',reply=await jobs.replyJob(work,job.id,{message:answer});
 assert.equal(reply.state,'queued');assert.equal(reply.request,job.request);assert.deepEqual(reply.inputs,job.inputs);assert.equal(reply.clarifications.at(-1).message,answer);stamp(reply.clarifications.at(-1).at);assert.equal('lease' in reply,false);
 assert.ok((await readFile(join(work,reply.taskFile),'utf8')).includes(answer));assert.ok(JSON.stringify(await json(join(work,'jobs',job.id,'context.json'))).includes(answer));
 const retry=await jobs.claimJob(work,job.id);assert.notEqual(retry.lease,claim.lease);await rejectedWithoutMutation(work,job.id,()=>jobs.updateJobProgress(work,job.id,{lease:claim.lease,phase:'editing',message:'old attempt'}));await jobs.cancelJob(work,job.id);
 const old=await create(),owned=await jobs.claimJob(work,old.id);await jobs.failJob(work,old.id,{lease:owned.lease,state:'needs-input',error:'确认范围'});await importAsset(work,'candidate',await buildDemo(true),'new source version');
 await assert.rejects(jobs.replyJob(work,old.id,{message:'不要把本答复应用到新版本'}));const stale=await jobs.getJob(work,old.id);assert.equal(stale.state,'stale');assert.equal((stale.clarifications||[]).length,0);
}));

test('CLI and real stdio MCP publish the same version-bound progress contract',()=>fixture(async(work,create)=>{
 const job=await create(),claim=await jobs.claimJob(work,job.id),cli=join(ROOT,'scripts/motion-feedback.mjs');
 const command=spawnSync(process.execPath,[cli,'progress','--workspace',work,'--job',job.id,'--lease',claim.lease,'--phase','editing','--message','CLI正在编辑左臂。'],{encoding:'utf8'});
 assert.equal(command.status,0,command.stderr);assert.equal(JSON.parse(command.stdout).progress.phase,'editing');
 const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'independent-progress-test',version:'1'}}},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'motion_report_progress',arguments:{id:job.id,lease:claim.lease,phase:'checking',message:'MCP正在核对腿和右手。'}}}];
 const response=spawnSync(process.execPath,[join(ROOT,'scripts/mcp.mjs'),'--workspace',work],{input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',encoding:'utf8'});
 assert.equal(response.status,0,response.stderr);const messages=response.stdout.trim().split('\n').map(JSON.parse);assert.ok(messages[1].result.tools.some(t=>t.name==='motion_report_progress'));assert.ok(messages[1].result.tools.some(t=>t.name==='motion_reply_job'));
 assert.equal(messages[2].result.isError,undefined);const saved=messages[2].result.structuredContent;assert.equal(saved.progress.phase,'checking');assert.equal(saved.progress.source,'agent');assert.equal('lease' in saved,false);
}));

async function until(check,message,timeout=6000){const end=Date.now()+timeout;while(Date.now()<end){const found=await check();if(found)return found;await new Promise(r=>setTimeout(r,30));}throw Error(message);}
test('offline worker reports real file phases and safe command activity, never late cancelled writes',()=>fixture(async(work,create)=>{
 const previous={CODEX_EXECUTABLE:process.env.CODEX_EXECUTABLE,MOTION_PROGRESS_TEST_DIR:process.env.MOTION_PROGRESS_TEST_DIR};let running,abort=new AbortController();
 try{
  const fake=join(work,'codex.cjs');await writeFile(fake,`
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('offline-progress-fixture');process.exit(0);}
const root=process.env.MOTION_PROGRESS_TEST_DIR;let seen=0,prompt='';
const emit=item=>process.stdout.write(JSON.stringify(item)+'\\n');
process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
 fs.writeFileSync(path.join(root,'fixture-ready'),'ready');emit({type:'turn.started'});
 setInterval(()=>{let c;try{c=JSON.parse(fs.readFileSync(path.join(root,'control.json'),'utf8'));}catch{return;}if(c.seq===seen)return;seen=c.seq;
 if(c.action==='phase'){fs.writeFileSync('progress.tmp',JSON.stringify({phase:c.phase,message:c.message}));fs.renameSync('progress.tmp','progress.json');}
 if(c.action==='started')emit({type:'item.started',item:{id:'cmd',type:'command_execution',command:'node /PRIVATE_RAW_COMMAND_SENTINEL.js',status:'in_progress'}});
 if(c.action==='completed'){emit({type:'item.completed',item:{id:'thought',type:'reasoning',text:'PRIVATE_REASONING_SENTINEL'}});emit({type:'item.completed',item:{id:'cmd',type:'command_execution',command:'PRIVATE_RAW_COMMAND_SENTINEL',aggregated_output:'PRIVATE_TOOL_OUTPUT_SENTINEL',exit_code:0,status:'completed'}});}
 if(c.action==='late'){fs.writeFileSync('progress.json',JSON.stringify({phase:'exporting',message:'LATE_CANCELLED_PHASE_SENTINEL'}));emit({type:'item.completed',item:{id:'late',type:'agent_message',text:'LATE_CANCELLED_ACTIVITY_SENTINEL'}});}
 },20);
});
`);process.env.CODEX_EXECUTABLE=fake;process.env.MOTION_PROGRESS_TEST_DIR=work;
  const job=await create(),previousClaim=await jobs.claimJob(work,job.id);
  await jobs.updateJobProgress(work,job.id,{lease:previousClaim.lease,phase:'exporting',message:'上轮导出阶段。'});
  await jobs.updateJobActivity(work,job.id,{lease:previousClaim.lease,message:'上轮活动，不应作为重试活动。'});
  await jobs.failJob(work,job.id,{lease:previousClaim.lease,state:'needs-input',error:'请确认左臂范围。'});
  await jobs.replyJob(work,job.id,{message:'确认整个行走周期的角色自身左上臂。'});
  await atomic(join(work,'jobs',job.id,'agent-output','progress.json'),{phase:'exporting',message:'STALE_PREVIOUS_ATTEMPT_SENTINEL'});
  running=startWorker(work,{once:true,signal:abort.signal,timeoutMs:12000});
  await until(async()=>{try{return await readFile(join(work,'fixture-ready'),'utf8');}catch{return false;}},'offline worker did not start');
  // Cross a progress-file polling interval: a retry must not replay the old file.
  await new Promise(r=>setTimeout(r,650));
  const restarted=await jobs.getJob(work,job.id);assert.equal(restarted.progress.phase,'reading');assert.doesNotMatch(JSON.stringify({progress:restarted.progress,history:restarted.progressEvents,activity:restarted.activity}),/STALE_PREVIOUS_ATTEMPT_SENTINEL|上轮活动|上轮导出阶段/);
  let seq=0;const control=body=>atomic(join(work,'control.json'),{seq:++seq,...body});
  await control({action:'phase',phase:'editing',message:'正在缩小左臂曲线。'});await until(async()=>{const j=await jobs.getJob(work,job.id);return j.progress?.phase==='editing'&&j;},'progress.json phase was not observed');
  const phase=structuredClone((await jobs.getJob(work,job.id)).progress);
  await control({action:'started'});await until(async()=>{const j=await jobs.getJob(work,job.id);return /正在运行本地处理命令/.test(j.activity?.message||'')&&j;},'command-start activity was not surfaced');
  await control({action:'completed'});const completed=await until(async()=>{const j=await jobs.getJob(work,job.id);return /本地命令已完成.*Agent\s*正在分析结果/.test(j.activity?.message||'')&&j;},'command completion activity was not surfaced');
  assert.deepEqual(completed.progress,phase,'command events must not invent editing/checking progress');assert.doesNotMatch(JSON.stringify(completed),/PRIVATE_(REASONING|RAW_COMMAND|TOOL_OUTPUT)_SENTINEL/);
  await jobs.cancelJob(work,job.id);const cancelled=await jobBytes(work,job.id);await control({action:'late'});await running;
  assert.equal(await jobBytes(work,job.id),cancelled,'a cancelled process must not append a phase, activity or result');
 }finally{
  abort.abort();if(running)await running.catch(()=>{});for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
}));
