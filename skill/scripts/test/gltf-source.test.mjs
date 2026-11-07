import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {linkProject} from '../project-context.mjs';
import {parseGlb,encodeGlb,editGlb,packGltf,gltfReferences} from '../asset-tools.mjs';
import {readProject,modelSlots,glbInfo,sha} from '../core.mjs';
import {startCatalogScan,waitForCatalogScan,stopCatalogScan,catalogPage,openCatalogAsset} from '../asset-catalog.mjs';
import {castRoster,characterPage,characterModelBytes,openCharacter} from '../character-library.mjs';
import {waitForCharacterActions,previewCharacterAction,characterActionCurves,stopCharacterActionDiscovery} from '../character-actions.mjs';
import {validateCandidate} from '../candidate-validation.mjs';
import {serve} from '../server.mjs';

const base=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(40,3)]);
// Splits a GLB the way a "glTF Separate" export lays it out: JSON + .bin + texture.
function split(glb,name){
 const {doc,bin}=parseGlb(glb),d=structuredClone(doc),length=doc.buffers[0].byteLength;
 d.buffers=[{uri:name+'.bin',byteLength:length}];d.images=[{name:'skin',uri:'textures/'+encodeURIComponent(name+' skin.png')}];d.textures=[{source:0}];
 return {json:JSON.stringify(d,null,1),bin:Buffer.from(bin.subarray(0,length))};
}
function foreign(){const edited=editGlb(base,{clip:'Run',bone:'LeftShoulder',factor:.5}),p=parseGlb(edited.bytes);p.doc.animations=[p.doc.animations.find(a=>a.name==='Run')];p.doc.animations[0].name='Borrowed';return encodeGlb(p.doc,p.bin);}
async function writeGltf(root,name,glb){
 const {json,bin}=split(glb,name);await mkdir(join(root,'models','textures'),{recursive:true});
 await Promise.all([writeFile(join(root,'models',name+'.gltf'),json),writeFile(join(root,'models',name+'.bin'),bin),writeFile(join(root,'models','textures',name+' skin.png'),PNG)]);
 return {json,bin};
}
// Edits real vertex data inside the .bin only; the .gltf JSON stays byte-identical.
async function editBin(root,name,stamp){
 const path=join(root,'models',name+'.bin'),bin=await readFile(path);bin.writeFloatLE(-.25,0);await writeFile(path,bin);
 const when=new Date(stamp);await utimes(path,when,when);
}
async function fixture(fn){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'motion-gltf-'))),root=join(dir,'Project'),work=join(dir,'review');
 await mkdir(root);await initializeWorkspace(work);await linkProject(work,root);
 const cfg=await readProject(work),asset=modelSlots(cfg).baseline,input={assetId:cfg.activeAssetId,slot:'baseline',expectedModelSha:asset.sha256};
 try{await fn({root,work,input});}finally{await stopCharacterActionDiscovery(work);await stopCatalogScan(work);await rm(dir,{recursive:true,force:true});}
}
async function scan(work){await startCatalogScan(work,{force:true});return waitForCatalogScan(work);}

test('packGltf turns JSON + .bin + images into one self-contained GLB and keeps data URIs working',()=>{
 const {json,bin}=split(base,'hero'),doc=JSON.parse(json);
 doc.images.push({uri:'data:image/png;base64,'+PNG.toString('base64')});doc.textures.push({source:1});
 assert.deepEqual(gltfReferences(doc,'models/hero.gltf').map(r=>r.path),['models/hero.bin','models/textures/hero skin.png']);
 const packed=packGltf(doc,new Map([['models/hero.bin',bin],['models/textures/hero skin.png',PNG]]),'models/hero.gltf'),{doc:out,bin:chunk}=parseGlb(packed);
 assert.deepEqual(out.buffers,[{byteLength:out.buffers[0].byteLength}]);assert.ok(out.images.every(i=>!i.uri&&i.mimeType==='image/png'));
 assert.deepEqual(chunk.subarray(0,bin.length),bin,'original buffer is the start of the BIN chunk');
 for(const image of out.images){const v=out.bufferViews[image.bufferView];assert.equal(v.byteOffset%4,0);assert.deepEqual(chunk.subarray(v.byteOffset,v.byteOffset+v.byteLength),PNG);}
 assert.deepEqual(glbInfo(packed).clips,glbInfo(base).clips);assert.equal(validateCandidate(packed,glbInfo(base).clips).kind,'candidate-file-check');
 for(const uri of ['../../outside.bin','/abs/hero.bin','https://example.com/hero.bin','C:/hero.bin'])assert.throws(()=>gltfReferences({buffers:[{uri}]},'models/hero.gltf'),/项目内/);
 assert.deepEqual(gltfReferences({images:[{uri:'../shared/skin.png'}]},'models/hero.gltf').map(r=>r.path),['shared/skin.png'],'a sibling folder inside the project is allowed');
 assert.throws(()=>packGltf(doc,new Map([['models/hero.bin',bin]]),'models/hero.gltf'),/缺少 glTF 引用的文件/);
 assert.throws(()=>packGltf(doc,new Map([['models/hero.bin',bin.subarray(0,16)],['models/textures/hero skin.png',PNG]]),'models/hero.gltf'),/buffer 数据不完整/);
});

test('a .gltf + .bin + PNG project opens and plays as a GLB; a changed .bin is a reported source change',()=>fixture(async({root,work})=>{
 await writeGltf(root,'hero',base);
 let entry=(await scan(work)).entries.find(e=>e.relativePath==='models/hero.gltf');
 assert.equal(entry.status,'available');assert.equal(entry.format,'gltf');assert.deepEqual(entry.metadata.clips.map(c=>c.name),['Run','Salute']);
 assert.deepEqual(entry.dependencies,['models/hero.bin','models/textures/hero skin.png']);assert.ok(entry.dependencyFingerprint);
 await openCatalogAsset(work,entry.id);let cfg=await readProject(work),head=modelSlots(cfg,entry.id).baseline;
 assert.equal(cfg.activeAssetId,entry.id);assert.deepEqual(head.clips.map(c=>c.name),['Run','Salute']);
 assert.equal(head.source.format,'gltf');assert.equal(head.source.sha256,sha(await readFile(join(root,'models/hero.gltf'))));
 assert.deepEqual(head.source.dependencies.map(d=>d.projectRelativePath),entry.dependencies);assert.equal(head.source.dependencies[0].sha256,sha(await readFile(join(root,'models/hero.bin'))));
 const snapshot=parseGlb(await readFile(join(work,head.file)));assert.equal(snapshot.doc.images[0].mimeType,'image/png');
 assert.deepEqual(cfg.models[entry.id].sourceDependencies,head.source.dependencies);
 assert.equal((await catalogPage(work)).entries.find(e=>e.id===entry.id).sourceChanged,false);

 // Touching the .bin is visible, but reloading identical bytes creates no new version.
 const touched=new Date(Date.now()+5000);await utimes(join(root,'models/hero.bin'),touched,touched);await scan(work);
 assert.equal((await catalogPage(work)).entries.find(e=>e.id===entry.id).sourceChanged,true);
 await openCatalogAsset(work,entry.id,{refreshSource:true});cfg=await readProject(work);
 assert.equal(modelSlots(cfg,entry.id).baseline.sha256,head.sha256);assert.equal(cfg.models[entry.id].revisions,undefined);
 assert.equal((await catalogPage(work)).entries.find(e=>e.id===entry.id).sourceChanged,false);

 await editBin(root,'hero',Date.now()+10000);entry=(await scan(work)).entries.find(e=>e.id===entry.id);
 assert.equal(entry.status,'available');assert.equal((await catalogPage(work)).entries.find(e=>e.id===entry.id).sourceChanged,true,'only the .bin changed; it is still a source change');
 assert.equal(modelSlots(await readProject(work),entry.id).baseline.sha256,head.sha256,'scanning never replaces the opened version');
 await openCatalogAsset(work,entry.id,{refreshSource:true});cfg=await readProject(work);const next=modelSlots(cfg,entry.id).baseline;
 assert.notEqual(next.sha256,head.sha256);assert.equal(cfg.models[entry.id].revisions.length,1);assert.notEqual(next.source.dependencies[0].sha256,head.source.dependencies[0].sha256);
}));

test('missing, escaping or malformed glTF files are invalid catalog rows, not previews',()=>fixture(async({root,work})=>{
 const {json}=split(base,'ghost'),escape=JSON.parse(json);escape.buffers[0].uri='../../outside.bin';
 await mkdir(join(root,'models'));await writeFile(join(root,'models/ghost.gltf'),json);await writeFile(join(root,'models/escape.gltf'),JSON.stringify(escape));await writeFile(join(root,'models/broken.gltf'),'{"asset":');
 const {entries}=await scan(work),ghost=entries.find(e=>e.name==='ghost.gltf'),out=entries.find(e=>e.name==='escape.gltf');
 assert.equal(entries.find(e=>e.name==='broken.gltf').error,'glTF JSON 无法解析');
 assert.equal(ghost.status,'invalid');assert.match(ghost.error,/缺少 glTF 引用的文件：models\/ghost\.bin/);
 assert.equal(out.status,'invalid');assert.match(out.error,/不在项目内/);
 await assert.rejects(openCatalogAsset(work,ghost.id),/缺少 glTF 引用的文件/);
 assert.equal((await castRoster(work)).entries.filter(e=>e.kind==='character').length,0);
}));

test('a .gltf character shows in the rail with a packed-GLB portrait, opens, and reports .bin changes',()=>fixture(async({root,work})=>{
 const {json,bin}=await writeGltf(root,'hero',base);await scan(work);
 const hero=(await castRoster(work)).entries.find(e=>e.relativePath==='models/hero.gltf');
 assert.equal(hero.kind,'character');assert.equal(hero.format,'gltf');assert.equal(hero.status,'available');assert.equal(hero.clipCount,2);
 assert.equal(hero.portrait.source,'project');assert.equal(hero.portrait.url,'/api/characters/'+encodeURIComponent(hero.id)+'/model');
 const expected=packGltf(JSON.parse(json),new Map([['models/hero.bin',bin],['models/textures/hero skin.png',PNG]]),'models/hero.gltf');
 assert.deepEqual(await characterModelBytes(work,hero.id),expected);
 const server=await serve(work,0);try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+hero.portrait.url);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'model/gltf-binary');assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
 }finally{await new Promise(r=>server.close(r));}
 await openCharacter(work,hero.id);const head=modelSlots(await readProject(work),hero.id).baseline;
 assert.deepEqual(head.clips.map(c=>c.name),['Run','Salute']);assert.equal(head.source.format,'gltf');
 assert.deepEqual(head.source.dependencies.map(d=>d.projectRelativePath),['models/hero.bin','models/textures/hero skin.png']);
 assert.equal((await characterPage(work)).entries.find(e=>e.id===hero.id).sourceChanged,false);
 await editBin(root,'hero',Date.now()+10000);
 assert.equal((await characterPage(work)).entries.find(e=>e.id===hero.id).sourceChanged,true);
 assert.notEqual((await castRoster(work)).entries.find(e=>e.id===hero.id).portrait.identity,hero.portrait.identity,'the portrait is re-rendered after a .bin change');
}));

test('a .gltf action source matches a same-rig GLB character and is fenced against .bin changes',()=>fixture(async({root,work,input})=>{
 await writeGltf(root,'foreign',foreign());await scan(work);
 const data=await waitForCharacterActions(work,input),action=data.actions.find(a=>a.name==='Borrowed');
 assert.equal(data.state,'ready');assert.ok(action,'the glTF clip is offered to the GLB character');assert.equal(action.sourceName,'foreign.gltf');
 const curves=await characterActionCurves(work,{...input,actionIds:[action.id],samples:4});assert.ok(curves.clips[action.id].tracks.length);
 const before=await readFile(join(work,'project.json')),out=await previewCharacterAction(work,{...input,actionId:action.id});
 assert.equal(out.result.status,'compatible');assert.equal(out.result.clips[0].name,'Borrowed');assert.deepEqual(await readFile(join(work,'project.json')),before);
 await editBin(root,'foreign',Date.now()+10000);
 await assert.rejects(previewCharacterAction(work,{...input,actionId:action.id}),/来源已变化/);
 assert.match((await characterActionCurves(work,{...input,actionIds:[action.id]})).clips[action.id].error,/来源已变化/);
}));
