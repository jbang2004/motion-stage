// CI diagnostics only. Sampling must never fail or modify the browser test.
import {performance} from 'node:perf_hooks';
import {cpus,availableParallelism,freemem,totalmem} from 'node:os';

const positive=(value,fallback)=>Number.isFinite(value)&&value>0?value:fallback;
const message=error=>error?.stack||String(error);
const total=times=>Object.values(times).reduce((sum,value)=>sum+value,0);

export function createBrowserResourceMonitor({getBrowserProcesses,sampleIntervalMs=1000,browserIntervalMs=5000,browserTimeoutMs=2000,maxSamples=1000}={}){
 sampleIntervalMs=positive(sampleIntervalMs,1000);browserIntervalMs=positive(browserIntervalMs,5000);browserTimeoutMs=positive(browserTimeoutMs,2000);maxSamples=Math.max(1,Math.floor(positive(maxSamples,1000)));
 const report={version:1,pid:process.pid,platform:process.platform,node:process.version,sampleIntervalMs,browserIntervalMs,browserTimeoutMs,maxSamples,status:'idle',nodeSamples:[],browserSamples:[],errors:[],skippedBrowserSamples:0,droppedNodeSamples:0,droppedBrowserSamples:0};
 let timer=null,running=false,stopped=false,started=0,lastTick=0,nextBrowser=0,previousCPU,previousSystem,flight=null,stopPromise=null,previousBrowser=null;
 const keep=(key,row)=>{report[key].push(row);if(report[key].length>maxSamples){report[key].shift();if(key==='nodeSamples')report.droppedNodeSamples++;if(key==='browserSamples')report.droppedBrowserSamples++;}};
 const error=(phase,cause)=>{try{report.errors.push({phase,at:new Date().toISOString(),elapsedMs:performance.now()-started,error:message(cause)});if(report.errors.length>100)report.errors.shift();}catch{}};
 const nodeSample=()=>{
  try{
   const now=performance.now(),cpu=process.cpuUsage(),system=cpus(),intervalMs=lastTick?now-lastTick:null;
   const processCPU=previousCPU&&intervalMs>0?{userMicros:cpu.user-previousCPU.user,systemMicros:cpu.system-previousCPU.system}:null;
   if(processCPU)processCPU.percentOfOneCore=(processCPU.userMicros+processCPU.systemMicros)/(intervalMs*1000)*100;
   const cores=system.map((current,index)=>{
    const before=previousSystem?.[index];if(!before||before.model!==current.model)return {index,busyPercent:null};
    const totalDelta=total(current.times)-total(before.times),idleDelta=current.times.idle-before.times.idle;
    return {index,totalDeltaMs:totalDelta,idleDeltaMs:idleDelta,busyPercent:totalDelta>0&&idleDelta>=0?(1-idleDelta/totalDelta)*100:null};
   });
   const valid=cores.filter(core=>core.totalDeltaMs>0&&core.idleDeltaMs>=0),systemTotal=valid.reduce((sum,core)=>sum+core.totalDeltaMs,0),systemIdle=valid.reduce((sum,core)=>sum+core.idleDeltaMs,0);
   keep('nodeSamples',{at:new Date().toISOString(),elapsedMs:now-started,intervalMs,lagMs:intervalMs===null?0:Math.max(0,intervalMs-sampleIntervalMs),processCPU,systemCPU:{cpuCount:system.length,availableParallelism:availableParallelism(),busyPercent:systemTotal>0?(1-systemIdle/systemTotal)*100:null,cores},memory:{...process.memoryUsage(),systemFreeBytes:freemem(),systemTotalBytes:totalmem()}});
   previousCPU=cpu;previousSystem=system;lastTick=now;
  }catch(cause){error('node-sample',cause);}
 };
 const browserSample=()=>{
  if(typeof getBrowserProcesses!=='function')return;
  if(flight){report.skippedBrowserSamples++;return;}
  const began=performance.now(),wall=Date.now(),row={at:new Date(wall).toISOString(),elapsedMs:began-started,status:'RUNNING',timeoutMs:browserTimeoutMs};keep('browserSamples',row);
  const current={deadline:null,observed:null};flight=current;
  let finish;
  current.observed=new Promise(resolve=>{
   let done=false;
   finish=(status,value)=>{
    if(done||stopped)return;done=true;clearTimeout(current.deadline);
    const now=performance.now();Object.assign(row,{status,durationMs:now-began,wallDurationMs:Date.now()-wall,finishedAt:new Date().toISOString()});
    if(status==='PASS'){
     try{
      const rows=Array.isArray(value)?value:value?.processInfo;if(!Array.isArray(rows))throw Error('SystemInfo.getProcessInfo returned no processInfo array');
      const intervalMs=previousBrowser?now-previousBrowser.at:null;
      row.intervalSincePreviousSuccessMs=intervalMs;
      row.processes=rows.map(info=>{
       const pid=info.id??info.pid,cpuTime=info.cpuTime,type=info.type;
       if(!Number.isFinite(pid)||!Number.isFinite(cpuTime)||typeof type!=='string')throw Error('Invalid browser process CPU sample');
       const prior=previousBrowser?.processes.get(pid),delta=prior?.type===type&&cpuTime>=prior.cpuTime?cpuTime-prior.cpuTime:null;
       return {pid,type,cpuTime,cpuDeltaSeconds:delta,cpuPercentOfOneCore:delta!==null&&intervalMs>0?delta/(intervalMs/1000)*100:null};
      });
      previousBrowser={at:now,processes:new Map(row.processes.map(info=>[info.pid,info]))};
     }catch(cause){row.status='ERROR';row.error=message(cause);error('browser-process-sample',cause);}
    }else{row.error=message(value);error('browser-process-sample',value);}
    resolve();
   };
   current.deadline=setTimeout(()=>finish('TIMEOUT',Error('Browser process sample timed out after '+browserTimeoutMs+' ms')),browserTimeoutMs);
  });
  // A timeout bounds observation, not the underlying CDP command. Keep the raw
  // command occupying the slot until it settles so slow replies never overlap.
  Promise.resolve().then(()=>getBrowserProcesses()).then(value=>{
   finish('PASS',value);
   if(!stopped&&row.status==='TIMEOUT')row.lateSettlementMs=performance.now()-began;
  },cause=>{finish('ERROR',cause);if(!stopped&&row.status==='TIMEOUT')row.lateSettlementMs=performance.now()-began;}).finally(()=>{if(flight===current)flight=null;}).catch(cause=>error('browser-sample-finalization',cause));
 };
 const tick=()=>{
  if(!running)return;
  try{nodeSample();const now=performance.now();if(now>=nextBrowser){nextBrowser=now+browserIntervalMs;browserSample();}}catch(cause){error('sample-tick',cause);}
 };
 const snapshot=()=>{
  try{return structuredClone(report);}catch(cause){error('snapshot',cause);return {version:1,status:report.status,error:message(cause)};}
 };
 const start=()=>{
  try{
   if(running||stopped)return snapshot();running=true;started=performance.now();report.status='running';report.startedAt=new Date().toISOString();
   nodeSample();nextBrowser=started+browserIntervalMs;browserSample();timer=setInterval(tick,sampleIntervalMs);timer.unref?.();
  }catch(cause){error('start',cause);}
  return snapshot();
 };
 const stop=()=>{
  if(stopPromise)return stopPromise;
  stopPromise=(async()=>{
   try{
    running=false;clearInterval(timer);timer=null;
    // observed always settles within the current sample's original deadline;
    // do not wait for an unresponsive raw CDP command, and do not restart it.
    if(flight)await flight.observed;
    if(report.status!=='idle')nodeSample();
   }catch(cause){error('stop',cause);}
   finally{stopped=true;if(flight)clearTimeout(flight.deadline);report.status='stopped';report.stoppedAt=new Date().toISOString();report.elapsedMs=started?performance.now()-started:0;}
   return snapshot();
  })();
  return stopPromise;
 };
 return {start,stop,snapshot};
}
