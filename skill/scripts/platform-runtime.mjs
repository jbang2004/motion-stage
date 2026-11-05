import * as hostPath from 'node:path';
import {access,stat,readdir,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';

const getEnv=(env,name)=>env[name]??env[Object.keys(env).find(k=>k.toLowerCase()===name.toLowerCase())];
const pathsFor=platform=>platform==='win32'?hostPath.win32:hostPath.posix;

/** relative() returns an absolute path for different Windows drives/shares. */
export function pathWithin(root,target,pathApi=hostPath){
 const rel=pathApi.relative(pathApi.resolve(root),pathApi.resolve(target));
 return rel===''||!pathApi.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+pathApi.sep);
}

/** Resolve only a file, never shell syntax or a command plus arguments. Dependencies
 * are injectable so drive/UNC/PATHEXT behavior is exercised on every CI host. */
export async function resolveExecutable(name,{explicit,env=process.env,platform=process.platform,candidates=[],fileStat=stat,fileAccess=access,pathApi=pathsFor(platform)}={}){
 const windows=platform==='win32',extensions=windows?(getEnv(env,'PATHEXT')||'.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean):[''];
 const variants=file=>pathApi.extname(file)||!windows?[file]:[file,...extensions.map(ext=>file+ext.toLowerCase()),...extensions.map(ext=>file+ext.toUpperCase())];
 const direct=file=>pathApi.isAbsolute(file)||file.includes('/')||file.includes('\\');
 const fromPath=value=>direct(value)?variants(pathApi.resolve(value)):(getEnv(env,'PATH')||'').split(windows?';':':').filter(Boolean).flatMap(dir=>variants(pathApi.resolve(dir.replace(/^"|"$/g,''),value)));
 const requested=explicit?[String(explicit)]:null;
 const choices=requested?fromPath(requested[0]):[...fromPath(name),...candidates.flatMap(fromPath)];
 for(const file of [...new Set(choices)]){
  try{if(!(await fileStat(file)).isFile())continue;await fileAccess(file,windows||/\.(?:[cm]?js)$/i.test(file)?constants.R_OK:constants.X_OK);return file;}catch{}
 }
 const error=Error(explicit?`指定的可执行文件不可用：${explicit}`:`未找到 ${name}。请安装后加入 PATH，或设置 ${name==='codex'?'CODEX_EXECUTABLE':'BLENDER_EXECUTABLE'}。`);
 error.code='EXECUTABLE_NOT_FOUND';throw error;
}

/** Never interpolate user paths/arguments into cmd.exe. Standard npm/pnpm Codex
 * shims are adapters to a JS entrypoint, so invoke that entrypoint with Node.
 * An unrecognized batch wrapper is explicitly unsupported rather than shelled. */
export async function commandSpec(executable,args=[],{kind,platform=process.platform,nodePath=process.execPath,fileStat=stat,fileRead=readFile,pathApi=pathsFor(platform)}={}){
 const extension=pathApi.extname(executable).toLowerCase();
 if(['.js','.mjs','.cjs'].includes(extension))return {command:nodePath,args:[executable,...args]};
 if(platform!=='win32'||!['.cmd','.bat'].includes(extension))return {command:executable,args:[...args]};
 if(kind!=='codex')throw Error('不直接执行批处理包装器。请指定实际 .exe 或 Node .js/.cjs/.mjs 入口。');
 const dir=pathApi.dirname(executable),known=[pathApi.resolve(dir,'node_modules','@openai','codex','bin','codex.js'),pathApi.resolve(dir,'..','@openai','codex','bin','codex.js')];
 try{
  const wrapper=await fileRead(executable,'utf8');
  for(const match of wrapper.matchAll(/"((?:%dp0%|%~dp0)[^"\r\n]*[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js)"/gi)){
   const tail=match[1].replace(/^(?:%dp0%|%~dp0)[\\/]?/i,'');
   if(!tail.includes('%')&&!tail.includes('!'))known.push(pathApi.resolve(dir,tail));
  }
 }catch{}
 for(const file of [...new Set(known)])try{if((await fileStat(file)).isFile())return {command:nodePath,args:[file,...args]};}catch{}
 throw Error('无法识别 Codex 的 CMD 包装器。请将 CODEX_EXECUTABLE 设置为实际 codex.exe 或 @openai/codex/bin/codex.js。');
}

export async function spawnExecutable(executable,args=[],options={}){
 const {kind,...spawnOptions}=options,launch=await commandSpec(executable,args,{kind});
 return spawn(launch.command,launch.args,{...spawnOptions,shell:false});
}
export async function execExecutable(executable,args=[],options={}){
 const {kind,...execOptions}=options,launch=await commandSpec(executable,args,{kind});
 return promisify(execFile)(launch.command,launch.args,{...execOptions,shell:false});
}

// The guardian remains the process-group leader until the final group signal.
// A delayed kill from the worker would be unsafe after the CLI exits: its PGID
// could already belong to a newly started, unrelated process. Only this living
// owner ever signals the group, including when its worker disconnects.
const processGuardian=String.raw`
const {spawn}=require('node:child_process');
const {command,args,graceMs}=JSON.parse(process.argv[1]);
let stopping=false,resultSent=false,commandResult;
const report=()=>{if(resultSent||!commandResult)return;resultSent=true;if(!process.connected)return;try{process.send({type:'motion-owned-command-exit',...commandResult},()=>{});}catch{}};
const stop=()=>{
 if(stopping)return;stopping=true;
 setTimeout(()=>{report();process.kill(-process.pid,'SIGKILL');},graceMs);
 try{process.kill(-process.pid,'SIGTERM');}catch{}
};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.on('message',message=>{if(message?.type==='motion-stop-owned-process')stop();});
process.on('disconnect',stop);
const child=spawn(command,args,{stdio:['inherit','inherit','inherit'],shell:false,windowsHide:true});
child.on('error',error=>{commandResult={code:null,error:error.message};report();stop();});
child.on('exit',(code,signal)=>{
 commandResult??={code,signal};report();
 // Successful CLIs can also leave background tools behind. They belong to this
 // execution and receive the same bounded cleanup before the worker continues.
 stop();
});
`;

/** Start a task-owned tree. POSIX uses a private IPC guardian to retain its PGID
 * through cleanup; Windows uses the OS process-tree termination API. stdout,
 * stderr and stdin remain byte streams of the actual command. `commandExit`
 * means the CLI ended; `close` means the owned tree has finished cleanup. */
export function spawnOwnedProcess(command,args=[],{graceMs=2000,...options}={}){
 if(!Number.isSafeInteger(graceMs)||graceMs<0)throw Error('Invalid owned-process cleanup grace period');
 const posix=process.platform!=='win32',stdio=options.stdio??['pipe','pipe','pipe'];
 if(!Array.isArray(stdio)||stdio.length!==3)throw Error('Owned processes require three explicit stdio streams');
 const child=posix?spawn(process.execPath,['--input-type=commonjs','-e',processGuardian,JSON.stringify({command,args,graceMs})],{...options,stdio:[...stdio,'ipc'],detached:true,shell:false}):spawn(command,args,{...options,stdio,detached:false,shell:false});
 let result,closed=false,stopping;
 child.once('close',()=>{closed=true;});
 if(posix)child.on('message',message=>{
  if(message?.type!=='motion-owned-command-exit'||result)return;
  result={code:message.code,signal:message.signal,error:message.error};child.emit('commandExit',result);
 });
 else child.once('exit',(code,signal)=>{result={code,signal};child.emit('commandExit',result);});
 return {child,get result(){return result;},stop(){
  if(stopping)return stopping;
  if(closed)return Promise.resolve();
  if(!posix)return stopping=stopProcessTree(child);
  // No PID-based fallback: a disconnected guardian either owns cleanup itself,
  // or has exited, in which case its numeric PID must never be targeted again.
  return stopping=new Promise(resolve=>{
   if(!child.connected)return resolve();
   child.send({type:'motion-stop-owned-process'},()=>resolve());
  });
 }};
}

/** The npm JS bootstrap can own a native Codex child. Windows kill(pid) alone
 * leaves that child running, so explicitly terminate the owned process tree. */
export async function stopProcessTree(child,{signal='SIGTERM',group=false,platform=process.platform,env=process.env,execCommand=promisify(execFile)}={}){
 if(!Number.isInteger(child?.pid)||child.pid<=0)return;
 if(platform==='win32'){
  const taskkill=hostPath.win32.join(getEnv(env,'SystemRoot')||'C:\\Windows','System32','taskkill.exe');
  try{await execCommand(taskkill,['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,timeout:5000});}catch{try{child.kill(signal);}catch{}}
 }else try{if(group)process.kill(-child.pid,signal);else child.kill(signal);}catch{}
}

export async function blenderExecutable({explicit,env=process.env,platform=process.platform,readDirectory=readdir,resolveProgram=resolveExecutable}={}){
 const p=pathsFor(platform),candidates=[];
 if(platform==='win32'){
  for(const root of [getEnv(env,'ProgramFiles'),getEnv(env,'ProgramFiles(x86)'),getEnv(env,'LOCALAPPDATA')&&p.join(getEnv(env,'LOCALAPPDATA'),'Programs')].filter(Boolean)){
   const foundation=p.join(root,'Blender Foundation');
   try{const versions=(await readDirectory(foundation,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^Blender/i.test(e.name)).map(e=>e.name).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));for(const version of versions)candidates.push(p.join(foundation,version,'blender.exe'));}catch{}
   candidates.push(p.join(foundation,'Blender','blender.exe'));
  }
 }else if(platform==='darwin')candidates.push('/Applications/Blender.app/Contents/MacOS/Blender',p.join(homedir(),'Applications/Blender.app/Contents/MacOS/Blender'),'/opt/homebrew/bin/blender','/usr/local/bin/blender');
 else candidates.push('/usr/bin/blender','/usr/local/bin/blender','/snap/bin/blender');
 return resolveProgram('blender',{explicit:explicit||getEnv(env,'BLENDER_EXECUTABLE'),env,platform,candidates});
}
