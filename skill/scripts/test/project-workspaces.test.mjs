import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp,readdir,symlink,realpath,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace,prepareProject,projectStatus,recentProjects} from '../project-workspaces.mjs';
import {createJob,getJob,claimJob,cancelJob,localEditJob,reviewJob,getJobProjectContext,completeJob} from '../jobs.mjs';
import {json,sha,atomic} from '../core.mjs';
import {parseGlb,encodeGlb} from '../asset-tools.mjs';
import {serve} from '../server.mjs';
import {linkProject} from '../project-context.mjs';
async function fixture(run){const base=await realpath(await mkdtemp(join(tmpdir(),'motion-project-flow-')));try{const work=join(base,'standalone'),root=join(base,'Game A'),settingsPath=join(base,'settings.json');await mkdir(join(root,'src'),{recursive:true});await writeFile(join(root,'package.json'),'{}');await writeFile(join(root,'src','motion.js'),'export const heroSpeed=1;\n');await initializeWorkspace(work);await run({base,work,root,settingsPath});}finally{await rm(base,{recursive:true,force:true});}}
async function enqueue(w,{slot='baseline',parentJobId,...rest}={}){const p=await json(join(w,'project.json'));return createJob(w,{request:'收小左肩摆动，其他数据保持',preserve:'腿脚、右臂和所有原有动作保持',slot,parentJobId,target:{bone:'LeftShoulder'},scope:{wholeClip:true,start:0,end:1},context:{slot,asset:p.slots[slot],clip:'Run',time:.3,fps:30},...rest});}

test('project association copies owned history atomically, reuses existing data and survives project move',()=>fixture(async({base,work,root,settingsPath})=>{
 const before=await readFile(join(work,'project.json'));const j=await enqueue(work);await cancelJob(work,j.id);
 const r=await prepareProject(work,root,{settingsPath});assert.equal(r.migrated,true);assert.equal(r.workspace,join(root,'.motion-studio'));assert.deepEqual(await readFile(join(work,'project.json')),before);assert.equal((await getJob(r.workspace,j.id)).state,'cancelled');
 const original=await json(join(work,'project.json')),copied=await json(join(r.workspace,'project.json'));assert.equal(copied.slots.baseline.sha256,original.slots.baseline.sha256);assert.ok(await readFile(join(r.workspace,original.slots.baseline.file)));
 const again=await prepareProject(work,root,{settingsPath});assert.equal(again.reused,true);assert.equal(again.migrated,false);assert.deepEqual(await readFile(join(r.workspace,'project.json')),before);
 const moved=join(base,'Moved Game');await cp(root,moved,{recursive:true});const status=await projectStatus(join(moved,'.motion-studio'),{settingsPath});assert.equal(status.status,'linked');assert.equal(status.project.id,r.project.id);assert.equal(status.project.root,moved);assert.equal((await getJob(join(moved,'.motion-studio'),j.id)).taskPath.startsWith(moved),true);
 assert.equal((await recentProjects({settingsPath})).length,1);
}));

test('switching linked projects never migrates the other project and unknown folders are preserved',()=>fixture(async({base,work,root,settingsPath})=>{
 const a=await prepareProject(work,root,{settingsPath});const job=await enqueue(a.workspace);await cancelJob(a.workspace,job.id);
 const other=join(base,'Game B');await mkdir(other);const b=await prepareProject(a.workspace,other,{adoptCurrent:true,settingsPath});assert.equal(b.migrated,false);assert.equal(b.migrationSkippedReason,'different-linked-project');assert.notEqual(b.project.id,a.project.id);assert.equal(await readFile(join(a.workspace,'jobs',job.id,'job.json'),'utf8').then(()=>true),true);assert.equal((await readdir(b.workspace)).includes('jobs'),false);
 const occupied=join(base,'Occupied');await mkdir(join(occupied,'.motion-studio'),{recursive:true});await writeFile(join(occupied,'.motion-studio','artist.txt'),'keep');await assert.rejects(prepareProject(work,occupied,{settingsPath}),/未知文件/);assert.equal(await readFile(join(occupied,'.motion-studio','artist.txt'),'utf8'),'keep');
}));

test('reopening an explicitly linked external review reuses its records and leaves the game untouched',()=>fixture(async({base,work,root,settingsPath})=>{
 const linked=await linkProject(work,root),job=await enqueue(work);await cancelJob(work,job.id);
 const before=await readFile(join(work,'jobs',job.id,'job.json')),filesBefore=await readdir(root);
 const opened=await prepareProject(work,root,{settingsPath});assert.equal(opened.workspace,work);assert.equal(opened.reused,true);assert.equal(opened.migrated,false);assert.equal(opened.project.id,linked.id);
 const restarted=await prepareProject(null,root,{settingsPath});assert.equal(restarted.workspace,work);assert.equal(restarted.project.id,linked.id);
 const other=join(base,'Game B');await mkdir(other);const b=await prepareProject(work,other,{settingsPath});assert.equal(b.migrated,false);assert.notEqual(b.project.id,linked.id);
 const returned=await prepareProject(b.workspace,root,{settingsPath});assert.equal(returned.workspace,work);assert.equal(returned.migrationSkippedReason,'different-linked-project');assert.equal(returned.project.id,linked.id);
 assert.deepEqual(await readdir(root),filesBefore);assert.deepEqual(await readFile(join(work,'jobs',job.id,'job.json')),before);
}));

test('unfinished tasks and workspace symlinks prevent migration without damaging either project',()=>fixture(async({work,root,settingsPath})=>{
 const j=await enqueue(work);await assert.rejects(prepareProject(work,root,{settingsPath}),/任务/);assert.equal((await getJob(work,j.id)).state,'queued');assert.equal((await readdir(root)).some(n=>n.startsWith('.motion-studio.init-')),false);
 await cancelJob(work,j.id);await mkdir(join(work,'sources'));await symlink(process.platform==='win32'?join(root,'src'):join(root,'src','motion.js'),join(work,'sources','outside.js'),process.platform==='win32'?'junction':'file');await assert.rejects(prepareProject(work,root,{settingsPath}),/符号链接/);assert.equal(await readFile(join(root,'src','motion.js'),'utf8'),'export const heroSpeed=1;\n');assert.equal((await readdir(root)).some(n=>n.startsWith('.motion-studio.init-')),false);
}));

test('accepted preview checkpoints and inherited requirements are bound to the chosen candidate',()=>fixture(async({work,root,settingsPath})=>{
 const {workspace:w}=await prepareProject(work,root,{settingsPath});const first=await enqueue(w);await localEditJob(w,first.id,{bone:'LeftShoulder',factor:.7});const accepted=await reviewJob(w,first.id,{decision:'accept-candidate',outcome:'Synthetic QA acceptance only: keep this left-arm spacing.'});
 assert.equal((await json(join(w,accepted.reviews.at(-1).checkpointFile))).installed,false);const checkpoint=await readFile(join(w,accepted.reviews.at(-1).checkpointFile));
 const next=await enqueue(w,{slot:'candidate',parentJobId:first.id,request:'在这一版基础上再收一点'});const packet=await getJobProjectContext(w,next.id);assert.equal(packet.continuity.parentJobId,first.id);assert.ok(packet.continuity.inheritedRequirements.some(x=>x.text.includes('腿脚')));assert.ok(packet.continuity.acceptedCheckpoints.some(x=>x.sha256===accepted.candidate.sha256));assert.equal(next.inputs.candidate.sha256,accepted.candidate.sha256);
 const frozenBefore=await readFile(join(w,next.projectContextFile));await cancelJob(w,next.id);await reviewJob(w,first.id,{decision:'revise',outcome:'Synthetic later decision; retain old history.'});assert.deepEqual(await readFile(join(w,accepted.reviews.at(-1).checkpointFile)),checkpoint);assert.deepEqual(await readFile(join(w,next.projectContextFile)),frozenBefore);
 const another=await enqueue(w,{slot:'candidate',parentJobId:first.id});const raw=await json(join(w,another.projectContextFile));assert.equal(raw.continuity.acceptedCheckpoints.find(x=>x.sha256===accepted.candidate.sha256)?.active,false);await cancelJob(w,another.id);
}));

test('candidate completion cannot silently remove another existing animation',()=>fixture(async({work})=>{
 const j=await enqueue(work),claim=await claimJob(work,j.id),p=await json(join(work,'project.json'));const{doc,bin,extra}=parseGlb(await readFile(join(work,p.slots.baseline.file)));assert.equal(doc.animations.length>1,true);doc.animations=doc.animations.filter(a=>a.name==='Run');const output=join(work,'lost-action.glb');await writeFile(output,encodeGlb(doc,bin,extra));
 await assert.rejects(completeJob(work,j.id,{lease:claim.lease,candidatePath:output,summary:'Synthetic incomplete export'}),/缺少原有动作/);assert.equal((await json(join(work,'project.json'))).slots.candidate.sha256,p.slots.candidate.sha256);await cancelJob(work,j.id);
}));

test('HTTP project picker/open returns isolated project server and frozen context endpoint',()=>fixture(async({work,root,settingsPath})=>{
 const server=await serve(work,0,{settingsPath,chooseFolder:async()=>({path:root,cancelled:false})});try{
  const url='http://127.0.0.1:'+server.address().port,s=await(await fetch(url+'/api/session')).json();
  const post=async(path,input)=>{const r=await fetch(url+path,{method:'POST',headers:{'x-motion-token':s.token},body:JSON.stringify(input)});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
  assert.equal((await(await fetch(url+'/api/project')).json()).status,'unlinked');assert.equal((await post('/api/project/select-folder',{})).path,root);
  const opened=await post('/api/project/open',{path:root,adoptCurrent:true});assert.notEqual(opened.url,url+'/');assert.equal(opened.project.root,root);assert.equal((await(await fetch(opened.url+'api/project')).json()).status,'linked');assert.equal((await(await fetch(url+'/api/project')).json()).status,'unlinked');
  const job=await enqueue(opened.workspace);const frozen=await(await fetch(opened.url+'api/jobs/'+job.id+'/project-context')).json();assert.equal(frozen.projectContext.status,'linked');assert.equal(frozen.continuity.sourceSha256,job.inputs.baseline.sha256);await cancelJob(opened.workspace,job.id);
 }finally{await new Promise(r=>server.close(r));}
}));

test('ordinary clarification never adopts changed linked authoring files',()=>fixture(async({work,root,settingsPath})=>{
 const {workspace:w}=await prepareProject(work,root,{settingsPath}),cfg=await json(join(w,'project.json'));await mkdir(join(root,'author'));await writeFile(join(root,'author','hero.gltf'),'{"asset":{"version":"2.0"}}');
 const link=await json(join(w,'project-link.json'));link.assetLinks=[{asset:{sha256:cfg.slots.baseline.sha256},code:['src/motion.js'],sources:['author/hero.gltf']}];await atomic(join(w,'project-link.json'),link);
 const job=await enqueue(w),claim=await claimJob(w,job.id);const {failJob,replyJob}=await import('../jobs.mjs');await failJob(w,job.id,{lease:claim.lease,state:'needs-input',error:'请确认修改倍率'});const snapshot=await readFile(join(w,job.projectContextFile));await writeFile(join(root,'author','hero.gltf'),'{"asset":{"version":"2.0"},"extras":{"changed":true}}');
 await assert.rejects(replyJob(w,job.id,{message:'倍率90%'}),/上下文已变化/);const ended=await getJob(w,job.id);assert.equal(ended.state,'stale');assert.equal(ended.contextRevision,1);assert.deepEqual(await readFile(join(w,job.projectContextFile)),snapshot);assert.equal(ended.clarifications?.length||0,0);
}));

test('owned native import sources rebase across old paths and are marked upstream after a curve edit',()=>fixture(async({work})=>{
 const source=Buffer.from('SYNTHETIC FBX SOURCE FOR PROVENANCE TEST'),originalSha=sha(source),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await mkdir(join(work,'sources'));await writeFile(join(work,'sources',originalSha+'.fbx'),source);const dir=join(work,'conversions',id);await mkdir(dir,{recursive:true});
 const cfg=await json(join(work,'project.json')),asset=cfg.slots.baseline;await cp(join(work,asset.file),join(dir,'converted.glb'));await writeFile(join(dir,'editable.blend'),'SYNTHETIC NATIVE FILE: no render/conversion claim');await atomic(join(dir,'source-map.json'),{source:{sha256:originalSha,fps:30,frameRange:[1,31]}});
 cfg.slots.baseline.source={format:'fbx',sha256:originalSha,file:'sources/'+originalSha+'.fbx',editablePath:'/previous/machine/conversions/'+id+'/editable.blend',previewSha256:asset.sha256};cfg.slots.candidate=structuredClone(cfg.slots.baseline);cfg.models[cfg.activeAssetId].slots=structuredClone(cfg.slots);await atomic(join(work,'project.json'),cfg);
 const first=await enqueue(work),p=await getJobProjectContext(work,first.id),native=p.projectContext.sources.find(x=>x.workspaceRelativePath?.endsWith('editable.blend'));assert.ok(native);assert.equal(native.confidence,'linked');assert.equal(native.metadata.upstreamOnly,false);
 await localEditJob(work,first.id,{bone:'LeftShoulder',factor:.7});const second=await enqueue(work,{slot:'candidate',parentJobId:first.id}),next=await getJobProjectContext(work,second.id);assert.equal(next.projectContext.sources.find(x=>x.workspaceRelativePath?.endsWith('editable.blend')).metadata.upstreamOnly,true);assert.ok(next.projectContext.warnings.some(x=>x.includes('上游')));await cancelJob(work,second.id);
}));

test('legacy candidates without source retain the exact multi-hop production source',()=>fixture(async({work,root,settingsPath})=>{
 const {workspace:w}=await prepareProject(work,root,{settingsPath}),cfg=await json(join(w,'project.json'));await mkdir(join(root,'models'));await cp(join(w,cfg.slots.baseline.file),join(root,'models','hero.glb'));const {importFile}=await import('../jobs.mjs');await importFile(w,'baseline',join(root,'models','hero.glb'));
 const a=await enqueue(w);await localEditJob(w,a.id,{bone:'LeftShoulder',factor:.7});let state=await json(join(w,'project.json'));delete state.slots.candidate.source;state.version=3;await atomic(join(w,'project.json'),state);const aj=await json(join(w,'jobs',a.id,'job.json'));delete aj.candidate.source;await atomic(join(w,'jobs',a.id,'job.json'),aj);
 const b=await enqueue(w,{slot:'candidate',parentJobId:a.id});await localEditJob(w,b.id,{bone:'LeftShoulder',factor:.9});state=await json(join(w,'project.json'));delete state.slots.candidate.source;state.version=3;await atomic(join(w,'project.json'),state);const bj=await json(join(w,'jobs',b.id,'job.json'));delete bj.source;delete bj.candidate.source;await atomic(join(w,'jobs',b.id,'job.json'),bj);
 const c=await enqueue(w,{slot:'candidate',parentJobId:b.id}),packet=await getJobProjectContext(w,c.id);assert.equal(packet.continuity.provenanceChain.length,2);assert.ok(packet.projectContext.sources.some(x=>x.relativePath==='models/hero.glb'&&x.confidence==='linked'));assert.equal(packet.projectContext.task.sourceProvenance.upstreamOnly,true);await cancelJob(w,c.id);
}));


test('migration honors an explicit legacy return without rewriting the original workspace',()=>fixture(async({work,root,settingsPath})=>{
 const first=await enqueue(work),done=await localEditJob(work,first.id,{bone:'LeftShoulder',factor:.7});await reviewJob(work,first.id,{decision:'keep-baseline',outcome:'Synthetic legacy user chose the original.'});
 const jobPath=join(work,'jobs',first.id,'job.json'),old=await json(jobPath);delete old.reviews.at(-1).recordFile;delete old.reviews.at(-1).id;delete old.restoredSource;await atomic(jobPath,old);
 const cfg=await json(join(work,'project.json'));cfg.slots.candidate=done.candidate;cfg.version=3;await atomic(join(work,'project.json'),cfg);const before=await readFile(join(work,'project.json'));const then=new Date(Date.parse(old.reviews.at(-1).at)-2000);await utimes(join(work,'project.json'),then,then);
 const migrated=await prepareProject(work,root,{settingsPath}),next=await json(join(migrated.workspace,'project.json'));assert.equal(next.slots.candidate.sha256,old.reviews.at(-1).assets.baseline.sha256);assert.equal(next.migrationNotes.at(-1).kind,'honored-recorded-legacy-return');assert.deepEqual(await readFile(join(work,'project.json')),before);assert.ok(await readFile(join(migrated.workspace,done.candidate.file)));
}));
