import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {ROOT,atomic,json,importAsset,readProject,withWorkspaceLock} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {createExecution,executionHealth,HEARTBEAT_STALE_MS} from '../execution-runtime.mjs';
import {createJob,claimJob,getJob,listJobs,interruptJob,retryJob,cancelJob,failJob,completeJob,restoreJob,reviewJob,jobArtifacts} from '../jobs.mjs';
import {serve} from '../server.mjs';
import {callTool} from '../mcp.mjs';
const cli=join(ROOT,'scripts/motion-feedback.mjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+8000;while(Date.now()<end){const value=await fn();if(value)return value;await wait(25);}throw Error('condition did not become true');}
async function setup(run){const w=await mkdtemp(join(tmpdir(),'motion-lifecycle-'));try{
 await atomic(join(w,'project.json'),{version:2,slots:{}});await atomic(join(w,'feedback.json'),{version:1,notes:[]});await importAsset(w,'baseline',await buildDemo(false),'demo');
 const input=async(assetId)=>{const p=await readProject(w),id=assetId||p.activeAssetId,a=p.models[id].slots.baseline;return {assetId:id,request:'收小左臂',slot:'baseline',context:{assetId:id,asset:a,slot:'baseline',clip:'Run',time:.25}};};
 await run(w,input);
 }finally{await rm(w,{recursive:true,force:true});}}

test('one active task per model is atomic across concurrent submissions and needs-input; different models queue',()=>setup(async(w,input)=>{
 const payload=await input(),results=await Promise.allSettled([createJob(w,payload),createJob(w,payload)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/草稿尚未提交/);
 const j=results.find(r=>r.status==='fulfilled').value,c=await claimJob(w,j.id);await failJob(w,j.id,{lease:c.lease,state:'needs-input',error:'确认左侧'});await assert.rejects(createJob(w,payload),/等待补充/);
 await importAsset(w,'baseline',await buildDemo(false),'other',{newModel:true});const other=await createJob(w,await input());assert.notEqual(other.assetId,j.assetId);assert.equal(other.state,'queued');assert.equal((await listJobs(w)).length,2);
}));

test('CLI manual claim survives claiming process exit, supports explicit interruption and fenced retry through CLI/MCP',()=>setup(async(w,input)=>{
 const j=await createJob(w,await input()),result=spawnSync(process.execPath,[cli,'claim','--workspace',w,'--job',j.id],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const old=JSON.parse(result.stdout);assert.equal((await getJob(w,j.id)).state,'running');assert.equal(old.execution,undefined);
 await callTool(w,'motion_interrupt_job',{id:j.id});assert.equal((await getJob(w,j.id)).state,'interrupted');await callTool(w,'motion_retry_job',{id:j.id});const fresh=await claimJob(w,j.id);assert.notEqual(fresh.lease,old.lease);
 await assert.rejects(completeJob(w,j.id,{lease:old.lease,candidatePath:join(w,'none.glb'),summary:'late'}),/租约/);await assert.rejects(failJob(w,j.id,{lease:old.lease,error:'old failure'}),/租约/);
 await interruptJob(w,j.id);await cancelJob(w,j.id);assert.equal((await getJob(w,j.id)).state,'cancelled');
}));

test('independent heartbeat advances while workspace is locked and no business progress occurs; stale live host is observable',()=>setup(async(w,input)=>{
 const execution=await createExecution(w,{heartbeatMs:20});try{
 const j=await createJob(w,await input()),c=await claimJob(w,j.id,{execution:execution.record}),path=join(w,'executions',execution.record.id+'.json');const before=await json(path);
 await withWorkspaceLock(w,()=>wait(130));const after=await json(path);assert.notEqual(after.heartbeatAt,before.heartbeatAt);assert.equal((await getJob(w,j.id)).lastActivityAt,c.lastActivityAt);assert.equal((await executionHealth(w,execution.record)).status,'alive');
 // Stop periodic updates by ending it, then emulate a persisted active record after an extended host pause.
 await execution.close();await atomic(path,{...after,status:'active',heartbeatAt:new Date(Date.now()-HEARTBEAT_STALE_MS-1000).toISOString()});
 const paused=await getJob(w,j.id);assert.equal(paused.state,'running');assert.equal(paused.executionHealth.status,'unresponsive');assert.equal((await executionHealth(w,{...execution.record,processStart:'previous-process-start'})).status,'dead','a reused live PID must not revive an old executor');await interruptJob(w,j.id);
 }finally{await execution.close();}
}));

test('a killed automatic worker is recovered on server restart, preserves output, does not retry itself, and rejects its old lease',()=>setup(async(w,input)=>{
 const fake=join(w,'codex.cjs');await writeFile(fake,`const fs=require('node:fs');if(process.argv[2]==='--version'){console.log('test');process.exit(0)}process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync('partial.txt','preserved');setInterval(()=>{},1000)});`);
 const j=await createJob(w,await input()),child=spawn(process.execPath,[cli,'worker','--workspace',w,'--once'],{env:{...process.env,CODEX_EXECUTABLE:fake},stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);
 let server;try{
 const running=await until(async()=>{const row=await getJob(w,j.id,{raw:true});return row.state==='running'&&row.outputDirectory&&await readFile(join(w,row.outputDirectory,'partial.txt'),'utf8').catch(()=>null)?row:null;});
 child.kill('SIGKILL');await once(child,'exit');server=await serve(w,0);const url='http://127.0.0.1:'+server.address().port;
 const recovered=await getJob(w,j.id);assert.equal(recovered.state,'interrupted');assert.equal((await jobArtifacts(w,j.id)).files.some(f=>f.file.endsWith('/partial.txt')),true);
 assert.equal((await fetch(url+'/api/jobs/'+j.id+'/artifacts?file='+encodeURIComponent(running.outputDirectory+'/partial.txt'))).status,200);
 const session=await (await fetch(url+'/api/session')).json(),post=path=>fetch(url+path,{method:'POST',headers:{'x-motion-token':session.token},body:'{}'});
 assert.equal((await post('/api/jobs/'+j.id+'/retry')).status,200);const newClaim=await claimJob(w,j.id);assert.notEqual(newClaim.lease,running.lease);await assert.rejects(completeJob(w,j.id,{lease:running.lease,candidatePath:join(w,'none.glb'),summary:'late'}),/租约/);
 assert.equal(await readFile(join(w,running.outputDirectory,'partial.txt'),'utf8'),'preserved');await cancelJob(w,j.id);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}if(server)await new Promise(r=>server.close(r));}
}));

test('retry retains original version checks and cannot bypass another active task',()=>setup(async(w,input)=>{
 const payload=await input(),j=await createJob(w,payload),c=await claimJob(w,j.id);await interruptJob(w,j.id);const next=await createJob(w,payload);await assert.rejects(retryJob(w,j.id),/已有/);await cancelJob(w,next.id);
 await importAsset(w,'candidate',await buildDemo(true),'new');await assert.rejects(retryJob(w,j.id),/过期/);assert.equal((await getJob(w,j.id)).state,'stale');await assert.rejects(failJob(w,j.id,{lease:c.lease,error:'late'}),/租约/);
}));

test('accepted checkpoint restore is explicit, revision guarded, model scoped and exposed over HTTP/MCP',()=>setup(async(w,input)=>{
 const j=await createJob(w,await input()),c=await claimJob(w,j.id),file=join(w,'candidate.glb');await writeFile(file,await buildDemo(true));const done=await completeJob(w,j.id,{lease:c.lease,candidatePath:file,summary:'changed'});const accepted=await reviewJob(w,j.id,{decision:'accept-candidate',outcome:'认可'}),checkpointId=accepted.reviews.at(-1).id;
 await importAsset(w,'candidate',await buildDemo(false),'later');const before=await readProject(w),baseline=before.slots.baseline.sha256;
 await assert.rejects(restoreJob(w,j.id,{checkpointId,expectedRevision:before.revision-1}),/版本已变化/);
 const blocker=await createJob(w,await input());await assert.rejects(restoreJob(w,j.id,{checkpointId,expectedRevision:before.revision}),/已有/);await cancelJob(w,blocker.id);
 const restored=await callTool(w,'motion_restore_checkpoint',{id:j.id,checkpointId,expectedRevision:before.revision});assert.equal(restored.project.slots.candidate.sha256,done.candidate.sha256);assert.equal(restored.project.slots.baseline.sha256,baseline);assert.equal(restored.job.restores.length,1);assert.equal((await json(join(w,'checkpoints',checkpointId+'.json'))).installed,false);
 let server;try{server=await serve(w,0);const url='http://127.0.0.1:'+server.address().port,s=await (await fetch(url+'/api/session')).json();const response=await fetch(url+'/api/jobs/'+j.id+'/restore',{method:'POST',headers:{'x-motion-token':s.token},body:JSON.stringify({checkpointId,expectedRevision:restored.project.revision})});assert.equal(response.status,200);assert.equal((await response.json()).job.restores.length,2);await reviewJob(w,j.id,{decision:'revise',outcome:'后来发现问题'});await assert.rejects(restoreJob(w,j.id,{checkpointId,expectedRevision:(await readProject(w)).revision}),/后续已有/);}finally{if(server)await new Promise(r=>server.close(r));}
}));

test('legacy same-model queued jobs cannot run concurrently, including manual claims',()=>setup(async(w,input)=>{
 const first=await createJob(w,await input());const {randomUUID}=await import('node:crypto'),duplicate={...await getJob(w,first.id,{raw:true}),id:randomUUID()};await mkdir(join(w,'jobs',duplicate.id));await atomic(join(w,'jobs',duplicate.id,'job.json'),duplicate);
 const results=await Promise.allSettled([claimJob(w,first.id),claimJob(w,duplicate.id)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const winner=results.find(r=>r.status==='fulfilled').value,loser=winner.id===first.id?duplicate:first;
 const err=results.find(r=>r.status==='rejected').reason;assert.equal(err.code,'MODEL_JOB_ACTIVE');assert.equal(err.jobId,winner.id);
 await failJob(w,winner.id,{lease:winner.lease,state:'needs-input',error:'need detail'});await assert.rejects(claimJob(w,loser.id),/另一任务/);await cancelJob(w,winner.id);assert.equal((await claimJob(w,loser.id)).state,'running');
}));

test('artifact endpoint excludes lease-bearing job metadata and paths outside the owning output directory',()=>setup(async(w,input)=>{
 const j=await createJob(w,await input());await claimJob(w,j.id);const artifacts=await jobArtifacts(w,j.id);assert.equal(artifacts.files.some(f=>f.file.endsWith('/job.json')),false);assert.equal(artifacts.files.some(f=>f.file.endsWith('/context.json')),false);
}));

test('simultaneous server connections share one probe and worker; disconnect during probe cancels pending connection',()=>setup(async(w)=>{
 let probes=0,starts=0,finishProbe;const agentWorker={probeCodex:()=>{probes++;return new Promise(r=>finishProbe=r);},startWorker:async(_,{signal})=>{starts++;if(!signal.aborted)await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}};
 const server=await serve(w,0,{agentWorker}),url='http://127.0.0.1:'+server.address().port,s=await (await fetch(url+'/api/session')).json(),post=path=>fetch(url+path,{method:'POST',headers:{'x-motion-token':s.token},body:JSON.stringify({provider:'codex'})});
 try{
  const a=post('/api/agent/connect'),b=post('/api/agent/connect');await until(()=>probes===1);await wait(30);assert.equal(probes,1);finishProbe({available:true});await Promise.all([a,b]);assert.equal(starts,1);await post('/api/agent/disconnect');
  const pending=post('/api/agent/connect');await until(()=>probes===2);await post('/api/agent/disconnect');finishProbe({available:true});assert.equal((await (await pending).json()).connected,false);await wait(30);assert.equal(starts,1);
 }finally{await new Promise(r=>server.close(r));}
}));

test('client switching preserves a busy worker and waits for an idle worker to exit before starting the new one',()=>setup(async(w,input)=>{
 const workers=[],events=[];
 let finishProbe;
 const agentWorker={
  probeCodex:async()=>({available:true}),
  startWorker:async(_,{signal,provider,onState})=>{
   events.push('start '+provider);
   workers.push({signal,onState});
   if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
   await wait(25);
   events.push('exit '+provider);
  },
 };
 const server=await serve(w,0,{agentWorker,probeProvider:()=>new Promise(resolve=>{finishProbe=resolve;})});
 const url='http://127.0.0.1:'+server.address().port;
 const session=await (await fetch(url+'/api/session')).json();
 const connect=provider=>fetch(url+'/api/agent/connect',{method:'POST',headers:{'x-motion-token':session.token},body:JSON.stringify({provider})});
 try{
  assert.equal((await connect('codex')).status,200);
  const [old]=await until(()=>workers.length&&workers);
  const queued=await createJob(w,{...await input(),delivery:'worker',provider:'claude'});
  old.onState({state:'running',jobId:'old-task'});
  const busy=await connect('claude');
  assert.equal(busy.status,409);
  assert.equal((await busy.json()).code,'AGENT_BUSY');
  assert.equal(finishProbe,undefined);
  old.onState({state:'connected',jobId:null});

  const racing=connect('claude');
  await until(()=>finishProbe);
  old.onState({state:'claiming'});
  finishProbe({available:true});
  assert.equal((await racing).status,409);
  assert.equal(old.signal.aborted,false);
  assert.equal((await getJob(w,queued.id)).state,'queued');
  old.onState({state:'connected'});

  finishProbe=null;
  const unavailable=connect('claude');
  await until(()=>finishProbe);
  finishProbe({available:false,error:'test unavailable'});
  assert.equal((await unavailable).status,400);
  assert.equal(old.signal.aborted,false);
  finishProbe=null;
  const switching=connect('claude');
  await until(()=>finishProbe);
  finishProbe({available:true});
  const switched=await switching;
  assert.equal(switched.status,200);
  assert.equal((await switched.json()).provider,'claude');
  await until(()=>workers.length===2);
  assert.deepEqual(events,['start codex','exit codex','start claude']);
 }finally{await new Promise(resolve=>server.close(resolve));}
}));

test('ended execution is fenced at completion without a preceding recovery read',()=>setup(async(w,input)=>{
 const execution=await createExecution(w),j=await createJob(w,await input()),claim=await claimJob(w,j.id,{execution:execution.record});await execution.close();const file=join(w,'candidate.glb');await writeFile(file,await buildDemo(true));
 await assert.rejects(completeJob(w,j.id,{lease:claim.lease,candidatePath:file,summary:'late ended worker'}),/租约/);assert.equal((await getJob(w,j.id)).state,'interrupted');assert.equal((await readProject(w)).slots.candidate.sha256,j.inputs.candidate.sha256);
}));

test('checkpoint restore recovers one transaction after a real process exits between model and job publication',()=>setup(async(w,input)=>{
 const j=await createJob(w,await input()),c=await claimJob(w,j.id),file=join(w,'candidate.glb');await writeFile(file,await buildDemo(true));const done=await completeJob(w,j.id,{lease:c.lease,candidatePath:file,summary:'changed'});await reviewJob(w,j.id,{decision:'accept-candidate'});await importAsset(w,'candidate',await buildDemo(false),'later');const before=await readProject(w);
 const script=join(w,'restore-crash.mjs');await writeFile(script,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.promises.rename;fs.promises.rename=async(from,to)=>{if(to.endsWith(${JSON.stringify(join('jobs',j.id,'job.json'))}))process.exit(73);return rename(from,to);};syncBuiltinESMExports();const {restoreJob}=await import(${JSON.stringify(new URL('../jobs.mjs',import.meta.url).href)});await restoreJob(${JSON.stringify(w)},${JSON.stringify(j.id)},{expectedRevision:${before.revision}});`);
 const crashed=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(crashed.status,73,crashed.stderr);assert.ok(await readFile(join(w,'.motion-transaction.json')));
 const project=await readProject(w),recovered=await getJob(w,j.id);assert.equal(project.slots.candidate.sha256,done.candidate.sha256);assert.equal(recovered.restores.length,1);assert.equal(recovered.restores[0].asset.sha256,project.slots.candidate.sha256);await assert.rejects(readFile(join(w,'.motion-transaction.json')),{code:'ENOENT'});
}));
