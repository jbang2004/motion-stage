import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomic,inside} from './core.mjs';

const exec=promisify(execFile),HOST=hostname();
export const HEARTBEAT_STALE_MS=30000;
// Windows PowerShell can take several seconds to cold-start on a busy machine.
const PROBE_TIMEOUT_MS=process.platform==='win32'?15000:3000;
const identities=new Map(),probes=new Map();
async function readIdentity(pid){
 if(process.platform==='linux'){
  const text=await readFile(`/proc/${pid}/stat`,'utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(' ');
  return fields[0]==='Z'?'dead':'linux:'+fields[19];
 }
 if(process.platform==='win32'){
  const {stdout}=await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],{timeout:PROBE_TIMEOUT_MS,windowsHide:true});
  return /^\d+$/.test(stdout.trim())?'win:'+stdout.trim():null;
 }
 const {stdout}=await exec('/bin/ps',['-p',String(pid),'-o','lstart='],{timeout:PROBE_TIMEOUT_MS});return stdout.trim()?'ps:'+stdout.trim():null;
}
// Known identities are cached briefly; a failed or timed-out probe is not, so
// one slow start cannot hide a reused PID from the next check. Concurrent
// checks of the same PID share one probe.
async function processIdentity(pid){
 if(!Number.isSafeInteger(pid)||pid<1)return null;
 const hit=identities.get(pid);if(hit&&Date.now()-hit.at<1000)return hit.value;
 if(probes.has(pid))return probes.get(pid);
 const probe=readIdentity(pid).catch(()=>null).then(value=>{probes.delete(pid);if(value)identities.set(pid,{at:Date.now(),value});return value;});
 probes.set(pid,probe);return probe;
}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function executionPath(id){if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('无效执行实例');return 'executions/'+id+'.json';}
export async function createExecution(work,{heartbeatMs=1000}={}){
 const record={version:1,id:randomUUID(),host:HOST,pid:process.pid,processStart:await processIdentity(process.pid),startedAt:new Date().toISOString(),status:'active'};
 await mkdir(await inside(work,'executions'),{recursive:true});
 const path=await inside(work,executionPath(record.id));let pending=Promise.resolve(),closed=false;
 const beat=()=>{pending=pending.catch(()=>{}).then(()=>atomic(path,{...record,heartbeatAt:new Date().toISOString()}));return pending;};
 await beat();const timer=setInterval(()=>{if(!closed)beat().catch(()=>{});},heartbeatMs);timer.unref();
 return {record:{...record},async close(){if(closed)return;closed=true;clearInterval(timer);await pending.catch(()=>{});record.status='ended';record.endedAt=new Date().toISOString();await beat();}};
}
export async function executionHealth(work,execution){
 if(!execution?.id)return {status:'manual'};
 if(execution.host!==HOST)return {status:'unresponsive',reason:'执行实例来自另一台主机，请确认原执行器已停止后手动中断。'};
 if(!alive(execution.pid))return {status:'dead',reason:'执行宿主已退出，现场和产物已保留。'};
 let record;try{record=JSON.parse(await readFile(await inside(work,executionPath(execution.id)),'utf8'));}catch{return {status:'unresponsive',reason:'无法读取执行心跳，请检查执行器后手动中断或继续等待。'};}
 if(record.id!==execution.id||record.pid!==execution.pid||record.host!==execution.host)return {status:'unresponsive',reason:'执行心跳身份不匹配，请检查原执行器。'};
 if(record.status==='ended')return {status:'dead',reason:'执行器已结束，任务没有完成回传；现场和产物已保留。'};
 const heartbeatAt=Date.parse(record.heartbeatAt),stale=!Number.isFinite(heartbeatAt)||Date.now()-heartbeatAt>HEARTBEAT_STALE_MS;
 if(stale){
  const identity=await processIdentity(execution.pid);
  if(identity==='dead'||(execution.processStart&&identity&&identity!==execution.processStart))return {status:'dead',reason:'原执行宿主已退出，进程号已改变；现场和产物已保留。'};
 }
 return {status:stale?'unresponsive':'alive',heartbeatAt:record.heartbeatAt,...(stale?{reason:'执行心跳已暂停；宿主仍存在，可检查产物、继续等待或手动中断。'}:{})};
}
