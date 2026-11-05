import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomic,ROOT} from '../core.mjs';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {diagnoseRuntime} from '../runtime-diagnostics.mjs';
import {serve} from '../server.mjs';

async function workspace(){const work=await mkdtemp(join(tmpdir(),'motion-startup-'));await atomic(join(work,'project.json'),{version:2,slots:{}});await atomic(join(work,'feedback.json'),{version:1,notes:[]});return work;}
const close=server=>new Promise(resolve=>server.close(resolve));

test('the launcher reports an old runtime before loading the studio or creating a workspace',async()=>{
 const work=await workspace(),unused=join(work,'not-created');
 try{
  const code="Object.defineProperty(process.versions,'node',{value:'20.0.0'});await import("+JSON.stringify(pathToFileURL(join(ROOT,'scripts/start.mjs')).href)+')';
  const run=spawnSync(process.execPath,['--input-type=module','-e',code,'--','--workspace',unused,'--no-open'],{encoding:'utf8'});
  assert.equal(run.status,1);assert.match(run.stderr,/需要 Node.js >=22/);await assert.rejects(lstat(unused),{code:'ENOENT'});
 }finally{await rm(work,{recursive:true,force:true});}
});

test('studio startup/polling reuse core checks, while explicit concurrent rechecks coalesce',async()=>{
 const work=await workspace();let server,diagnoses=0,programs=0,release;
 const gate=new Promise(resolve=>release=resolve);
 const missing=async()=>{programs++;throw Object.assign(Error('optional dependency missing'),{code:'EXECUTABLE_NOT_FOUND'});};
 try{
  server=await serve(work,0,{diagnoseRuntime:async options=>{diagnoses++;if(!options.programs)await gate;return diagnoseRuntime({...options,resolveBlender:missing,resolveProgram:missing});}});
  const url='http://127.0.0.1:'+server.address().port;
  const read=async path=>{const response=await fetch(url+path);assert.equal(response.status,200);return response.json();};
  const reports=await Promise.all([read('/api/studio'),read('/api/studio'),read('/api/doctor?cached=1')]);
  assert.equal(diagnoses,1);assert.equal(programs,0);assert.equal(reports[0].capabilities.runtime.workspace.status,'ready');assert.equal(reports[2].server.status,'ready');
  let requests=0;server.on('request',req=>{if(req.url==='/api/doctor')requests++;});
  const first=read('/api/doctor'),second=read('/api/doctor');
  const until=Date.now()+3000;while(requests<2&&Date.now()<until)await new Promise(setImmediate);
  assert.equal(requests,2);assert.equal(diagnoses,2);release();
  const checked=await Promise.all([first,second]);assert.equal(programs,2);assert.deepEqual(checked[0],checked[1]);assert.equal(checked[0].blender.status,'missing');assert.equal(checked[0].features.offlineServer,true);
  assert.equal((await read('/api/studio')).capabilities.runtime.codex.status,'missing');assert.equal(diagnoses,2);
 }finally{release();if(server)await close(server);await rm(work,{recursive:true,force:true});}
});

test('startup refuses an unsupported runtime or failed workspace before serving requests',async()=>{
 const work=await workspace();try{
  for(const mode of ['node','workspace'])await assert.rejects(serve(work,0,{diagnoseRuntime:async()=>({node:{supported:mode!=='node'},workspace:{status:mode==='workspace'?'error':'ready',error:'请选择可写目录'}})}),mode==='node'?/Node.js 22/:/可写目录/);
 }finally{await rm(work,{recursive:true,force:true});}
});

test('a real port conflict gives an actionable error and leaves the first service usable',async()=>{
 const first=await workspace(),second=await workspace();let server;
 try{
  server=await serve(first,0);await assert.rejects(serve(second,server.address().port),error=>error.code==='EADDRINUSE'&&error.message.includes('--port 0'));
  assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/session')).status,200);
 }finally{if(server)await close(server);await rm(first,{recursive:true,force:true});await rm(second,{recursive:true,force:true});}
});
