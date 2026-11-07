import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDeepSeekEvents} from '../deepseek-events.mjs';
import {desktopModelSelection,prepareDeepSeekProfile} from '../deepseek-profile.mjs';
import {providerLocations,probeProvider} from '../agent-providers.mjs';
import {atomic,importAsset} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {createJob,getJob,cancelJob,retryJob} from '../jobs.mjs';
import {startWorker} from '../agent-worker.mjs';
const outcome={status:'complete',summary:'已调整左肩',candidate:'candidate.glb',reason:''};
test('Harness protocol requires a matching session and successful terminal; thinking never becomes progress',()=>{
 const sessions=[],activities=[],p=createDeepSeekEvents({onSession:id=>sessions.push(id),onActivity:t=>activities.push(t)});
 p.receive({type:'session',sessionId:'session-test'});assert.equal(p.receive({type:'thinking',text:'private chain'}),null);assert.equal(p.receive({type:'text',text:'speculative prose'}),null);
 const safe=p.receive({type:'tool_call',callId:'a',input:{secret:'x'}});assert.equal('input' in safe,false);p.receive({type:'final',sessionId:'session-test',reason:{kind:'completed'},text:JSON.stringify(outcome)});assert.deepEqual(p.result(),outcome);assert.deepEqual(sessions,['session-test']);assert.equal(activities.length,1);
 for(const end of [{sessionId:'session-other',reason:{kind:'completed'},text:JSON.stringify(outcome)},{sessionId:'session-test',reason:{kind:'error',error:{message:'auth failed'}},text:JSON.stringify(outcome)},{sessionId:'session-test',reason:{kind:'completed'},text:'not JSON'}]){const s=createDeepSeekEvents();s.receive({type:'session',sessionId:'session-test'});s.receive({type:'final',...end});assert.throws(()=>s.result());}
 assert.throws(()=>createDeepSeekEvents().result());
});
test('discovery uses dsh and bundled macOS launcher without changing PATH; overrides are explicit',async()=>{
 const location=providerLocations('deepseek',{env:{},platform:'darwin'});assert.equal(location.name,'dsh');assert.ok(location.options.candidates[0].endsWith('runtime/cli/bin/dsh'));
 assert.equal(providerLocations('deepseek',{env:{DSH_EXECUTABLE:'/custom/dsh'},platform:'linux'}).options.explicit,'/custom/dsh');assert.deepEqual(providerLocations('deepseek',{env:{},platform:'win32'}).options.candidates,[]);
 const calls=[];const probe=await probeProvider('deepseek',{resolveProgram:async(name,opts)=>{assert.equal(name,'dsh');return '/bundle/dsh';},execProgram:async(_,args)=>{calls.push(args);return {stdout:args[0]==='--version'?'0.2.2':'--json --permission-mode --approval-policy'};}});assert.equal(probe.available,true);assert.deepEqual(calls,[['--version'],['headless','--help']]);
});
test('per-run profile restores managed login and only copies declarative desktop model settings',async()=>{
 const w=await mkdtemp(join(tmpdir(),'dsh-profile-'));try{await mkdir(join(w,'profiles','desktop'),{recursive:true});const file=join(w,'profiles','desktop','cordis.patch.yml'),original='- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: "deepseek-flash"\n    reasoningEffort: max\n- id: unrelated\n  config:\n    token: do-not-copy\n';await writeFile(file,original);
 const {file:patch,selection}=await prepareDeepSeekProfile(w,{env:{DSH_HOME:w}});assert.equal(selection.model,'deepseek-flash');const text=await readFile(patch,'utf8');assert.doesNotMatch(text,/do-not-copy/);assert.ok(JSON.parse(text).some(r=>r.id==='credentials'&&r.disabled===false));assert.equal(await readFile(file,'utf8'),original);
 assert.throws(()=>desktopModelSelection('- id: agent-default-model\n  config:\n    provider: !!js execute()\n    model: a\n'));assert.equal(desktopModelSelection('[]'),null);
 }finally{await rm(w,{recursive:true,force:true});}
});
test('Harness process integration returns candidate, retains sessions on retry, rejects errors and stops cancellation',async()=>{
 const w=await mkdtemp(join(tmpdir(),'motion-dsh-')),previous={DEEPSEEK_EXECUTABLE:process.env.DEEPSEEK_EXECUTABLE,DSH_HOME:process.env.DSH_HOME};
 try{
 await atomic(join(w,'project.json'),{version:2,title:'DeepSeek test',slots:{}});await atomic(join(w,'feedback.json'),{version:1,notes:[]});const asset=await importAsset(w,'baseline',await buildDemo(false),'base.glb');const candidate=join(w,'changed.glb');await writeFile(candidate,await buildDemo(true));const exe=join(w,'dsh.cjs');process.env.DEEPSEEK_EXECUTABLE=exe;process.env.DSH_HOME=w;
 const fake=async mode=>writeFile(exe,`const fs=require('node:fs'),a=process.argv.slice(2);if(a[0]==='--version'){console.log('fixture');process.exit(0)}if(a.includes('--help')){console.log('--json --permission-mode --approval-policy');process.exit(0)}if(a[a.indexOf('--permission-mode')+1]!=='workspace-write'||a[a.indexOf('--approval-policy')+1]!=='never')process.exit(9);const patch=JSON.parse(fs.readFileSync(a[a.indexOf('--patch')+1]));if(!patch.some(r=>r.id==='credentials'&&r.disabled===false))process.exit(8);process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'session',sessionId:'session-fixture'}));console.log(JSON.stringify({type:'thinking',text:'private chain'}));if(${JSON.stringify(mode)}==='wait'){setInterval(()=>{},1000);return}if(${JSON.stringify(mode)}==='auth'){console.log(JSON.stringify({type:'error',message:'MISSING_CREDENTIAL: sign in required'}));process.exitCode=1;return}fs.writeFileSync('candidate.glb',fs.readFileSync(${JSON.stringify(candidate)}));console.log(JSON.stringify({type:'tool_result',callId:'c',status:'completed',result:'secret raw output'}));process.stdout.write(JSON.stringify({type:'final',sessionId:'session-fixture',reason:{kind:'completed'},text:JSON.stringify(${JSON.stringify(outcome)})}));});`);
 const input={request:'调整左肩',context:{slot:'baseline',asset,clip:'Run',time:.2},provider:'deepseek'};
 await fake('auth');const failed=await createJob(w,input);await startWorker(w,{once:true,provider:'deepseek'});let j=await getJob(w,failed.id);assert.equal(j.state,'needs-input');assert.equal(j.providerSession.sessionId,'session-fixture');await cancelJob(w,j.id);
 await fake('success');const job=await createJob(w,input);await startWorker(w,{once:true,provider:'deepseek'});j=await getJob(w,job.id);assert.equal(j.state,'complete',j.error);assert.equal(j.owner,'deepseek-cli');assert.equal(j.providerSession.attemptId,j.attemptId);assert.doesNotMatch(await readFile(join(w,j.outputDirectory,'events.jsonl'),'utf8'),/private chain|secret raw output/);
 await fake('wait');const timed=await createJob(w,input);await startWorker(w,{once:true,provider:'deepseek',timeoutMs:1000});const beforeRetry=await getJob(w,timed.id);assert.equal(beforeRetry.state,'interrupted');assert.ok(beforeRetry.providerSession);const retried=await retryJob(w,timed.id);assert.equal(retried.providerSession,undefined);assert.equal(retried.attempts.at(-1).providerSession.sessionId,'session-fixture');await cancelJob(w,timed.id);
 await fake('wait');const stopped=await createJob(w,input),run=startWorker(w,{once:true,provider:'deepseek',pollMs:10,timeoutMs:15000});
 for(let i=0;i<200;i++){if((await getJob(w,stopped.id)).providerSession)break;await new Promise(r=>setTimeout(r,20));}assert.ok((await getJob(w,stopped.id)).providerSession);await cancelJob(w,stopped.id);await run;assert.equal((await getJob(w,stopped.id)).state,'cancelled');
 }finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(w,{recursive:true,force:true});}
});
