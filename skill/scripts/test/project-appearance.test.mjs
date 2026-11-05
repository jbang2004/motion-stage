import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {linkProject} from '../project-context.mjs';
import {importAsset,readProject,sha} from '../core.mjs';
import {installAppearance,appearanceStatus,appearanceFile} from '../project-appearance.mjs';
import {createJob} from '../jobs.mjs';
import {serve} from '../server.mjs';
const bytes=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
async function fixture(fn){const base=await realpath(await mkdtemp(join(tmpdir(),'motion-look-'))),root=join(base,'Project'),work=join(base,'review'),bundle=join(base,'外观包');await mkdir(root);await mkdir(bundle);await initializeWorkspace(work);await linkProject(work,root);await writeFile(join(root,'hero.glb'),bytes);await writeFile(join(root,'look.js'),'// reviewed project shader');await importAsset(work,'baseline',bytes,'Hero',{source:{projectRelativePath:'hero.glb',sha256:sha(bytes)}});await writeFile(join(bundle,'adapter.mjs'),'throw Error("Registration must not execute this module");');const config={version:1,label:'Project look',threeRevision:'186',entry:'adapter.mjs',files:['adapter.mjs'],profiles:{'hero.glb':{look:'toon'}},evidence:[{file:'look.js'}],limitations:['Inspection stage']};const file=join(bundle,'manifest.json');await writeFile(file,JSON.stringify(config));try{await fn({root,work,bundle,file,config,save:()=>writeFile(file,JSON.stringify(config))});}finally{await rm(base,{recursive:true,force:true});}}

test('appearance registration is explicit, copies immutable reviewed files and preserves model heads',()=>fixture(async({work,file,bundle})=>{
 const before=await readProject(work);assert.equal((await appearanceStatus(work)).status,'unavailable');const installed=await installAppearance(work,file),status=await appearanceStatus(work);assert.equal(status.status,'ready');assert.equal(status.bundle,installed.bundle);assert.equal(status.threeRevision,'186');assert.equal(status.profile.look,'toon');assert.deepEqual(await readProject(work),before);await writeFile(join(bundle,'adapter.mjs'),'new authoring');assert.match((await appearanceFile(work,status.bundle,'adapter.mjs')).toString(),/Registration must not execute/);
}));

test('tampered owned modules, missing files and changed project evidence remain optional unavailable states',()=>fixture(async({work,file,root})=>{
 const installed=await installAppearance(work,file),path=join(work,'appearance',installed.bundle,'adapter.mjs');await writeFile(path,'tampered');assert.match((await appearanceStatus(work)).message,/外观文件已变化/);await assert.rejects(appearanceFile(work,installed.bundle,'adapter.mjs'),/校验失败/);await installAppearance(work,file);await writeFile(join(root,'look.js'),'updated shader');assert.match((await appearanceStatus(work)).message,/依据已变化/);await rm(path);assert.equal((await appearanceStatus(work)).status,'unavailable');assert.ok((await readProject(work)).slots.baseline);
}));

test('unsupported characters and corrupt configuration never disable basic model APIs',()=>fixture(async({work,file})=>{
 await installAppearance(work,file);await importAsset(work,'baseline',bytes,'Other',{newModel:true});assert.equal((await appearanceStatus(work)).status,'unavailable');await writeFile(join(work,'appearance.json'),'{bad');assert.equal((await appearanceStatus(work)).status,'unavailable');assert.ok((await readProject(work)).slots.baseline);
}));

test('relative paths support Unicode/Windows separators while traversal, symlink escapes and undeclared files fail',()=>fixture(async({work,file,bundle,config,save,root})=>{
 await mkdir(join(bundle,'模块'));await writeFile(join(bundle,'模块','外观.mjs'),'export const version=1');config.entry='模块\\外观.mjs';config.files=['模块\\外观.mjs'];await save();const installed=await installAppearance(work,file);assert.equal((await appearanceFile(work,installed.bundle,'模块/外观.mjs')).toString(),'export const version=1');await assert.rejects(appearanceFile(work,installed.bundle,'manifest.json'),/未登记/);await assert.rejects(appearanceFile(work,installed.bundle,'../project.json'),/相对路径/);
 for(const entry of ['../outside.mjs','C:\\secret.mjs','/tmp/x.mjs']){config.entry=entry;config.files=[entry];await save();await assert.rejects(installAppearance(work,file),/相对路径/);}
 await writeFile(join(root,'outside.mjs'),'not allowed');await symlink(join(root,'outside.mjs'),join(bundle,'escape.mjs'));config.entry='escape.mjs';config.files=['escape.mjs'];await save();await assert.rejects(installAppearance(work,file),/outside/);
}));

test('old registered snapshots remain available after installing a new reviewed bundle',()=>fixture(async({work,file,bundle})=>{
 const old=await installAppearance(work,file);await writeFile(join(bundle,'adapter.mjs'),'export const version=1');const next=await installAppearance(work,file);assert.notEqual(old.bundle,next.bundle);assert.match((await appearanceFile(work,old.bundle,'adapter.mjs')).toString(),/must not execute/);assert.equal((await appearanceStatus(work)).bundle,next.bundle);
}));

test('HTTP serves only registered verified modules; feedback freezes appearance identity without modifying assets',()=>fixture(async({work,file})=>{
 await installAppearance(work,file);const server=await serve(work,0);try{const base='http://127.0.0.1:'+server.address().port,status=await(await fetch(base+'/api/appearance')).json();assert.equal(status.status,'ready');const response=await fetch(base+status.module);assert.match(response.headers.get('content-type'),/javascript/);assert.equal(response.status,200);assert.equal((await fetch(base+'/appearance/'+status.bundle+'/unknown.js')).status,400);
 const cfg=await readProject(work),job=await createJob(work,{request:'Synthetic appearance observation',slot:'baseline',context:{asset:cfg.slots.baseline,clip:'Run',time:.2,appearance:{mode:'project',bundle:status.bundle,evidence:status.evidence}}});assert.equal(job.context.appearance.bundle,status.bundle);assert.equal((await readProject(work)).slots.baseline.sha256,cfg.slots.baseline.sha256);
 }finally{await new Promise(r=>server.close(r));}
}));
