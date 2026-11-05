import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {atomic,commitWorkspace,readWorkspaceJSON,withWorkspaceLock} from '../workspace-store.mjs';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {readProject,sha} from '../core.mjs';
import {createJob,claimJob,completeJob,getJob,reviewJob} from '../jobs.mjs';
import {buildDemo} from '../practice.mjs';

async function fixture(fn){const work=await mkdtemp(join(tmpdir(),'motion-store-'));try{await fn(work);}finally{await rm(work,{recursive:true,force:true});}}
const hash=x=>createHash('sha256').update(x).digest('hex');
async function running(work){await initializeWorkspace(work);const cfg=await readProject(work),job=await createJob(work,{request:'Store fault recovery QA',context:{asset:cfg.slots.baseline,clip:'Run',time:.2}});return {cfg,job,claim:await claimJob(work,job.id)};}
// Use real temporary files while injecting Windows sharing errors at the native
// fs boundary. A child keeps the platform/fault overrides out of other tests.
async function windowsIOFixture(work,source){
 const script=join(work,'windows-io.mjs'),moduleUrl=pathToFileURL(join(import.meta.dirname,'..','workspace-store.mjs')).href;
 await writeFile(script,`import fs from 'node:fs';import assert from 'node:assert/strict';import {syncBuiltinESMExports} from 'node:module';import {channel} from 'node:diagnostics_channel';import {join,basename} from 'node:path';import {randomUUID} from 'node:crypto';const work=await fs.promises.realpath(process.argv[2]),native={...fs.promises},events=[];Object.defineProperty(process,'platform',{value:'win32'});channel('motion-workspace.io-retry').subscribe(event=>events.push(event));const store=await import(${JSON.stringify(moduleUrl)});${source}`);
 const exit=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,work],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>resolve({code,error}));});
 assert.equal(exit.code,0,exit.error);
}

test('Windows transient sharing violations retry atomic replacement without deleting the old target',()=>fixture(work=>windowsIOFixture(work,`
 const target=join(work,'target.json');await native.writeFile(target,'old');let attempts=0;
 fs.promises.rename=async(source,destination)=>{if(destination===target){attempts++;assert.equal(await native.readFile(target,'utf8'),'old');assert.equal(await native.readFile(source,'utf8'),'new');if(attempts<=3)throw Object.assign(Error('sharing violation'),{code:['EPERM','EACCES','EBUSY'][attempts-1],syscall:'rename',path:source,dest:destination});}return native.rename(source,destination);};
 fs.promises.rm=async(path,options)=>{assert.notEqual(path,target,'replacement must never unlink the target');return native.rm(path,options);};syncBuiltinESMExports();
 await store.atomic(target,'new');assert.equal(attempts,4);assert.equal(await native.readFile(target,'utf8'),'new');assert.equal(events.filter(e=>e.status==='retrying'&&e.operation==='replace').length,3);assert.ok(events.some(e=>e.status==='recovered'&&e.attempts===4));
`)));

test('Windows permanent atomic replacement errors are bounded and preserve old bytes and native error identity',()=>fixture(work=>windowsIOFixture(work,`
 const target=join(work,'target.json');await native.writeFile(target,'old');let attempts=0;const started=Date.now();
 fs.promises.rename=async(source,destination)=>{if(destination===target){attempts++;assert.equal(await native.readFile(target,'utf8'),'old');throw Object.assign(Error('permanent access denied'),{code:'EPERM',syscall:'rename',path:source,dest:destination});}return native.rename(source,destination);};
 fs.promises.rm=async(path,options)=>{assert.notEqual(path,target);return native.rm(path,options);};syncBuiltinESMExports();
 await assert.rejects(store.atomic(target,'new'),error=>error.code==='EPERM'&&error.syscall==='rename'&&error.dest===target&&error.workspaceIO.attempts===12&&error.workspaceIO.maxAttempts===12);
 assert.equal(attempts,12);assert.ok(Date.now()-started<5000);assert.equal(await native.readFile(target,'utf8'),'old');assert.ok(events.some(e=>e.status==='failed'&&e.operation==='replace'&&e.attempts===12));assert.equal((await native.readdir(work)).some(name=>name.endsWith('.tmp')),false);
`)));

test('Windows journal application retries sharing violations and retains redo evidence on permanent replacement failure',()=>fixture(work=>windowsIOFixture(work,`
 const first=join(work,'first.json'),second=join(work,'second.json');await native.writeFile(first,'{"old":1}');await native.writeFile(second,'{"old":1}');let attempts=0;
 fs.promises.rename=async(source,destination)=>{if(destination===first&&source.includes('.txn-')&&++attempts<=2)throw Object.assign(Error('shared journal target'),{code:'EPERM',syscall:'rename',path:source,dest:destination});return native.rename(source,destination);};syncBuiltinESMExports();
 await store.commitWorkspace(work,{'first.json':{new:1},'second.json':{new:1}});assert.equal(attempts,3);assert.deepEqual(JSON.parse(await native.readFile(first,'utf8')),{new:1});
 attempts=0;fs.promises.rename=async(source,destination)=>{if(destination===first&&source.includes('.txn-')){attempts++;throw Object.assign(Error('permanently denied journal target'),{code:'EACCES',syscall:'rename',path:source,dest:destination});}return native.rename(source,destination);};syncBuiltinESMExports();
 await assert.rejects(store.commitWorkspace(work,{'first.json':{new:2},'second.json':{new:2}}),error=>error.code==='EACCES'&&error.workspaceIO.attempts===12);assert.equal(attempts,12);assert.deepEqual(JSON.parse(await native.readFile(first,'utf8')),{new:1});assert.deepEqual(JSON.parse(await native.readFile(second,'utf8')),{new:1});
 const journal=JSON.parse(await native.readFile(join(work,'.motion-transaction.json'),'utf8'));assert.equal(journal.writes.length,2);for(const write of journal.writes)assert.equal(await native.readFile(join(work,write.temp),'utf8'),write.data);
 fs.promises.rename=native.rename;syncBuiltinESMExports();assert.deepEqual(await store.readWorkspaceJSON(work,'first.json'),{new:2});assert.deepEqual(await store.readWorkspaceJSON(work,'second.json'),{new:2});assert.equal((await native.readdir(work)).some(name=>name==='.motion-transaction.json'||name.endsWith('.tmp')),false);
`)));

test('Windows shared ticket reads and dead-ticket/lock cleanup recover without losing ownership',()=>fixture(work=>windowsIOFixture(work,`
 const nonce=randomUUID(),deadTicket=join(work,'.motion-write.ticket-'+nonce+'.json'),lock=join(work,'.motion-write.lock');await native.writeFile(deadTicket,JSON.stringify({nonce,pid:2147483647,choosing:false,number:1}));await native.mkdir(lock);await native.writeFile(join(lock,'owner.json'),JSON.stringify({pid:2147483647,nonce:'dead'}));let readFailures=0,entered=0;const removals=new Map();
 fs.promises.readFile=async(path,...options)=>{if(/^\\.motion-write\\.ticket-/.test(basename(String(path)))&&readFailures++<2)throw Object.assign(Error('shared ticket read'),{code:'EACCES',syscall:'open',path});return native.readFile(path,...options);};
 fs.promises.rm=async(path,options)=>{if(path===deadTicket||path===lock){const count=(removals.get(path)||0)+1;removals.set(path,count);if(count<=2)throw Object.assign(Error('shared cleanup path'),{code:'EPERM',syscall:'unlink',path});}return native.rm(path,options);};syncBuiltinESMExports();
 await store.withWorkspaceLock(work,async()=>{entered++;assert.ok(JSON.parse(await native.readFile(join(lock,'owner.json'),'utf8')).pid===process.pid);});assert.equal(entered,1);assert.equal((await native.readdir(work)).some(name=>name.startsWith('.motion-write')),false);assert.ok(events.some(e=>e.status==='recovered'&&e.operation==='read'));assert.ok(events.some(e=>e.status==='recovered'&&e.operation==='remove'&&e.path===deadTicket));assert.ok(events.some(e=>e.status==='recovered'&&e.operation==='remove'&&e.path===lock));
`)));

test('Windows permanent ticket read failures keep the native cause distinct from invalid JSON',()=>fixture(work=>windowsIOFixture(work,`
 let attempts=0;fs.promises.readFile=async(path,...options)=>{if(/^\\.motion-write\\.ticket-/.test(basename(String(path)))){attempts++;throw Object.assign(Error('native sharing denial'),{code:'EACCES',syscall:'open',path,originalFailure:true});}return native.readFile(path,...options);};syncBuiltinESMExports();
 await assert.rejects(store.withWorkspaceLock(work,()=>assert.fail('must not enter')),error=>error.code==='EACCES'&&error.originalFailure===true&&error.syscall==='open'&&error.workspaceIO.attempts===12&&!error.message.includes('票据损坏'));assert.equal(attempts,12);
 fs.promises.readFile=native.readFile;syncBuiltinESMExports();await native.writeFile(join(work,'.motion-write.ticket-'+randomUUID()+'.json'),'{bad json');await assert.rejects(store.withWorkspaceLock(work,()=>assert.fail('must not enter')),error=>error.message.includes('票据损坏')&&error.cause instanceof SyntaxError);
`)));

test('a failed Windows owner read during release resumes once before concurrent same-process acquisitions',()=>fixture(work=>windowsIOFixture(work,`
 const lock=join(work,'.motion-write.lock'),owner=join(lock,'owner.json'),counter=join(work,'count.json'),critical=join(work,'critical');await native.writeFile(counter,'0');let block=false,releaseReads=0;
 fs.promises.readFile=async(path,...options)=>{if(path===owner&&block){releaseReads++;throw Object.assign(Error('release owner is shared'),{code:'EACCES',syscall:'open',path});}return native.readFile(path,...options);};syncBuiltinESMExports();
 await assert.rejects(store.withWorkspaceLock(work,()=>{block=true;}),error=>error.code==='EACCES');assert.equal(releaseReads,12);assert.ok((await native.readdir(work)).some(name=>name.startsWith('.motion-write.ticket-')));block=false;
 await Promise.all(Array.from({length:8},()=>store.withWorkspaceLock(work,async()=>{const handle=await native.open(critical,'wx');try{const value=JSON.parse(await native.readFile(counter,'utf8'));await new Promise(r=>setTimeout(r,5));await store.atomic(counter,value+1);}finally{await handle.close();await native.rm(critical);}})));
 assert.equal(JSON.parse(await native.readFile(counter,'utf8')),8);assert.equal((await native.readdir(work)).some(name=>name.startsWith('.motion-write')),false);
`)));

test('pending Windows release never deletes a compatibility lock whose owner nonce has changed',()=>fixture(work=>windowsIOFixture(work,`
 const lock=join(work,'.motion-write.lock'),owner=join(lock,'owner.json');let block=false;
 fs.promises.readFile=async(path,...options)=>{if(path===owner&&block)throw Object.assign(Error('release owner denied'),{code:'EACCES',path});return native.readFile(path,...options);};syncBuiltinESMExports();await assert.rejects(store.withWorkspaceLock(work,()=>{block=true;}),{code:'EACCES'});block=false;
 const peer={pid:process.pid,nonce:randomUUID(),at:Date.now()};await native.writeFile(owner,JSON.stringify(peer));await assert.rejects(store.withWorkspaceLock(work,()=>assert.fail('peer owns this lock'),{timeoutMs:50}),/正在写入/);assert.deepEqual(JSON.parse(await native.readFile(owner,'utf8')),peer);
 await native.rm(lock,{recursive:true,force:true});await store.withWorkspaceLock(work,()=>{});assert.equal((await native.readdir(work)).some(name=>name.startsWith('.motion-write')),false);
`)));

test('permanent Windows ticket cleanup failures recover in the same process after IO becomes available',()=>fixture(work=>windowsIOFixture(work,`
 let block=false,attempts=0;fs.promises.rm=async(path,options)=>{if(block&&/^\\.motion-write\\.ticket-/.test(basename(String(path)))){attempts++;throw Object.assign(Error('ticket removal denied'),{code:'EPERM',syscall:'unlink',path});}return native.rm(path,options);};syncBuiltinESMExports();await assert.rejects(store.withWorkspaceLock(work,()=>{block=true;}),error=>error.code==='EPERM'&&error.workspaceIO.attempts===12);assert.equal(attempts,12);assert.equal((await native.readdir(work)).includes('.motion-write.lock'),false);block=false;
 let completed=0;await Promise.all(Array.from({length:8},()=>store.withWorkspaceLock(work,()=>{completed++;})));assert.equal(completed,8);assert.equal((await native.readdir(work)).some(name=>name.startsWith('.motion-write')),false);
`)));

test('partially removed Windows lock directories resume safely while their unique ticket remains held',()=>fixture(work=>windowsIOFixture(work,`
 const lock=join(work,'.motion-write.lock');let block=false;fs.promises.rm=async(path,options)=>{if(path===lock&&block){await native.rm(join(lock,'owner.json'),{force:true});throw Object.assign(Error('directory remained shared after owner removal'),{code:'EPERM',path});}return native.rm(path,options);};syncBuiltinESMExports();await assert.rejects(store.withWorkspaceLock(work,()=>{block=true;}),{code:'EPERM'});assert.equal((await native.readdir(lock)).length,0);block=false;await store.withWorkspaceLock(work,()=>{});assert.equal((await native.readdir(work)).some(name=>name.startsWith('.motion-write')),false);
`)));

test('slow filesystem polling in one process uses one ticket and drains sustained concurrent requests',()=>fixture(work=>windowsIOFixture(work,`
 let reads=0,maximumTickets=0,completed=0;fs.promises.readFile=async(path,...options)=>{if(/^\\.motion-write\\.ticket-/.test(basename(String(path)))){reads++;maximumTickets=Math.max(maximumTickets,(await native.readdir(work)).filter(name=>name.startsWith('.motion-write.ticket-')).length);await new Promise(r=>setTimeout(r,15));}return native.readFile(path,...options);};syncBuiltinESMExports();
 for(let wave=0;wave<3;wave++)await Promise.all(Array.from({length:8},()=>store.withWorkspaceLock(work,()=>{completed++;},{timeoutMs:5000})));
 assert.equal(completed,24);assert.equal(maximumTickets,1);assert.ok(reads<=24*4,'local contenders must not repeatedly scan one another');assert.equal((await native.readdir(work)).some(name=>name.startsWith('.motion-write')),false);
`)));

test('expired local waiters never publish tickets or run callbacks and cannot block the next live waiter',()=>fixture(work=>windowsIOFixture(work,`
 let started,release,expiredCalls=0,liveCalls=0;const ready=new Promise(resolve=>started=resolve),held=new Promise(resolve=>release=resolve);
 const owner=store.withWorkspaceLock(work,async()=>{started();await held;});await ready;
 const expired=assert.rejects(store.withWorkspaceLock(work,()=>{expiredCalls++;},{timeoutMs:30}),error=>error.code==='WORKSPACE_BUSY'&&error.workspaceLock.phase==='local-queue');
 const live=store.withWorkspaceLock(work,()=>{liveCalls++;},{timeoutMs:2000});await expired;assert.equal(expiredCalls,0);assert.equal((await native.readdir(work)).filter(name=>name.startsWith('.motion-write.ticket-')).length,1);release();await Promise.all([owner,live]);assert.equal(liveCalls,1);assert.equal((await native.readdir(work)).some(name=>name.startsWith('.motion-write')),false);
 await assert.rejects(store.withWorkspaceLock(work,()=>{throw Error('request failed');}),/request failed/);await store.withWorkspaceLock(work,()=>{liveCalls++;});assert.equal(liveCalls,2);
`)));

test('a locally queued workspace turn retains its caller ownership of another workspace',()=>fixture(work=>windowsIOFixture(work,`
 const first=join(work,'first'),second=join(work,'second');await native.mkdir(first);await native.mkdir(second);let ready,release;const started=new Promise(resolve=>ready=resolve),held=new Promise(resolve=>release=resolve);const blocker=store.withWorkspaceLock(second,async()=>{ready();await held;});await started;
 let reentered=false;await store.withWorkspaceLock(first,async()=>{const queued=store.withWorkspaceLock(second,async()=>{await store.withWorkspaceLock(first,()=>{reentered=true;},{timeoutMs:100});});await new Promise(r=>setTimeout(r,30));release();await queued;});await blocker;assert.equal(reentered,true);assert.equal((await native.readdir(first)).length,0);assert.equal((await native.readdir(second)).length,0);
`)));

test('concurrent HTTP studio, catalog and project preview requests survive slow ticket IO without changing model heads',()=>fixture(work=>windowsIOFixture(work,`
 const scripts=${JSON.stringify(pathToFileURL(join(import.meta.dirname,'..')+'/').href)};
 const [{initializeWorkspace},{linkProject},{serve},{waitForCatalogScan}]=await Promise.all([import(new URL('project-workspaces.mjs',scripts)),import(new URL('project-context.mjs',scripts)),import(new URL('server.mjs',scripts)),import(new URL('asset-catalog.mjs',scripts))]);
 const root=join(work,'project');await native.mkdir(root);await native.writeFile(join(root,'controller.js'),'export const walkSpeed=1;');await initializeWorkspace(work);await linkProject(work,root);process.env.BLENDER_EXECUTABLE=join(work,'missing-blender');process.env.CODEX_EXECUTABLE=join(work,'missing-codex');const server=await serve(work,0,{settingsPath:join(work,'recent.json')});
 try{await waitForCatalogScan(work);const base='http://127.0.0.1:'+server.address().port,session=await(await fetch(base+'/api/session')).json(),before=JSON.parse(await native.readFile(join(work,'project.json'),'utf8'));let maximumTickets=0;
 fs.promises.readFile=async(path,...options)=>{if(/^\\.motion-write\\.ticket-/.test(basename(String(path)))){maximumTickets=Math.max(maximumTickets,(await native.readdir(work)).filter(name=>name.startsWith('.motion-write.ticket-')).length);await new Promise(r=>setTimeout(r,15));}return native.readFile(path,...options);};syncBuiltinESMExports();
 for(let wave=0;wave<2;wave++)await Promise.all(Array.from({length:8},async(_,i)=>{const route=i%3===0?'/api/studio':i%3===1?'/api/catalog':'/api/project/preview',response=await fetch(base+route,route.endsWith('preview')?{method:'POST',headers:{'x-motion-token':session.token},body:JSON.stringify({assetId:session.project.activeAssetId,request:'inspect current walk',slot:'baseline'})}:{}),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));}));
 assert.equal(maximumTickets,1);assert.deepEqual(JSON.parse(await native.readFile(join(work,'project.json'),'utf8')),before);assert.equal((await native.readdir(work)).some(name=>name.startsWith('.motion-write')),false);
 }finally{await new Promise(resolve=>server.close(resolve));}
`)));

test('staging I/O failure leaves every public metadata file unchanged and removes temporary files',()=>fixture(async work=>{
 await atomic(join(work,'a.json'),{before:true});await atomic(join(work,'b.json'),{before:true});
 await assert.rejects(commitWorkspace(work,{'a.json':{after:true},'b.json':{after:true}},{checkpoint:({phase,file})=>{if(phase==='before-stage'&&file==='b.json')throw Object.assign(Error('injected disk full'),{code:'ENOSPC'});}}),{code:'ENOSPC'});
 assert.deepEqual(await readWorkspaceJSON(work,'a.json'),{before:true});assert.deepEqual(await readWorkspaceJSON(work,'b.json'),{before:true});assert.deepEqual((await readdir(work)).sort(),['a.json','b.json']);
}));

test('a partially applied commit is recovered before the next metadata read and repeated reads are idempotent',()=>fixture(async work=>{
 await atomic(join(work,'a.json'),{old:1});await atomic(join(work,'b.json'),{old:1});
 await assert.rejects(commitWorkspace(work,{'a.json':{new:2},'b.json':{new:2}},{checkpoint:({phase,index})=>{if(phase==='applied'&&index===0)throw Error('injected interruption');}}),/interruption/);
 assert.deepEqual(JSON.parse(await readFile(join(work,'a.json'),'utf8')),{new:2});assert.deepEqual(JSON.parse(await readFile(join(work,'b.json'),'utf8')),{old:1});
 assert.deepEqual(await readWorkspaceJSON(work,'b.json'),{new:2});assert.deepEqual(await readWorkspaceJSON(work,'a.json'),{new:2});assert.equal((await readdir(work)).some(n=>n.includes('transaction')||n.endsWith('.tmp')),false);
}));

test('an abruptly exited process leaves a recoverable journal and the next process reclaims its dead lock',()=>fixture(async work=>{
 await atomic(join(work,'a.json'),{old:1});await atomic(join(work,'b.json'),{old:1});const script=join(work,'crash.mjs'),moduleUrl=pathToFileURL(join(import.meta.dirname,'..','workspace-store.mjs')).href;
 await writeFile(script,`import {commitWorkspace} from ${JSON.stringify(moduleUrl)};await commitWorkspace(process.argv[2],{'a.json':{new:3},'b.json':{new:3}},{checkpoint:({phase,index})=>{if(phase==='applied'&&index===0)process.exit(73);}});`);
 const exit=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,work],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>resolve({code,error}));});assert.equal(exit.code,73,exit.error);
 assert.deepEqual(await readWorkspaceJSON(work,'a.json'),{new:3});assert.deepEqual(await readWorkspaceJSON(work,'b.json'),{new:3});assert.equal((await readdir(work)).includes('.motion-write.lock'),false);
}));

test('recovery can regenerate a missing staged file from its verified journal data',()=>fixture(async work=>{
 await assert.rejects(commitWorkspace(work,{'a.json':{new:4},'b.json':{new:4}},{checkpoint:({phase})=>{if(phase==='prepared')throw Error('crash');}}),/crash/);
 const journal=JSON.parse(await readFile(join(work,'.motion-transaction.json'),'utf8'));await rm(join(work,journal.writes[0].temp));
 assert.deepEqual(await readWorkspaceJSON(work,'a.json'),{new:4});assert.deepEqual(await readWorkspaceJSON(work,'b.json'),{new:4});
}));

test('corrupt or escaping journals block recovery before writing any target',()=>fixture(async work=>{
 const id=randomUUID(),data='{}',outside='../must-not-write.json';
 await atomic(join(work,'.motion-transaction.json'),{version:1,id,writes:[{file:outside,temp:outside+'.txn-'+id+'.tmp',data,sha256:hash(data)}]});
 await assert.rejects(readWorkspaceJSON(work,'a.json'),/校验|超出/);await rm(join(work,'.motion-transaction.json'));
 await atomic(join(work,'.motion-transaction.json'),{version:1,id,writes:[{file:'a.json',temp:'a.json.txn-'+id+'.tmp',data,sha256:'0'.repeat(64)}]});await assert.rejects(readWorkspaceJSON(work,'a.json'),/校验/);await assert.rejects(readFile(join(work,'a.json')),{code:'ENOENT'});
}));

test('async descendants cannot retain a released lock ownership token',()=>fixture(async work=>{
 let deferred,first;
 await withWorkspaceLock(work,async()=>{first=JSON.parse(await readFile(join(work,'.motion-write.lock','owner.json'),'utf8')).nonce;deferred=new Promise((resolve,reject)=>setTimeout(()=>withWorkspaceLock(work,async()=>JSON.parse(await readFile(join(work,'.motion-write.lock','owner.json'),'utf8')).nonce).then(resolve,reject),10));});
 assert.notEqual(await deferred,first);
}));

test('many processes reclaim one dead owner without overlapping critical sections',()=>fixture(async work=>{
 const script=join(work,'contender.mjs'),moduleUrl=pathToFileURL(join(import.meta.dirname,'..','workspace-store.mjs')).href;
 await writeFile(script,`import {withWorkspaceLock,atomic} from ${JSON.stringify(moduleUrl)};import {readFile,open,rm} from 'node:fs/promises';import {join} from 'node:path';const work=process.argv[2];for(let i=0;i<3;i++)await withWorkspaceLock(work,async()=>{const marker=join(work,'critical'),handle=await open(marker,'wx');try{const count=JSON.parse(await readFile(join(work,'count.json'),'utf8'));await new Promise(r=>setTimeout(r,2));await atomic(join(work,'count.json'),count+1);}finally{await handle.close();await rm(marker);}});`);
 for(let round=0;round<3;round++){
  await atomic(join(work,'count.json'),0);await atomic(join(work,'.motion-write.lock','owner.json'),{pid:2147483647,nonce:'dead-owner'});
  const exits=await Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,work],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>resolve({code,error}));})));
  for(const exit of exits)assert.equal(exit.code,0,exit.error);assert.equal(await readWorkspaceJSON(work,'count.json'),24);
 }
}));

test('initialization is recovered after a process exits on the first published project head',()=>fixture(async work=>{
 const script=join(work,'init-crash.mjs'),moduleUrl=pathToFileURL(join(import.meta.dirname,'..','project-workspaces.mjs')).href;
 await writeFile(script,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {realpath} from 'node:fs/promises';import {join} from 'node:path';const work=await realpath(process.argv[2]),original=fs.promises.rename;fs.promises.rename=async(...args)=>{const result=await original(...args);if(args[1]===join(work,'project.json'))process.exit(74);return result;};syncBuiltinESMExports();const {initializeWorkspace}=await import(${JSON.stringify(moduleUrl)});await initializeWorkspace(work);`);
 const exit=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,work],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>resolve({code,error}));});assert.equal(exit.code,74,exit.error);
 await initializeWorkspace(work);const cfg=await readProject(work);assert.ok(cfg.slots.baseline);assert.ok(cfg.slots.candidate);assert.deepEqual(await readWorkspaceJSON(work,'feedback.json'),{version:1,notes:[]});
}));

test('a recognized legacy half-initialization resumes without overwriting real history',()=>fixture(async work=>{
 await atomic(join(work,'project.json'),{version:2,title:'Legacy empty initialization',slots:{}});const recovered=await initializeWorkspace(work);assert.equal(recovered.recovered,true);assert.ok((await readProject(work)).slots.baseline);
 await rm(join(work,'feedback.json'));await assert.rejects(initializeWorkspace(work),/缺少反馈记录/);assert.ok((await readProject(work)).slots.baseline);
}));

test('completion retries with the same lease return the committed result without advancing the model again',()=>fixture(async work=>{
 const {job,claim}=await running(work),candidatePath=join(work,'candidate.glb');await writeFile(candidatePath,await buildDemo(true));
 const first=await completeJob(work,job.id,{lease:claim.lease,candidatePath,summary:'Synthetic change'}),before=await readProject(work);
 const again=await completeJob(work,job.id,{lease:claim.lease,candidatePath,summary:'Retry after lost response'}),after=await readProject(work);
 assert.equal(again.candidate.sha256,first.candidate.sha256);assert.equal(after.models[job.assetId].headRevision,before.models[job.assetId].headRevision);assert.equal('completionReceipt' in again,false);
 await assert.rejects(completeJob(work,job.id,{lease:'wrong',candidatePath,summary:'wrong receipt'}),/租约/);
 const decisionId=randomUUID();await reviewJob(work,job.id,{decision:'accept-candidate',outcome:'QA acceptance',decisionId});const repeated=await reviewJob(work,job.id,{decision:'accept-candidate',outcome:'QA acceptance',decisionId});assert.equal(repeated.reviews.length,1);
}));

test('real directory permission failure cannot leave a new preview with an unfinished job',{skip:process.platform==='win32'||process.getuid?.()===0?'Requires POSIX non-root permission enforcement; portable failure/crash tests still run':false},()=>fixture(async work=>{
 const {cfg,job,claim}=await running(work),candidatePath=join(work,'candidate.glb'),dir=join(work,'jobs',job.id);await writeFile(candidatePath,await buildDemo(true));await chmod(dir,0o555);
 try{await assert.rejects(completeJob(work,job.id,{lease:claim.lease,candidatePath,summary:'Cannot write job'}),{code:'EACCES'});}finally{await chmod(dir,0o755);}
 assert.equal((await readProject(work)).slots.candidate.sha256,cfg.slots.candidate.sha256);assert.equal((await getJob(work,job.id)).state,'running');
 const done=await completeJob(work,job.id,{lease:claim.lease,candidatePath,summary:'Retried after permissions restored'});assert.equal(done.state,'complete');assert.notEqual(done.candidate.sha256,cfg.slots.candidate.sha256);
}));
