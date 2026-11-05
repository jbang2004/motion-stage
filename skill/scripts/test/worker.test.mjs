import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomic,json,importAsset} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {createJob,getJob,cancelJob} from '../jobs.mjs';
import {startWorker} from '../agent-worker.mjs';

// A fake executable tests process/lease/result plumbing. It does not claim AI quality.
// The fake writes candidate bytes instead of copying: Windows CopyFile keeps the source mtime,
// and the worker correctly rejects a candidate older than the execution as stale.
async function fixture(mode,run){
 const w=await mkdtemp(join(tmpdir(),'motion-worker-'));const previous={CODEX_EXECUTABLE:process.env.CODEX_EXECUTABLE,MOTION_TEST_MODE:process.env.MOTION_TEST_MODE,MOTION_TEST_FIXTURE:process.env.MOTION_TEST_FIXTURE};
 try{
  await atomic(join(w,'project.json'),{version:2,title:'worker test',slots:{}});await atomic(join(w,'feedback.json'),{version:1,notes:[]});
  const base=await buildDemo(false);await importAsset(w,'baseline',base,'base.glb');await importAsset(w,'candidate',base,'base.glb');await writeFile(join(w,'changed.glb'),await buildDemo(true));
  const heartbeat=role=>`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(join(w,role+'.pid'))},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(join(w,role+'.heartbeat'))},String(Date.now())),30);`;
  const descendant=heartbeat('descendant')+`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(heartbeat('grandchild'))}],{stdio:'ignore'});`;
  const fake=join(w,'codex.cjs');await writeFile(fake,`
const fs=require('node:fs');const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('test-codex');process.exit(0);}
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
 if(!prompt.includes('immutable task'))process.exit(3);
 const result=a[a.indexOf('--output-last-message')+1];const mode=process.env.MOTION_TEST_MODE;
 if(mode.includes('descendant'))require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref();
 if(mode==='wait'||mode==='wait-descendant'){console.log(JSON.stringify({type:'test.waiting'}));setInterval(()=>{},1000);return;}
 if(mode==='failure'){console.error('test execution failure');process.exit(2);}
 const finish=()=>{const needs=mode==='needs-input';if(!needs){fs.writeFileSync('candidate.glb',fs.readFileSync(process.env.MOTION_TEST_FIXTURE));fs.writeFileSync('audit.json',JSON.stringify({fixtureCheck:true}));}
  if(mode==='optional-failure'){
   console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',exit_code:1,aggregated_output:'Optional renderer crashed'}}));
   console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',error:{message:'Optional player denied'}}}));
   console.error('Optional renderer unavailable');fs.writeFileSync('audit.json',JSON.stringify({limitations:['Optional preview unavailable; use studio comparison']}));
  }
  if(mode==='missing-audit')fs.unlinkSync('audit.json');
  if(mode==='directory-audit'){fs.unlinkSync('audit.json');fs.mkdirSync('audit.json');}
  if(mode==='malformed-audit')fs.writeFileSync('audit.json','{');
  if(mode==='oversized-audit')fs.writeFileSync('audit.json',' '.repeat(512*1024+1));
  if(mode==='stale-audit')fs.utimesSync('audit.json',new Date(1),new Date(1));
  if(mode==='stale-candidate')fs.utimesSync('candidate.glb',new Date(1),new Date(1));
  if(mode==='bad-binary'){const bytes=fs.readFileSync('candidate.glb'),n=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+n).toString()),a=doc.accessors[doc.animations[0].samplers[0].output];bytes.writeFloatLE(NaN,28+n+(doc.bufferViews[a.bufferView].byteOffset||0)+(a.byteOffset||0));fs.writeFileSync('candidate.glb',bytes);}
  fs.writeFileSync(result,JSON.stringify({status:mode==='invalid-result'?'unexpected':needs?'needs-input':'complete',summary:'fixture result',candidate:needs?'':'candidate.glb',reason:needs?'Need editable source':''}));
  console.log(JSON.stringify({type:'turn.completed'}));
 };
 if(mode==='success-descendant'){const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(w,'grandchild.heartbeat'))})){clearInterval(timer);finish();}},10);return;}
 finish();
});
`);
  process.env.CODEX_EXECUTABLE=fake;process.env.MOTION_TEST_MODE=mode;process.env.MOTION_TEST_FIXTURE=join(w,'changed.glb');
  const p=await json(join(w,'project.json'));
  const enqueue=(executor='agent')=>createJob(w,{request:'Reduce left arm swing, preserve other joints',slot:'baseline',executor,target:{bone:'LeftArm'},scope:{wholeClip:true,start:0,end:1},context:{slot:'baseline',asset:p.slots.baseline,clip:'Run',time:.25,fps:30}});
  await run(w,enqueue,p);
 }finally{
  // A failed regression must not leave its intentionally resistant fixture alive.
  for(const role of ['grandchild','descendant'])try{const pid=Number(await readFile(join(w,role+'.pid'),'utf8'));process.kill(pid,'SIGKILL');}catch{}
  for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(w,{recursive:true,force:true});
 }
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function descendantsReady(work){
 const end=Date.now()+6000;
 while(Date.now()<end){try{return await Promise.all(['descendant','grandchild'].map(async role=>({pid:Number(await readFile(join(work,role+'.pid'),'utf8')),heartbeat:join(work,role+'.heartbeat'),before:await readFile(join(work,role+'.heartbeat'),'utf8')})));}catch{}await delay(30);}
 throw Error('Owned descendant fixture did not start');
}
async function assertDescendantsStopped(rows){
 const heartbeats=await Promise.all(rows.map(row=>readFile(row.heartbeat,'utf8')));await delay(250);
 for(let i=0;i<rows.length;i++)assert.equal(await readFile(rows[i].heartbeat,'utf8'),heartbeats[i],'a descendant wrote after worker cleanup returned');
 for(const row of rows){
  let alive=true;try{process.kill(row.pid,0);}catch{alive=false;}
  // Linux may briefly retain a terminated orphan as a zombie before init reaps it.
  if(alive&&process.platform==='linux')try{alive=!/\) Z /.test(await readFile(`/proc/${row.pid}/stat`,'utf8'));}catch{alive=false;}
  assert.equal(alive,false,'owned descendant is still running');
 }
}

test('worker executes agent tasks, skips local jobs, and installs a distinct candidate',async()=>fixture('success',async(w,enqueue,p)=>{
 const local=await enqueue('local'),job=await enqueue();await startWorker(w,{once:true});
 const done=await getJob(w,job.id);assert.equal(done.state,'complete');assert.equal((await getJob(w,local.id)).state,'queued');assert.notEqual(done.candidate.sha256,p.slots.baseline.sha256);assert.equal((await json(join(w,'project.json'))).slots.baseline.sha256,p.slots.baseline.sha256);assert.equal(done.artisticDecision,null);assert.equal(done.audit.fixtureCheck,true);assert.match(await readFile(join(w,'jobs',job.id,'agent-output','events.jsonl'),'utf8'),/turn.completed/);
}));

test('worker surfaces missing input and execution failure without replacing candidate',async()=>{
 for(const mode of ['needs-input','failure'])await fixture(mode,async(w,enqueue,p)=>{
  const job=await enqueue();await startWorker(w,{once:true});const done=await getJob(w,job.id);assert.equal(done.state,mode==='needs-input'?'needs-input':'failed');assert.equal((await json(join(w,'project.json'))).slots.candidate.sha256,p.slots.candidate.sha256);assert.ok(done.error);assert.ok(await readFile(join(w,'jobs',job.id,'agent-output','stderr.txt')));
 });
});

test('optional tool failures and missing/bad audit reports do not block a checked candidate',async()=>{
 for(const mode of ['optional-failure','missing-audit','malformed-audit','oversized-audit','stale-audit','directory-audit'])await fixture(mode,async(w,enqueue,p)=>{
  const job=await enqueue();await startWorker(w,{once:true});const done=await getJob(w,job.id);
  assert.equal(done.state,'complete',mode);assert.notEqual(done.candidate.sha256,p.slots.candidate.sha256);assert.ok(done.validation.floatValuesChecked>0);
  assert.equal(done.automaticArtisticApproval,false);assert.equal((await json(join(w,'project.json'))).slots.baseline.sha256,p.slots.baseline.sha256);
  if(mode!=='missing-audit')assert.ok(done.audit.limitations.length,mode);
 });
});

test('invalid data, stale candidate files and invalid final states still block publication',async()=>{
 for(const mode of ['bad-binary','stale-candidate','invalid-result'])await fixture(mode,async(w,enqueue,p)=>{
  const job=await enqueue();await startWorker(w,{once:true});const done=await getJob(w,job.id);
  assert.equal(done.state,'failed',mode);assert.ok(done.error);assert.equal((await json(join(w,'project.json'))).slots.candidate.sha256,p.slots.candidate.sha256);
 });
});

test('cancelling an active worker stops its process and never installs a late result',async()=>fixture('wait',async(w,enqueue,p)=>{
 const job=await enqueue();const running=startWorker(w,{once:true,timeoutMs:8000});
 const until=Date.now()+5000;let entered=false;
 while(Date.now()<until){if((await getJob(w,job.id)).state==='running'){entered=true;break;}await new Promise(r=>setTimeout(r,30));}
 assert.equal(entered,true);await cancelJob(w,job.id);await running;assert.equal((await getJob(w,job.id)).state,'cancelled');assert.equal((await json(join(w,'project.json'))).slots.candidate.sha256,p.slots.candidate.sha256);
}));

for(const terminal of ['cancel','timeout'])test(`worker ${terminal} cleans resistant children and grandchildren even after the CLI exits`,async()=>fixture('wait-descendant',async(work,enqueue,p)=>{
 const job=await enqueue(),running=startWorker(work,{once:true,timeoutMs:terminal==='timeout'?4000:10000});
 const descendants=await descendantsReady(work);
 if(terminal==='cancel')await cancelJob(work,job.id);
 await running;assert.equal((await getJob(work,job.id)).state,terminal==='cancel'?'cancelled':'failed');
 if(terminal==='timeout')assert.match((await getJob(work,job.id)).error,/超时/);
 assert.equal((await json(join(work,'project.json'))).slots.candidate.sha256,p.slots.candidate.sha256);
 await assertDescendantsStopped(descendants);
}));

test('successful worker cleans owned background descendants before installing its result',{skip:process.platform==='win32'&&'POSIX process-group contract; Windows taskkill is covered separately'},async()=>fixture('success-descendant',async(work,enqueue)=>{
 const job=await enqueue(),running=startWorker(work,{once:true,timeoutMs:1800});
 const descendants=await descendantsReady(work);await running;
 assert.equal((await getJob(work,job.id)).state,'complete','cleanup grace must not turn a completed CLI into a timeout');
 await assertDescendantsStopped(descendants);
}));
