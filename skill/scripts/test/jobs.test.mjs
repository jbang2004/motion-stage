import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {parseGlb,encodeGlb} from '../asset-tools.mjs';
import {ROOT,atomic,json,importAsset,sha,withWorkspaceLock} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {createJob,claimJob,completeJob,getJob,listJobs,cancelJob,failJob,localEditJob,reviewJob,inspectSlot} from '../jobs.mjs';
import {serve} from '../server.mjs';
async function setup(){const w=await mkdtemp(resolve(tmpdir(),'motion-jobs-'));await atomic(resolve(w,'project.json'),{version:2,title:'Test',slots:{}});await atomic(resolve(w,'feedback.json'),{version:1,notes:[]});const b=await buildDemo(false);await importAsset(w,'baseline',b,'base.glb');await importAsset(w,'candidate',b,'candidate.glb');return w;}
async function input(w,changes={}){const p=await json(resolve(w,'project.json'));return {request:'左臂摆动收小三成，保留其他动作',preserve:'模型、其他肢体和时长',target:{bone:'LeftArm'},scope:{start:0,end:1,wholeClip:true},context:{slot:'baseline',asset:p.slots.baseline,clip:'Run',time:.25,fps:30,frame:8,view:'front',mode:'elapsed',rootLocked:true,slots:Object.fromEntries(Object.entries(p.slots).map(([k,v])=>[k,{...v,clip:'Run',time:.25}]))},...changes};}

test('job persists observation, accepts one owner, returns distinct candidate and records human review',async()=>{
 const w=await setup();try{
  const j=await createJob(w,await input(w));assert.equal(j.state,'queued');assert.equal(j.context.time,.25);assert.equal((await readFile(j.taskPath,'utf8')).includes(j.inputs.baseline.sha256),true);
  const results=await Promise.allSettled([claimJob(w,j.id,{owner:'one'}),claimJob(w,j.id,{owner:'two'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const claim=results.find(r=>r.status==='fulfilled').value;
  const original=await readFile(resolve(w,j.inputs.baseline.file));const path=resolve(w,'candidate.glb');await writeFile(path,original);await assert.rejects(completeJob(w,j.id,{lease:claim.lease,candidatePath:path,summary:'unchanged'}),/完全相同/);
  await writeFile(path,await buildDemo(true));await assert.rejects(completeJob(w,j.id,{lease:'bad',candidatePath:path,summary:'changed'}),/租约/);
  const done=await completeJob(w,j.id,{lease:claim.lease,candidatePath:path,summary:'只调整左臂，检查了其余动作'});assert.equal(done.state,'complete');assert.notEqual(done.candidate.sha256,j.inputs.baseline.sha256);assert.equal(sha(await readFile(resolve(w,j.inputs.baseline.file))),j.inputs.baseline.sha256);assert.equal(done.automaticArtisticApproval,false);
  const reviewed=await reviewJob(w,j.id,{decision:'keep-baseline',outcome:'保留原动作'});assert.equal(reviewed.artisticDecision,'keep-baseline');assert.equal((await json(resolve(w,'project.json'))).slots.baseline.sha256,j.inputs.baseline.sha256);assert.equal((await listJobs(w)).length,1);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('stale completion and cancelled execution never replace current preview',async()=>{
 const w=await setup();try{
  const j=await createJob(w,await input(w)),claim=await claimJob(w,j.id);const b=await buildDemo(true);await importAsset(w,'candidate',b,'newer.glb');const current=(await json(resolve(w,'project.json'))).slots.candidate;
  const p=resolve(w,'output.glb');await writeFile(p,b);await assert.rejects(completeJob(w,j.id,{lease:claim.lease,candidatePath:p,summary:'old worker'}),/过期/);assert.equal((await getJob(w,j.id)).state,'stale');assert.deepEqual((await json(resolve(w,'project.json'))).slots.candidate,current);
  const k=await createJob(w,await input(w)),c=await claimJob(w,k.id);await cancelJob(w,k.id);await assert.rejects(completeJob(w,k.id,{lease:c.lease,candidatePath:p,summary:'late'}),/租约/);assert.equal((await getJob(w,k.id)).state,'cancelled');
  const n=await createJob(w,await input(w)),nc=await claimJob(w,n.id);await failJob(w,n.id,{lease:nc.lease,state:'needs-input',error:'请确认改整个动作还是片段'});assert.equal((await getJob(w,n.id)).state,'needs-input');assert.equal((await claimJob(w,n.id)).state,'running');
 }finally{await rm(w,{recursive:true,force:true});}
});

test('HTTP enqueue -> deterministic scoped candidate -> preserved observation + static intake',async()=>{
 const w=await setup();let server;try{
  const inspect=await inspectSlot(w,'baseline');const bone=inspect.clips.find(c=>c.name==='Run').targets.find(t=>t.path==='rotation').name;
  server=await serve(w,0);const url='http://127.0.0.1:'+server.address().port,s=await(await fetch(url+'/api/session')).json();
  const post=async(path,d,token=s.token)=>{const r=await fetch(url+path,{method:'POST',headers:{'x-motion-token':token},body:JSON.stringify(d)});return [r.status,await r.json()];};
  assert.equal((await post('/api/jobs',await input(w),'wrong'))[0],403);
  const payload=await input(w,{executor:'local',target:{bone},screenshot:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII='});const [code,j]=await post('/api/jobs',payload);assert.equal(code,200);assert.equal(j.executor,'local');assert.ok(await readFile(resolve(w,j.screenshot)));
  const [status,result]=await post('/api/jobs/'+j.id+'/local-edit',{bone,factor:.7});assert.equal(status,200,JSON.stringify(result));assert.equal(result.state,'complete');assert.equal(result.audit.agentGenerated,false);assert.equal(result.audit.preserved.otherChannels,true);
  const studio=await(await fetch(url+'/api/studio')).json();assert.equal(studio.version,2);assert.equal(studio.jobs[0].state,'complete');assert.equal(studio.project.slots.candidate.sha256,result.candidate.sha256);assert.equal((await fetch(url+'/workspace/'+j.screenshot)).status,200);
  const exported=await(await fetch(url+'/api/export')).json();assert.equal(exported.jobs.length,1);assert.equal(exported.jobs[0].state,'complete');assert.equal('lease' in exported.jobs[0],false);
  const report=spawnSync(process.execPath,[resolve(ROOT,'scripts/motion-feedback.mjs'),'report','--workspace',w],{encoding:'utf8'});assert.equal(report.status,0,report.stderr);assert.equal(JSON.parse(report.stdout).jobs.length,1);
  const validate=()=>spawnSync(process.execPath,[resolve(ROOT,'scripts/motion-feedback.mjs'),'validate','--workspace',w],{encoding:'utf8'});const v=validate();assert.equal(v.status,0,v.stderr);assert.equal(JSON.parse(v.stdout).jobsCount,1);
  await rm(resolve(w,j.screenshot));assert.equal(validate().status,1);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(w,{recursive:true,force:true});}
});

test('MCP stdio supports real protocol initialize, tools and job context without optional packages',async()=>{
 const w=await setup();try{
  const job=await createJob(w,await input(w));const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'motion_get_job',arguments:{id:job.id}}}];
  const r=spawnSync(process.execPath,[resolve(ROOT,'scripts/motion-feedback.mjs'),'mcp','--workspace',w],{input:messages.map(m=>JSON.stringify(m)).join('\n')+'\n',encoding:'utf8'});assert.equal(r.status,0,r.stderr);const out=r.stdout.trim().split('\n').map(JSON.parse);assert.equal(out.length,3);assert.equal(out[0].result.protocolVersion,'2024-11-05');assert.ok(out[1].result.tools.some(t=>t.name==='motion_complete_job'));assert.equal(out[2].result.structuredContent.id,job.id);
 }finally{await rm(w,{recursive:true,force:true});}
});


test('first private import seeds a matching candidate without replacing a genuine existing candidate',async()=>{
 const w=await setup();try{
  const parsed=parseGlb(await buildDemo(false));parsed.doc.asset.generator='Private artist export';const real=encodeGlb(parsed.doc,parsed.bin,parsed.extra);
  await importAsset(w,'baseline',real,'My character.glb');let p=await json(resolve(w,'project.json'));assert.equal(p.slots.candidate.sha256,p.slots.baseline.sha256);assert.equal(p.slots.candidate.label.includes('尚未修改'),true);
  const other=parseGlb(await buildDemo(true));other.doc.asset.generator='Private candidate';const candidate=encodeGlb(other.doc,other.bin,other.extra);await importAsset(w,'candidate',candidate,'Genuine candidate');const expected=sha(candidate);
  await importAsset(w,'baseline',await buildDemo(false),'Another baseline');p=await json(resolve(w,'project.json'));assert.equal(p.slots.candidate.sha256,expected);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('two independent CLI processes cannot claim the same task',async()=>{
 const w=await setup();try{
  const j=await createJob(w,await input(w));const call=()=>new Promise((ok,no)=>{const p=spawn(process.execPath,[resolve(ROOT,'scripts/motion-feedback.mjs'),'claim','--workspace',w,'--job',j.id],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',no);p.on('exit',code=>ok({code,stdout,stderr}));});
  const results=await Promise.all([call(),call()]);assert.equal(results.filter(r=>r.code===0).length,1);assert.equal((await getJob(w,j.id)).state,'running');
 }finally{await rm(w,{recursive:true,force:true});}
});


test('direct MCP entry remains active when launched through a filesystem alias',async()=>{
 const w=await setup();try{
  const alias=resolve(w,'mcp-alias'),link=process.platform==='win32'?resolve(alias,'scripts/mcp.mjs'):alias+'.mjs';await symlink(process.platform==='win32'?ROOT:resolve(ROOT,'scripts/mcp.mjs'),process.platform==='win32'?alias:link,process.platform==='win32'?'junction':'file');
  const msg={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}};
  const r=spawnSync(process.execPath,[link,'--workspace',w],{input:JSON.stringify(msg)+'\n',encoding:'utf8'});assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout.trim());assert.equal(out.id,1);assert.equal(out.result.serverInfo.name,'motion-stage');
 }finally{await rm(w,{recursive:true,force:true});}
});
