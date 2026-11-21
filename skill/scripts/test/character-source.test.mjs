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
import {parseGlb,encodeGlb,editGlb} from '../asset-tools.mjs';
import {clipChanges} from '../candidate-diff.mjs';
import {readProject,modelSlots,sha,importAsset} from '../core.mjs';
import {saveDraft} from '../drafts.mjs';
import {createJob,cancelJob,claimJob,failJob,getJob} from '../jobs.mjs';
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

test('a source update waits for running work and for a draft about a clip it changed; anything else goes through',()=>fixture(async({root,work})=>{
 const opened=await characterSource(work,{...expected,refreshSource:true}),id=opened.assetId,heads=modelSlots(await readProject(work),id);
 const job=await createJob(work,{assetId:id,request:'Synthetic running work',slot:'baseline',context:{asset:heads.baseline,clip:'Run',time:.2}});const claim=await claimJob(work,job.id);
 const next=editGlb(bytes,{clip:'Salute',bone:'LeftShoulder',factor:.5}).bytes,options={...expected,expectedSha256:sha(next),refreshSource:true};await writeFile(join(root,model),next);
 await assert.rejects(characterSource(work,options),/正在执行/);assert.ok((await characterSource(work,{profileId:'hero'})).blockers.some(b=>/正在执行/.test(b)));
 await failJob(work,job.id,{lease:claim.lease,error:'stopped for the test'});
 await saveDraft(work,id,{expectedRevision:0,draft:{assetId:id,context:{assetId:id,clip:'Salute'},request:'unfinished edit',preserve:''}});
 const saved=await readFile(join(work,'drafts',id+'.json'));await assert.rejects(characterSource(work,options),/草稿（Salute）/);assert.deepEqual(await readFile(join(work,'drafts',id+'.json')),saved);
 await saveDraft(work,id,{expectedRevision:1,draft:{assetId:id,context:{assetId:id,clip:'Run'},request:'a draft about a clip the update left alone',preserve:''}});
 assert.equal((await characterSource(work,options)).status,'current');assert.equal(modelSlots(await readProject(work),id).baseline.source.sha256,sha(next));
}));

test('a source update sorts the old work clip by clip: queued tasks go stale with the reason, the candidate keeps the clips that still apply',()=>fixture(async({root,work})=>{
 const opened=await characterSource(work,{...expected,refreshSource:true}),id=opened.assetId;let heads=modelSlots(await readProject(work),id);
 const done=await createJob(work,{assetId:id,request:'raise the run arm',slot:'baseline',context:{asset:heads.baseline,clip:'Run',time:.2}});
 const claim=await claimJob(work,done.id);await failJob(work,done.id,{lease:claim.lease,error:'kept as history'});
 const queued=await createJob(work,{assetId:id,request:'salute higher',slot:'baseline',context:{asset:heads.baseline,clip:'Salute',time:.2}});
 const base=await readFile(join(work,heads.baseline.file)),edited=editGlb(base,{clip:'Run',bone:'LeftShoulder',factor:.7}).bytes;
 await importAsset(work,'candidate',edited,'Run edit',{assetId:id});const revision=(await readProject(work)).models[id].headRevision;
 const next=editGlb(bytes,{clip:'Salute',bone:'LeftShoulder',factor:.5}).bytes;await writeFile(join(root,model),next);
 const result=await characterSource(work,{...expected,expectedSha256:sha(next),refreshSource:true});assert.equal(result.status,'current');assert.deepEqual(result.sourceUpdate.carried,['Run'],'the delivery result says what was carried');
 const cfg=await readProject(work);heads=modelSlots(cfg,id);assert.equal(cfg.models[id].headRevision,revision+1,'one update, one head revision');
 assert.deepEqual(cfg.models[id].sourceUpdate.carried,['Run']);assert.deepEqual(cfg.models[id].sourceUpdate.dropped,[]);
 const nb=await readFile(join(work,heads.baseline.file)),nc=await readFile(join(work,heads.candidate.file));
 assert.deepEqual([...clipChanges(nb,nc,['Run','Salute'])],[['Run','changed'],['Salute','unchanged']],'the new source with the candidate\'s run');
 assert.deepEqual([...clipChanges(edited,nc,['Run'])],[['Run','unchanged']],'the run carried as it was');
 const q=await getJob(work,queued.id),d=await getJob(work,done.id);
 assert.equal(q.state,'stale');assert.equal(q.sourceUpdate.status,'changed');assert.match(q.events.at(-1).message,/已被新版本替换/);
 assert.equal(d.state,'failed');assert.equal(d.sourceUpdate.status,'unchanged');
}));

test('a clip removed from the game source archives the candidate\'s edit of it and marks its tasks removed',()=>fixture(async({root,work})=>{
 const opened=await characterSource(work,{...expected,refreshSource:true}),id=opened.assetId;let heads=modelSlots(await readProject(work),id);
 const job=await createJob(work,{assetId:id,request:'salute higher',slot:'baseline',context:{asset:heads.baseline,clip:'Salute',time:.2}});
 const base=await readFile(join(work,heads.baseline.file)),edited=editGlb(base,{clip:'Salute',bone:'LeftShoulder',factor:.7}).bytes;
 const claim=await claimJob(work,job.id);await failJob(work,job.id,{lease:claim.lease,error:'kept'});await importAsset(work,'candidate',edited,'Salute edit',{assetId:id});
 const p=parseGlb(bytes);p.doc.animations=p.doc.animations.filter(a=>a.name!=='Salute');const next=encodeGlb(p.doc,p.bin,p.extra);await writeFile(join(root,model),next);
 await characterSource(work,{...expected,expectedSha256:sha(next),refreshSource:true});
 const cfg=await readProject(work);heads=modelSlots(cfg,id);
 assert.equal(heads.candidate.sha256,heads.baseline.sha256,'nothing left to carry');assert.deepEqual(cfg.models[id].sourceUpdate.dropped,[{clip:'Salute',status:'removed'}]);
 assert.equal(cfg.models[id].revisions.at(-1).slots.candidate.sha256,sha(edited),'the old pair archived');
 assert.equal((await getJob(work,job.id)).sourceUpdate.status,'removed');
}));

test('the stage follows the game: a changed model is loaded when it holds still, and running work holds it back with the reason',()=>fixture(async({root,work})=>{
 const opened=await characterSource(work,{...expected,refreshSource:true}),id=opened.assetId;
 const server=await serve(work,0,{watchSources:true,sourcePoll:{interval:40,stable:80}}),base='http://127.0.0.1:'+server.address().port;
 const studio=async()=>(await fetch(base+'/api/studio?compact=1&assetId='+id)).json();
 const until=async(test,what)=>{for(let i=0;i<150;i++){const d=await studio();if(test(d))return d;await new Promise(r=>setTimeout(r,40));}throw Error('timed out waiting for '+what);};
 try{
  const next=editGlb(bytes,{clip:'Salute',bone:'LeftShoulder',factor:.5}).bytes;await writeFile(join(root,model),next);
  await until(d=>d.project?.slots?.baseline?.source?.sha256===sha(next)&&d.sourceSync?.state==='synced','the new source');
  const heads=modelSlots(await readProject(work),id),job=await createJob(work,{assetId:id,request:'running',slot:'baseline',context:{asset:heads.baseline,clip:'Run',time:.2}});await claimJob(work,job.id);
  const third=editGlb(bytes,{clip:'Run',bone:'LeftShoulder',factor:.4}).bytes;await writeFile(join(root,model),third);
  const blocked=await until(d=>d.sourceSync?.state==='blocked','the hold');assert.match(blocked.sourceSync.reasons.join(),/正在执行/);
  assert.equal(modelSlots(await readProject(work),id).baseline.source.sha256,sha(next),'not replaced under running work');
 }finally{await new Promise(r=>server.close(r));}
}));

test('CLI reports a stale source with nonzero status and HTTP identifies the running and installed release',()=>fixture(async({root,work})=>{
 await characterSource(work,{...expected,refreshSource:true});await writeFile(join(root,model),changed());
 await assert.rejects(run(process.execPath,[fileURLToPath(new URL('../motion-feedback.mjs',import.meta.url)),'character-source','--workspace',work,'--profile-id','hero']),error=>{assert.equal(error.code,1);assert.equal(JSON.parse(error.stdout).status,'stale');return true;});
 const server=await serve(work,0);try{const session=await(await fetch('http://127.0.0.1:'+server.address().port+'/api/session')).json();assert.equal(session.runtime.version,'4.8.0');assert.equal(session.runtime.installedVersion,session.runtime.version);}finally{await new Promise(r=>server.close(r));}
}));
