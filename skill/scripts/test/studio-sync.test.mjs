import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {atomic,importAsset,readProject,projectView} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {serve} from '../server.mjs';
import {createJob,claimJob,completeJob,reviewJob} from '../jobs.mjs';

test('an external completion notifies open pages and shared writes are serialized per model',async t=>{
 const work=await mkdtemp(resolve(tmpdir(),'motion-sync-'));
 let server;
 const abort=new AbortController();
 t.after(async()=>{abort.abort();if(server)await new Promise(done=>server.close(done));await rm(work,{recursive:true,force:true});});
 await atomic(resolve(work,'project.json'),{version:2,slots:{}});
 await atomic(resolve(work,'feedback.json'),{version:1,notes:[]});
 const original=await buildDemo(false),candidate=await buildDemo(true);
 await importAsset(work,'baseline',original,'Role A');
 const other=await importAsset(work,'baseline',original,'Role B',{newModel:true,activate:false});
 const originalProject=projectView(await readProject(work));
 const payload=project=>({request:'调整摆臂',scope:{wholeClip:true,start:0,end:1},context:{slot:'baseline',clip:'Run',time:.25,assetId:project.activeAssetId,asset:project.slots.baseline}});
 server=await serve(work,0);
 const base='http://127.0.0.1:'+server.address().port;
 const get=async path=>(await fetch(base+path)).json();
 const snapshot=await get('/api/studio?compact=1');
 const stream=await fetch(base+'/api/studio/events',{signal:abort.signal});
 assert.match(stream.headers.get('content-type'),/^text\/event-stream/);
 const reader=stream.body.getReader(),decoder=new TextDecoder();
 async function until(pattern){
  let data='';
  while(!pattern.test(data)){
   const part=await reader.read();assert.ok(!part.done,'stream closed before notification');
   data+=decoder.decode(part.value,{stream:true});
  }
 }
 await until(/data: ready/);
 const deadline=setTimeout(()=>abort.abort(),5000);deadline.unref();
 const changed=until(/data: changed/);
 const candidateFile=resolve(work,'result.glb');
 await writeFile(candidateFile,candidate);
 const moduleURL=new URL('../jobs.mjs',import.meta.url).href;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',`
  import {createJob,claimJob,completeJob} from ${JSON.stringify(moduleURL)};
  const [work,payload,candidatePath]=process.argv.slice(1);
  const job=await createJob(work,JSON.parse(payload));
  const claimed=await claimJob(work,job.id);
  await completeJob(work,job.id,{lease:claimed.lease,candidatePath,summary:'修改完成'});
  console.log(job.id);
 `,work,JSON.stringify(payload(originalProject)),candidateFile]);
 await changed;clearTimeout(deadline);
 const completeId=stdout.trim();
 const latest=await get('/api/studio?compact=1&since='+snapshot.revision);
 assert.equal(latest.candidateJobId,completeId);
 assert.equal(latest.jobs.find(job=>job.id===completeId)?.state,'complete');
 assert.notEqual(latest.project.slots.candidate.sha256,originalProject.slots.baseline.sha256);

 const contenders=await Promise.allSettled([createJob(work,payload(latest.project)),createJob(work,payload(latest.project))]);
 const active=contenders.find(item=>item.status==='fulfilled')?.value;
 assert.ok(active);
 assert.equal(contenders.find(item=>item.status==='rejected')?.reason.jobId,active.id);
 const independent=await createJob(work,payload(projectView(await readProject(work),other.assetId)));
 assert.equal(independent.assetId,other.assetId);
 const {token}=await get('/api/session');
 const post=(path,body,contentType='application/json')=>fetch(base+path,{method:'POST',headers:{'x-motion-token':token,'Content-Type':contentType},body});
 for(const response of [
  await post('/api/jobs/'+completeId+'/review',JSON.stringify({decision:'keep-baseline'})),
  await post('/api/assets/candidate?assetId='+active.assetId,original,'application/octet-stream')
 ]){
  assert.equal(response.status,409);
  assert.deepEqual(Object.fromEntries(Object.entries(await response.json()).filter(([key])=>key!=='error')),{code:'MODEL_JOB_ACTIVE',jobId:active.id});
 }
 const claimed=await claimJob(work,active.id);
 const repeated=await completeJob(work,active.id,{lease:claimed.lease,candidatePath:candidateFile,summary:'另一任务返回相同内容'});
 await reviewJob(work,completeId,{decision:'keep-baseline'});
 const after=await get('/api/studio?compact=1');
 assert.equal(after.candidateJobId,repeated.id);
 assert.equal(after.project.slots.candidate.sha256,repeated.candidate.sha256);
});
