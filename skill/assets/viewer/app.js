import {findJoint,jointValue,selectedJoint,correspondingJoint} from './joint-targets.mjs';
import {createModelLoader} from './gltf-loader.mjs';
import {prepareResource,createResourcePanel} from './resource-preview.mjs';
import {resourceLabel} from './resource-capabilities.mjs';
import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {icon,decorateIcons,element as el,createActionButton} from './ui.mjs';
import {createViewState,saveViewDraft,readViewDraft} from './view-state.mjs';
import {createModelCatalog} from './model-catalog.mjs';
import {projectArray,renderProjectContext as renderContext} from './project-context-view.mjs';
import {createAssetLoader} from './asset-loader.mjs';
import {createAppearanceController,disposeAppearance,withRendererState,renderAppearance,captureResources,disposeResources} from './project-appearance.mjs';
import {createEnvironmentPanel} from './environment-view.mjs';
import {observationDuration,observationTime,planObservationRestore,restoredTransportTime,observationFrame,observationFrameOptions} from './observation-state.mjs';
import {createDemandLoop} from './render-loop.mjs';

decorateIcons();

const $=id=>document.getElementById(id),slots=['baseline','candidate'];
const state={switching:false,allJobs:[],jobCounts:{},totalJobs:0,jobsRevision:null,studioRevision:null,studioAssetId:null,historyJobs:[],historyAssetId:null,historyRevision:null,historyHasMore:false,historyTotal:0,catalog:null,initialized:false,ready:false,loading:false,playing:false,loop:true,time:0,speed:1,fps:30,display:'single',focus:'baseline',view:'front',models:{},project:null,token:null,paths:{},jobs:[],agent:null,target:null,selectedJob:null,archivedJobId:null,capturing:false,submitting:false,submissionOwner:null,panelMode:'compose',composerSource:null,comparisonPair:null,observationTransform:null,explicitCompose:false,projectLink:null,projectPreview:null,projectPreviewError:null,lineageParentJobId:null};
let renderLoop;
const viewState=createViewState(new URLSearchParams(location.search).get('asset'));
const viewPositions={front:[0,1.12,4.8],side:[4.8,1.12,0],back:[0,1.12,-4.8],top:[0,5,.001]};
const statusNames={queued:'等待 Agent',running:'正在处理',complete:'候选已就绪',failed:'处理失败','needs-input':'需要补充信息',cancelled:'已取消',stale:'版本已变化',interrupted:'执行已中断'};
const partNames={leftarm:'左上臂',rightarm:'右上臂',leftforearm:'左前臂',rightforearm:'右前臂',lefthand:'左手',righthand:'右手',leftshoulder:'左肩',rightshoulder:'右肩',leftupleg:'左大腿',rightupleg:'右大腿',leftleg:'左小腿',rightleg:'右小腿',leftfoot:'左脚',rightfoot:'右脚',lefttoebase:'左脚趾',righttoebase:'右脚趾',hips:'骨盆',pelvis:'骨盆',spine:'脊柱',spine1:'胸部',spine2:'上胸部',neck:'颈部',head:'头部',leftelbow:'左肘',rightelbow:'右肘',lefthip:'左髋',righthip:'右髋',leftknee:'左膝',rightknee:'右膝'};
function part(name){const key=name.replace(/^.*:/,'').replace(/^mixamorig/i,'').replace(/[_ .-]/g,'').toLowerCase();return partNames[key]||name;}
function semanticPart(name){const mapped=part(name);if(mapped!==name)return mapped;const finger=name.match(/(left|right).*hand.*(thumb|index|middle|ring|pinky)/i);if(finger)return(finger[1].toLowerCase()==='left'?'左手':'右手')+({thumb:'拇指',index:'食指',middle:'中指',ring:'无名指',pinky:'小指'}[finger[2].toLowerCase()]);return null;}
function activeSlot(){return state.display==='single'?state.focus:'candidate';}
function activeModel(){return state.models[activeSlot()]||state.models.baseline;}
function duration(){return observationDuration(state.models,state.display,state.focus);}
function localTime(slot){return observationTime(state.models,slot,state.time,{display:state.display,focus:state.focus,mode:$('progress').checked?'progress':'elapsed'});}
let toastTimer;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function notice(message,error=false){$('notice').textContent=message;$('notice').hidden=!message;$('notice').classList.toggle('error',error);}
function fail(e,fatal=false){const message=e?.message||String(e);notice(message,true);if(fatal){$('errorMessage').textContent=message;$('stageError').hidden=false;$('stageLoading').hidden=true;}console.error(e);}
async function api(path,method='GET',body,request={}){if(method==='GET'&&['/api/session','/api/studio'].includes(path)){const params=new URLSearchParams(),id=request.assetId??state.project?.activeAssetId??new URLSearchParams(location.search).get('asset');if(id)params.set('assetId',id);if(request.compact){params.set('compact','1');if(request.since)params.set('since',request.since);if(state.selectedJob)params.set('jobId',state.selectedJob);}if(params.size)path+='?'+params;}const response=await fetch(path,{method,signal:request.signal,headers:method==='GET'?{}:{'x-motion-token':state.token,'Content-Type':body instanceof Blob?'application/octet-stream':'application/json'},body:body===undefined?undefined:body instanceof Blob?body:JSON.stringify(body)});let data;try{data=await response.json();}catch{throw Error('工作台服务没有返回有效结果，请检查服务是否仍在运行。');}if(!response.ok)throw Error(data.error||'请求失败（'+response.status+'）');return data;}
const environmentPanel=createEnvironmentPanel({button:$('openEnvironment'),dialog:$('environmentDialog'),body:$('environmentResults'),recheck:$('recheckEnvironment'),close:$('closeEnvironment'),reload:$('reloadEnvironment'),loadReport:refresh=>api('/api/doctor'+(refresh?'':'?cached=1'))});
const appearance=createAppearanceController({revision:T.REVISION,runCreate:(fn,ctx)=>withRendererState(renderer,T,()=>fn(ctx)),loadStatus:id=>api('/api/appearance?assetId='+encodeURIComponent(id||''),'GET',undefined,{signal:AbortSignal.timeout?.(5000)}),onChange:drawAppearance});
function drawAppearance({mode,descriptor,error,loading}){const select=$('appearanceMode');select.value=mode;select.querySelector('option[value="project"]').disabled=descriptor?.status!=='ready'||activeModel()?.capabilities.hasMesh===false;select.disabled=activeModel()?.capabilities.hasMesh===false||loading||state.switching||state.loading||state.capturing||state.submitting; $('appearanceStatus').textContent=error||(mode==='project'?descriptor.label+' · '+(descriptor.limitations||[]).join('；'):'中性检查 · '+(descriptor?.status==='ready'?'可切换为 '+descriptor.label:descriptor?.message||'未配置项目外观'));}
$('appearanceMode').onchange=async()=>{if(state.loading||state.switching||state.capturing||state.submitting){drawAppearance({mode:appearance.mode,descriptor:appearance.descriptor,error:appearance.error});return;}appearance.select($('appearanceMode').value);try{await refreshModels({force:true});}catch(e){fail(e);}finally{drawAppearance({mode:appearance.mode,descriptor:appearance.descriptor,error:appearance.error});}};
let appearanceRecovery=false;
function recoverAppearance(error){if(appearanceRecovery||appearance.mode!=='project')return;appearanceRecovery=true;renderLoop?.wake();appearance.fail('项目外观渲染失败，已恢复中性检查：'+error.message);}
let projectPreviewTimer,projectPreviewSeq=0,projectPreviewKey='',projectPreviewPendingKey=null,projectBusy=false,selectedProjectFolder='';
const frozenProjectSnapshots=new Map(),frozenProjectLoads=new Map();
function parentJobId(){const m=activeModel();if(activeSlot()!=='candidate'||!m)return null;const explicit=state.jobs.find(j=>j.id===state.lineageParentJobId&&j.state==='complete'&&j.candidate?.sha256===m.meta.sha256);if(explicit)return explicit.id;return [...state.jobs].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).find(j=>j.state==='complete'&&j.candidate?.sha256===m.meta.sha256)?.id||null;}
function renderProjectContext(host,payload,options={}){
 return renderContext(host,payload,{
  ...options,onLinkProject:openProjectDialog,onError:fail,describeBone:semanticPart
 });
}

function updateProjectPreview(){
 const summary=$('projectContextSummary'),host=$('projectContextBody'),identity=state.projectLink;
 if(identity?.status!=='linked'){summary.textContent='关联项目，自动找到相关素材与要求';renderProjectContext(host,null);return;}
 const p=state.projectPreview,c=p?.continuity||{},count=c.summary?.inheritedRequirementCount??projectArray(c.inheritedRequirements).length,history=c.summary?.historicalInstructionCount??projectArray(c.historicalInstructions).length,rounds=c.summary?.ancestorCount??projectArray(c.ancestry).length,active=c.summary?.activeAcceptedSha256,ambiguous=c.summary?.needsClarification;
 summary.textContent='已关联 '+identity.project.name+(state.projectPreviewPending?' · 正在匹配本次要求':p?(ambiguous?' · 需确认历史分支':' · '+(rounds?'续接 '+rounds+' 轮修改':history?'带上 '+history+' 条历史原话':'自动匹配项目资料')+(active?' · 参考已验收版本':'')):' · 自动整理本次资料');
 if(state.projectPreviewPending){host.replaceChildren(el('p','正在按当前角色与修改要求更新相关资料…'));return;}if(state.projectPreviewError){host.replaceChildren(el('p','资料预览暂未完成：'+state.projectPreviewError,'context-note'));host.append(actionButton('重新整理本次资料',()=>scheduleProjectPreview(850),'text-button'));return;}
 if(p)renderProjectContext(host,p);else{host.replaceChildren(el('p','正在按当前角色与修改要求查找相关资料…'));}
}
function scheduleProjectPreview(delay=1000){
 if(!state.ready||state.loading||state.switching||state.panelMode!=='compose'||state.projectLink?.status!=='linked')return;
 const body={assetId:state.project.activeAssetId,request:$('request').value.trim(),slot:activeSlot(),clip:activeModel()?.clip||null,target:state.target?structuredClone(state.target):null,parentJobId:parentJobId()};
 const key=JSON.stringify({...body,asset:activeModel()?.meta.sha256});if(key===projectPreviewPendingKey)return;clearTimeout(projectPreviewTimer);const seq=++projectPreviewSeq,ticket=viewState.capture();
 if(key===projectPreviewKey){projectPreviewPendingKey=null;state.projectPreviewPending=false;updateProjectPreview();return;}
 projectPreviewPendingKey=key;state.projectPreviewPending=true;state.projectPreviewError=null;updateProjectPreview();
 projectPreviewTimer=setTimeout(async()=>{try{const result=await api('/api/project/preview','POST',body);if(seq!==projectPreviewSeq||!viewState.isCurrent(ticket,body.assetId)||state.switching)return;state.projectPreview=result;state.projectPreviewError=null;projectPreviewKey=key;}catch(error){if(seq!==projectPreviewSeq||!viewState.isCurrent(ticket,body.assetId)||state.switching)return;state.projectPreviewError=error.message;}finally{if(seq===projectPreviewSeq&&viewState.isCurrent(ticket,body.assetId)&&!state.switching){projectPreviewPendingKey=null;state.projectPreviewPending=false;updateProjectPreview();}}},Math.max(850,delay));
}
function drawProjectIdentity(){const linked=state.projectLink?.status==='linked',p=state.projectLink?.project;$('projectButtonLabel').textContent=linked?p.name:'关联项目';$('projectButton').classList.toggle('linked',linked);$('projectButton').title=linked?'当前项目：'+p.name+' · '+p.root:'关联一次游戏项目，自动保存候选与相关资料';updateProjectPreview();}
async function loadProjectIdentity(){state.projectLink=await api('/api/project');drawProjectIdentity();scheduleProjectPreview();return state.projectLink;}
function projectStatus(message,error=false){$('projectLinkStatus').textContent=message;$('projectLinkStatus').hidden=!message;$('projectLinkStatus').classList.toggle('error',error);}
function drawProjectDialog(){
 const d=state.projectLink||{},linked=d.status==='linked',p=d.project,suggested=d.suggested;
 $('projectDialogTitle').textContent=linked?'当前项目与最近项目':'关联游戏项目';$('projectDialogIntro').textContent=linked?'已关联的项目会自动沿用，不需要重复选择。打开另一个项目时，会进入独立工作区，不会把这里的素材与记录混过去。':'只需关联一次。当前素材与记录会复制到项目的 .motion-studio，原文件保持。以后在这里保存候选、观察现场与验收记录。';
 $('projectCurrent').hidden=!linked;$('projectCurrent').replaceChildren();if(linked){$('projectCurrent').append(el('b','当前项目：'+p.name),el('small',p.root));const actions=el('div',undefined,'project-current-actions');actions.append(actionButton('打开记录文件夹 ↗',async()=>{try{const result=await api('/api/project/reveal','POST',{});if(!result.opened)throw Error('系统未能打开记录文件夹，请使用“复制记录路径”。');projectStatus('已在文件管理器中打开当前项目的记录文件夹。');}catch(error){projectStatus(error.message,true);}},'text-button'),actionButton('复制记录路径',()=>copyText(p.workspace),'text-button'));$('projectCurrent').append(actions);}
 const pending=state.jobs.filter(j=>['queued','running','needs-input'].includes(j.state)).length;$('projectPending').hidden=!pending;$('projectPending').textContent=linked?'这里的 '+pending+' 条待处理记录仍保留在当前项目，正在执行的任务可返回原页面查看。':'待执行或运行中的任务需先完成或停止，再复制到项目；等待补充的任务会随资料保留。';
 const showSuggestion=suggested&&(!linked||suggested.root!==p.root);$('projectSuggestion').hidden=!showSuggestion;if(showSuggestion){$('projectSuggestedName').textContent=suggested.name;$('projectSuggestedPath').textContent=suggested.root;$('useSuggestedProject').textContent=linked?'打开这个项目 →':'关联这个项目 →';}
 $('pickProjectFolder').textContent=linked?'打开其他项目文件夹…':'选择项目文件夹…';$('openProjectPath').textContent=linked?'打开项目':'关联并打开';$('confirmProjectFolder').textContent=linked?'打开这个项目 →':'关联并打开 →';
 const recent=projectArray(d.recent).filter(r=>!linked||r.root!==p.root);$('recentProjects').hidden=!recent.length;const host=$('recentProjectList');host.replaceChildren();for(const r of recent){const button=actionButton('',()=>openLinkedProject(r.root),'recent-project-button'),text=el('span');text.append(el('b',r.name),el('small',r.root));button.append(text,el('span','→'));host.append(button);}
}
async function openProjectDialog(){projectStatus('');$('projectSelection').hidden=true;selectedProjectFolder='';drawProjectDialog();$('projectDialog').showModal();try{await loadProjectIdentity();drawProjectDialog();}catch(error){projectStatus('项目状态暂未同步：'+error.message,true);}}
async function openLinkedProject(path){
 if(projectBusy)return;path=String(path||'').trim();if(!path){projectStatus('请选择项目文件夹，或粘贴完整路径。',true);return;}projectBusy=true;const buttons=[...$('projectDialog').querySelectorAll('button:not([data-close])')];buttons.forEach(b=>b.disabled=true);const adopt=state.projectLink?.status!=='linked';projectStatus(adopt?'正在关联项目并复制当前素材与记录…':'正在打开独立项目工作区…');
 try{const r=await api('/api/project/open','POST',{path,adoptCurrent:adopt});if(!r.url)throw Error('服务没有返回项目工作区地址。');location.assign(r.url);}catch(error){projectStatus(error.message,true);}finally{projectBusy=false;buttons.forEach(b=>b.disabled=false);}
}

const modelCatalog=createModelCatalog({
 api,
 getView:()=>({
  activeAssetId:state.project?.activeAssetId,
  jobs:state.allJobs,
  jobCounts:state.jobCounts,
  switching:state.switching,
  allowAutomaticOpen:!state.switching&&!state.loading&&!state.submitting&&
   !$('request').value.trim()&&!(state.totalJobs||state.allJobs.length)&&
   Boolean(activeModel()?.meta.generator?.includes('original teaching'))
 }),
 onOpen:openCatalogModel,
 onChooseFolder:openProjectDialog,
 onError:fail,
 onChange:data=>{state.catalog=data;}
});
function catalogMessage(message,error=false){modelCatalog.message(message,error);}

async function restoreModelDraft(){
 const saved=readViewDraft(()=>localStorage,{workspace:state.paths.workspace,assetId:viewState.loadedAssetId,view:viewState});
 if(!saved)return;
 $('request').value=saved.request||'';$('preserve').value=saved.preserve||'';
 state.selectedJob=saved.selectedJob||null;state.panelMode=saved.panelMode||'compose';state.comparisonPair=saved.comparisonPair||null;state.composerSource=saved.composerSource||null;state.lineageParentJobId=saved.lineageParentJobId||null;
 state.explicitCompose=state.panelMode==='compose'&&Boolean(saved.request?.trim()||saved.composerIntent);
 if(saved.context?.asset?.sha256===state.models[saved.context.slot||'baseline']?.meta.sha256)await restoreContext(saved.context);
}
async function openCatalogModel(id,{refreshSource=false,character=false}={}){
 if(state.switching||state.loading||state.capturing||state.submitting)return;
 persistView();const previousProject=state.project,previousURL=location.href,ticket=viewState.select(id);let ownerTicket=ticket;state.switching=true;state.playing=false;
 const row=state.catalog?.entries.find(e=>e.id===id);
 catalogMessage(row?.format==='fbx'?'正在准备角色；首次打开需要用本机 Blender 转换…':'正在打开角色…');
 $('modelList').setAttribute('aria-busy','true');
 try{
  const result=await api((character?'/api/characters/':'/api/catalog/')+encodeURIComponent(id)+'/open','POST',{refreshSource});if(!result.project?.activeAssetId)throw Error('服务未返回模型身份，请刷新后重试。');if(!viewState.isCurrent(ticket,result.project?.activeAssetId))return;
  clearTimeout(projectPreviewTimer);projectPreviewSeq++;state.projectPreview=null;projectPreviewKey='';
  state.project=result.project;history.replaceState(null,'','?asset='+encodeURIComponent(id));
  state.target=null;state.selectedJob=null;state.archivedJobId=null;state.panelMode='compose';state.explicitCompose=false;state.composerSource=null;state.comparisonPair=null;state.lineageParentJobId=null;state.time=0;state.focus='baseline';state.display='single';state.jobs=[];
  $('request').value='';$('preserve').value='';$('scopeMode').value='whole';$('scopeInputs').hidden=true;
  if(!await refreshModels({preserve:false,selectionTicket:ticket})||!viewState.isCurrent(ticket,id))return;await restoreModelDraft();if(!viewState.isCurrent(ticket,id))return;clearTarget();
  state.switching=false;await pollStudio();if(!viewState.isCurrent(ticket,id))return;jobsRenderSignature='';drawJobs();drawMetadata();
  await refreshCatalog();if(!viewState.isCurrent(ticket,id))return;$('modelCatalogDialog').close();notice('');
  toast(refreshSource?'已打开源文件的新版本。之前的候选和任务仍在修改记录中。':'已打开 '+(row?.name||'角色')+'，可继续检查。');
 }catch(e){if(!viewState.isCurrent(ticket,id))return;ownerTicket=viewState.select(previousProject?.activeAssetId);state.project=previousProject;history.replaceState(null,'',previousURL);try{await refreshModels({preserve:false,selectionTicket:ownerTicket});await restoreModelDraft();}catch{}drawCatalog();catalogMessage('打开未完成：'+e.message,true);throw e;}
 finally{if(viewState.isCurrent(ownerTicket)){state.switching=false;$('modelList').removeAttribute('aria-busy');drawMetadata();}}
}
function drawCatalog(){modelCatalog.draw();}
function refreshCatalog(options){return modelCatalog.refresh(options);}

async function ensureFrozenProjectSnapshot(job){
 if(frozenProjectSnapshots.has(job.id)||frozenProjectLoads.has(job.id))return;
 const promise=api('/api/jobs/'+encodeURIComponent(job.id)+'/project-context').then(data=>frozenProjectSnapshots.set(job.id,{data})).catch(error=>frozenProjectSnapshots.set(job.id,{error:error.message})).finally(()=>{frozenProjectLoads.delete(job.id);if(state.panelMode==='task'&&currentJob()?.id===job.id){jobsRenderSignature='';drawJobs();}});frozenProjectLoads.set(job.id,promise);return promise;
}
function frozenProjectDetails(job,disclosures){const d=el('details');d.dataset.disclosure='project';d.open=disclosures.get('project')||false;d.append(el('summary','本次项目资料与沿用要求'));const body=el('div',undefined,'project-context-content');const cached=frozenProjectSnapshots.get(job.id);if(cached?.data)renderProjectContext(body,cached.data,{frozen:true});else if(cached?.error)body.append(el('p','本次任务资料暂未读出：'+cached.error,'context-note'));else body.append(el('p','展开后查看这条任务提交时保存的相关资料。'));d.append(body);d.ontoggle=()=>{if(d.open&&!frozenProjectSnapshots.has(job.id)){body.replaceChildren(el('p','正在读取本次任务保存的资料…'));ensureFrozenProjectSnapshot(job);}};if(d.open&&!cached)ensureFrozenProjectSnapshot(job);return d;}

const canvas=$('canvas');let renderer;
try{renderer=new T.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});environmentPanel.setGraphics({status:'ready'});}
catch(e){renderer=null;environmentPanel.setGraphics({status:'error',error:'WebGL2 不可用。曲线仍可查看；三维资源请开启硬件加速后重试。'});}
canvas.addEventListener('webglcontextlost',()=>environmentPanel.setGraphics({status:'error',error:'浏览器的三维上下文已丢失。等待恢复，或刷新页面重试。'}));
canvas.addEventListener('webglcontextrestored',()=>environmentPanel.setGraphics({status:'ready'}));
if(renderer){renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.NeutralToneMapping;renderer.setClearColor(0x161e2a);renderer.autoClear=false;}
const loader=createModelLoader(renderer);
const loadAsset=createAssetLoader();
const resourcePanels=Object.fromEntries(slots.map(slot=>{const panel=createResourcePanel({onChange:()=>syncCurveSelection(slot)});$('stage').append(panel.element);return [slot,panel];}));
const cameras={},controls={};let cameraBusy=false;
for(const slot of slots){const camera=new T.PerspectiveCamera(34,1,.01,1000);camera.position.set(...viewPositions.front);const ctl=new OrbitControls(camera,$('surface-'+slot));ctl.target.set(0,1,0);ctl.minDistance=.45;ctl.maxDistance=40;ctl.enableDamping=false;ctl.update();cameras[slot]=camera;controls[slot]=ctl;ctl.addEventListener('start',()=>{state.view='orbit';setViewButtons();});ctl.addEventListener('change',()=>{if(cameraBusy)return;if(!$('linkCameras').checked){render();return;}cameraBusy=true;const other=slot==='candidate'?'baseline':'candidate';cameras[other].position.copy(camera.position);cameras[other].quaternion.copy(camera.quaternion);ctl.target&&controls[other].target.copy(ctl.target);controls[other].update();cameraBusy=false;render();});}
function makeScene(){const scene=new T.Scene();scene.background=new T.Color(0x161e2a);scene.fog=new T.Fog(0x161e2a,10,26);scene.add(new T.HemisphereLight(0xeaf0fa,0x263241,1.7));const key=new T.DirectionalLight(0xfff3e4,3.2);key.position.set(2.2,4,3.5);scene.add(key);const fill=new T.DirectionalLight(0xc6defa,1.4);fill.position.set(-3,2,-1);scene.add(fill);const rim=new T.DirectionalLight(0xdde8ff,1.7);rim.position.set(1,3,-4);scene.add(rim);
const floor=new T.Mesh(new T.PlaneGeometry(80,80),new T.MeshStandardMaterial({color:0x1b2533,roughness:.95,metalness:.08}));floor.rotation.x=-Math.PI/2;floor.position.y=-.012;scene.add(floor);
const grid=new T.GridHelper(40,80,0x4c607e,0x33445d);grid.material.transparent=true;grid.material.opacity=.24;grid.position.y=-.009;scene.add(grid);
const ring=new T.Mesh(new T.RingGeometry(.73,.734,100),new T.MeshBasicMaterial({color:0x849dbb,transparent:true,opacity:.28,side:T.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=-.005;scene.add(ring);
const shadow=new T.Mesh(new T.CircleGeometry(.65,64),new T.MeshBasicMaterial({color:0x080e18,transparent:true,opacity:.22,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.scale.set(1,.58,1);shadow.position.y=-.003;scene.add(shadow);
return{scene,environment:[floor,grid,ring,shadow]};}
function dispose(m){if(!m)return;m.mixer?.stopAllAction();m.mixer?.uncacheRoot(m.root);const resources=captureResources(m.scene,m.inputResources);for(const material of m.ghostMaterials||[])resources.materials.add(material);disposeAppearance(m);disposeResources(resources);}
function timeModel(m,time){m.holder.position.copy(m.offset);if(m.action){m.action.reset().play();m.mixer.setTime(time);}m.scene.updateMatrixWorld(true);}
function normalize(m,frame=observationFrame(m.bbox,$('scaleMode').value)){
 m.frame=frame;m.factor=frame.factor;m.holder.scale.setScalar(frame.factor);m.offset.fromArray(frame.offset);timeModel(m,0);m.anchor=m.hip.getWorldPosition(new T.Vector3());m.poseStamp=null;
 if(m.scene.fog===m.inspectionFog){m.inspectionFog.near=10*frame.distanceScale;m.inspectionFog.far=26*frame.distanceScale;}
 if(m.appearanceContext)Object.assign(m.appearanceContext.normalization,{scale:m.factor,restOffset:m.offset.toArray(),sourceHeight:m.height});
}
function recordedFrame(source){
 const recorded=state.observationTransform;
 return source&&recorded?.sha256===source.meta.sha256&&recorded.assetId===(source.meta.assetId||state.project?.activeAssetId)?recorded:null;
}
function pairFrame(models=state.models,options=null){
 const source=models.baseline||models.candidate;if(!source)return null;
 return observationFrame(source.bbox,options?.scaleMode||$('scaleMode').value,options?options.normalization:recordedFrame(source));
}
function normalizePair(models=state.models,options=null){
 const frame=pairFrame(models,options);if(frame)for(const m of Object.values(models))if(m)normalize(m,frame);
}

async function loadSlot(slot,overrideMeta,{commit=true}={}){let gltf,createdScene;try{
 const meta=overrideMeta||state.project.slots[slot];if(!meta)return;gltf=await loadAsset(meta,loader);
 const resource=await prepareResource(gltf,T),{root,capabilities,meshes,joints,bbox,height}=resource;
 createdScene=root;
 if(!renderer&&['model','skeleton','nodes'].includes(capabilities.preview))throw Error('此资源需要 WebGL2 三维预览。请开启浏览器硬件加速后重试；已有版本保持。');
 const {scene,environment}=makeScene();createdScene=scene;const holder=new T.Group();holder.add(root);scene.add(holder);
 const hip=joints.find(o=>/hips|pelvis/i.test(o.name))||root;
 const lines=new T.LineSegments(new T.BufferGeometry(),new T.LineBasicMaterial({color:slot==='baseline'?0x8bbccb:0xd6bd8f,transparent:true,opacity:.85,depthTest:false}));lines.renderOrder=50;scene.add(lines);
 const points=new T.Points(new T.BufferGeometry(),new T.PointsMaterial({color:0xbed6ff,size:.06,sizeAttenuation:true,depthTest:false}));points.renderOrder=51;scene.add(points);const nodeAxes=new T.AxesHelper(.16);nodeAxes.material.depthTest=false;nodeAxes.renderOrder=52;scene.add(nodeAxes);
 const marker=new T.Mesh(new T.SphereGeometry(.025,16,12),new T.MeshBasicMaterial({color:0xf0d6a6,depthTest:false}));marker.renderOrder=100;marker.visible=false;scene.add(marker);
 const m={...resource,scene,inspectionFog:scene.fog,environment,holder,meta,hip,lines,points,nodeAxes,jointSet:new Set(joints),marker,mixer:new T.AnimationMixer(root),clip:null,action:null,duration:0,center:bbox.getCenter(new T.Vector3()),minY:bbox.min.y,offset:new T.Vector3(),anchor:new T.Vector3(),parser:gltf.parser,ghostMaterials:[],originalMaterials:new Map()};
 normalize(m);m.inputResources=captureResources(scene);m.appearanceContext={THREE:T,root,scene,camera:cameras[slot],renderer,slot,environment,normalization:{scale:m.factor,sourceHeight:m.height}};if(commit)commitModel(slot,m);return m;
 }catch(e){if(createdScene||gltf?.scene)dispose({scene:createdScene||gltf.scene});throw e;}}

function commitModel(slot,m){const previous=state.models[slot]?.clip;dispose(state.models[slot]);state.models[slot]=m;selectClip(slot,m.clips.some(c=>c.name===previous)?previous:m.clips[0]?.name);}
async function loadPair(wanted,force=false,isCurrent=()=>true,frameOptions=null){
 const selected=slots.filter(s=>wanted[s]&&(force||frameOptions&&appearance.mode==='project'||!state.models[s]||state.models[s].meta.sha256!==wanted[s].sha256||state.models[s].meta.assetId!==wanted[s].assetId));
 const results=await Promise.allSettled(selected.map(s=>loadSlot(s,wanted[s],{commit:false})));
 const release=()=>{for(const r of results)if(r.status==='fulfilled')dispose(r.value);};
 if(!isCurrent()){release();return false;}
 const failed=results.find(r=>r.status==='rejected');if(failed){release();throw failed.reason;}
 if(selected.length){
  const prepared=results.map(r=>r.value),pair=Object.fromEntries(slots.filter(s=>wanted[s]).map(s=>[s,prepared[selected.indexOf(s)]||state.models[s]])),frame=pairFrame(pair,frameOptions);
  for(const m of prepared)if(frame)normalize(m,frame);
  if(appearance.mode==='project'&&prepared.some(m=>!m.capabilities.hasMesh))appearance.fail('当前资源没有网格，使用资源检查预览。');
  const status=await appearance.prepare(prepared,isCurrent);if(!isCurrent()){release();return false;}
  if(status==='retired'||status==='fallback'){release();return loadPair(wanted,true,isCurrent,frameOptions);}
  if(appearance.mode==='project'){try{for(const m of prepared)withRendererState(renderer,T,()=>{const previous=renderer.debug.onShaderError;try{renderer.debug.onShaderError=()=>{throw Error('项目角色着色器编译失败');};renderer.compile(m.scene,m.appearanceContext.camera);}finally{renderer.debug.onShaderError=previous;}});}catch(e){release();appearance.fail('项目外观不可用，已恢复中性检查：'+e.message);return loadPair(wanted,true,isCurrent,frameOptions);}}
 }
 results.forEach((r,i)=>commitModel(selected[i],r.value));
 for(const s of slots)if(wanted[s]&&state.models[s])state.models[s].meta=wanted[s];
 for(const s of slots)if(!wanted[s]&&state.models[s]){dispose(state.models[s]);delete state.models[s];}
 normalizePair(state.models,frameOptions);return true;
}
function selectClip(slot,name){const m=state.models[slot];if(!m)return;m.poseStamp=null;m.mixer.stopAllAction();const clip=m.clips.find(c=>c.name===name);m.clip=clip?.name||null;m.duration=clip?.duration||0;m.action=clip?.tracks.length?m.mixer.clipAction(clip):null;if(m.action){m.action.setLoop(T.LoopOnce,1);m.action.clampWhenFinished=true;m.action.play();}timeModel(m,0);m.anchor=m.hip.getWorldPosition(new T.Vector3());}
function pose(){for(const slot of slots){const m=state.models[slot];if(!m)continue;const stamp=[m.action,localTime(slot),m.frame,$('lockRoot').checked,$('bones').checked,state.display,state.target];if(m.poseStamp?.every((value,i)=>value===stamp[i]))continue;m.poseStamp=stamp;timeModel(m,localTime(slot));if($('lockRoot').checked&&m.action){const delta=m.hip.getWorldPosition(new T.Vector3()).sub(m.anchor);m.holder.position.x-=delta.x;m.holder.position.z-=delta.z;m.scene.updateMatrixWorld(true);}m.lines.visible=!m.capabilities.hasMesh||$('bones').checked||(state.display==='overlay'&&slot==='baseline');m.points.visible=!m.capabilities.hasMesh&&m.joints.length>0;if(m.points.visible)m.points.geometry.setFromPoints(m.joints.map(b=>b.getWorldPosition(new T.Vector3())));if(m.lines.visible){const points=[];for(const b of m.joints)if(m.jointSet.has(b.parent))points.push(b.getWorldPosition(new T.Vector3()),b.parent.getWorldPosition(new T.Vector3()));m.lines.geometry.setFromPoints(points);}m.nodeAxes.visible=!m.capabilities.hasMesh&&m.joints.length>0;if(m.nodeAxes.visible){const b=joint(m,state.target?.bone,state.target?.nodeIndex)||m.joints.at(-1);m.nodeAxes.position.copy(b.getWorldPosition(new T.Vector3()));m.nodeAxes.quaternion.copy(b.getWorldQuaternion(new T.Quaternion()));}m.marker.visible=Boolean(state.target&&state.target.slot===slot);if(m.marker.visible){const bone=joint(m,state.target.bone,state.target.nodeIndex);if(bone)m.marker.position.copy(bone.getWorldPosition(new T.Vector3()));else if(state.target.worldPoint)m.marker.position.fromArray(state.target.worldPoint);else m.marker.visible=false;}}
}
function drawModel(m,camera,viewport){if(['curves','metadata'].includes(m.capabilities.preview))return;try{renderAppearance(m,{renderer,THREE:T,camera,viewport,time:localTime(m.appearanceContext.slot)});}catch(error){if(m.appearance||appearanceRecovery)recoverAppearance(error);else throw error;}}
function render(){if(continuousFrames())renderLoop?.wake();if(!state.ready)return;drawObservationConditions();pose();drawResourcePanels();if(!renderer)return;const rect=$('stage').getBoundingClientRect(),w=rect.width,h=rect.height;if(!w||!h)return;renderer.setScissorTest(true);renderer.setViewport(0,0,w,h);renderer.setScissor(0,0,w,h);renderer.clear();
if(state.display==='split'){for(const [i,slot] of ['candidate','baseline'].entries()){const m=state.models[slot];if(!m)continue;cameras[slot].aspect=w/2/h;cameras[slot].updateProjectionMatrix();renderer.setViewport(i*w/2,0,w/2,h);renderer.setScissor(i*w/2,0,w/2,h);drawModel(m,cameras[slot],{x:i*w/2,y:0,width:w/2,height:h});}}
else{const slot=activeSlot(),m=state.models[slot];if(m){cameras[slot].aspect=w/h;cameras[slot].updateProjectionMatrix();drawModel(m,cameras[slot],{x:0,y:0,width:w,height:h});}if(state.display==='overlay'&&state.models.baseline&&!['curves','metadata'].includes(state.models.baseline.capabilities.preview)){const base=state.models.baseline,old=base.scene.background;base.scene.background=null;for(const o of base.environment)o.visible=false;for(const o of base.meshes)o.visible=false;renderer.clearDepth();renderer.render(base.scene,cameras[slot]);for(const o of base.environment)o.visible=true;for(const o of base.meshes)o.visible=true;base.scene.background=old;}}
renderer.setScissorTest(false);updateSelectionFloat();}
function size(){const r=$('stage').getBoundingClientRect();if(renderer&&!state.capturing&&r.width&&r.height)renderer.setSize(r.width,r.height,false);render();}
function syncCurveSelection(slot){const selected=resourcePanels[slot].observe();if(state.display==='split'&&selected)resourcePanels[slot==='baseline'?'candidate':'baseline'].restore(selected);if(state.ready&&activeModel()?.capabilities.preview==='curves')$('targetText').textContent=resourcePanels[activeSlot()].observe()?.binding||'全部曲线';render();}
function drawResourcePanels(){
 for(const slot of slots){const panel=resourcePanels[slot],m=state.models[slot],visible=state.display==='split'||slot===activeSlot();panel.setDomain(null);if(!visible||!m){panel.element.hidden=true;continue;}panel.element.style.left=state.display==='split'?(slot==='baseline'?'calc(50% + 8px)':'8px'):'8px';panel.element.style.right=state.display==='split'?(slot==='candidate'?'calc(50% + 8px)':'8px'):'8px';panel.render(m,localTime(slot));}
 const a=resourcePanels.baseline,b=resourcePanels.candidate,x=a.observe(),y=b.observe();
 if(state.display==='split'&&!a.element.hidden&&!b.element.hidden&&x&&y&&x.binding===y.binding&&x.component===y.component){const range=[Math.min(a.range[0],b.range[0]),Math.max(a.range[1],b.range[1])];for(const p of [a,b]){p.setDomain(range);p.redraw();}}
}

function captureStage(){const out=document.createElement('canvas'),r=$('stage').getBoundingClientRect();out.width=renderer?canvas.width:Math.max(1,Math.round(r.width));out.height=renderer?canvas.height:Math.max(1,Math.round(r.height));const ctx=out.getContext('2d');ctx.fillStyle='#161e2a';ctx.fillRect(0,0,out.width,out.height);if(renderer)ctx.drawImage(canvas,0,0);for(const panel of Object.values(resourcePanels))if(!panel.element.hidden){const box=panel.element.getBoundingClientRect();ctx.save();ctx.translate((box.left-r.left)*out.width/r.width,(box.top-r.top)*out.height/r.height);ctx.scale(out.width/r.width,out.height/r.height);panel.paint(ctx,box.width,box.height);ctx.restore();}return out;}
function setViewButtons(){document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===state.view;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});$('viewName').textContent=({front:'正面',side:'侧面',back:'背面',top:'俯视',orbit:'自由视角'})[state.view]||'自由视角';}
function view(name){cameraBusy=true;const frame=activeModel()?.frame,target=frame?.target||[0,1,0],scale=frame?.distanceScale||1;for(const slot of slots){const position=viewPositions[name];cameras[slot].position.set(target[0]+position[0]*scale,target[1]+(position[1]-1)*scale,target[2]+position[2]*scale);cameras[slot].near=Math.max(.00001,.01*scale);cameras[slot].far=Math.max(1000,1000*scale);cameras[slot].updateProjectionMatrix();controls[slot].minDistance=.45*scale;controls[slot].maxDistance=40*scale;controls[slot].target.fromArray(target);controls[slot].update();}cameraBusy=false;state.view=name;setViewButtons();render();}
function drawObservationConditions(){
 const text=[$('lockRoot').checked?'根位移已锁定':'保留根位移',$('progress').checked&&state.display!=='single'?'按进度对齐':'按秒数对齐',$('scaleMode').value==='raw'?'原始尺度与原点':recordedFrame(state.models.baseline)?'共用冻结现场尺度与偏移':'共用修改前尺度与偏移'].join(' · ');
 if($('observationConditions').textContent!==text)$('observationConditions').textContent=text;
}


function jobSourceAsset(job){return job?.inputs?.[job.slot||'baseline'];}
function hasComparison(){const a=state.models.baseline?.meta,b=state.models.candidate?.meta;return Boolean(a&&b&&(state.jobs.some(j=>j.state==='complete'&&jobSourceAsset(j)?.sha256===a.sha256&&j.candidate?.sha256===b.sha256)||(state.comparisonPair?.baseline===a.sha256&&state.comparisonPair?.candidate===b.sha256)));}
function updateDisplay(){
 const curves=Object.values(state.models).some(m=>['curves','metadata'].includes(m.capabilities.preview));if(curves&&state.display==='overlay')state.display='split';document.querySelector('[data-display="overlay"]').disabled=curves;
 const split=state.display==='split',active=activeSlot(),comparison=hasComparison();
 for(const slot of slots){const surface=$('surface-'+slot);surface.hidden=!split&&slot!==active;surface.style.left=split?(slot==='candidate'?'0':'50%'):'0';surface.style.right=split?(slot==='candidate'?'50%':'0'):'0';controls[slot].enabled=split||slot===active;}
 $('stageDivider').hidden=!split;$('candidateLabel').hidden=!split&&active!=='candidate';$('baselineLabel').hidden=!split&&active!=='baseline';$('baselineLabel').style.left=split?'calc(50% + 17px)':'17px';
 $('compareControls').hidden=!comparison;$('focusSlot').disabled=state.display!=='single';$('focusSlot').value=state.focus;
 $('versionModes').hidden=!comparison;$('singleVersion').hidden=comparison;$('singleVersion').textContent=state.focus==='candidate'?'正在观察当前版本':state.models.baseline?.meta.sha256===state.project?.slots.baseline?.sha256?'正在观察最初原版':'正在观察修改前';document.querySelector('[data-version="baseline"]').textContent=comparison?'修改前':'最初原版';$('baselineLabel').querySelector('span').firstChild.nodeValue=comparison?'修改前':'最初原版';
 document.querySelectorAll('[data-display]').forEach(b=>{const yes=b.dataset.display===state.display;b.classList.toggle('active',yes);b.setAttribute('aria-pressed',String(yes));});
 document.querySelectorAll('[data-version]').forEach(b=>{const yes=b.dataset.version===(state.display==='single'?state.focus:'compare');b.classList.toggle('active',yes);b.setAttribute('aria-pressed',String(yes));});
 $('comparisonMeaning').textContent=$('progress').checked?'按进度对齐 · 速度可能不同':'同一秒数比较 · 保留真实节奏';size();updateWorkflow();
}
function selectMotion(name){if(state.switching||state.loading)return;for(const slot of slots)if(state.models[slot]?.clips.some(c=>c.name===name))selectClip(slot,name);state.time=0;state.playing=duration()>0;clearTarget();drawLibrary();updateBoneChoices();drawMetadata();render();}
function seek(time){state.playing=false;state.time=Math.max(0,Math.min(duration(),Number(time)||0));render();updateClock();}
function updateClock(){const d=duration();$('timeline').max=String(d||1);$('timeline').value=String(Math.min(state.time,d));$('timeline').style.setProperty('--progress',(d?Math.min(100,state.time/d*100):0)+'%');$('clock').replaceChildren(document.createTextNode(state.time.toFixed(3)+' '),el('span','/ '+d.toFixed(3)+' s'));const symbol=state.playing?'pause':'play';if($('play').dataset.symbol!==symbol){$('play').replaceChildren(icon(symbol));$('play').dataset.symbol=symbol;}$('play').setAttribute('aria-label',state.playing?'暂停':'播放');$('play').disabled=!state.ready||!d;$('prev').disabled=!d;$('next').disabled=!d;$('contextTime').textContent=localTime(activeSlot()).toFixed(3)+'s';$('frameInfo').textContent='第 '+Math.round(localTime(activeSlot())*state.fps)+' 帧 · '+state.fps+' fps 审阅';$('contextClip').textContent=activeModel()?.clip||'静态姿态';$('tickQuarter').textContent=(d/4).toFixed(2);$('tickMid').textContent=(d/2).toFixed(2);$('tickThreeQuarter').textContent=(d*.75).toFixed(2);$('tickEnd').textContent=d.toFixed(2)+' s';updateScopeVisual();}
function context(){const slot=activeSlot(),m=state.models[slot];return{assetId:viewState.loadedAssetId,slot,asset:m?{sha256:m.meta.sha256,file:m.meta.file}:null,clip:m?.clip||null,time:localTime(slot),frame:Math.round(localTime(slot)*state.fps),fps:state.fps,speed:state.speed,loop:state.loop,scaleMode:$('scaleMode').value,view:state.view,displayMode:state.display==='single'?'all':'comparison',display:state.display,mode:$('progress').checked?'progress':'elapsed',normalized:$('scaleMode').value!=='raw'&&Boolean(m?.capabilities.hasMesh||m?.capabilities.hasNodes),rootLocked:$('lockRoot').checked,linkedCameras:$('linkCameras').checked,cameras:Object.fromEntries(slots.map(s=>[s,{position:cameras[s].position.toArray(),target:controls[s].target.toArray(),fov:cameras[s].fov,projection:'perspective'}])),slots:Object.fromEntries(slots.filter(s=>state.models[s]).map(s=>[s,{sha256:state.models[s].meta.sha256,file:state.models[s].meta.file,clip:state.models[s].clip,duration:state.models[s].duration,time:localTime(s)}])),normalization:Object.fromEntries(slots.filter(s=>state.models[s]).map(s=>[s,{scale:state.models[s].factor,restOffset:state.models[s].offset.toArray(),displayOffset:state.models[s].holder.position.toArray(),sourceHeight:state.models[s].height}])),selection:state.target?structuredClone(state.target):null,appearance:appearance.snapshot(m),resourceObservation:resourcePanels[slot].observe()};}
function rawName(m,o){const idx=m.parser?.associations?.get(o)?.nodes;return idx!==undefined?(m.parser.json.nodes[idx]?.name||o.name):o.name;}
function joint(m,name,index){return findJoint(m,name,index);}
function updateBoneChoices(){const m=activeModel(),previous=state.target?joint(m,state.target.bone,state.target.nodeIndex):selectedJoint(m,$('boneSelect').value),advanced=$('showAllBones').checked,select=$('boneSelect');select.replaceChildren();const all=el('option',m?.capabilities.hasMesh?'整个模型 / 自动判断部位':'整个资源 / 选择节点');all.value='';select.append(all);const counts=new Map();for(const b of m?.joints||[])counts.set(rawName(m,b),(counts.get(rawName(m,b))||0)+1);if(m)for(const b of m.joints){const name=rawName(m,b),label=semanticPart(name);if(m.capabilities.hasMesh&&!advanced&&part(name)===name&&b!==previous)continue;const duplicate=counts.get(name)>1,description=advanced?(label?label+' · '+name:name):(label||name),o=el('option',description+(duplicate?' · 节点 '+m.parser.associations.get(b)?.nodes:''));o.value=jointValue(m,b);select.append(o);}select.value=previous?jointValue(m,previous):'';}

function clearTarget(){state.target=null;$('boneSelect').value='';$('targetText').textContent=activeModel()?.capabilities.hasMesh?'整个模型':'整个资源';$('targetHint').textContent='点击位置用于定位参考，关联部位可以在这里确认。';$('clearSelection').hidden=true;$('selectionFloat').hidden=true;for(const m of Object.values(state.models))m.marker.visible=false;render();scheduleProjectPreview();}
function setTarget(target){state.target=target;$('targetText').textContent=target.bone?(semanticPart(target.bone)||target.bone):'已选表面';$('clearSelection').hidden=false;updateBoneChoices();const node=joint(state.models[target.slot],target.bone,target.nodeIndex);if(node)$('boneSelect').value=jointValue(state.models[target.slot],node);$('targetHint').textContent=target.inferred?'已根据点击位置关联部位。请确认是否为你想调整的位置；点击不会指定精确顶点。':'已确认修改部位。你也可以在描述中说明其他部位如何保持。';render();scheduleProjectPreview();}

function updateSelectionFloat(){const label=$('selectionFloat'),target=state.target;if(!target){label.hidden=true;return;}const m=state.models[target.slot],bone=m&&joint(m,target.bone,target.nodeIndex);if(!m||!bone){label.hidden=true;return;}const point=bone.getWorldPosition(new T.Vector3()).project(cameras[target.slot]);const split=state.display==='split';if(!split&&target.slot!==activeSlot()){label.hidden=true;return;}const r=$('stage').getBoundingClientRect();const index=target.slot==='candidate'?0:1;let x=(point.x+1)/2*r.width/(split?2:1)+(split?index*r.width/2:0),y=(1-point.y)/2*r.height;label.hidden=point.z>1||x<0||x>r.width||y<0||y>r.height;if(!label.hidden){label.style.left=Math.min(r.width-120,Math.max(10,x))+'px';label.style.top=Math.max(65,Math.min(r.height-40,y))+'px';label.textContent=semanticPart(target.bone)||target.bone;}}
const raycaster=new T.Raycaster();
function pickSurface(event,slot){if(!state.ready||state.loading||state.switching)return;const m=state.models[slot];if(!m)return;const rect=$('surface-'+slot).getBoundingClientRect();const pointer=new T.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);state.playing=false;updateClock();pose();raycaster.setFromCamera(pointer,cameras[slot]);if(!m.capabilities.hasMesh){raycaster.params.Points.threshold=.06;const hit=raycaster.intersectObject(m.points)[0],node=hit&&m.joints[hit.index];if(node)setTarget({slot,assetSha256:m.meta.sha256,bone:rawName(m,node),nodeIndex:m.parser.associations.get(node)?.nodes,space:'node-local',inferred:false});return;}const hit=raycaster.intersectObjects(m.meshes,true)[0];if(!hit)return;let associated=null;const mesh=hit.object;
if(mesh.isSkinnedMesh&&hit.face){const indices=mesh.geometry.attributes.skinIndex,weights=mesh.geometry.attributes.skinWeight,totals=new Map();if(indices&&weights){for(const vertex of [hit.face.a,hit.face.b,hit.face.c])for(let i=0;i<Math.min(4,indices.itemSize);i++){const index=indices.getComponent(vertex,i),weight=weights.getComponent(vertex,i);if(weight>0)totals.set(index,(totals.get(index)||0)+weight);}const best=[...totals].sort((a,b)=>b[1]-a[1])[0];if(best)associated=mesh.skeleton.bones[best[0]];}}
if(!associated){let o=mesh.parent;while(o&&o!==m.root){if(m.joints.includes(o)){associated=o;break;}o=o.parent;}}
if(!associated&&m.joints.length){let distance=Infinity;for(const b of m.joints){const d=b.getWorldPosition(new T.Vector3()).distanceTo(hit.point);if(d<distance){distance=d;associated=b;}}}
const nodeIndex=associated?m.parser?.associations?.get(associated)?.nodes:undefined;setTarget({slot,assetSha256:m.meta.sha256,bone:associated?rawName(m,associated):null,nodeIndex,mesh:rawName(m,mesh),meshNodeIndex:m.parser?.associations?.get(mesh)?.nodes,point:mesh.worldToLocal(hit.point.clone()).toArray(),worldPoint:hit.point.toArray(),space:'mesh-local-posed',faceIndex:hit.faceIndex,pickedAt:{clip:m.clip,time:localTime(slot)},inferred:true});updateClock();}
for(const slot of slots){let down=null;const surface=$('surface-'+slot);surface.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY};});surface.addEventListener('pointerup',e=>{if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<5)pickSurface(e,slot);down=null;});}
$('boneSelect').onchange=()=>{const slot=activeSlot(),m=state.models[slot],b=selectedJoint(m,$('boneSelect').value);if(!b)return clearTarget();setTarget({slot,assetSha256:m.meta.sha256,bone:rawName(m,b),nodeIndex:m.parser?.associations?.get(b)?.nodes,mesh:null,space:'bone-local',inferred:false});};$('clearSelection').onclick=clearTarget;
function drawSidebar(){
 const m=activeModel(),host=$('sidebarClipList');host.replaceChildren();$('sidebarClipCount').textContent=m?.clips.length||0;
 for(const c of m?.clips||[]){const active=m.clip===c.name,b=el('button',undefined,'sidebar-clip'+(active?' active':'')),text=el('span');b.type='button';b.setAttribute('aria-pressed',String(active));text.append(el('b',c.name),el('small',c.duration.toFixed(2)+' s'));b.append(icon('motion'),text);b.onclick=()=>selectMotion(c.name);host.append(b);}
 if(m&&!m.clips.length)host.append(el('p',resourceLabel(m.capabilities)+' · 无内置动作','sidebar-static'));
}
function drawLibrary(){const m=activeModel(),list=$('clipList'),query=$('search').value.trim().toLowerCase();drawSidebar();list.replaceChildren();const clips=(m?.clips||[]).filter(c=>!query||c.name.toLowerCase().includes(query));$('clipCount').textContent=m?.clips.length||0;const chooser=$('motionSelect');chooser.replaceChildren();for(const c of m?.clips||[]){const o=el('option',c.name);o.value=c.name;chooser.append(o);}if(m?.clip)chooser.value=m.clip;if(!m?.clips.length){const o=el('option','无内置动作');o.value='';chooser.append(o);}chooser.disabled=!m?.clips.length;if(!m?.clips.length){list.append(el('p',m?resourceLabel(m.capabilities)+'。此资源没有内置动作；可独立检查，或明确关联兼容动作。':'导入模型、骨架或动作，或稍候读取示例。','clip-empty'));return;}for(const [index,c] of clips.entries()){const b=el('button',undefined,'motion-card'+(m.clip===c.name?' active':''));b.setAttribute('role','option');b.setAttribute('aria-selected',String(m.clip===c.name));b.dataset.clip=c.name;const glyph=el('span',undefined,'motion-icon'),text=el('span',undefined,'motion-text');glyph.append(icon('motion'));text.append(el('strong',c.name),el('small',c.duration.toFixed(2)+' 秒 · '+(state.display==='single'&&state.focus==='baseline'?'原版动作':'版本对照')));b.append(glyph,text,el('span',String(index+1).padStart(2,'0'),'motion-index'));b.onclick=()=>{selectMotion(c.name);$('libraryDialog').close();};list.append(b);}if(!clips.length)list.append(el('p','没有找到这个动作，试试其他名称。','clip-empty'));}
function drawMetadata(){
 drawAppearance({mode:appearance.mode,descriptor:appearance.descriptor,error:appearance.error});
 const m=activeModel();if(!m)return;
 const teaching=m.meta.generator?.includes('original teaching');
 const title=state.project.title&&state.project.title!=='动作反馈练习'?state.project.title:teaching?'原创练习角色':m.meta.label.replace(/\.(glb|fbx)$/i,'');
 $('sidebarAssetName').textContent=(title||'当前角色').split(' · ')[0];$('sidebarAssetName').title=title||'当前角色';$('sidebarAssetMeta').textContent=(m.meta.bytes/1048576).toFixed(1)+' MB · GLB';
 $('roleName').textContent=title||'当前角色';$('workspaceTitle').textContent=title||'动作修改工作台';$('assetKind').textContent=resourceLabel(m.capabilities);
 const motionOrigin=m.meta.source?.assembly?.clips?.[m.clip];
 $('assetDescription').textContent=motionOrigin?'动作来源：'+motionOrigin.file+' · '+motionOrigin.sourceClip:teaching?'原创教学角色，可以直接体验一次动作修改。':m.capabilities.limitations.join('；')||'素材留在本机，原文件与每次修改独立保留。';$('assetLabel').textContent=m.meta.label;$('assetStats').textContent=(m.meta.bytes/1048576).toFixed(1)+' MB · '+m.joints.length+' 个骨骼 / 节点';
 $('clipTitle').textContent=m.clip==='mixamo.com'?'角色动作':m.clip||resourceLabel(m.capabilities);$('stageEyebrow').textContent=state.archivedJobId?'历史版本':state.focus==='candidate'?'修改后的版本':m.clip?'当前动作':'当前资源';
 $('currentHash').textContent=m.meta.sha256;$('stageStatus').textContent=state.archivedJobId?'历史对照 · 当前素材保持':(m.appearance?'项目外观 · ':'中性检查 · ')+resourceLabel(m.capabilities);
 $('baselineFile').textContent=state.models.baseline?.meta.label||'—';$('candidateFile').textContent=state.models.candidate?.meta.label||'尚无候选';$('baselineImportName').textContent=state.models.baseline?.meta.label||'';$('candidateImportName').textContent=state.models.candidate?.meta.label||'';
 if(!state.target){$('targetText').textContent=m.capabilities.preview==='curves'?resourcePanels[activeSlot()].observe()?.binding||'全部曲线':m.capabilities.hasMesh?'整个模型':'整个资源';}$('openTarget').disabled=!m.capabilities.canPickNode&&!m.capabilities.canPickSurface;
 $('exampleBanner').hidden=!teaching||state.jobs.some(j=>j.state==='complete');$('scopeMode').disabled=!m.duration;
 if(!m.duration){$('scopeMode').value='whole';$('scopeInputs').hidden=true;$('scopeStart').disabled=true;$('scopeEnd').disabled=true;}
 $('scopeEnd').max=String(m.duration);$('scopeStart').max=String(m.duration);if($('scopeMode').value==='whole')$('scopeEnd').value=String(m.duration);
 $('submitRequest').disabled=!state.initialized||!state.ready||!m.capabilities.canInspect||state.loading||state.submitting||state.switching||Boolean(state.archivedJobId);$('saveQueued').disabled=$('submitRequest').disabled;$('localEdit').disabled=!state.initialized||!state.ready||!m.action||!m.capabilities.canLocalRotate||state.submitting||Boolean(state.archivedJobId);
 $('snapshotButton').disabled=$('quickSnapshot').disabled=['curves','metadata'].includes(m.capabilities.preview);$('scaleMode').disabled=state.loading||state.switching||state.capturing||state.submitting;$('bones').disabled=!m.joints.length;$('lockRoot').disabled=!m.action;$('stageHint').textContent=m.capabilities.preview==='curves'?'选择轨道与分量 · 时间轴定位 · 可提交曲线反馈':m.capabilities.preview==='metadata'?'此容器没有可显示内容':'拖动旋转 · 滚轮缩放 · 点击选节点或表面';$('returnCurrent').hidden=!state.archivedJobId;drawAgent();updateClock();updateWorkflow();scheduleProjectPreview();
}
function scope(){const d=activeModel()?.duration||0;if($('scopeMode').value==='whole')return{start:0,end:d,wholeClip:true};const start=Number($('scopeStart').value),end=Number($('scopeEnd').value);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>d+.0001)throw Error('请选择有效的时间范围：开始需早于结束，并位于当前动作内。');return{start,end,wholeClip:false};}
function updateScopeVisual(){const range=$('scopeMode').value==='range';$('scopeText').textContent=range?(Number($('scopeStart').value)||0).toFixed(2)+'–'+(Number($('scopeEnd').value)||0).toFixed(2)+'秒':'整个动作';const bar=$('scopeVisual');bar.hidden=$('scopeMode').value!=='range'||!duration();if(!bar.hidden){const start=Number($('scopeStart').value)||0,end=Number($('scopeEnd').value)||0;bar.style.left=Math.max(0,start/duration()*100)+'%';bar.style.width=Math.max(0,Math.min(100,(end-start)/duration()*100))+'%';}}
async function refreshModels({preserve=true,force=false,selectionTicket=null,observation=null}={}){
 if(state.capturing||state.switching&&!selectionTicket||selectionTicket&&!viewState.isCurrent(selectionTicket))return null;
 const ticket=viewState.beginLoad();if(!ticket)return null;
 const old=preserve&&state.ready?context():null,savedTime=state.time,savedPlaying=state.playing,savedFocus=state.focus,savedDisplay=state.display;
 state.loading=true;state.playing=false;$('stageLoading').hidden=false;$('stageError').hidden=true;
 try{
  const d=await api('/api/session','GET',undefined,{assetId:ticket.assetId,signal:ticket.signal});
  if(!d.project?.activeAssetId||!viewState.isUnchanged(ticket,d.project.activeAssetId))return null;
  state.token=d.token;state.paths=d.paths||{};
  if(!await loadPair(d.project.slots,force,()=>viewState.isUnchanged(ticket,d.project.activeAssetId),observation?observationFrameOptions(observation):null))return null;
  if(!state.models.baseline)throw Error('尚无基线素材，请导入原版角色。');
  if(!viewState.markLoaded(ticket,d.project.activeAssetId))return null;
  const prior=state.project;state.project=d.project;state.fps=d.project.fps||30;state.ready=true;
  if(old){
   for(const slot of slots){const clip=old.slots[slot]?.clip;if(clip&&state.models[slot]?.clips.some(c=>c.name===clip))selectClip(slot,clip);}
   cameraBusy=true;for(const slot of slots){cameras[slot].position.fromArray(old.cameras[slot].position);controls[slot].target.fromArray(old.cameras[slot].target);cameras[slot].fov=old.cameras[slot].fov;cameras[slot].updateProjectionMatrix();controls[slot].update();}cameraBusy=false;
   state.focus=savedFocus;state.display=savedDisplay;state.time=Math.min(duration(),savedTime);state.playing=savedPlaying;
  }else{state.time=0;state.playing=duration()>0;view(state.view==='orbit'?'front':state.view);}
  if(state.target&&state.models[state.target.slot]?.meta.sha256!==state.target.assetSha256)state.target=null;
  $('stageLoading').hidden=true;drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();render();
  return {candidateChanged:prior?.slots?.candidate?.sha256!==state.project.slots.candidate?.sha256,observationTicket:ticket};
 }finally{if(viewState.isUnchanged(ticket)){state.loading=false;drawMetadata();drawLatestJob();renderLoop?.wake();}}
}
// Shared by draft/history restoration and candidate comparison. Async identity
// checks stay at the caller boundary; this synchronous phase cannot adopt an
// observation belonging to a retired asset load.
function applyObservation(ctx,options={}){
 const plan=planObservationRestore(ctx,state.models,options),settings=plan.settings;
 state.playing=false;state.display=plan.display;state.focus=plan.focus;
 $('lockRoot').checked=settings.rootLocked;$('linkCameras').checked=settings.linkedCameras;$('progress').checked=settings.mode==='progress';$('scaleMode').value=settings.scaleMode;
 state.speed=settings.speed;$('speed').value=String(state.speed);state.loop=settings.loop;drawLoop();
 for(const [slot,clip] of Object.entries(plan.clips))selectClip(slot,clip);
 state.observationTransform=plan.normalization?{...plan.normalization,sha256:state.models.baseline?.meta.sha256,assetId:state.models.baseline?.meta.assetId||state.project?.activeAssetId}:null;normalizePair();state.time=restoredTransportTime(plan,state.models);state.view=settings.view;const scale=activeModel()?.frame?.distanceScale||1;for(const slot of slots){cameras[slot].near=Math.max(.00001,.01*scale);cameras[slot].far=Math.max(1000,1000*scale);controls[slot].minDistance=.45*scale;controls[slot].maxDistance=40*scale;}
 cameraBusy=true;try{for(const [slot,camera] of Object.entries(plan.cameras)){cameras[slot].position.fromArray(camera.position);controls[slot].target.fromArray(camera.target);if(camera.fov)cameras[slot].fov=camera.fov;cameras[slot].updateProjectionMatrix();controls[slot].update();}}finally{cameraBusy=false;}
 setViewButtons();$('focusSlot').value=state.focus;
}
async function restoreContext(ctx){
 if(!ctx)return;const appearanceTicket=viewState.capture();
 const appearanceChanged=await appearance.chooseRecorded(ctx.appearance,state.project?.activeAssetId,()=>viewState.isUnchanged(appearanceTicket));
 if(appearanceChanged===null||!viewState.isUnchanged(appearanceTicket))return;
 if(appearanceChanged||appearance.mode==='project'){const refreshed=await refreshModels({force:true,selectionTicket:appearanceTicket,observation:ctx});if(!refreshed||!viewState.isCurrentMutation(appearanceTicket)||!viewState.isUnchanged(refreshed.observationTicket))return;}
 applyObservation(ctx);drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();render();resourcePanels[activeSlot()].restore(ctx.resourceObservation);render();
 if(ctx.selection){const selected=ctx.selection,m=state.models[selected.slot];if(m?.meta.sha256===selected.assetSha256&&(!selected.bone||joint(m,selected.bone,selected.nodeIndex)))setTarget(structuredClone(selected));else clearTarget();}
}

function viewMatchesJob(job,needCandidateVisible=false){return Boolean((job.assetId||state.project?.legacyAssetId||'legacy')===state.project?.activeAssetId&&job.candidate&&state.models.candidate?.meta.sha256===job.candidate.sha256&&state.models.baseline?.meta.sha256===jobSourceAsset(job)?.sha256&&(!needCandidateVisible||state.display!=='single'||state.focus==='candidate'));}
async function showCandidate(job,{restoreAppearance=false}={}){
 if(job?.summaryOnly){const ticket=viewState.capture();job=await ensureJobDetail(job);if(!job||!viewState.isUnchanged(ticket,job.assetId))return false;}
 const assetId=job?.assetId||state.project?.legacyAssetId||'legacy';
 if(assetId!==state.project?.activeAssetId)throw Error('请先打开这条任务所属的模型。');
 if(state.switching||state.capturing)return false;
 if(!job?.candidate||!job.inputs?.baseline||!jobSourceAsset(job))throw Error('此任务没有完整的归档候选信息。');
 const ticket=viewState.beginLoad();if(!ticket)return false;
 state.playing=false;const archived=state.project.slots.baseline?.sha256!==job.inputs.baseline.sha256||state.project.slots.candidate?.sha256!==job.candidate.sha256;
 state.loading=true;drawMetadata();
 try{
  const appearanceChanged=restoreAppearance?await appearance.chooseRecorded(job.context?.appearance,assetId,()=>viewState.isUnchanged(ticket,assetId)):false;if(appearanceChanged===null)return false;
  const wanted={baseline:jobSourceAsset(job),candidate:job.candidate};
  if(!await loadPair(wanted,appearanceChanged,()=>viewState.isUnchanged(ticket,assetId),observationFrameOptions(job.context||{},job.slot||'baseline')))return false;
  if(!viewState.markLoaded(ticket,assetId))return false;
  state.selectedJob=job.id;state.panelMode='task';state.archivedJobId=archived?job.id:null;state.display='split';state.focus='candidate';
  applyObservation(job.context||{},{inputSlot:job.slot||'baseline',fallbackClip:job.clip});
  $('focusSlot').value='candidate';clearTarget();
  const matched=correspondingJoint(state.models.candidate,state.models.baseline,job.target);if(matched){const b=matched;setTarget({slot:'candidate',assetSha256:state.models.candidate.meta.sha256,bone:rawName(state.models.candidate,b),nodeIndex:state.models.candidate.parser?.associations?.get(b)?.nodes,space:'bone-local',inferred:false});}
  drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();drawLatestJob();render();const curve=job.context?.resourceObservation||resourcePanels.baseline.observe();if(curve){for(const slot of slots)resourcePanels[slot].restore(curve);render();}
  notice(archived?'正在比较此历史任务修改前后的版本。当前工作区素材没有改变；返回当前素材后可继续发起修改。':'候选已载入，镜头与时刻已对齐。请检查完整动作后再决定。');return true;
 }finally{if(viewState.isUnchanged(ticket)){state.loading=false;drawMetadata();drawLatestJob();renderLoop?.wake();}}
}

function currentJob(){return state.jobs.find(x=>x.id===state.selectedJob)||[...state.jobs].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''))[0];}
const phaseNames={reading:'理解要求与检查素材',editing:'正在修改素材',checking:'检查修改结果',exporting:'导出并载入候选'};
function elapsedLabel(date){if(!date)return'尚未开始';const n=Math.max(0,Math.floor((Date.now()-new Date(date).getTime())/1000));return n<60?n+'秒':n<3600?Math.floor(n/60)+'分 '+n%60+'秒':Math.floor(n/3600)+'小时 '+Math.floor(n%3600/60)+'分';}
function queuedAhead(job){return state.jobs.filter(j=>j.id!==job.id&&j.executor!=='local'&&(['queued','running'].includes(j.state))&&(j.createdAt||'')<(job.createdAt||'')).length;}
function jobText(job){
 if(job.state==='queued'){if(job.executor==='local')return'正在准备本地数值工具，未调用 AI。';if(!state.agent?.connected)return'修改要求和当前画面已经保存。连接本机 Codex 后即可开始。';const ahead=queuedAhead(job);return ahead?'本机 Agent 会按顺序处理，前方还有 '+ahead+' 个任务。':'本机 Codex 已连接，正在等待它领取这条任务。';}
 if(job.state==='running')return job.executor==='local'?'正在按你指定的倍率调整旋转摆幅，未调用 AI。':'原版独立保留。Agent 将根据你的要求生成一个修改候选。';
 if(job.state==='complete')return job.executor==='local'?'本地数值候选已生成，未调用 AI。请播放完整动作检查。':'修改后的版本已返回。请播放完整动作，检查它是否符合你的想法。';
 if(job.state==='interrupted')return '执行器已停止响应，本轮要求和已有输出已保留。可以在原输入版本上重新执行。';
 if(job.state==='failed')return errorString(job.error)||'这次处理没有完成。你的要求和观察现场已经保留。';
 if(job.state==='needs-input')return job.question||errorString(job.error)||'Agent 需要你再说明一点，补充后会继续处理原来的任务。';
 if(job.state==='stale')return'任务发起后的素材发生了变化。旧意见保留，请回到当前素材重新确认。';
 return'处理已停止，原版没有改变。可以沿用刚才的要求再试一次。';
}
function errorString(error){return typeof error==='string'?error:error?.message||JSON.stringify(error||'');}
async function copyText(text){try{await navigator.clipboard.writeText(text);toast('已复制，可以粘贴到 Agent 对话。');}catch{const input=el('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();if(ok)toast('已复制。');else throw Error('浏览器未允许复制，请展开任务详情手动复制。');}}
function updateWorkflow(){
 if(!state.initialized){$('mobileTaskAction').disabled=true;return;}$('mobileTaskAction').disabled=false;
 const j=currentJob(),task=state.panelMode==='task'&&j,step=task?(j.state==='complete'?'compare':'process'):'observe';
 for(const [id,key]of[['flowObserve','observe'],['flowProcess','process'],['flowCompare','compare']])$(id).classList.toggle('current',step===key);
 let title='描述你想要的修改',detail='观察好了？用一句话告诉 Agent',icon='✎';
 if(task){icon=j.state==='complete'?'✓':['failed','needs-input'].includes(j.state)?'!':'◷';title=j.state==='running'?'正在修改 · '+(phaseNames[j.progress?.phase]||'Agent 执行中'):j.state==='queued'?(state.agent?.connected?'任务排队中':'等待连接 Agent'):j.state==='complete'?'候选已返回 · 检查效果':statusNames[j.state]||'查看修改任务';detail=j.state==='running'?(j.progress?.message||j.activity?.message||'处理结束后自动显示对照'):j.state==='complete'?'比较效果，也可以基于这版继续调整':'点击查看详情与下一步';}
 $('mobileTaskTitle').textContent=title;$('mobileTaskDetail').textContent=detail;$('mobileTaskIcon').textContent=icon;requestAnimationFrame(updateMobileActionVisibility);
}
function updateMobileActionVisibility(){const r=$('taskPanel').getBoundingClientRect();$('mobileTaskAction').hidden=innerWidth<=760&&r.top<innerHeight*.64&&r.bottom>60;}
window.addEventListener('scroll',updateMobileActionVisibility,{passive:true});window.addEventListener('resize',updateMobileActionVisibility);
function actionButton(label,fn,cls='secondary-button'){
 return createActionButton(label,fn,{className:cls,onError:fail});
}
async function connectAgent(){const r=await api('/api/agent/connect','POST',{provider:'codex'});await pollStudio();if(r.error)throw Error(errorString(r.error));return r;}
async function beginCompose({job=null,source=null,prefill=false}={}){
 if(state.switching||state.loading||state.capturing)return;const ticket=viewState.capture();
 if(state.archivedJobId){notice('这是一条归档任务。请先返回当前素材，再继续修改。');return;}
 if(source==='candidate'&&job&&job.state==='complete'&&!viewMatchesJob(job)){if(!await showCandidate(job)||!viewState.isCurrent(ticket))return;}
 if(state.archivedJobId){notice('这是一条归档任务。请先返回当前素材，再继续修改。');return;}
 const focus=source||activeSlot(),sourceTime=localTime(focus),target=state.target?structuredClone(state.target):null,targetModel=state.target?state.models[state.target.slot]:null;
 // Comparisons temporarily load this round's input into the baseline canvas.
 // New tasks must bind the untouched canonical project slots again.
 if(!await refreshModels({preserve:true})||!viewState.isCurrent(ticket))return;state.focus=focus;state.display='single';state.time=Math.min(activeModel()?.duration||0,sourceTime);$('focusSlot').value=focus;
 if(target&&target.slot===focus&&target.assetSha256===state.models[focus]?.meta.sha256)setTarget(target);
 else if(target?.bone&&correspondingJoint(state.models[focus],targetModel,target)){const m=state.models[focus],bone=correspondingJoint(m,targetModel,target);setTarget({slot:focus,assetSha256:m.meta.sha256,bone:rawName(m,bone),nodeIndex:m.parser?.associations?.get(bone)?.nodes,space:'bone-local',inferred:target.inferred});}
 state.panelMode='compose';state.explicitCompose=true;state.composerSource=focus;state.lineageParentJobId=focus==='candidate'&&job?.candidate?.sha256===activeModel()?.meta.sha256?job.id:null;$('request').value=prefill&&job?job.request:'';if(prefill&&job)$('preserve').value=job.preserve||'';
 $('composeKicker').textContent=focus==='candidate'?'基于当前版本':'提出修改';$('composeTitle').textContent=focus==='candidate'?'还想怎样调整？':'你想改哪里？';$('composeIntro').textContent=focus==='candidate'?'下一次会在当前版本上修改，最初原版继续保留。':'描述你想要的变化，让 Agent 处理余下的细节。';
 drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();jobsRenderSignature='';drawJobs();$('taskPanel').scrollIntoView({block:'nearest',behavior:'smooth'});$('request').focus({preventScroll:true});
}
const jobDetails=new Map(),jobDetailLoads=new Map();
function mergeJobSummary(summary){const cached=jobDetails.get(summary.id);return cached?.detailRevision===summary.detailRevision?cached:summary;}
async function ensureJobDetail(summary){
 if(!summary?.summaryOnly)return summary;
 const key=summary.id+':'+summary.detailRevision,ticket=viewState.capture();
 let pending=jobDetailLoads.get(key);
 if(!pending){pending=api('/api/jobs/'+encodeURIComponent(summary.id),'GET',undefined,{signal:ticket.signal}).finally(()=>jobDetailLoads.delete(key));jobDetailLoads.set(key,pending);}
 const job=await pending;if(!viewState.isUnchanged(ticket,summary.assetId)||job.id!==summary.id||(job.assetId||state.project?.legacyAssetId||'legacy')!==summary.assetId)return null;
 // A newer poll may have retired this summary while detail was in flight.
 const current=state.jobs.find(j=>j.id===summary.id);if(current?.detailRevision&&current.detailRevision!==summary.detailRevision)return null;
 const full={...job,assetId:summary.assetId,detailRevision:summary.detailRevision};jobDetails.delete(job.id);jobDetails.set(job.id,full);while(jobDetails.size>40)jobDetails.delete(jobDetails.keys().next().value);
 state.jobs=[full,...state.jobs.filter(j=>j.id!==job.id)].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));return full;
}
let historyLoading=false,historyLoadingAssetId=null,historyGeneration=0,historyRenderSignature='',jobsRenderSignature='';
async function loadJobHistory({more=false}={}){
 if(historyLoading&&historyLoadingAssetId===viewState.loadedAssetId)return;
 const ticket=viewState.capture(),assetId=viewState.loadedAssetId,generation=++historyGeneration;
 const append=more&&state.historyAssetId===assetId,offset=append?state.historyJobs.length:0;
 historyLoading=true;historyLoadingAssetId=assetId;$('historyMore').disabled=true;
 try{const wanted=append?30:Math.max(30,state.historyAssetId===assetId?state.historyJobs.length:0),pages=[];
  for(let loaded=0;loaded<wanted;loaded+=100){const page=await api('/api/jobs?page=1&assetId='+encodeURIComponent(assetId)+'&offset='+(offset+loaded)+'&limit='+Math.min(100,wanted-loaded),'GET',undefined,{signal:ticket.signal});
   if(generation!==historyGeneration||!viewState.isUnchanged(ticket,assetId))return;pages.push(page);if(!page.hasMore)break;
  }
  const page=pages[0],rows=pages.flatMap(p=>p.jobs);state.historyJobs=append?[...state.historyJobs,...rows.filter(j=>!state.historyJobs.some(old=>old.id===j.id))]:rows;state.historyAssetId=assetId;state.historyRevision=page.revision;state.historyHasMore=pages.at(-1).hasMore;state.historyTotal=page.total;historyRenderSignature='';drawJobs();
 }finally{if(generation===historyGeneration){historyLoading=false;$('historyMore').disabled=false;}}
}
function drawJobs(){
 const count=state.jobCounts?.[state.project?.activeAssetId]?.total??state.jobs.length;
 $('jobCount').textContent=count;$('headerJobCount').textContent=count;$('sidebarJobCount').textContent=count;
 const history=state.historyAssetId===state.project?.activeAssetId?state.historyJobs:[],historyKey=history.map(j=>j.id+':'+j.detailRevision).join('|');
 if(historyKey!==historyRenderSignature){historyRenderSignature=historyKey;const host=$('historyList');host.replaceChildren();
  for(const job of history){const card=el('button',undefined,'history-card');card.append(el('span',statusNames[job.state]||job.state,'status-label '+job.state),el('strong',job.request),el('small',(job.clip||'静态资源')+' · '+new Date(job.createdAt||Date.now()).toLocaleString([],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})));card.onclick=async()=>{const ticket=viewState.capture();try{const full=await ensureJobDetail(job);if(!full||!viewState.isUnchanged(ticket,job.assetId))return;state.selectedJob=job.id;state.panelMode='task';$('libraryDialog').close();if(full.state==='complete')await showCandidate(full,{restoreAppearance:true});else drawLatestJob();$('taskPanel').scrollIntoView({block:'nearest',behavior:'smooth'});}catch(e){fail(e);}};host.append(card);}
  if(!history.length)host.append(el('p',count?'打开修改记录后按需读取历史。':'每一次要求、候选和决定都会保存在这里。','clip-empty'));
 }
 $('historyMore').hidden=$('historyList').hidden||!state.historyHasMore||state.historyAssetId!==state.project?.activeAssetId;$('historyMore').textContent='加载更多记录（已显示 '+history.length+' / '+(state.historyTotal||count)+'）';
 const j=currentJob(),signature=[j?.id,j?.detailRevision,j?.updatedAt,j?.state,state.selectedJob,state.panelMode,state.agent?.connected,state.models.baseline?.meta.sha256,state.models.candidate?.meta.sha256,state.display,state.focus].join('|');
 if(signature===jobsRenderSignature){updateTaskClock();return;}jobsRenderSignature=signature;drawLatestJob();
}
function taskDetails(job,disclosures){
 const d=el('details');d.dataset.disclosure='execution';d.open=disclosures.get('execution')||false;d.append(el('summary','任务与执行详情'));
 const cmd=job.agentCommand||job.command,command=Array.isArray(cmd)?cmd.join(' '):cmd;
 if(command){d.append(actionButton('复制任务给其他 Agent',()=>copyText(command),'text-button'),el('pre',command));}
 const outputs=el('details');outputs.dataset.disclosure='outputs';outputs.append(el('summary','本轮输出与执行记录'));let outputLoading=false;outputs.addEventListener('toggle',async()=>{if(!outputs.open||outputLoading||outputs.dataset.loaded)return;outputLoading=true;const ticket=viewState.capture();try{const result=await api('/api/jobs/'+job.id+'/artifacts','GET',undefined,{signal:ticket.signal});if(!viewState.isUnchanged(ticket,job.assetId)||currentJob()?.id!==job.id)return;outputs.dataset.loaded='true';if(result.outputDirectory)outputs.append(el('p',result.outputDirectory));for(const file of result.files||[]){const link=el('a',file.file+' · '+(file.size/1024).toFixed(1)+' KB','download-candidate');link.href='/api/jobs/'+job.id+'/artifacts?file='+encodeURIComponent(file.file);link.download=file.file.split('/').at(-1);outputs.append(link);}if(!result.files?.length)outputs.append(el('p','这次执行尚未留下可下载文件。'));}catch(error){if(viewState.isUnchanged(ticket,job.assetId))outputs.append(el('p',error.message,'error-copy'));}finally{outputLoading=false;}});d.append(outputs);
 d.append(el('p','任务编号：'+job.id));if(job.taskPath||job.taskFile)d.append(el('p','任务文件：'+(job.taskPath||job.taskFile)));
 if(job.candidate)d.append(el('p','候选文件：'+job.candidate.file),el('p','候选 SHA-256：'+job.candidate.sha256));
 const trace=[...(job.events||[]),...(job.progressEvents||[])].sort((a,b)=>(a.at||'').localeCompare(b.at||''));for(const ev of trace.slice(-24))d.append(el('p',(ev.at?new Date(ev.at).toLocaleTimeString()+' · ':'')+(ev.phase?(phaseNames[ev.phase]||ev.phase)+' · ':'')+(typeof ev==='string'?ev:ev.message||ev.detail||ev.state||ev.type||JSON.stringify(ev))));
 return d;
}
function drawLatestJob(){
 if(!state.initialized){$('composePanel').hidden=true;$('latestJob').hidden=true;return;}
 const job=currentJob(),card=$('latestJob'),show=state.panelMode==='task'&&Boolean(job);$('composePanel').hidden=show;card.hidden=!show;updateWorkflow();if(!show){const candidate=state.composerSource==='candidate';$('composeKicker').textContent=candidate?'基于当前版本':'提出修改';$('composeTitle').textContent=candidate?'还想怎样调整？':'你想改哪里？';$('composeIntro').textContent=candidate?'下一次会在当前版本上修改，最初原版继续保留。':'描述你想要的变化，让 Agent 处理余下的细节。';return;}
 if(job.summaryOnly){card.replaceChildren(el('p','正在读取这条任务的详情…'));ensureJobDetail(job).then(full=>{if(full&&currentJob()?.id===full.id){jobsRenderSignature='';drawJobs();}}).catch(error=>{if(currentJob()?.id===job.id)card.replaceChildren(el('p',error.message,'error-copy'),actionButton('重新读取',()=>{jobsRenderSignature='';drawJobs();}));});return;}
 const same=card.dataset.jobId===job.id,disclosures=same?new Map([...card.querySelectorAll('details[data-disclosure]')].map(d=>[d.dataset.disclosure,d.open])):new Map();const reply=same?card.querySelector('#jobReply')?.value||'':'';const reviewReason=same?card.querySelector('#reviewReason')?.value||'':'',reviewText=same?card.querySelector('#reviewText')?.value||'':'';const transition=!same||card.dataset.state!==job.state;card.dataset.jobId=job.id;card.dataset.state=job.state;card.replaceChildren();
 const pending=['queued','running','needs-input'].includes(job.state),complete=job.state==='complete';
 const titles={queued:job.executor==='local'?'准备本地微调':state.agent?.connected?'任务已排队':'等待连接 Agent',running:job.executor==='local'?'正在生成数值候选':'Agent 正在修改',complete:'修改候选已返回','needs-input':'需要你补充一句',failed:'这次没有完成',cancelled:'任务已停止',stale:'素材版本已变化',interrupted:'执行已中断'};
 const symbol=el('div',job.state==='running'?undefined:complete?'✓':['failed','needs-input'].includes(job.state)?'!':'◷','state-symbol '+job.state);symbol.setAttribute('aria-hidden','true');card.append(symbol,el('span',complete?'检查结果':pending?'修改进展':'修改记录','section-kicker'),el('h2',titles[job.state]||statusNames[job.state]),el('p',jobText(job),job.state==='failed'?'error-copy':'task-explanation'));
 if(job.state==='running'){
  const progress=el('div',undefined,'progress-card');progress.append(el('span','当前进度','progress-kicker'),el('h3',job.executor==='local'?'按指定倍率调整摆幅':phaseNames[job.progress?.phase]||'Agent 正在执行'),el('p',job.progress?.message||(job.executor==='local'?'数值工具正在执行，不调用 AI。':'正在执行修改任务，尚未上报具体阶段。')));card.append(progress);
  const timing=el('div',undefined,'task-timing');const total=el('span');total.append(document.createTextNode('已用时 '),el('b','—'));total.dataset.clock='elapsed';const last=el('span');last.append(document.createTextNode('最近更新 '),el('b','—'));last.dataset.clock='last';timing.append(total,last);card.append(timing);
  if(job.activity?.message&&job.activity.message!==job.progress?.message){const activity=el('div',undefined,'activity-card');activity.append(el('small','最近活动'),el('p',job.activity.message));card.append(activity);}card.append(el('p','无需操作。你可以继续观察，候选返回后自动进入对照。','task-next'));const stale=el('p','','task-next');stale.dataset.clock='stale';card.append(stale);
 }
 if(job.state==='queued'){
  const info=el('div',undefined,'progress-card');info.append(el('span','现在需要做什么','progress-kicker'),el('h3',job.executor==='local'?'等待数值工具':state.agent?.connected?'无需操作，按顺序处理':'连接 Agent，开始这次修改'),el('p',job.executor==='local'?'正在生成明确参数的数值候选。':state.agent?.connected?(queuedAhead(job)?'前方 '+queuedAhead(job)+' 个任务，轮到后自动开始。':'已连接代表可以接收任务，当前尚未开始执行。'):'使用本机已登录的 Codex 账户。任务处理会计入该账户的正常用量。'));card.append(info);
  if(!state.agent?.connected&&job.executor!=='local'){const actions=el('div',undefined,'task-action-stack');actions.append(actionButton('连接 Codex 并开始修改',connectAgent,'primary-button'));if(state.agent?.lastError||state.agent?.error)actions.append(el('p',errorString(state.agent.lastError||state.agent.error),'error-copy'));card.append(actions);}
 }
 if(job.state==='needs-input'){
  const form=el('form',undefined,'answer-form'),label=el('label','补充给 Agent');label.htmlFor='jobReply';const input=el('textarea');input.id='jobReply';input.rows=3;input.required=true;input.placeholder='用一句话说明即可…';input.value=reply;const send=el('button','补充并继续','primary-button');send.type='submit';form.append(label,input,send);form.onsubmit=async e=>{e.preventDefault();if(!input.value.trim())return;send.disabled=true;try{await api('/api/jobs/'+job.id+'/reply','POST',{message:input.value.trim()});await pollStudio();}catch(error){fail(error);send.disabled=false;}};card.append(form);
 }
 if(complete){
  if(!viewMatchesJob(job)){card.append(el('p','当前画面是另一版本。先打开这条任务的修改前后，避免看错结果。','task-next'),actionButton('打开这次修改的对照',()=>showCandidate(job,{restoreAppearance:true}),'primary-button'));}
  if(job.summary){card.append(el('span','这次改了什么','result-label'));if(job.summary.length>420){card.append(el('p',job.summary.slice(0,350)+'…','result-summary'));const full=el('details');full.dataset.disclosure='summary';full.open=disclosures.get('summary')||false;full.append(el('summary','展开完整修改说明'),el('p',job.summary));card.append(full);}else card.append(el('p',job.summary,'result-summary'));}else card.append(el('p','候选已经生成。Agent 没有附上额外说明，请以动作与验证记录为准。','result-summary'));
  const checks=el('section',undefined,'result-checks');checks.append(el('span','检查与限制','result-label'));
  const data=job.audit&&typeof job.audit==='object'?job.audit:null,names={changedKeyframes:'修改关键帧',factor:'幅度倍率',bone:'目标部位',clip:'动作',protectedWorldMaxDifference:'保护部位最大差异',sourceUnchanged:'原版保持',sampling:'采样范围'};
  if(data)for(const[key,label]of Object.entries(names))if(data[key]!==undefined)checks.append(el('p',label+'：'+(typeof data[key]==='object'?JSON.stringify(data[key]):String(data[key]))));
  if(job.validation)checks.append(el('p','文件检查：'+(job.validation.status||'候选已通过资源校验')));
  const limitations=[data?.limitations,job.validation?.limitations].flatMap(value=>Array.isArray(value)?value:value?[String(value)]:[]);checks.append(el('p',limitations.length?(Array.isArray(limitations)?limitations.join('；'):String(limitations)):'尚未附上具体艺术检查限制，请播放完整动作并检查游戏内表现。','task-next'));
  checks.append(el('p','技术检查不会自动形成艺术认可；已认可版本仍需单独接入游戏。','task-next'));
  const raw=el('details');raw.dataset.disclosure='audit';raw.open=disclosures.get('audit')||false;raw.append(el('summary','原始检查 JSON'),el('pre',JSON.stringify({audit:job.audit||null,validation:job.validation||null,contextVerification:job.contextVerification||null},null,2)));checks.append(raw);card.append(checks);
  const versions=el('div',undefined,'version-provenance');const reviewDecision=job.review||job.reviews?.at(-1);
  versions.append(el('small','最初原版 · '+(job.inputs.baseline?.sha256?.slice(0,10)||'未知')),el('small','本轮修改前 · '+(jobSourceAsset(job)?.sha256?.slice(0,10)||'未知')),el('small',(reviewDecision?.decision==='accept-candidate'?'已认可候选':'本轮候选')+' · '+(job.candidate?.sha256?.slice(0,10)||'未知')));card.append(versions);
  const actions=el('div',undefined,'result-actions');const next=actionButton(state.archivedJobId?'返回当前素材后继续':'基于这版继续调整',()=>beginCompose({job,source:'candidate'}),'primary-button');next.disabled=Boolean(state.archivedJobId)||!viewMatchesJob(job);actions.append(next);
  if(job.candidate){const download=el('a','下载修改后的 GLB ↓','download-candidate');download.href='/workspace/'+job.candidate.file;download.download=job.candidate.label||'candidate.glb';actions.append(download);}
  const feedback=el('details',undefined,'review-feedback');feedback.dataset.disclosure='review';feedback.open=disclosures.get('review')||false;feedback.append(el('summary','评审意见（可选）'));
  const reasonLabel=el('label','未采用或继续修改的原因'),reason=el('select');reason.id='reviewReason';reasonLabel.htmlFor=reason.id;for(const [value,label] of [['','不选择原因'],['direction','修改方向不符合预期'],['too-much','变化幅度过大'],['too-little','变化不明显'],['regression','影响了需要保持的部分'],['quality','动作或模型出现问题'],['other','其他原因']]){const option=el('option',label);option.value=value;reason.append(option);}reason.value=reviewReason;
  const textLabel=el('label','补充说明'),text=el('textarea');text.id='reviewText';text.rows=2;text.placeholder='可以留空；例如右脚仍然滑动，希望继续修正。';text.value=reviewText;textLabel.htmlFor=text.id;feedback.append(reasonLabel,reason,textLabel,text);actions.append(feedback);
  const secondary=el('div',undefined,'result-secondary'),yes=actionButton('满意，保留这版',()=>recordDecision(job,'accept-candidate'),'text-button'),keep=actionButton('保留本轮修改前',()=>recordDecision(job,'keep-baseline'),'text-button');yes.disabled=!viewMatchesJob(job,true);keep.disabled=!viewMatchesJob(job);secondary.append(yes,keep);actions.append(secondary);card.append(actions);
  const accepted=(job.reviews?.at(-1)?.decision==='accept-candidate'?job.reviews.at(-1):null);if(accepted)card.append(actionButton('恢复这条已认可版本',async()=>{const ticket=viewState.beginMutation();if(!ticket)return;const result=await api('/api/jobs/'+job.id+'/restore','POST',{checkpointId:accepted.id,expectedRevision:state.project.revision});if(!viewState.isUnchanged(ticket,job.assetId))return;state.archivedJobId=null;state.project=result.project;if(!await refreshModels({preserve:true})||!viewState.isCurrentMutation(ticket,job.assetId))return;state.studioRevision=null;await pollStudio();toast('已恢复这条已认可版本。');},'secondary-button'));
  const review=job.review||job.reviews?.at(-1);if(review)card.append(el('p',review.decision==='accept-candidate'?'已记录保留此候选。下载后可用于后续游戏接入，原文件保持。':review.decision==='keep-baseline'?'已记录保留本轮修改前的版本。候选仍在历史中保留。':'已记录继续修改。','review-note'));if(review?.outcome)card.append(el('p',review.outcome,'review-note'));
 }else if(['failed','cancelled','stale','interrupted'].includes(job.state)){
  const actions=el('div',undefined,'task-action-stack');if(['failed','interrupted'].includes(job.state))actions.append(actionButton('重新执行这条任务',async()=>{const ticket=viewState.beginMutation();const result=await api('/api/jobs/'+job.id+'/retry','POST',{});if(!viewState.isUnchanged(ticket,job.assetId))return;commitJobResult(result,ticket);state.studioRevision=null;await pollStudio();},'secondary-button'));actions.append(actionButton(job.state==='stale'?'返回当前素材，重新确认':'沿用要求，修改后重试',async()=>{if(state.archivedJobId||job.state==='stale'){state.archivedJobId=null;await refreshModels({preserve:true});}await beginCompose({job,prefill:true});},'primary-button'));card.append(actions);
 }
 const request=el('details');request.dataset.disclosure='request';request.open=disclosures.get('request')||false;request.append(el('summary','我的修改要求'),el('p',job.request,'request-quote'));if(job.preserve)request.append(el('p','需要保持：'+job.preserve));for(const answer of job.clarifications||[])request.append(el('p','补充：'+answer.message));card.append(request);
 if(job.state==='running'){
  if((job.executionHealth?.status||job.executionHealth)==='unresponsive')card.append(el('p','执行器仍在运行，但已长时间没有心跳。可以中断本轮，再从保留的输入重试。','error-copy'));
  card.append(actionButton('中断执行，保留本轮',async()=>{const ticket=viewState.beginMutation();if(!ticket)return;const result=await api('/api/jobs/'+job.id+'/interrupt','POST',{});if(!viewState.isUnchanged(ticket,job.assetId))return;commitJobResult(result,ticket);state.studioRevision=null;await pollStudio();},'text-button'));
 }
 if(pending)card.append(actionButton('取消这次任务',async()=>{await api('/api/jobs/'+job.id+'/cancel','POST',{});await pollStudio();},'text-button'));
 card.append(frozenProjectDetails(job,disclosures),taskDetails(job,disclosures));updateTaskClock();if(transition)requestAnimationFrame(()=>$('taskPanel').scrollTop=0);
}
function updateTaskClock(){const j=currentJob();if(!j||state.panelMode!=='task')return;const started=j.claimedAt||j.startedAt||j.updatedAt,last=j.lastActivityAt||j.activity?.at||j.progress?.at||j.updatedAt;const card=$('latestJob'),a=card.querySelector('[data-clock="elapsed"] b'),b=card.querySelector('[data-clock="last"] b'),c=card.querySelector('[data-clock="stale"]');if(a)a.textContent=elapsedLabel(started);if(b)b.textContent=elapsedLabel(last)+'前';if(c){const seconds=(Date.now()-new Date(last).getTime())/1000;c.hidden=seconds<60;c.textContent=seconds>=60?'暂未收到新进展，上次实际更新在 '+elapsedLabel(last)+'前。任务仍保留，可继续等待或停止。':'';}}
const pendingDecisions=new Map();
async function recordDecision(job,decision){
 if(state.loading||state.switching||state.capturing||state.submitting)throw Error('正在准备当前画面，请稍候再记录决定。');
 const ticket=viewState.beginMutation();if(!ticket)return;
 if(!viewMatchesJob(job,decision==='accept-candidate'))throw Error('当前画面与此任务版本不一致，请先打开该任务的候选对照。');
 const currentHead=state.project?.slots.candidate?.sha256===job.candidate.sha256&&state.project?.slots.baseline?.sha256===job.inputs.baseline?.sha256;
 const reason=$('reviewReason'),note=$('reviewText')?.value.trim(),reasonText=decision!=='accept-candidate'&&reason?.value?reason.options[reason.selectedIndex].textContent:'';const outcome=[decision==='accept-candidate'?'用户在动作台选择保留此候选；游戏接入仍需单独验证。':'用户选择保留本轮修改前的版本，不采用本轮候选。',reasonText?'原因：'+reasonText:'',note?'评审意见：'+note:''].filter(Boolean).join('\n');
 const decisionKey=job.id+'|'+decision+'|'+outcome;let decisionId=pendingDecisions.get(decisionKey);if(!decisionId){decisionId=crypto.randomUUID();pendingDecisions.set(decisionKey,decisionId);}const result=await api('/api/jobs/'+job.id+'/review','POST',{decision,outcome,decisionId});pendingDecisions.delete(decisionKey);
 if(!viewState.isCurrentMutation(ticket)||state.switching)return result;commitJobResult(result,ticket);
 const restored=decision==='keep-baseline'&&currentHead&&result.restoredSource?.sha256===jobSourceAsset(job)?.sha256;
 if(restored){state.archivedJobId=null;if(!await refreshModels({preserve:true})||!viewState.isCurrentMutation(ticket))return result;state.focus='candidate';state.display='single';$('focusSlot').value='candidate';clearTarget();}
 await pollStudio();if(!viewState.isCurrentMutation(ticket)||state.switching)return result;
 if(restored){await beginCompose({source:'candidate'});if(!viewState.isCurrentMutation(ticket)||state.switching)return result;const parent=state.jobs.find(j=>j.id===job.parentJobId&&j.candidate?.sha256===state.models.candidate?.meta.sha256);if(parent){state.lineageParentJobId=parent.id;scheduleProjectPreview();}toast('已保留本轮修改前的版本，可在这版上继续。被撤下的候选仍在记录中。');}
 else toast(decision==='accept-candidate'?'已记录保留候选，游戏文件保持。':'已记录保留该任务修改前的版本，当前工作区未切换。');
 return result;
}
function drawAgent(){const connected=Boolean(state.agent?.connected);$('agentDot').classList.toggle('connected',connected);$('agentLabel').textContent=connected?'本机 Codex 已连接':'本机 Codex 未连接';$('agentConnect').title=connected?'仅表示可接收任务，点击断开本机 Codex。':'点击连接本机已登录的 Codex。';$('submitRequest').firstElementChild.textContent=state.submitting?'正在保存当前画面…':connected?'开始修改':'连接 Codex 并开始修改';$('submitHint').textContent=connected?'附上素材与当前画面，完成后自动显示前后对照。':'使用本机 Codex 账户及正常用量。原版与当前画面自动保留。';$('saveQueued').hidden=connected;updateWorkflow();}

let polling=false,pollErrors=0;
async function pollStudio(){
 if(polling||state.loading||state.switching||state.capturing||state.submitting)return;polling=true;let ticket=viewState.capture();
 try{
  const d=await api('/api/studio','GET',undefined,{assetId:ticket.assetId,signal:ticket.signal,compact:true,since:state.studioAssetId===ticket.assetId?state.studioRevision:null});
  if(d.unchanged){if(viewState.isUnchanged(ticket,d.assetId)){updateTaskClock();pollErrors=0;}return;}
  if(!d.project?.activeAssetId||state.switching||state.loading||state.capturing||state.submitting||!viewState.isUnchanged(ticket,d.project.activeAssetId))return;
  const previous=new Map(state.jobs.map(j=>[j.id,j.state]));
  state.allJobs=Array.isArray(d.jobs)?d.jobs:[];state.jobs=state.allJobs.filter(j=>(j.assetId||d.project.legacyAssetId||'legacy')===d.project.activeAssetId);if(d.version===3){state.jobs=state.jobs.map(mergeJobSummary);state.jobCounts=d.jobCounts||{};state.totalJobs=d.totalJobs;state.jobsRevision=d.jobsRevision;if(!$('historyList').hidden&&state.historyRevision!==d.jobsRevision)loadJobHistory().catch(fail);drawCatalog();}state.agent=d.agent||d.capabilities?.agent?.worker||null;drawAgent();if(d.capabilities?.runtime)environmentPanel.update(d.capabilities.runtime);
  const incoming=d.project?.slots?.candidate,changed=state.ready&&incoming&&incoming.sha256!==state.models.candidate?.meta.sha256;if(!changed)state.project=d.project;
  const completed=state.jobs.find(j=>j.state==='complete'&&previous.has(j.id)&&previous.get(j.id)!=='complete'&&j.candidate?.sha256===incoming?.sha256);if(completed)state.pendingCandidate={id:completed.id,assetId:completed.assetId};
  let resume=null;
  if(!state.initialized&&!state.explicitCompose){
   const pending=state.jobs.find(j=>['queued','running','needs-input'].includes(j.state));
   const undecided=state.jobs.find(j=>j.state==='complete'&&j.candidate&&j.candidate.sha256===incoming?.sha256&&!j.review&&!j.reviews?.length&&!j.artisticDecision&&j.inputs?.baseline?.sha256===d.project?.slots?.baseline?.sha256);
   const wanted=pending||undecided;
   if(wanted){state.selectedJob=wanted.id;state.panelMode='task';if(wanted.state==='complete')resume=wanted;}
   else{state.selectedJob=null;state.panelMode='compose';}
  }
  if(state.archivedJobId)state.project=d.project;
  else{
   if(changed){if(!await refreshModels({preserve:true})||!viewState.isCurrentMutation(ticket,d.project.activeAssetId)||state.switching||state.submitting)return;ticket=viewState.capture();}
   let result=completed||resume||state.jobs.find(j=>j.id===state.pendingCandidate?.id&&j.assetId===d.project.activeAssetId&&j.state==='complete'&&j.candidate?.sha256===incoming?.sha256);
   if(result?.summaryOnly){result=await ensureJobDetail(result);if(!result||!viewState.isUnchanged(ticket,d.project.activeAssetId)||state.switching||state.submitting)return;}
   if(result){if(!await showCandidate(result)||!viewState.isCurrentMutation(ticket,d.project.activeAssetId)||state.switching||state.submitting)return;ticket=viewState.capture();state.pendingCandidate=null;if(completed)toast('修改候选已返回，正在同镜头比较。');}
  }
  if(!viewState.isUnchanged(ticket,d.project.activeAssetId)||state.switching)return;
  drawJobs();updateDisplay();if(d.version===3){state.studioRevision=d.revision;state.studioAssetId=d.project.activeAssetId;}pollErrors=0;
 }catch(e){if(viewState.isCurrentMutation(ticket))state.studioRevision=null;if(e.name!=='AbortError'&&viewState.isCurrentMutation(ticket)&&!state.switching&&!state.submitting&&++pollErrors===2)notice('任务状态暂时无法同步：'+e.message+'。查看与已写意见保留。',true);}
 finally{polling=false;}
}

function commitJobResult(job,ticket){
 if(!job?.id||!viewState.isUnchanged(ticket,job.assetId)||state.project?.activeAssetId!==job.assetId||viewState.loadedAssetId!==job.assetId)return false;
 state.jobs=[job,...state.jobs.filter(j=>j.id!==job.id)];state.allJobs=[job,...(state.allJobs||[]).filter(j=>j.id!==job.id)];state.selectedJob=job.id;state.panelMode='task';drawJobs();updateClock();return true;
}
async function createJob(request,{local=false,operationTicket=null}={}){
 clearTimeout(projectPreviewTimer);projectPreviewSeq++;projectPreviewPendingKey=null;state.projectPreviewPending=false;
 if(!state.ready||state.loading||state.switching||!viewState.loadedAssetId)throw Error('请先载入角色素材。');if(state.archivedJobId)throw Error('正在查看历史版本，请先返回当前素材，再创建修改任务。');state.playing=false;render();const ctx=context(),range=scope();
 const ticket=operationTicket||viewState.beginMutation();if(!ticket||!viewState.isUnchanged(ticket))throw Error('观察版本已变化，请重新确认当前角色。');
 const body={assetId:viewState.loadedAssetId,request:request.trim(),preserve:$('preserve').value.trim(),target:state.target?structuredClone(state.target):null,scope:range,context:ctx,slot:activeSlot(),parentJobId:parentJobId(),executor:local?'local':'agent',screenshot:captureStage().toDataURL('image/png')};
 const result=await api('/api/jobs','POST',body);if(result.assetId!==body.assetId||!result.id)throw Error('服务返回的任务不属于提交的模型。');commitJobResult(result,ticket);return result;
}
async function submitRequest({connect=true}={}){
 if(state.submitting||state.switching||state.loading)return;const request=$('request').value.trim();if(!request)return $('request').focus();const ticket=viewState.beginMutation();if(!ticket)return;state.submitting=true;state.submissionOwner=ticket;drawMetadata();
 try{const result=await createJob(request,{operationTicket:ticket});if(!viewState.isUnchanged(ticket,result.assetId))return;$('request').value='';persistView();notice('');if(connect&&!state.agent?.connected)try{await connectAgent();}catch(error){if(viewState.isCurrentMutation(ticket))notice('任务已保存，连接没有完成：'+error.message,true);}if(viewState.isCurrentMutation(ticket))toast('修改要求与当前画面已保存，原版保持。');}
 catch(error){if(viewState.isCurrentMutation(ticket)){persistView();fail(error);}}finally{if(state.submissionOwner===ticket){state.submissionOwner=null;state.submitting=false;drawMetadata();drawLatestJob();}}
}
$('requestForm').onsubmit=e=>{e.preventDefault();submitRequest();};$('saveQueued').onclick=()=>submitRequest({connect:false});

async function runLocalEdit(){
 if(!state.ready||!viewState.loadedAssetId||!activeModel()?.action||state.submitting||state.switching||state.loading||state.capturing||state.archivedJobId)return;
 const bone=state.target?.bone||$('boneSelect').value;if(!bone){$('targetDialog').showModal();$('boneSelect').focus();toast('先点选一个部位，再试本地微调。');return;}
 const factor=Number($('swingFactor').value);let range;try{range=scope();}catch(error){fail(error);return;}
 let ticket=viewState.beginMutation();if(!ticket)return;const owner=ticket,assetId=viewState.loadedAssetId;let job,result;
 const current=()=>viewState.isCurrentMutation(ticket,assetId)&&viewState.loadedAssetId===assetId&&state.project?.activeAssetId===assetId&&!state.switching;
 state.submitting=true;state.submissionOwner=owner;drawMetadata();$('localEdit').disabled=true;$('localEdit').textContent='正在生成数值候选…';
 try{
  job=await createJob('本地数值微调：将 '+bone+' 的旋转摆动幅度调整为 '+Math.round(factor*100)+'%，其他骨骼与时长保持。',{local:true,operationTicket:ticket});
  if(!current()||!viewState.isUnchanged(ticket,job.assetId))return;
  result=await api('/api/jobs/'+job.id+'/local-edit','POST',{bone,factor,...(range.wholeClip?{}:{start:range.start,end:range.end})});
  if(!current()||!viewState.isUnchanged(ticket,assetId))return;
  if(result.id!==job.id||result.assetId!==assetId)throw Error('本地微调结果不属于提交的模型和任务。');
  commitJobResult(result,ticket);
  if(result.state!=='complete')throw Error(errorString(result.error)||'本地微调尚未完成，请查看这条任务的状态。');
  // The POST response is the authoritative full result. An in-flight poll can
  // still contain the queued snapshot and is never used as candidate input.
  if(!await refreshModels({preserve:true})||!current())return;ticket=viewState.capture();
  if(!await showCandidate(result)||!current())return;
  toast('本地数值候选已生成，请比较效果。');
 }catch(error){
  if(!current())return;
  if(job&&!result)try{const latest=await api('/api/jobs/'+job.id);if(current()&&latest.id===job.id&&latest.assetId===assetId)commitJobResult(latest,ticket);}catch{}
  if(current())fail(error);
 }finally{if(state.submissionOwner===owner){state.submissionOwner=null;state.submitting=false;drawMetadata();drawLatestJob();$('localEdit').textContent='生成本地微调候选';}}
}
$('localEdit').onclick=runLocalEdit;
$('agentConnect').onclick=async()=>{const connected=Boolean(state.agent?.connected);$('agentConnect').disabled=true;try{const result=await api(connected?'/api/agent/disconnect':'/api/agent/connect','POST',connected?{}:{provider:'codex'});await pollStudio();if(result.error)throw Error(errorString(result.error));toast(connected?'已断开本机 Agent。':'连接请求已提交，等待状态确认。');}catch(e){fail(e);}finally{$('agentConnect').disabled=false;}};
async function importFile(slot,file){
 if(!file||state.switching||state.loading||state.capturing||state.submitting)return;
 $('importDone').hidden=true;if(!/\.(glb|fbx|json)$/i.test(file.name))throw Error('请选择 GLB、FBX 或采样动作 JSON 文件。');
 persistView();const previousProject=state.project,previousURL=location.href,ticket=viewState.select(slot==='baseline'?null:state.project?.activeAssetId);let ownerTicket=ticket;
 state.switching=true;state.playing=false;$('importProgress').hidden=false;
 $('importProgress').textContent=/\.fbx$/i.test(file.name)?'正在用本机 Blender 转换 FBX，首次可能需要稍候…':'正在读取模型、检查动作并创建本地副本…';
 try{
  const imported=await api('/api/assets/'+slot+'?name='+encodeURIComponent(file.name)+(slot==='baseline'?'&newModel=true':'')+'&assetId='+encodeURIComponent(previousProject?.activeAssetId||''),'POST',file);
  if(!imported.assetId)throw Error('服务未返回导入模型的身份，请刷新后重试。');if(!viewState.isCurrent(ticket,imported.assetId))return;
  if(imported.assetId){state.project={...state.project,activeAssetId:imported.assetId};history.replaceState(null,'','?asset='+encodeURIComponent(imported.assetId));}
  if(!await refreshModels({preserve:false,selectionTicket:ticket})||!viewState.isCurrent(ticket,imported.assetId))return;
  state.focus=slot;state.display='single';state.panelMode='compose';state.explicitCompose=true;state.composerSource=slot;state.lineageParentJobId=null;state.selectedJob=null;state.archivedJobId=null;
  if(slot==='baseline'){$('request').value='';$('preserve').value='';}
  clearTarget();state.comparisonPair=slot==='candidate'?{baseline:state.models.baseline?.meta.sha256,candidate:state.models.candidate?.meta.sha256}:null;
  $('focusSlot').value=slot;drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();drawLatestJob();
  $('importProgress').textContent='已载入 '+file.name+'。源文件保留，历史反馈不覆盖。';$('importDone').hidden=false;
  state.switching=false;await pollStudio();if(!imported.assetId)throw Error('服务未返回导入模型的身份，请刷新后重试。');if(!viewState.isCurrent(ticket,imported.assetId))return;await refreshCatalog();if(!imported.assetId)throw Error('服务未返回导入模型的身份，请刷新后重试。');if(!viewState.isCurrent(ticket,imported.assetId))return;notice('');toast('素材副本已载入动作台。');
 }catch(error){
  if(!viewState.isCurrent(ticket))return;ownerTicket=viewState.select(previousProject?.activeAssetId);state.project=previousProject;history.replaceState(null,'',previousURL);
  try{await refreshModels({preserve:false,selectionTicket:ownerTicket});await restoreModelDraft();}catch{}
  $('importProgress').textContent='导入未完成：'+error.message;throw error;
 }finally{if(viewState.isCurrent(ownerTicket))state.switching=false;}
}
for(const [slot,id,zone]of[['baseline','fileBaseline','dropBaseline'],['candidate','fileCandidate','dropCandidate']]){$(id).onchange=async e=>{try{await importFile(slot,e.target.files[0]);}catch(e){fail(e);}finally{$(id).value='';}};const area=$(zone);area.addEventListener('dragover',e=>{e.preventDefault();area.classList.add('dragging');});area.addEventListener('dragleave',()=>area.classList.remove('dragging'));area.addEventListener('drop',async e=>{e.preventDefault();area.classList.remove('dragging');try{await importFile(slot,e.dataTransfer.files[0]);}catch(error){fail(error);}});}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function fourViews(){state.playing=false;state.capturing=true;const saved=context(),savedView=state.view;try{const out=document.createElement('canvas');out.width=1600;out.height=1060;const ctx=out.getContext('2d');ctx.fillStyle='#161e2a';ctx.fillRect(0,0,out.width,out.height);for(const [i,name]of['front','side','back','top'].entries()){view(name);render();const x=i%2*800,y=Math.floor(i/2)*530;ctx.fillStyle='#b8cbea';ctx.font='16px -apple-system,sans-serif';ctx.fillText(({front:'正面',side:'侧面',back:'背面',top:'俯视'}[name])+' · '+(activeModel()?.clip||'静态姿态')+' · '+saved.time.toFixed(3)+' s',x+20,y+29);const scale=Math.min(800/canvas.width,480/canvas.height),w=canvas.width*scale,h=canvas.height*scale;ctx.drawImage(canvas,x+(800-w)/2,y+42+(480-h)/2,w,h);}return await new Promise(resolve=>out.toBlob(resolve,'image/png'));}finally{cameraBusy=true;for(const slot of slots){cameras[slot].position.fromArray(saved.cameras[slot].position);controls[slot].target.fromArray(saved.cameras[slot].target);controls[slot].update();}cameraBusy=false;state.view=savedView;state.capturing=false;setViewButtons();render();updateClock();}}
let snapshotBlob,snapshotURL;
$('snapshotButton').onclick=async()=>{if(!state.ready||state.loading||state.switching||state.capturing)return;try{snapshotBlob=await fourViews();if(!snapshotBlob)throw Error('浏览器未能生成截图，请重试。');if(snapshotURL)URL.revokeObjectURL(snapshotURL);snapshotURL=URL.createObjectURL(snapshotBlob);$('snapshotImage').src=snapshotURL;$('snapshotDialog').showModal();}catch(e){fail(e);}};$('downloadSnapshot').onclick=()=>snapshotBlob&&downloadBlob(snapshotBlob,'motion-four-views.png');
$('exportFeedback').onclick=async()=>{try{const data=await api('/api/export');downloadBlob(new Blob([JSON.stringify({...data,studioVersion:3},null,2)],{type:'application/json'}),'motion-feedback.json');toast('反馈与修改任务已导出。');}catch(e){fail(e);}};
function openInfo(){const m=activeModel();if(!m)return;const host=$('sceneInfo');host.replaceChildren();const grid=el('div',undefined,'info-grid');for(const [number,label]of[[m.clips.length,'动作片段'],[m.joints.length,'骨骼 / 节点'],[m.meshes.length,'网格']]){const card=el('div');card.append(el('b',String(number)),el('small',label));grid.append(card);}host.append(grid,el('p','当前文件：'+m.meta.label),el('p','固定版本：'+m.meta.sha256),el('p','默认以修改前的静止最大尺寸归一化到 2 个显示单位，两版共用缩放与偏移；可在视角与显示中检查原始尺度和原点。'),el('p','审阅帧号从零计数，不是源 Blender / FBX 帧号。修改应以秒数和制作源映射定位。'),el('p','本预览不包含游戏中的运行时 IK、衣料、动作混合与特效；游戏接入需另行检查。'));$('contextJSON').textContent=JSON.stringify(context(),null,2);$('infoDialog').showModal();}
$('assetInfo').onclick=openInfo;$('viewInitialOriginal').onclick=async()=>{try{state.archivedJobId=null;await refreshModels({preserve:true});state.focus='baseline';state.display='single';$('focusSlot').value='baseline';clearTarget();drawLibrary();drawMetadata();updateDisplay();drawJobs();$('infoDialog').close();if($('libraryDialog').open)$('libraryDialog').close();notice('正在查看最初原版。任务中的“修改前”指该轮实际输入的版本。');}catch(error){fail(error);}};
$('navStudio').onclick=()=>{$('stage').scrollIntoView({block:'nearest',behavior:'smooth'});$('stage').focus({preventScroll:true});};
$('navLibrary').onclick=()=>$('openLibrary').click();$('navHistory').onclick=()=>$('openHistory').click();$('sidebarAssetInfo').onclick=openInfo;$('sidebarImport').onclick=()=>$('openAssets').click();$('sidebarHelp').onclick=()=>$('helpButton').click();
$('quickFit').onclick=()=>$('fitView').click();$('quickSnapshot').onclick=()=>$('snapshotButton').click();
$('openLibrary').onclick=()=>{setLibraryTab(false);$('libraryDialog').showModal();};$('openHistory').onclick=()=>{setLibraryTab(true);$('libraryDialog').showModal();};$('motionSelect').onchange=e=>selectMotion(e.target.value);
$('importDone').onclick=()=>{$('importDialog').close();$('stage').scrollIntoView({block:'center',behavior:'smooth'});};$('importMine').onclick=()=>$('importDialog').showModal();$('openSettings').onclick=()=>$('settingsDialog').showModal();$('projectButton').onclick=()=>openProjectDialog();$('linkProjectInline').onclick=()=>openProjectDialog();$('projectContextDetails').addEventListener('click',e=>{if(e.target===$('projectContextSummary')&&state.projectLink?.status!=='linked'){e.preventDefault();openProjectDialog();}});$('projectContextDetails').addEventListener('toggle',()=>{if($('projectContextDetails').open)scheduleProjectPreview();});$('request').addEventListener('input',()=>scheduleProjectPreview());
$('useSuggestedProject').onclick=()=>openLinkedProject(state.projectLink?.suggested?.root);$('projectPathForm').onsubmit=e=>{e.preventDefault();openLinkedProject($('projectPath').value);};$('confirmProjectFolder').onclick=()=>openLinkedProject(selectedProjectFolder);$('pickProjectFolder').onclick=async()=>{if(projectBusy)return;projectBusy=true;$('pickProjectFolder').disabled=true;projectStatus('请选择项目文件夹…');try{const result=await api('/api/project/select-folder','POST',{});if(result.cancelled){projectStatus('已取消选择，当前工作区保持。');return;}if(!result.path)throw Error('没有收到文件夹路径。');selectedProjectFolder=result.path;$('projectPath').value=result.path;$('projectSelectedPath').textContent=result.path;$('projectSelection').hidden=false;projectStatus('');}catch(error){projectStatus(error.message+'。也可以粘贴文件夹路径。',true);$('projectPathFallback').open=true;}finally{projectBusy=false;$('pickProjectFolder').disabled=false;}};
$('showAllBones').onchange=updateBoneChoices;$('openTarget').onclick=()=>$('targetDialog').showModal();$('localTarget').onclick=()=>$('targetDialog').showModal();
for(const id of ['openScope','scopeChip'])$(id).onclick=()=>$('scopeDialog').showModal();$('applyScope').onclick=()=>{try{scope();updateScopeVisual();$('scopeDialog').close();}catch(e){fail(e);}};
$('mobileTaskAction').onclick=()=>{$('taskPanel').scrollIntoView({block:'start',behavior:'smooth'});if(state.panelMode==='compose')setTimeout(()=>$('request').focus({preventScroll:true}),250);};
document.querySelectorAll('[data-version]').forEach(b=>b.onclick=()=>{state.display=b.dataset.version==='compare'?'split':'single';if(state.display==='single')state.focus=b.dataset.version;state.time=Math.min(state.time,duration());clearTarget();drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();drawJobs();});

$('openAssets').onclick=()=>$('importDialog').showModal();$('helpButton').onclick=()=>$('helpDialog').showModal();$('footerHelp').onclick=()=>$('helpDialog').showModal();document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());document.querySelectorAll('[data-help]').forEach(b=>b.onclick=()=>{for(const name of ['guide','case','connect'])$('help'+name[0].toUpperCase()+name.slice(1)).hidden=name!==b.dataset.help;document.querySelectorAll('[data-help]').forEach(x=>x.classList.toggle('active',x===b));});
function drawLoop(){$('loop').classList.toggle('active',state.loop);$('loop').setAttribute('aria-pressed',String(state.loop));$('loop').textContent=state.loop?'已开启':'已关闭';}
$('play').onclick=()=>{if(duration())state.playing=!state.playing;renderLoop.wake();updateClock();};$('restart').onclick=()=>{state.time=0;state.playing=duration()>0;render();updateClock();};$('prev').onclick=()=>seek(state.time-1/state.fps);$('next').onclick=()=>seek(state.time+1/state.fps);$('loop').onclick=()=>{state.loop=!state.loop;drawLoop();};$('timeline').oninput=e=>seek(e.target.value);$('speed').onchange=e=>state.speed=Number(e.target.value);$('lockRoot').onchange=render;$('bones').onchange=render;$('scaleMode').onchange=async()=>{
 state.observationTransform=null;
 try{
  if(appearance.mode==='project'){const refreshed=await refreshModels({force:true});if(!refreshed||!viewState.isUnchanged(refreshed.observationTicket))return;}
  else normalizePair();
  view(state.view==='orbit'?'front':state.view);
 }catch(error){fail(error);}
};$('progress').onchange=()=>{const slot=activeSlot(),time=observationTime(state.models,slot,state.time,{display:state.display,focus:state.focus,mode:$('progress').checked?'elapsed':'progress'});const plan={timeSlot:slot,localTime:time,display:state.display,focus:state.focus,settings:{mode:$('progress').checked?'progress':'elapsed'}};state.time=restoredTransportTime(plan,state.models);updateDisplay();render();};$('linkCameras').onchange=()=>{if($('linkCameras').checked){cameraBusy=true;cameras.baseline.position.copy(cameras.candidate.position);controls.baseline.target.copy(controls.candidate.target);cameras.baseline.fov=cameras.candidate.fov;cameras.baseline.updateProjectionMatrix();controls.baseline.update();cameraBusy=false;}render();};
$('returnCurrent').onclick=async()=>{try{state.archivedJobId=null;await refreshModels({preserve:true});drawLatestJob();notice('已返回当前素材，历史版本保持归档。');}catch(e){fail(e);}};
$('focusSlot').onchange=()=>{state.focus=$('focusSlot').value;state.time=Math.min(state.time,duration());clearTarget();drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();};document.querySelectorAll('[data-display]').forEach(b=>b.onclick=()=>{if(b.dataset.display!=='single'&&!state.models.candidate)return toast('请先载入候选素材。');state.display=b.dataset.display;state.time=Math.min(state.time,duration());clearTarget();drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();});document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>view(b.dataset.view));$('fitView').onclick=()=>view(state.view==='orbit'?'front':state.view);$('search').oninput=drawLibrary;
function setLibraryTab(history){if(history)loadJobHistory().catch(fail);$('search').closest('label').hidden=history;$('clipList').hidden=history;$('historyList').hidden=!history;$('historyMore').hidden=!history||!state.historyHasMore;$('clipsTab').classList.toggle('active',!history);$('historyTab').classList.toggle('active',history);}$('historyMore').onclick=()=>loadJobHistory({more:true}).catch(fail);$('clipsTab').onclick=()=>setLibraryTab(false);$('historyTab').onclick=()=>setLibraryTab(true);
function rangeAroundCurrent(){const d=activeModel()?.duration||0,t=localTime(activeSlot());$('scopeStart').value=String(Math.max(0,t-.15));$('scopeEnd').value=String(Math.min(d,t+.15));updateScopeVisual();}
$('scopeMode').onchange=()=>{const range=$('scopeMode').value==='range';$('scopeInputs').hidden=!range;$('scopeStart').disabled=!range;$('scopeEnd').disabled=!range;if(range)rangeAroundCurrent();updateScopeVisual();};$('scopeStart').oninput=updateScopeVisual;$('scopeEnd').oninput=updateScopeVisual;$('useCurrentTime').onclick=rangeAroundCurrent;
$('swingFactor').oninput=()=>$('factorLabel').textContent=Math.round(Number($('swingFactor').value)*100)+'%';document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{$('request').value=b.dataset.prompt;$('request').focus();scheduleProjectPreview();});$('retryLoad').onclick=()=>refreshModels({force:true}).catch(e=>fail(e,true));
window.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||document.querySelector('dialog[open]'))return;if(e.code==='Space'){e.preventDefault();$('play').click();}if(e.key==='ArrowLeft'){e.preventDefault();$('prev').click();}if(e.key==='ArrowRight'){e.preventDefault();$('next').click();}if(e.key==='/'){e.preventDefault();setLibraryTab(false);$('libraryDialog').showModal();$('search').focus();}if(e.key==='Escape')clearTarget();});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();state.playing=false;fail(Error('三维画面暂时中断。反馈已经保留，请刷新页面恢复。'),true);});
new ResizeObserver(size).observe($('stage'));
function continuousFrames(){return Boolean(appearanceRecovery||state.ready&&!state.loading&&!state.capturing&&(state.playing&&duration()||Object.values(state.models).some(m=>m.appearance&&(m.appearance.update||m.appearance.render))));}
let lastDOM=0;
renderLoop=createDemandLoop({requestFrame:requestAnimationFrame,cancelFrame:cancelAnimationFrame,shouldContinue:continuousFrames,onFrame(now,dt){
 if(appearanceRecovery&&!state.loading&&!state.switching&&!state.capturing&&!state.submitting){appearanceRecovery=false;if(Object.values(state.models).some(m=>m.appearance)){void refreshModels({force:true}).catch(fail);return;}}
 if(!state.ready||state.loading||state.capturing)return;
 const wasPlaying=state.playing;
 if(state.playing&&duration()){state.time+=dt*state.speed;if(state.time>duration()){if(state.loop)state.time%=duration();else{state.time=duration();state.playing=false;}}}
 render();if(state.playing&&now-lastDOM>60||wasPlaying&&!state.playing){updateClock();lastDOM=now;}
}});

async function loadCase(){try{const r=await fetch('/case/case.json');if(!r.ok)return;const c=await r.json();for(const section of c.sections||[]){$('caseContent').append(el('h3',section.title));for(const p of section.paragraphs||[])$('caseContent').append(el('p',p));if(section.quote)$('caseContent').append(el('blockquote',section.quote));for(const item of section.images||[]){const img=el('img');img.src='/case/'+item.file;img.alt=item.caption;$('caseContent').append(img,el('p',item.caption));}}const link=el('a','查看证据与来源记录');link.href='/case/evidence.json';link.target='_blank';$('caseContent').append(link);}catch{}}
let persistTimer;function persistView(){return saveViewDraft(()=>localStorage,viewState,state,()=>({context:context(),request:$('request').value,preserve:$('preserve').value,selectedJob:state.selectedJob,panelMode:state.panelMode,comparisonPair:state.comparisonPair,composerSource:state.composerSource,lineageParentJobId:state.lineageParentJobId,composerIntent:state.panelMode==='compose'&&Boolean(state.composerSource||$('request').value.trim())}));}window.addEventListener('beforeunload',persistView);document.addEventListener('visibilitychange',()=>{if(document.hidden)persistView();});persistTimer=setInterval(persistView,5000);
try{await refreshModels();await restoreModelDraft();await pollStudio();state.initialized=true;$('taskRestoring').hidden=true;$('taskFooter').hidden=false;drawMetadata();drawLatestJob();updateDisplay();}catch(e){state.initialized=true;$('taskRestoring').hidden=true;$('taskFooter').hidden=false;drawLatestJob();fail(e,true);}loadProjectIdentity().catch(error=>{$('projectButton').title='项目状态暂未同步：'+error.message;});loadCase();refreshCatalog().catch(e=>catalogMessage(e.message,true));setInterval(()=>{pollStudio();if(state.catalog?.scan?.state==='scanning'||$('modelCatalogDialog').open)refreshCatalog().catch(e=>catalogMessage(e.message,true));},1800);setInterval(updateTaskClock,1000);
window.motionReview={state,openCatalogModel,refreshCatalog,seek,view,refresh:refreshModels,render,context,cameras,controls,showCandidate,pollStudio,clearTarget,selectMotion};
