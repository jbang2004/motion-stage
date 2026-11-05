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
import {discoverCharacterActions,waitForCharacterActions,previewCharacterAction} from '../character-actions.mjs';
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
test('HTTP discovery and direct trial preserve token checks and close cleanly with background matching',()=>fixture(async({work,project,input})=>{
 await writeFile(join(project,'foreign.glb'),foreign());await scan(work);const {serve}=await import('../server.mjs'),server=await serve(work,0);try{
 const url='http://127.0.0.1:'+server.address().port,session=await(await fetch(url+'/api/session')).json(),path='/api/actions?'+new URLSearchParams(input);let data;
 for(let i=0;i<60;i++){data=await(await fetch(url+path)).json();if(data.state==='ready')break;await new Promise(r=>setTimeout(r,5));}assert.equal(data.state,'ready');assert.equal(data.actions.length,1);
 const post=token=>fetch(url+'/api/actions/preview',{method:'POST',headers:{'x-motion-token':token},body:JSON.stringify({...input,actionId:data.actions[0].id})});assert.equal((await post('wrong')).status,403);const response=await post(session.token),result=await response.json();assert.equal(response.status,200);assert.equal(result.result.status,'compatible');assert.equal(result.result.recipe.modelSha,input.expectedModelSha);
 }finally{await new Promise(r=>server.close(r));}
}));
