import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProviders} from '../agent-providers.mjs';
import {atomic,importAsset} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {createJob,getJob,cancelJob} from '../jobs.mjs';
import {startWorker} from '../agent-worker.mjs';
test('discovery distinguishes command support, app-only discovery and missing clients without a model call',async()=>{
 const commands=[];const r=await scanProviders({platform:'darwin',resolveProgram:async id=>{if(['codex','claude'].includes(id))return id;throw Error('missing');},execProgram:async(cmd,args)=>{commands.push(args);return {stdout:args[0]==='--help'?'--print --output-format --json-schema':'test-v1'};},exists:async p=>p.endsWith('DeepSeek Harness.app')});
 assert.deepEqual(r.providers.filter(p=>p.available).map(p=>p.id),['codex','claude']);assert.equal(r.providers.find(p=>p.id==='deepseek').available,false);assert.equal(r.providers.find(p=>p.id==='workbuddy').status,'missing');assert.ok(commands.every(a=>['--help','--version'].includes(a[0])));
});
test('unsupported Claude CLI stays unavailable',async()=>{const r=await scanProviders({resolveProgram:async()=>'/fake',execProgram:async()=>({stdout:'old'}),exists:async()=>false});assert.equal(r.providers.find(p=>p.id==='claude').available,false);});
test('Claude worker consumes only explicitly addressed tasks and validates returned candidate',async()=>{
 const w=await mkdtemp(join(tmpdir(),'motion-claude-')),old=process.env.CLAUDE_EXECUTABLE;
 try{await atomic(join(w,'project.json'),{version:2,title:'Test',slots:{}});await atomic(join(w,'feedback.json'),{version:1,notes:[]});const asset=await importAsset(w,'baseline',await buildDemo(false),'base.glb');const candidate=join(w,'candidate.glb');await writeFile(candidate,await buildDemo(true));
 const exe=join(w,'claude.cjs');await writeFile(exe,`const fs=require('node:fs');if(process.argv.includes('--version')){console.log('fixture');process.exit(0)}if(process.argv.includes('--help')){console.log('--print --output-format --json-schema');process.exit(0)}if(!process.argv.includes('--print')||process.argv.includes('--dangerously-skip-permissions'))process.exit(5);process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync('candidate.glb',fs.readFileSync(${JSON.stringify(candidate)}));console.log(JSON.stringify({type:'result',structured_output:{status:'complete',summary:'Fixture edited candidate',candidate:'candidate.glb',reason:''}}))});`);process.env.CLAUDE_EXECUTABLE=exe;
 const input={request:'测试左臂',context:{slot:'baseline',asset,clip:'Run',time:.2}};
 const first=await createJob(w,input);await startWorker(w,{once:true,provider:'claude'});assert.equal((await getJob(w,first.id)).state,'queued');await cancelJob(w,first.id);
 const second=await createJob(w,{...input,provider:'claude'});await startWorker(w,{once:true,provider:'claude'});const done=await getJob(w,second.id);assert.equal(done.state,'complete',done.error);assert.equal(done.provider,'claude');assert.equal(done.owner,'claude-cli');assert.notEqual(done.candidate.sha256,asset.sha256);
 await writeFile(exe,`if(process.argv.includes('--version')){console.log('fixture');process.exit(0)}if(process.argv.includes('--help')){console.log('--print --output-format --json-schema');process.exit(0)}process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',is_error:true,result:'Authentication required; login first'})));`);
 const failed=await createJob(w,{...input,provider:'claude'});await startWorker(w,{once:true,provider:'claude'});const error=await getJob(w,failed.id);assert.equal(error.state,'needs-input');assert.match(error.error,/Authentication/);assert.equal(error.provider,'claude');
 }finally{if(old===undefined)delete process.env.CLAUDE_EXECUTABLE;else process.env.CLAUDE_EXECUTABLE=old;await rm(w,{recursive:true,force:true});}
});
