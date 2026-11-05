import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath,mkdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,parse,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {convertFbx,withBlenderFileAccess} from '../asset-tools.mjs';
import {buildDemo} from '../practice.mjs';

async function fixture(fn){const work=await realpath(await mkdtemp(join(tmpdir(),'motion-fbx & 100% !^ 中文-')));try{await fn(work);}finally{await rm(work,{recursive:true,force:true});}}
function longOutput(work){let parent=work;while(join(parent,'catalog-'+'a'.repeat(64)+'-'+ '0'.repeat(36)).length<=280)parent=join(parent,'nested-'+ 'x'.repeat(60));const out=join(parent,'catalog-'+'a'.repeat(64)+'-'+randomUUID());assert.ok(out.length>280);assert.ok(out.split(sep).every(segment=>segment.length<255));return out;}
async function processFixture(work,body){
 const source=join(work,'source.fbx'),adapter=join(work,'fixture.cjs'),script=join(work,'process-probe.mjs'),moduleUrl=pathToFileURL(join(import.meta.dirname,'..','asset-tools.mjs')).href;
 await writeFile(source,'SYNTHETIC FBX');await writeFile(adapter,'setInterval(()=>{},1000);');
 await writeFile(script,`import assert from 'node:assert/strict';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {readFile} from 'node:fs/promises';import {join} from 'node:path';const work=process.argv[2],source=join(work,'source.fbx'),adapter=join(work,'fixture.cjs'),nativeSpawn=cp.spawn;const {convertFbx}=await import(${JSON.stringify(moduleUrl)});${body}`);
 const exit=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,work],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>resolve({code,error}));});assert.equal(exit.code,0,exit.error);
}

test('FBX conversion uses absolute arguments and a short cwd for a real Node adapter with output longer than MAX_PATH',()=>fixture(async work=>{
 const source=join(work,'source & 100% !^ 角色.fbx'),template=join(work,'template.glb'),adapter=join(work,'adapter.cjs'),out=longOutput(work);assert.ok(out.length>280);
 await writeFile(source,'SYNTHETIC FBX');await writeFile(template,await buildDemo(false));
 await writeFile(adapter,`const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),args=process.argv.slice(2),input=args[args.indexOf('--input')+1],out=args[args.indexOf('--output')+1],owned=args[args.indexOf('--owned-output')+1],script=args[args.indexOf('--python')+1];for(const p of [input,out,script,owned])assert.ok(path.isAbsolute(p));assert.equal(process.cwd(),path.parse(process.execPath).root);assert.ok(owned.length>280);assert.ok(process.platform==='win32'?out.length<240:out.length>280);fs.copyFileSync(${JSON.stringify(template)},path.join(out,'converted.glb'));fs.writeFileSync(path.join(out,'editable.blend'),'SYNTHETIC SOURCE');fs.writeFileSync(path.join(out,'source-map.json'),JSON.stringify({source:{path:input,sha256:crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),editablePath:path.join(out,'editable.blend')},cwd:process.cwd(),output:out}));console.log('long output adapter completed');`);
 const result=await convertFbx(relative(process.cwd(),source),relative(process.cwd(),out),{blenderPath:adapter,timeoutMs:5000});assert.equal(result.glbPath,join(out,'converted.glb'));assert.equal(result.source.path,source);assert.equal(result.report.cwd,parse(process.execPath).root);assert.equal(result.report.output,out);assert.match(await readFile(join(out,'conversion.log'),'utf8'),/long output adapter completed/);
 assert.equal(result.source.editablePath,join(out,'editable.blend'));assert.deepEqual(JSON.parse(await readFile(join(out,'source-map.json'),'utf8')),result.report);assert.equal(await readFile(result.source.editablePath,'utf8'),'SYNTHETIC SOURCE');
}));

test('short Blender directory access writes the original long output and fresh file access leaves no stored alias dependency',()=>fixture(async work=>{
 const out=longOutput(work);await mkdir(out,{recursive:true});let firstAlias,secondAlias;
 const stored=await withBlenderFileAccess([out],async([nativeOut],toOwned,mappings)=>{firstAlias=nativeOut;assert.ok(nativeOut.length<240);assert.ok(mappings.length);for(const mapping of mappings)assert.ok((await lstat(mapping.native)).isSymbolicLink());assert.equal(await realpath(nativeOut),await realpath(out));await writeFile(join(nativeOut,'editable.blend'),'PACKED OWNED SOURCE');return {editablePath:toOwned(join(nativeOut,'editable.blend'))};},{platform:'win32'});
 assert.equal(stored.editablePath,join(out,'editable.blend'));await assert.rejects(lstat(firstAlias),{code:'ENOENT'});assert.equal(await readFile(stored.editablePath,'utf8'),'PACKED OWNED SOURCE');
 await withBlenderFileAccess([stored.editablePath],async([nativeBlend],toOwned)=>{secondAlias=nativeBlend;assert.ok(nativeBlend.length<240);assert.notEqual(nativeBlend,stored.editablePath);assert.equal(toOwned(nativeBlend),stored.editablePath);assert.equal(await readFile(nativeBlend,'utf8'),'PACKED OWNED SOURCE');},{platform:'win32'});
 await assert.rejects(lstat(secondAlias),{code:'ENOENT'});assert.equal(await readFile(stored.editablePath,'utf8'),'PACKED OWNED SOURCE');
}));

test('Blender path alias cleanup after a failed callback removes only temporary links and preserves original evidence',()=>fixture(async work=>{
 const out=longOutput(work);await mkdir(out,{recursive:true});const original=join(out,'evidence.txt'),failure=Error('conversion failed');await writeFile(original,'preserve me');let alias;
 await assert.rejects(withBlenderFileAccess([out],async([nativeOut])=>{alias=nativeOut;await writeFile(join(nativeOut,'partial.blend'),'partial evidence');throw failure;},{platform:'win32'}),error=>error===failure);
 await assert.rejects(lstat(alias),{code:'ENOENT'});assert.equal(await readFile(original,'utf8'),'preserve me');assert.equal(await readFile(join(out,'partial.blend'),'utf8'),'partial evidence');
}));

test('long FBX input access preserves sibling texture topology and normalizes consumed paths to original files',()=>fixture(async work=>{
 const root=longOutput(work),source=join(root,'characters','hero.fbx'),image=join(root,'textures','surface.png'),out=longOutput(work),template=join(work,'template.glb'),adapter=join(work,'deep-input.cjs');await mkdir(join(root,'characters'),{recursive:true});await mkdir(join(root,'textures'));await writeFile(source,'SYNTHETIC LONG INPUT');await writeFile(image,'ORIGINAL SIBLING TEXTURE');await writeFile(template,await buildDemo(false));assert.ok(source.length>280);
 await writeFile(adapter,`const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),args=process.argv.slice(2),input=args[args.indexOf('--input')+1],ownedInput=args[args.indexOf('--owned-input')+1],out=args[args.indexOf('--output')+1],texture=path.join(path.dirname(input),'..','textures','surface.png'),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');assert.ok(ownedInput.length>280);assert.ok(process.platform==='win32'?input.length<240:input.length>280);assert.equal(fs.readFileSync(texture,'utf8'),'ORIGINAL SIBLING TEXTURE');fs.copyFileSync(${JSON.stringify(template)},path.join(out,'converted.glb'));fs.writeFileSync(path.join(out,'editable.blend'),'PACKED DEEP INPUT');fs.writeFileSync(path.join(out,'source-map.json'),JSON.stringify({source:{path:input,sha256:hash(input),editablePath:path.join(out,'editable.blend')},externalImages:[{path:texture,sha256:hash(texture)}]}));`);
 const result=await convertFbx(source,out,{blenderPath:adapter,timeoutMs:5000});assert.equal(result.source.path,source);assert.equal(result.source.editablePath,join(out,'editable.blend'));assert.equal(result.report.externalImages[0].path,await realpath(image));assert.equal(await readFile(image,'utf8'),'ORIGINAL SIBLING TEXTURE');assert.equal(await readFile(source,'utf8'),'SYNTHETIC LONG INPUT');assert.deepEqual(JSON.parse(await readFile(join(out,'source-map.json'),'utf8')),result.report);
}));

test('Blender synchronous and native asynchronous launch failures retain their causes and write logs',()=>fixture(work=>processFixture(work,`
 for(const mode of ['throw','native']){
  const out=join(work,'launch-'+mode),injected=Object.assign(Error('injected launch denial'),{code:'EACCES'});let calls=0;
  cp.spawn=(command,args,options)=>{calls++;if(mode==='throw')throw injected;return nativeSpawn(join(work,'missing-executable'),args,options);};syncBuiltinESMExports();
  await assert.rejects(convertFbx(source,out,{blenderPath:adapter,timeoutMs:5000}),error=>error.message.includes('启动失败')&&(mode==='throw'?error.cause===injected:error.cause?.code==='ENOENT'));assert.equal(calls,1);assert.match(await readFile(join(out,'conversion.log'),'utf8'),/launch/);
 }
`)));

test('Blender stdout and stderr errors reject safely, terminate the real adapter and preserve the original stream cause',()=>fixture(work=>processFixture(work,`
 for(const stream of ['stdout','stderr']){
  const out=join(work,'pipe-'+stream),injected=Object.assign(Error('injected disconnected '+stream),{code:'ENOTCONN'});let child,calls=0;
  cp.spawn=(...args)=>{calls++;child=nativeSpawn(...args);child.once('spawn',()=>child[stream].emit('error',injected));return child;};syncBuiltinESMExports();
  await assert.rejects(convertFbx(source,out,{blenderPath:adapter,timeoutMs:5000}),error=>error.message.includes(stream)&&error.code==='ENOTCONN'&&error.cause===injected);assert.equal(calls,1);assert.ok(child.exitCode!==null||child.signalCode!==null);assert.match(await readFile(join(out,'conversion.log'),'utf8'),new RegExp(stream));
 }
`)));

test('a failed spawn can emit errors on both pipes before child.error without an unhandled error or a lost launch cause',()=>fixture(work=>processFixture(work,`
 const launchError=Object.assign(Error('actual CreateProcess failure'),{code:'ENAMETOOLONG'}),out=join(work,'early-pipes');let calls=0;
 cp.spawn=()=>{calls++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();process.nextTick(()=>{child.stdout.emit('error',Object.assign(Error('early stdout'),{code:'ENOTCONN'}));child.stderr.emit('error',Object.assign(Error('early stderr'),{code:'ENOTCONN'}));child.emit('error',launchError);child.emit('close',null,null);});return child;};syncBuiltinESMExports();
 await assert.rejects(convertFbx(source,out,{blenderPath:adapter,timeoutMs:5000}),error=>error.cause===launchError&&error.code==='ENAMETOOLONG');assert.equal(calls,1);assert.match(await readFile(join(out,'conversion.log'),'utf8'),/actual CreateProcess failure/);
`)));

test('stream failures settle after bounded escalation even when the child never emits close',()=>fixture(work=>processFixture(work,`
 const out=join(work,'no-close'),signals=[],child=new EventEmitter();child.pid=2147483647;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=signal=>{signals.push(signal);return true;};cp.spawn=()=>{process.nextTick(()=>child.stdout.emit('error',Object.assign(Error('broken pipe without close'),{code:'ENOTCONN'})));return child;};syncBuiltinESMExports();
 const started=Date.now();await assert.rejects(convertFbx(source,out,{blenderPath:adapter,timeoutMs:60000}),error=>error.code==='ENOTCONN');assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.ok(Date.now()-started<10000);assert.ok(child.stdout.destroyed&&child.stderr.destroyed);assert.match(await readFile(join(out,'conversion.log'),'utf8'),/broken pipe without close/);
`)));

test('a timed-out Blender process remains failed even when its termination handler exits successfully',()=>fixture(work=>processFixture(work,`
 const out=join(work,'timeout-zero'),child=new EventEmitter();child.pid=2147483647;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{process.nextTick(()=>child.emit('close',0,null));return true;};cp.spawn=()=>child;syncBuiltinESMExports();await assert.rejects(convertFbx(source,out,{blenderPath:adapter,timeoutMs:20}),/超时/);assert.match(await readFile(join(out,'conversion.log'),'utf8'),/timeout/);
`)));
