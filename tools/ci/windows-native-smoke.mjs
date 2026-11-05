// Native OS checks that cannot be established by path.win32 or process mocks.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve,parse} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const argv=process.argv.slice(2),option=name=>argv[argv.indexOf('--'+name)+1];
assert.equal(process.platform,'win32','Run only on a real Windows host.');
assert.ok(process.env.GITHUB_ACTIONS==='true'||process.env.CI==='true','Only authorized CI fixtures are supported.');
assert.ok(argv.includes('--package')&&argv.includes('--output'));
const skill=resolve(option('package')),output=resolve(option('output'));
await mkdir(output,{recursive:true});
const runtime=await import(pathToFileURL(join(skill,'scripts/platform-runtime.mjs')).href);
const {inside}=await import(pathToFileURL(join(skill,'scripts/core.mjs')).href);
const root=await mkdtemp(join(tmpdir(),'Motion Windows native & 100% !^ 中文 '));
const result={platform:process.platform,node:process.version,verdict:'FAIL',checks:[]};
let owned,descendantPID,closed;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 const npm=join(root,'npm & 100% !^ 中文'),entry=join(npm,'node_modules/@openai/codex/bin/codex.js'),shim=join(npm,'codex.cmd');
 await mkdir(join(npm,'node_modules/@openai/codex/bin'),{recursive:true});
 await writeFile(join(npm,'node_modules/@openai/codex/package.json'),JSON.stringify({type:'commonjs',private:true}));
 await writeFile(entry,"process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
 await writeFile(shim,'@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path'));
 env.Path=npm;env.PATHEXT='.EXE;.CMD';
 const resolved=await runtime.resolveExecutable('codex',{env});assert.equal(resolved.toLowerCase(),shim.toLowerCase());
 const args=['','literal & (x) %PATH% ! ^','中文 空格','quote "inside"','line one\nline two'];
 const response=await runtime.execExecutable(resolved,args,{kind:'codex',timeout:10000});assert.deepEqual(JSON.parse(response.stdout),args);
 result.checks.push({name:'real PATHEXT lookup and npm CMD adapter argv roundtrip',status:'PASS',usesActualCodex:false});
 const unsupported=join(root,'unknown.cmd');await writeFile(unsupported,'@echo must-never-run\r\n');
 await assert.rejects(runtime.execExecutable(unsupported,[],{kind:'codex'}),/无法识别/);
 result.checks.push({name:'unknown real batch wrapper is rejected without execution',status:'PASS'});
 const workspace=join(root,'workspace'),external=join(root,'outside');await mkdir(workspace);await mkdir(external);
 await writeFile(join(external,'sentinel.txt'),'Owned synthetic CI fixture');
 const {symlink}=await import('node:fs/promises');await symlink(external,join(workspace,'junction'),'junction');
 await assert.rejects(inside(workspace,'junction/sentinel.txt'),/Symlink outside workspace/);
 await assert.rejects(inside(workspace,'junction/not-yet-created.txt'),/Symlink outside workspace/);
 await assert.rejects(inside(skill,join(external,'sentinel.txt')),/outside workspace/i);
 result.checks.push({name:'native junction and external absolute path containment',status:'PASS',packageDrive:parse(skill).root,fixtureDrive:parse(await realpath(root)).root});
 const pidFile=join(root,'descendant.pid'),heartbeat=join(root,'heartbeat.txt');
 const childCode=`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),30);`;
 const parentCode=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore',shell:false});setInterval(()=>{},1000);`;
 owned=runtime.spawnOwnedProcess(process.execPath,['-e',parentCode],{stdio:['ignore','ignore','pipe']});
 const errors=[];owned.child.stderr.on('data',bytes=>errors.push(bytes));
 closed=new Promise((resolve,reject)=>{owned.child.once('error',reject);owned.child.once('close',resolve);});
 for(let i=0;i<200;i++){
  try{descendantPID=Number(await readFile(pidFile,'utf8'));if(descendantPID>0&&(await readFile(heartbeat,'utf8')).trim())break;}catch{}
  await pause(25);
 }
 assert.ok(Number.isInteger(descendantPID)&&descendantPID>0,Buffer.concat(errors).toString());
 assert.ok((await readFile(heartbeat,'utf8')).trim(),'Owned descendant must really execute before cancellation.');
 await owned.stop();await closed;
 const stopped=await readFile(heartbeat,'utf8');await pause(500);assert.equal(await readFile(heartbeat,'utf8'),stopped,'Descendant kept executing after taskkill returned.');
 assert.throws(()=>process.kill(descendantPID,0),{code:'ESRCH'});
 result.checks.push({name:'real taskkill terminates the owned active parent and descendant',status:'PASS',heartbeatStable:true,descendantGone:true});
 result.verdict='PASS';
}catch(error){result.error=error.stack||String(error);process.exitCode=1;}
finally{
 if(owned)await owned.stop();
 // The owned parent's taskkill operation controls cleanup. Never send a
 // delayed signal to a descendant PID after its process may already be gone.
 await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(error=>{result.cleanupError=error.message;result.verdict='FAIL';process.exitCode=1;});
 await writeFile(join(output,'windows-native.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result,null,2));
