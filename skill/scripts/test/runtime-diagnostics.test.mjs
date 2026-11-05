import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseRuntime,checkWorkspace} from '../runtime-diagnostics.mjs';
import {mkdtemp,writeFile,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('startup checks only core capabilities without resolving or executing optional tools',async()=>{
 const work=await mkdtemp(join(tmpdir(),'motion-environment 中文-'));
 try{
  await writeFile(join(work,'keep.txt'),'user data');const before=await readdir(work);
  const unexpected=async()=>assert.fail('optional tool was probed during startup');
  const report=await diagnoseRuntime({workspace:work,programs:[],resolveBlender:unexpected,resolveProgram:unexpected,execProgram:unexpected});
  assert.equal(report.workspace.status,'ready');assert.equal(report.features.offlineServer,true);assert.equal(report.blender.status,'not-checked');assert.equal(report.codex.status,'not-checked');assert.equal(report.features.fbxConversion,null);
  assert.deepEqual(await readdir(work),before);assert.equal(await readFile(join(work,'keep.txt'),'utf8'),'user data');
 }finally{await rm(work,{recursive:true,force:true});}
});

test('a workspace failure is actionable and disables core readiness without optional probes',async()=>{
 const work=await mkdtemp(join(tmpdir(),'motion-environment-invalid-'));
 try{
  const path=join(work,'not-a-directory');await writeFile(path,'keep');
  const report=await diagnoseRuntime({workspace:path,programs:[]});assert.equal(report.workspace.status,'error');assert.match(report.workspace.error,/可写目录/);assert.equal(report.features.offlineServer,false);assert.equal(report.features.localEdit,false);assert.equal(await readFile(path,'utf8'),'keep');
 }finally{await rm(work,{recursive:true,force:true});}
});

test('a real read-only workspace fails and recovers after permissions are restored',{skip:process.platform==='win32'||process.getuid?.()===0},async()=>{
 const work=await mkdtemp(join(tmpdir(),'motion-environment-permission-'));
 try{await chmod(work,0o500);assert.equal((await checkWorkspace(work)).status,'error');await chmod(work,0o700);assert.equal((await checkWorkspace(work)).status,'ready');assert.deepEqual(await readdir(work),[]);}
 finally{await chmod(work,0o700);await rm(work,{recursive:true,force:true});}
});

test('diagnostics preserve offline capability when optional programs are missing',async()=>{
 const missing=async()=>{throw Object.assign(Error('missing optional dependency'),{code:'EXECUTABLE_NOT_FOUND'});};
 const report=await diagnoseRuntime({nodeVersion:'22.0.0',resolveBlender:missing,resolveProgram:missing});
 assert.equal(report.features.offlineServer,true);assert.equal(report.features.localEdit,true);assert.equal(report.features.fbxConversion,false);assert.equal(report.features.automaticAgentExecutable,false);
 assert.equal(report.blender.status,'missing');assert.equal(report.browser.webgl2,'not-checked');
});

test('diagnostics reject old Blender and never infer CLI authentication from a version response',async()=>{
 const report=await diagnoseRuntime({nodeVersion:'22.0.0',resolveBlender:async()=>'/blender',resolveProgram:async()=>'/codex',execProgram:async executable=>({stdout:executable==='/blender'?'Blender 4.1.9':'codex-cli test'})});
 assert.equal(report.blender.available,true);assert.equal(report.blender.supported,false);assert.equal(report.blender.status,'unsupported');assert.match(report.blender.error,/4.2/);
 assert.equal(report.codex.auth,'not-checked');assert.equal(report.codex.status,'ready');
});

test('diagnostics accept supported Blender, identify an invalid adapter and report unsupported Node',async()=>{
 const options={nodeVersion:'20.0.0',resolveBlender:async()=>'/blender',resolveProgram:async()=>'/codex',execProgram:async executable=>({stdout:executable==='/blender'?'Blender 4.2.0\nbuild info':'codex-cli test'})};
 const report=await diagnoseRuntime(options);assert.equal(report.node.supported,false);assert.equal(report.blender.version,'4.2.0');assert.equal(report.blender.supported,true);assert.equal(report.features.offlineServer,false);assert.equal(report.features.fbxConversion,false);
 const invalid=await diagnoseRuntime({...options,execProgram:async()=>({stdout:'Some unrelated executable 99'})});assert.equal(invalid.blender.supported,false);assert.match(invalid.blender.error,/无法识别/);
});
