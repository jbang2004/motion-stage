import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {readProject,modelSlots,importAsset,sha} from '../core.mjs';
import {motionLibrary,registerMotionPack,previewMotion,adoptMotion,materializeMotion,saveMotionMapping,motionRigOptions} from '../motion-library.mjs';
import {parseGlb,encodeGlb} from '../asset-tools.mjs';
import {serve} from '../server.mjs';
import {previewReplacement,replaceAction,listReplacementPlans,withdrawReplacementPlan} from '../action-replacement.mjs';
import {applyUndo,undoStatus} from '../undo.mjs';
async function setup(fn){const w=await mkdtemp(join(tmpdir(),'motion-separated-'));try{await initializeWorkspace(w);const cfg=await readProject(w),assetId=cfg.activeAssetId;return await fn(w,{assetId,slot:'baseline',expectedModelSha:modelSlots(cfg,assetId).baseline.sha256});}finally{await rm(w,{recursive:true,force:true});}}
async function register(w,target){return registerMotionPack(w,{...target,expectedRevision:0,name:'公共人形动作'});}
const request=(target,p)=>({...target,packId:p.pack.id,versionId:p.version.id,clip:p.version.clips[0].name});
test('replacement plans leave model heads and assets intact, accumulate by clip, and support undo and redo',()=>setup(async(w,t)=>{
 const input={...t,clip:'Run',source:{kind:'own',name:'Salute'}};
 const project=await readFile(join(w,'project.json')),files=await readdir(join(w,'assets')),preview=await previewReplacement(w,input);
 const first=await replaceAction(w,{...input,previewId:preview.previewId});
 assert.deepEqual(await readFile(join(w,'project.json')),project);
 assert.deepEqual(await readdir(join(w,'assets')),files);
 assert.equal(first.plan.source.clip,'Salute');
 await assert.rejects(replaceAction(w,{...input,previewId:preview.previewId}),/方案已更新/);
 const replay=await previewReplacement(w,{...input,source:{kind:'plan',id:first.plan.id}});
 assert.equal(replay.action.name,'Salute');
 const lib=await registerMotionPack(w,{...t,expectedRevision:0});
 const source={...request(t,lib),clip:'Run'};
 const sample=await previewMotion(w,source),adopted=await adoptMotion(w,{...source,previewId:sample.recipe.id,expectedRevision:1});
 const next={...input,clip:'Salute',source:{kind:'saved',id:adopted.action.id}};
 const second=await replaceAction(w,{...next,previewId:(await previewReplacement(w,next)).previewId});
 assert.deepEqual(second.plans.map(plan=>plan.clip),['Run','Salute']);
 assert.deepEqual(await readFile(join(w,'project.json')),project);
 const undo=await undoStatus(w,t.assetId);
 const rolledBack=await applyUndo(w,{assetId:t.assetId,expectedRevision:undo.revision,entryId:undo.undo.id});
 assert.deepEqual(rolledBack.replacementPlans,[first.plan]);
 const redo=await undoStatus(w,t.assetId);
 await applyUndo(w,{assetId:t.assetId,direction:'redo',expectedRevision:redo.revision,entryId:redo.redo.id});
 assert.deepEqual((await listReplacementPlans(w,t.assetId)).plans,second.plans);
 const withdrawal=await withdrawReplacementPlan(w,{assetId:t.assetId,id:first.plan.id});
 assert.deepEqual(withdrawal.plans.map(plan=>plan.clip),['Salute']);
 const restore=await undoStatus(w,t.assetId);
 await applyUndo(w,{assetId:t.assetId,expectedRevision:restore.revision,entryId:restore.undo.id});
 assert.deepEqual((await listReplacementPlans(w,t.assetId)).plans,second.plans);
}));
test('shared motion contains reference skeleton and curves without geometry or skin',()=>setup(async(w,t)=>{
 const p=await register(w,t),d=parseGlb(await readFile(join(w,p.version.file))).doc;
 assert.equal(d.meshes,undefined);assert.equal(d.materials,undefined);assert.equal(d.skins,undefined);assert.ok(d.nodes.length);assert.equal(d.animations.length,2);
 assert.ok(p.version.bytes<(await readFile(join(w,modelSlots(await readProject(w),t.assetId).baseline.file))).length);
 const again=await registerMotionPack(w,{...t,expectedRevision:1});assert.equal(again.reused,true);assert.equal(again.revision,1);
}));
test('preview and adoption change no model bytes or heads; action versions pin old source versions',()=>setup(async(w,t)=>{
 const p=await register(w,t),before=await readFile(join(w,'project.json')),files=await readdir(join(w,'assets')),input=request(t,p),preview=await previewMotion(w,input);
 assert.equal(preview.status,'compatible');assert.ok(preview.clips[0].tracks.length);const firstValue=preview.clips[0].tracks[0].values[0];preview.clips[0].tracks[0].values[0]=123456;assert.equal((await previewMotion(w,input)).clips[0].tracks[0].values[0],firstValue,'callers cannot mutate derived caches');
 const action=await adoptMotion(w,{...input,previewId:preview.recipe.id,expectedRevision:1,name:'跑步'});
 assert.equal(action.action.number,1);assert.deepEqual(await readFile(join(w,'project.json')),before);assert.deepEqual(await readdir(join(w,'assets')),files);
 assert.equal((await motionLibrary(w)).characters[t.assetId][0].recipe.versionId,p.version.id);
 assert.equal((await adoptMotion(w,{...input,previewId:preview.recipe.id,expectedRevision:2,name:'跑步'})).reused,true);
 await assert.rejects(adoptMotion(w,{...input,previewId:'wrong',expectedRevision:2}),/试播组合/);
}));
test('one shared pack can drive two distinct compatible models without duplicating geometry',()=>setup(async(w,t)=>{
 const p=await register(w,t),cfg=await readProject(w),base=await readFile(join(w,modelSlots(cfg,t.assetId).baseline.file)),doc=parseGlb(base);doc.doc.asset.extras={character:'second'};
 const a=await importAsset(w,'baseline',encodeGlb(doc.doc,doc.bin),'第二角色',{newModel:true});
 const preview=await previewMotion(w,{...request(t,p),assetId:a.assetId,expectedModelSha:a.sha256});assert.equal(preview.model.sha256,a.sha256);assert.equal(preview.recipe.versionId,p.version.id);
}));
test('incompatible rest poses and stale models cannot preview or adopt',()=>setup(async(w,t)=>{
 const p=await register(w,t),cfg=await readProject(w),a=modelSlots(cfg,t.assetId).baseline,parsed=parseGlb(await readFile(join(w,a.file)));parsed.doc.nodes.find(n=>n.name==='LeftShoulder').translation=[20,0,0];
 const changed=await importAsset(w,'baseline',encodeGlb(parsed.doc,parsed.bin),'不同参考姿势',{assetId:t.assetId});
 await assert.rejects(previewMotion(w,request(t,p)),/角色版本已变化/);
 await assert.rejects(previewMotion(w,{...request(t,p),expectedModelSha:changed.sha256}),/重定向/);
}));
test('mapping is immutable and scoped to exact model and source, not just node names',()=>setup(async(w,t)=>{
 const p=await register(w,t),rigs=await motionRigOptions(w,request(t,p));assert.ok(rigs.source.some(n=>n.name==='LeftShoulder'));assert.ok(rigs.target.some(n=>n.name==='LeftShoulder'));const m=await saveMotionMapping(w,{...request(t,p),name:'兼容骨架',nodeMap:{},expectedRevision:1});
 const preview=await previewMotion(w,{...request(t,p),mappingId:m.mapping.id});assert.equal(preview.recipe.mappingId,m.mapping.id);
 await assert.rejects(saveMotionMapping(w,{...request(t,p),nodeMap:{LeftShoulder:'Missing'},expectedRevision:2}),/目标节点/);
 await assert.rejects(previewMotion(w,{...request(t,p),mappingId:'missing'}),/映射不存在/);
}));
test('explicit export creates no stored GLB, while prepare creates a versioned candidate with recipe provenance',()=>setup(async(w,t)=>{
 const p=await register(w,t),input=request(t,p),v=await previewMotion(w,input),files=await readdir(join(w,'assets')),before=await readFile(join(w,'project.json'));
 const exported=await materializeMotion(w,{...input,previewId:v.recipe.id,exportOnly:true});assert.ok(exported.bytes.length);assert.deepEqual(await readFile(join(w,'project.json')),before);assert.deepEqual(await readdir(join(w,'assets')),files);
 const prepared=await materializeMotion(w,{...input,previewId:v.recipe.id});assert.equal(prepared.asset.source.motionBinding.id,v.recipe.id);assert.equal(prepared.project.slots.baseline.sha256,t.expectedModelSha);
}));
test('source tampering and concurrent metadata writes are rejected',()=>setup(async(w,t)=>{
 const p=await register(w,t);await assert.rejects(registerMotionPack(w,{...t,expectedRevision:0}),/其他操作/);
 await writeFile(join(w,p.version.file),'corrupt');await assert.rejects(previewMotion(w,request(t,p)),/损坏/);
}));
test('HTTP supports separated preview, adoption and export with existing origin and token protection',()=>setup(async(w,t)=>{
 const server=await serve(w,0);try{const base='http://127.0.0.1:'+server.address().port,session=await(await fetch(base+'/api/session')).json();
 const post=async(path,input,token=session.token)=>fetch(base+'/api/motions/'+path,{method:'POST',headers:{'x-motion-token':token},body:JSON.stringify(input)});
 assert.equal((await post('register',{...t,expectedRevision:0},'wrong')).status,403);
 const p=await(await post('register',{...t,expectedRevision:0})).json(),input=request(t,p),v=await(await post('preview',input)).json();assert.equal(v.status,'compatible');
 const exp=await fetch(base+'/api/motions/export?'+new URLSearchParams({...input,previewId:v.recipe.id}));assert.equal(exp.status,200);assert.ok(exp.headers.get('content-type').includes('gltf'));
 assert.equal((await(await fetch(base+'/api/motions')).json()).packs.length,1);
 }finally{await new Promise(r=>server.close(r));}
}));
test('publishing a new public version never upgrades adopted actions and old curves remain available',()=>setup(async(w,t)=>{
 const first=await register(w,t),input=request(t,first),preview=await previewMotion(w,input);await adoptMotion(w,{...input,expectedRevision:1,previewId:preview.recipe.id,name:'移动'});
 const cfg=await readProject(w),a=modelSlots(cfg,t.assetId).baseline,parsed=parseGlb(await readFile(join(w,a.file)));parsed.doc.animations[0].name='Run-v2';
 const changed=await importAsset(w,'baseline',encodeGlb(parsed.doc,parsed.bin),'角色新版本',{assetId:t.assetId}),second=await registerMotionPack(w,{assetId:t.assetId,packId:first.pack.id,expectedRevision:2});
 assert.equal(second.version.number,2);const lib=await motionLibrary(w);assert.equal(lib.characters[t.assetId][0].recipe.versionId,first.version.id);assert.equal(lib.packs[0].versions.length,2);
 const old=await previewMotion(w,{...input,expectedModelSha:changed.sha256});assert.equal(old.clips[0].name,input.clip);
 const nextInput={...input,expectedModelSha:changed.sha256,versionId:second.version.id,clip:'Run-v2'},next=await previewMotion(w,nextInput),adopted=await adoptMotion(w,{...nextInput,previewId:next.recipe.id,expectedRevision:3,name:'移动'});assert.equal(adopted.action.number,2);assert.equal(adopted.action.parentId,lib.characters[t.assetId][0].id);
}));
test('preparing an edit archives prior heads and refuses active model tasks',()=>setup(async(w,t)=>{
 const p=await register(w,t),input=request(t,p),v=await previewMotion(w,input),before=modelSlots(await readProject(w),t.assetId);
 await materializeMotion(w,{...input,previewId:v.recipe.id});const cfg=await readProject(w);assert.deepEqual(cfg.models[t.assetId].revisions.at(-1).slots,before);
 const {randomUUID}=await import('node:crypto'),{mkdir}=await import('node:fs/promises'),id=randomUUID();await mkdir(join(w,'jobs',id),{recursive:true});await writeFile(join(w,'jobs',id,'job.json'),JSON.stringify({id,assetId:t.assetId,state:'queued',request:'existing task',createdAt:new Date().toISOString()}));
 await assert.rejects(materializeMotion(w,{...input,previewId:v.recipe.id}),/未完成任务/);assert.ok((await materializeMotion(w,{...input,previewId:v.recipe.id,exportOnly:true})).bytes.length);
}));
test('project adoption copies separate motion references and immutable assets together',()=>setup(async(w,t)=>{
 const p=await register(w,t),input=request(t,p),v=await previewMotion(w,input);await adoptMotion(w,{...input,previewId:v.recipe.id,expectedRevision:1});
 const root=await mkdtemp(join(tmpdir(),'motion-target-'));try{const {prepareProject}=await import('../project-workspaces.mjs'),r=await prepareProject(w,root,{adoptCurrent:true,settingsPath:join(root,'recent.json')});const lib=await motionLibrary(r.workspace);assert.equal(lib.packs[0].versions[0].id,p.version.id);assert.equal(lib.characters[t.assetId].length,1);assert.equal((await previewMotion(r.workspace,input)).recipe.id,v.recipe.id);}finally{await rm(root,{recursive:true,force:true});}
}));
