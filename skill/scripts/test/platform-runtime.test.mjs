import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,win32,posix} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {pathWithin,resolveExecutable,commandSpec,execExecutable,blenderExecutable,stopProcessTree,spawnOwnedProcess} from '../platform-runtime.mjs';
import {probeCodex} from '../agent-worker.mjs';

const filesAt=files=>async file=>{if(!files.map(x=>x.toLowerCase()).includes(file.toLowerCase()))throw Object.assign(Error('not found'),{code:'ENOENT'});return {isFile:()=>true};};

test('path containment rejects Windows drives, UNC shares, traversal and prefix siblings on every host',()=>{
 for(const [root,target,expected] of [
  ['C:\\Project\\review','D:\\private\\model.glb',false],
  ['C:\\Project\\review','C:\\Project\\review-other\\model.glb',false],
  ['C:\\Project\\review','C:\\Project\\review\\..\\private.glb',false],
  ['C:\\Project\\review','c:\\project\\REVIEW\\models\\hero.glb',true],
  ['\\\\server\\share\\review','\\\\server\\other\\secret.glb',false],
  ['\\\\server\\share\\review','\\\\other\\share\\secret.glb',false],
  ['\\\\server\\share\\review','\\\\server\\share\\review\\hero.glb',true],
 ])assert.equal(pathWithin(root,target,win32),expected,root+' → '+target);
 assert.equal(pathWithin('/work/review','/work/review2/model.glb',posix),false);
 assert.equal(pathWithin('/work/review','/work/review/models/hero.glb',posix),true);
});

test('Windows executable lookup respects case-insensitive Path and PATHEXT, and rejects missing explicit programs',async()=>{
 const actual='C:\\Tools & Apps\\codex.exe',fileStat=filesAt([actual]),fileAccess=async()=>{};
 const resolved=await resolveExecutable('codex',{platform:'win32',env:{Path:'C:\\Empty;"C:\\Tools & Apps"',PATHEXT:'.EXE;.CMD'},fileStat,fileAccess});
 assert.equal(resolved.toLowerCase(),actual.toLowerCase());
 await assert.rejects(resolveExecutable('codex',{explicit:'C:\\Missing\\codex.exe',platform:'win32',env:{PATH:'C:\\Tools & Apps'},fileStat,fileAccess}),{code:'EXECUTABLE_NOT_FOUND'});
});

test('Windows standard Blender installations are discovered by version without requiring PATH',async()=>{
 const wanted='C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
 const resolved=await blenderExecutable({platform:'win32',env:{ProgramFiles:'C:\\Program Files'},readDirectory:async()=>['Blender 4.2','Blender 5.2'].map(name=>({name,isDirectory:()=>true})),resolveProgram:(name,options)=>resolveExecutable(name,{...options,fileStat:filesAt([wanted]),fileAccess:async()=>{}})});
 assert.equal(resolved,wanted);
});

test('npm Codex CMD shim resolves to Node without shell expansion of arguments or install paths',async()=>{
 const wrapper='C:\\Users\\A & B%USER%\\npm\\codex.cmd',entry='C:\\Users\\A & B%USER%\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',args=['exec','-C','C:\\Assets\\hero & (side)%PATH%!^.glb','--message','literal "quote"'];
 const launch=await commandSpec(wrapper,args,{platform:'win32',kind:'codex',nodePath:'C:\\Node\\node.exe',fileStat:filesAt([entry]),fileRead:async()=> '@ECHO off\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n'});
 assert.deepEqual(launch,{command:'C:\\Node\\node.exe',args:[entry,...args]});
 assert.equal(Object.hasOwn(launch,'shell'),false);
});

test('pnpm CMD shim uses its verified Codex JS entry; unknown batch wrappers never enter a shell',async()=>{
 const wrapper='C:\\pnpm\\codex.cmd',entry='C:\\pnpm\\global\\5\\.pnpm\\codex@1\\node_modules\\@openai\\codex\\bin\\codex.js';
 const launch=await commandSpec(wrapper,['--version'],{platform:'win32',kind:'codex',nodePath:'C:\\Node\\node.exe',fileStat:filesAt([entry]),fileRead:async()=> '"%~dp0\\global\\5\\.pnpm\\codex@1\\node_modules\\@openai\\codex\\bin\\codex.js" %*'});
 assert.deepEqual(launch.args,[entry,'--version']);
 await assert.rejects(commandSpec(wrapper,[],{platform:'win32',kind:'codex',fileStat:filesAt([]),fileRead:async()=> '@echo off\nother-command %*'}),/无法识别/);
 await assert.rejects(commandSpec('C:\\tools\\blender.cmd',[],{platform:'win32'}),/不直接执行批处理/);
 const args=['100%PATH%!&literal'];assert.deepEqual(await commandSpec('C:\\Tools\\codex.exe',args,{platform:'win32'}),{command:'C:\\Tools\\codex.exe',args});
});

test('explicit Node adapters work without POSIX shebangs and preserve metacharacters as literal arguments',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motion runtime & percent%-'));try{
  const script=join(dir,'adapter.cjs'),args=['a & b','%PATH%!','x^y','"quoted"','中文 空格'];await writeFile(script,"process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const result=await execExecutable(script,args,{timeout:5000});assert.deepEqual(JSON.parse(result.stdout),args);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Windows cancellation targets the whole owned process tree without a shell',async()=>{
 const calls=[],child={pid:12345,kill:()=>{throw Error('unnecessary fallback');}};
 await stopProcessTree(child,{platform:'win32',env:{SystemRoot:'C:\\Windows'},execCommand:async(...args)=>calls.push(args)});
 assert.deepEqual(calls,[[String.raw`C:\Windows\System32\taskkill.exe`,['/PID','12345','/T','/F'],{shell:false,windowsHide:true,timeout:5000}]]);
 let fallback=0;await stopProcessTree({pid:12345,kill:()=>fallback++},{platform:'win32',execCommand:async()=>{throw Error('unavailable');}});assert.equal(fallback,1);
 await stopProcessTree({pid:undefined,kill:()=>fallback++},{platform:'win32'});assert.equal(fallback,1);
});

test('owned command keeps byte streams and the real CLI status across guardian cleanup',async()=>{
 const owned=spawnOwnedProcess(process.execPath,['-e',"process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write('fixture stderr');});process.stdin.on('end',()=>process.exitCode=7);"],{stdio:['pipe','pipe','pipe'],graceMs:50});
 const stdout=[],stderr=[],events=[];owned.child.stdout.on('data',b=>stdout.push(b));owned.child.stderr.on('data',b=>stderr.push(b));owned.child.on('commandExit',result=>events.push(result));
 const closed=new Promise((resolve,reject)=>{owned.child.once('error',reject);owned.child.once('close',resolve);});
 const input=Buffer.from([0,1,2,10,38,37,33,94,255]);owned.child.stdin.end(input);await closed;
 assert.deepEqual(Buffer.concat(stdout),input);assert.equal(Buffer.concat(stderr).toString(),'fixture stderr');
 assert.equal(owned.result.code,7);assert.equal(events.length,1);await owned.stop();
});

test('guardian distinguishes CLI launch failures from a command exit status',{skip:process.platform==='win32'&&'POSIX guardian protocol'},async()=>{
 const owned=spawnOwnedProcess(join(tmpdir(),'nonexistent-motion-executable-'+process.pid),[],{stdio:['pipe','pipe','pipe'],graceMs:50});
 await new Promise((resolve,reject)=>{owned.child.once('error',reject);owned.child.once('close',resolve);});
 assert.equal(owned.result.code,null);assert.match(owned.result.error,/ENOENT/);
});

test('guardian cleans resistant descendants after worker disconnect and the CLI exits on SIGTERM',{skip:process.platform==='win32'&&'POSIX guardian protocol'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motion guardian disconnected-')),pidFile=join(dir,'child.pid'),heartbeat=join(dir,'heartbeat');let pid;
 try{
  const descendant=`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),30);`;
  const fixture=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const parent=`import {spawnOwnedProcess} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname,'..','platform-runtime.mjs')).href)};import {readFile} from 'node:fs/promises';spawnOwnedProcess(process.execPath,['-e',${JSON.stringify(fixture)}],{stdio:['ignore','ignore','ignore'],graceMs:150});for(let i=0;i<100;i++){try{await readFile(${JSON.stringify(heartbeat)});process.exit(0);}catch{}await new Promise(r=>setTimeout(r,30));}process.exit(2);`;
  await execExecutable(process.execPath,['--input-type=module','-e',parent],{timeout:6000});pid=Number(await readFile(pidFile,'utf8'));
  await new Promise(resolve=>setTimeout(resolve,350));const stopped=await readFile(heartbeat,'utf8');await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(await readFile(heartbeat,'utf8'),stopped,'orphaned owned CLI kept writing after guardian grace');
  let alive=true;try{process.kill(pid,0);}catch{alive=false;}
  if(alive&&process.platform==='linux')try{alive=!/\) Z /.test(await readFile(`/proc/${pid}/stat`,'utf8'));}catch{alive=false;}
  assert.equal(alive,false);
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await rm(dir,{recursive:true,force:true});}
});

test('Codex probing accepts an explicit executable adapter and returns missing dependency errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motion codex probe-')),previous=process.env.CODEX_EXECUTABLE;
 try{
  const script=join(dir,'codex.cjs');await writeFile(script,"console.log('codex test fixture 1');\n");process.env.CODEX_EXECUTABLE=script;
  const available=await probeCodex();assert.equal(available.available,true);assert.equal(available.executable,script);assert.match(available.version,/test fixture/);
  process.env.CODEX_EXECUTABLE=join(dir,'missing.cjs');const missing=await probeCodex();assert.equal(missing.available,false);assert.match(missing.error,/不可用/);
 }finally{if(previous===undefined)delete process.env.CODEX_EXECUTABLE;else process.env.CODEX_EXECUTABLE=previous;await rm(dir,{recursive:true,force:true});}
});

const python=[process.env.PYTHON_EXECUTABLE,process.platform==='win32'?'python':'python3','python3'].filter(Boolean).find(command=>spawnSync(command,['-c','import sys; sys.exit(0)'],{stdio:'ignore'}).status===0);
test('Blender capability probes cover legacy, modern, missing and cancelled operators',{skip:!python&&'Python is optional locally; CI installs Python'},()=>{
 const result=spawnSync(python,[join(import.meta.dirname,'blender-capabilities.py')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr||result.stdout);
});
