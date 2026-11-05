#!/usr/bin/env node
// Minimal remote-CI transport comparison. No product app, WebGL, routing,
// Fetch-domain interception, network replacement or forced GC. Tracing is an
// explicit optional comparison axis and is disabled by default.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {release as osRelease} from 'node:os';

const help=`CI-only native fetch versus released Three.FileLoader comparison.
node tools/diagnostics/browser-network-probe.mjs --package PATH --playwright-root PATH --output PATH [--rounds 20] [--timeout-ms 15000] [--trace]
Requires authorized CI=true/GITHUB_ACTIONS=true on Linux or Windows, Node >=22,
and the separate official Playwright installation and matching Chromium browser.
Each client runs 10-20 times with unique queries. Any protocol failure remains a
failure even when JavaScript receives a valid complete GLB.
Tracing is off by default; --trace records screenshots/snapshots/sources into
trace.zip, using the same settings as the full UI harness.
`;
const argv=process.argv.slice(2),options={};
if(argv.includes('--help')){console.log(help);process.exit(0);}
for(let i=0;i<argv.length;i++){const key=argv[i];assert.ok(['--package','--playwright-root','--output','--rounds','--timeout-ms','--trace'].includes(key),`Unknown option ${key}`);assert.ok(!Object.hasOwn(options,key),`Repeated option ${key}`);if(key==='--trace'){options[key]=true;continue;}assert.ok(argv[i+1]&&!argv[i+1].startsWith('--'),`Missing option value ${key}`);options[key]=argv[++i];}
for(const key of ['--package','--playwright-root','--output'])assert.ok(options[key],`Required ${key}\n${help}`);
assert.ok(['linux','win32'].includes(process.platform),'Browser execution is restricted to remote Linux/Windows CI; local macOS uses CUA.');
assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true','Authorized CI is required.');
assert.ok(Number(process.versions.node.split('.')[0])>=22,'Node.js 22+ is required.');
const rounds=Number(options['--rounds']||20),timeoutMs=Number(options['--timeout-ms']||15000);
assert.ok(Number.isInteger(rounds)&&rounds>=10&&rounds<=20,'--rounds must be 10-20 per client.');assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=60000,'Invalid --timeout-ms.');
const packageRoot=resolve(options['--package']),output=resolve(options['--output']),outside=relative(packageRoot,output);
assert.ok(outside==='..'||outside.startsWith('..'+sep)||isAbsolute(outside),'Output must be outside the extracted Skill.');await mkdir(output,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const bounded=async(promise,label,ms=timeoutMs)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error(label+' timed out after '+ms+' ms'),{code:'PROBE_TIMEOUT'})),ms);})]);}finally{clearTimeout(timer);}};
const report={version:1,startedAt:new Date().toISOString(),verdict:'FAIL',environment:{platform:process.platform,architecture:process.arch,osRelease:osRelease(),node:process.version},design:{roundsPerClient:rounds,order:'paired trials; native/Three order alternates by round',uniqueQueryPerTrial:true,productAppLoaded:false,webgl:false,playwrightRoutes:false,fetchDomainEnabled:false,tracing:Boolean(options['--trace']),forcedGC:false,serverDelivery:'one res.end(Buffer), no-store, explicit Content-Length'},trials:[],requests:[],requestFailures:[],httpErrors:[],console:[],pageErrors:[],unexpectedRequests:[],serverEvents:[],cdpNetwork:[],scriptSha256:sha(await readFile(new URL(import.meta.url)))};
let server,browser,context,page,baseURL,traceStarted=false;const trialByURL=new Map(),browserRequests=new WeakMap(),cdpRequests=new Map();let nextRequest=0;
const pageSource=`<!doctype html><html><head><meta charset="utf-8"><title>Teaching GLB network probe</title><link rel="icon" href="data:,"></head><body><h1>Teaching GLB transport comparison</h1><p>Bundled original mannequin only. No app, WebGL or Agent.</p><pre id="status">Loading the released Three core module…</pre><script type="module">
import {FileLoader,REVISION} from '/three.core.js';
window.networkProbe={revision:REVISION,async run(kind,url){
 const started=performance.now(),progress=[];let buffer;
 if(kind==='native'){const response=await fetch(url);if(!response.ok)throw Error('HTTP '+response.status);buffer=await response.arrayBuffer();}
 else if(kind==='three'){const loader=new FileLoader();loader.setResponseType('arraybuffer');buffer=await loader.loadAsync(url,event=>progress.push({loaded:event.loaded,total:event.total,lengthComputable:event.lengthComputable}));}
 else throw Error('Unknown client');
 if(!(buffer instanceof ArrayBuffer))throw Error('Client did not return an ArrayBuffer');
 const digest=await crypto.subtle.digest('SHA-256',buffer),sha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
 document.getElementById('status').textContent=kind+' received '+buffer.byteLength+' bytes; SHA-256 '+sha256;
 return {byteLength:buffer.byteLength,sha256,elapsedMs:performance.now()-started,progress};
}};document.getElementById('status').textContent='Ready; Three revision '+REVISION;
</script></body></html>`;
try{
 const manifestBytes=await readFile(join(packageRoot,'bundle-manifest.json')),manifest=JSON.parse(manifestBytes),corePath='assets/vendor/three/build/three.core.js',demoPath='assets/demo/baseline.glb';
 const [core,glb]=await Promise.all([readFile(join(packageRoot,corePath)),readFile(join(packageRoot,demoPath))]);
 for(const [path,bytes]of [[corePath,core],[demoPath,glb]]){const entry=manifest.files.find(entry=>entry.path===path);assert.ok(entry,`Not in release manifest: ${path}`);assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256);}
 assert.equal(glb.readUInt32LE(0),0x46546c67);assert.equal(glb.readUInt32LE(8),glb.length);
 report.package={version:manifest.version,manifestSha256:sha(manifestBytes),core:{path:corePath,bytes:core.length,sha256:sha(core)},demo:{path:demoPath,kind:'Packaged original teaching mannequin; no user asset',bytes:glb.length,sha256:sha(glb)}};
 const requirePlaywright=createRequire(join(resolve(options['--playwright-root']),'package.json')),{chromium}=requirePlaywright('playwright');report.environment.playwright=requirePlaywright('playwright/package.json').version;
 server=createServer((request,response)=>{
  const url=new URL(request.url,'http://'+request.headers.host),trial=trialByURL.get(url.href),startedAt=new Date().toISOString();
  if(url.pathname==='/demo.glb'){
   const event=(type,extra={})=>{const row={type,url:url.href,trialId:trial?.row.id,at:new Date().toISOString(),...extra};report.serverEvents.push(row);return row;};event('request',{method:request.method,startedAt});
   request.on('aborted',()=>event('request-aborted'));
   response.on('finish',()=>{const row=event('response-finish',{statusCode:response.statusCode,expectedBytes:glb.length,writableFinished:response.writableFinished});trial?.server.resolve(row);});
   response.on('close',()=>event('response-close',{statusCode:response.statusCode,writableFinished:response.writableFinished,writableEnded:response.writableEnded}));
   response.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':glb.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(glb);return;
  }
  if(url.pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(pageSource);return;}
  if(url.pathname==='/three.core.js'){response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Content-Length':core.length,'Cache-Control':'no-store'});response.end(core);return;}
  if(url.pathname==='/favicon.ico'){response.writeHead(204);response.end();return;}
  response.writeHead(404,{'Content-Type':'text/plain'});response.end('Not part of the minimal probe');
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});baseURL='http://127.0.0.1:'+server.address().port;report.baseURL=baseURL;
 browser=await chromium.launch({headless:true});report.environment.chromium=browser.version();context=await browser.newContext({viewport:{width:1000,height:500}});if(options['--trace']){await context.tracing.start({screenshots:true,snapshots:true,sources:true});traceStarted=true;}page=await context.newPage();page.setDefaultTimeout(timeoutMs);
 page.on('console',message=>report.console.push({type:message.type(),text:message.text(),location:message.location()}));page.on('pageerror',error=>report.pageErrors.push({message:error.message,stack:error.stack}));
 page.on('request',request=>{const url=new URL(request.url()),trial=trialByURL.get(url.href),row={id:++nextRequest,url:url.href,method:request.method(),type:request.resourceType(),trialId:trial?.row.id,startedAt:new Date().toISOString()};browserRequests.set(request,row);report.requests.push(row);if(!['data:','blob:'].includes(url.protocol)&&url.origin!==baseURL)report.unexpectedRequests.push(row);});
 page.on('response',response=>{const row=browserRequests.get(response.request());if(row){row.status=response.status();row.headers=response.headers();}if(response.status()>=400)report.httpErrors.push({url:response.url(),status:response.status()});});
 page.on('requestfinished',request=>{const row=browserRequests.get(request);if(row)row.finishedAt=new Date().toISOString();trialByURL.get(request.url())?.browser.resolve({type:'requestfinished',requestId:row?.id});});
 page.on('requestfailed',request=>{const row=browserRequests.get(request),failure={requestId:row?.id,url:request.url(),trialId:row?.trialId,errorText:request.failure()?.errorText,at:new Date().toISOString()};if(row)row.failure=failure;report.requestFailures.push(failure);trialByURL.get(request.url())?.browser.resolve({type:'requestfailed',...failure});});
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
 cdp.on('Network.requestWillBeSent',event=>{const trial=trialByURL.get(event.request.url);if(!trial)return;const row={requestId:event.requestId,url:event.request.url,trialId:trial.row.id,requestTimestamp:event.timestamp,initiator:event.initiator,dataLength:0,encodedDataLength:0};cdpRequests.set(event.requestId,row);report.cdpNetwork.push(row);});
 cdp.on('Network.responseReceived',event=>{const row=cdpRequests.get(event.requestId);if(row)Object.assign(row,{status:event.response.status,headers:event.response.headers});});
 cdp.on('Network.dataReceived',event=>{const row=cdpRequests.get(event.requestId);if(row){row.dataLength+=event.dataLength;row.encodedDataLength+=event.encodedDataLength;(row.chunks??=[]).push({timestamp:event.timestamp,dataLength:event.dataLength,encodedDataLength:event.encodedDataLength});}});
 cdp.on('Network.loadingFinished',event=>{const row=cdpRequests.get(event.requestId);if(row){Object.assign(row,{finishedTimestamp:event.timestamp,finishedEncodedDataLength:event.encodedDataLength});trialByURL.get(row.url)?.cdp.resolve({type:'loadingFinished',requestId:event.requestId});}});
 cdp.on('Network.loadingFailed',event=>{const row=cdpRequests.get(event.requestId);if(row){Object.assign(row,{failedTimestamp:event.timestamp,errorText:event.errorText,canceled:event.canceled,blockedReason:event.blockedReason});trialByURL.get(row.url)?.cdp.resolve({type:'loadingFailed',requestId:event.requestId,errorText:event.errorText,canceled:event.canceled});}});
 await page.goto(baseURL,{waitUntil:'commit',timeout:timeoutMs});await page.waitForFunction(()=>window.networkProbe&&typeof window.networkProbe.run==='function',undefined,{polling:100,timeout:timeoutMs});
 report.page=await page.evaluate(()=>({threeRevision:window.networkProbe.revision,readyState:document.readyState,secureContext:isSecureContext,webCrypto:Boolean(crypto.subtle),canvasCount:document.querySelectorAll('canvas').length}));assert.equal(report.page.canvasCount,0);assert.equal(report.page.webCrypto,true);
 outer:for(let round=1;round<=rounds;round++)for(const kind of round%2?['native','three']:['three','native']){
  const id=kind+'-'+String(round).padStart(2,'0'),url=new URL('/demo.glb',baseURL);url.search=new URLSearchParams({client:kind,round:String(round),nonce:randomUUID()}).toString();
  const row={id,kind,round,url:url.href,status:'FAIL',startedAt:new Date().toISOString()},trial={row,browser:deferred(),cdp:deferred(),server:deferred()};trialByURL.set(url.href,trial);report.trials.push(row);let clientTimedOut=false;
  try{const value=await bounded(page.evaluate(({kind,url})=>window.networkProbe.run(kind,url),{kind,url:url.href}),'client '+id);row.client={status:'PASS',...value};assert.equal(value.byteLength,glb.length);assert.equal(value.sha256,sha(glb));}
  catch(error){row.client={...(row.client||{}),status:'FAIL',error:error.stack||String(error)};clientTimedOut=error.code==='PROBE_TIMEOUT';}
  const settled=await Promise.allSettled([bounded(trial.browser.promise,'Playwright terminal '+id,3000),bounded(trial.cdp.promise,'CDP terminal '+id,3000),bounded(trial.server.promise,'server finish '+id,3000)]);
  row.terminals=Object.fromEntries(['playwright','cdp','server'].map((key,i)=>[key,settled[i].status==='fulfilled'?{status:'fulfilled',value:settled[i].value}:{status:'rejected',error:settled[i].reason?.message}]));
  const clean=row.terminals.playwright.value?.type==='requestfinished'&&row.terminals.cdp.value?.type==='loadingFinished'&&row.terminals.server.value?.type==='response-finish';row.transportStatus=clean?'PASS':'FAIL';if(row.client.status==='PASS'&&clean)row.status='PASS';row.finishedAt=new Date().toISOString();
  // A timed-out page evaluation can still be running. Stop instead of allowing
  // it to overlap a later trial and corrupt the sequential comparison.
  if(clientTimedOut){report.stoppedAfterClientTimeout=id;break outer;}
 }
 await page.screenshot({path:join(output,'browser-network-probe.png')});await writeFile(join(output,'browser-network-probe.html'),await page.content());
}catch(error){report.error=error.stack||String(error);process.exitCode=1;}
finally{
 if(context&&traceStarted)try{await context.tracing.stop({path:join(output,'trace.zip')});}catch(error){report.traceStopError=error.message;}
 if(browser)try{await browser.close();}catch(error){report.browserCleanupError=error.message;}
 if(server)try{const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections?.();await closed;}catch(error){report.serverCleanupError=error.message;}
 report.summary=Object.fromEntries(['native','three'].map(kind=>{const trials=report.trials.filter(row=>row.kind===kind);return [kind,{planned:rounds,completed:trials.length,clientSHAAndLengthPassed:trials.filter(row=>row.client?.status==='PASS').length,cleanProtocolTerminals:trials.filter(row=>row.transportStatus==='PASS').length,requestFailures:report.requestFailures.filter(row=>row.trialId?.startsWith(kind+'-')).length,cdpFailures:report.cdpNetwork.filter(row=>row.trialId?.startsWith(kind+'-')&&row.errorText).length}];}));
 const prematureServerClose=report.serverEvents.some(row=>row.type==='response-close'&&!row.writableFinished);
 if(!report.error&&!report.traceStopError&&!report.browserCleanupError&&!report.serverCleanupError&&report.trials.length===rounds*2&&report.trials.every(row=>row.status==='PASS')&&!report.requestFailures.length&&!report.httpErrors.length&&!report.pageErrors.length&&!report.console.some(row=>row.type==='error')&&!report.unexpectedRequests.length&&!report.cdpNetwork.some(row=>row.errorText)&&!prematureServerClose)report.verdict='PASS';
 report.finishedAt=new Date().toISOString();report.prematureServerClose=prematureServerClose;
 await writeFile(join(output,'browser-network-probe-result.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(output,'browser-network-probe-events.json'),JSON.stringify({requests:report.requests,requestFailures:report.requestFailures,httpErrors:report.httpErrors,pageErrors:report.pageErrors,console:report.console,unexpectedRequests:report.unexpectedRequests,serverEvents:report.serverEvents,cdpNetwork:report.cdpNetwork},null,2)+'\n');
}
console.log(JSON.stringify({verdict:report.verdict,summary:report.summary,error:report.error,output},null,2));if(report.verdict!=='PASS')process.exitCode=1;
