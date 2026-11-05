#!/usr/bin/env node
// Development CI only. Playwright is supplied from a separate temporary npm
// prefix; it is never installed into the zero-dependency distributable.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rename,rm,readdir,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir,release as osRelease} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {classifyRequestFailure} from './browser-smoke.network.mjs';
import {createBrowserResourceMonitor} from './browser-resources.mjs';

const help=`Remote Linux/Windows Chromium smoke test for an extracted release.

node tools/ci/browser-smoke.mjs --package PATH --playwright-root PATH --output PATH [--software-webgl] [--keep-fixture] [--browser-channel chromium] [--swiftshader-threads 1..16] [--real-samples PATH]

Requires CI=true (or GITHUB_ACTIONS=true), Node >=22, and official playwright
installed into --playwright-root with its matching Chromium browser installed.
No browser is launched on macOS. See browser-smoke.md for runner commands.
`;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const argv=process.argv.slice(2);
if(argv.includes('--help')){console.log(help);process.exit(0);}
const flags=new Set(['--software-webgl','--keep-fixture']);
const requiredValues=['--package','--playwright-root','--output'];
const values=new Set([...requiredValues,'--browser-channel','--swiftshader-threads','--real-samples']);
const options={};
for(let i=0;i<argv.length;i++){
 const key=argv[i];assert.ok(flags.has(key)||values.has(key),`Unknown option: ${key}`);
 assert.ok(!Object.hasOwn(options,key),`Repeated option: ${key}`);
 if(flags.has(key))options[key]=true;
 else{assert.ok(argv[i+1]&&!argv[i+1].startsWith('--'),`Missing value for ${key}`);options[key]=argv[++i];}
}
for(const key of requiredValues)assert.ok(options[key],`Required: ${key}\n${help}`);
if(options['--browser-channel'])assert.equal(options['--browser-channel'],'chromium');
if(options['--swiftshader-threads'])assert.ok(options['--software-webgl']&&/^(?:[1-9]|1[0-6])$/.test(options['--swiftshader-threads']),'SwiftShader worker count must be 1..16 with software WebGL');
assert.ok(['linux','win32'].includes(process.platform),'Browser execution is restricted to remote Linux/Windows runners; local macOS must use CUA.');
assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true','Browser execution requires an explicitly authorized CI runner.');
assert.ok(Number(process.versions.node.split('.')[0])>=22,'Node.js 22+ is required.');

const packageRoot=resolve(options['--package']),output=resolve(options['--output']);
assert.ok(relative(packageRoot,output)==='..'||relative(packageRoot,output).startsWith('..'+sep)||isAbsolute(relative(packageRoot,output)),'Artifacts must be outside the extracted Skill.');
await mkdir(output,{recursive:true});
const report={version:3,startedAt:new Date().toISOString(),verdict:'FAIL',environment:{platform:process.platform,architecture:process.arch,osRelease:osRelease(),node:process.version,ci:process.env.GITHUB_ACTIONS==='true'?'GitHub Actions':'CI',waitForFunctionPollingMs:100,startupBudgetMs:90000,subsequentSelectionBudgetMs:45000,overallBudgetMs:720000},packageRoot,checks:[],operations:[],screenshots:[],console:[],pageErrors:[],requestFailures:[],httpErrors:[],blockedRequests:[],externalRequests:[],agentRequests:[],mutationRequests:[],selectionEpochs:[],resourceRequests:[],cdpNetwork:[],readyWaits:[],limitations:['Synthetic teaching mannequins only; Sword/Bow names identify isolation fixtures, not user artwork.','Chromium smoke coverage does not replace visual/artistic acceptance, all race permutations, or hardware GPU validation.','Startup, selection and harness timeouts are CI execution budgets, not a product performance SLO.'],scriptSha256:sha(await readFile(new URL(import.meta.url))),networkClassifierSha256:sha(await readFile(new URL('./browser-smoke.network.mjs',import.meta.url)))};
let browser,context,page,server,fixtureRoot,stopCatalogScan,workspace,browserCDP,traceStarted=false,closing=false;
const resourceMonitor=createBrowserResourceMonitor({getBrowserProcesses:()=>browserCDP?browserCDP.send('SystemInfo.getProcessInfo'):Promise.resolve({processInfo:[]})});
resourceMonitor.start();
const ownedSwiftConfigs=[];
const previousEnv={CODEX_EXECUTABLE:process.env.CODEX_EXECUTABLE,BLENDER_EXECUTABLE:process.env.BLENDER_EXECUTABLE};
const pendingHTTPBodies=new Set();
const bounded=async(promise,label,ms=5000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out after '+ms+' ms')),ms);})]);}finally{clearTimeout(timer);}};
let progressWrites=Promise.resolve();
const progress=async()=>{
 const bytes=JSON.stringify(report,null,2)+'\n',file=join(output,'browser-smoke-progress.json');
 const write=progressWrites.catch(()=>{}).then(async()=>{await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);});progressWrites=write;
 try{await bounded(write,'incremental progress write');}catch(error){report.verdict='FAIL';(report.progressErrors??=[]).push(error.stack||String(error));console.error('[browser-smoke] progress write failed: '+error.message);}
};
// Publish the authoritative verdict after its supporting artifacts. If an
// artifact write fails, the saved verdict and the process status must agree.
const finalizeArtifacts=async()=>{
 try{
  await bounded(writeFile(join(output,'browser-console.json'),JSON.stringify({console:report.console,pageErrors:report.pageErrors,requestFailures:report.requestFailures,httpErrors:report.httpErrors,blockedRequests:report.blockedRequests,externalRequests:report.externalRequests,agentRequests:report.agentRequests,selectionEpochs:report.selectionEpochs,resourceRequests:report.resourceRequests,cdpNetwork:report.cdpNetwork},null,2)+'\n'),'write final browser events');
  if(report.failureDiagnostics)await bounded(writeFile(join(output,'failure-diagnostics.json'),JSON.stringify(report.failureDiagnostics,null,2)+'\n'),'write final failure diagnostics');
  await progress();
  await bounded(writeFile(join(output,'browser-smoke-result.json'),JSON.stringify(report,null,2)+'\n'),'write final result');
 }catch(error){
  report.verdict='FAIL';report.artifactWriteError=error.stack||String(error);console.error('[browser-smoke] artifact write failed: '+error.message);await progress();
  try{await bounded(writeFile(join(output,'browser-smoke-result.json'),JSON.stringify(report,null,2)+'\n'),'write failed final result');}
  catch(cause){report.resultWriteError=cause.stack||String(cause);console.error('[browser-smoke] failed verdict could not be saved: '+cause.message);}
 }
};
const operation=async(label,run,timeoutMs=30000)=>{
 const started=Date.now(),row={label,status:'RUNNING',startedAt:new Date(started).toISOString(),timeoutMs};report.operations.push(row);console.log('[browser-smoke] START '+label);await progress();
 try{const result=await bounded(Promise.resolve().then(run),label,timeoutMs);row.status='PASS';return result;}
 catch(error){row.status='FAIL';row.error=error.stack||String(error);throw error;}
 finally{row.elapsedMs=Date.now()-started;row.finishedAt=new Date().toISOString();console.log('[browser-smoke] '+row.status+' '+label+' '+row.elapsedMs+'ms');await progress();}
};
// A timed-out Playwright command may leave its transport/browser alive. Keep a
// separate process deadline so even a stuck cleanup cannot hold CI indefinitely.
const watchdog=setTimeout(()=>{
 report.verdict='FAIL';report.resources=resourceMonitor.snapshot();report.error??='Overall browser harness CI budget exhausted';report.watchdog={firedAt:new Date().toISOString(),budgetMs:report.environment.overallBudgetMs};console.error('[browser-smoke] FATAL overall harness budget exhausted');
 bounded(writeFile(join(output,'browser-smoke-watchdog.json'),JSON.stringify(report,null,2)+'\n'),'watchdog evidence write',3000).catch(()=>{}).finally(()=>process.exit(1));
},report.environment.overallBudgetMs);watchdog.unref();
const failureDiagnostics=async label=>{
 const browserRead=page?bounded(page.evaluate(()=>{
  const s=window.motionReview?.state,ids=['taskRestoring','stageLoading','stageError','notice','errorMessage','catalogStatus','stageStatus','clipTitle'];const canvas=document.querySelector('#canvas'),gl=canvas?.getContext('webgl2');
  return {url:location.href,documentReadyState:document.readyState,exposedStateAvailable:Boolean(s),state:s?{initialized:s.initialized,ready:s.ready,loading:s.loading,switching:s.switching,submitting:s.submitting,activeAssetId:s.project?.activeAssetId,models:Object.fromEntries(Object.entries(s.models||{}).map(([slot,m])=>[slot,{assetId:m.meta?.assetId,sha256:m.meta?.sha256,meshCount:m.meshes?.length,clip:m.clip}]))}:null,dom:Object.fromEntries(ids.map(id=>{const node=document.getElementById(id);return [id,node?{hidden:node.hidden,text:node.textContent.slice(0,4000)}:null];})),catalog:{query:document.getElementById('modelSearch')?.value,dialogOpen:document.getElementById('modelCatalogDialog')?.open,cards:Array.from(document.querySelectorAll('#modelList .model-card'),node=>({text:node.textContent.slice(0,4000),data:{...node.dataset}}))},canvas:canvas?{width:canvas.width,height:canvas.height,webgl2:Boolean(gl),contextLost:gl?.isContextLost()}:null};
 }), 'read-only browser failure summary'):Promise.resolve({unavailable:'Browser not started'});
 const workspaceRead=workspace?bounded((async()=>{
  const entries=await readdir(workspace,{withFileTypes:true}),files=['project.json','catalog.json','.motion-write.lock/owner.json','.motion-transaction.json',...entries.filter(entry=>/^\.motion-write\.ticket-[a-f0-9-]+\.json$/.test(entry.name)).map(entry=>entry.name)];
  const reads=await Promise.allSettled(files.map(async file=>{const path=join(workspace,file),info=await stat(path),row={file,bytes:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,ino:info.ino,dev:info.dev};if(info.isFile()&&info.size<=65536){const bytes=await readFile(path);row.sha256=sha(bytes);const text=bytes.toString('utf8');try{row.json=JSON.parse(text);}catch{row.text=text;}}return row;}));
  return {workspace,topLevel:entries.map(entry=>({name:entry.name,directory:entry.isDirectory()})),files:reads.map((read,i)=>read.status==='fulfilled'?{status:'fulfilled',...read.value}:{status:'rejected',file:files[i],code:read.reason?.code,error:read.reason?.message})};
 })(),'read-only workspace failure snapshot'):Promise.resolve({unavailable:'Workspace not initialized'});
 const results=await Promise.allSettled([browserRead,workspaceRead,bounded(Promise.allSettled([...pendingHTTPBodies]),'diagnostic HTTP error body reads')]);
 const names=['browser','workspace','httpErrorBodyReads'];(report.failureDiagnostics??=[]).push({label,capturedAt:new Date().toISOString(),reads:Object.fromEntries(results.map((result,i)=>[names[i],result.status==='fulfilled'?{status:'fulfilled',value:result.value}:{status:'rejected',error:result.reason?.stack||String(result.reason)}]))});
};
const screenshot=name=>operation('PNG screenshot '+name,async()=>{const file=name+'.png';await page.screenshot({path:join(output,file),fullPage:true,timeout:30000});report.screenshots.push({file,sha256:sha(await readFile(join(output,file)))});},35000);
const check=async(name,run)=>{const start=Date.now(),row={name,status:'RUNNING',startedAt:new Date(start).toISOString()};report.checks.push(row);console.log('[browser-smoke] CHECK START '+name);await progress();try{const details=await bounded(Promise.resolve().then(run),'check '+name,300000);row.status='PASS';if(details!==undefined)row.details=details;}catch(error){row.status='FAIL';row.error=error.stack||String(error);throw error;}finally{row.elapsedMs=Date.now()-start;row.finishedAt=new Date().toISOString();console.log('[browser-smoke] CHECK '+row.status+' '+name+' '+row.elapsedMs+'ms');await progress();}};
try{
 const manifestBytes=await readFile(join(packageRoot,'bundle-manifest.json')),manifest=JSON.parse(manifestBytes);
 await check('extracted release manifest',async()=>{
  const seen=new Set();for(const entry of manifest.files){assert.ok(entry.path&&!isAbsolute(entry.path)&&!entry.path.split(/[\\/]/).includes('..'));assert.ok(!seen.has(entry.path));seen.add(entry.path);const bytes=await readFile(join(packageRoot,entry.path));assert.equal(bytes.length,entry.bytes,entry.path);assert.equal(sha(bytes),entry.sha256,entry.path);}
  report.package={version:manifest.version,manifestSha256:sha(manifestBytes),manifestEntries:manifest.files.length};return report.package;
 });
 const requirePlaywright=createRequire(join(resolve(options['--playwright-root']),'package.json'));
 const {chromium}=requirePlaywright('playwright');report.environment.playwright=requirePlaywright('playwright/package.json').version;
 const setupStarted=Date.now();report.setup={status:'RUNNING',startedAt:new Date(setupStarted).toISOString()};console.log('[browser-smoke] START teaching fixture setup');await progress();
 const moduleAt=path=>import(pathToFileURL(join(packageRoot,path)).href);
 const [{initializeWorkspace},{linkProject},{buildDemo},{parseGlb,encodeGlb},catalog,{serve}]=await Promise.all([moduleAt('scripts/project-workspaces.mjs'),moduleAt('scripts/project-context.mjs'),moduleAt('scripts/practice.mjs'),moduleAt('scripts/asset-tools.mjs'),moduleAt('scripts/asset-catalog.mjs'),moduleAt('scripts/server.mjs')]);
 stopCatalogScan=catalog.stopCatalogScan;
 fixtureRoot=await mkdtemp(join(tmpdir(),'Motion browser CI & 100% 中文 '));
 const project=join(fixtureRoot,'教学项目 中文 空格 & 100%'),models=join(project,'角色'),settings=join(fixtureRoot,'isolated-recent-projects.json');workspace=join(fixtureRoot,'isolated-review');await mkdir(models,{recursive:true});
 process.env.CODEX_EXECUTABLE=join(fixtureRoot,'missing-codex.cjs');process.env.BLENDER_EXECUTABLE=join(fixtureRoot,'missing-blender');
 const demo=await buildDemo(false),names={sword:'教学夹具 Sword 剑士.glb',bow:'教学夹具 Bow 弓手.glb',static:'教学夹具 Static 静态角色.glb',corrupt:'教学夹具 Corrupt 损坏模型.glb'};
 const fixtureHashes={};
 for(const key of ['sword','bow','static']){
  const parsed=parseGlb(demo);parsed.doc.asset.generator='MotionStage synthetic CI teaching derivative '+key;
  parsed.doc.asset.extras={...(parsed.doc.asset.extras||{}),fixture:true,provenance:'Bundled original segmented teaching mannequin; not a user model',identity:key};
  if(parsed.doc.materials?.[0]?.pbrMetallicRoughness)parsed.doc.materials[0].pbrMetallicRoughness.baseColorFactor=key==='bow'?[.2,.65,.85,1]:key==='static'?[.65,.7,.75,1]:[.85,.4,.25,1];
  if(key==='static')delete parsed.doc.animations;
  const bytes=encodeGlb(parsed.doc,parsed.bin,parsed.extra);fixtureHashes[key]=sha(bytes);await writeFile(join(models,names[key]),bytes);
 }
 await writeFile(join(models,names.corrupt),'Synthetic CI teaching fixture: deliberately invalid GLB header.\n');
 await writeFile(join(project,'FIXTURE.txt'),'Only derivatives of the packaged original teaching mannequin. Sword and Bow test model identity; no user project, paid asset or real Agent account is used.\n');
 await bounded(initializeWorkspace(workspace,{title:'Remote browser CI teaching fixtures'}),'initialize fixture workspace',60000);await bounded(linkProject(workspace,project),'link teaching fixture project',30000);await catalog.startCatalogScan(workspace,{force:true});const scanned=await bounded(catalog.waitForCatalogScan(workspace),'scan teaching fixture catalog',60000);
 const entries=Object.fromEntries(Object.entries(names).map(([key,name])=>[key,scanned.entries.find(entry=>entry.name===name)]));for(const [key,entry]of Object.entries(entries))assert.ok(entry,`Missing fixture ${key}`);
 assert.equal(entries.corrupt.status,'invalid');await catalog.openCatalogAsset(workspace,entries.sword.id);
 report.fixture={kind:'Packaged teaching-demo derivatives',project,workspace,names,assetIds:Object.fromEntries(Object.entries(entries).map(([key,entry])=>[key,entry.id])),sourceHashes:fixtureHashes,usesUserAssets:false};
 server=await bounded(serve(workspace,0,{settingsPath:settings}),'start fixture HTTP server',30000);const baseURL='http://127.0.0.1:'+server.address().port;report.baseURL=baseURL;Object.assign(report.setup,{status:'PASS',elapsedMs:Date.now()-setupStarted,finishedAt:new Date().toISOString()});console.log('[browser-smoke] PASS teaching fixture setup '+report.setup.elapsedMs+'ms');await progress();
 const launchArgs=options['--software-webgl']?['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']:[];
 report.environment.chromiumArgs=launchArgs;report.environment.softwareWebGLRequested=Boolean(options['--software-webgl']);
 const viewport=process.platform==='win32'?{width:1280,height:720}:{width:1440,height:1000},traceOptions={screenshots:process.platform!=='win32',snapshots:true,sources:true};report.environment.viewport=viewport;report.environment.trace=traceOptions;
 const browserChannel=options['--browser-channel'];report.environment.browserChannel=browserChannel||'chromium-headless-shell';
 if(options['--swiftshader-threads']){
  assert.equal(browserChannel,'chromium','Thread configuration uses the explicit full Chromium executable');
  const bytes='[Processor]\nThreadCount='+options['--swiftshader-threads']+'\n';
  for(const path of new Set([join(process.cwd(),'SwiftShader.ini'),join(dirname(chromium.executablePath()),'SwiftShader.ini')])){await writeFile(path,bytes,{flag:'wx'});ownedSwiftConfigs.push({path,bytes});}
  report.environment.swiftShaderConfig={requestedThreads:Number(options['--swiftshader-threads']),files:ownedSwiftConfigs.map(({path,bytes})=>({path,sha256:sha(bytes)})),source:'https://swiftshader.googlesource.com/SwiftShader/+/refs/heads/master/docs/RuntimeConfiguration.md',actualConfigConsumptionVerified:false};
 }
 browser=await operation('launch Chromium',()=>chromium.launch({headless:true,...(browserChannel?{channel:browserChannel}:{}),args:launchArgs,timeout:45000}),50000);report.environment.chromium=browser.version();
 browserCDP=await operation('attach browser resource observer',()=>browser.newBrowserCDPSession());
 context=await operation('create browser context',()=>browser.newContext({viewport,deviceScaleFactor:1,locale:'zh-CN'}));
 await operation('start DOM/resources trace',()=>context.tracing.start(traceOptions));traceStarted=true;page=await operation('create browser page',()=>context.newPage());page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(45000);
 page.on('console',message=>report.console.push({type:message.type(),text:message.text(),location:message.location()}));
 page.on('pageerror',error=>report.pageErrors.push({message:error.message,stack:error.stack}));
 const requests=new WeakMap();let activeSelection={epoch:1,assetId:entries.sword.id,startedAt:new Date().toISOString(),reason:'initial navigation'},nextRequest=0;report.selectionEpochs.push(activeSelection);
 page.on('request',request=>{
  const url=new URL(request.url()),selected=url.origin===baseURL&&request.method()==='POST'?url.pathname.match(/^\/api\/catalog\/([a-zA-Z0-9_-]+)\/open$/):null;
  if(!['data:','blob:'].includes(url.protocol)&&url.origin!==baseURL)report.externalRequests.push({url:request.url(),method:request.method(),reason:'Unexpected external page request observed; not intercepted'});
  if(url.origin===baseURL&&url.pathname.startsWith('/api/agent/'))report.agentRequests.push({url:request.url(),method:request.method(),reason:'Unexpected Agent request observed; not intercepted; fixture programs are explicitly missing'});
  if(selected){activeSelection={epoch:activeSelection.epoch+1,assetId:selected[1],startedAt:new Date().toISOString(),reason:'actual UI catalog open request'};report.selectionEpochs.push(activeSelection);}
  if(request.method()!=='GET')report.mutationRequests.push({method:request.method(),path:url.pathname,selectionEpoch:activeSelection.epoch});
  let referrerAssetId=null;try{referrerAssetId=new URL(request.headers().referer).searchParams.get('asset');}catch{}
  const session=['/api/session','/api/studio'].includes(url.pathname),glb=/^\/workspace\/assets\/[a-f0-9]{64}\.glb$/.test(url.pathname),requestAssetId=session?url.searchParams.get('assetId'):referrerAssetId;
  const owner=requestAssetId===activeSelection.assetId?{epoch:activeSelection.epoch,assetId:activeSelection.assetId,referrerAssetId}:null;
  const row={id:++nextRequest,url:request.url(),method:request.method(),resourceType:request.resourceType(),startedAt:new Date().toISOString(),owner,selectionAtStart:{epoch:activeSelection.epoch,assetId:activeSelection.assetId}};requests.set(request,row);if(session||glb)report.resourceRequests.push(row);
 });
 page.on('requestfinished',request=>{const row=requests.get(request);if(row)row.finishedAt=new Date().toISOString();});
 page.on('requestfailed',request=>{
  const failure=request.failure(),row=requests.get(request),failureSelection={epoch:activeSelection.epoch,assetId:activeSelection.assetId};
  const expected=classifyRequestFailure({url:request.url(),method:request.method(),errorText:failure?.errorText,owner:row?.owner,failureSelection,baseURL,closing});
  const event={requestId:row?.id,url:request.url(),method:request.method(),failure,expected,owner:row?.owner||null,failureSelection,failedAt:new Date().toISOString(),closing};if(row)Object.assign(row,{failure:failure?.errorText,failedAt:event.failedAt,failureSelection,expected});report.requestFailures.push(event);
 });
 page.on('response',response=>{
  const row=requests.get(response.request());if(row){row.status=response.status();row.contentLength=response.headers()['content-length']||null;}
  if(response.status()>=400){const error={url:response.url(),status:response.status(),requestId:row?.id,observedAt:new Date().toISOString()};report.httpErrors.push(error);const pending=bounded(response.text(),'HTTP error response body').then(body=>{error.body=body.slice(0,65536);error.bodyCharacters=body.length;error.bodyTruncated=body.length>65536;}).catch(cause=>{error.bodyReadError=cause.message;});pendingHTTPBodies.add(pending);pending.finally(()=>pendingHTTPBodies.delete(pending));}
 });
 // Zero-interception ablation: observe Network events only. No Fetch domain,
 // Playwright routes, response replacement or application/network mocks.
 const cdp=await operation('attach passive Network observer',()=>context.newCDPSession(page)),cdpRequests=new Map();await operation('enable passive Network events',()=>cdp.send('Network.enable'));
 report.environment.networkInterception={method:'none; passive Network events only',playwrightRoutes:false,fetchDomainEnabled:false,patterns:[]};
 cdp.on('Network.requestWillBeSent',event=>{if(!/^\/workspace\/assets\/[a-f0-9]{64}\.glb$/.test(new URL(event.request.url).pathname))return;const row={requestId:event.requestId,url:event.request.url,requestTimestamp:event.timestamp,selectionEpoch:activeSelection.epoch,assetId:activeSelection.assetId,initiator:event.initiator,dataLength:0,encodedDataLength:0};cdpRequests.set(event.requestId,row);report.cdpNetwork.push(row);});
 cdp.on('Network.dataReceived',event=>{const row=cdpRequests.get(event.requestId);if(row){row.dataLength+=event.dataLength;row.encodedDataLength+=event.encodedDataLength;}});
 cdp.on('Network.loadingFinished',event=>{const row=cdpRequests.get(event.requestId);if(row)Object.assign(row,{finishedTimestamp:event.timestamp,finishedEncodedDataLength:event.encodedDataLength});});
 cdp.on('Network.loadingFailed',event=>{const row=cdpRequests.get(event.requestId);if(row)Object.assign(row,{failedTimestamp:event.timestamp,errorText:event.errorText,canceled:event.canceled,blockedReason:event.blockedReason,selectionAtFailure:{epoch:activeSelection.epoch,assetId:activeSelection.assetId}});});
 const ready=async(assetId,{timeoutMs=45000}={})=>{
  const wait={assetId,startedAt:new Date().toISOString(),pollingMs:100,timeoutMs,requiresDocumentParsed:true,requiresLoadedGeometry:true},started=Date.now();report.readyWaits.push(wait);
  try{await operation('strict ready '+assetId,()=>page.waitForFunction(id=>{const s=window.motionReview?.state;return document.readyState!=='loading'&&s?.initialized&&s.ready&&!s.loading&&!s.switching&&!s.submitting&&s.project?.activeAssetId===id&&s.models.baseline?.meta.assetId===id&&s.models.baseline.meshes.length>0;},assetId,{timeout:timeoutMs,polling:100}),timeoutMs+1000);wait.status='PASS';wait.elapsedMs=Date.now()-started;}
  catch(error){wait.elapsedMs=Date.now()-started;wait.status='FAIL';await operation('read-only ready failure diagnostics',()=>failureDiagnostics('ready timeout for '+assetId),8000).catch(cause=>{report.diagnosticError=cause.stack;});throw error;}
  assert.equal(await page.locator('#stageError').isVisible(),false);
 };
 const openCatalog=async()=>{if(!await page.locator('#modelCatalogDialog').isVisible())await page.locator('#openModelCatalog').click();await page.locator('#modelCatalogDialog').waitFor({state:'visible'});};
 const search=async query=>{await page.locator('#modelSearch').fill(query);await operation('catalog search '+query,()=>page.waitForFunction(q=>{const list=document.querySelector('#modelList');return list?.querySelectorAll('.model-card').length===1&&list.textContent.includes(q);},query,{timeout:30000,polling:100}),31000);};
 const selectModel=key=>operation('select fixture '+key,async()=>{await openCatalog();await search(names[key]);const row=page.locator('#modelList .model-card').filter({hasText:names[key]});await row.getByRole('button',{name:/^(预览|打开|继续查看)$/}).click();await ready(entries[key].id);await page.locator('#modelCatalogDialog').waitFor({state:'hidden'});},150000);
 const openDetails=async selector=>{if(!await operation('read details disclosure '+selector,()=>page.locator(selector).evaluate(node=>node.open)))await page.locator(selector+' > summary').click();};
 const readState=()=>operation('read browser review state',()=>page.evaluate(()=>{const r=window.motionReview,s=r.state;return {assetId:s.project?.activeAssetId,ready:s.ready,display:s.display,focus:s.focus,time:s.time,playing:s.playing,panelMode:s.panelMode,target:s.target,models:Object.fromEntries(Object.entries(s.models).map(([key,m])=>[key,{assetId:m.meta.assetId,sha256:m.meta.sha256,clip:m.clip,duration:m.duration,clips:m.clips.map(c=>c.name),meshCount:m.meshes.length}])),jobs:s.jobs.map(j=>({id:j.id,state:j.state,executor:j.executor,assetId:j.assetId,audit:j.audit,candidate:j.candidate,inputs:j.inputs})),context:r.context()};}));
 const webgl=()=>operation('WebGL2 context and framebuffer pixels',()=>page.locator('#canvas').evaluate(canvas=>{
  const gl=canvas.getContext('webgl2');if(!gl)return {webgl2:false};const debug=gl.getExtension('WEBGL_debug_renderer_info');const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);const colors=[new Set(),new Set()];let nonBlack=0,samples=0;
  for(let y=0;y<canvas.height;y+=8)for(let x=0;x<canvas.width;x+=8){const i=(y*canvas.width+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];colors[x<canvas.width/2?0:1].add([r>>3,g>>3,b>>3].join(','));nonBlack+=Number(r+g+b>12);samples++;}
  return {webgl2:gl instanceof WebGL2RenderingContext,contextLost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER),vendor:gl.getParameter(debug?debug.UNMASKED_VENDOR_WEBGL:gl.VENDOR),canvas:{width:canvas.width,height:canvas.height},quantizedColorsByHalf:colors.map(set=>set.size),nonBlackSampleRatio:nonBlack/samples,readPixelsError:gl.getError()};
 }),30000);
 await check('real Chromium WebGL2 preview',async()=>{
  const started=Date.now(),deadline=started+report.environment.startupBudgetMs;report.startup={startedAt:new Date(started).toISOString(),deadlineAt:new Date(deadline).toISOString(),budgetMs:report.environment.startupBudgetMs,navigationWaitUntil:'commit'};
  try{const response=await operation('navigate to committed studio document',()=>page.goto(baseURL+'/?asset='+encodeURIComponent(entries.sword.id),{waitUntil:'commit',timeout:Math.max(1,deadline-Date.now())}),Math.max(1,deadline-Date.now()));report.startup.navigationCommittedMs=Date.now()-started;report.startup.responseStatus=response?.status();const remaining=deadline-Date.now();assert.ok(remaining>0,'CI startup budget exhausted before readiness');await ready(entries.sword.id,{timeoutMs:remaining});report.startup.strictReadyMs=Date.now()-started;assert.ok(Date.now()<=deadline,'CI startup budget exhausted before strict readiness');report.startup.status='PASS';}catch(error){report.startup.status='FAIL';report.startup.elapsedMs=Date.now()-started;throw error;}
  const graphics=await webgl();assert.equal(graphics.webgl2,true);assert.equal(graphics.contextLost,false);assert.equal(graphics.readPixelsError,0);assert.ok(graphics.canvas.width>0&&graphics.canvas.height>0);assert.ok(graphics.quantizedColorsByHalf.every(n=>n>3));assert.ok(graphics.nonBlackSampleRatio>.2);report.graphics=graphics;await screenshot('01-webgl-preview');return graphics;
 });
 await check('directory, invalid item and UI search',async()=>{
  await openCatalog();await page.locator('#modelSearch').fill('');await operation('read complete fixture catalog',()=>page.waitForFunction(()=>document.querySelectorAll('#modelList .model-card').length===5,undefined,{timeout:30000,polling:100}),31000);
  const broken=page.locator('#modelList .model-card').filter({hasText:names.corrupt});assert.ok((await broken.locator('.catalog-error').innerText()).length>0);assert.equal(await broken.getByRole('button').count(),0);assert.ok((await page.locator('#modelList').innerText()).includes('原创教学素材'));await screenshot('02-directory-invalid-item');await search('Sword');assert.equal(await page.locator('#modelList .model-card').count(),1);await screenshot('03-directory-search');await page.locator('#modelCatalogDialog button[data-close]').click();return {totalEntries:5,invalidCannotOpen:true,teachingFixtureVisible:true};
 });
 const drafts={sword:{request:'Sword 教学夹具 A 草稿\n保留右臂 & 根运动 100%。',preserve:'A preserve：其他动作和时长保持。'},bow:{request:'Bow 教学夹具 B 独立草稿\n不要混入 Sword 的要求。',preserve:'B preserve：只检查这个教学模型。'}};
 await check('A/B draft isolation and restoration through UI',async()=>{
  await page.locator('#request').fill(drafts.sword.request);await openDetails('.preserve-details');await page.locator('#preserve').fill(drafts.sword.preserve);await selectModel('bow');assert.equal(await page.locator('#request').inputValue(),'');assert.equal(await page.locator('#preserve').inputValue(),'');await page.locator('#request').fill(drafts.bow.request);await openDetails('.preserve-details');await page.locator('#preserve').fill(drafts.bow.preserve);
  for(const key of ['sword','bow']){await selectModel(key);assert.equal(await page.locator('#request').inputValue(),drafts[key].request);assert.equal(await page.locator('#preserve').inputValue(),drafts[key].preserve);await screenshot('04-draft-'+key);}
  return {assetIds:{sword:entries.sword.id,bow:entries.bow.id},exactRequestAndPreserveRestored:true};
 });
 await check('static preview disables animation and local motion editing',async()=>{
  await selectModel('static');await openDetails('#localTools');for(const id of ['motionSelect','play','prev','next','scopeMode','localEdit'])assert.equal(await page.locator('#'+id).isDisabled(),true,id);const state=await readState();assert.equal(state.models.baseline.clips.length,0);assert.equal(state.models.baseline.duration,0);assert.ok(state.models.baseline.meshCount>0);await screenshot('05-static-disabled-controls');return state;
 });
 await check('70 percent LeftShoulder local candidate and split comparison',async()=>{
  await selectModel('sword');await page.locator('#motionSelect').selectOption('Run');await openDetails('#localTools');await page.locator('#localTarget').click();await page.locator('#targetDialog').waitFor({state:'visible'});await page.locator('#boneSelect').selectOption('LeftShoulder');await page.locator('#targetDialog .primary-button[data-close]').click();await page.locator('#swingFactor').focus();await page.locator('#swingFactor').press('Home');for(let i=0;i<10;i++)await page.locator('#swingFactor').press('ArrowRight');assert.ok(Math.abs(Number(await page.locator('#swingFactor').inputValue())-.7)<1e-9);assert.equal((await page.locator('#factorLabel').innerText()).trim(),'70%');
  await page.locator('#localEdit').click();await operation('local candidate complete and visible',()=>page.waitForFunction(()=>{const s=window.motionReview?.state;return s&&!s.loading&&!s.switching&&!s.submitting&&s.display==='split'&&s.jobs.some(j=>j.state==='complete'&&j.executor==='local')&&s.models.candidate?.meta.sha256!==s.models.baseline?.meta.sha256;},undefined,{timeout:45000,polling:100}),46000);
  await page.locator('[data-version="compare"]').click();if(await operation('read playback state',()=>page.evaluate(()=>window.motionReview.state.playing)))await page.locator('#play').click();await page.locator('#timeline').focus();await page.locator('#timeline').press('Home');for(let i=0;i<3;i++)await page.locator('#timeline').press('PageUp');
  const state=await readState(),job=state.jobs.find(j=>j.state==='complete'&&j.executor==='local');assert.equal(state.assetId,entries.sword.id);assert.equal(job.assetId,entries.sword.id);assert.equal(job.audit.factor,.7);assert.equal(job.audit.bone,'LeftShoulder');assert.equal(state.models.baseline.sha256,fixtureHashes.sword);assert.notEqual(state.models.candidate.sha256,state.models.baseline.sha256);assert.equal(state.display,'split');assert.equal(await page.locator('#stageDivider').isVisible(),true);assert.equal(await page.locator('#surface-baseline').isVisible(),true);assert.equal(await page.locator('#surface-candidate').isVisible(),true);assert.ok((await page.locator('#latestJob').innerText()).includes('70%'));
  const a=state.context.cameras.baseline,b=state.context.cameras.candidate;for(const key of ['position','target'])for(let i=0;i<3;i++)assert.ok(Math.abs(a[key][i]-b[key][i])<1e-6);assert.ok(Math.abs(state.context.slots.baseline.time-state.context.slots.candidate.time)<1e-6);assert.ok(state.time>.1&&state.time<.9);const graphics=await webgl();assert.ok(graphics.quantizedColorsByHalf.every(n=>n>3));assert.equal(graphics.readPixelsError,0);await screenshot('06-local-70-percent-comparison');return {state,graphics,alignedCamerasAndElapsedSeconds:true};
 });
 await check('source files unchanged and no real Agent execution',async()=>{
  for(const key of ['sword','bow','static'])assert.equal(sha(await readFile(join(models,names[key]))),fixtureHashes[key]);assert.equal(report.blockedRequests.length,0);assert.equal(report.externalRequests.length,0);assert.equal(report.agentRequests.length,0);assert.equal(report.pageErrors.length,0);const unexpectedConsole=report.console.filter(item=>item.type==='error'),unexpectedRequests=report.requestFailures.filter(item=>!item.expected);assert.deepEqual(unexpectedConsole,[]);assert.deepEqual(unexpectedRequests,[]);assert.deepEqual(report.httpErrors,[]);const state=await readState();assert.ok(state.jobs.every(job=>job.executor==='local'));return {sourceHashes:fixtureHashes,onlyLocalJobs:true,pageErrors:0,consoleErrors:0,unexpectedFailedRequests:0,expectedViewRequestAborts:report.requestFailures.length};
 });
 if(options['--real-samples']){const {checkRealAssetBrowser}=await import('./real-assets/browser-check.mjs');await check('locked public real assets',async()=>{report.limitations[0]='Teaching isolation fixtures plus hash-pinned public assets; see realAssets for exact sources and checks.';report.realAssets=await checkRealAssetBrowser({context,skillRoot:packageRoot,samples:resolve(options['--real-samples']),output});return {samples:report.realAssets.cases.length,status:report.realAssets.status};});}
 report.verdict='PASS';
}catch(error){
 report.error=error.stack||String(error);if(report.setup?.status==='RUNNING')Object.assign(report.setup,{status:'FAIL',error:report.error});await progress();
 if(!report.failureDiagnostics)await operation('read-only smoke failure diagnostics',()=>failureDiagnostics('smoke failure'),8000).catch(cause=>{report.diagnosticError=cause.stack;});
 if(page){
  await screenshot('failure').catch(cause=>{(report.failureCaptureErrors??=[]).push(cause.stack||String(cause));});
  await operation('capture failure HTML',async()=>{const html=await bounded(page.content(),'read failure HTML',5000);await bounded(writeFile(join(output,'failure.html'),html),'write failure HTML',5000);},11000).catch(cause=>{(report.failureCaptureErrors??=[]).push(cause.stack||String(cause));});
 }
}
finally{
 closing=true;
 browserCDP=null;
 await bounded(Promise.allSettled([...pendingHTTPBodies]),'pending HTTP error body reads',6000).catch(error=>{report.httpBodyCleanupError=error.message;report.verdict='FAIL';});
 if(context&&traceStarted)try{await operation('stop and save DOM/resources trace',()=>context.tracing.stop({path:join(output,'trace.zip')}),20000);}catch(error){report.traceError=error.message;report.verdict='FAIL';}
 if(browser)try{await operation('close Chromium',()=>browser.close(),10000);}catch(error){report.cleanupError=error.message;report.verdict='FAIL';}
 if(server)try{await operation('close fixture HTTP server',async()=>{const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections?.();await closed;},10000);}catch(error){report.serverCleanupError=error.message;report.verdict='FAIL';}
 if(stopCatalogScan&&workspace)try{await operation('stop fixture catalog scan',()=>stopCatalogScan(workspace),10000);}catch(error){report.scanCleanupError=error.message;report.verdict='FAIL';}
 for(const [key,value]of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 if(fixtureRoot&&!options['--keep-fixture'])try{await operation('remove isolated teaching fixture',()=>rm(fixtureRoot,{recursive:true,force:true}),10000);}catch(error){report.fixtureCleanupError=error.message;report.verdict='FAIL';}
 for(const config of ownedSwiftConfigs)try{await operation('remove owned SwiftShader configuration',async()=>{if(await readFile(config.path,'utf8')!==config.bytes)throw Error('Owned SwiftShader config changed during test');await rm(config.path);},5000);}catch(error){report.configCleanupError=error.message;report.verdict='FAIL';}
 report.resources=await resourceMonitor.stop();
 const lateUnexpected=report.requestFailures.filter(item=>!item.expected);if(lateUnexpected.length){report.verdict='FAIL';report.unexpectedRequestFailures=lateUnexpected;}
 await bounded(Promise.allSettled([...pendingHTTPBodies]),'final HTTP error body reads',6000).catch(error=>{report.httpBodyCleanupError=error.message;report.verdict='FAIL';});if(report.httpErrors.length||report.pageErrors.length||report.console.some(item=>item.type==='error')||report.blockedRequests.length||report.externalRequests.length||report.agentRequests.length||report.progressErrors?.length)report.verdict='FAIL';
 report.finishedAt=new Date().toISOString();report.fixtureRetained=Boolean(fixtureRoot&&options['--keep-fixture']);
 await progress();
 await finalizeArtifacts();
}
clearTimeout(watchdog);
console.log(JSON.stringify({verdict:report.verdict,platform:process.platform,checks:report.checks.map(({name,status})=>({name,status})),output,error:report.error},null,2));
if(report.verdict!=='PASS')process.exitCode=1;
// Transport promises that exceeded their bounds cannot keep the CLI alive after
// evidence is saved. This does not convert a cleanup timeout into a passing run.
const exitWatchdog=setTimeout(()=>process.exit(process.exitCode||0),1000);exitWatchdog.unref();
