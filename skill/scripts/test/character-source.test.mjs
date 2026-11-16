import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {linkProject} from '../project-context.mjs';
import {characterSource,saveCharacterMap} from '../character-library.mjs';
import {parseGlb,encodeGlb} from '../asset-tools.mjs';
import {readProject,modelSlots,sha,importAsset} from '../core.mjs';
import {saveDraft} from '../drafts.mjs';
import {createJob,cancelJob} from '../jobs.mjs';
import {serve} from '../server.mjs';
import {readProjectModel} from '../asset-catalog.mjs';
const run=promisify(execFile),bytes=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
const model='runtime/hero.glb';
const changed=()=>{const p=parseGlb(bytes);p.doc.asset.extras={revision:'new installed model'};return encodeGlb(p.doc,p.bin,p.extra);};
async function fixture(fn){const base=await realpath(await mkdtemp(join(tmpdir(),'motion-source-'))),root=join(base,'game'),work=join(base,'review');try{
 await mkdir(join(root,'runtime'),{recursive:true});await writeFile(join(root,model),bytes);await initializeWorkspace(work);await linkProject(work,root);
 await saveCharacterMap(work,{version:1,characters:[{id:'hero',model}]});await fn({base,root,work});
}finally{await rm(base,{recursive:true,force:true});}}
const expected={profileId:'hero',expectedModel:model,expectedSha256:sha(bytes)};

test('source check is read-only; explicit exact-version refresh archives prior heads and is idempotent',()=>fixture(async({root,work})=>{
 const original=await readFile(join(work,'project.json')),initial=await characterSource(work,expected);assert.equal(initial.status,'unopened');assert.deepEqual(await readFile(join(work,'project.json')),original);
 const opened=await characterSource(work,{...expected,refreshSource:true});assert.equal(opened.status,'current');assert.equal(opened.sourceSha256,opened.snapshotSourceSha256);assert.equal(opened.refreshed,true);
 const next=changed();await writeFile(join(root,model),next);const frozen=await readFile(join(work,'project.json'));
 const stale=await characterSource(work,{profileId:'hero'});assert.equal(stale.status,'stale');assert.equal(stale.snapshotSourceSha256,sha(bytes));assert.deepEqual(await readFile(join(work,'project.json')),frozen);
 assert.equal((await characterSource(work,{...expected})).status,'source-mismatch');
 const result=await characterSource(work,{...expected,expectedSha256:sha(next),refreshSource:true});assert.equal(result.status,'current');assert.equal(result.snapshotSourceSha256,sha(next));
 const cfg=await readProject(work);assert.equal(cfg.models[result.assetId].revisions.at(-1).slots.baseline.source.sha256,sha(bytes));
 assert.equal((await characterSource(work,{...expected,expectedSha256:sha(next),refreshSource:true})).refreshed,false);
}));

test('mapping mismatch, stale expected hash and missing expectations cannot refresh any head',()=>fixture(async({work})=>{
 const before=await readFile(join(work,'project.json'));
 assert.equal((await characterSource(work,{...expected,expectedModel:'runtime/other.glb'})).status,'mapping-mismatch');
 await assert.rejects(characterSource(work,{profileId:'hero',refreshSource:true}),/刷新需要/);
 await assert.rejects(characterSource(work,{...expected,expectedSha256:'0'.repeat(64),refreshSource:true}),/source-mismatch/);
 assert.deepEqual(await readFile(join(work,'project.json')),before);
}));

test('glTF refresh pins referenced buffers even when JSON bytes are unchanged',()=>fixture(async({root,work})=>{
 const {doc,bin}=parseGlb(bytes);doc.buffers[0].uri='hero.bin';const gltf='runtime/hero.gltf';
 await writeFile(join(root,gltf),JSON.stringify(doc));await writeFile(join(root,'runtime/hero.bin'),bin);
 await saveCharacterMap(work,{version:1,characters:[{id:'hero',model:gltf}]});
 const initial=await characterSource(work,{profileId:'hero'}),options={profileId:'hero',expectedModel:gltf,expectedSha256:initial.sourceSha256};
 await assert.rejects(characterSource(work,{...options,refreshSource:true}),/source-fingerprint/);
 const current=await characterSource(work,{...options,expectedFingerprint:initial.sourceFingerprint,refreshSource:true});assert.equal(current.status,'current');assert.equal(current.sourceFingerprint,current.snapshotSourceFingerprint);
 const edited=Buffer.from(bin);edited[edited.length-1]^=1;await writeFile(join(root,'runtime/hero.bin'),edited);
 const stale=await characterSource(work,{profileId:'hero'});assert.equal(stale.status,'stale');assert.equal(stale.sourceSha256,current.sourceSha256);assert.notEqual(stale.sourceFingerprint,current.sourceFingerprint);
 await assert.rejects(characterSource(work,{...options,expectedFingerprint:current.sourceFingerprint,refreshSource:true}),/source-mismatch/);
 const source=await readProjectModel(root,gltf);assert.equal(sha(source.bytes),(await characterSource(work,{...options,expectedFingerprint:stale.sourceFingerprint,refreshSource:true})).previewSha256);
}));

test('external animation assembly compares main-source identity separately from preview bytes',()=>fixture(async({root,work})=>{
 await mkdir(join(root,'motions'));const p=parseGlb(bytes);p.doc.animations=[p.doc.animations[0]];p.doc.animations[0].name='External';await writeFile(join(root,'motions/extra.glb'),encodeGlb(p.doc,p.bin,p.extra));
 await saveCharacterMap(work,{version:1,characters:[{id:'hero',model,animations:[{file:'motions/extra.glb',format:'glb'}]}]});
 const result=await characterSource(work,{...expected,refreshSource:true});assert.equal(result.status,'current');assert.equal(result.sourceSha256,result.snapshotSourceSha256);assert.notEqual(result.previewSha256,result.sourceSha256);assert.equal(result.motionSources[0].status,'ready');
}));

test('safe delivery refresh protects pending jobs, unsent drafts and independent candidates',()=>fixture(async({root,work})=>{
 const opened=await characterSource(work,{...expected,refreshSource:true}),id=opened.assetId,heads=modelSlots(await readProject(work),id);
 const job=await createJob(work,{assetId:id,request:'Synthetic pending work',slot:'baseline',context:{asset:heads.baseline,clip:'Run',time:.2}});
 const next=changed(),options={...expected,expectedSha256:sha(next),refreshSource:true};await writeFile(join(root,model),next);
 await assert.rejects(characterSource(work,options),/待处理任务/);await cancelJob(work,job.id);
 await saveDraft(work,id,{expectedRevision:0,draft:{assetId:id,context:{assetId:id},request:'unfinished edit',preserve:''}});
 const saved=await readFile(join(work,'drafts',id+'.json'));await assert.rejects(characterSource(work,options),/草稿/);assert.deepEqual(await readFile(join(work,'drafts',id+'.json')),saved);
 await saveDraft(work,id,{expectedRevision:1,draft:{assetId:id,context:{assetId:id},request:'',preserve:''}});
 await importAsset(work,'candidate',next,'Synthetic candidate',{assetId:id});await assert.rejects(characterSource(work,options),/独立候选/);
 assert.equal(modelSlots(await readProject(work),id).baseline.source.sha256,sha(bytes));
}));

test('CLI reports a stale source with nonzero status and HTTP identifies the running and installed release',()=>fixture(async({root,work})=>{
 await characterSource(work,{...expected,refreshSource:true});await writeFile(join(root,model),changed());
 await assert.rejects(run(process.execPath,[fileURLToPath(new URL('../motion-feedback.mjs',import.meta.url)),'character-source','--workspace',work,'--profile-id','hero']),error=>{assert.equal(error.code,1);assert.equal(JSON.parse(error.stdout).status,'stale');return true;});
 const server=await serve(work,0);try{const session=await(await fetch('http://127.0.0.1:'+server.address().port+'/api/session')).json();assert.equal(session.runtime.version,'4.6.0');assert.equal(session.runtime.installedVersion,session.runtime.version);}finally{await new Promise(r=>server.close(r));}
}));
