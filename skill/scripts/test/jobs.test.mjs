import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {parseGlb,encodeGlb,editGlb} from '../asset-tools.mjs';
import {ROOT,atomic,json,importAsset,sha,withWorkspaceLock,readProject,modelSlots} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {createJob,claimJob,completeJob,getJob,listJobs,cancelJob,failJob,localEditJob,reviewJob,inspectSlot,checkMotionSlot} from '../jobs.mjs';
import {serve} from '../server.mjs';
import {saveDraft,readDraft} from '../drafts.mjs';
import {feedbackObservation,pointsForClip} from '../../assets/viewer/feedback-points.mjs';
import {planObservationRestore,restoredTransportTime} from '../../assets/viewer/observation-state.mjs';
async function setup(){const w=await mkdtemp(resolve(tmpdir(),'motion-jobs-'));await atomic(resolve(w,'project.json'),{version:2,title:'Test',slots:{}});await atomic(resolve(w,'feedback.json'),{version:1,notes:[]});const b=await buildDemo(false);await importAsset(w,'baseline',b,'base.glb');await importAsset(w,'candidate',b,'candidate.glb');return w;}
async function input(w,changes={}){const p=await json(resolve(w,'project.json'));return {request:'左臂摆动收小三成，保留其他动作',preserve:'模型、其他肢体和时长',target:{bone:'LeftArm'},scope:{start:0,end:1,wholeClip:true},context:{slot:'baseline',asset:p.slots.baseline,clip:'Run',time:.25,fps:30,frame:8,view:'front',mode:'elapsed',rootLocked:true,slots:Object.fromEntries(Object.entries(p.slots).map(([k,v])=>[k,{...v,clip:'Run',time:.25}]))},...changes};}

test('foot diagnostics compare the displayed frozen pair after the workspace candidate changes',async()=>{
 const w=await setup();let server;try{
  const j=await createJob(w,await input(w)),claim=await claimJob(w,j.id),path=resolve(w,'foot-candidate.glb');
  await writeFile(path,await buildDemo(true));
  const done=await completeJob(w,j.id,{lease:claim.lease,candidatePath:path,summary:'左肩改动'});
  await importAsset(w,'candidate',await buildDemo(false),'newer.glb');
  server=await serve(w,0);const url='http://127.0.0.1:'+server.address().port,session=await(await fetch(url+'/api/session')).json();
  const post=(data,token=session.token)=>fetch(url+'/api/actions/foot-diagnostics',{method:'POST',headers:{'x-motion-token':token},body:JSON.stringify(data)});
  const versions={baseline:j.inputs.baseline.sha256,candidate:done.candidate.sha256};
  const payload={assetId:j.assetId,clip:'Run',versions,jobId:j.id};
  assert.equal((await post(payload,'wrong')).status,403);
  assert.equal((await post({...payload,jobId:undefined})).status,400);
  assert.equal((await post({...payload,clip:'不存在的动作'})).status,400);
  const response=await post(payload);assert.equal(response.status,200);
  const result=await response.json();
  assert.deepEqual(result.reports.map(r=>[r.slot,r.sha256]),Object.entries(versions));
  assert(result.reports.every(r=>r.fps===30&&r.clip==='Run'&&r.checks.footSlip.length===2&&r.checks.footSlip.every(f=>f.contacts.length)));
  const single=await post({...payload,jobId:undefined,versions:{baseline:versions.baseline}});
  assert.deepEqual((await single.json()).reports.map(r=>r.slot),['baseline']);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(w,{recursive:true,force:true});}
});

test('feedback markers persist as separate clip drafts and freeze together as one reviewable task',async()=>{
 const w=await setup();try{
  const payload=await input(w,{request:''}),asset=payload.context.asset,assetId=(await readProject(w)).activeAssetId;
  const one={id:'one',assetSha256:asset.sha256,clip:'Run',time:.22,note:'收小左肩摆幅',target:{bone:'LeftShoulder',nodeIndex:9},camera:{position:[0,2,4],target:[0,1,0],fov:35},view:'front',rootLocked:true,scaleMode:'shared',normalization:{scale:2,restOffset:[0,0,0]}};
  const two={...one,id:'two',time:.65,note:'右肩后摆收一点',target:{bone:'RightShoulder'},camera:{position:[4,2,0],target:[0,1,0],fov:39},view:'side'};
  const other={...one,id:'other',clip:'Salute'};
  await saveDraft(w,assetId,{expectedRevision:0,draft:{assetId,context:{assetId},request:'',preserve:'',feedbackPoints:[one,two,other]}});
  const stored=(await readDraft(w,assetId)).draft.feedbackPoints;
  assert.deepEqual(stored,[one,two,other]);
  await assert.rejects(createJob(w,{...payload,feedbackPoints:[one,other]}),/不匹配/);
  await assert.rejects(createJob(w,{...payload,feedbackPoints:[{...one,assetSha256:'f'.repeat(64)}]}),/不匹配/);
  await assert.rejects(createJob(w,{...payload,feedbackPoints:[one,two],scope:{start:.5,end:1,wholeClip:false}}),/超出/);
  await assert.rejects(createJob(w,{...payload,feedbackPoints:[one,one]}),/无效|缺少/);
  await assert.rejects(createJob(w,{...payload,feedbackPoints:[one],executor:'local'}),/本地微调/);
  await assert.rejects(createJob(w,payload),/不能为空/);
  const j=await createJob(w,{...payload,feedbackPoints:pointsForClip(stored,asset.sha256,'Run')});
  assert.equal(j.pointOnly,true);assert.deepEqual(j.target,{});assert.deepEqual(j.feedbackPoints,[one,two]);
  assert.deepEqual((await json(resolve(w,'jobs',j.id,'context.json'))).feedbackPoints,[one,two]);
  assert.match(await readFile(j.taskPath,'utf8'),/1\. 0\.220 秒 · LeftShoulder\n   收小左肩摆幅\n2\. 0\.650 秒 · RightShoulder\n   右肩后摆收一点/);
  assert.equal((await listJobs(w)).length,1);
  const models={baseline:{clips:[{name:'Run'}],duration:1},candidate:{clips:[{name:'Run'}],duration:2}};
  for(const mark of j.feedbackPoints){
   const ctx=feedbackObservation({...j.context,mode:'progress'},mark,'candidate',{comparison:true});
   const plan=planObservationRestore(ctx,models,{inputSlot:'candidate'});
   assert.equal(plan.display,'split');assert.equal(plan.settings.mode,'elapsed');assert.equal(plan.settings.view,mark.view);
   assert.deepEqual(plan.cameras,{baseline:mark.camera,candidate:mark.camera});
   assert.deepEqual(plan.clips,{baseline:'Run',candidate:'Run'});
   assert.deepEqual(plan.normalization,mark.normalization);
   assert.equal(restoredTransportTime(plan,models),mark.time);
  }
 }finally{await rm(w,{recursive:true,force:true});}
});

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

test('the frozen clip lock allows preview but blocks adoption when other animation tracks changed',async()=>{
 const w=await setup();try{
  const payload=await input(w,{lockOtherClips:true});
  const job=await createJob(w,payload),claim=await claimJob(w,job.id);
  const original=await readFile(resolve(w,job.inputs.baseline.file)),path=resolve(w,'diff-candidate.glb');
  assert.equal((await json(resolve(w,'jobs',job.id,'context.json'))).lockOtherClips,true);
  const altered=editGlb(original,{clip:'Salute',bone:'RightShoulder',factor:.6});
  await writeFile(path,altered.bytes);
  const result=await completeJob(w,job.id,{lease:claim.lease,candidatePath:path,summary:'test'});
  assert.equal(result.candidateDiff.protection,'violated');
  assert.equal(result.candidateDiff.outside,1);
  await assert.rejects(reviewJob(w,job.id,{decision:'accept-candidate'}),/锁定的其他动作/);
  assert.equal((await getJob(w,job.id)).review,undefined);
  await reviewJob(w,job.id,{decision:'keep-baseline'});
  const current=modelSlots(await readProject(w),job.assetId);
  const next=await createJob(w,{assetId:job.assetId,request:'缩小左肩摆幅',slot:'candidate',lockOtherClips:true,context:{slot:'candidate',asset:current.candidate,clip:'Run',time:.25}});
  const nextClaim=await claimJob(w,next.id);
  await writeFile(path,editGlb(original,{clip:'Run',bone:'LeftShoulder',factor:.6}).bytes);
  const done=await completeJob(w,next.id,{lease:nextClaim.lease,candidatePath:path,summary:'test'});
  assert.equal(done.candidateDiff.protection,'verified');
  assert.deepEqual(done.candidateDiff.tracks,{unchanged:15,changed:1,added:0,removed:0,unverified:0});
  assert.equal((await reviewJob(w,next.id,{decision:'accept-candidate'})).artisticDecision,'accept-candidate');
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

test('CLI rejects unknown flags with hints and lists jobs as compact summaries by default',async()=>{
 const w=await setup();try{
  const job=await createJob(w,await input(w)),cli=(...a)=>spawnSync(process.execPath,[resolve(ROOT,'scripts/motion-feedback.mjs'),...a],{encoding:'utf8'});
  const p=await json(resolve(w,'project.json')),file=resolve(w,p.slots.baseline.file);
  const wrong=cli('motion-check','--input',file,'--candidate',file,'--clip','Run');assert.equal(wrong.status,1);assert.match(wrong.stderr,/--input（是不是 --baseline-file？）/);assert.match(wrong.stderr,/--candidate（是不是 --file？）/);
  const right=cli('motion-check','--baseline-file',file,'--file',file,'--clip','Run');assert.equal(right.status,0,right.stderr);assert.equal(JSON.parse(right.stdout).summary.newWarnings,0);
  const badCheck=cli('motion-check','--file',file,'--clip','Run','--checks','flips');assert.equal(badCheck.status,1);assert.match(badCheck.stderr,/未知检查项：flips/);
  assert.match(cli('actions','--workspace',w,'--catgory','attack').stderr,/actions 不认识 --catgory/);
  const compact=cli('jobs','--workspace',w),full=cli('jobs','--workspace',w,'--full');assert.equal(compact.status,0,compact.stderr);
  const summary=JSON.parse(compact.stdout).jobs[0],detail=JSON.parse(full.stdout).jobs[0];
  assert.equal(summary.id,job.id);assert.equal(summary.request,job.request);assert.equal(summary.state,'queued');assert.equal(summary.clip,'Run');
  assert.ok(!('context' in summary)&&'context' in detail);assert.ok(compact.stdout.length*3<full.stdout.length);
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'motion_list_jobs',arguments:{}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'motion_list_jobs',arguments:{full:true}}}];
  const r=spawnSync(process.execPath,[resolve(ROOT,'scripts/motion-feedback.mjs'),'mcp','--workspace',w],{input:messages.map(m=>JSON.stringify(m)).join('\n')+'\n',encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const [,listed,listedFull]=r.stdout.trim().split('\n').map(JSON.parse);assert.equal(listed.result.structuredContent.jobs[0].id,job.id);assert.ok(!('context' in listed.result.structuredContent.jobs[0]));assert.ok('context' in listedFull.result.structuredContent.jobs[0]);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('a request naming the other side than the picked bone is recorded for the agent',async()=>{
 const w=await setup();try{
  const conflict=await createJob(w,await input(w,{request:'右臂摆得太大，收一点',target:{bone:'LeftArm',inferred:true}}));
  assert.deepEqual(conflict.sideConflict,{requested:'right',picked:'left',bone:'LeftArm',inferred:true});
  const task=await readFile(conflict.taskPath,'utf8');assert.match(task,/左右提示：要求写的是右侧，页面选中的却是角色左侧的 LeftArm（由点击位置推断）/);assert.match(task,/needs-input/);
  await cancelJob(w,conflict.id);
  const clean=await createJob(w,await input(w,{request:'左右手都收一点',target:{bone:'LeftArm'}}));assert.equal(clean.sideConflict,undefined);assert.doesNotMatch(await readFile(clean.taskPath,'utf8'),/左右提示/);
 }finally{await rm(w,{recursive:true,force:true});}
});


test('job-bound motion check uses the frozen candidate input across later head changes',async()=>{
 const w=await setup();try{
  const first=await createJob(w,await input(w));await localEditJob(w,first.id,{bone:'LeftShoulder',factor:.7});
  const p=await json(resolve(w,'project.json')),j=await createJob(w,await input(w,{slot:'candidate',parentJobId:first.id,context:{slot:'candidate',asset:p.slots.candidate,clip:'Run',time:.2}}));
  const file=resolve(w,'next.glb');await writeFile(file,await buildDemo(false));
  const report=await checkMotionSlot(w,{jobId:j.id,file});assert.equal(report.jobId,j.id);assert.equal(report.baselineSha256,j.inputs.candidate.sha256);assert.notEqual(report.baselineSha256,j.inputs.baseline.sha256);
  await assert.rejects(checkMotionSlot(w,{jobId:j.id,file,baselineSlot:'baseline'}),/固定本轮输入/);await assert.rejects(checkMotionSlot(w,{jobId:j.id,file,assetId:'other'}),/模型与任务不一致/);await assert.rejects(checkMotionSlot(w,{jobId:j.id,file,clip:'Salute'}),/动作与任务不一致/);
  await importAsset(w,'candidate',await buildDemo(false),'new-head.glb');assert.equal((await checkMotionSlot(w,{jobId:j.id,file})).baselineSha256,j.inputs.candidate.sha256);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('whole-clip local edit accepts a rotation track shorter than the animation',async()=>{
 const w=await setup();try{
  const {readAccessor}=await import('../asset-tools.mjs'),parsed=parseGlb(await buildDemo(false)),d=parsed.doc,a=d.animations.find(a=>a.name==='Run'),node=d.nodes.findIndex(n=>n.name==='LeftShoulder'),channel=a.channels.find(c=>c.target.node===node&&c.target.path==='rotation'),sampler=a.samplers[channel.sampler];
  for(const [key,width]of [['input',4],['output',16]]){const accessor=structuredClone(d.accessors[sampler[key]]);accessor.byteOffset=(accessor.byteOffset||0)+width;accessor.count-=2;delete accessor.min;delete accessor.max;sampler[key]=d.accessors.push(accessor)-1;}
  const times=readAccessor(d,parsed.bin,sampler.input).flat();d.accessors[sampler.input].min=[times[0]];d.accessors[sampler.input].max=[times.at(-1)];assert.ok(times[0]>0);await importAsset(w,'baseline',encodeGlb(d,parsed.bin),'short-track.glb');const j=await createJob(w,await input(w,{target:{bone:'LeftShoulder'}}));const result=await localEditJob(w,j.id,{bone:'LeftShoulder',factor:.9});assert.equal(result.state,'complete');assert.equal(result.audit.preserved.otherChannels,true);
 }finally{await rm(w,{recursive:true,force:true});}
});
