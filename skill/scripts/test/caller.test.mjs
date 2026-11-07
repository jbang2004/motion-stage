import {spawnSync} from 'node:child_process';
import {ROOT} from '../core.mjs';
import {callTool} from '../mcp.mjs';
import {listQueuedJobSummaries} from '../job-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {normalizeCaller,callerFromArgs,restoredDelivery,callerKey} from '../../assets/viewer/caller.mjs';
import {taskHandoff} from '../../assets/viewer/handoff.mjs';
import {atomic,importAsset} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {serve} from '../server.mjs';
import {createJob,claimJob,getJob,cancelJob,failJob,retryJob,replyJob,listJobSummaries,localEditJob} from '../jobs.mjs';
const a={client:'claude',sessionId:'chat-a'},b={client:'codex',sessionId:'chat-b'};
async function setup(t){const w=await mkdtemp(resolve(tmpdir(),'motion-caller-'));t.after(()=>rm(w,{recursive:true,force:true}));await atomic(resolve(w,'project.json'),{version:2,title:'Caller test',slots:{}});await atomic(resolve(w,'feedback.json'),{version:1,notes:[]});const asset=await importAsset(w,'baseline',await buildDemo(false),'base.glb');return {w,input:{request:'收小左臂摆幅',delivery:'chat',context:{slot:'baseline',asset,clip:'Run',time:.25}}};}
test('caller flags require an explicit pair; model is optional metadata, never inferred',()=>{
 assert.equal(callerFromArgs([]),null);
 for(const args of [['--caller','claude'],['--session','a'],['--caller'],['--caller-model','deepseek'],['--caller','claude','--session','$(open)']])assert.throws(()=>callerFromArgs(args));
 assert.equal(callerFromArgs(['--caller','workbuddy','--session','s-1','--caller-model','deepseek-v3']).client,'workbuddy');
 assert.throws(()=>normalizeCaller({...a,model:'bad\nmodel'}));
 for(const client of ['codex','claude','deepseek','workbuddy','another-agent'])assert.equal(normalizeCaller({...a,client}).transport,'handoff');
});
test('restoring a draft from another caller cannot silently select the Codex worker',()=>{
 const saved={executionMode:'worker',callerKey:callerKey(a)};
 assert.equal(restoredDelivery(saved,a),'worker');assert.equal(restoredDelivery(saved,b),'chat');assert.equal(restoredDelivery(saved,{...a,sessionId:'other'}),'chat');assert.equal(restoredDelivery({executionMode:'worker'},a),'chat');assert.equal(restoredDelivery({executionMode:'worker'},null),'chat');
});
test('two servers bind independently, ignore browser caller spoofing and preserve routing through reply/retry',async t=>{
 const {w,input}=await setup(t);const options={caller:{...a}},s1=await serve(w,0,options),s2=await serve(w,0,{caller:b});t.after(()=>{s1.close();s2.close();});options.caller.sessionId='mutated';
 const url=s=>'http://127.0.0.1:'+s.address().port;
 const session=await (await fetch(url(s1)+'/api/session')).json();assert.equal(session.caller.sessionId,'chat-a');
 const post=async(s,body)=>{const {token}=await(await fetch(url(s)+'/api/session')).json();const response=await fetch(url(s)+'/api/jobs',{method:'POST',headers:{'content-type':'application/json','x-motion-token':token},body:JSON.stringify(body)});const j=await response.json();assert.equal(response.status,200,JSON.stringify(j));return j;};
 const j=await post(s1,{...input,caller:b});assert.equal(j.caller.client,'claude');assert.equal(j.caller.sessionId,'chat-a');
 const identity={client:'claude',sessionId:'chat-a'};
 for(const caller of [undefined,b,{...identity,sessionId:'other'}])await assert.rejects(claimJob(w,j.id,{caller}),/原会话/);
 assert.equal((await getJob(w,j.id)).state,'queued');assert.equal((await listQueuedJobSummaries(w)).length,0);assert.equal((await listJobSummaries(w))[0].caller.client,'claude');
 assert.match(await readFile(j.taskPath,'utf8'),/--caller 'claude' --session 'chat-a'/);assert.equal(JSON.parse(await readFile(resolve(w,'jobs',j.id,'context.json'))).caller.sessionId,'chat-a');
 assert.match(taskHandoff(j,session.paths),/Claude[\s\S]*chat-a[\s\S]*--caller 'claude'/);
 let claim=await claimJob(w,j.id,{caller:identity});await failJob(w,j.id,{lease:claim.lease,state:'needs-input',error:'范围？'});await replyJob(w,j.id,{message:'整个动作'});await assert.rejects(claimJob(w,j.id,{caller:b}),/原会话/);
 claim=await claimJob(w,j.id,{caller:identity});await failJob(w,j.id,{lease:claim.lease,error:'retry test'});assert.equal((await retryJob(w,j.id)).caller.sessionId,'chat-a');await cancelJob(w,j.id);await assert.rejects(claimJob(w,j.id,{caller:identity}),/重复领取/);
 const second=await post(s2,input);assert.equal(second.caller.client,'codex');await cancelJob(w,second.id);
 const worker=await post(s2,{...input,delivery:'worker'});assert.equal(worker.caller,null);await cancelJob(w,worker.id);
 const local=await post(s1,{...input,executor:'local'});assert.equal(local.caller,null);assert.equal((await localEditJob(w,local.id,{bone:'LeftShoulder',factor:.7})).state,'complete');
});
test('legacy unbound chat tasks remain claimable without caller metadata',async t=>{
 const {w,input}=await setup(t);const j=await createJob(w,input);assert.equal(j.caller,null);assert.equal((await claimJob(w,j.id)).state,'running');
});

test('project opening never reuses another caller server, even for the same project',async t=>{
 const {w}=await setup(t),root=resolve(w,'game');await mkdir(root);const settingsPath=resolve(w,'settings.json');
 const servers=await Promise.all([serve(w,0,{caller:a,settingsPath}),serve(w,0,{caller:b,settingsPath})]);t.after(()=>servers.forEach(s=>s.close()));
 const open=async s=>{const url='http://127.0.0.1:'+s.address().port;const {token}=await(await fetch(url+'/api/session')).json();const r=await fetch(url+'/api/project/open',{method:'POST',headers:{'x-motion-token':token},body:JSON.stringify({path:root,adoptCurrent:false})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
 const first=await open(servers[0]),second=await open(servers[1]);assert.notEqual(first.url,second.url);assert.equal((await open(servers[0])).url,first.url);
 for(const [opened,caller] of [[first,a],[second,b]])assert.deepEqual((await(await fetch(opened.url+'api/session')).json()).caller,normalizeCaller(caller));
});
test('CLI and MCP enforce caller identity and return a usable lease to the right session',async t=>{
 const {w,input}=await setup(t),j=await createJob(w,{...input,caller:a});
 const run=extra=>spawnSync(process.execPath,[resolve(ROOT,'scripts/motion-feedback.mjs'),'claim','--workspace',w,'--job',j.id,...extra],{encoding:'utf8'});
 assert.notEqual(run([]).status,0);const cli=run(['--caller',a.client,'--session',a.sessionId]);assert.equal(cli.status,0,cli.stderr);assert.ok(JSON.parse(cli.stdout).lease);await cancelJob(w,j.id);
 const next=await createJob(w,{...input,caller:b});await assert.rejects(callTool(w,'motion_claim_job',{id:next.id,caller:a}),/原会话/);const claim=await callTool(w,'motion_claim_job',{id:next.id,caller:b});assert.equal(claim.state,'running');assert.ok(claim.lease);
});
