import {createServer} from 'node:http';
import {readFile,stat,realpath} from 'node:fs/promises';
import {extname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ROOT,json,inside,atomic,validateNote,importAsset,readMarks,sha,withWorkspaceLock,hasClip,readProject,projectView,modelSlots} from './core.mjs';
import {catalogPage,startCatalogScan,openCatalogAsset,stopCatalogScan} from './asset-catalog.mjs';
import {characterPage,openCharacter,associateCharacterMotion,saveCharacterMap} from './character-library.mjs';
import {listJobs,getJob,createJob,cancelJob,localEditJob,reviewJob,inspectSlot,importBytes,replyJob,updateJobProgress,getJobProjectContext,previewProjectContext} from './jobs.mjs';
import {projectStatus,prepareProject,chooseProjectFolder,revealWorkspace} from './project-workspaces.mjs';
import {diagnoseRuntime} from './runtime-diagnostics.mjs';
import {appearanceStatus,appearanceFile} from './project-appearance.mjs';

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.glb':'model/gltf-binary','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4','.md':'text/plain; charset=utf-8'};
const workspaceServers=new Map();
async function body(req,limit){let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>limit)throw Error('文件过大');chunks.push(b);}return Buffer.concat(chunks);}
export async function serve(work,port=5178,options={}){
 work=await realpath(work);const children=new Set();
 let serverCloseCleanup=()=>{};
 const diagnose=options.diagnoseRuntime||diagnoseRuntime;
 let runtime=await diagnose({workspace:work,programs:[]});
 if(!runtime.node.supported)throw Error('需要 Node.js 22 或更高版本。请升级 Node.js 后重新启动工作台。');
 if(runtime.workspace.status!=='ready')throw Error(runtime.workspace.error||'工作区不可读写，请选择本机可写目录。');
 await readProject(work);
 const token=randomBytes(24).toString('hex');let queue=Promise.resolve();
 let agent={connected:false,active:false,state:'disconnected',provider:'codex',error:null},workerAbort=null,workerGeneration=0;
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
   if(p==='/api/session'&&req.method==='GET')return send(200,{token,paths:{workspace:work,cli:ROOT+'/scripts/motion-feedback.mjs'},project:projectView(await readProject(work),url.searchParams.get('assetId')||undefined),feedback:await json(await inside(work,'feedback.json')),marks:await readMarks(work)});
   if(p==='/api/doctor'&&req.method==='GET')return send(200,url.searchParams.get('cached')==='1'?runtime:await recheck());
   if(p==='/api/catalog'&&req.method==='GET')return send(200,await catalogPage(work,Object.fromEntries(url.searchParams)));
   if(p==='/api/characters'&&req.method==='GET')return send(200,await characterPage(work,Object.fromEntries(url.searchParams)));
   if(p==='/api/appearance'&&req.method==='GET')return send(200,await appearanceStatus(work,url.searchParams.get('assetId')||undefined));
   if(p==='/api/project'&&req.method==='GET')return send(200,await projectStatus(work,options));
   const pc=p.match(/^\/api\/jobs\/([a-f0-9-]{36})\/project-context$/);if(pc&&req.method==='GET')return send(200,await getJobProjectContext(work,pc[1]));
   if(p==='/api/studio'&&req.method==='GET'){const capabilities=await getCaps();return send(200,await withWorkspaceLock(work,async()=>({version:2,project:projectView(await readProject(work),url.searchParams.get('assetId')||undefined),jobs:await listJobs(work),capabilities,agent:{...agent,lastError:agent.error}})));}
   if(p==='/api/jobs'&&req.method==='GET')return send(200,{jobs:await listJobs(work)});
   if(/^\/api\/jobs\/[a-f0-9-]{36}$/.test(p)&&req.method==='GET')return send(200,await getJob(work,p.split('/').pop()));
   if(p==='/api/inspect'&&req.method==='GET')return send(200,await inspectSlot(work,url.searchParams.get('slot')||'baseline',url.searchParams.get('assetId')||undefined));
   if(p==='/api/feedback'&&req.method==='GET')return send(200,await json(await inside(work,'feedback.json')));
   if(p==='/api/export'&&req.method==='GET')return send(200,{...await json(await inside(work,'feedback.json')),marks:Object.values((await readMarks(work)).reviews),jobs:await listJobs(work),version:2});
   if(p.startsWith('/api/')&&req.method!=='GET'){
    if(req.headers['x-motion-token']!==token)return send(403,{error:'请刷新页面后重试'});
    const data=await body(req,p.startsWith('/api/assets/')?200*1024*1024:12*1024*1024);
    if(p==='/api/catalog/scan'&&req.method==='POST')return send(200,await startCatalogScan(work,{force:true}));
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
     const key=await realpath(result.workspace);let target=workspaceServers.get(key);
     if(!target||!target.listening){target=await serve(key,0,options);children.add(target);}
     return send(200,{...result,url:'http://127.0.0.1:'+target.address().port+'/'});
    }
    if(p==='/api/jobs'&&req.method==='POST')return send(200,await createJob(work,JSON.parse(data)));
    const jm=p.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(cancel|local-edit|review|reply|progress)$/);
    if(jm&&req.method==='POST'){const options=data.length?JSON.parse(data):{};return send(200,await (jm[2]==='cancel'?cancelJob(work,jm[1]):jm[2]==='reply'?replyJob(work,jm[1],options):jm[2]==='progress'?updateJobProgress(work,jm[1],options):jm[2]==='review'?reviewJob(work,jm[1],options):localEditJob(work,jm[1],options)));}
    if(p==='/api/agent/connect'&&req.method==='POST'){
     const options=JSON.parse(data);if(options.provider!=='codex')throw Error('仅支持明确连接本机 Codex；其他 Agent 可通过 MCP 或任务命令领取');
     if(agent.active)return send(200,agent);const module=await import('./agent-worker.mjs'),probe=await module.probeCodex();if(!probe.available)throw Error(probe.error||'本机未找到 Codex CLI');
     workerAbort=new AbortController();const generation=++workerGeneration;agent={connected:true,active:true,state:'connected',provider:'codex',error:null};
     module.startWorker(work,{signal:workerAbort.signal,onState:state=>{if(generation!==workerGeneration)return;agent={...agent,...state,connected:!['failed','disconnected'].includes(state.state),active:state.state!=='disconnected'};}}).then(()=>{if(generation!==workerGeneration)return;agent={...agent,connected:false,active:false,state:'disconnected'};}).catch(e=>{if(generation!==workerGeneration)return;agent={...agent,connected:false,active:false,state:'failed',error:e.message};});return send(200,agent);
    }
    if(p==='/api/agent/disconnect'&&req.method==='POST'){workerGeneration++;workerAbort?.abort();if(agent.jobId){try{await cancelJob(work,agent.jobId);}catch{}}agent={...agent,connected:false,active:false,state:'disconnected',jobId:null,activity:null,startedAt:null};return send(200,agent);}
    if(p.startsWith('/api/assets/')&&req.method==='POST'){
     const cfg=await readProject(work),assetId=url.searchParams.get('assetId')||cfg.activeAssetId;
     return send(200,await importBytes(work,p.split('/').pop(),data,url.searchParams.get('name')||'model.glb',{assetId,newModel:url.searchParams.get('newModel')==='true'}));
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
   else return send(404,{error:'Not found'});
   const file=await inside(root,name),s=await stat(file);if(!s.isFile())return send(404,{error:'Not found'});
   const bytes=await readFile(file);res.writeHead(200,{'Content-Type':MIME[extname(file)]||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(e){if(!res.headersSent)send(e.code==='ENOENT'?404:400,{error:e.message});else res.end();}
 });
 server.once('close',()=>{if(workspaceServers.get(work)===server)workspaceServers.delete(work);serverCloseCleanup();});
 const close=server.close.bind(server);server.close=callback=>{Promise.all([stopCatalogScan(work),...[...children].filter(c=>c.listening).map(c=>new Promise(r=>c.close(r)))]).catch(()=>{}).finally(()=>close(callback));return server;};
 try{await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});}
 catch(error){throw Object.assign(Error(error.code==='EADDRINUSE'?'本地服务端口已被占用，请关闭旧服务或使用 --port 0 自动选择端口。':'本地服务无法启动，请检查本机网络权限后重试。',{cause:error}),{code:error.code});}
 runtime.server={status:'ready',host:'127.0.0.1',port:server.address().port};workspaceServers.set(work,server);
 await startCatalogScan(work,{force:true}).catch(()=>{});return server;
}
