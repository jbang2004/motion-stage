import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readJobIndex,jobsPage,listQueuedJobSummaries} from '../job-index.mjs';
import {atomic,importAsset,readProject} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {serve} from '../server.mjs';

async function fixture(count=12){
 const work=await mkdtemp(resolve(tmpdir(),'motion-index-')),jobs=[];
 for(let i=0;i<count;i++){
  const id=randomUUID(),j={id,assetId:i%2?'A':'B',state:i===0?'running':i===1?'queued':'complete',executor:'agent',execution:i===0?{id:randomUUID(),pid:123}:undefined,request:'要求 '+i,createdAt:new Date(1700000000000+i).toISOString(),updatedAt:new Date(1700000000000+i).toISOString(),slot:'baseline',inputs:{baseline:{file:'assets/source.glb',sha256:'source'}},candidate:{file:'assets/candidate.glb',sha256:'candidate'},context:{privateLarge:'x'.repeat(8000)},events:[{message:'x'.repeat(4000)}],lease:'secret',audit:{large:'x'.repeat(2000)}};
  await mkdir(resolve(work,'jobs',id),{recursive:true});await writeFile(resolve(work,'jobs',id,'job.json'),JSON.stringify(j));jobs.push(j);
 }
 return {work,jobs};
}
test('recoverable index keeps compact summaries, cross-model counts and deterministic bounded pages',async()=>{
 const {work,jobs}=await fixture();try{
  const first=await readJobIndex(work);assert.equal(first.total,12);assert.equal(first.counts.A.total,6);assert.equal(first.counts.B.active,1);assert.equal(first.rows.find(j=>j.id===jobs[0].id).executionManaged,true);
  assert.ok(JSON.stringify(first).length<14000);assert.equal(first.rows.some(j=>'lease' in j||'context' in j||'events' in j||'audit' in j),false);
  const page=await jobsPage(work,{assetId:'A',limit:2});assert.equal(page.total,6);assert.equal(page.jobs.length,2);assert.equal(page.hasMore,true);assert.equal(page.jobs[0].id,jobs[11].id);
  const next=await jobsPage(work,{assetId:'A',limit:2,offset:2});assert.equal(next.jobs[0].id,jobs[7].id);assert.equal((await listQueuedJobSummaries(work))[0].id,jobs[1].id);
  const file=resolve(work,'job-index.json'),before=await stat(file);assert.equal((await readJobIndex(work)).revision,first.revision);assert.equal((await stat(file)).mtimeMs,before.mtimeMs);
  await writeFile(file,'{broken');assert.equal((await readJobIndex(work)).revision,first.revision);
  const corrupt=JSON.parse(await readFile(file,'utf8'));corrupt.entries[jobs[0].id].summary.state='complete';await writeFile(file,JSON.stringify(corrupt));assert.equal((await readJobIndex(work)).rows.find(j=>j.id===jobs[0].id).state,'running');
  const invalid=JSON.parse(await readFile(file,'utf8'));invalid.entries[jobs[0].id].summary.id='invalid';await writeFile(file,JSON.stringify(invalid));assert.equal((await readJobIndex(work)).rows.find(j=>j.id===jobs[0].id).state,'running');
 }finally{await rm(work,{recursive:true,force:true});}
});
test('a separate CLI process and direct job replacements are visible without cache invalidation hooks',async()=>{
 const {work,jobs}=await fixture();try{
  const before=await readJobIndex(work),j={...jobs[1],state:'failed',updatedAt:new Date().toISOString()};
  const child=spawnSync(process.execPath,['--input-type=module','-e',"import {writeFile,rename} from 'node:fs/promises';const [file,data]=process.argv.slice(1);await writeFile(file+'.tmp',data);await rename(file+'.tmp',file);",resolve(work,'jobs',j.id,'job.json'),JSON.stringify(j)],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
  const next=await readJobIndex(work);assert.notEqual(next.revision,before.revision);assert.equal(next.rows.find(x=>x.id===j.id).state,'failed');assert.equal(next.counts.A.active,0);
  await rm(resolve(work,'jobs',jobs[0].id),{recursive:true});assert.equal((await readJobIndex(work)).total,11);
 }finally{await rm(work,{recursive:true,force:true});}
});
test('compact studio is revision-aware, selects bounded current summaries and preserves legacy API',async()=>{
 const {work,jobs}=await fixture(120);let server;try{
  await atomic(resolve(work,'project.json'),{version:2,title:'Index test',slots:{}});await atomic(resolve(work,'feedback.json'),{version:1,notes:[]});await importAsset(work,'baseline',await buildDemo(false),'base.glb');const cfg=await readProject(work),assetId=cfg.activeAssetId;
  for(const j of jobs){j.assetId=assetId;await atomic(resolve(work,'jobs',j.id,'job.json'),j);}
  server=await serve(work,0);const base='http://127.0.0.1:'+server.address().port;
  const get=async path=>{const r=await fetch(base+path);assert.equal(r.status,200);return r.json();};
  const compact=await get('/api/studio?compact=1');assert.equal(compact.version,3);assert.ok(compact.jobs.length<=4);assert.equal(compact.jobCounts[assetId].total,120);assert.equal(compact.jobs.some(j=>'context' in j),false);assert.ok(JSON.stringify(compact).length<20000);
  const unchanged=await get('/api/studio?compact=1&since='+compact.revision);assert.equal(unchanged.unchanged,true);assert.ok(JSON.stringify(unchanged).length<250);
  const page=await get('/api/jobs?page=1&assetId='+assetId+'&limit=7');assert.equal(page.jobs.length,7);assert.equal(page.total,120);
  const selected=await get('/api/studio?compact=1&jobId='+jobs[50].id);assert.ok(selected.jobs.some(j=>j.id===jobs[50].id));
  const detail=await get('/api/jobs/'+jobs[50].id);assert.equal(detail.context.privateLarge.length,8000);assert.equal('lease' in detail,false);
  const legacy=await get('/api/studio');assert.equal(legacy.version,2);assert.equal(legacy.jobs.length,120);assert.equal(legacy.jobs[0].context.privateLarge.length,8000);
  await atomic(resolve(work,'jobs',jobs[119].id,'job.json'),{...jobs[119],request:'外部工具更新'});const updated=await get('/api/studio?compact=1&since='+compact.revision);assert.equal(updated.unchanged,undefined);assert.notEqual(updated.revision,compact.revision);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(work,{recursive:true,force:true});}
});
