import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {linkProject} from '../project-context.mjs';
import {parseGlb,encodeGlb,editGlb} from '../asset-tools.mjs';
import {readProject,modelSlots,importAsset,sha} from '../core.mjs';
import {startCatalogScan,waitForCatalogScan,stopCatalogScan,openCatalogAsset,catalogPage} from '../asset-catalog.mjs';
import {characterPage,openCharacter,saveCharacterMap,associateCharacterMotion} from '../character-library.mjs';
import {characterProfileDigest} from '../source-dependencies.mjs';
import {createJob,claimJob,getJob} from '../jobs.mjs';
import {serve} from '../server.mjs';
const bytes=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
const pose={fps:60,clips:{Pose:{duration:1,tracks:[['LeftShoulder.quaternion','quaternion',4,[0,0,0,1]]]}}};
const map=()=>({version:1,characters:[{id:'hero',name:'角色甲',model:'models/hero.glb',variants:['models/old.glb'],animations:[{file:'motions/explore.glb',format:'glb'},{file:'motions/director.json',format:'sampled-tracks-v1'}],evidence:[{file:'registry.js'}]}]});
async function fixture(fn){const base=await realpath(await mkdtemp(join(tmpdir(),'motion-characters-'))),root=join(base,'Project'),work=join(base,'review');await mkdir(join(root,'models'),{recursive:true});await mkdir(join(root,'motions'));await initializeWorkspace(work);await linkProject(work,root);
 const p=parseGlb(bytes);p.doc.animations=[p.doc.animations[0]];p.doc.animations[0].name='Explore';delete p.doc.meshes;for(const n of p.doc.nodes){delete n.mesh;delete n.skin;}
 await Promise.all([writeFile(join(root,'models/hero.glb'),bytes),writeFile(join(root,'models/old.glb'),bytes),writeFile(join(root,'motions/explore.glb'),encodeGlb(p.doc,p.bin)),writeFile(join(root,'motions/director.json'),JSON.stringify(pose)),writeFile(join(root,'registry.js'),'// model and animation declarations')]);
 await startCatalogScan(work,{force:true});await waitForCatalogScan(work);
 try{await fn({base,root,work});}finally{await stopCatalogScan(work);await rm(base,{recursive:true,force:true});}}
async function enqueue(work,id){const cfg=await readProject(work),heads=modelSlots(cfg,id);return createJob(work,{assetId:id,request:'Synthetic QA only',slot:'baseline',context:{asset:heads.baseline,clip:'Run',time:.2}});}

test('profiles collapse variants and external sources; complete motions are lazy and isolated from raw model history',()=>fixture(async({root,work})=>{
 const raw=(await catalogPage(work)).entries.find(e=>e.relativePath==='models/hero.glb');await openCatalogAsset(work,raw.id);const before=structuredClone(modelSlots(await readProject(work),raw.id));
 await saveCharacterMap(work,map());const page=await characterPage(work);assert.equal(page.entries.length,1);const role=page.entries[0];assert.equal(role.embeddedCount,2);assert.equal(role.externalCount,2);assert.equal(role.motionSources[0].status,'declared');assert.equal(Object.keys((await readProject(work)).models).length,2,'listing imports no geometry');
 await Promise.all([openCharacter(work,role.id),openCharacter(work,role.id)]);const cfg=await readProject(work),heads=modelSlots(cfg,role.id);assert.deepEqual(heads.baseline.clips.map(c=>c.name),['Run','Salute','Explore','Pose']);assert.equal(cfg.models[role.id].headRevision,1);assert.deepEqual(modelSlots(cfg,raw.id),before);assert.equal((await characterPage(work)).entries[0].motionSources[0].status,'ready');assert.equal(heads.baseline.source.assembly.clips.Explore.file,'motions/explore.glb');assert.equal(sha(await readFile(join(root,'models/hero.glb'))),sha(bytes));
}));

test('animation-only sources are valid files, never automatic characters, and open independently',()=>fixture(async({work})=>{
 const files=await catalogPage(work),motion=files.entries.find(e=>e.relativePath==='motions/explore.glb');assert.equal(motion.status,'available');assert.equal(motion.metadata.kind,'node-animation');assert.equal((await characterPage(work)).entries.length,2,'compatible source does not establish ownership');await openCatalogAsset(work,motion.id);assert.equal((await readProject(work)).activeAssetId,motion.id);
}));

test('missing, unsupported and incompatible sources do not block base or other motions',()=>fixture(async({root,work})=>{
 const m=map();m.characters[0].animations.push({file:'motions/absent.fbx',format:'unsupported'});const p=parseGlb(await readFile(join(root,'motions/explore.glb')));p.doc.nodes.find(n=>n.name==='LeftShoulder').translation=[20,0,0];await writeFile(join(root,'motions/explore.glb'),encodeGlb(p.doc,p.bin));await saveCharacterMap(work,m);const role=(await characterPage(work)).entries[0];await openCharacter(work,role.id);const head=modelSlots(await readProject(work),role.id).baseline;assert.deepEqual(head.clips.map(c=>c.name),['Run','Salute','Pose']);assert.deepEqual(head.source.assembly.sources.map(s=>s.status),['needs-retarget','ready','unavailable']);assert.equal(head.source.assembly.dependencies.some(d=>d.projectRelativePath==='motions/explore.glb'),false);
}));

test('explicit source refresh archives candidates; touch-only refresh preserves candidate, head and queued task',()=>fixture(async({root,work})=>{
 await saveCharacterMap(work,map());const role=(await characterPage(work)).entries[0];await openCharacter(work,role.id);let cfg=await readProject(work),head=modelSlots(cfg,role.id).baseline;
 const edited=editGlb(await readFile(join(work,head.file)),{clip:'Run',bone:'LeftShoulder',factor:.7}).bytes;await importAsset(work,'candidate',edited,'QA candidate',{assetId:role.id});cfg=await readProject(work);const revision=cfg.models[role.id].headRevision,job=await enqueue(work,role.id);
 await utimes(join(root,'motions/director.json'),new Date(),new Date(Date.now()+1000));assert.equal((await characterPage(work)).entries[0].sourceChanged,true);await openCharacter(work,role.id,{refreshSource:true});cfg=await readProject(work);assert.equal(cfg.models[role.id].headRevision,revision);assert.equal(modelSlots(cfg,role.id).candidate.sha256,sha(edited));assert.equal((await characterPage(work)).entries[0].sourceChanged,false);assert.ok((await claimJob(work,job.id)).lease);
 const changed=structuredClone(pose);changed.clips.Pose.tracks[0][3]=[0,.6,0,.8];await writeFile(join(root,'motions/director.json'),JSON.stringify(changed));await openCharacter(work,role.id);assert.equal(modelSlots(await readProject(work),role.id).baseline.sha256,head.sha256);await openCharacter(work,role.id,{refreshSource:true});cfg=await readProject(work);assert.equal(cfg.models[role.id].headRevision,revision+1);assert.equal(cfg.models[role.id].revisions.at(-1).slots.candidate.sha256,sha(edited));
}));

test('consumed motion changes invalidate frozen tasks; unrelated profile changes do not',()=>fixture(async({root,work})=>{
 const m=map();await saveCharacterMap(work,m);const role=(await characterPage(work)).entries[0];await openCharacter(work,role.id);const job=await enqueue(work,role.id);
 m.characters.push({id:'other',model:'models/old.glb',name:'Other'});m.characters[0].variants=[];m.characters[0].animations[0].prefix='new__';await saveCharacterMap(work,m);await assert.rejects(claimJob(work,job.id),/过期/,'changing this role binding invalidates its input');assert.equal((await getJob(work,job.id)).state,'stale');
 await openCharacter(work,role.id,{refreshSource:true});const clean=await enqueue(work,role.id);m.characters[1].name='Other renamed';await saveCharacterMap(work,m);assert.ok((await claimJob(work,clean.id)).lease);
 const changed=await enqueue(work,role.id);await writeFile(join(root,'motions/director.json'),JSON.stringify({...pose,fps:30}));await assert.rejects(claimJob(work,changed.id),/过期/);assert.equal((await getJob(work,changed.id)).state,'stale');
}));

test('changed registry evidence is visible and skips unconfirmed external motions until re-reviewed',()=>fixture(async({root,work})=>{
 await saveCharacterMap(work,map());await writeFile(join(root,'registry.js'),'// changed routing');const role=(await characterPage(work)).entries[0];assert.ok(role.motionSources.every(s=>s.status==='needs-confirmation'));await openCharacter(work,role.id);assert.equal(modelSlots(await readProject(work),role.id).baseline.clips.length,2);assert.ok(modelSlots(await readProject(work),role.id).baseline.source.assembly.sources.every(s=>s.status==='needs-confirmation'));
 await saveCharacterMap(work,map());await openCharacter(work,role.id,{refreshSource:true});assert.equal(modelSlots(await readProject(work),role.id).baseline.clips.length,4);
}));

test('snapshots survive removed mapping and missing files; refresh cannot silently overwrite them',()=>fixture(async({root,work})=>{
 await saveCharacterMap(work,map());const role=(await characterPage(work)).entries[0];await openCharacter(work,role.id);const before=structuredClone(modelSlots(await readProject(work),role.id));await rm(join(root,'models/hero.glb'));await saveCharacterMap(work,{version:1,characters:[]});const retained=(await characterPage(work)).entries.find(r=>r.id===role.id);assert.equal(retained.status,'missing');await openCharacter(work,role.id);assert.deepEqual(modelSlots(await readProject(work),role.id),before);await assert.rejects(openCharacter(work,role.id,{refreshSource:true}),/关联不存在/);
}));

test('explicit association checks compatibility, normalizes Windows separators and protects concurrent mapping edits',()=>fixture(async({work})=>{
 const role=(await characterPage(work)).entries.find(r=>r.relativePath==='models/hero.glb'),motion=(await catalogPage(work)).entries.find(r=>r.metadata.kind==='node-animation');await openCharacter(work,role.id);const job=await enqueue(work,role.id);const result=await associateCharacterMotion(work,role.id,{assetId:motion.id});assert.equal(result.requiresRefresh,true);await assert.rejects(claimJob(work,job.id),/过期/);await openCharacter(work,role.id,{refreshSource:true});assert.ok(modelSlots(await readProject(work),role.id).baseline.clips.some(c=>c.name==='explore__Explore'));
 await assert.rejects(associateCharacterMotion(work,role.id,{assetId:motion.id}),/已经关联/);const m=map();m.characters[0].model='models\\hero.glb';await saveCharacterMap(work,m);assert.equal((await characterPage(work)).entries.find(r=>r.profileId==='hero').relativePath,'models/hero.glb');await assert.rejects(saveCharacterMap(work,m,{expectedDigest:characterProfileDigest({version:1,characters:[]})}),/其他操作/);
 for(const bad of ['../outside.glb','C:\\private.glb','/tmp/private.glb']){const m=map();m.characters[0].model=bad;await assert.rejects(saveCharacterMap(work,m),/项目内/);}
}));

test('HTTP character API keeps authentication, source provenance and raw catalog contract',()=>fixture(async({work})=>{
 const server=await serve(work,0);try{const base='http://127.0.0.1:'+server.address().port;const session=await(await fetch(base+'/api/session')).json();const post=async(path,data)=>fetch(base+path,{method:'POST',headers:{'x-motion-token':session.token},body:JSON.stringify(data)});
 assert.equal((await fetch(base+'/api/characters/map',{method:'POST',body:JSON.stringify(map())})).status,403);assert.equal((await post('/api/characters/map',map())).status,200);const page=await(await fetch(base+'/api/characters')).json();assert.equal(page.entries.length,1);const result=await post('/api/characters/'+page.entries[0].id+'/open',{});assert.equal(result.status,200,await result.clone().text());assert.equal((await result.json()).project.slots.baseline.clips.length,4);assert.ok((await(await fetch(base+'/api/catalog')).json()).entries.length>=3);
 }finally{await new Promise(r=>server.close(r));}
}));

test('mapping corruption is disclosed while owned snapshots remain accessible and can recover',()=>fixture(async({work})=>{
 await saveCharacterMap(work,map());const role=(await characterPage(work)).entries[0];await openCharacter(work,role.id);await writeFile(join(work,'character-map.json'),'{broken');const page=await characterPage(work);assert.ok(page.scan.warnings.some(w=>w.includes('映射无法读取')));assert.ok(page.entries.some(r=>r.id===role.id&&r.opened));await openCharacter(work,role.id);await saveCharacterMap(work,map());assert.equal((await characterPage(work)).entries.find(r=>r.id===role.id).sourceChanged,false);
}));

test('renaming a profile changes display metadata without resetting a candidate or making its task stale',()=>fixture(async({work})=>{
 const m=map();await saveCharacterMap(work,m);const role=(await characterPage(work)).entries[0];await openCharacter(work,role.id);const head=(await readProject(work)).models[role.id].headRevision,job=await enqueue(work,role.id);m.characters[0].name='Renamed';m.characters[0].variants=[];await saveCharacterMap(work,m);await openCharacter(work,role.id,{refreshSource:true});const cfg=await readProject(work);assert.equal(cfg.models[role.id].headRevision,head);assert.equal(cfg.models[role.id].name,'Renamed');assert.ok((await claimJob(work,job.id)).lease);
}));
