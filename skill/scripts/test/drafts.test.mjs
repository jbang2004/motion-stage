import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {readProject} from '../core.mjs';
import {readDraft,saveDraft} from '../drafts.mjs';
import {serve} from '../server.mjs';
import {createDraftSync} from '../../assets/viewer/draft-sync.mjs';
test('drafts survive new server ports and reject concurrent overwrite',async()=>{
 const work=await mkdtemp(join(tmpdir(),'motion-drafts-'));let a,b;
 try{
  await initializeWorkspace(work);const id=(await readProject(work)).activeAssetId,draft={assetId:id,context:{assetId:id},request:'左臂收一点',preserve:'保持脚步'};
  a=await serve(work,0);const url='http://127.0.0.1:'+a.address().port,session=await (await fetch(url+'/api/session')).json();
  const post=await fetch(url+'/api/drafts/'+id,{method:'POST',headers:{'x-motion-token':session.token},body:JSON.stringify({expectedRevision:0,draft})});assert.equal(post.status,200);
  b=await serve(work,0);const restored=await(await fetch('http://127.0.0.1:'+b.address().port+'/api/drafts/'+id)).json();assert.equal(restored.draft.request,draft.request);
  const conflict=await saveDraft(work,id,{expectedRevision:0,draft:{...draft,request:'另一窗口'}});assert.equal(conflict.conflict,true);assert.equal((await readDraft(work,id)).draft.request,draft.request);
  await assert.rejects(saveDraft(work,id,{expectedRevision:1,draft:{...draft,assetId:'wrong'}}),/身份/);
 }finally{await Promise.all([a,b].filter(Boolean).map(s=>new Promise(r=>s.close(r))));await rm(work,{recursive:true,force:true});}
});
test('client keeps local text on conflict and resolves explicitly',async()=>{
 let record={revision:1,draft:{request:'原稿'}},statuses=[];
 const client=createDraftSync({load:async()=>record,save:async(id,input)=>input.expectedRevision!==record.revision?{conflict:true,current:record}:(record={revision:record.revision+1,draft:input.draft}),onStatus:(id,s)=>statuses.push(s)});
 await client.restore('a');record={revision:2,draft:{request:'其他窗口'}};
 await client.persist('a',{request:'本窗口'});assert.equal(statuses.at(-1),'conflict');assert.equal((await client.restore('a')).request,'本窗口');assert.equal(record.draft.request,'其他窗口');
 await client.resolve('a','local');assert.equal(record.draft.request,'本窗口');assert.equal(record.revision,3);
});
test('playback alone does not write; paused seeks and request edits do',async()=>{
 let writes=0,record={revision:1,draft:{request:'保持脚步',pausedTime:null,context:{time:0,frame:0,slots:{baseline:{time:0}},normalization:{baseline:{displayOffset:[0,0,0]}}}}};
 const client=createDraftSync({load:async()=>record,save:async(id,input)=>{writes++;return record={revision:record.revision+1,draft:input.draft};}});
 const draft=structuredClone(await client.restore('a'));draft.context.time=.4;draft.context.frame=12;draft.context.slots.baseline.time=.4;draft.context.normalization.baseline.displayOffset=[1,0,0];await client.persist('a',draft);assert.equal(writes,0);
 await client.persist('a',{...draft,pausedTime:.4});assert.equal(writes,1);await client.persist('a',{...draft,pausedTime:.4,request:'新要求'});assert.equal(writes,2);
});
test('edits made while a save is pending are serialized and retain the latest text',async()=>{
 let release,inputs=[];const gate=new Promise(r=>release=r);let record={revision:0,draft:null};
 const client=createDraftSync({load:async()=>record,save:async(id,input)=>{inputs.push(input);if(inputs.length===1)await gate;return record={revision:record.revision+1,draft:input.draft};}});
 await client.restore('a');const saving=client.persist('a',{request:'第一句'});await client.persist('b',{request:'另一角色'});client.persist('a',{request:'最新一句'});release();await saving;
 assert.equal(inputs.filter(i=>i.draft.request!=='另一角色').at(-1).draft.request,'最新一句');assert.equal((await client.restore('a')).request,'最新一句');
});
test('offline saves preserve local text, and choosing the other window restores its draft',async()=>{
 let offline=true,record={revision:1,draft:{request:'远端'}};
 const client=createDraftSync({load:async()=>{if(offline)throw Error('offline');return record;},save:async()=>({conflict:true,current:record})});
 await client.persist('a',{request:'离线输入'});assert.equal((await client.restore('a')).request,'离线输入');offline=false;
 await client.persist('a',{request:'离线输入'});await client.resolve('a','remote');assert.equal((await client.restore('a')).request,'远端');
});
