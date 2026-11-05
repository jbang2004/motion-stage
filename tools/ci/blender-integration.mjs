#!/usr/bin/env node
// Real Blender integration against an unpacked release, with synthetic inputs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,readdir,realpath,cp,rm,lstat} from 'node:fs/promises';
import {resolve,join,basename,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const args=process.argv.slice(2),option=name=>{const index=args.indexOf('--'+name);return index<0?undefined:args[index+1];};
if(args.includes('--help')||!option('skill-root')||!option('output')){
 console.log('node tools/ci/blender-integration.mjs --skill-root EXTRACTED/motion-stage --blender EXECUTABLE --series 4.2|5.2 --output EVIDENCE_DIR [--node-major 24]');
 process.exit(args.includes('--help')?0:2);
}
const skill=await realpath(resolve(option('skill-root'))),output=resolve(option('output')),binary=option('blender')||process.env.BLENDER_EXECUTABLE;
assert.ok(binary,'Pass --blender or BLENDER_EXECUTABLE');
await mkdir(output,{recursive:true});
const work=await mkdtemp(join(output,'work & 100% !^ 中文 ')),logs=join(output,'logs');await mkdir(logs,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),fileHash=async path=>hash(await readFile(path));
const moduleAt=path=>import(pathToFileURL(join(skill,'scripts',path)).href);
const report={version:1,createdAt:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,skill,blender:binary,work,
 fixture:{kind:'independent synthetic skinned cube, one bone, one-second animation, referenced and unused external PNGs'},checks:{},cases:{}};
try{
 if(option('node-major'))assert.equal(process.versions.node.split('.')[0],option('node-major'),'CI must run the requested Node version');
 const manifest=JSON.parse(await readFile(join(skill,'bundle-manifest.json'),'utf8'));
 assert.equal(manifest.name,'motion-stage');assert.ok(manifest.files.length);
 for(const row of manifest.files){const bytes=await readFile(join(skill,row.path));assert.equal(bytes.length,row.bytes,row.path+' byte count');assert.equal(hash(bytes),row.sha256,row.path+' release SHA');}
 report.release={version:manifest.version,manifestSha256:await fileHash(join(skill,'bundle-manifest.json')),verifiedFiles:manifest.files.length};report.checks.releaseManifestVerified=true;
 const [{execExecutable},{convertFbx,inspectAsset,parseGlb,withBlenderFileAccess},{initializeWorkspace},{linkProject}]=await Promise.all([moduleAt('platform-runtime.mjs'),moduleAt('asset-tools.mjs'),moduleAt('project-workspaces.mjs'),moduleAt('project-context.mjs')]);
 const env={...process.env,BLENDER_EXECUTABLE:binary,CODEX_EXECUTABLE:join(work,'deliberately-missing-codex.cjs')};
 const run=async(label,executable,argv,{timeout=180000,...options}={})=>{
  try{const result=await execExecutable(executable,argv,{env,timeout,maxBuffer:8*1024*1024,...options});await writeFile(join(logs,label+'.stdout.log'),result.stdout);await writeFile(join(logs,label+'.stderr.log'),result.stderr);return result;}
  catch(error){await writeFile(join(logs,label+'.stdout.log'),error.stdout||'');await writeFile(join(logs,label+'.stderr.log'),error.stderr||error.stack||String(error));throw error;}
 };
 const version=(await run('blender-version',binary,['--version'])).stdout.split(/\r?\n/)[0];
 const match=version.match(/^Blender (\d+)\.(\d+)\.(\d+)/);assert.ok(match,'Actual Blender executable must report its version');
 const series=match[1]+'.'+match[2];if(option('series'))assert.equal(series,option('series'));assert.ok(['4.2','5.2'].includes(series),'This regression targets Blender 4.2 and 5.2');
 report.blenderVersion=version;const expectedImporter=series==='4.2'?'import_scene.fbx':'wm.fbx_import';
 const blenderScript=(label,script,argv)=>run(label,binary,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',join(import.meta.dirname,script),'--',...argv]);
 let sourceRoot=join(work,'project inputs & 100% !^ 中文');
 while(sourceRoot.length<=280)sourceRoot=join(sourceRoot,'deep project inputs & 100% !^ 中文 '+ 'x'.repeat(24));
 // Generate independently through a short ordinary path, then relocate just
 // this synthetic fixture. Production intake must handle the real deep path;
 // it cannot borrow a still-existing short original or a renamed test folder.
 const fixtureTemp=await mkdtemp(join(tmpdir(),'motion-fixture-')),generatedSource=join(fixtureTemp,'input');
 try{await blenderScript('generate-fixture','make-fbx.py',[generatedSource]);await mkdir(dirname(sourceRoot),{recursive:true});await cp(generatedSource,sourceRoot,{recursive:true,errorOnExist:true,force:false});}
 finally{await rm(fixtureTemp,{recursive:true,force:true});}
 await assert.rejects(lstat(generatedSource),{code:'ENOENT'});assert.ok(sourceRoot.length>280);
 const fixture=JSON.parse(await readFile(join(sourceRoot,'fixture.json'),'utf8')),source=join(sourceRoot,fixture.source),surface=join(sourceRoot,'surface.png'),unused=join(sourceRoot,'unused.png');
 const sourceSHA=await fileHash(source),surfaceSHA=await fileHash(surface),unusedSHA=await fileHash(unused);assert.notEqual(surfaceSHA,unusedSHA,'Unused PNG must be a distinct negative control');
 assert.equal(fixture.durationSeconds,1);assert.equal(fixture.skinnedVertices,8);report.fixture={...report.fixture,...fixture};
 report.fixture.sourceRoot=sourceRoot;report.fixture.sourcePathLength=source.length;report.checks.shortFixtureOriginalRemoved=true;report.checks.deepOriginalInputExceedsMAXPATH=source.length>260;
 const sourcesUnchanged=async()=>{for(const [name,sha]of Object.entries(fixture.files))assert.equal(await fileHash(join(sourceRoot,name)),sha,'Source changed: '+name);};
 const validateGLB=async(file,label)=>{
  const bytes=await readFile(file),inspection=inspectAsset(bytes),{doc}=parseGlb(bytes);
  assert.ok(inspection.rigs.length,'Rig lost in '+label);assert.ok(inspection.meshes.some(mesh=>mesh.hasWeights),'Skin weights lost in '+label);
  assert.ok(inspection.clips.some(clip=>Math.abs(clip.duration-1)<1/30+1e-5),'One-second animation lost in '+label);
  assert.ok(inspection.meshes.some(mesh=>mesh.influenceSummary.scanComplete&&Math.abs(mesh.influenceSummary.minimumSum-1)<1e-4&&Math.abs(mesh.influenceSummary.maximumSum-1)<1e-4),'Normalized skin weights lost in '+label);
  assert.ok(doc.images?.length&&doc.images.every(image=>Number.isInteger(image.bufferView)||image.uri?.startsWith('data:')),'GLB must embed its texture');
  return {sha256:hash(bytes),skinCount:inspection.rigs.length,meshCount:inspection.meshes.length,clipDurations:inspection.clips.map(clip=>clip.duration),embeddedImages:doc.images.length};
 };
 const validateSource=async(sourceInfo,label,workspace)=>{
  assert.equal(sourceInfo.sha256,sourceSHA,label+' FBX hash');const mapping=sourceInfo.conversionReport;
  assert.equal(mapping.importer,expectedImporter,label+' importer capability');assert.equal(mapping.externalImages.length,1,label+' exact consumed image count');
  assert.equal(mapping.externalImages[0].sha256,surfaceSHA,label+' consumed PNG bytes');
  assert.equal(await realpath(mapping.externalImages[0].path),await realpath(surface),label+' consumed PNG path');
  if(sourceInfo.file){assert.ok(workspace,label+' source snapshot needs its workspace');assert.equal(await fileHash(join(workspace,sourceInfo.file)),sourceSHA,label+' owned source snapshot');}
  const packedReport=join(output,label+'-fresh-packed-images.json');
  await withBlenderFileAccess([sourceInfo.editablePath,join(import.meta.dirname,'check-packed-images.py'),output],async([nativeBlend,nativeScript,nativeOutput])=>{
   await run(label+'-fresh-open',binary,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',nativeScript,'--',nativeBlend,join(nativeOutput,basename(packedReport))]);
  });
  const packed=JSON.parse(await readFile(packedReport,'utf8'));
  assert.ok(packed.images.some(image=>image.sha256===surfaceSHA),label+' fresh-open native file packed PNG must match source SHA');
  for(const image of packed.images.filter(image=>image.sha256===surfaceSHA))assert.equal(await realpath(image.filepath),await realpath(surface),label+' native packed image must retain its canonical original filepath');
  assert.ok(!packed.images.some(image=>image.sha256===unusedSHA),label+' unused neighboring PNG must stay outside the native model');
  return {importer:mapping.importer,externalImages:mapping.externalImages,packedImageBytesMatchSource:true,unusedPNGNotConsumed:true};
 };
 const apiDir=join(work,'API conversion & 100% !^ 中文'),api=await convertFbx(source,apiDir,{blenderPath:binary,timeoutMs:180000});
 await writeFile(join(output,'api-source-map.json'),JSON.stringify(api.report,null,2)+'\n');
 report.cases.api={...await validateGLB(api.glbPath,'API'),...await validateSource({...api.source,conversionReport:api.report},'api')};await sourcesUnchanged();
 const cli=join(skill,'scripts','motion-feedback.mjs'),cliWork=join(work,'CLI workspace & 100% !^ 中文'),catalogWork=join(work,'catalog workspace & 100% !^ 中文');
 const callCLI=async(label,command,workspace,argv=[],json=true)=>{const result=await run(label,process.execPath,[cli,command,'--workspace',workspace,...argv]);return json?JSON.parse(result.stdout):result.stdout;};
 await callCLI('cli-init','init',cliWork,[],false);
 const imported=await callCLI('cli-add','add',cliWork,['--slot','baseline','--file',source,'--new-model']);
 report.cases.cli={...await validateGLB(join(cliWork,imported.file),'CLI add'),...await validateSource(imported.source,'cli',cliWork),ownedFBXSnapshot:true};await sourcesUnchanged();
 await initializeWorkspace(catalogWork,{title:'Cross-platform synthetic integration'});await linkProject(catalogWork,sourceRoot);
 const catalog=await callCLI('catalog-scan','scan-models',catalogWork),entry=catalog.entries.find(row=>row.relativePath===fixture.source);assert.ok(entry,'Synthetic FBX must be discoverable by a real catalog scan');
 assert.equal(catalog.scan.state,'complete');
 const opened=await callCLI('catalog-open','open-model',catalogWork,['--asset-id',entry.id]),head=opened.slots.baseline;
 assert.deepEqual(head.source.dependencies,[{projectRelativePath:'surface.png',sha256:surfaceSHA}]);
 report.cases.catalog={...await validateGLB(join(catalogWork,head.file),'Catalog open'),...await validateSource(head.source,'catalog',catalogWork),ownedFBXSnapshot:true};await sourcesUnchanged();
 const skeleton=join(sourceRoot,fixture.skeletonSource),skeletonSHA=await fileHash(skeleton),skeletonOutput=await convertFbx(skeleton,join(work,'standalone skeleton'),{blenderPath:binary,timeoutMs:180000});
 const skeletonInspection=inspectAsset(await readFile(skeletonOutput.glbPath));assert.equal(skeletonInspection.capabilities.preview,'skeleton');assert.equal(skeletonInspection.capabilities.hasMesh,false);assert.equal(skeletonInspection.capabilities.hasSkin,false);assert.equal(skeletonInspection.capabilities.hasRig,true);assert.ok(skeletonInspection.clips.some(c=>Math.abs(c.duration-1)<1/30+1e-5));assert.equal(await fileHash(skeleton),skeletonSHA);
 const motionEntry=catalog.entries.find(row=>row.relativePath===fixture.skeletonSource);assert.ok(motionEntry);const motionOpened=await callCLI('catalog-open-skeleton','open-model',catalogWork,['--asset-id',motionEntry.id]);assert.equal(motionOpened.slots.baseline.capabilities.preview,'skeleton');assert.equal(JSON.parse(await readFile(join(catalogWork,'project.json'),'utf8')).models[entry.id].slots.baseline.sha256,head.sha256,'Opening a skeleton must retain the other model head');
 report.cases.standaloneSkeleton={sourceSha256:skeletonSHA,jointCount:skeletonInspection.capabilities.jointCount,clips:skeletonInspection.clips.map(c=>({name:c.name,duration:c.duration})),hasSkin:false,originalModelPreserved:true};
 const conversionCount=async()=>(await readdir(join(catalogWork,'conversions'),{withFileTypes:true})).filter(row=>row.isDirectory()).length;
 const beforeCount=await conversionCount(),unusedBytes=await readFile(unused);
 try{
  await writeFile(unused,await readFile(surface));
  await callCLI('catalog-rescan-unused-change','scan-models',catalogWork);
  const refreshed=await callCLI('catalog-refresh-unused-change','open-model',catalogWork,['--asset-id',entry.id,'--refresh-source']);
  assert.equal(refreshed.slots.baseline.sha256,head.sha256,'Unused PNG must not change authored version');assert.equal(await conversionCount(),beforeCount,'Unused PNG must not invalidate the conversion cache');
  report.checks.unusedPNGDoesNotInvalidateCache=true;
 }finally{await writeFile(unused,unusedBytes);}
 await sourcesUnchanged();report.checks.allOriginalSourceHashesPreserved=true;report.checks.freshOpenPackedSHA=true;report.verdict='PASS';
}catch(error){report.verdict='FAIL';report.error=error.stack||String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(join(output,'blender-integration.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
