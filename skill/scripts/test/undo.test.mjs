import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {callTool} from '../mcp.mjs';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {ROOT,readProject,modelSlots,importAsset} from '../core.mjs';
import {createJob,claimJob,completeJob,reviewJob,getJob,cancelJob} from '../jobs.mjs';
import {buildDemo} from '../practice.mjs';
import {motionLibrary,registerMotionPack,previewMotion,adoptMotion,removeMotion} from '../motion-library.mjs';
import {undoStatus,applyUndo} from '../undo.mjs';
import {serve} from '../server.mjs';
async function setup(fn){const w=await mkdtemp(join(tmpdir(),'motion-undo-'));try{await initializeWorkspace(w);const cfg=await readProject(w);await fn(w,cfg.activeAssetId);}finally{await rm(w,{recursive:true,force:true});}}
async function input(w,id){const heads=modelSlots(await readProject(w),id);return {assetId:id,request:'收小左臂摆幅',target:{bone:'LeftShoulder'},scope:{wholeClip:true},context:{assetId:id,slot:'baseline',asset:heads.baseline,clip:'Run',time:.2,slots:Object.fromEntries(Object.entries(heads).map(([k,v])=>[k,{...v,clip:'Run',time:.2}]))}};}
async function complete(w,id){const j=await createJob(w,await input(w,id)),c=await claimJob(w,j.id);const path=join(w,'result.glb');await writeFile(path,await buildDemo(true));return completeJob(w,j.id,{lease:c.lease,candidatePath:path,summary:'测试候选'});}
async function run(w,id,direction='undo'){const h=await undoStatus(w,id);return applyUndo(w,{assetId:id,direction,expectedRevision:h.revision,entryId:h[direction]?.id});}
async function adopt(w,id){const cfg=await readProject(w),target={assetId:id,slot:'baseline',expectedModelSha:modelSlots(cfg,id).baseline.sha256},lib=await motionLibrary(w),p=await registerMotionPack(w,{...target,expectedRevision:lib.revision}),request={...target,packId:p.pack.id,versionId:p.version.id,clip:p.version.clips[0].name},preview=await previewMotion(w,request);return adoptMotion(w,{...request,expectedRevision:p.revision,previewId:preview.recipe.id});}

test('accept undo/redo survives reload, restores exact source bytes and keeps immutable decisions',()=>setup(async(w,id)=>{
 const j=await complete(w,id),stamps=await Promise.all([j.inputs.baseline,j.candidate].map(a=>stat(join(w,a.file)).then(s=>s.mtimeMs))),accepted=await reviewJob(w,j.id,{decision:'accept-candidate'}),point=accepted.reviews.at(-1).checkpointFile;
 assert.equal((await undoStatus(w,id)).undo.label,'采用这版');
 await run(w,id);assert.equal(modelSlots(await readProject(w),id).candidate.sha256,j.inputs[j.slot].sha256);assert.equal((await getJob(w,j.id)).artisticDecision,'revise');assert.ok(await readFile(join(w,point)));
 await run(w,id,'redo');assert.equal(modelSlots(await readProject(w),id).candidate.sha256,j.candidate.sha256);assert.equal((await getJob(w,j.id)).artisticDecision,'accept-candidate');assert.equal((await getJob(w,j.id)).reviews.length,3);
 await run(w,id);assert.equal((await undoStatus(w,id)).undo,null);assert.equal((await undoStatus(w,id)).redo.label,'采用这版');assert.deepEqual(await Promise.all([j.inputs.baseline,j.candidate].map(a=>stat(join(w,a.file)).then(s=>s.mtimeMs))),stamps);
}));
test('unused candidate undo returns completed candidate without another execution',()=>setup(async(w,id)=>{
 const j=await complete(w,id);await reviewJob(w,j.id,{decision:'keep-baseline'});assert.equal(modelSlots(await readProject(w),id).candidate.sha256,j.inputs.baseline.sha256);
 await run(w,id);assert.equal(modelSlots(await readProject(w),id).candidate.sha256,j.candidate.sha256);assert.equal((await getJob(w,j.id)).state,'complete');
 await run(w,id,'redo');assert.equal(modelSlots(await readProject(w),id).candidate.sha256,j.inputs.baseline.sha256);
}));
test('adopt/remove form one operation each; undo retains exact recipe, model and source bytes',()=>setup(async(w,id)=>{
 const a=await adopt(w,id),cfg=await readFile(join(w,'project.json')),lib=await motionLibrary(w);await removeMotion(w,{assetId:id,actionId:a.action.id,expectedRevision:lib.revision});
 assert.equal((await motionLibrary(w)).characters[id].length,0);await run(w,id);assert.deepEqual((await motionLibrary(w)).characters[id][0],a.action);await run(w,id);assert.equal((await motionLibrary(w)).characters[id].length,0);
 await run(w,id,'redo');await run(w,id,'redo');assert.equal((await motionLibrary(w)).characters[id].length,0);assert.deepEqual(await readFile(join(w,'project.json')),cfg);assert.ok(await readFile(join(w,a.action.recipe.motionFile)));
}));
test('history is scoped by model, concurrent undo is CAS guarded and new changes clear redo',()=>setup(async(w,id)=>{
 const a=await adopt(w,id),base=modelSlots(await readProject(w),id).baseline;const other=await importAsset(w,'baseline',await readFile(join(w,base.file)),'另一个角色',{newModel:true});await adopt(w,other.assetId);
 assert.equal((await undoStatus(w,id)).reason,'');const h=await undoStatus(w,id),args={assetId:id,expectedRevision:h.revision,entryId:h.undo.id};const results=await Promise.allSettled([applyUndo(w,args),applyUndo(w,args)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await motionLibrary(w)).characters[other.assetId].length,1);
 await adopt(w,id);assert.equal((await undoStatus(w,id)).redo,null);assert.equal((await motionLibrary(w)).characters[id][0].recipe.id,a.action.recipe.id);
}));
test('active work blocks undo; cancel does not restart it and late completion cannot change heads',()=>setup(async(w,id)=>{
 await adopt(w,id);const j=await createJob(w,await input(w,id)),claim=await claimJob(w,j.id);assert.match((await undoStatus(w,id)).reason,/停止或完成/);await assert.rejects(run(w,id),/停止或完成/);await cancelJob(w,j.id);assert.equal((await undoStatus(w,id)).reason,'');await run(w,id);await run(w,id,'redo');assert.equal((await getJob(w,j.id)).state,'cancelled');
 const head=modelSlots(await readProject(w),id).candidate.sha256,path=join(w,'late.glb');await writeFile(path,await buildDemo(true));await assert.rejects(completeJob(w,j.id,{lease:claim.lease,candidatePath:path,summary:'迟到'}),/租约/);assert.equal(modelSlots(await readProject(w),id).candidate.sha256,head);
}));
test('external ABA head changes invalidate history even when bytes match again',()=>setup(async(w,id)=>{
 await adopt(w,id);const head=modelSlots(await readProject(w),id).candidate,old=await readFile(join(w,head.file));await importAsset(w,'candidate',await buildDemo(true),'other',{assetId:id});await importAsset(w,'candidate',old,'same',{assetId:id});assert.match((await undoStatus(w,id)).reason,/版本已变化/);await assert.rejects(run(w,id),/版本已变化/);
}));
test('HTTP history/removal require token and reject stale revisions',()=>setup(async(w,id)=>{
 await adopt(w,id);const server=await serve(w,0);try{const url='http://127.0.0.1:'+server.address().port,session=await(await fetch(url+'/api/session')).json(),h=await(await fetch(url+'/api/undo?assetId='+id)).json(),args={assetId:id,expectedRevision:h.revision,entryId:h.undo.id};
 const post=(route,body,token=session.token)=>fetch(url+route,{method:'POST',headers:{'x-motion-token':token},body:JSON.stringify(body)});assert.equal((await post('/api/undo',args,'wrong')).status,403);assert.equal((await post('/api/undo',args)).status,200);assert.notEqual((await post('/api/undo',args)).status,200);assert.equal((await motionLibrary(w)).characters[id].length,0);
 }finally{await new Promise(r=>server.close(r));}
}));

test('CLI and MCP use the same persisted revision and exact entry guard',()=>setup(async(w,id)=>{
 await adopt(w,id);const h=await callTool(w,'motion_undo_status',{assetId:id}),cli=spawnSync(process.execPath,[join(ROOT,'scripts/motion-feedback.mjs'),'undo','--workspace',w,'--asset-id',id,'--expected-revision',String(h.revision),'--entry',h.undo.id],{encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).history.redo.id,h.undo.id);
 const after=await callTool(w,'motion_undo_status',{assetId:id});await callTool(w,'motion_undo',{assetId:id,direction:'redo',expectedRevision:after.revision,entryId:after.redo.id});assert.equal((await motionLibrary(w)).characters[id].length,1);
}));
test('undoing a historical review never replaces the newer current head',()=>setup(async(w,id)=>{
 const j=await complete(w,id);await importAsset(w,'candidate',await buildDemo(false),'new current',{assetId:id});const current=modelSlots(await readProject(w),id).candidate.sha256;
 await reviewJob(w,j.id,{decision:'accept-candidate'});await run(w,id);assert.equal(modelSlots(await readProject(w),id).candidate.sha256,current);assert.equal((await getJob(w,j.id)).artisticDecision,'revise');await run(w,id,'redo');assert.equal(modelSlots(await readProject(w),id).candidate.sha256,current);
}));
test('multiple accepted generations keep a continuous undo chain including A → B → A bytes',()=>setup(async(w,id)=>{
 const first=await complete(w,id);await reviewJob(w,first.id,{decision:'accept-candidate'});
 const request=await input(w,id),heads=modelSlots(await readProject(w),id);request.context.slot='candidate';request.context.asset=heads.candidate;request.parentJobId=first.id;
 const second=await createJob(w,request),claim=await claimJob(w,second.id),path=join(w,'second.glb');await writeFile(path,await readFile(join(w,first.inputs.baseline.file)));await completeJob(w,second.id,{lease:claim.lease,candidatePath:path,summary:'第二轮候选'});await reviewJob(w,second.id,{decision:'accept-candidate'});
 await run(w,id);assert.equal(modelSlots(await readProject(w),id).candidate.sha256,first.candidate.sha256);assert.equal((await undoStatus(w,id)).undo.jobId,first.id);
 await run(w,id);assert.equal(modelSlots(await readProject(w),id).candidate.sha256,first.inputs.baseline.sha256);await run(w,id,'redo');assert.equal(modelSlots(await readProject(w),id).candidate.sha256,first.candidate.sha256);await run(w,id,'redo');assert.equal(modelSlots(await readProject(w),id).candidate.sha256,first.inputs.baseline.sha256);
}));
