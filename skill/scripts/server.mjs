import {createStudioEvents} from './studio-events.mjs';
import {scanProviders,probeProvider,providerInfo} from './agent-providers.mjs';
import {normalizeCaller,callerKey} from '../assets/viewer/caller.mjs';
import {discoverCharacterActions,previewCharacterAction,characterActionCurves,stopCharacterActionDiscovery} from './character-actions.mjs';
import {listThumbnails,saveThumbnail,thumbnailPath} from './thumbnails.mjs';
import {undoStatus,applyUndo} from './undo.mjs';
import {readDraft,saveDraft} from './drafts.mjs';
import {integrationStatus} from './game-integration.mjs';
import {motionLibrary,registerMotionPack,saveMotionMapping,previewMotion,adoptMotion,removeMotion,materializeMotion,motionRigOptions} from './motion-library.mjs';
import {previewReplacement,replaceAction,listReplacementPlans,withdrawReplacementPlan,replacementHandoff} from './action-replacement.mjs';
import {createServer} from 'node:http';
import {readFile,stat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {extname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ROOT,json,inside,atomic,validateNote,importAsset,readMarks,sha,withWorkspaceLock,hasClip,readProject,projectView,modelSlots,activateModel} from './core.mjs';
import {catalogPage,startCatalogScan,openCatalogAsset,stopCatalogScan} from './asset-catalog.mjs';
import {characterPage,castRoster,characterModelBytes,openCharacter,associateCharacterMotion,saveCharacterMap} from './character-library.mjs';
import {listJobs,getJob,createJob,cancelJob,localEditJob,reviewJob,inspectSlot,diagnoseFootSlip,importBytes,replyJob,updateJobProgress,getJobProjectContext,previewProjectContext,retryJob,restoreJob,interruptJob,jobArtifacts,reconcileExecutions} from './jobs.mjs';
import {projectStatus,prepareProject,chooseProjectFolder,revealWorkspace} from './project-workspaces.mjs';
import {diagnoseRuntime} from './runtime-diagnostics.mjs';
import {appearanceStatus,appearanceFile} from './project-appearance.mjs';
import {offlinePreviewStatus,runtimePreviewStatus,runtimePreviewHandoff} from './runtime-preview.mjs';
import {createManagedPreview} from './managed-preview.mjs';
import {readJobIndex,jobsPage,activeJobStates} from './job-index.mjs';
import * as jobLifecycle from './jobs.mjs';

async function studioJobIndex(work){return withWorkspaceLock(work,async()=>{let index=await readJobIndex(work);if(jobLifecycle.reconcileExecutions&&(await jobLifecycle.reconcileExecutions(work,{index})).changed)index=await readJobIndex(work);return index;});}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.glb':'model/gltf-binary','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.mp4':'video/mp4','.md':'text/plain; charset=utf-8'};
const workspaceServers=new Map();
async function body(req,limit){let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>limit)throw Error('文件过大');chunks.push(b);}return Buffer.concat(chunks);}
export async function serve(work,port=5178,options={}){
 const caller=normalizeCaller(options.caller);options={...options,caller};
 work=await realpath(work);const serverKey=JSON.stringify([work,callerKey(caller)]);const children=new Set();
 let serverCloseCleanup=()=>{};
 const managedPreview=createManagedPreview(work, options.managedPreview);
 const diagnose=options.diagnoseRuntime||diagnoseRuntime;
 let runtime=await diagnose({workspace:work,programs:[]});
 if(!runtime.node.supported)throw Error('需要 Node.js 22 或更高版本。请升级 Node.js 后重新启动工作台。');
 if(runtime.workspace.status!=='ready')throw Error(runtime.workspace.error||'工作区不可读写，请选择本机可写目录。');
 await readProject(work);await reconcileExecutions(work);
 const studioEvents=createStudioEvents(work);
 const token=randomBytes(24).toString('hex');let queue=Promise.resolve();
 let agent={connected:false,active:false,state:'disconnected',provider:'codex',error:null},workerAbort=null,workerGeneration=0,connecting=null,workerRun=null;
 const updateAgent=next=>{agent=next;studioEvents.changed();};
 const ensureAgentIdle=()=>{if(agent.active&&(agent.jobId||agent.state==='claiming'))throw Object.assign(Error(providerInfo(agent.provider).label+' 正在处理任务，完成后即可切换。'),{code:'AGENT_BUSY'});};
 const capabilityView=runtime=>({codex:runtime.codex,localEdit:runtime.features.localEdit,fbxImport:runtime.features.fbxConversion,mcp:true,automaticAgent:agent.connected,runtime});
 const getCaps=()=>capabilityView(runtime);
 let checking;
 const recheck=()=>checking??=diagnose({workspace:work}).then(report=>{runtime={...report,server:runtime.server};return runtime;}).finally(()=>{checking=null;});

 serverCloseCleanup=()=>{workerAbort?.abort();for(const child of children)child.close();};
 const server=createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  try{
   const host=req.headers.host||'';if(!/^127\.0\.0\.1:\d+$/.test(host))return send(403,{error:'只接受本机连接'});
   const origin='http://'+host;if(req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'Origin mismatch'});
   const url=new URL(req.url,origin),p=decodeURIComponent(url.pathname);
   const draftRoute=p.match(/^\/api\/drafts\/([a-zA-Z0-9_-]{1,80})$/);
   if(draftRoute&&req.method==='GET')return send(200,await readDraft(work,draftRoute[1]));
   if(p==='/api/undo'&&req.method==='GET')return send(200,await undoStatus(work,url.searchParams.get('assetId')));
   if(p==='/api/actions/replacement-plans'&&req.method==='GET')return send(200,await listReplacementPlans(work,url.searchParams.get('assetId')));
   if(p==='/api/integrations'&&req.method==='GET')return send(200,await integrationStatus(work));
   if(p==='/api/session'&&req.method==='GET')return send(200,{token,caller,paths:{workspace:work,cli:ROOT+'/scripts/motion-feedback.mjs'},project:projectView(await readProject(work),url.searchParams.get('assetId')||undefined),feedback:await json(await inside(work,'feedback.json')),marks:await readMarks(work)});
   if(p==='/api/agents'&&req.method==='GET')return send(200,await scanProviders());
   if(p==='/api/doctor'&&req.method==='GET')return send(200,url.searchParams.get('cached')==='1'?runtime:await recheck());
   if(p==='/api/actions'&&req.method==='GET')return send(200,await discoverCharacterActions(work,Object.fromEntries(url.searchParams)));
   if(p==='/api/motions'&&req.method==='GET')return send(200,await motionLibrary(work));
   if(p==='/api/motions/export'&&req.method==='GET'){const result=await materializeMotion(work,{...Object.fromEntries(url.searchParams),exportOnly:true});res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Disposition':"attachment; filename=motion-stage-character.glb",'Content-Length':result.bytes.length,'Cache-Control':'no-store'});return res.end(result.bytes);}
   if(p==='/api/catalog'&&req.method==='GET')return send(200,await catalogPage(work,Object.fromEntries(url.searchParams)));
   if(p==='/api/characters'&&req.method==='GET')return send(200,await characterPage(work,Object.fromEntries(url.searchParams)));
   if(p==='/api/cast'&&req.method==='GET')return send(200,await castRoster(work,{scope:url.searchParams.get('scope')||'all'}));
   if(p==='/api/thumbnails'&&req.method==='GET')return send(200,await listThumbnails(work));
   const characterModel=p.match(/^\/api\/characters\/([-\w]+)\/model$/);
   if(characterModel&&req.method==='GET'){const bytes=await characterModelBytes(work,characterModel[1]);res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(bytes);}
   if(p==='/api/appearance'&&req.method==='GET')return send(200,await appearanceStatus(work,url.searchParams.get('assetId')||undefined));
   if(p==='/api/runtime-preview'&&req.method==='GET')return send(200,await runtimePreviewStatus(work,url.searchParams.get('assetId'),origin));
   if(p==='/api/offline-preview'&&req.method==='GET')return send(200,await offlinePreviewStatus(work,url.searchParams.get('assetId')));
   if(p==='/api/project'&&req.method==='GET')return send(200,await projectStatus(work,options));
   const pc=p.match(/^\/api\/jobs\/([a-f0-9-]{36})\/project-context$/);if(pc&&req.method==='GET')return send(200,await getJobProjectContext(work,pc[1]));
   if(p==='/api/studio/events'&&req.method==='GET')return studioEvents.subscribe(res);
   if(p==='/api/studio'&&req.method==='GET'){
    const capabilities=await getCaps();
    if(url.searchParams.get('compact')!=='1')return send(200,await withWorkspaceLock(work,async()=>({version:2,project:projectView(await readProject(work),url.searchParams.get('assetId')||undefined),jobs:await listJobs(work),capabilities,agent:{...agent,lastError:agent.error}})));
    return send(200,await withWorkspaceLock(work,async()=>{
     const project=projectView(await readProject(work),url.searchParams.get('assetId')||undefined),index=await studioJobIndex(work),rows=index.rows.filter(j=>j.assetId===project.activeAssetId),selected=url.searchParams.get('jobId');
     const head=project.slots.candidate;
     const owner=head?.derivedByJobId||head?.source?.derivedByJobId;
     const matchesHead=j=>j.state==='complete'&&j.candidate?.sha256===head.sha256&&j.candidate.file===head.file;
     const currentCandidate=head&&(rows.find(j=>j.id===owner&&matchesHead(j))||rows.find(matchesHead));
     const jobs=rows.filter((j,i)=>i===0||activeJobStates.has(j.state)||j.id===selected||j.id===currentCandidate?.id);
     const payload={version:3,project,jobs,candidateJobId:currentCandidate?.id??null,jobCounts:index.counts,totalJobs:index.total,jobsRevision:index.revision,capabilities,agent:{...agent,lastError:agent.error}};
     const revision=sha(Buffer.from(JSON.stringify(payload)));return url.searchParams.get('since')===revision?{version:3,unchanged:true,revision,assetId:project.activeAssetId}:{...payload,revision};
    }));
   }
   if(p==='/api/jobs'&&req.method==='GET')return send(200,url.searchParams.get('page')==='1'?await jobsPage(work,Object.fromEntries(url.searchParams),{index:await studioJobIndex(work)}):{jobs:await listJobs(work)});
   const artifacts=p.match(/^\/api\/jobs\/([a-f0-9-]{36})\/artifacts$/);
   if(artifacts&&req.method==='GET'){const result=await jobArtifacts(work,artifacts[1]),file=url.searchParams.get('file');if(!file)return send(200,result);const entry=result.files.find(f=>f.file===file);if(!entry)return send(404,{error:'产物不存在'});if(entry.size>200*1024*1024)throw Error('产物超过 200 MB，请在工作区检查。');const bytes=await readFile(await inside(work,file));res.writeHead(200,{'Content-Type':MIME[extname(file)]||'application/octet-stream','Content-Disposition':'attachment','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(bytes);}
   if(/^\/api\/jobs\/[a-f0-9-]{36}$/.test(p)&&req.method==='GET')return send(200,await getJob(work,p.split('/').pop()));
   if(p==='/api/inspect'&&req.method==='GET')return send(200,await inspectSlot(work,url.searchParams.get('slot')||'baseline',url.searchParams.get('assetId')||undefined));
   if(p==='/api/feedback'&&req.method==='GET')return send(200,await json(await inside(work,'feedback.json')));
   if(p==='/api/export'&&req.method==='GET')return send(200,{...await json(await inside(work,'feedback.json')),marks:Object.values((await readMarks(work)).reviews),jobs:await listJobs(work),version:2});
   if(p.startsWith('/api/')&&req.method!=='GET'){
    if(req.headers['x-motion-token']!==token)return send(403,{error:'请刷新页面后重试'});
    const data=await body(req,p.startsWith('/api/assets/')?200*1024*1024:12*1024*1024);
    if(p.startsWith('/api/runtime-preview/')&&req.method==='POST'){
     const input=JSON.parse(data);
     if(p==='/api/runtime-preview/handoff')return send(200,await runtimePreviewHandoff(work,input,caller,options.sendToCaller));
     const {lease,assetId}=input;
     if(typeof lease!=='string'||!/^[-\w]{36}$/.test(lease))return send(400,{error:'游戏预览会话无效'});
     if(p==='/api/runtime-preview/renew')return send(200,{active:managedPreview.renew(lease)});
     if(p==='/api/runtime-preview/release'){await managedPreview.release(lease);return send(200,{});}
     if(p==='/api/runtime-preview/open'){
      const catalog=await managedPreview.acquire(lease);
      const result=await runtimePreviewStatus(work,assetId,origin,catalog);
      if(catalog&&!result.states.length)await managedPreview.release(lease);
      return send(200,{...result,managed:Boolean(catalog&&result.states.length)});
     }
    }
    if(draftRoute&&req.method==='POST')return send(200,await saveDraft(work,draftRoute[1],JSON.parse(data)));
    if(p==='/api/undo'&&req.method==='POST')return send(200,await applyUndo(work,JSON.parse(data)));
    // Cache writes and read-only curve reads skip the mutation queue so
    // thumbnails never wait behind character assembly or task commits.
    const thumbnailKey=p.match(/^\/api\/thumbnails\/([a-z0-9-]+)$/);
    if(thumbnailKey&&req.method==='POST')return send(200,await saveThumbnail(work,thumbnailKey[1],data));
    if(p==='/api/actions/curves'&&req.method==='POST')return send(200,await characterActionCurves(work,JSON.parse(data)));
    if(p==='/api/actions/foot-diagnostics'&&req.method==='POST')return send(200,await diagnoseFootSlip(work,JSON.parse(data)));
    if(p==='/api/actions/preview'&&req.method==='POST')return send(200,await previewCharacterAction(work,JSON.parse(data)));
    if(p==='/api/actions/replacement-preview'&&req.method==='POST')return send(200,await previewReplacement(work,JSON.parse(data)));
    if(p==='/api/actions/replace'&&req.method==='POST')return send(200,await replaceAction(work,JSON.parse(data)));
    if(p==='/api/actions/replacement-withdraw'&&req.method==='POST')return send(200,await withdrawReplacementPlan(work,JSON.parse(data)));
    if(p==='/api/actions/replacement-handoff'&&req.method==='POST')return send(200,await replacementHandoff(work,JSON.parse(data).ids));
    if(p.startsWith('/api/motions/')&&req.method==='POST'){const action=p.slice('/api/motions/'.length),input=JSON.parse(data),fn={register:registerMotionPack,mapping:saveMotionMapping,rigs:motionRigOptions,preview:previewMotion,adopt:adoptMotion,remove:removeMotion,prepare:materializeMotion}[action];if(fn)return send(200,await fn(work,input));}
    if(p==='/api/catalog/scan'&&req.method==='POST')return send(200,await startCatalogScan(work,{force:true}));
    const modelName=p.match(/^\/api\/models\/([a-zA-Z0-9_-]{1,80})\/name$/);if(modelName&&req.method==='POST')return send(200,await withWorkspaceLock(work,async()=>{const input=JSON.parse(data),cfg=await readProject(work),m=cfg.models[modelName[1]];if(!m||typeof input.name!=='string'||!input.name.trim()||input.name.length>160)throw Error('模型名称需为 1–160 个字符');if(input.expectedHeadRevision!==m.headRevision||input.expectedName!==m.name)throw Error('模型版本已变化，请刷新后重试');m.name=input.name.trim();cfg.revision=(cfg.revision||0)+1;await atomic(await inside(work,'project.json'),cfg);return {project:projectView(cfg,m.id)};}));
    const storedOpen=p.match(/^\/api\/models\/([a-zA-Z0-9_-]{1,80})\/open$/);if(storedOpen&&req.method==='POST')return send(200,{project:await activateModel(work,storedOpen[1])});
    const modelOpen=p.match(/^\/api\/catalog\/([a-zA-Z0-9_-]{1,80})\/open$/);
    if(modelOpen&&req.method==='POST')return send(200,{project:await openCatalogAsset(work,modelOpen[1],JSON.parse(data.length?data:'{}'))});
    if(p==='/api/characters/map'&&req.method==='POST')return send(200,await saveCharacterMap(work,JSON.parse(data)));
    const characterAction=p.match(/^\/api\/characters\/([a-zA-Z0-9_-]{1,80})\/(open|associate)$/);
    if(characterAction&&req.method==='POST'){const input=JSON.parse(data.length?data:'{}');return send(200,characterAction[2]==='open'?{project:await openCharacter(work,characterAction[1],input)}:await associateCharacterMotion(work,characterAction[1],input));}
    if(p==='/api/project/reveal'&&req.method==='POST')return send(200,await revealWorkspace(work));
    if(p==='/api/project/select-folder'&&req.method==='POST')return send(200,await (options.chooseFolder||chooseProjectFolder)());
    if(p==='/api/project/preview'&&req.method==='POST')return send(200,await previewProjectContext(work,JSON.parse(data)));
    if(p==='/api/project/open'&&req.method==='POST'){
     const input=JSON.parse(data),result=await prepareProject(work,input.path,{adoptCurrent:input.adoptCurrent!==false,settingsPath:options.settingsPath});
     const key=await realpath(result.workspace);let target=workspaceServers.get(JSON.stringify([key,callerKey(caller)]));
     if(!target||!target.listening){target=await serve(key,0,options);children.add(target);}
     return send(200,{...result,url:'http://127.0.0.1:'+target.address().port+'/'});
    }
    if(p==='/api/jobs'&&req.method==='POST')return send(200,await createJob(work,{...JSON.parse(data),caller}));
    const lifecycle=p.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(retry|restore|interrupt)$/);
    if(lifecycle&&req.method==='POST'){const input=data.length?JSON.parse(data):{};return send(200,await (lifecycle[2]==='retry'?retryJob(work,lifecycle[1]):lifecycle[2]==='restore'?restoreJob(work,lifecycle[1],input):interruptJob(work,lifecycle[1])));}
    const jm=p.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(cancel|local-edit|review|reply|progress)$/);
    if(jm&&req.method==='POST'){const options=data.length?JSON.parse(data):{};return send(200,await (jm[2]==='cancel'?cancelJob(work,jm[1]):jm[2]==='reply'?replyJob(work,jm[1],options):jm[2]==='progress'?updateJobProgress(work,jm[1],options):jm[2]==='review'?reviewJob(work,jm[1],options):localEditJob(work,jm[1],options)));}
    if(p==='/api/agent/connect'&&req.method==='POST'){
     const input=JSON.parse(data);providerInfo(input.provider);const provider=input.provider;
     if(connecting){
      if(connecting.provider!==provider)throw Error('另一个执行器正在连接，请稍后重试');
      return send(200,await connecting.pending);
     }
     if(agent.active&&agent.provider===provider)return send(200,agent);
     ensureAgentIdle();
     const previousGeneration=workerGeneration;
     const pending=(async()=>{
      const module=options.agentWorker||await import('./agent-worker.mjs');
      const probe=provider==='codex'?await module.probeCodex():await (options.probeProvider||probeProvider)(provider);
      if(previousGeneration!==workerGeneration)return agent;
      if(!probe.available)throw Error(probe.error||'本机无法连接 '+providerInfo(provider).label);
      // The old worker may have started claiming a task during the probe.
      ensureAgentIdle();
      const generation=++workerGeneration,previousRun=workerRun;
      workerAbort?.abort();
      workerAbort=new AbortController();updateAgent({connected:true,active:true,state:'connected',provider,error:null});
      const signal=workerAbort.signal;
      workerRun=Promise.resolve(previousRun).then(()=>{if(generation!==workerGeneration)return;return module.startWorker(work,{signal,provider,onState:state=>{if(generation!==workerGeneration)return;updateAgent({...agent,...state,connected:!['failed','disconnected'].includes(state.state),active:state.state!=='disconnected'});}});}).then(()=>{if(generation!==workerGeneration)return;updateAgent({...agent,connected:false,active:false,state:'disconnected'});}).catch(e=>{if(generation!==workerGeneration)return;updateAgent({...agent,connected:false,active:false,state:'failed',error:e.message});});
      return agent;
     })();
     const connection={provider,pending};
     connecting=connection;try{return send(200,await pending);}finally{if(connecting===connection)connecting=null;}
    }
    if(p==='/api/agent/disconnect'&&req.method==='POST'){
     workerGeneration++;connecting=null;workerAbort?.abort();
     const jobId=agent.jobId,disconnected={...agent,connected:false,active:false,state:'disconnected',jobId:null,activity:null,startedAt:null};
     updateAgent(disconnected);
     if(jobId){try{await interruptJob(work,jobId);}catch{}}
     return send(200,disconnected);
    }
    if(p.startsWith('/api/assets/')&&req.method==='POST'){
     const cfg=await readProject(work),assetId=url.searchParams.get('assetId')||cfg.activeAssetId;
     return send(200,await importBytes(work,p.split('/').pop(),data,url.searchParams.get('name')||'model.glb',{assetId,newModel:url.searchParams.get('newModel')==='true',protectActive:true}));
    }
    const op=async()=>{
     if(p==='/api/marks'&&req.method==='POST'){
      const input=JSON.parse(data),cfg=projectView(await readProject(work),input.context?.assetId||undefined),slot=input.displayMode==='all'?'baseline':'candidate',active=cfg.slots[slot];
      if(!['all','comparison'].includes(input.displayMode)||!['','fix','review','want'].includes(input.verdict)||!['','candidate','original'].includes(input.choice)||typeof input.note!=='string'||input.note.length>8000)throw Error('动作标记格式无效');
      if(input.asset?.sha256!==active.sha256||input.asset?.file!==active.file||!hasClip(active,input.clip))throw Error('动作版本已切换，请刷新');
      if(input.displayMode==='comparison'&&(input.reference?.sha256!==cfg.slots.baseline.sha256||input.reference?.file!==cfg.slots.baseline.file||!hasClip(cfg.slots.baseline,input.reference.clip)))throw Error('对照版本已切换');
      const context=input.context;
      if(!context||!Number.isFinite(context.time)||context.time<0||!['elapsed','progress'].includes(context.mode)||typeof context.rootLocked!=='boolean')throw Error('缺少标记时的播放上下文');
      for(const s of ['baseline','candidate']){const a=context.slots?.[s],current=cfg.slots[s];if(!a||a.sha256!==current.sha256||a.file!==current.file||!hasClip(current,a.clip,a.time))throw Error('标记上下文不属于当前版本');}
      const reference=input.displayMode==='comparison'?{sha256:cfg.slots.baseline.sha256,file:cfg.slots.baseline.file,clip:input.reference.clip}:null;
      const identity={assetId:input.context?.assetId||active.assetId||'legacy',displayMode:input.displayMode,sha256:active.sha256,clip:input.clip,reference:reference?{sha256:reference.sha256,clip:reference.clip}:null},key=sha(Buffer.from(JSON.stringify(identity)));
      const db=await readMarks(work),previous=db.reviews[key],review={...identity,asset:{sha256:active.sha256,file:active.file,label:active.label},reference,verdict:input.verdict,choice:input.choice,note:input.note,context,updatedAt:new Date().toISOString()};
      review.history=[...(previous?.history||[]),{verdict:review.verdict,choice:review.choice,note:review.note,context,at:review.updatedAt}];
      db.reviews[key]=review;await atomic(await inside(work,'marks.json'),db);return{key,review};
     }
     if(p==='/api/notes'&&req.method==='POST'){
      const input=JSON.parse(data),cfg=projectView(await readProject(work),input.assetId||input.comparison?.assetId||undefined),active=cfg.slots[input.slot];
      validateNote(input);if(!active||input.asset.sha256!==active.sha256||input.asset.file!==active.file)throw Error('资产已切换，请刷新后重新定位');
      if(!hasClip(active,input.clip,input.time))throw Error('动作或时间无效');
      const db=await json(await inside(work,'feedback.json'));if(db.notes.some(x=>x.id===input.id))throw Error('反馈 ID 已存在');
      if(input.comparison){for(const slot of ['baseline','candidate']){const c=input.comparison.slots?.[slot],current=cfg.slots[slot];if(!c||c.sha256!==current.sha256||!hasClip(current,c.clip,c.time))throw Error('对比上下文已变化，请刷新');}}
      const note={id:input.id,assetId:active.assetId||'legacy',slot:input.slot,asset:{sha256:active.sha256,file:active.file,label:active.label},clip:input.clip,time:input.time,frame:input.frame,fps:input.fps,view:input.view,camera:input.camera,comparison:input.comparison,observed:input.observed,expected:input.expected,acceptance:input.acceptance,preserve:input.preserve||'',reference:input.reference||'',hypothesis:input.hypothesis||'',status:'open',decision:null,createdAt:new Date().toISOString()};
      db.notes.push(note);await atomic(await inside(work,'feedback.json'),db);return note;
     }
     if(/^\/api\/notes\/[-a-zA-Z0-9_]+$/.test(p)&&req.method==='PATCH'){
      const update=JSON.parse(data),db=await json(await inside(work,'feedback.json')),n=db.notes.find(x=>x.id===p.split('/').pop());if(!n)throw Error('反馈不存在');
      if(!['keep-baseline','accept-candidate','revise'].includes(update.decision)||typeof update.outcome!=='string'||!update.outcome.trim()||update.outcome.length>8000)throw Error('请选择决定并填写验收说明');
      const cfg=await readProject(work);if(update.decision==='accept-candidate'&&!cfg.slots.candidate)throw Error('尚未载入候选');
      n.decision=update.decision;n.outcome=update.outcome;n.status=update.decision==='revise'?'open':'resolved';n.reviewedAssets=structuredClone(cfg.slots);n.updatedAt=new Date().toISOString();(n.reviews??=[]).push({decision:n.decision,outcome:n.outcome,assets:n.reviewedAssets,at:n.updatedAt});validateNote(n);await atomic(await inside(work,'feedback.json'),db);return n;
     }
     if(/^\/api\/snapshots\/[-a-zA-Z0-9_]+$/.test(p)&&req.method==='POST'){
      if(data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('需要 PNG 截图');
      const db=await json(await inside(work,'feedback.json')),n=db.notes.find(x=>x.id===p.split('/').pop());if(!n)throw Error('先保存反馈');
      const file='snapshots/'+n.id+'-'+Date.now()+'.png';await atomic(await inside(work,file),data);n.snapshot=file;await atomic(await inside(work,'feedback.json'),db);return{file};
     }
     throw Error('未知接口');
    };
    const task=queue.then(()=>withWorkspaceLock(work,op));queue=task.catch(()=>{});return send(200,await task);
   }
   if(req.method!=='GET'&&req.method!=='HEAD')return send(405,{error:'Method not allowed'});
   const appearance=p.match(/^\/appearance\/([a-f0-9]{64})\/(.+)$/);
   if(appearance){const bytes=await appearanceFile(work,appearance[1],appearance[2]);res.writeHead(200,{'Content-Type':MIME[extname(appearance[2])]||'application/javascript','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(req.method==='HEAD'?undefined:bytes);}
   let root,name;
   if(p==='/'||p==='/index.html'){root=ROOT+'/assets/viewer';name='index.html';}
   else if(p.startsWith('/viewer/')){root=ROOT+'/assets/viewer';name=p.slice(8);}
   else if(p.startsWith('/vendor/')){root=ROOT+'/assets/vendor';name=p.slice(8);}
   else if(p.startsWith('/case/')){root=ROOT+'/assets/case';name=p.slice(6);}
   else if(p.startsWith('/workspace/assets/')){root=work;name=p.slice(11);if(!/^assets\/[a-f0-9]{64}\.glb$/.test(name))return send(404,{error:'Not found'});}
   else if(/^\/workspace\/jobs\/[a-f0-9-]{36}\/view\.png$/.test(p)){root=work;name=p.slice(11);}
   else if(p.startsWith('/workspace/snapshots/')){root=work;name=p.slice(11);if(!/^snapshots\/[-\w]+\.png$/.test(name))return send(404,{error:'Not found'});}
   else if(p.startsWith('/workspace/thumbnails/')){root=work;name=thumbnailPath(p);if(!name)return send(404,{error:'Not found'});}
   else return send(404,{error:'Not found'});
   const file=await inside(root,name),s=await stat(file);if(!s.isFile())return send(404,{error:'Not found'});
   const immutable=name.startsWith('cache/thumbnails/')||name.startsWith('assets/');
   res.writeHead(200,{'Content-Type':MIME[extname(file)]||'application/octet-stream','Content-Length':s.size,'Cache-Control':immutable?'private, max-age=31536000, immutable':'no-store','X-Content-Type-Options':'nosniff'});
   if(req.method==='HEAD')return res.end();
   const stream=createReadStream(file);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
  }catch(e){if(!res.headersSent)send(e.code==='ENOENT'?404:['MODEL_JOB_ACTIVE','AGENT_BUSY'].includes(e.code)?409:400,{error:e.message,...(e.code?{code:e.code}:{}),...(e.jobId?{jobId:e.jobId}:{})});else res.end();}
 });
 server.once('close',()=>{if(workspaceServers.get(serverKey)===server)workspaceServers.delete(serverKey);serverCloseCleanup();});
 const close=server.close.bind(server);server.close=callback=>{studioEvents.close();workerGeneration++;connecting=null;workerAbort?.abort();Promise.all([workerRun,managedPreview.close(),stopCharacterActionDiscovery(work),stopCatalogScan(work),...[...children].filter(c=>c.listening).map(c=>new Promise(r=>c.close(r)))]).catch(()=>{}).finally(()=>close(callback));return server;};
 try{await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});}
 catch(error){throw Object.assign(Error(error.code==='EADDRINUSE'?'本地服务端口已被占用，请关闭旧服务或使用 --port 0 自动选择端口。':'本地服务无法启动，请检查本机网络权限后重试。',{cause:error}),{code:error.code});}
 runtime.server={status:'ready',host:'127.0.0.1',port:server.address().port};workspaceServers.set(serverKey,server);
 await startCatalogScan(work,{force:true}).catch(()=>{});return server;
}
