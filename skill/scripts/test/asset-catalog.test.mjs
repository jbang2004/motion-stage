import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,realpath,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {linkProject} from '../project-context.mjs';
import {buildDemo} from '../practice.mjs';
import {parseGlb,encodeGlb,editGlb} from '../asset-tools.mjs';
import {ROOT,json,atomic,sha,readProject,modelSlots,importAsset} from '../core.mjs';
import {startCatalogScan,waitForCatalogScan,readCatalog,catalogPage,openCatalogAsset,stopCatalogScan} from '../asset-catalog.mjs';
import {createJob,claimJob,cancelJob,completeJob,getJob,reviewJob,getJobProjectContext} from '../jobs.mjs';
import {serve} from '../server.mjs';

async function fixture(fn){
 const base=await realpath(await mkdtemp(join(tmpdir(),'motion-catalog-'))),root=join(base,'Project'),work=join(base,'review');
 await mkdir(root);await initializeWorkspace(work);await linkProject(work,root);
 const parsed=parseGlb(await buildDemo(false));parsed.doc.asset.generator='Independent catalog QA fixture';
 const bytes=encodeGlb(parsed.doc,parsed.bin,parsed.extra);
 try{await fn({base,root,work,bytes});}finally{await stopCatalogScan(work);await rm(base,{recursive:true,force:true});}
}
async function scan(work,options={}){await startCatalogScan(work,{force:true,...options});return waitForCatalogScan(work);}
async function enqueue(work,assetId,request='Only reduce the left shoulder swing'){
 const cfg=await readProject(work),heads=modelSlots(cfg,assetId);
 return createJob(work,{assetId,request,preserve:'Keep all other tracks',slot:'baseline',context:{assetId,asset:heads.baseline,slot:'baseline',clip:'Run',time:.2},scope:{start:0,end:1,wholeClip:true},target:{bone:'LeftShoulder'}});
}

test('recursive metadata scan discovers all formats, isolates failures, skips workspaces and links, and deduplicates concurrent starts',()=>fixture(async({root,work,base,bytes})=>{
 await mkdir(join(root,'characters','A'),{recursive:true});await mkdir(join(root,'characters','B'),{recursive:true});
 await writeFile(join(root,'characters','A','hero.GLB'),bytes);await writeFile(join(root,'characters','B','hero.GLB'),bytes);
 await writeFile(join(root,'bad.glb'),'broken');await writeFile(join(root,'animation.fbx'),'not converted during scanning');await writeFile(join(root,'editable.blend'),'source only');
 for(const name of ['node_modules','.motion-studio','.motion-studio.init-old']){await mkdir(join(root,name));await writeFile(join(root,name,'ignored.glb'),bytes);}
 await mkdir(join(base,'outside'));await writeFile(join(base,'outside','external.glb'),bytes);await symlink(join(base,'outside'),join(root,'external-directory'),process.platform==='win32'?'junction':'dir');await symlink(join(root,'characters'),join(root,'loop'),process.platform==='win32'?'junction':'dir');
 await Promise.all([startCatalogScan(work,{force:true}),startCatalogScan(work,{force:true})]);const result=await waitForCatalogScan(work);
 assert.equal(result.scan.state,'complete');assert.equal(result.entries.length,5);
 const heroes=result.entries.filter(e=>e.name==='hero.GLB');assert.equal(heroes.length,2);assert.notEqual(heroes[0].id,heroes[1].id);assert.equal(heroes[0].metadata.clips.length,2);
 assert.equal(result.entries.find(e=>e.name==='bad.glb').status,'invalid');assert.equal(result.entries.find(e=>e.name==='editable.blend').status,'source-only');
 assert.equal(Object.keys((await readProject(work)).models).length,1,'discovery does not import files into active slots');
 const again=await scan(work);assert.equal(again.entries.find(e=>e.relativePath===heroes[0].relativePath).id,heroes[0].id);
}));

test('catalog search and pagination cover more than a single page without importing or truncating clips',()=>fixture(async({root,work,bytes})=>{
 for(let i=0;i<205;i++)await writeFile(join(root,'model-'+String(i).padStart(3,'0')+'.glb'),bytes);
 const result=await scan(work);assert.equal(result.entries.length,205);assert.equal(result.scan.truncated,false);
 const page=await catalogPage(work,{query:'model-',offset:100,limit:100});assert.equal(page.entries.length,100);assert.equal(page.matched,205);assert.equal(page.hasMore,true);
 const last=await catalogPage(work,{query:'model-',offset:200});assert.equal(last.entries.length,5);assert.equal(last.hasMore,false);
 const exact=await catalogPage(work,{query:'MODEL-204'});assert.equal(exact.entries[0].name,'model-204.glb');
}));

test('A can finish, accept and roll back while B is being viewed; equal source bytes do not mix their histories',()=>fixture(async({root,work,bytes})=>{
 await writeFile(join(root,'A.glb'),bytes);await writeFile(join(root,'B.glb'),bytes);
 const {entries:[a,b]}=await scan(work);await openCatalogAsset(work,a.id);const first=await enqueue(work,a.id),claim=await claimJob(work,first.id);
 await openCatalogAsset(work,b.id);const bBefore=structuredClone(modelSlots(await readProject(work),b.id));
 const edited=editGlb(bytes,{clip:'Run',bone:'LeftShoulder',factor:.7}),candidate=join(work,'a-output.glb');await writeFile(candidate,edited.bytes);
 const done=await completeJob(work,first.id,{lease:claim.lease,candidatePath:candidate,summary:'Synthetic shoulder correction'});
 let cfg=await readProject(work);assert.equal(cfg.activeAssetId,b.id);assert.deepEqual(modelSlots(cfg,b.id),bBefore);assert.equal(modelSlots(cfg,a.id).candidate.sha256,done.candidate.sha256);
 await reviewJob(work,first.id,{decision:'accept-candidate',outcome:'Synthetic QA user decision'});
 const bJob=await enqueue(work,b.id),packet=await getJobProjectContext(work,bJob.id);assert.equal(packet.continuity.ancestry.length,0);assert.equal(packet.continuity.acceptedCheckpoints.length,0);
 await reviewJob(work,first.id,{decision:'keep-baseline',outcome:'Synthetic revert while viewing B'});cfg=await readProject(work);assert.equal(cfg.activeAssetId,b.id);assert.equal(modelSlots(cfg,a.id).candidate.sha256,sha(bytes));assert.deepEqual(modelSlots(cfg,b.id),bBefore);
 await openCatalogAsset(work,a.id);assert.equal((await readProject(work)).slots.candidate.sha256,sha(bytes));
}));

test('a same-model head change still invalidates completion while a view change alone does not',()=>fixture(async({root,work,bytes})=>{
 await writeFile(join(root,'A.glb'),bytes);const {entries:[a]}=await scan(work);await openCatalogAsset(work,a.id);
 const job=await enqueue(work,a.id),claim=await claimJob(work,job.id),changed=editGlb(bytes,{clip:'Run',bone:'LeftShoulder',factor:.9}).bytes;
 await importAsset(work,'candidate',changed,'Concurrent new head',{assetId:a.id,activate:false});const path=join(work,'late.glb');await writeFile(path,editGlb(bytes,{clip:'Run',bone:'LeftShoulder',factor:.7}).bytes);
 await assert.rejects(completeJob(work,job.id,{lease:claim.lease,candidatePath:path,summary:'late result'}),/过期/);assert.equal((await getJob(work,job.id)).state,'stale');assert.equal(modelSlots(await readProject(work),a.id).candidate.sha256,sha(changed));
}));

test('source updates are explicit revisions; missing files keep owned previews; partial scans never report unseen sources as missing',()=>fixture(async({root,work,bytes})=>{
 await writeFile(join(root,'A.glb'),bytes);await writeFile(join(root,'B.glb'),bytes);let catalog=await scan(work);const a=catalog.entries.find(e=>e.name==='A.glb'),b=catalog.entries.find(e=>e.name==='B.glb');await openCatalogAsset(work,a.id);
 const changed=editGlb(bytes,{clip:'Run',bone:'LeftShoulder',factor:.8}).bytes;await writeFile(join(root,'A.glb'),changed);await scan(work);
 assert.equal((await catalogPage(work)).entries.find(e=>e.id===a.id).sourceChanged,true);
 await openCatalogAsset(work,a.id);assert.equal((await readProject(work)).slots.baseline.sha256,sha(bytes));
 await openCatalogAsset(work,a.id,{refreshSource:true});let cfg=await readProject(work);assert.equal(cfg.slots.baseline.sha256,sha(changed));assert.equal(cfg.models[a.id].revisions[0].slots.baseline.sha256,sha(bytes));
 await rm(join(root,'B.glb'));catalog=await scan(work,{limits:{maxFiles:0}});assert.equal(catalog.scan.state,'partial');assert.notEqual(catalog.entries.find(e=>e.id===b.id).status,'missing');
 catalog=await scan(work);assert.equal(catalog.entries.find(e=>e.id===b.id).status,'missing');await rm(join(root,'A.glb'));await scan(work);await openCatalogAsset(work,a.id);assert.equal((await readProject(work)).slots.baseline.sha256,sha(changed));
 await assert.rejects(openCatalogAsset(work,a.id,{refreshSource:true}),/不存在/);
}));

test('unscoped legacy jobs remain attached to their migrated pair after another model is selected',()=>fixture(async({root,work,bytes})=>{
 const old=await enqueue(work,'legacy'),file=join(work,'jobs',old.id,'job.json'),raw=await json(file);delete raw.assetId;await atomic(file,raw);
 await writeFile(join(root,'new.glb'),bytes);const {entries:[entry]}=await scan(work);await openCatalogAsset(work,entry.id);
 const claim=await claimJob(work,old.id);assert.ok(claim.lease);assert.equal((await readProject(work)).activeAssetId,entry.id);
}));

test('HTTP directory discovery, model switching and per-tab sessions keep input identity separate from active view',()=>fixture(async({root,work,bytes})=>{
 await writeFile(join(root,'A.glb'),bytes);await writeFile(join(root,'B.glb'),bytes);
 const server=await serve(work,0);try{
  const base='http://127.0.0.1:'+server.address().port;await waitForCatalogScan(work);const session=await(await fetch(base+'/api/session')).json();
  const page=await(await fetch(base+'/api/catalog')).json(),a=page.entries.find(e=>e.name==='A.glb'),b=page.entries.find(e=>e.name==='B.glb');
  const post=async(path,input={})=>{const response=await fetch(base+path,{method:'POST',headers:{'x-motion-token':session.token},body:JSON.stringify(input)});assert.equal(response.status,200,await response.clone().text());return response.json();};
  await post('/api/catalog/'+a.id+'/open');await post('/api/catalog/'+b.id+'/open');
  const aSession=await(await fetch(base+'/api/session?assetId='+a.id)).json(),bSession=await(await fetch(base+'/api/session?assetId='+b.id)).json();assert.equal(aSession.project.activeAssetId,a.id);assert.equal(bSession.project.activeAssetId,b.id);
  const job=await post('/api/jobs',{assetId:a.id,request:'QA task from tab A',slot:'baseline',context:{asset:aSession.project.slots.baseline,clip:'Run',time:.2}});assert.equal(job.assetId,a.id);assert.equal((await readProject(work)).activeAssetId,b.id);
  assert.equal((await fetch(base+'/api/catalog/scan',{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/catalog/constructor/open',{method:'POST',headers:{'x-motion-token':session.token},body:'{}'})).status,400);
 }finally{await new Promise(r=>server.close(r));}
}));

test('FBX conversion is lazy, preserves adjacent textures, caches by settings and invalidates on external image changes',()=>fixture(async({base,root,work,bytes})=>{
 const fbx=join(root,'hero.fbx'),image=join(root,'shared','skin.png'),blender=join(base,'fake-blender.cjs'),countFile=join(base,'conversions.txt'),template=join(base,'fixture.glb');
 await mkdir(join(root,'shared'));await writeFile(join(root,'unrelated.png'),'unused image');await writeFile(fbx,'SYNTHETIC FBX');await writeFile(image,'first texture');await writeFile(template,bytes);
 const script=`const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2);if(args[0]==='--version'){console.log('Synthetic Blender fixture 1');process.exit(0);}
const out=args[args.indexOf('--output')+1],input=args[args.indexOf('--input')+1],image=${JSON.stringify(image)};
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
fs.appendFileSync(${JSON.stringify(countFile)},'convert\\n');fs.copyFileSync(${JSON.stringify(template)},path.join(out,'converted.glb'));fs.writeFileSync(path.join(out,'editable.blend'),'SYNTHETIC NATIVE SOURCE');
fs.writeFileSync(path.join(out,'source-map.json'),JSON.stringify({source:{sha256:hash(input),editablePath:path.join(out,'editable.blend'),fps:30,frameRange:[0,30]},externalImages:[{path:image,sha256:hash(image)}]}));
`;
 await writeFile(blender,script);await chmod(blender,0o755);const prior=process.env.BLENDER_EXECUTABLE;process.env.BLENDER_EXECUTABLE=blender;
 try{
  const {entries:[entry]}=await scan(work);assert.equal(entry.format,'fbx');await assert.rejects(readFile(countFile),/ENOENT/);
  const openProcess=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[join(ROOT,'scripts/motion-feedback.mjs'),'open-model','--workspace',work,'--asset-id',entry.id],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(error)));});
  await Promise.all([openProcess(),openProcess()]);let cfg=await readProject(work);assert.equal(cfg.slots.baseline.source.projectRelativePath,'hero.fbx');assert.ok(cfg.slots.baseline.source.dependencies.some(d=>d.projectRelativePath==='shared/skin.png'));
  await openCatalogAsset(work,entry.id,{refreshSource:true});assert.equal((await readFile(countFile,'utf8')).trim().split('\n').length,1,'unchanged external images reuse the verified conversion');
  const independent=await enqueue(work,entry.id);await writeFile(join(root,'unrelated.png'),'unused changed');await scan(work);assert.equal((await catalogPage(work)).entries.find(e=>e.id===entry.id).sourceChanged,false);await claimJob(work,independent.id);await openCatalogAsset(work,entry.id,{refreshSource:true});assert.equal((await readFile(countFile,'utf8')).trim().split('\n').length,1);
  await cancelJob(work,independent.id);const job=await enqueue(work,entry.id);await writeFile(image,'second texture');await scan(work);assert.equal((await catalogPage(work)).entries.find(e=>e.id===entry.id).sourceChanged,true);await assert.rejects(claimJob(work,job.id),/上下文/);
  await openCatalogAsset(work,entry.id,{refreshSource:true});assert.equal((await readFile(countFile,'utf8')).trim().split('\n').length,2);
  cfg=await readProject(work);assert.equal(cfg.slots.baseline.source.dependencies.find(d=>d.projectRelativePath==='shared/skin.png').sha256,sha(Buffer.from('second texture')));
 }finally{if(prior===undefined)delete process.env.BLENDER_EXECUTABLE;else process.env.BLENDER_EXECUTABLE=prior;}
}));

test('an interrupted scan is recoverable without discarding its previous catalog',()=>fixture(async({root,work,bytes})=>{
 await writeFile(join(root,'hero.glb'),bytes);const catalog=await scan(work),id=catalog.entries[0].id;
 catalog.scan={...catalog.scan,state:'scanning',pid:2147483647};await atomic(join(work,'catalog.json'),catalog);
 assert.equal((await readCatalog(work)).scan.state,'interrupted');const next=await scan(work);assert.equal(next.scan.state,'complete');assert.equal(next.entries[0].id,id);
}));

test('cached scan status notices a remote scanner exit without another catalog write',()=>fixture(async({work})=>{
 const link=await json(join(work,'project-link.json')),child=spawn(process.execPath,['-e','process.stdout.write("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
 try{
  await once(child.stdout,'data');await atomic(join(work,'catalog.json'),{version:1,projectId:link.projectId,entries:[],scan:{state:'scanning',pid:child.pid,warnings:[]}});
  assert.equal((await catalogPage(work)).scan.state,'scanning');const closed=once(child,'close');child.kill('SIGKILL');await closed;
  assert.equal((await catalogPage(work)).scan.state,'interrupted');assert.equal((await catalogPage(work)).scan.state,'interrupted');
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}));

test('unchanged source refresh keeps candidates, head revisions and queued tasks while simultaneous restore cannot suppress refresh',()=>fixture(async({root,work,bytes})=>{
 const file=join(root,'hero.glb');await writeFile(file,bytes);const {entries:[entry]}=await scan(work);await openCatalogAsset(work,entry.id);
 const candidate=editGlb(bytes,{clip:'Run',bone:'LeftShoulder',factor:.7}).bytes;await importAsset(work,'candidate',candidate,'Owned candidate',{assetId:entry.id});const job=await enqueue(work,entry.id),before=await readProject(work);
 await writeFile(file,bytes);await scan(work);await openCatalogAsset(work,entry.id,{refreshSource:true});const after=await readProject(work);
 assert.equal(after.models[entry.id].headRevision,before.models[entry.id].headRevision);assert.equal(after.slots.candidate.sha256,sha(candidate));assert.ok((await claimJob(work,job.id)).lease);
 const changed=editGlb(bytes,{clip:'Run',bone:'LeftShoulder',factor:.8}).bytes;await writeFile(file,changed);await scan(work);
 await Promise.all([openCatalogAsset(work,entry.id),openCatalogAsset(work,entry.id,{refreshSource:true})]);assert.equal((await readProject(work)).slots.baseline.sha256,sha(changed));
}));

test('new tasks project exact consumed dependencies from old broad source records without rewriting old evidence',()=>fixture(async({root,work,bytes})=>{
 const fbx=Buffer.from('legacy source'),used=Buffer.from('used image'),unused=Buffer.from('unused image');await writeFile(join(root,'hero.fbx'),fbx);await writeFile(join(root,'used.png'),used);await writeFile(join(root,'unused.png'),unused);
 const provenance={format:'fbx',sha256:sha(fbx),projectRelativePath:'hero.fbx',dependencies:[{projectRelativePath:'used.png',sha256:sha(used)},{projectRelativePath:'unused.png',sha256:sha(unused)}],conversionReport:{externalImages:[{path:join(root,'used.png'),sha256:sha(used)}]}};
 const asset=await importAsset(work,'baseline',bytes,'Legacy',{newModel:true,source:provenance}),job=await enqueue(work,asset.assetId);
 assert.equal(job.source.dependencies.length,1);assert.equal(job.inputs.baseline.source.dependencies.length,1);
 await writeFile(join(root,'unused.png'),'irrelevant change');assert.ok((await claimJob(work,job.id)).lease);assert.equal((await readProject(work)).slots.baseline.source.dependencies.length,2);
}));

test('catalog index results are isolated from callers and invalidate on metadata changes',()=>fixture(async({root,work,bytes})=>{
 await writeFile(join(root,'A.glb'),bytes);await scan(work);const first=await catalogPage(work,{query:'A.glb'});first.entries[0].name='tampered';first.entries[0].metadata.clips.length=0;
 const again=await catalogPage(work,{query:'A.glb'});assert.equal(again.entries[0].name,'A.glb');assert.equal(again.entries[0].metadata.clips.length,2);
 await writeFile(join(root,'B.glb'),bytes);await scan(work);assert.equal((await catalogPage(work,{query:'.glb'})).matched,2);
}));
