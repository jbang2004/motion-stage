import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {buildDemo} from '../practice.mjs';
import {importBytes} from '../jobs.mjs';
import {readProject,sha} from '../core.mjs';
import {serve} from '../server.mjs';

async function fixture(fn){const work=await mkdtemp(join(tmpdir(),'motion-upload-'));try{await initializeWorkspace(work);await fn(work);}finally{await rm(work,{recursive:true,force:true});}}

test('browser GLB byte intake creates an independent model and keeps the previous model heads',()=>fixture(async work=>{
 const before=await readProject(work),bytes=await buildDemo(true),imported=await importBytes(work,'baseline',bytes,'uploaded character.glb',{newModel:true}),after=await readProject(work);
 assert.notEqual(imported.assetId,before.activeAssetId);assert.equal(imported.sha256,sha(bytes));assert.equal(after.slots.baseline.sha256,sha(bytes));assert.equal(after.models[before.activeAssetId].slots.baseline.sha256,before.slots.baseline.sha256);
}));

test('HTTP browser GLB and embedded FBX uploads pass through actual byte intake and preserve owned source identity',()=>fixture(async work=>{
 const template=join(work,'fixture.glb'),blender=join(work,'upload-blender.cjs'),bytes=await buildDemo(true);await writeFile(template,bytes);
 await writeFile(blender,`const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),args=process.argv.slice(2);if(args[0]==='--version'){console.log('Synthetic upload Blender 4.2');process.exit(0);}const input=args[args.indexOf('--input')+1],out=args[args.indexOf('--output')+1];fs.copyFileSync(${JSON.stringify(template)},path.join(out,'converted.glb'));fs.writeFileSync(path.join(out,'editable.blend'),'SYNTHETIC UPLOAD TEST');fs.writeFileSync(path.join(out,'source-map.json'),JSON.stringify({source:{sha256:crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),editablePath:path.join(out,'editable.blend'),fps:30,frameRange:[0,30]},externalImages:[]}));`);
 const prior=process.env.BLENDER_EXECUTABLE;process.env.BLENDER_EXECUTABLE=blender;let server;
 try{
  server=await serve(work,0);const base='http://127.0.0.1:'+server.address().port,session=await(await fetch(base+'/api/session')).json();
  const upload=async(name,body)=>{const response=await fetch(base+'/api/assets/baseline?newModel=true&name='+encodeURIComponent(name),{method:'POST',headers:{'x-motion-token':session.token,'Content-Type':'application/octet-stream'},body});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
  const glb=await upload('角色 & 100%.glb',bytes),fbxBytes=Buffer.from('SYNTHETIC EMBEDDED FBX'),fbx=await upload('角色 & 100%.fbx',fbxBytes);
  assert.notEqual(glb.assetId,fbx.assetId);assert.equal(fbx.source.sha256,sha(fbxBytes));assert.equal(sha(await readFile(join(work,fbx.source.file))),sha(fbxBytes));assert.equal(fbx.source.projectRelativePath,undefined);assert.deepEqual(fbx.source.dependencies,[]);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));if(prior===undefined)delete process.env.BLENDER_EXECUTABLE;else process.env.BLENDER_EXECUTABLE=prior;}
}));
