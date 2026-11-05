import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as T from '../../assets/vendor/three/build/three.core.js';
import {resourceCapabilities} from '../../assets/viewer/resource-capabilities.mjs';
import {prepareResource,curveSamples,curveValue} from '../../assets/viewer/resource-preview.mjs';
import {createCurveResource,parseSampledTracks} from '../curve-resources.mjs';
import {glbInfo,readProject,modelSlots,sha,importAsset} from '../core.mjs';
import {parseGlb,encodeGlb,readAccessor,inspectAsset} from '../asset-tools.mjs';
import {validateCandidate} from '../candidate-validation.mjs';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {linkProject} from '../project-context.mjs';
import {startCatalogScan,waitForCatalogScan,openCatalogAsset,catalogPage} from '../asset-catalog.mjs';
import {characterPage} from '../character-library.mjs';
import {createJob,claimJob,completeJob,getJob,importBytes,importFile} from '../jobs.mjs';
import {assembleCharacter} from '../motion-assembly.mjs';

const demo=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
const pack=(value=.4)=>({format:'sampled-tracks-v1',fps:2,clips:{Reach:{duration:1,tracks:[['LeftShoulder.quaternion','quaternion',4,[0,0,0,1,0,Math.sin(value/2),0,Math.cos(value/2),0,0,0,1]],['strength','number',1,[0,.8,0]]]}}});
const bytes=value=>Buffer.from(JSON.stringify(value));
function variant({mesh=true,animation=true,rig=false}={}){const p=parseGlb(demo);if(!mesh){for(const n of p.doc.nodes){delete n.mesh;delete n.skin;}delete p.doc.meshes;}if(!animation)delete p.doc.animations;if(rig){const joint=p.doc.nodes.findIndex(n=>n.name==='LeftShoulder');p.doc.nodes[joint].extras={motionStudioJoint:true};}return encodeGlb(p.doc,p.bin);}

test('independent capabilities distinguish static, skinned, skeletal, node, morph, curve and empty resources',()=>{
 const staticInfo=glbInfo(variant({animation:false}));assert.equal(staticInfo.kind,'static-model');assert.equal(staticInfo.capabilities.canPlay,false);assert.equal(staticInfo.capabilities.canPickSurface,true);
 const skeleton=glbInfo(variant({mesh:false,rig:true}));assert.equal(skeleton.kind,'skeleton-animation');assert.equal(skeleton.capabilities.hasSkin,false);assert.equal(skeleton.capabilities.needsTarget,true);
 assert.equal(glbInfo(variant({mesh:false,rig:true,animation:false})).kind,'skeleton');assert.equal(glbInfo(variant({mesh:false})).kind,'node-animation');
 const d=parseGlb(variant({animation:false})).doc,joint=d.nodes.findIndex(n=>n.name==='LeftShoulder'),mesh=d.nodes.find(n=>n.mesh!==undefined);d.skins=[{joints:[joint]}];mesh.skin=0;assert.equal(resourceCapabilities(d).hasSkin,true);assert.equal(resourceCapabilities(d).hasClips,false);
 d.meshes[0].primitives[0].targets=[{POSITION:0}];d.animations=[{channels:[{target:{node:d.nodes.indexOf(mesh),path:'weights'}}]}];const morph=resourceCapabilities(d);assert.deepEqual(morph.animationTypes,['morph']);assert.equal(morph.hasMorphTargets,true);
 const empty=encodeGlb({asset:{version:'2.0'}},Buffer.alloc(0));assert.equal(glbInfo(empty).kind,'empty');assert.equal(glbInfo(empty).capabilities.canInspect,false);
 assert.equal(glbInfo(createCurveResource(bytes(pack()))).kind,'curves');
});

test('bad hierarchy, missing mesh, multiple parents, cycles and deep trees fail before replacing a head',()=>{
 for(const nodes of [[{children:[1]},{children:[0]}],[{children:[2]},{children:[2]},{}],[{mesh:99}],[{skin:99}],[{children:[90]}],Array.from({length:258},(_,i)=>i<257?{children:[i+1]}:{})])assert.throws(()=>resourceCapabilities({nodes}),/引用|循环|父节点|层/);
 assert.throws(()=>resourceCapabilities({nodes:[{}],scenes:[{nodes:[1]}]}),/根节点/);
 assert.throws(()=>resourceCapabilities({nodes:[{}],scenes:[{nodes:[0]}],scene:9}),/默认场景/);
});

test('sampled intake preserves timing, constants and original data, and rejects corrupt or excessive curves',()=>{
 const input=pack(),copy=structuredClone(input),preview=createCurveResource(bytes(input));assert.deepEqual(input,copy);validateCandidate(preview);assert.deepEqual(glbInfo(preview).clips.map(c=>c.name),['Reach']);assert.equal(inspectAsset(preview).capabilities.preview,'curves');
 const constant={fps:60,clips:{Hold:{duration:2,tracks:[['root.position','vector',3,[0,1,0]]]}}};const parsed=parseSampledTracks(constant);assert.deepEqual(parsed[0].tracks[0].times,[0,2]);
 for(const change of [p=>p.fps=0,p=>p.clips.Reach.duration=1e99,p=>p.clips.Reach.tracks[0][3][0]=1e99,p=>p.clips.Reach.tracks[0][3]=[0,0,0,0],p=>p.clips.Reach.tracks.push(p.clips.Reach.tracks[0]),p=>p.clips.Reach.tracks[0][2]=3]){const p=pack();change(p);assert.throws(()=>createCurveResource(bytes(p)));}
 const p=parseGlb(preview),t=p.doc.extras.motionStudio.clips[0].tracks[0],inputView=p.doc.bufferViews[p.doc.accessors[t.input].bufferView];p.bin.writeFloatLE(0,inputView.byteOffset+4);assert.throws(()=>validateCandidate(encodeGlb(p.doc,p.bin)),/曲线时间/);
 const bad=parseGlb(preview),out=bad.doc.extras.motionStudio.clips[0].tracks[0].output;bad.bin.writeFloatLE(NaN,bad.doc.bufferViews[bad.doc.accessors[out].bufferView].byteOffset);assert.throws(()=>validateCandidate(encodeGlb(bad.doc,bad.bin)),/非有限/);
 const wrong=parseGlb(preview);wrong.doc.extras.motionStudio.clips[0].tracks[0].output=999;assert.throws(()=>glbInfo(encodeGlb(wrong.doc,wrong.bin)),/曲线轨道/);
});

function fakeGltf(buffer){const {doc,bin}=parseGlb(buffer),objects=(doc.nodes||[]).map(n=>{const o=new T.Group();o.name=n.name||'';if(n.translation)o.position.fromArray(n.translation);if(n.rotation)o.quaternion.fromArray(n.rotation);return o;}),associations=new Map(objects.map((o,i)=>[o,{nodes:i}]));for(const [i,n]of (doc.nodes||[]).entries())for(const child of n.children||[])objects[i].add(objects[child]);const scene=doc.scenes?.length?new T.Group():undefined;if(scene)for(const i of doc.scenes[doc.scene||0].nodes||[])scene.add(objects[i]);return {scene,animations:[],parser:{json:doc,associations,async getDependency(type,i){if(type==='node')return objects[i];if(type==='accessor')return new T.Float32BufferAttribute(readAccessor(doc,bin,i).flat(),1);throw Error('unexpected '+type);}}};}

test('spatial preparation frames actual standalone hierarchy and scene-less roots without a mesh or template body',async()=>{
 const buffer=encodeGlb({asset:{version:'2.0'},nodes:[{name:'Root',translation:[2,3,4],children:[1],extras:{motionStudioJoint:true}},{name:'Tip',translation:[0,2,0],extras:{motionStudioJoint:true}}]},Buffer.alloc(0));const r=await prepareResource(fakeGltf(buffer),T);assert.equal(r.meshes.length,0);assert.equal(r.joints.length,2);assert.equal(r.height,2);assert.deepEqual(r.bbox.min.toArray(),[2,3,4]);assert.deepEqual(r.bbox.max.toArray(),[2,5,4]);assert.equal(r.capabilities.preview,'skeleton');
 const collapsed=encodeGlb({asset:{version:'2.0'},nodes:[{name:'Point'}],scenes:[{nodes:[0]}]},Buffer.alloc(0));const point=await prepareResource(fakeGltf(collapsed),T);assert.ok(Number.isFinite(point.height)&&point.height>0);assert.equal(point.capabilities.preview,'nodes');assert.equal(point.root.children.length,1);
});

test('curve preparation and plotting require no WebGL and retain narrow peaks within a bounded draw budget',async()=>{
 const r=await prepareResource(fakeGltf(createCurveResource(bytes(pack()))),T);assert.equal(r.meshes.length,0);assert.equal(r.joints.length,0);assert.equal(r.clips[0].duration,1);assert.equal(r.clips[0].tracks.length,0);assert.equal(r.curves[0].tracks.length,2);assert.ok(Math.abs(curveValue(r.curves[0].tracks[1],.25)-.4)<1e-6);
 const values=new Float32Array(10000);values[5432]=100;values[5433]=-100;const track={width:1,times:new T.Float32BufferAttribute(Array.from(values,(_,i)=>i/1000),1),values:new T.Float32BufferAttribute(values,1)};const samples=curveSamples(track,0,200);assert.ok(samples.length<=202);assert.ok(samples.some(p=>p[1]===100));assert.ok(samples.some(p=>p[1]===-100));assert.equal(samples.at(-1)[0],track.times.getX(9999));
});

async function fixture(fn){const base=await mkdtemp(join(tmpdir(),'motion-resources-')),root=join(base,'arbitrary-layout'),work=join(base,'review');await mkdir(root);await initializeWorkspace(work);await linkProject(work,root);try{await fn({base,root,work});}finally{await rm(base,{recursive:true,force:true});}}
async function scan(work){await startCatalogScan(work,{force:true});return waitForCatalogScan(work);}

test('a model-only project stays usable with no map, code, animations, Blender or Agent',()=>fixture(async({root,work})=>{
 await writeFile(join(root,'object.glb'),variant({animation:false}));await scan(work);const page=await characterPage(work,{preferMapped:true});assert.equal(page.kind,'files');assert.equal(page.entries.filter(e=>e.origin==='project').length,1);const row=page.entries.find(e=>e.name==='object.glb');await openCatalogAsset(work,row.id);const head=modelSlots(await readProject(work),row.id).baseline;assert.equal(head.capabilities.preview,'model');assert.deepEqual(head.clips,[]);const job=await createJob(work,{assetId:row.id,request:'Fix the static silhouette',slot:'baseline',context:{assetId:row.id,asset:head,clip:null,time:0},scope:{start:0,end:0,wholeClip:true}});assert.equal(job.clip,'');
}));

test('a motion-only project opens nodes and raw curves, ignores ordinary JSON, and isolates invalid sources',()=>fixture(async({root,work})=>{
 await writeFile(join(root,'motion.glb'),variant({mesh:false,rig:true}));await writeFile(join(root,'curves.json'),bytes(pack()));await writeFile(join(root,'package.json'),bytes({name:'unrelated'}));await writeFile(join(root,'moves.json'),bytes({clips:{Idle:{duration:1,events:[]}}}));await writeFile(join(root,'bad.json'),bytes({format:'sampled-tracks-v1',fps:0,clips:{}}));await writeFile(join(root,'bad.glb'),'broken');await scan(work);
 const page=await characterPage(work,{preferMapped:true}),project=page.entries.filter(e=>e.origin==='project');assert.equal(project.length,4);assert.equal(project.find(e=>e.name==='bad.json').status,'invalid');assert.equal(project.find(e=>e.name==='bad.glb').status,'invalid');
 const skeleton=project.find(e=>e.name==='motion.glb');await openCatalogAsset(work,skeleton.id);assert.equal(modelSlots(await readProject(work),skeleton.id).baseline.capabilities.preview,'skeleton');const raw=project.find(e=>e.name==='curves.json');await openCatalogAsset(work,raw.id);let cfg=await readProject(work),head=modelSlots(cfg,raw.id).baseline;assert.equal(head.capabilities.preview,'curves');assert.equal(sha(await readFile(join(work,head.source.file))),sha(bytes(pack())));
 const before=structuredClone(cfg.models);await writeFile(join(root,'curves.json'),bytes({format:'sampled-tracks-v1',fps:0}));await scan(work);await assert.rejects(openCatalogAsset(work,raw.id,{refreshSource:true}));assert.deepEqual((await readProject(work)).models,before);await openCatalogAsset(work,skeleton.id);assert.equal((await readProject(work)).activeAssetId,skeleton.id);
 await rm(join(root,'motion.glb'));await scan(work);await openCatalogAsset(work,skeleton.id);assert.equal(modelSlots(await readProject(work),skeleton.id).baseline.capabilities.preview,'skeleton');
}));

test('curve jobs share frozen source/history, reject corrupt or incompatible candidates, and preserve legacy jobs byte for byte',()=>fixture(async({root,work})=>{
 const initial=(await readProject(work)).slots.baseline;const old=await createJob(work,{request:'Legacy observation',slot:'baseline',context:{asset:initial,clip:'Run',time:0},scope:{start:0,end:1,wholeClip:true}}),oldPath=join(work,'jobs',old.id,'job.json'),oldBytes=await readFile(oldPath);
 const head=await importBytes(work,'baseline',bytes(pack()),'only-motion.json',{newModel:true}),id=head.assetId;
 const context={assetId:id,asset:head,clip:'Reach',time:.5,resourceObservation:{kind:'curve',binding:'strength',component:0,clip:'Reach',time:.5}},job=await createJob(work,{assetId:id,request:'Reduce the rotation peak',slot:'baseline',context,scope:{start:0,end:1,wholeClip:true}}),claim=await claimJob(work,job.id);
 const candidate=join(work,'output.glb');await writeFile(candidate,variant());await assert.rejects(completeJob(work,job.id,{lease:claim.lease,candidatePath:candidate,summary:'bad'}),/采样曲线/);assert.equal(modelSlots(await readProject(work),id).candidate.sha256,head.sha256);assert.equal((await getJob(work,job.id)).state,'running');
 const changed=createCurveResource(bytes(pack(.2)));await writeFile(candidate,changed);const done=await completeJob(work,job.id,{lease:claim.lease,candidatePath:candidate,summary:'Reduced curve peak'});assert.equal(done.context.resourceObservation.binding,'strength');assert.equal(done.candidate.sha256,sha(changed));assert.deepEqual(await readFile(oldPath),oldBytes);
 await writeFile(join(root,'curves.json'),bytes(pack(.1)));const f=await importFile(work,'baseline',join(root,'curves.json'),{newModel:true});assert.equal(f.source.format,'sampled-tracks-v1');assert.notEqual(f.assetId,id);assert.equal(modelSlots(await readProject(work),id).candidate.sha256,sha(changed));assert.ok((await readdir(join(work,'jobs'))).includes(old.id));
}));

test('resource combinations are explicit: static model + compatible motion, incompatible skeleton, and curves with a declared target',async()=>{
 const model=variant({animation:false}),motion=variant({mesh:false}),combined=await assembleCharacter(model,[{file:'motions.glb',format:'glb',bytes:motion}]);assert.equal(combined.sources[0].status,'ready');assert.deepEqual(glbInfo(combined.bytes).clips.map(c=>c.name),['Run','Salute']);assert.equal(glbInfo(combined.bytes).capabilities.hasMesh,true);
 const bad=parseGlb(motion);bad.doc.nodes.find(n=>n.name==='LeftShoulder').translation=[20,0,0];const rejected=await assembleCharacter(model,[{file:'wrong.glb',format:'glb',bytes:encodeGlb(bad.doc,bad.bin)}]);assert.notEqual(rejected.sources[0].status,'ready');assert.deepEqual(rejected.bytes,model);
 const declared=await assembleCharacter(model,[{file:'curves.json',format:'sampled-tracks-v1',bytes:bytes({fps:2,clips:{Reach:{duration:1,tracks:pack().clips.Reach.tracks.slice(0,1)}}})}]);assert.equal(declared.sources[0].status,'ready');validateCandidate(declared.bytes);assert.equal(glbInfo(declared.bytes).capabilities.preview,'model');
});

// Exercise the actual curve panel selection, snapshot rendering and shared axes.
import {createResourcePanel} from '../../assets/viewer/resource-preview.mjs';
import {createDocument} from './viewer-dom-fixture.mjs';
function panelFixture(){const document=createDocument(),make=document.createElement.bind(document),texts=[];document.createElement=tag=>{const e=make(tag);if(tag==='select'){Object.defineProperty(e,'options',{get:()=>e.children});const append=e.append.bind(e),replace=e.replaceChildren.bind(e);e.append=(...nodes)=>{append(...nodes);if(!e.value)e.value=e.children[0]?.value||'';};e.replaceChildren=(...nodes)=>{e.value='';replace(...nodes);};}if(tag==='canvas'){e.getBoundingClientRect=()=>({width:400,height:220});const ctx=new Proxy({fillText:t=>texts.push(t)},{get:(o,k)=>o[k]||(()=>{})});e.getContext=()=>ctx;}return e;};let changes=0;const panel=createResourcePanel({document,onChange:()=>changes++});return {panel,texts,get changes(){return changes;}};}

test('curve panel keeps the selected binding through playback, restores observations, and paints common numeric axes',async()=>{
 const a=await prepareResource(fakeGltf(createCurveResource(bytes(pack()))),T),b=await prepareResource(fakeGltf(createCurveResource(bytes(pack(.2)))),T);a.clip=b.clip='Reach';const left=panelFixture(),right=panelFixture();left.panel.render(a,.5);right.panel.render(b,.5);assert.equal(left.changes,0,'loading a clip must not broadcast its default selection over another viewport');
 const select=left.panel.element.children[0];select.value='1';select.onchange();assert.equal(left.panel.observe().binding,'strength');assert.equal(left.changes,1);right.panel.restore(left.panel.observe());assert.equal(right.panel.observe().binding,'strength');assert.equal(right.changes,0,'restoration cannot trigger a selection loop');
 left.panel.render(a,.75);assert.equal(left.panel.observe().binding,'strength');assert.equal(left.panel.observe().time,.75);left.texts.length=0;left.panel.setDomain([-5,5]);left.panel.redraw();assert.ok(left.texts.includes('5.00'));assert.ok(left.texts.some(t=>t.includes('strength')));assert.ok(left.texts.some(t=>t.includes('v1 = 0.4000')));
});

test('oversized recognized JSON is discovered without parsing its payload, and malformed explicit motion is isolated',()=>fixture(async({root,work})=>{
 await writeFile(join(root,'large.json'),bytes(pack()));await writeFile(join(root,'broken.json'),'{"format":"sampled-tracks-v1","fps":');await writeFile(join(root,'unrelated.json'),'{"name":');await startCatalogScan(work,{force:true,limits:{maxMetadataBytes:100}});await waitForCatalogScan(work);const rows=(await catalogPage(work)).entries.filter(r=>r.origin==='project');assert.equal(rows.length,2);const large=rows.find(r=>r.name==='large.json');assert.equal(large.status,'available');assert.equal(large.metadata,undefined);await openCatalogAsset(work,large.id);assert.equal(modelSlots(await readProject(work),large.id).baseline.capabilities.preview,'curves');assert.equal(rows.find(r=>r.name==='broken.json').status,'invalid');
}));
