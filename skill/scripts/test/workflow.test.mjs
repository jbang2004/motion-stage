import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,cp,symlink,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,json,sha,glbInfo,validateFeedback,inside} from '../core.mjs';
import {buildDemo,measureDemo} from '../practice.mjs';
import {serve} from '../server.mjs';
const cli=resolve(ROOT,'scripts/motion-feedback.mjs');
const run=(args,cwd)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',cwd,env:{...process.env,NODE_PATH:''}});

test('original GLB, scoped practice edit and unchanged limbs',async()=>{
 const a=await buildDemo(false),b=await buildDemo(true);assert.equal(sha(a),sha(await buildDemo(false)));assert.notEqual(sha(a),sha(b));
 assert.deepEqual(glbInfo(a).clips.map(x=>[x.name,x.duration]),[['Run',1],['Salute',1.5]]);
 const m=await measureDemo();assert.equal(m.otherLimbCurvesUnchanged,true);assert.ok(m.leftWristMinDistanceFromMidlineAfter>m.leftWristMinDistanceFromMidlineBefore+.3);
 assert.throws(()=>glbInfo(Buffer.from('bad')));
});

test('independent workspace: feedback, snapshot, decision, replacement and migration',async()=>{
 const base=await mkdtemp(resolve(tmpdir(),'motion-review-test-')),work=resolve(base,'中文 space'),moved=resolve(base,'迁移');let server;
 try{
  const init=run(['init','--workspace',work],base);assert.equal(init.status,0,init.stderr);
  server=await serve(work,0);const url='http://127.0.0.1:'+server.address().port,s=await(await fetch(url+'/api/session')).json();
  const request=async(path,data,method='POST',headers={})=>fetch(url+path,{method,headers:{'x-motion-token':s.token,...headers},body:data instanceof Buffer?data:JSON.stringify(data)});
  assert.equal((await fetch(url+'/')).status,200);assert.equal((await fetch(url+'/vendor/three/build/three.module.js')).status,200);
  const icons=await fetch(url+'/viewer/icons.svg');assert.equal(icons.headers.get('content-type'),'image/svg+xml');assert.match(await icons.text(),/<symbol id="play"/);
  assert.equal((await request('/api/notes',{},'POST',{'x-motion-token':'wrong'})).status,403);
  assert.equal((await request('/api/notes',{},'POST',{'Origin':'https://example.invalid'})).status,403);
  const n={id:'real-note-1',slot:'baseline',asset:s.project.slots.baseline,clip:'Run',time:.25,frame:8,fps:30,view:'front',status:'open',observed:'左手挤入腰部',expected:'左手离开躯干',acceptance:'完整周期和侧面检查',preserve:'其他肢体和周期'};
  assert.equal((await request('/api/notes',{...n,time:3})).status,400);assert.equal((await request('/api/notes',n)).status,200);
  const mark={displayMode:'comparison',asset:s.project.slots.candidate,clip:'Run',reference:{...s.project.slots.baseline,clip:'Run'},verdict:'fix',choice:'',note:'自动检查：手部与腰部轮廓重合',context:{time:.25,mode:'elapsed',rootLocked:true,slots:Object.fromEntries(['baseline','candidate'].map(slot=>[slot,{...s.project.slots[slot],clip:'Run',time:.25}]))}};
  assert.equal((await request('/api/marks',mark)).status,200);
  assert.equal((await request('/api/marks',{...mark,verdict:'want',choice:'original'})).status,200);
  const exported=await(await fetch(url+'/api/export')).json();assert.equal(exported.marks.length,1);assert.equal(exported.marks[0].history.length,2);assert.equal(exported.marks[0].choice,'original');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=','base64');
  assert.equal((await request('/api/snapshots/'+n.id,png)).status,200);
  const practice=run(['practice','--workspace',work],base);assert.equal(practice.status,0,practice.stderr);
  assert.equal((await request('/api/notes/'+n.id,{decision:'accept-candidate',outcome:'原速和慢放检查左手，保留其余动作；这是自动测试决定，不是作者审美认可。'},'PATCH')).status,200);
  const d=await validateFeedback(work);assert.equal(d.notes.length,1);assert.equal(d.notes[0].status,'resolved');assert.equal(d.notes[0].asset.sha256,n.asset.sha256);assert.notEqual(d.notes[0].reviewedAssets.candidate.sha256,n.asset.sha256);
  const before=await json(resolve(work,'project.json'));
  assert.equal((await request('/api/assets/candidate',Buffer.from('not a GLB'))).status,400);assert.deepEqual(await json(resolve(work,'project.json')),before);
  const old=await readFile(resolve(work,'assets',n.asset.sha256+'.glb'));assert.equal(sha(old),n.asset.sha256);
  await cp(work,moved,{recursive:true});await validateFeedback(moved);
  assert.equal(run(['init','--workspace',work],base).status,1);assert.equal((await json(resolve(work,'feedback.json'))).notes.length,1);
 }finally{if(server)await new Promise(r=>server.close(r));await rm(base,{recursive:true,force:true});}
});

test('workspace confinement includes symlinks',async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),'motion-path-test-'));try{await assert.rejects(inside(dir,'../outside'));
  const other=await mkdtemp(resolve(tmpdir(),'motion-outside-'));try{await writeFile(resolve(other,'secret'),'not served');await symlink(other,resolve(dir,'jump'),'junction');await assert.rejects(inside(dir,'jump/secret'));}finally{await rm(other,{recursive:true,force:true});}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('installer carries all runnable resources to a fresh path without npm',async()=>{
 const tmp=await mkdtemp(resolve(tmpdir(),'motion-install-test-')),target=resolve(tmp,'独立 install'),work=resolve(tmp,'work');try{
  const r=run(['install','--target',target],tmp);assert.equal(r.status,0,r.stderr);assert.equal(run(['install','--target',target],tmp).status,1);
  const result=spawnSync(process.execPath,[resolve(target,'scripts/motion-feedback.mjs'),'init','--workspace',work],{cwd:tmp,encoding:'utf8',env:{...process.env,NODE_PATH:''}});assert.equal(result.status,0,result.stderr);
  assert.ok((await readFile(resolve(target,'assets/vendor/three/build/three.core.js'))).length>100000);await validateFeedback(work);
 }finally{await rm(tmp,{recursive:true,force:true});}
});
