import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {linkProject} from '../project-context.mjs';
import {startCatalogScan,waitForCatalogScan,stopCatalogScan} from '../asset-catalog.mjs';
import {readProject,modelSlots} from '../core.mjs';
import {parseGlb,encodeGlb,editGlb} from '../asset-tools.mjs';
import {discoverCharacterActions,waitForCharacterActions,previewCharacterAction,ACTION_CACHE_DIR} from '../character-actions.mjs';
import {previewReplacement,replaceAction,listReplacementPlans,replacementHandoff,recordReplacementIntegration} from '../action-replacement.mjs';
import {spawnSync} from 'node:child_process';
const base=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
function foreign(factor=.5,rest=false){const edited=editGlb(base,{clip:'Run',bone:'LeftShoulder',factor}),p=parseGlb(edited.bytes);p.doc.animations=[p.doc.animations.find(a=>a.name==='Run')];p.doc.animations[0].name='Borrowed';if(rest)p.doc.nodes.find(n=>n.name==='LeftShoulder').translation=[30,0,0];return encodeGlb(p.doc,p.bin);}
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'flat-character-')),project=join(root,'project'),work=join(root,'work');await mkdir(project);await initializeWorkspace(work);await linkProject(work,project);const cfg=await readProject(work),asset=modelSlots(cfg).baseline,input={assetId:cfg.activeAssetId,slot:'baseline',expectedModelSha:asset.sha256};try{await fn({work,project,input});}finally{await stopCatalogScan(work);await rm(root,{recursive:true,force:true});}}
async function scan(work){await startCatalogScan(work,{force:true});await waitForCatalogScan(work);}
test('compatible actions appear automatically without a public library and duplicates/presets are removed',()=>fixture(async({work,project,input})=>{
 await writeFile(join(project,'foreign.glb'),foreign());await writeFile(join(project,'copy.glb'),foreign());await writeFile(join(project,'preset.glb'),base);await scan(work);
 const before=await readFile(join(work,'project.json')),files=await readdir(join(work,'assets'));const initial=await discoverCharacterActions(work,input);assert.equal(initial.state,'scanning');const result=await waitForCharacterActions(work,input);assert.equal(result.state,'ready');assert.equal(result.actions.length,1);assert.equal(result.actions[0].name,'Borrowed');assert.equal(result.actions[0].sourceCount,2);assert.deepEqual(await readFile(join(work,'project.json')),before);assert.deepEqual(await readdir(join(work,'assets')),files);
}));
test('same name with different curves remains independently selectable; incompatible rest poses stay out',()=>fixture(async({work,project,input})=>{
 await writeFile(join(project,'a.glb'),foreign(.5));await writeFile(join(project,'b.glb'),foreign(.8));await writeFile(join(project,'wrong.glb'),foreign(.5,true));await scan(work);const result=await waitForCharacterActions(work,input);assert.equal(result.actions.length,2);assert.ok(result.actions.every(a=>a.name==='Borrowed'));assert.notEqual(result.actions[0].id,result.actions[1].id);assert.ok(result.incompatible>0);
}));
test('one-click trial resolves its hidden motion reference but does not adopt or replace model heads',()=>fixture(async({work,project,input})=>{
 await writeFile(join(project,'foreign.glb'),foreign());await scan(work);const data=await waitForCharacterActions(work,input),before=await readFile(join(work,'project.json')),out=await previewCharacterAction(work,{...input,actionId:data.actions[0].id});assert.equal(out.result.status,'compatible');assert.equal(out.result.clips[0].name,'Borrowed');assert.ok(out.request.packId);assert.deepEqual(await readFile(join(work,'project.json')),before);const manifest=JSON.parse(await readFile(join(work,'motion-library.json'),'utf8'));assert.deepEqual(manifest.characters,{});assert.equal(manifest.packs[0].versions[0].clips.length,1);
}));
test('changed source files and stale character identities cannot play an indexed action',()=>fixture(async({work,project,input})=>{
 const path=join(project,'foreign.glb');await writeFile(path,foreign());await scan(work);const data=await waitForCharacterActions(work,input);await writeFile(path,foreign(.7));await assert.rejects(previewCharacterAction(work,{...input,actionId:data.actions[0].id}),/来源已变化/);await assert.rejects(discoverCharacterActions(work,{...input,expectedModelSha:'wrong'}),/角色版本已变化/);
}));
test('matched action replacement previews read-only and pins the actual curves on confirmation',()=>fixture(async({work,project,input})=>{
 const file=join(project,'foreign.glb');await writeFile(file,foreign());await scan(work);
 const data=await waitForCharacterActions(work,input),request={...input,expectedCandidateSha:input.expectedModelSha,clip:'Run',source:{kind:'matched',id:data.actions[0].id}};
 const config=await readFile(join(work,'project.json')),files=await readdir(join(work,'assets')),preview=await previewReplacement(work,request);
 assert.ok(preview.action.tracks.length);assert.deepEqual(await readdir(join(work,'assets')),files);
 const result=await replaceAction(work,{...request,previewId:preview.previewId});
 assert.equal(result.plan.source.clip,'Borrowed');
 assert.deepEqual(await readFile(join(work,'project.json')),config);
 await writeFile(file,foreign(.7));
 const replay=await previewReplacement(work,{...request,source:{kind:'plan',id:result.plan.id}});
 assert.deepEqual(replay.action.tracks,preview.action.tracks);
 const own={...request,clip:'Salute',source:{kind:'own',name:'Run'}};
 const second=await replaceAction(work,{...own,previewId:(await previewReplacement(work,own)).previewId});
 const ids=[result.plan.id,second.plan.id],handoff=await replacementHandoff(work,ids);
 assert.deepEqual(handoff.task.plans.map(plan=>plan.clip),['Run','Salute']);
 assert.match(handoff.prompt,/replacement-integrated/);
 await assert.rejects(recordReplacementIntegration(work,{ids,files:[file],summary:'替换两个动作'}),/游戏验证/);
 await recordReplacementIntegration(work,{ids,files:[file],summary:'替换两个动作',gameCheck:'已在游戏预览确认'});
 assert.ok((await listReplacementPlans(work,input.assetId)).plans.every(plan=>plan.integration?.files[0].path==='foreign.glb'));
 await assert.rejects(replacementHandoff(work,ids),/已接入/);
}));
test('HTTP discovery and direct trial preserve token checks and close cleanly with background matching',()=>fixture(async({work,project,input})=>{
 await writeFile(join(project,'foreign.glb'),foreign());await scan(work);const {serve}=await import('../server.mjs'),server=await serve(work,0);try{
 const url='http://127.0.0.1:'+server.address().port,session=await(await fetch(url+'/api/session')).json(),path='/api/actions?'+new URLSearchParams(input);let data;
 for(let i=0;i<60;i++){data=await(await fetch(url+path)).json();if(data.state==='ready')break;await new Promise(r=>setTimeout(r,5));}assert.equal(data.state,'ready');assert.equal(data.actions.length,1);
 const post=token=>fetch(url+'/api/actions/preview',{method:'POST',headers:{'x-motion-token':token},body:JSON.stringify({...input,actionId:data.actions[0].id})});assert.equal((await post('wrong')).status,403);const response=await post(session.token),result=await response.json();assert.equal(response.status,200);assert.equal(result.result.status,'compatible');assert.equal(result.result.recipe.modelSha,input.expectedModelSha);
 }finally{await new Promise(r=>server.close(r));}
}));
// A fresh process stands in for a CLI run or a server restart: the in-memory
// cache is gone, so anything it returns came from cache/actions on disk.
function freshProcessActions(work,input){
 const code="import {waitForCharacterActions,stopCharacterActionDiscovery} from "+JSON.stringify(new URL('../character-actions.mjs',import.meta.url).href)+";const [w,i]=process.argv.slice(1);const r=await waitForCharacterActions(w,JSON.parse(i));await stopCharacterActionDiscovery(w);console.log(JSON.stringify(r.actions.map(a=>a.name)));";
 const r=spawnSync(process.execPath,['--input-type=module','-e',code,work,JSON.stringify(input)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test('match results persist across processes, follow source changes and ignore a damaged cache',()=>fixture(async({work,project,input})=>{
 const path=join(project,'foreign.glb');await writeFile(path,foreign());await scan(work);
 const first=await waitForCharacterActions(work,input);assert.deepEqual(first.actions.map(a=>a.name),['Borrowed']);
 const file=join(work,ACTION_CACHE_DIR,input.expectedModelSha+'.json'),saved=JSON.parse(await readFile(file,'utf8'));
 assert.equal(saved.targetSha,input.expectedModelSha);const keys=Object.keys(saved.entries);assert.equal(keys.length,1);
 // Rename the cached clip: a fresh process that shows the new name read the cache instead of the GLB.
 saved.entries[keys[0]].rows[0].clip='FROM_CACHE';await writeFile(file,JSON.stringify(saved));
 assert.deepEqual(freshProcessActions(work,input),['FROM_CACHE']);
 // A rewritten source has a new identity stamp: it is matched again and the stale entry is pruned.
 await writeFile(path,foreign(.7));await scan(work);assert.deepEqual(freshProcessActions(work,input),['Borrowed']);
 const after=JSON.parse(await readFile(file,'utf8'));assert.equal(Object.keys(after.entries).length,1);assert.ok(!after.entries[keys[0]]);
 await writeFile(file,'{not json');assert.deepEqual(freshProcessActions(work,input),['Borrowed']);assert.equal(JSON.parse(await readFile(file,'utf8')).version,2);
}));
test('read-ahead keeps inventory order: listing order and the duplicate source label match a one-by-one scan',()=>fixture(async({work,project,input})=>{
 const variant=(factor,name)=>{const p=parseGlb(foreign(factor));p.doc.animations[0].name=name;return encodeGlb(p.doc,p.bin);};
 for(let i=0;i<10;i++)await writeFile(join(project,'src-'+String(i).padStart(2,'0')+'.glb'),variant(.3+i*.05,'Clip'+i));
 await writeFile(join(project,'src-10.glb'),await readFile(join(project,'src-03.glb')));await scan(work);
 const result=await waitForCharacterActions(work,input);assert.deepEqual(result.actions.map(a=>a.name),Array.from({length:10},(_,i)=>'Clip'+i));
 const shared=result.actions[3];assert.equal(shared.sourceCount,2);assert.match(shared.sourceName,/src-03/);
}));
