import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {readProject,projectView} from '../core.mjs';
import {proposeTask,listProposals,dropProposal} from '../proposals.mjs';
import {serve} from '../server.mjs';
import {pendingEdit,composeSource,versionNotice,proposalFor} from '../../assets/viewer/studio-sync.mjs';

const CLI=new URL('../motion-feedback.mjs',import.meta.url).pathname;

test('an agent drafts a chat request into the page; the page sees it, opening or dismissing drops it',async()=>{
 const work=await mkdtemp(join(tmpdir(),'motion-proposals-'));let server;
 try{
  await initializeWorkspace(work);
  const cfg=await readProject(work),id=cfg.activeAssetId,clip=projectView(cfg).slots.baseline.clips[0].name;
  await assert.rejects(proposeTask(work,{assetId:id,clip:'没有这个动作',request:'收小摆臂'}),/没有动作/);
  await assert.rejects(proposeTask(work,{assetId:id,clip,request:'  '}),/request/);
  await assert.rejects(proposeTask(work,{assetId:'nope',clip,request:'收小摆臂'}),/模型不存在/);
  await assert.rejects(proposeTask(work,{assetId:id,clip,request:'收小摆臂',source:'later'}),/--source/);
  await assert.rejects(proposeTask(work,{assetId:id,clip,request:'收小摆臂',parentJobId:'00000000-0000-0000-0000-000000000000'}),/父任务/);
  const {stdout}=await promisify(execFile)(process.execPath,[CLI,'propose','--workspace',work,'--asset-id',id,'--clip',clip,
   '--request','右臂跟左臂一样的幅度，握刀的手自然','--caller','claude','--session','s-1']);
  const made=JSON.parse(stdout);
  assert.equal(made.request,'右臂跟左臂一样的幅度，握刀的手自然');assert.equal(made.caller.client,'claude');assert.equal(made.source,null);
  const newer=await proposeTask(work,{assetId:id,clip,request:'只收小右臂'});
  assert.deepEqual((await listProposals(work,id)).map(p=>p.id),[newer.id],'one draft a clip: the newest replaces the older');
  server=await serve(work,0);const url='http://127.0.0.1:'+server.address().port;
  const studio=await(await fetch(url+'/api/studio?compact=1')).json();
  assert.equal(studio.proposals[0].id,newer.id);
  const token=(await(await fetch(url+'/api/session')).json()).token;
  const drop=await fetch(url+'/api/proposals/'+newer.id+'/drop',{method:'POST',headers:{'x-motion-token':token},body:'{}'});
  assert.equal(drop.status,200);assert.deepEqual(await drop.json(),{dropped:true});
  assert.deepEqual(await listProposals(work,id),[]);
  assert.deepEqual(await dropProposal(work,newer.id),{dropped:false});
  const again=await(await fetch(url+'/api/studio?compact=1&since='+studio.revision)).json();
  assert.ok(!again.unchanged,'a dropped draft changes the studio snapshot');assert.deepEqual(again.proposals,[]);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(work,{recursive:true,force:true});}
});

test('the stage says when it shows the game version while an edit waits, and a new edit starts from that edit',()=>{
 const base={sha256:'a'.repeat(64),file:'assets/a.glb'},head={sha256:'b'.repeat(64),file:'assets/b.glb'};
 const project={activeAssetId:'m',slots:{baseline:base,candidate:head}};
 const job={id:'j',assetId:'m',state:'complete',clip:'Run',candidate:head,artisticDecision:null,review:null};
 assert.equal(pendingEdit([],{activeAssetId:'m',slots:{baseline:base}}),null,'no candidate');
 assert.equal(pendingEdit([],{activeAssetId:'m',slots:{baseline:base,candidate:base}}),null,'the candidate is the game version');
 const review=pendingEdit([job],project);
 assert.equal(review.status,'review');assert.equal(review.clip,'Run');assert.equal(composeSource(review),'candidate');
 assert.match(versionNotice(review,{focus:'baseline',clip:'Run'}),/等你评审/);
 assert.equal(versionNotice(review,{focus:'candidate',clip:'Run'}),null,'already looking at the edit');
 assert.equal(versionNotice(review,{focus:'baseline',clip:'Idle'}),null,'another clip');
 const accepted=pendingEdit([{...job,artisticDecision:'accept-candidate',review:{decision:'accept-candidate'}}],project);
 assert.equal(accepted.status,'accepted');assert.match(versionNotice(accepted,{focus:'baseline',clip:'Run'}),/不含已采用的修改/);
 assert.equal(versionNotice({...accepted,integrated:true},{focus:'baseline',clip:'Run'}),null,'already in the game');
 assert.equal(pendingEdit([{...job,artisticDecision:'keep-baseline',review:{decision:'keep-baseline'}}],project),null,'turned down');
 assert.equal(composeSource(null),'baseline');
 const imported=pendingEdit([],project);
 assert.equal(imported.status,'imported');assert.match(versionNotice(imported,{focus:'baseline',clip:'Idle'}),/未经任务评审/);
 const drafts=[{id:'1',assetId:'m',clip:'Idle',createdAt:'2026-01-02'},{id:'2',assetId:'m',clip:'Run',createdAt:'2026-01-01'},{id:'3',assetId:'x',clip:'Run',createdAt:'2026-01-03'}];
 assert.equal(proposalFor(drafts,{assetId:'m',clip:'Run'}).id,'2');assert.equal(proposalFor(drafts,{assetId:'m',clip:'Walk'}).id,'1');assert.equal(proposalFor(drafts,{assetId:'y'}),null);
});
