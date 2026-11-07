import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,atomic,json,sha,importAsset,readProject,modelSlots} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {createJob,claimJob,completeJob,reviewJob,getJob,cancelJob,validateJobs} from '../jobs.mjs';
import {linkProject} from '../project-context.mjs';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {registerMotionPack,previewMotion,adoptMotion} from '../motion-library.mjs';
import {integrationStatus,recordIntegration} from '../game-integration.mjs';
import {parseGlb,encodeGlb} from '../asset-tools.mjs';
import {callTool} from '../mcp.mjs';
const cli=join(ROOT,'scripts/motion-feedback.mjs');
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
const variant=async n=>{const d=parseGlb(await buildDemo(true));d.doc.asset.extras={pass:n};return encodeGlb(d.doc,d.bin);};
// A workspace linked to a game whose models/hero.glb is the imported original.
async function linked(fn){const root=await mkdtemp(join(tmpdir(),'motion-integration-'));try{
 const w=join(root,'work'),game=join(root,'game'),original=await buildDemo(false);await mkdir(join(game,'models'),{recursive:true});await mkdir(w);await writeFile(join(game,'models/hero.glb'),original);
 await atomic(join(w,'project.json'),{version:2,slots:{}});await atomic(join(w,'feedback.json'),{version:1,notes:[]});await linkProject(w,game,{name:'demo-game'});
 await importAsset(w,'baseline',original,'hero',{source:{format:'glb',sha256:sha(original),originalName:'hero.glb',projectRelativePath:'models/hero.glb'}});
 const input=async(slot='baseline')=>{const p=await readProject(w),id=p.activeAssetId,a=p.models[id].slots[slot];return {assetId:id,request:'收小左臂',slot,context:{assetId:id,asset:a,slot,clip:'Run',time:.25}};};
 const edit=async(slot,bytes)=>{const j=await createJob(w,await input(slot)),c=await claimJob(w,j.id),file=join(w,j.id+'.glb');await writeFile(file,bytes);await completeJob(w,j.id,{lease:c.lease,candidatePath:file,summary:'changed'});return j;};
 const accept=async j=>(await reviewJob(w,j.id,{decision:'accept-candidate',outcome:'认可'})).reviews.at(-1).id;
 await fn({w,game,input,edit,accept});
}finally{await rm(root,{recursive:true,force:true});}}

test('an accepted candidate is pending with its game file state until an integration of real changes is recorded',()=>linked(async({w,game,input,edit,accept})=>{
 const bytes=await buildDemo(true),j=await edit('baseline',bytes);
 assert.equal((await integrationStatus(w)).candidates.length,0,'an unreviewed candidate is not waiting for the game');
 const checkpointId=await accept(j);
 let status=await integrationStatus(w),entry=status.candidates[0];
 assert.equal(status.pending,1);assert.equal(status.project.name,'demo-game');assert.equal(entry.status,'pending');assert.equal(entry.checkpointId,checkpointId);
 assert.equal(entry.game.modelFile,'models/hero.glb');assert.equal(entry.game.file.state,'original');assert.match(entry.hint,/可以用候选替换/);assert.doesNotMatch(entry.hint,/制作源/,'the model file is not its own authoring source');assert.equal(sha(await readFile(entry.candidate.file)),entry.candidate.sha256);
 const open=await createJob(w,await input());entry=(await integrationStatus(w)).candidates[0];assert.equal(entry.activeJobs,1);assert.match(entry.hint,/过期/);await cancelJob(w,open.id);
 await assert.rejects(recordIntegration(w,{checkpointId,files:['models/hero.glb'],summary:'替换模型'}),/还是导入时的原版/);
 await assert.rejects(recordIntegration(w,{checkpointId,files:['../work/project.json'],summary:'越界'}),/不在关联的游戏项目里/);
 await assert.rejects(recordIntegration(w,{checkpointId,files:['models/missing.glb'],summary:'缺失'}),/找不到游戏文件/);
 await assert.rejects(recordIntegration(w,{checkpointId,actionId:'x',files:['models/hero.glb'],summary:'两者'}),/--checkpoint/);
 await writeFile(join(game,'models/hero.glb'),bytes);assert.equal((await integrationStatus(w)).candidates[0].game.file.state,'candidate');
 const record=await callTool(w,'motion_record_integration',{checkpointId,files:[join(game,'models/hero.glb')],summary:'用候选替换 models/hero.glb',gameCheck:'游戏里跑步一圈，左臂摆幅收小'});
 assert.equal(record.kind,'candidate');assert.deepEqual(record.files.map(f=>[f.path,f.matches]),[['models/hero.glb','candidate']]);
 status=await integrationStatus(w);assert.equal(status.pending,0);assert.equal(status.candidates[0].status,'integrated');assert.doesNotMatch(status.candidates[0].hint,/记录接入。/);assert.equal(status.candidates[0].changedSinceIntegration,false);assert.equal(status.candidates[0].integrations[0].gameChecked,true);
 assert.equal((await getJob(w,j.id)).integrations[0].id,record.id);assert.equal((await json(join(w,'checkpoints',checkpointId+'.json'))).installed,false,'checkpoints stay as the user accepted them');
 await writeFile(join(game,'models/hero.glb'),await variant(9));entry=(await integrationStatus(w)).candidates[0];assert.equal(entry.changedSinceIntegration,true);assert.match(entry.hint,/又被改动过/);
 await validateJobs(w);
 await reviewJob(w,j.id,{decision:'revise',outcome:'还要再改'});
 assert.equal((await integrationStatus(w)).candidates[0].status,'withdrawn');
 await assert.rejects(recordIntegration(w,{checkpointId,files:['models/hero.glb'],summary:'再接入'}),/后续已有/);
}));

test('a later accepted edit built on an accepted candidate supersedes it; an edit from another branch is flagged',()=>linked(async({w,edit,accept})=>{
 const a1=await accept(await edit('baseline',await variant(1))),a2=await accept(await edit('candidate',await variant(2)));
 let byId=Object.fromEntries((await integrationStatus(w)).candidates.map(e=>[e.checkpointId,e]));
 assert.equal(byId[a1].status,'superseded');assert.equal(byId[a1].supersededBy,a2);assert.match(byId[a1].hint,/最新那一版/);assert.equal(byId[a2].status,'pending');assert.deepEqual(byId[a2].otherBranches,[]);
 const a3=await accept(await edit('baseline',await variant(3)));
 byId=Object.fromEntries((await integrationStatus(w)).candidates.map(e=>[e.checkpointId,e]));
 assert.deepEqual(byId[a3].otherBranches,[a2]);assert.deepEqual(byId[a2].otherBranches,[a3]);assert.match(byId[a3].hint,/另一条已认可版本/);assert.equal(byId[a1].status,'superseded');
}));

test('an adopted action exports pinned to its versions, records against the export and is superseded by a newer adoption',async()=>{
 const root=await mkdtemp(join(tmpdir(),'motion-integration-action-'));try{
  const w=join(root,'work'),game=join(root,'game');await mkdir(game);await initializeWorkspace(w);await linkProject(w,game,{name:'demo-game'});
  const cfg=await readProject(w),assetId=cfg.activeAssetId,target={assetId,slot:'baseline',expectedModelSha:modelSlots(cfg,assetId).baseline.sha256};
  const pack=await registerMotionPack(w,{...target,expectedRevision:0,name:'公共动作'}),[clipA,clipB]=pack.version.clips.map(c=>c.name);
  const adopt=async(clip,expectedRevision)=>{const input={...target,packId:pack.pack.id,versionId:pack.version.id,clip},preview=await previewMotion(w,input);return (await adoptMotion(w,{...input,previewId:preview.recipe.id,expectedRevision,name:'跑步'})).action;};
  const first=await adopt(clipA,1);
  let listed=JSON.parse(run('integrations','--workspace',w).stdout),entry=listed.actions[0];
  assert.equal(entry.actionId,first.id);assert.equal(entry.status,'pending');assert.equal(entry.modelChanged,false);assert.equal(entry.clip,clipA);assert.match(entry.hint,/export-action/);
  const out=join(game,'hero.glb');let r=run('export-action','--workspace',w,'--action',first.id,'--out',out);assert.equal(r.status,0,r.stderr);
  const exported=JSON.parse(r.stdout);assert.equal(sha(await readFile(out)),exported.sha256);assert.equal(exported.recipe.clip,clipA);
  r=run('export-action','--workspace',w,'--action',first.id,'--out',out);assert.notEqual(r.status,0);assert.match(r.stderr,/--replace/);
  assert.equal(run('export-action','--workspace',w,'--action',first.id,'--out',out,'--replace').status,0);
  r=run('integrate','--workspace',w,'--action',first.id,'--file','hero.glb','--summary','导出角色 GLB 放进游戏');assert.equal(r.status,0,r.stderr);
  const record=JSON.parse(r.stdout);assert.equal(record.kind,'action');assert.equal(record.files[0].matches,'export');assert.equal(record.gameCheck,null);
  entry=(await callTool(w,'motion_integration_status')).actions[0];assert.equal(entry.status,'integrated');assert.equal(entry.integrations[0].gameChecked,false);
  const second=await adopt(clipB,2),byId=Object.fromEntries((await integrationStatus(w)).actions.map(a=>[a.actionId,a]));
  assert.equal(byId[first.id].status,'superseded');assert.equal(byId[second.id].status,'pending');
  const d=parseGlb(await readFile(join(w,modelSlots(cfg,assetId).baseline.file)));d.doc.asset.extras={changed:true};await importAsset(w,'baseline',encodeGlb(d.doc,d.bin),'新模型',{assetId});
  assert.equal((await integrationStatus(w)).actions.find(a=>a.actionId===second.id).modelChanged,true);
  await assert.rejects(callTool(w,'motion_export_action',{actionId:second.id,outputPath:join(root,'stale.glb')}),/重新试播并收录/);
  await assert.rejects(callTool(w,'motion_export_action',{actionId:second.id,outputPath:'relative.glb'}),/绝对路径/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('recording needs a linked game project',async()=>{
 const w=await mkdtemp(join(tmpdir(),'motion-integration-unlinked-'));try{
  await initializeWorkspace(w);assert.equal((await integrationStatus(w)).project,null);assert.match((await integrationStatus(w)).next,/project-open/);
  await assert.rejects(recordIntegration(w,{actionId:'x',files:['a.glb'],summary:'x'}),/关联可用的游戏项目/);
 }finally{await rm(w,{recursive:true,force:true});}
});
