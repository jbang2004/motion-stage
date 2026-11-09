import {callerLabel,callerKey,restoredDelivery,executorLabel} from './caller.mjs';
import {createCastBrowser} from './cast-browser.mjs';
import {createDraftSync} from './draft-sync.mjs';
import {createIntegrationPanel,createRuntimeHandoff,taskHandoff} from './handoff.mjs';
import {createThumbnailStudio} from './thumbnail-studio.mjs';
import {classifyAction} from './action-taxonomy.mjs';
import {createMotionWorkspace} from './motion-workspace.mjs';
import {createReplacementHandoff} from './action-replacement.mjs';
import {runtimeMotionClips} from './motion-runtime.mjs';
import {findJoint,jointValue,selectedJoint,correspondingJoint} from './joint-targets.mjs';
import {createModelLoader} from './gltf-loader.mjs';
import {prepareResource,createResourcePanel} from './resource-preview.mjs';
import {resourceLabel} from './resource-capabilities.mjs';
import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {icon,decorateIcons,element as el,createActionButton} from './ui.mjs';
import {activeStudioJob,currentStudioCandidate,currentComparison,canFollowCandidate,workspaceViewOutdated} from './studio-sync.mjs';
import {createViewState,saveViewDraft,readViewDraft} from './view-state.mjs';
import {createModelCatalog} from './model-catalog.mjs';
import {projectArray,renderProjectContext as renderContext} from './project-context-view.mjs';
import {createAssetLoader} from './asset-loader.mjs';
import {createAppearanceController,disposeAppearance,withRendererState,renderAppearance,captureResources,disposeResources} from './project-appearance.mjs';
import {createEnvironmentPanel} from './environment-view.mjs';
import {createRuntimePreview} from './runtime-preview.mjs';
import {createRuntimeStage,runtimeStageSource} from './runtime-stage.mjs';
import {parseOfflineState,modelPreviewStates,bindOfflineAttachments,resetOfflineAttachments,poseOfflineAttachments} from './offline-state.mjs';
import {observationDuration,observationTime,planObservationRestore,restoredTransportTime,observationFrame,observationFrameOptions} from './observation-state.mjs';
import {createDemandLoop} from './render-loop.mjs';
import {resultEvidence,candidateDiffEvidence,protectionMessage} from './result-evidence.mjs';
import {editRotationTrack} from './rotation-edit.mjs';
import {createUndoControls} from './undo-controls.mjs';
import {installShortcuts} from './shortcuts.mjs';
import {sideConflict,mirrorBoneName,SIDE_NAMES} from './body-side.mjs';
import {MAX_FEEDBACK_POINTS,pointsForClip,validateFeedbackPoints,feedbackObservation,feedbackPointList} from './feedback-points.mjs';
import {footDiagnosticReport,footRepairEvidence} from './foot-diagnostics.mjs';
import {footRepairScope,validateFootRepair} from './foot-repair.mjs';

decorateIcons();

const $=id=>document.getElementById(id),slots=['baseline','candidate'];
let localPreview=null;
let footDiagnosis=null;
const state={switching:false,allJobs:[],jobCounts:{},totalJobs:0,candidateJobId:null,jobsRevision:null,studioRevision:null,studioAssetId:null,historyJobs:[],historyAssetId:null,historyRevision:null,historyHasMore:false,historyTotal:0,catalog:null,initialized:false,ready:false,loading:false,playing:false,loop:true,time:0,speed:1,fps:30,display:'single',focus:'baseline',view:'front',models:{},project:null,token:null,paths:{},jobs:[],agent:null,target:null,selectedJob:null,archivedJobId:null,capturing:false,submitting:false,submissionOwner:null,panelMode:'compose',composerSource:null,comparisonPair:null,observationTransform:null,explicitCompose:false,projectLink:null,projectPreview:null,projectPreviewError:null,lineageParentJobId:null,feedbackPoints:[]};
let renderLoop,castBrowser;
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
function toast(message,action=null){$('toast').textContent=message;if(action){const b=el('button','撤销','text-button');b.type='button';b.onclick=action;$('toast').append(b);}$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function notice(message,error=false){$('notice').textContent=message;$('notice').hidden=!message;$('notice').classList.toggle('error',error);}
function fail(e,fatal=false){if(e?.code==='MODEL_JOB_ACTIVE')scheduleStudioSync();const message=e?.message||String(e);notice(message,true);if(fatal){$('errorMessage').textContent=message;$('stageError').hidden=false;$('stageLoading').hidden=true;}console.error(e);}
async function api(path,method='GET',body,request={}){if(method==='GET'&&['/api/session','/api/studio','/api/undo'].includes(path)){const params=new URLSearchParams(),id=request.assetId??state.project?.activeAssetId??new URLSearchParams(location.search).get('asset');if(id)params.set('assetId',id);if(request.compact){params.set('compact','1');if(request.since)params.set('since',request.since);if(state.selectedJob)params.set('jobId',state.selectedJob);}if(params.size)path+='?'+params;}const response=await fetch(path,{method,signal:request.signal,keepalive:method!=='GET'&&(path==='/api/runtime-preview/release'||path.startsWith('/api/drafts/')&&JSON.stringify(body).length<15000),headers:method==='GET'?{}:{'x-motion-token':state.token,'Content-Type':body instanceof Blob?'application/octet-stream':'application/json'},body:body===undefined?undefined:body instanceof Blob?body:JSON.stringify(body)});let data;try{data=await response.json();}catch{throw Error('工作台服务没有返回有效结果，请检查服务是否仍在运行。');}if(!response.ok){if(data.code==='MODEL_JOB_ACTIVE')scheduleStudioSync();throw Object.assign(Error(data.error||'请求失败（'+response.status+'）'),{code:data.code});}return data;}
const environmentPanel=createEnvironmentPanel({button:$('openEnvironment'),dialog:$('environmentDialog'),body:$('environmentResults'),recheck:$('recheckEnvironment'),close:$('closeEnvironment'),reload:$('reloadEnvironment'),loadReport:refresh=>api('/api/doctor'+(refresh?'':'?cached=1'))});
const runtimePreviewDialog=$('runtimePreviewDialog');
let offlineSelection=null;
const renewRuntime=lease=>api('/api/runtime-preview/renew','POST',{lease});
const releaseRuntime=lease=>api('/api/runtime-preview/release','POST',{lease});
const handoffRuntime=createRuntimeHandoff({
 dialog:$('runtimeHandoffDialog'),body:$('runtimeHandoffBody'),copy:copyText,
 request:input=>api('/api/runtime-preview/handoff','POST',input),
});
const runtimeStage=createRuntimeStage({
 stage:$('stage'), host:$('runtimeStageFrame'), button:$('runtimeStageMode'), assetButton:$('assetStageMode'),
 status:$('runtimeStageStatus'), transport:$('runtimeStageTransport'), timeline:$('runtimeStageTimeline'),
 play:$('runtimeStagePlay'), clock:$('runtimeStageClock'), load:loadPreviewStates, renew:renewRuntime, release:releaseRuntime,
 setup:$('runtimeStageSetup'), retry:$('runtimeStageRetry'), handoff:handoffRuntime,
 current:runtimeStageInput,
 onMode:active=>{$('taskPanel').inert=active;},
 onReturn:()=>{render();updateClock();},
});
function runtimeStageInput(){
 const model=activeModel(), selectedClip=model?.clip;
 const {file,clip}=runtimeStageSource(model?.meta.source,selectedClip);
 return {assetId:viewState.loadedAssetId, sourceId:JSON.stringify([model?.meta.sha256,selectedClip,file]), file, clip, selectedClip,
  time:localTime(activeSlot()), playing:state.playing, loop:state.loop,
  speed:state.speed, view:state.view,
  ineligible:!state.ready||!file||!viewState.loadedAssetId||state.display!=='single'||activeSlot()!=='baseline'||
   Boolean(state.motionPreview||localPreview||state.archivedJobId||state.capturing||state.submitting)};
}
createRuntimePreview({
 button:$('openRuntimePreview'),dialog:runtimePreviewDialog,title:$('runtimePreviewCharacter'),
 status:$('runtimePreviewStatus'),mode:$('runtimePreviewMode'),select:$('runtimePreviewState'),refresh:$('refreshRuntimeStates'),
 apply:$('applyOfflineState'),clear:$('clearOfflineState'),
 frameHost:$('runtimePreviewFrame'),external:$('openRuntimeExternal'),
 currentAsset:()=>({id:viewState.loadedAssetId,name:state.project?.title}),
 currentPreset:activeOfflinePreset,applyPreset:applyOfflinePreset,
 loadStates:loadPreviewStates,
 renew:renewRuntime, release:releaseRuntime,
});
runtimePreviewDialog.addEventListener('close',()=>renderLoop?.wake());
$('openRuntimePreview').addEventListener('click',()=>runtimeStage.stop(),{capture:true});
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
 api,defaultView:'files',
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

// A trial owns only clip bindings; canonical model heads remain untouched.
const motionReturns=new Map();let navigationEpoch=0;
const undoControls=createUndoControls({api,begin:()=>viewState.beginMutation(),isCurrent:ticket=>viewState.isUnchanged(ticket),getTarget:()=>({assetId:state.project?.activeAssetId,blocked:state.loading||state.switching||state.submitting||state.capturing||Boolean(state.archivedJobId)||Boolean(activeTask())||staleWorkspaceView()}),onError:fail,onApplied:async (result,ticket)=>{
 const assetId=result.assetId;if(assetId!==state.project?.activeAssetId)return;
 if(result.replacementPlans){replacementPlanRead++;replacementPlans={assetId,rows:result.replacementPlans};castBrowser?.draw();}
 if(result.replacementClip){await showReplacementVersion(result);if(!viewState.isCurrent(ticket,assetId))return;}
 if(result.job){clearMotionTrial(false);state.archivedJobId=null;state.project=result.project;state.panelMode='task';state.selectedJob=result.job.id;state.explicitCompose=false;commitJobResult(result.job,ticket);if(!await refreshModels({preserve:true,needCandidate:true})||!viewState.isCurrent(ticket,assetId))return;state.focus='candidate';state.display='single';drawLibrary();drawMetadata();updateDisplay();jobsRenderSignature='';drawJobs();}
 await castBrowser?.refresh();await motionWorkspace.refresh();if(!viewState.isCurrent(ticket,assetId))return;state.studioRevision=null;await pollStudio();notice(result.message);toast(result.message);persistView();
}});
async function offerUndo(message){await undoControls.refresh();const history=undoControls.current(),entry=history?.undo;toast(message,entry&&!history.reason?()=>undoControls.run('undo',{assetId:history.assetId,id:entry.id}):null);}
function rememberMotion(){const m=activeModel(),id=state.project?.activeAssetId;if(!id||!m||state.motionPreview)return;const rows=motionReturns.get(id)||[];rows.push({context:context(),playing:state.playing,sha:m.meta.sha256});motionReturns.set(id,rows.slice(-20));}
function drawRecovery(){undoControls.draw();const rows=motionReturns.get(state.project?.activeAssetId)||[];const prior=rows.at(-1);$('previousMotion').disabled=!prior||Boolean(state.motionPreview)||state.loading||state.switching;$('previousMotion').title=prior?'返回 '+(prior.context.clip||'上一动作'):'切换动作后可返回';}
async function endMotionTrial(){const epoch=++navigationEpoch,anchor=state.trialReturn;castBrowser?.cancelPreview();clearMotionTrial();if(anchor&&anchor.context.assetId===state.project?.activeAssetId){await restoreContext(anchor.context,{isCurrent:()=>epoch===navigationEpoch});if(epoch!==navigationEpoch||anchor.context.assetId!==state.project?.activeAssetId)return;state.playing=anchor.playing;updateClock();renderLoop?.wake();}notice('已回到试播前的动作和观察位置。');}
$('previousMotion').onclick=async()=>{const epoch=++navigationEpoch;try{castBrowser?.cancelPreview();const rows=motionReturns.get(state.project?.activeAssetId)||[],prior=rows.at(-1);if(!prior)return;const m=state.models[prior.context.slot];if(m?.meta.sha256!==prior.sha){rows.length=0;drawRecovery();return toast('动作版本已变化，请重新选择。');}rows.pop();await restoreContext(prior.context,{isCurrent:()=>epoch===navigationEpoch});if(epoch!==navigationEpoch||prior.context.assetId!==state.project?.activeAssetId)return;state.playing=prior.playing;drawRecovery();updateClock();renderLoop?.wake();}catch(e){fail(e);}};
$('backFromCompose').onclick=async()=>{try{persistView();const job=currentJob();if(job){state.panelMode='task';state.explicitCompose=false;if(job.state==='complete')await showCandidate(job);else drawLatestJob();}else castBrowser.setMode('library');toast('草稿已保留');}catch(e){fail(e);}};
const assetThumbnails=new Map();
const motionWorkspace=createMotionWorkspace({api,onAdopt:async r=>{await castBrowser?.refresh();if(r.action?.recipe?.assetId===state.project?.activeAssetId)await offerUndo(r.removed?'已移出常用':'已加入常用');},
 onThumbnail:(id,sha)=>{const m=activeModel(),key=id+'|'+sha;if(id===state.project?.activeAssetId&&m?.meta.sha256===sha&&m.capabilities.hasMesh&&!state.motionPreview&&!assetThumbnails.has(key)){render();assetThumbnails.set(key,canvas.toDataURL('image/webp',.7));while(assetThumbnails.size>24)assetThumbnails.delete(assetThumbnails.keys().next().value);}return assetThumbnails.get(key);},
 getTarget:()=>({assetId:state.project?.activeAssetId,slot:activeSlot(),expectedModelSha:activeModel()?.meta.sha256,clip:activeModel()?.clip}),
 onPreview:async (result,isCurrent=()=>true)=>{
  if(state.motionPreview?.replacement)throw Error('请先确认或取消动作替换');
  if(state.archivedJobId||state.loading||state.switching||state.submitting)throw Error('请先返回当前角色，等待载入结束后试播');
  const slot=result.recipe.slot,m=state.models[slot];if(!m||m.meta.sha256!==result.recipe.modelSha||state.project.activeAssetId!==result.recipe.assetId)throw Error('角色版本已变化，请重新选择动作');
  const clips=await runtimeMotionClips(T,result.clips,async index=>{const node=await m.parser.getDependency('node',index);if(!m.root.getObjectByProperty('uuid',node.uuid))throw Error('动作目标不在当前角色场景中');return node;});
  if(!isCurrent())return;
  if(state.models[slot]!==m)throw Error('模型已切换，请重新试播');
  navigationEpoch++;persistView();const anchor=state.trialReturn||{context:context(),playing:state.playing};clearMotionTrial(false);state.trialReturn=anchor;m.libraryOriginalClips=m.clips;m.libraryOriginalClip=m.clip;m.clips=clips;state.motionPreview={recipe:result.recipe,slot};state.focus=slot;state.display='single';state.time=0;state.playing=true;selectClip(slot,clips[0].name);drawLibrary();drawMetadata();drawJobs();updateDisplay();renderLoop?.wake();notice('正在试播其他来源的兼容动作。可直接切换，满意后加入常用。');
 },
 onExitPreview:endMotionTrial,
 onPrepare:async result=>{if(state.project?.activeAssetId!==result.project.activeAssetId||state.project.revision>result.project.revision)return;clearMotionTrial(false);state.project=result.project;state.selectedJob=null;state.archivedJobId=null;state.panelMode='compose';state.studioRevision=null;await refreshModels({preserve:false,needCandidate:true,preparedProject:result.project});state.focus='candidate';state.display='single';await selectMotion(result.recipe.clip);await beginCompose({source:'candidate'});notice('已准备独立动作工作版本。修改会生成角色专属候选，公共动作源保持固定。');},
 onOpenModel:async (id,{character=false}={})=>{if(id!==state.project?.activeAssetId)await openCatalogModel(id,{stored:!character,character});},
 onImport:()=>$('openAssets').click(),onCatalog:()=>$('openModelCatalog').click(),onError:fail
});
let replacementPlans={assetId:null,rows:[]},replacementPlanRead=0,replacementTargetRead=0;
const currentPlans=()=>replacementPlans.assetId===viewState.loadedAssetId?replacementPlans.rows:[];
async function refreshReplacementPlans(assetId=viewState.loadedAssetId){
 if(!assetId)return;
 const sequence=++replacementPlanRead;
 try{
  const {plans}=await api('/api/actions/replacement-plans?'+new URLSearchParams({assetId}));
  if(sequence!==replacementPlanRead||assetId!==viewState.loadedAssetId)return;
  if(assetId!==replacementPlans.assetId||JSON.stringify(plans)!==JSON.stringify(replacementPlans.rows)){
   replacementPlans={assetId,rows:plans};castBrowser?.draw();
  }
 }catch(error){if(sequence===replacementPlanRead&&assetId===viewState.loadedAssetId)console.warn(error);}
}
const openReplacementHandoff=createReplacementHandoff({api,dialog:$('replacementHandoffDialog'),list:$('replacementHandoffPlans'),
 copyButton:$('copyReplacementHandoff'),status:$('replacementHandoffStatus'),preview:$('replacementHandoffText'),copy:copyText});
$('handoffReplacements').onclick=()=>openReplacementHandoff(currentPlans().filter(plan=>!plan.integration));
const replacementIsCurrent=trial=>state.replacement===trial&&state.models[trial.request.slot]===trial.model&&
 trial.model.meta.sha256===trial.request.expectedModelSha&&viewState.loadedAssetId===trial.request.assetId;

async function startReplacement(name,plan=null){
 if(state.loading||state.switching||state.capturing||state.submitting||state.archivedJobId||state.display!=='single')return;
 const attempt=++replacementTargetRead;
 if(state.motionPreview)await endMotionTrial();
 if(attempt!==replacementTargetRead)return;
 if(plan&&plan.modelSha!==activeModel()?.meta.sha256){
  const planSlot=[plan.slot,...slots].find(slot=>state.project?.slots[slot]?.sha256===plan.modelSha);
  if(!planSlot)throw Error('方案基于旧素材，请重新选择来源');
  await showVersion('single',planSlot);
  if(attempt!==replacementTargetRead)return;
 }
 const model=activeModel(),slot=activeSlot(),assetId=viewState.loadedAssetId;
 if(!assetId||!model?.clips.some(clip=>clip.name===name))return;
 if(plan&&plan.modelSha!==model.meta.sha256)throw Error('方案基于旧素材，请重新选择来源');
 const ticket=viewState.capture(),epoch=navigationEpoch;
 const original=await model.resolveClip(name);
 if(attempt!==replacementTargetRead||epoch!==navigationEpoch||!viewState.isUnchanged(ticket)||activeModel()!==model)return;
 if(!original?.tracks.length)throw Error('这段动作没有可试播的轨道');
 runtimeStage.stop();persistView();
 state.trialReturn={context:context(),playing:state.playing};
 model.libraryOriginalClips=model.clips;model.libraryOriginalClip=model.clip;
 state.motionPreview={replacement:true,slot};
 const request={assetId,slot,expectedModelSha:model.meta.sha256,clip:name,
  expectedPlanId:currentPlans().find(row=>row.clip===name)?.id??null};
 const trial=state.replacement={request,model,original,sequence:0,sourceLabel:'',targetLabel:classifyAction(name).label};
 state.time=0;playReplacement(trial,original);drawReplacementBar(trial);
 castBrowser.focusReplacementSources(!plan);
 if(plan)await chooseReplacementSource({kind:'plan',id:plan.id});
}

function playReplacement(trial,clip){
 if(!replacementIsCurrent(trial))return;
 const {model,request}=trial;
 model.mixer.stopAllAction();
 model.clips=[clip];selectClip(request.slot,clip.name);
 state.time=Math.min(state.time,clip.duration);state.playing=true;trial.showing=clip===trial.original?'original':'replacement';
 drawMetadata();updateDisplay();renderLoop.wake();
}

async function chooseReplacementSource(source){
 const trial=state.replacement;if(!trial||state.submitting)return;
 const {request,model}=trial;
 if(source.kind==='own'&&source.name===request.clip){playReplacement(trial,trial.original);drawReplacementBar(trial);return;}
 const attempt=++trial.sequence;
 trial.pending=true;trial.error=null;drawReplacementBar(trial);castBrowser.updateReplacement();
 try{
  const result=await api('/api/actions/replacement-preview','POST',{...request,source});
  const replacement=result.action.tracks
   ?(await runtimeMotionClips(T,[result.action],async index=>{
    const node=await model.parser.getDependency('node',index);
    if(!model.root.getObjectByProperty('uuid',node.uuid))throw Error('动作目标不在当前角色场景中');
    return node;
   }))[0]
   :await resolveClip(model.libraryOriginalClips?.find(clip=>clip.name===result.action.name));
  if(!replacementIsCurrent(trial)||attempt!==trial.sequence)return;
  if(!replacement?.tracks.length)throw Error('所选动作没有可试播的轨道');
  if(trial.preview){model.mixer.stopAllAction();model.mixer.uncacheClip(trial.preview);}
  trial.sourceLabel=[replacement.name,result.action.sourceName].filter(Boolean).join(' · ');
  trial.preview=new T.AnimationClip(request.clip,replacement.duration,replacement.tracks,replacement.blendMode);
  trial.selection={source,previewId:result.previewId};
  playReplacement(trial,trial.preview);
 }catch(error){if(replacementIsCurrent(trial)&&attempt===trial.sequence)trial.error=error.message;}
 finally{
  if(replacementIsCurrent(trial)&&attempt===trial.sequence){
   trial.pending=false;drawReplacementBar(trial);castBrowser.updateReplacement();
  }
 }
}

function drawReplacementBar(trial){
 const bar=$('replacementPreviewBar'),{original,preview,request}=trial;
 const summary=el('div');summary.append(el('b',request.clip+(preview?' → '+trial.sourceLabel:'')));
 summary.append(el('small',trial.error||(trial.pending?'正在读取替换动作…':preview?
  original.duration.toFixed(2)+' → '+preview.duration.toFixed(2)+' 秒':'点击动作库中的来源试播。')));
 const controls=[];
 if(preview){
  for(const [label,clip,key] of [['原动作',original,'original'],['替换动作',preview,'replacement']]){
   const button=actionButton(label,()=>{playReplacement(trial,clip);drawReplacementBar(trial);},'mw-button');
   button.setAttribute('aria-pressed',String(trial.showing===key));controls.push(button);
  }
  if(trial.selection.source.kind!=='plan'){
   const save=actionButton('保存替换方案',()=>saveReplacement(trial),'mw-button mw-primary');
   save.disabled=trial.pending||state.submitting||Boolean(trial.error);
   controls.push(save);
  }
 }
 controls.push(actionButton(trial.selection?.source.kind==='plan'?'结束对比':'取消替换',()=>state.submitting?undefined:endMotionTrial(),'mw-button'));
 bar.replaceChildren(summary,...controls);bar.hidden=false;
}

async function saveReplacement(trial){
 if(!replacementIsCurrent(trial)||state.submitting||trial.pending)return;
 const operation=viewState.beginMutation();
 if(!operation)return;
 state.submitting=true;drawReplacementBar(trial);
 try{
  const saved=await api('/api/actions/replace','POST',{...trial.request,...trial.selection});
  if(!viewState.isUnchanged(operation,trial.request.assetId))return;
  replacementPlanRead++;replacementPlans={assetId:trial.request.assetId,rows:saved.plans};
  await endMotionTrial();
  if(await selectMotion(trial.request.clip,{remember:false}))castBrowser.revealAction(trial.request.clip);
  await offerUndo('已保存替换方案 · 待接入');
 }catch(error){if(replacementIsCurrent(trial))trial.error=error.message;}
 finally{
  state.submitting=false;drawMetadata();castBrowser.draw();
  if(replacementIsCurrent(trial))drawReplacementBar(trial);
 }
}
async function withdrawReplacement(plan){
 if(state.submitting||state.switching||state.loading||state.replacement||plan.assetId!==viewState.loadedAssetId)return;
 const operation=viewState.beginMutation();if(!operation)return;
 state.submitting=true;
 try{
  const result=await api('/api/actions/replacement-withdraw','POST',{assetId:plan.assetId,id:plan.id});
  if(!viewState.isUnchanged(operation,plan.assetId))return;
  replacementPlanRead++;replacementPlans={assetId:plan.assetId,rows:result.plans};
  await offerUndo('已撤回替换方案');
 }finally{state.submitting=false;castBrowser.draw();}
}
async function showReplacementVersion(result){
 clearMotionTrial(false);
 const changed=result.project.slots.candidate?.sha256!==result.project.slots.baseline?.sha256;
 if(!await refreshModels({needCandidate:changed,preparedProject:result.project}))return;
 state.focus=changed?'candidate':'baseline';state.display='single';
 state.studioRevision=null;state.archivedJobId=null;
 await selectMotion(result.replacementClip,{remember:false});
 updateDisplay();drawJobs();void castBrowser.refresh();
}
function clearMotionTrial(redraw=true){
 if(!state.motionPreview)return;const replacement=state.replacement;state.replacement=null;if(replacement?.preview)replacement.model.mixer.uncacheClip(replacement.preview);$('replacementPreviewBar').hidden=true;$('replacementPreviewBar').replaceChildren();for(const [slot,m]of Object.entries(state.models)){if(!m.libraryOriginalClips)continue;m.mixer.stopAllAction();for(const c of m.clips)m.mixer.uncacheClip(c);m.clips=m.libraryOriginalClips;delete m.libraryOriginalClips;selectClip(slot,m.libraryOriginalClip||m.clips[0]?.name);delete m.libraryOriginalClip;}
 state.motionPreview=null;state.trialReturn=null;state.playing=false;state.time=0;jobsRenderSignature='';motionWorkspace.clear();$('motionTrialInspector').hidden=true;if(redraw){drawLibrary();drawMetadata();drawJobs();updateDisplay();castBrowser?.draw();renderLoop?.wake();}
}
$('openMotionWorkspace').onclick=$('trialBrowse').onclick=()=>motionWorkspace.open();



async function restoreModelDraft(){
 const id=viewState.loadedAssetId,ticket=viewState.capture();
 const local=readViewDraft(()=>localStorage,{workspace:state.paths.workspace,assetId:id,view:viewState});
 const saved=await workspaceDrafts.restore(id,local);
 if(!viewState.isUnchanged(ticket,id))return;
 state.feedbackPoints=saved?.feedbackPoints||[];
 setFootRepairDraft(saved?.footRepair||null);
 state.draftFeedbackPoint=null;
 $('lockOtherClips').checked=saved?.lockOtherClips===true;
 if($('lockOtherClips').checked)$('clipLockOption').closest('details').open=true;
 if(!saved){$('request').value='';$('preserve').value='';return;}
 $('request').value=saved.request||'';$('preserve').value=saved.preserve||'';
 state.selectedJob=saved.selectedJob||null;state.panelMode=saved.panelMode||'compose';state.comparisonPair=saved.comparisonPair||null;state.composerSource=saved.composerSource||null;state.lineageParentJobId=saved.lineageParentJobId||null;
 state.explicitCompose=state.panelMode==='compose'&&Boolean(saved.request?.trim()||saved.composerIntent||state.feedbackPoints.length||state.footRepair);
 $('executionMode').value=restoredDelivery(saved,state.caller);state.savedProvider=saved.provider||null;if(state.providers&&state.savedProvider)$('executorProvider').value=state.providers.some(p=>p.id===state.savedProvider&&p.available)?state.savedProvider:'';
 if(state.explicitCompose)castBrowser?.setMode('studio');
 if(saved.context?.asset?.sha256===(state.models[saved.context.slot||'baseline']?.meta||state.project?.slots?.[saved.context.slot||'baseline'])?.sha256)await restoreContext(saved.context);
}
let nextModelOpen,modelOpenFlight;
function openCatalogModel(id,options={}){
 if(state.capturing||state.submitting||!modelOpenFlight&&(state.switching||state.loading))return;
 nextModelOpen={id,options};
 if(!modelOpenFlight)modelOpenFlight=(async()=>{
  try{
   while(nextModelOpen){
    const {id,options}=nextModelOpen;nextModelOpen=null;
    try{await openCatalogSelection(id,options,()=>!nextModelOpen);}
    catch(error){if(!nextModelOpen)throw error;}
   }
  }finally{modelOpenFlight=null;}
 })();
 return modelOpenFlight;
}
async function openCatalogSelection(id,{refreshSource=false,character=false,stored=false},stillWanted){
 if(state.replacement)clearMotionTrial();
 persistView();const previousProject=state.project,previousURL=location.href,ticket=viewState.select(id);let ownerTicket=ticket;state.switching=true;state.playing=false;
 const row=state.catalog?.entries.find(e=>e.id===id);
 catalogMessage(row?.format==='fbx'?'正在准备角色；首次打开需要用本机 Blender 转换…':'正在打开角色…');
 $('modelList').setAttribute('aria-busy','true');
 try{
  const result=await api((stored?'/api/models/':character?'/api/characters/':'/api/catalog/')+encodeURIComponent(id)+'/open','POST',{refreshSource});if(!result.project?.activeAssetId)throw Error('服务未返回模型身份，请刷新后重试。');if(!viewState.isCurrent(ticket,result.project?.activeAssetId)||!stillWanted())return;
  clearTimeout(projectPreviewTimer);projectPreviewSeq++;state.projectPreview=null;projectPreviewKey='';
  if(!await refreshModels({preserve:false,selectionTicket:ticket,preparedProject:result.project,stillWanted})||!viewState.isCurrent(ticket,id))return;
  history.replaceState(null,'','?asset='+encodeURIComponent(id));
  state.target=null;state.selectedJob=null;state.archivedJobId=null;state.panelMode='compose';state.explicitCompose=false;state.composerSource=null;state.comparisonPair=null;state.lineageParentJobId=null;state.time=0;state.focus='baseline';state.display='single';state.jobs=[];state.candidateJobId=null;
  $('request').value='';$('preserve').value='';$('scopeMode').value='whole';$('scopeInputs').hidden=true;
  await restoreModelDraft();if(!viewState.isCurrent(ticket,id)||!stillWanted())return;clearTarget();
  state.switching=false;jobsRenderSignature='';drawJobs();drawMetadata();render();
  const fromCatalog=$('modelCatalogDialog').open;
  if(fromCatalog)$('modelCatalogDialog').close();notice('');
  void pollStudio();
  if(fromCatalog||refreshSource)void refreshCatalog().catch(error=>catalogMessage(error.message,true));
  toast(refreshSource?'已打开源文件的新版本。之前的候选和任务仍在修改记录中。':'已打开 '+(row?.name||'角色')+'，可继续检查。');
 }catch(e){if(!viewState.isCurrent(ticket,id)||!stillWanted())return;ownerTicket=viewState.select(previousProject?.activeAssetId);state.project=previousProject;history.replaceState(null,'',previousURL);try{await refreshModels({preserve:false,selectionTicket:ownerTicket});await restoreModelDraft();}catch{}drawCatalog();catalogMessage('打开未完成：'+e.message,true);throw e;}
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
if(renderer){renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.NeutralToneMapping;renderer.setClearColor(0xebedf1);renderer.autoClear=false;}
const loader=createModelLoader(renderer,{lazyAnimations:true});
let legacyLoader;
const loadAsset=createAssetLoader();
// 动作库: character rail, gallery and action grid. Thumbnails render in their
// own offscreen renderer from clones, so the stage pose is never disturbed.
const thumbnailStudio=createThumbnailStudio({api,loader,loadAsset,foreground:()=>state.loading||state.switching,onError:e=>console.warn('thumbnail',e)});
function assetTitle(m=activeModel()){if(!m)return '';const teaching=m.meta.generator?.includes('original teaching');const title=state.project?.title&&state.project.title!=='动作反馈练习'?state.project.title:teaching?'原创练习角色':m.meta.label.replace(/\.(glb|fbx)$/i,'');return (title||'').replace(/ · (修改前|修改后)$/,'');}
castBrowser=createCastBrowser({api,studio:thumbnailStudio,
 getStage:()=>{const m=activeModel();return {replacement:state.replacement,plans:currentPlans(),heads:state.project?.slots,canReplace:state.display==='single'&&!state.submitting&&!activeTask()&&!staleWorkspaceView()&&m?.capabilities.preview!=='curves',ready:Boolean(state.ready&&m&&!state.switching&&!state.loading&&!state.archivedJobId),loading:Boolean(state.loading||state.switching),assetId:state.project?.activeAssetId,slot:activeSlot(),modelSha:m?.meta.sha256,model:m,name:assetTitle(m),ownClips:m?.libraryOriginalClips||m?.clips||[],currentClip:state.motionPreview?null:m?.clip,previewing:Boolean(state.motionPreview)};},
 onReplace:startReplacement,onReplacementSource:chooseReplacementSource,onCancelReplacement:endMotionTrial,onWithdrawReplacement:withdrawReplacement,onAssetChange:refreshReplacementPlans,
 openCharacter:entry=>openCatalogModel(entry.id,{character:entry.kind==='character',stored:entry.kind==='model'}),
 playOwn:async name=>{if(state.motionPreview?.replacement)return;if(!state.motionPreview&&activeModel()?.clip!==name)rememberMotion();clearMotionTrial(false);if(state.display!=='single'){state.focus=activeSlot();state.display='single';updateDisplay();}if(!await selectMotion(name,{remember:false}))return;state.loop=true;state.playing=duration()>0;updateClock();fitMotion();renderLoop?.wake();},
 playShared:async(row,isCurrent)=>{const request={assetId:state.project?.activeAssetId,slot:activeSlot(),expectedModelSha:activeModel()?.meta.sha256,actionId:row.id},response=await api('/api/actions/preview','POST',request);if(!isCurrent())return;await motionWorkspace.play(response.result,response.request,isCurrent);if(isCurrent())fitMotion();},
 playSaved:async(action,isCurrent)=>{const request={assetId:state.project?.activeAssetId,slot:activeSlot(),expectedModelSha:activeModel()?.meta.sha256,packId:action.recipe.packId,versionId:action.recipe.versionId,clip:action.recipe.clip,...(action.recipe.mappingId?{mappingId:action.recipe.mappingId}:{})},result=await api('/api/motions/preview','POST',request);if(!isCurrent())return;await motionWorkspace.play(result,request,isCurrent);if(isCurrent())fitMotion();},
 onEdit:()=>{if(state.motionPreview?.replacement){toast('请先结束动作对比。');return;}castBrowser.setMode('studio');if(state.motionPreview){notice('正在试播匹配动作。点击上方“以此动作继续修改”，先为这个角色准备独立的工作版本。');return;}if(state.panelMode!=='compose'&&!currentJob())void beginCompose({source:'baseline'});setTimeout(()=>$('request')?.focus({preventScroll:true}),160);},
 onModeChange:()=>{if(state.initialized)scheduleStudioSync();renderLoop?.wake();requestAnimationFrame(()=>{render();updateMobileActionVisibility();});},
 onError:fail
});
const integrationPanel=createIntegrationPanel({api,getPaths:()=>state.paths,copy:copyText,onError:fail});
$('openIntegrations').onclick=()=>integrationPanel.open();
$('mobilePreview').onclick=()=>$('stage').scrollIntoView({block:'start'});
$('mobileActions').onclick=()=>{setPreviewFocus(false);castBrowser.setMode('library');$('actionBrowser').scrollIntoView({block:'start'});};
$('mobileTask').onclick=()=>{setPreviewFocus(false);castBrowser.setMode('studio');$('taskPanel').scrollIntoView({block:'start'});};
function setPreviewFocus(on){document.body.classList.toggle('preview-focused',on);$('focusPreview').setAttribute('aria-pressed',String(on));$('focusPreview').setAttribute('aria-label',on?'退出专注预览':'专注预览');$('focusPreview').title=on?'退出专注预览':'专注预览';requestAnimationFrame(size);}
$('focusPreview').onclick=()=>setPreviewFocus(!document.body.classList.contains('preview-focused'));
const moreMenu=$('moreMenu'),moreButton=$('moreMenuButton');
function setMoreMenu(open){moreMenu.hidden=!open;moreButton.setAttribute('aria-expanded',String(open));if(open)moreMenu.querySelector('button')?.focus({preventScroll:true});}
moreButton.onclick=event=>{event.stopPropagation();setMoreMenu(moreMenu.hidden);};
moreMenu.addEventListener('click',()=>setMoreMenu(false));
document.addEventListener('click',event=>{if(!moreMenu.hidden&&!moreMenu.contains(event.target))setMoreMenu(false);});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!moreMenu.hidden){setMoreMenu(false);moreButton.focus();}});
const resourcePanels=Object.fromEntries(slots.map(slot=>{const panel=createResourcePanel({onChange:()=>syncCurveSelection(slot)});$('stage').append(panel.element);return [slot,panel];}));
const cameras={},controls={};let cameraBusy=false;
for(const slot of slots){const camera=new T.PerspectiveCamera(34,1,.01,1000);camera.position.set(...viewPositions.front);const ctl=new OrbitControls(camera,$('surface-'+slot));ctl.target.set(0,1,0);ctl.minDistance=.45;ctl.maxDistance=40;ctl.enableDamping=false;ctl.update();cameras[slot]=camera;controls[slot]=ctl;ctl.addEventListener('start',()=>{state.view='orbit';setViewButtons();});ctl.addEventListener('change',()=>{if(cameraBusy)return;if(!$('linkCameras').checked){render();return;}cameraBusy=true;const other=slot==='candidate'?'baseline':'candidate';cameras[other].position.copy(camera.position);cameras[other].quaternion.copy(camera.quaternion);ctl.target&&controls[other].target.copy(ctl.target);controls[other].update();cameraBusy=false;render();});}
function makeScene(){const scene=new T.Scene();scene.background=new T.Color(0xebedf1);scene.fog=new T.Fog(0xebedf1,10,26);scene.add(new T.HemisphereLight(0xffffff,0xaab2c0,1.55));const key=new T.DirectionalLight(0xfff2e6,3.0);key.position.set(2.2,4,3.5);scene.add(key);const fill=new T.DirectionalLight(0xdfe9ff,1.25);fill.position.set(-3,2,-1);scene.add(fill);const rim=new T.DirectionalLight(0xffffff,1.9);rim.position.set(1,3,-4);scene.add(rim);
const floor=new T.Mesh(new T.PlaneGeometry(80,80),new T.MeshStandardMaterial({color:0xe6e9ee,roughness:1,metalness:0}));floor.rotation.x=-Math.PI/2;floor.position.y=-.012;scene.add(floor);
const grid=new T.GridHelper(40,80,0xb9c0cc,0xcfd4dc);grid.material.transparent=true;grid.material.opacity=.5;grid.position.y=-.009;scene.add(grid);
const ring=new T.Mesh(new T.RingGeometry(.73,.734,100),new T.MeshBasicMaterial({color:0x8f9aad,transparent:true,opacity:.32,side:T.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=-.005;scene.add(ring);
const shadow=new T.Mesh(new T.CircleGeometry(.65,64),new T.MeshBasicMaterial({color:0x1c2230,transparent:true,opacity:.14,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.scale.set(1,.58,1);shadow.position.y=-.003;scene.add(shadow);
return{scene,environment:[floor,grid,ring,shadow]};}
function dispose(m){if(!m)return;m.mixer?.stopAllAction();m.mixer?.uncacheRoot(m.root);const resources=captureResources(m.scene,m.inputResources);for(const material of m.ghostMaterials||[])resources.materials.add(material);disposeAppearance(m);disposeResources(resources);}
function timeModel(m,time){resetOfflineAttachments(m.offlineBindings);m.holder.position.copy(m.offset);const action=m.previewAction||m.action;if(action){action.reset().play();m.mixer.setTime(time);}m.scene.updateMatrixWorld(true);poseOfflineAttachments(m);}
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

async function loadSlot(slot,overrideMeta){let gltf,createdScene;try{
 const meta=overrideMeta||state.project.slots[slot];if(!meta)return;gltf=await loadAsset(meta,meta.clips?loader:(legacyLoader??=createModelLoader(renderer)));
 const resource=await prepareResource(gltf,T,meta.clips),{root,capabilities,meshes,joints,bbox,height}=resource;// Root lock moves the holder against root motion; bind-pose bounds would cull the skinned body.
root.traverse(o=>{if(o.isSkinnedMesh)o.frustumCulled=false;});
 createdScene=root;
 if(!renderer&&['model','skeleton','nodes'].includes(capabilities.preview))throw Error('此资源需要 WebGL2 三维预览。请开启浏览器硬件加速后重试；已有版本保持。');
 const {scene,environment}=makeScene();createdScene=scene;const holder=new T.Group();holder.add(root);scene.add(holder);
 const hip=joints.find(o=>/hips|pelvis/i.test(o.name))||root;
 const lines=new T.LineSegments(new T.BufferGeometry(),new T.LineBasicMaterial({color:slot==='baseline'?0x8bbccb:0xd6bd8f,transparent:true,opacity:.85,depthTest:false}));lines.renderOrder=50;scene.add(lines);
 const points=new T.Points(new T.BufferGeometry(),new T.PointsMaterial({color:0xbed6ff,size:.06,sizeAttenuation:true,depthTest:false}));points.renderOrder=51;scene.add(points);const nodeAxes=new T.AxesHelper(.16);nodeAxes.material.depthTest=false;nodeAxes.renderOrder=52;scene.add(nodeAxes);
 const marker=new T.Mesh(new T.SphereGeometry(.025,16,12),new T.MeshBasicMaterial({color:0xf0d6a6,depthTest:false}));marker.renderOrder=100;marker.visible=false;scene.add(marker);
 const m={...resource,scene,inspectionFog:scene.fog,environment,holder,meta,hip,lines,points,nodeAxes,jointSet:new Set(joints),marker,mixer:new T.AnimationMixer(root),clip:null,action:null,duration:0,center:bbox.getCenter(new T.Vector3()),minY:bbox.min.y,offset:new T.Vector3(),anchor:new T.Vector3(),parser:gltf.parser,ghostMaterials:[],originalMaterials:new Map()};
 m.resolveClip=name=>resolveClip(m.clips.find(clip=>clip.name===name));
 normalize(m);m.inputResources=captureResources(scene);m.appearanceContext={THREE:T,root,scene,camera:cameras[slot],renderer,slot,environment,normalization:{scale:m.factor,sourceHeight:m.height}};return m;
 }catch(e){if(createdScene||gltf?.scene)dispose({scene:createdScene||gltf.scene});throw e;}}

const recentModels=new Map();
const cacheKey=(slot,meta)=>JSON.stringify([slot,meta.assetId,meta.sha256]);
function cacheWeight(m){
 let size=m.meta.bytes||0;
 for(const geometry of m.inputResources.geometries){
  const arrays=new Set([geometry.index,...Object.values(geometry.attributes),...Object.values(geometry.morphAttributes).flat()]
   .filter(Boolean).map(attribute=>attribute.array||attribute.data?.array));
  for(const array of arrays)size+=array?.byteLength||0;
 }
 for(const texture of m.inputResources.textures){
  const image=texture.image;
  size+=texture.mipmaps?.length?texture.mipmaps.reduce((sum,mip)=>sum+(mip.data?.byteLength||0),0):(image?.width||0)*(image?.height||0)*6;
 }
 return size;
}
function retireModel(slot,m,{discard=false}={}){
 if(!m)return;
 m.clipRequest=(m.clipRequest||0)+1;
 if(discard||m.appearance||appearance.mode!=='neutral'){dispose(m);return;}
 const key=cacheKey(slot,m.meta),weight=m.cacheWeight??=cacheWeight(m);
 const previous=recentModels.get(key);
 if(previous){dispose(previous);recentModels.delete(key);}
 recentModels.set(key,m);
 let total=[...recentModels.values()].reduce((sum,model)=>sum+model.cacheWeight,0);
 while(recentModels.size>4||total>320*1024*1024){
  const [oldest,model]=recentModels.entries().next().value;
  recentModels.delete(oldest);total-=model.cacheWeight;dispose(model);
 }
}
async function loadPair(wanted,force=false,isCurrent=()=>true,frameOptions=null,preferredClips={}){
 const selected=slots.filter(s=>wanted[s]&&(force||frameOptions&&appearance.mode==='project'||!state.models[s]||state.models[s].meta.sha256!==wanted[s].sha256||state.models[s].meta.assetId!==wanted[s].assetId));
 const results=await Promise.allSettled(selected.map(async slot=>{
  const key=cacheKey(slot,wanted[slot]),cached=appearance.mode==='neutral'&&!force&&recentModels.get(key);
  if(cached)recentModels.delete(key);
  const model=cached||await loadSlot(slot,wanted[slot]);
  try{
   const name=[preferredClips[slot],model.clip,state.models[slot]?.clip,model.clips[0]?.name].find(name=>model.clips.some(clip=>clip.name===name));
   await setModelClip(model,name);
   return model;
  }catch(error){dispose(model);throw error;}
 }));
 const release=()=>{for(const r of results)if(r.status==='fulfilled')dispose(r.value);};
 if(!isCurrent()){release();return false;}
 const failed=results.find(r=>r.status==='rejected');if(failed){release();throw failed.reason;}
 if(selected.length){
  const prepared=results.map(r=>r.value),pair=Object.fromEntries(slots.filter(s=>wanted[s]).map(s=>[s,prepared[selected.indexOf(s)]||state.models[s]])),frame=pairFrame(pair,frameOptions);
  for(const m of prepared)if(frame)normalize(m,frame);
  if(appearance.mode==='project'&&prepared.some(m=>!m.capabilities.hasMesh))appearance.fail('当前资源没有网格，使用资源检查预览。');
  const status=await appearance.prepare(prepared,isCurrent);if(!isCurrent()){release();return false;}
  if(status==='retired'||status==='fallback'){release();return loadPair(wanted,true,isCurrent,frameOptions,preferredClips);}
  if(appearance.mode==='project'){try{for(const m of prepared)withRendererState(renderer,T,()=>{const previous=renderer.debug.onShaderError;try{renderer.debug.onShaderError=()=>{throw Error('项目角色着色器编译失败');};renderer.compile(m.scene,m.appearanceContext.camera);}finally{renderer.debug.onShaderError=previous;}});}catch(e){release();appearance.fail('项目外观不可用，已恢复中性检查：'+e.message);return loadPair(wanted,true,isCurrent,frameOptions,preferredClips);}}
 }
 for(const [index,slot] of selected.entries()){
  retireModel(slot,state.models[slot],{discard:force});state.models[slot]=results[index].value;
 }
 for(const s of slots)if(wanted[s]&&state.models[s])state.models[s].meta=wanted[s];
 for(const s of slots)if(!wanted[s]&&state.models[s]){retireModel(s,state.models[s]);delete state.models[s];}
 normalizePair(state.models,frameOptions);return true;
}
function resolveClip(clip){
 if(!clip?.load)return clip;
 if(clip.decoded)return clip.decoded;
 return clip.pending??=clip.load().then(decoded=>clip.decoded=decoded).finally(()=>delete clip.pending);
}
function setModelClip(m,name,isCurrent=()=>true){
 const ticket=m.clipRequest=(m.clipRequest||0)+1,descriptor=m.clips.find(c=>c.name===name);
 const bind=clip=>{
  if(ticket!==m.clipRequest||!isCurrent())return false;
  if(localPreview?.model===m)clearLocalPreview();
  m.poseStamp=null;m.mixer.stopAllAction();
  m.clip=clip?.name||null;m.duration=clip?.duration||0;
  m.action=clip?.tracks.length?m.mixer.clipAction(clip):null;
  if(m.action){m.action.setLoop(T.LoopOnce,1);m.action.clampWhenFinished=true;m.action.play();}
  timeModel(m,0);m.anchor=m.hip.getWorldPosition(new T.Vector3());return true;
 };
 const clip=resolveClip(descriptor);
 return clip?.then?clip.then(bind):bind(clip);
}
function selectClip(slot,name,isCurrent=()=>true){
 const model=state.models[slot];
 return model&&setModelClip(model,name,()=>state.models[slot]===model&&isCurrent());
}
function pose(){for(const slot of slots){const m=state.models[slot];if(!m)continue;const stamp=[m.previewAction||m.action,localTime(slot),m.frame,$('lockRoot').checked,$('bones').checked,state.display,state.target];if(m.poseStamp?.every((value,i)=>value===stamp[i]))continue;m.poseStamp=stamp;timeModel(m,localTime(slot));if($('lockRoot').checked&&m.action){const delta=m.hip.getWorldPosition(new T.Vector3()).sub(m.anchor);m.holder.position.x-=delta.x;m.holder.position.z-=delta.z;m.scene.updateMatrixWorld(true);}m.lines.visible=!m.capabilities.hasMesh||$('bones').checked||(state.display==='overlay'&&slot==='baseline');m.points.visible=!m.capabilities.hasMesh&&m.joints.length>0;if(m.points.visible)m.points.geometry.setFromPoints(m.joints.map(b=>b.getWorldPosition(new T.Vector3())));if(m.lines.visible){const points=[];for(const b of m.joints)if(m.jointSet.has(b.parent))points.push(b.getWorldPosition(new T.Vector3()),b.parent.getWorldPosition(new T.Vector3()));m.lines.geometry.setFromPoints(points);}m.nodeAxes.visible=!m.capabilities.hasMesh&&m.joints.length>0;if(m.nodeAxes.visible){const b=joint(m,state.target?.bone,state.target?.nodeIndex)||m.joints.at(-1);m.nodeAxes.position.copy(b.getWorldPosition(new T.Vector3()));m.nodeAxes.quaternion.copy(b.getWorldQuaternion(new T.Quaternion()));}m.marker.visible=Boolean(state.target&&state.target.slot===slot);if(m.marker.visible){const bone=joint(m,state.target.bone,state.target.nodeIndex);if(bone)m.marker.position.copy(bone.getWorldPosition(new T.Vector3()));else if(state.target.worldPoint)m.marker.position.fromArray(state.target.worldPoint);else m.marker.visible=false;}}
}
function drawModel(m,camera,viewport){if(['curves','metadata'].includes(m.capabilities.preview))return;try{renderAppearance(m,{renderer,THREE:T,camera,viewport,time:localTime(m.appearanceContext.slot)});}catch(error){if(m.appearance||appearanceRecovery)recoverAppearance(error);else throw error;}}
function render(){if(!state.loading&&!state.switching)runtimeStage.sync();if(runtimeStage.active)return;if(continuousFrames())renderLoop?.wake();if(!state.ready)return;if(localPreview&&!localPreviewCurrent())clearLocalPreview();syncOfflineAttachments();drawObservationConditions();pose();drawResourcePanels();if(!renderer)return;const rect=$('stage').getBoundingClientRect(),w=rect.width,h=rect.height;if(!w||!h)return;renderer.setScissorTest(true);renderer.setViewport(0,0,w,h);renderer.setScissor(0,0,w,h);renderer.clear();
if(state.display==='split'){for(const [i,slot] of ['baseline','candidate'].entries()){const m=state.models[slot];if(!m)continue;cameras[slot].aspect=w/2/h;cameras[slot].updateProjectionMatrix();renderer.setViewport(i*w/2,0,w/2,h);renderer.setScissor(i*w/2,0,w/2,h);drawModel(m,cameras[slot],{x:i*w/2,y:0,width:w/2,height:h});}}
else{const slot=activeSlot(),m=state.models[slot];if(m){cameras[slot].aspect=w/h;cameras[slot].updateProjectionMatrix();drawModel(m,cameras[slot],{x:0,y:0,width:w,height:h});}if(state.display==='overlay'&&state.models.baseline&&!['curves','metadata'].includes(state.models.baseline.capabilities.preview)){const base=state.models.baseline,old=base.scene.background;base.scene.background=null;for(const o of base.environment)o.visible=false;for(const o of base.meshes)o.visible=false;renderer.clearDepth();renderer.render(base.scene,cameras[slot]);for(const o of base.environment)o.visible=true;for(const o of base.meshes)o.visible=true;base.scene.background=old;}}
renderer.setScissorTest(false);updateSelectionFloat();}
function size(){const r=$('stage').getBoundingClientRect();if(renderer&&!state.capturing&&r.width&&r.height)renderer.setSize(r.width,r.height,false);render();}
function syncCurveSelection(slot){const selected=resourcePanels[slot].observe();if(state.display==='split'&&selected)resourcePanels[slot==='baseline'?'candidate':'baseline'].restore(selected);if(state.ready&&activeModel()?.capabilities.preview==='curves')$('targetText').textContent=resourcePanels[activeSlot()].observe()?.binding||'全部曲线';render();}
function drawResourcePanels(){
 for(const slot of slots){const panel=resourcePanels[slot],m=state.models[slot],visible=state.display==='split'||slot===activeSlot();panel.setDomain(null);if(!visible||!m){panel.element.hidden=true;continue;}panel.element.style.left=state.display==='split'?(slot==='candidate'?'calc(50% + 8px)':'8px'):'8px';panel.element.style.right=state.display==='split'?(slot==='baseline'?'calc(50% + 8px)':'8px'):'8px';panel.render(m,localTime(slot));}
 const a=resourcePanels.baseline,b=resourcePanels.candidate,x=a.observe(),y=b.observe();
 if(state.display==='split'&&!a.element.hidden&&!b.element.hidden&&x&&y&&x.binding===y.binding&&x.component===y.component){const range=[Math.min(a.range[0],b.range[0]),Math.max(a.range[1],b.range[1])];for(const p of [a,b]){p.setDomain(range);p.redraw();}}
}

function captureStage(){runtimeStage.stop();const out=document.createElement('canvas'),r=$('stage').getBoundingClientRect();out.width=renderer?canvas.width:Math.max(1,Math.round(r.width));out.height=renderer?canvas.height:Math.max(1,Math.round(r.height));const ctx=out.getContext('2d');ctx.fillStyle='#161e2a';ctx.fillRect(0,0,out.width,out.height);if(renderer)ctx.drawImage(canvas,0,0);for(const panel of Object.values(resourcePanels))if(!panel.element.hidden){const box=panel.element.getBoundingClientRect();ctx.save();ctx.translate((box.left-r.left)*out.width/r.width,(box.top-r.top)*out.height/r.height);ctx.scale(out.width/r.width,out.height/r.height);panel.paint(ctx,box.width,box.height);ctx.restore();}return out;}
function setViewButtons(){document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===state.view;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});$('viewName').textContent=({front:'正面',side:'侧面',back:'背面',top:'俯视',orbit:'自由视角'})[state.view]||'自由视角';}
function view(name){cameraBusy=true;const frame=activeModel()?.frame,target=frame?.target||[0,1,0],scale=frame?.distanceScale||1;for(const slot of slots){const position=viewPositions[name];cameras[slot].position.set(target[0]+position[0]*scale,target[1]+(position[1]-1)*scale,target[2]+position[2]*scale);cameras[slot].near=Math.max(.00001,.01*scale);cameras[slot].far=Math.max(1000,1000*scale);cameras[slot].updateProjectionMatrix();controls[slot].minDistance=.45*scale;controls[slot].maxDistance=40*scale;controls[slot].target.fromArray(target);controls[slot].update();}cameraBusy=false;state.view=name;setViewButtons();render();}
function drawObservationConditions(){
 const text=[$('lockRoot').checked?'根位移已锁定':'保留根位移',$('progress').checked&&state.display!=='single'?'按进度对齐':'按秒数对齐',$('scaleMode').value==='raw'?'原始尺度与原点':recordedFrame(state.models.baseline)?'共用冻结现场尺度与偏移':'共用修改前尺度与偏移'].join(' · ');
 if($('observationConditions').textContent!==text)$('observationConditions').textContent=text;
}


function jobSourceAsset(job){return job?.inputs?.[job.slot||'baseline'];}
function hasComparison(){const a=state.models.baseline?.meta,b=state.models.candidate?.meta||state.project?.slots.candidate;return Boolean(a&&b&&(state.jobs.some(j=>j.state==='complete'&&jobSourceAsset(j)?.sha256===a.sha256&&j.candidate?.sha256===b.sha256)||(state.comparisonPair?.baseline===a.sha256&&state.comparisonPair?.candidate===b.sha256)||a.sha256!==b.sha256&&b.source?.actionReplacements));}
function updateDisplay(){
 const curves=Object.values(state.models).some(m=>['curves','metadata'].includes(m.capabilities.preview));if(curves&&state.display==='overlay')state.display='split';document.querySelector('[data-display="overlay"]').disabled=curves;
 const split=state.display==='split',active=activeSlot(),comparison=hasComparison();
 for(const slot of slots){const surface=$('surface-'+slot);surface.hidden=!split&&slot!==active;surface.style.left=split?(slot==='baseline'?'0':'50%'):'0';surface.style.right=split?(slot==='baseline'?'50%':'0'):'0';controls[slot].enabled=split||slot===active;}
 $('stageDivider').hidden=!split;$('candidateLabel').hidden=!split&&active!=='candidate';$('baselineLabel').hidden=!split&&active!=='baseline';$('baselineLabel').style.left='17px';$('candidateLabel').style.left=split?'calc(50% + 17px)':'17px';
 $('compareControls').hidden=!comparison;$('focusSlot').disabled=state.display!=='single';$('focusSlot').value=state.focus;
 $('versionModes').hidden=!comparison;$('singleVersion').hidden=comparison;$('singleVersion').textContent=state.focus==='candidate'?'正在观察当前版本':state.models.baseline?.meta.sha256===state.project?.slots.baseline?.sha256?'正在观察最初原版':'正在观察修改前';document.querySelector('[data-version="baseline"]').textContent=comparison?'修改前':'最初原版';$('baselineLabel').querySelector('span').firstChild.nodeValue=state.motionPreview?.replacement?'替换动作试播':state.motionPreview?'兼容动作试播':comparison?'修改前':'最初原版';if(state.motionPreview){$('singleVersion').textContent='临时试播 · 模型版本保持';$('versionModes').hidden=true;$('singleVersion').hidden=false;}
 document.querySelectorAll('[data-display]').forEach(b=>{const yes=b.dataset.display===state.display;b.classList.toggle('active',yes);b.setAttribute('aria-pressed',String(yes));});
 document.querySelectorAll('[data-version]').forEach(b=>{const yes=b.dataset.version===(state.display==='single'?state.focus:'compare');b.classList.toggle('active',yes);b.setAttribute('aria-pressed',String(yes));});
 $('comparisonMeaning').textContent=$('progress').checked?'按进度对齐 · 速度可能不同':'同一秒数比较 · 保留真实节奏';size();updateWorkflow();syncFootDiagnostics();
}
// 动作库 frames the whole motion: sample the clip once and fit the camera to
// every joint's travel, keeping the current view direction. Only the camera
// moves; the pose, clip and root-lock state are untouched.
let fitTween=0;
function fitMotion(){
 if(castBrowser?.mode()!=='library'||state.display!=='single'||!renderer)return;
 const slot=activeSlot(),m=state.models[slot],camera=cameras[slot],control=controls[slot];if(!m?.joints?.length||!camera)return;
 const box=new T.Box3(),point=new T.Vector3(),span=m.duration||0,samples=span>0?24:0,lock=$('lockRoot').checked;
 for(let i=0;i<=samples;i++){timeModel(m,samples?span*i/samples:0);if(lock&&m.action){const delta=m.hip.getWorldPosition(new T.Vector3()).sub(m.anchor);m.holder.position.x-=delta.x;m.holder.position.z-=delta.z;m.scene.updateMatrixWorld(true);}for(const joint of m.joints)box.expandByPoint(joint.getWorldPosition(point));}
 m.poseStamp=null;if(box.isEmpty())return;
 const frame=m.frame,scale=frame?.distanceScale||1,base=new T.Vector3().fromArray(frame?.target||[0,1,0]),standard=viewPositions.front[2]*scale;
 const height=box.max.y-box.min.y;box.max.y+=height*.08+.12*scale;box.min.y=Math.min(box.min.y,0);
 const direction=camera.position.clone().sub(control.target).normalize(),right=new T.Vector3().crossVectors(new T.Vector3(0,1,0),direction).normalize(),up=new T.Vector3().crossVectors(direction,right);
 const tanV=Math.tan(T.MathUtils.degToRad(camera.fov/2)),tanH=tanV*camera.aspect,center=box.getCenter(new T.Vector3());
 let distance=0;for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){const offset=new T.Vector3(x,y,z).sub(center);distance=Math.max(distance,offset.dot(direction)+Math.abs(offset.dot(right))*1.1/tanH,offset.dot(direction)+Math.abs(offset.dot(up))*1.1/tanV);}
 const expand=distance>standard;const target=expand?new T.Vector3(base.x,Math.max(base.y,center.y),base.z):base;const finalDistance=Math.max(standard,distance);
 const fromPosition=camera.position.clone(),fromTarget=control.target.clone(),toTarget=target,toPosition=target.clone().addScaledVector(direction,finalDistance);
 if(fromPosition.distanceTo(toPosition)<1e-3&&fromTarget.distanceTo(toTarget)<1e-3)return;
 const ticket=++fitTween,start=performance.now(),length=matchMedia('(prefers-reduced-motion: reduce)').matches?0:320;
 const step=now=>{if(ticket!==fitTween)return;const k=length?Math.min(1,(now-start)/length):1,e=1-Math.pow(1-k,3);cameraBusy=true;camera.position.lerpVectors(fromPosition,toPosition,e);control.target.lerpVectors(fromTarget,toTarget,e);control.update();cameraBusy=false;render();if(k<1)requestAnimationFrame(step);};
 requestAnimationFrame(step);
}
async function selectMotion(name,{remember=true}={}){
 const epoch=++navigationEpoch,ticket=viewState.capture();castBrowser?.cancelPreview();
 if(state.switching||state.loading)return false;
 try{
  if(remember&&activeModel()?.clip!==name)rememberMotion();
  const models=slots.filter(slot=>state.models[slot]?.clips.some(clip=>clip.name===name));
  const current=()=>epoch===navigationEpoch&&viewState.isUnchanged(ticket);
  await Promise.all(models.map(slot=>selectClip(slot,name,current)));
  if(!current())return false;
  state.time=0;state.playing=duration()>0;clearTarget();drawLibrary();updateBoneChoices();drawMetadata();render();return true;
 }catch(error){if(epoch===navigationEpoch&&viewState.isUnchanged(ticket))fail(error);return false;}
}
function activeOfflinePreset(){
 return offlineSelection&&offlineSelection.assetId===viewState.loadedAssetId?offlineSelection.preset:null;
}
async function loadPreviewStates(assetId,offline,signal,lease){
 if(!offline)return api('/api/runtime-preview/open','POST',{lease,assetId});
 const result=await api('/api/offline-preview?assetId='+encodeURIComponent(assetId),'GET',undefined,{signal});
 if(result.states.length||signal.aborted||assetId!==viewState.loadedAssetId)return result;
 const states=modelPreviewStates(Object.values(state.models),activeModel());
 return states.length?{states,message:'当前显示模型自带的动作。'+result.message+'。'}:result;
}
function restoreOfflinePreset(ctx){
 offlineSelection=null;
 if(!ctx.offlinePreset||ctx.assetId!==viewState.loadedAssetId)return;
 try{offlineSelection={assetId:ctx.assetId,preset:parseOfflineState(ctx.offlinePreset)};}
 catch(error){notice(error.message,true);}
}
function syncOfflineAttachments(){
 const preset=activeOfflinePreset();
 const models=Object.values(state.models).filter(model=>model.offlinePreset!==preset);
 if(!models.length)return;
 let bindings;
 try{bindings=models.map(model=>bindOfflineAttachments(T,model,preset?.attachments||[]));}
 catch(error){offlineSelection=null;syncOfflineAttachments();notice('已清除离线状态配置。'+error.message,true);return;}
 for(const [index,model] of models.entries()){
  resetOfflineAttachments(model.offlineBindings);
  model.offlineBindings=bindings[index];
  model.offlinePreset=preset;
  model.poseStamp=null;
 }
 $('openRuntimePreview').title=preset?'离线状态 · '+preset.label:'游戏状态';
}
async function applyOfflinePreset(preset){
 const assetId=viewState.loadedAssetId;
 if(!assetId||state.loading||state.switching||state.capturing||state.submitting)throw Error('请等当前操作完成后再选择状态');
 if(!preset){offlineSelection=null;render();persistView();return;}
 for(const model of Object.values(state.models)){
  const clips=model.libraryOriginalClips||model.clips;
  if(!clips.some(clip=>clip.name===preset.clip&&preset.time<=clip.duration))throw Error('当前版本缺少状态所需的动作或时刻：'+preset.clip);
  bindOfflineAttachments(T,model,preset.attachments);
 }
 rememberMotion();
 if(preset.appearance&&preset.appearance!==appearance.mode){
  appearance.select(preset.appearance);
  if(!await refreshModels({force:true})||assetId!==viewState.loadedAssetId)throw Error('角色已切换，请重新选择状态');
 }
 clearMotionTrial(false);
 offlineSelection=preset.modelOnly?null:{assetId,preset};
 await selectMotion(preset.clip,{remember:false});
 seek(preset.time);
 state.playing=preset.play&&duration()>0;
 updateClock();
 persistView();
 if(preset.appearance==='project'&&appearance.error)notice(appearance.error,true);
}
function seek(time){state.playing=false;state.time=Math.max(0,Math.min(duration(),Number(time)||0));render();updateClock();}
function updateClock(){const d=duration();$('timeline').max=String(d||1);$('timeline').value=String(Math.min(state.time,d));$('timeline').style.setProperty('--progress',(d?Math.min(100,state.time/d*100):0)+'%');$('clock').replaceChildren(document.createTextNode(state.time.toFixed(3)+' '),el('span','/ '+d.toFixed(3)+' s'));const symbol=state.playing?'pause':'play';if($('play').dataset.symbol!==symbol){$('play').replaceChildren(icon(symbol));$('play').dataset.symbol=symbol;}$('play').setAttribute('aria-label',state.playing?'暂停':'播放');$('play').disabled=!state.ready||!d;$('prev').disabled=!d;$('next').disabled=!d;$('contextTime').textContent=localTime(activeSlot()).toFixed(3)+'s';$('frameInfo').textContent='第 '+Math.round(localTime(activeSlot())*state.fps)+' 帧 · '+state.fps+' fps 审阅';$('contextClip').textContent=activeModel()?.clip||'静态姿态';$('tickQuarter').textContent=(d/4).toFixed(2);$('tickMid').textContent=(d/2).toFixed(2);$('tickThreeQuarter').textContent=(d*.75).toFixed(2);$('tickEnd').textContent=d.toFixed(2)+' s';updateScopeVisual();}
function context(){const slot=activeSlot(),m=state.models[slot];return{assetId:viewState.loadedAssetId,slot,asset:m?{sha256:m.meta.sha256,file:m.meta.file}:null,clip:m?.clip||null,time:localTime(slot),frame:Math.round(localTime(slot)*state.fps),fps:state.fps,speed:state.speed,loop:state.loop,scaleMode:$('scaleMode').value,view:state.view,displayMode:state.display==='single'?'all':'comparison',display:state.display,mode:$('progress').checked?'progress':'elapsed',normalized:$('scaleMode').value!=='raw'&&Boolean(m?.capabilities.hasMesh||m?.capabilities.hasNodes),rootLocked:$('lockRoot').checked,linkedCameras:$('linkCameras').checked,cameras:Object.fromEntries(slots.map(s=>[s,{position:cameras[s].position.toArray(),target:controls[s].target.toArray(),fov:cameras[s].fov,projection:'perspective'}])),slots:Object.fromEntries(slots.filter(s=>state.models[s]).map(s=>[s,{sha256:state.models[s].meta.sha256,file:state.models[s].meta.file,clip:state.models[s].clip,duration:state.models[s].duration,time:localTime(s)}])),normalization:Object.fromEntries(slots.filter(s=>state.models[s]).map(s=>[s,{scale:state.models[s].factor,restOffset:state.models[s].offset.toArray(),displayOffset:state.models[s].holder.position.toArray(),sourceHeight:state.models[s].height}])),selection:state.target?structuredClone(state.target):null,appearance:appearance.snapshot(m),offlinePreset:activeOfflinePreset(),resourceObservation:resourcePanels[slot].observe()};}
function rawName(m,o){const idx=m.parser?.associations?.get(o)?.nodes;return idx!==undefined?(m.parser.json.nodes[idx]?.name||o.name):o.name;}
function joint(m,name,index){return findJoint(m,name,index);}
function updateBoneChoices(){const m=activeModel(),previous=state.target?joint(m,state.target.bone,state.target.nodeIndex):selectedJoint(m,$('boneSelect').value),advanced=$('showAllBones').checked,select=$('boneSelect');select.replaceChildren();const all=el('option',m?.capabilities.hasMesh?'整个模型 / 自动判断部位':'整个资源 / 选择节点');all.value='';select.append(all);const counts=new Map();for(const b of m?.joints||[])counts.set(rawName(m,b),(counts.get(rawName(m,b))||0)+1);if(m)for(const b of m.joints){const name=rawName(m,b),label=semanticPart(name);if(m.capabilities.hasMesh&&!advanced&&part(name)===name&&b!==previous)continue;const duplicate=counts.get(name)>1,description=advanced?(label?label+' · '+name:name):(label||name),o=el('option',description+(duplicate?' · 节点 '+m.parser.associations.get(b)?.nodes:''));o.value=jointValue(m,b);select.append(o);}select.value=previous?jointValue(m,previous):'';}

function clearTarget(){state.target=null;$('boneSelect').value='';$('targetText').textContent=activeModel()?.capabilities.hasMesh?'整个模型':'整个资源';$('targetHint').textContent='点击位置用于定位参考，关联部位可以在这里确认。';$('clearSelection').hidden=true;updateSideWarning();$('selectionFloat').hidden=true;for(const m of Object.values(state.models))m.marker.visible=false;render();scheduleProjectPreview();}
// The request's 左/右 and the picked bone disagree: say so before submitting and
// offer the mirrored bone. A second submit sends it as is (the task records it).
let sideAcknowledged='';
function updateSideWarning(){
 const target=state.target,c=target?.bone?sideConflict($('request').value,target.bone):null;$('sideWarning').hidden=!c;if(!c)return null;
 const m=state.models[target.slot],mirror=mirrorBoneName(c.bone),node=mirror&&m?joint(m,mirror):null,picked=semanticPart(c.bone)||c.bone;
 $('sideWarningText').textContent=`要求写的是${SIDE_NAMES[c.requested]}侧，选中的却是${picked}（角色${SIDE_NAMES[c.picked]}侧）。左右按角色自己算：角色面向镜头时，它的右手在画面左边。再次提交即按当前选择发送。`;
 $('sideFix').hidden=!node;if(node){$('sideFix').textContent='改选'+(semanticPart(mirror)||mirror)+' →';$('sideFix').onclick=()=>setTarget({slot:target.slot,assetSha256:m.meta.sha256,bone:rawName(m,node),nodeIndex:m.parser?.associations?.get(node)?.nodes,mesh:null,space:'bone-local',inferred:false});}
 return c;
}
function setTarget(target){state.target=target;$('targetText').textContent=target.bone?(semanticPart(target.bone)||target.bone):'已选表面';$('clearSelection').hidden=false;updateBoneChoices();const node=joint(state.models[target.slot],target.bone,target.nodeIndex);if(node)$('boneSelect').value=jointValue(state.models[target.slot],node);$('targetHint').textContent=target.inferred?'已根据点击位置关联部位。请确认是否为你想调整的位置；点击不会指定精确顶点。':'已确认修改部位。你也可以在描述中说明其他部位如何保持。';updateSideWarning();render();scheduleProjectPreview();}

function updateSelectionFloat(){const label=$('selectionFloat'),target=state.target;if(!target){label.hidden=true;return;}const m=state.models[target.slot],bone=m&&joint(m,target.bone,target.nodeIndex);if(!m||!bone){label.hidden=true;return;}const point=bone.getWorldPosition(new T.Vector3()).project(cameras[target.slot]);const split=state.display==='split';if(!split&&target.slot!==activeSlot()){label.hidden=true;return;}const r=$('stage').getBoundingClientRect();const index=target.slot==='baseline'?0:1;let x=(point.x+1)/2*r.width/(split?2:1)+(split?index*r.width/2:0),y=(1-point.y)/2*r.height;label.hidden=point.z>1||x<0||x>r.width||y<0||y>r.height;if(!label.hidden){label.style.left=Math.min(r.width-120,Math.max(10,x))+'px';label.style.top=Math.max(65,Math.min(r.height-40,y))+'px';label.textContent=semanticPart(target.bone)||target.bone;}}
const raycaster=new T.Raycaster();
function pickSurface(event,slot){if(!state.ready||state.loading||state.switching)return;const m=state.models[slot];if(!m)return;const rect=$('surface-'+slot).getBoundingClientRect();const pointer=new T.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);state.playing=false;updateClock();pose();raycaster.setFromCamera(pointer,cameras[slot]);if(!m.capabilities.hasMesh){raycaster.params.Points.threshold=.06;const hit=raycaster.intersectObject(m.points)[0],node=hit&&m.joints[hit.index];if(node)setTarget({slot,assetSha256:m.meta.sha256,bone:rawName(m,node),nodeIndex:m.parser.associations.get(node)?.nodes,space:'node-local',inferred:false});return;}const hit=raycaster.intersectObjects(m.meshes,true)[0];if(!hit)return;let associated=null;const mesh=hit.object;
if(mesh.isSkinnedMesh&&hit.face){const indices=mesh.geometry.attributes.skinIndex,weights=mesh.geometry.attributes.skinWeight,totals=new Map();if(indices&&weights){for(const vertex of [hit.face.a,hit.face.b,hit.face.c])for(let i=0;i<Math.min(4,indices.itemSize);i++){const index=indices.getComponent(vertex,i),weight=weights.getComponent(vertex,i);if(weight>0)totals.set(index,(totals.get(index)||0)+weight);}const best=[...totals].sort((a,b)=>b[1]-a[1])[0];if(best)associated=mesh.skeleton.bones[best[0]];}}
if(!associated){let o=mesh.parent;while(o&&o!==m.root){if(m.joints.includes(o)){associated=o;break;}o=o.parent;}}
if(!associated&&m.joints.length){let distance=Infinity;for(const b of m.joints){const d=b.getWorldPosition(new T.Vector3()).distanceTo(hit.point);if(d<distance){distance=d;associated=b;}}}
const nodeIndex=associated?m.parser?.associations?.get(associated)?.nodes:undefined;setTarget({slot,assetSha256:m.meta.sha256,bone:associated?rawName(m,associated):null,nodeIndex,mesh:rawName(m,mesh),meshNodeIndex:m.parser?.associations?.get(mesh)?.nodes,point:mesh.worldToLocal(hit.point.clone()).toArray(),worldPoint:hit.point.toArray(),space:'mesh-local-posed',faceIndex:hit.faceIndex,pickedAt:{clip:m.clip,time:localTime(slot)},inferred:true});updateClock();}
for(const slot of slots){let down=null;const surface=$('surface-'+slot);surface.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY};});surface.addEventListener('pointerup',e=>{if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<5)pickSurface(e,slot);down=null;});}
$('boneSelect').onchange=()=>{const slot=activeSlot(),m=state.models[slot],b=selectedJoint(m,$('boneSelect').value);if(!b)return clearTarget();setTarget({slot,assetSha256:m.meta.sha256,bone:rawName(m,b),nodeIndex:m.parser?.associations?.get(b)?.nodes,mesh:null,space:'bone-local',inferred:false});};$('clearSelection').onclick=clearTarget;
function drawSidebar(){
 castBrowser?.sync();
}

function footDiagnosticInput(){
 const model=activeModel(),clip=model?.clip,assetId=viewState.loadedAssetId;
 if(!assetId||!clip||!model.joints.length||state.motionPreview)return null;
 const visible=state.display==='single'?[activeSlot()]:slots;
 if(visible.some(slot=>state.models[slot]?.clip!==clip))return null;
 const versions=Object.fromEntries(visible.map(slot=>[slot,state.models[slot].meta.sha256]));
 const job=currentJob(),jobId=job&&viewMatchesJob(job)?job.id:undefined;
 return {assetId,clip,versions,jobId};
}
function syncFootDiagnostics(){
 const input=footDiagnosticInput(),button=$('checkFootSlip'),panel=$('footDiagnostics');
 if(footDiagnosis&&footDiagnosis.key!==JSON.stringify(input)){
  footDiagnosis=null;panel.hidden=true;panel.replaceChildren();
 }
 button.hidden=!activeModel()?.clip||!activeModel()?.joints.length||Boolean(state.motionPreview);
 button.disabled=!input||!state.initialized||state.loading||state.switching;
 button.title=!input&&!button.hidden?'请先在两个版本上打开同一个动作。':'';
 button.setAttribute('aria-expanded',String(!panel.hidden));
 button.textContent=panel.hidden?'检查脚滑':'收起脚滑检查';
}
function seekFootDiagnostic({slot,foot,time}){
 if(footDiagnosis?.key!==JSON.stringify(footDiagnosticInput())||state.loading||state.switching)return;
 clearLocalPreview();
 $('lockRoot').checked=false;
 if(state.display!=='single'){
  state.display='split';$('progress').checked=false;updateDisplay();
 }
 const model=state.models[slot],node=joint(model,foot.foot,foot.nodeIndex);
 if(node)setTarget({slot,assetSha256:model.meta.sha256,bone:foot.foot,nodeIndex:foot.nodeIndex,space:'bone-local',inferred:true});
 else clearTarget();
 seek(time);$('stage').scrollIntoView({block:'nearest'});return true;
}
function canRepairFoot(slot,sha256){
 return !state.archivedJobId&&state.project?.slots[slot]?.sha256===sha256;
}
function activeFootRepair(){
 const repair=state.footRepair,m=activeModel();
 return state.panelMode==='compose'&&repair&&m?.clip===repair.clip&&m.meta.sha256===repair.assetSha256?repair:null;
}
function setFootRepairDraft(repair){
 state.footRepair=repair;
 $('footRepairSpeed').value=repair?.runtime?.speed??'';
 $('footRepairDirection').value=repair?.runtime?.direction||'';
}
function footRepairForSubmission(){
 const repair=activeFootRepair();
 if(!repair)return null;
 const input=$('footRepairSpeed');
 if(!input.validity.valid)throw Error('请输入有效的模拟移动速度。');
 const direction=$('footRepairDirection').value;
 if(repair.inPlace&&input.value&&!direction)throw Error('请选择素材中的前进方向。');
 const runtime=repair.inPlace&&input.value?{speed:input.valueAsNumber,direction}:null;
 return validateFootRepair({...repair,runtime});
}
function drawFootRepair(){
 const repair=state.footRepair,active=activeFootRepair(),panel=$('footRepairDraft');
 panel.hidden=!repair;
 $('footRepairRuntime').hidden=!active?.inPlace;
 $('scopeChip').disabled=$('openScope').disabled=Boolean(active);
 $('scopeChip').title=active?'移除诊断后可另选修改范围。':'';
 if(!repair)return;
 const interval=repair.time.map(t=>t.toFixed(3)).join('–')+' 秒';
 const name=semanticPart(repair.foot)||repair.foot;
 $('footRepairSummary').textContent=active
  ?name+' · '+interval+'。修改范围含前后两帧用于衔接，其他动作会锁定。'
  :name+' · '+repair.clip+' · '+interval+'。切回原动作和版本可继续此修复。';
}
async function startFootRepair({slot,...data}){
 if(state.loading||state.switching||state.submitting||!canRepairFoot(slot,data.assetSha256))return;
 const current=footDiagnosticInput();
 if(footDiagnosis?.key!==JSON.stringify(current)||current?.clip!==data.clip||current.versions[slot]!==data.assetSha256)return;
 const previous=state.footRepair;
 if(previous&&!(previous.assetSha256===data.assetSha256&&previous.clip===data.clip&&previous.nodeIndex===data.nodeIndex&&previous.time.every((t,i)=>t===data.time[i]))){
  toast('先移除草稿里的脚滑诊断，再换一个区间。');return;
 }
 const repair=previous||validateFootRepair(data);
 const job=currentJob();
 if(!await beginCompose({source:slot,job:job?.candidate?.sha256===data.assetSha256?job:null}))return;
 const m=activeModel();
 if(m?.meta.sha256!==repair.assetSha256||m.clip!==repair.clip)throw Error('当前动作版本已变化，请重新检查脚滑。');
 setFootRepairDraft(repair);
 $('lockRoot').checked=false;
 setTarget({slot,assetSha256:repair.assetSha256,bone:repair.foot,nodeIndex:repair.nodeIndex,space:'bone-local',inferred:true});
 seek(repair.time[0]);drawMetadata();persistView();
 toast('已带入脚滑区间，可补充要求后提交。');
}
$('removeFootRepair').onclick=()=>{setFootRepairDraft(null);drawMetadata();persistView();};
for(const id of ['footRepairSpeed','footRepairDirection'])$(id).addEventListener('input',()=>{
 try{const updated=footRepairForSubmission();if(updated){state.footRepair=updated;persistView();}}catch{/* Keep the last valid draft until the user finishes typing. */}
});
$('checkFootSlip').onclick=async()=>{
 const input=footDiagnosticInput(),panel=$('footDiagnostics');
 if(!input)return;
 panel.hidden=!panel.hidden;syncFootDiagnostics();
 if(panel.hidden)return;
 if(footDiagnosis&&!footDiagnosis.error){panel.scrollIntoView({block:'nearest'});return;}
 const pending={key:JSON.stringify(input)};footDiagnosis=pending;
 const status=el('p','正在采样脚节点…','foot-diagnostic-caption');status.setAttribute('role','status');panel.replaceChildren(status);
 try{
  const result=await api('/api/actions/foot-diagnostics','POST',input);
  if(footDiagnosis!==pending||pending.key!==JSON.stringify(footDiagnosticInput()))return;
  panel.replaceChildren(footDiagnosticReport(result,{partName:name=>semanticPart(name)||name,onSeek:seekFootDiagnostic,
   canRepair:canRepairFoot,onRepair:data=>startFootRepair(data).catch(fail)}));
 }catch(error){
  if(footDiagnosis!==pending)return;
  pending.error=true;status.textContent=error.message;status.classList.add('error-copy');
 }
 if(!panel.hidden)panel.scrollIntoView({block:'nearest'});
};

function drawLibrary(){const m=activeModel(),list=$('clipList'),query=$('search').value.trim().toLowerCase();drawSidebar();list.replaceChildren();const clips=(m?.clips||[]).filter(c=>!query||c.name.toLowerCase().includes(query));$('clipCount').textContent=m?.clips.length||0;const chooser=$('motionSelect');chooser.replaceChildren();for(const c of m?.clips||[]){const o=el('option',c.name);o.value=c.name;chooser.append(o);}if(m?.clip)chooser.value=m.clip;if(!m?.clips.length){const o=el('option','无内置动作');o.value='';chooser.append(o);}chooser.disabled=!m?.clips.length;if(!m?.clips.length){list.append(el('p',m?resourceLabel(m.capabilities)+'。此资源没有内置动作；可独立检查，或明确关联兼容动作。':'导入模型、骨架或动作，或稍候读取示例。','clip-empty'));return;}for(const [index,c] of clips.entries()){const b=el('button',undefined,'motion-card'+(m.clip===c.name?' active':''));b.setAttribute('role','option');b.setAttribute('aria-selected',String(m.clip===c.name));b.dataset.clip=c.name;const glyph=el('span',undefined,'motion-icon'),text=el('span',undefined,'motion-text');glyph.append(icon('motion'));text.append(el('strong',c.name),el('small',c.duration.toFixed(2)+' 秒 · '+(state.display==='single'&&state.focus==='baseline'?'原版动作':'版本对照')));b.append(glyph,text,el('span',String(index+1).padStart(2,'0'),'motion-index'));b.onclick=()=>{selectMotion(c.name);$('libraryDialog').close();};list.append(b);}if(!clips.length)list.append(el('p','没有找到这个动作，试试其他名称。','clip-empty'));}
let feedbackEditor=null;
const feedbackPart=p=>p.target?.bone?(semanticPart(p.target.bone)||p.target.bone):p.target?.mesh||'整个动作';
function activeFeedbackPoints(){
 const model=activeModel();return pointsForClip(state.feedbackPoints,model?.meta.sha256,model?.clip);
}
function canEditFeedback(){
 return state.ready&&state.panelMode==='compose'&&!state.loading&&!state.switching&&!state.submitting&&!state.archivedJobId&&!state.motionPreview;
}
function drawFeedbackPoints(){
 const points=activeFeedbackPoints(),other=state.feedbackPoints.filter(p=>!points.includes(p)),canEdit=canEditFeedback();
 $('feedbackPoints').hidden=!activeModel()?.clip&&!other.length;
 $('addFeedbackPoint').disabled=!canEdit||!activeModel()?.clip||state.feedbackPoints.length>=MAX_FEEDBACK_POINTS;
 $('quickFeedbackPoint').hidden=state.panelMode!=='compose'||!activeModel()?.clip||Boolean(state.motionPreview);
 $('quickFeedbackPoint').disabled=$('addFeedbackPoint').disabled;
 $('feedbackPointsHint').textContent=state.feedbackPoints.length>=MAX_FEEDBACK_POINTS?'已到 '+MAX_FEEDBACK_POINTS+' 条草稿标记上限。提交或删除后可继续添加。':points.length?'本次将随任务提交 '+points.length+' 条标记。':'有几处要改？逐处标记，一起提交。';
 const actions=canEdit?{onEdit:p=>openFeedbackEditor(p),onDelete:removeFeedbackPoint}:{};
 $('feedbackPointList').replaceChildren(feedbackPointList(points,{describe:feedbackPart,activeId:state.draftFeedbackPoint,onSeek:canEdit?point=>void seekDraftFeedback(point).catch(fail):null,...actions}));
 $('otherFeedbackPoints').hidden=!other.length;
 $('otherFeedbackSummary').textContent='其他动作或版本的标记（'+other.length+'）';
 const describeOther=p=>{
  const version=state.project?.slots.baseline?.sha256===p.assetSha256?'原版':state.project?.slots.candidate?.sha256===p.assetSha256?'当前候选':'历史版本';
  return p.clip+' · '+version+' · '+feedbackPart(p);
 };
 $('otherFeedbackList').replaceChildren(feedbackPointList(other,{describe:describeOther,...actions}));
}
function feedbackDraftChanged(){
 drawFeedbackPoints();persistView();
}
function revealFeedbackPoint(list,point){
 list.querySelector('[data-feedback-point="'+point.id+'"]')?.focus({preventScroll:true});
 if(innerWidth<=760)$('stage').scrollIntoView({block:'start'});
}
function removeFeedbackPoint(point){
 if(!canEditFeedback())return;
 const before=state.feedbackPoints,after=before.filter(p=>p.id!==point.id);
 state.feedbackPoints=after;feedbackDraftChanged();$('addFeedbackPoint').focus();
 toast('已删除标记',()=>{if(state.feedbackPoints!==after||!canEditFeedback())return;state.feedbackPoints=before;feedbackDraftChanged();toast('已恢复标记');});
}
async function seekDraftFeedback(point){
 if(!canEditFeedback()||!activeFeedbackPoints().includes(point))return;
 clearLocalPreview();const slot=activeSlot();
 await applyObservation(feedbackObservation(context(),point,slot));
 state.draftFeedbackPoint=point.id;
 if(point.target)setTarget({...point.target,slot,assetSha256:point.assetSha256});else clearTarget();
 drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();render();
 revealFeedbackPoint($('feedbackPointList'),point);
}
function openFeedbackEditor(point=null,trigger=null){
 if(!canEditFeedback()||(!point&&(!activeModel()?.clip||state.feedbackPoints.length>=MAX_FEEDBACK_POINTS)))return;
 if(!point){
  state.playing=false;clearLocalPreview();render();updateClock();
  const ctx=context(),selection=ctx.selection;
  const target=selection?.slot===ctx.slot&&selection.assetSha256===ctx.asset.sha256?selection:null;
  point={id:crypto.randomUUID(),assetSha256:ctx.asset.sha256,clip:ctx.clip,time:ctx.time,target,
   camera:ctx.cameras[ctx.slot],view:ctx.view,rootLocked:ctx.rootLocked,scaleMode:ctx.scaleMode,normalization:ctx.normalization[ctx.slot]};
 }
 feedbackEditor={point,trigger,assetId:viewState.loadedAssetId,editing:point.note!==undefined};
 $('feedbackPointTitle').textContent=feedbackEditor.editing?'编辑反馈标记':'标记当前画面';
 $('feedbackPointAnchor').textContent=point.time.toFixed(3)+' 秒 · '+feedbackPart(point)+' · '+point.clip;
 $('feedbackPointNote').value=point.note||'';$('feedbackPointError').hidden=true;
 $('feedbackPointDialog').showModal();
}
$('addFeedbackPoint').onclick=()=>openFeedbackEditor();
$('quickFeedbackPoint').onclick=e=>openFeedbackEditor(null,e.currentTarget);
$('cancelFeedbackPoint').onclick=()=>$('feedbackPointDialog').close();
$('feedbackPointDialog').addEventListener('close',()=>{feedbackEditor=null;});
$('feedbackPointForm').onsubmit=event=>{
 event.preventDefault();
 const editor=feedbackEditor,note=$('feedbackPointNote').value.trim();
 try{
  if(!note)throw Error('请描述这处想怎么改。');
  if(!editor||!canEditFeedback()||editor.assetId!==viewState.loadedAssetId)throw Error('当前素材已变化，请关闭后重新定位。');
  if(editor.editing&&!state.feedbackPoints.includes(editor.point))throw Error('这条标记已变化，请关闭后重新打开。');
  if(!editor.editing&&!pointsForClip([editor.point],activeModel()?.meta.sha256,activeModel()?.clip).length)throw Error('当前动作已变化，请关闭后重新定位。');
  const point={...editor.point,note};
  state.feedbackPoints=validateFeedbackPoints(editor.editing?state.feedbackPoints.map(p=>p===editor.point?point:p):[...state.feedbackPoints,point]);
  $('feedbackPointDialog').close();feedbackDraftChanged();
  (editor.trigger||$('feedbackPointList').querySelector('[data-feedback-point="'+point.id+'"]')||$('addFeedbackPoint')).focus({preventScroll:true});
  if(editor.trigger)toast('已保存反馈标记');
 }catch(error){$('feedbackPointError').textContent=error.message;$('feedbackPointError').hidden=false;$('feedbackPointNote').focus();}
};

function drawMetadata(){
 drawStudioSync();
 $('runtimeStageMode').disabled=!runtimeStage.active&&(state.loading||state.switching||runtimeStageInput().ineligible);
 drawRecovery();
 updateSideWarning();
 drawFeedbackPoints();
 syncFootDiagnostics();
 drawFootRepair();
 for(const b of $('versionModes')?.querySelectorAll?.('button')||[])b.disabled=Boolean(state.motionPreview);
 drawAppearance({mode:appearance.mode,descriptor:appearance.descriptor,error:appearance.error});
 const m=activeModel();if(!m)return;
 const teaching=m.meta.generator?.includes('original teaching');
 const title=state.project.title&&state.project.title!=='动作反馈练习'?state.project.title:teaching?'原创练习角色':m.meta.label.replace(/\.(glb|fbx)$/i,'');
 castBrowser?.sync();
 $('roleName').textContent=title||'当前角色';$('workspaceTitle').textContent=title||'动作修改工作台';$('assetKind').textContent=resourceLabel(m.capabilities);
 const replacement=Object.hasOwn(m.meta.source?.actionReplacements||{},m.clip||'');
 const motionOrigin=m.meta.source?.assembly?.clips?.[m.clip];
 $('assetDescription').textContent=replacement?'已替换 · '+m.clip:motionOrigin?'动作来源：'+motionOrigin.file+' · '+motionOrigin.sourceClip:teaching?'原创教学角色，可以直接体验一次动作修改。':m.capabilities.limitations.join('；')||'素材留在本机，原文件与每次修改独立保留。';$('assetLabel').textContent=m.meta.label;$('assetStats').textContent=(m.meta.bytes/1048576).toFixed(1)+' MB · '+m.joints.length+' 个骨骼 / 节点';
 const clipInfo=m.clip?classifyAction(m.clip,{duration:m.duration}):null;$('clipTitle').textContent=m.clip==='mixamo.com'?'角色动作':clipInfo?.label||resourceLabel(m.capabilities);$('clipTitle').title=m.clip||'';$('roleName').textContent=[assetTitle(m)||'当前角色',m.clip&&m.clip!==clipInfo?.label?m.clip:null,m.duration?m.duration.toFixed(2)+' s':null].filter(Boolean).join(' · ');$('stageEyebrow').style.setProperty('--heading-cat',clipInfo?'var(--cat-'+clipInfo.category+')':'var(--ms-accent)');$('stageEyebrow').textContent=state.motionPreview?.replacement?'动作替换 · 对比':state.motionPreview?'匹配动作 · 试播':state.archivedJobId?'历史版本':state.focus==='candidate'?'修改后的版本':clipInfo?({idle:'待机',move:'移动',attack:'攻击',skill:'技能',defense:'防御',hit:'受击',air:'跳跃',down:'倒地',emote:'表演',other:'动作'})[clipInfo.category]:'当前资源';
 $('currentHash').textContent=m.meta.sha256;$('stageStatus').textContent=state.motionPreview?'动作试播 · 模型版本保持':state.archivedJobId?'历史对照 · 当前素材保持':(m.appearance?'项目外观 · ':'中性检查 · ')+resourceLabel(m.capabilities);
 $('baselineFile').textContent=state.models.baseline?.meta.label||'—';$('candidateFile').textContent=(state.models.candidate?.meta||state.project?.slots.candidate)?.label||'尚无候选';$('baselineImportName').textContent=state.models.baseline?.meta.label||'';$('candidateImportName').textContent=(state.models.candidate?.meta||state.project?.slots.candidate)?.label||'';
 if(!state.target){$('targetText').textContent=m.capabilities.preview==='curves'?resourcePanels[activeSlot()].observe()?.binding||'全部曲线':m.capabilities.hasMesh?'整个模型':'整个资源';}$('openTarget').disabled=!m.capabilities.canPickNode&&!m.capabilities.canPickSurface;
 $('exampleBanner').hidden=!teaching||state.jobs.some(j=>j.state==='complete');$('scopeMode').disabled=!m.duration;
 $('clipLockOption').hidden=!m.clip;
 if(!m.duration){$('scopeMode').value='whole';$('scopeInputs').hidden=true;$('scopeStart').disabled=true;$('scopeEnd').disabled=true;}
 $('scopeEnd').max=String(m.duration);$('scopeStart').max=String(m.duration);if($('scopeMode').value==='whole')$('scopeEnd').value=String(m.duration);

 $('snapshotButton').disabled=$('quickSnapshot').disabled=['curves','metadata'].includes(m.capabilities.preview);$('scaleMode').disabled=state.loading||state.switching||state.capturing||state.submitting;$('bones').disabled=!m.joints.length;$('lockRoot').disabled=!m.action;$('stageHint').textContent=m.capabilities.preview==='curves'?'选择轨道与分量 · 时间轴定位 · 可提交曲线反馈':m.capabilities.preview==='metadata'?'此容器没有可显示内容':'拖动旋转 · 滚轮缩放 · 点击选节点或表面';$('returnCurrent').hidden=!state.archivedJobId;drawAgent();updateClock();updateWorkflow();scheduleProjectPreview();
}
function scope(){const d=activeModel()?.duration||0,repair=activeFootRepair();if(repair)return footRepairScope(repair,d);if($('scopeMode').value==='whole')return{start:0,end:d,wholeClip:true};const start=Number($('scopeStart').value),end=Number($('scopeEnd').value);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>d+.0001)throw Error('请选择有效的时间范围：开始需早于结束，并位于当前动作内。');return{start,end,wholeClip:false};}
function updateScopeVisual(){
 const repair=activeFootRepair(),range=repair?footRepairScope(repair,activeModel().duration):$('scopeMode').value==='range'?{start:Number($('scopeStart').value)||0,end:Number($('scopeEnd').value)||0}:null;
 $('scopeText').textContent=range?range.start.toFixed(2)+'–'+range.end.toFixed(2)+' 秒':'整个动作';
 $('localScope').textContent='时间范围 · '+(range?$('scopeText').textContent:'整段');
 const bar=$('scopeVisual'),d=duration();bar.hidden=!range||!d;
 if(!bar.hidden){bar.style.left=Math.max(0,range.start/d*100)+'%';bar.style.width=Math.max(0,Math.min(100,(range.end-range.start)/d*100))+'%';}
}
async function refreshModels({preserve=true,force=false,selectionTicket=null,observation=null,needCandidate=false,preparedProject=null,stillWanted=()=>true}={}){
 if(state.motionPreview)clearMotionTrial(false);
 if(state.capturing||state.switching&&!selectionTicket||selectionTicket&&!viewState.isCurrent(selectionTicket))return null;
 const ticket=viewState.beginLoad();if(!ticket)return null;
 const old=preserve&&state.ready?context():null,savedTime=state.time,savedPlaying=state.playing,savedFocus=state.focus,savedDisplay=state.display;
 state.loading=true;state.playing=false;$('stageLoading').hidden=state.ready;$('stageError').hidden=true;
 try{
  const d=preparedProject?{project:preparedProject}:await api('/api/session','GET',undefined,{assetId:ticket.assetId,signal:ticket.signal});
  if(!d.project?.activeAssetId||!viewState.isUnchanged(ticket,d.project.activeAssetId))return null;
  if(!preparedProject){state.token=d.token;state.paths=d.paths||{};state.caller=d.caller||null;}
  const current=()=>viewState.isUnchanged(ticket,d.project.activeAssetId)&&stillWanted();
  const wanted={baseline:d.project.slots.baseline};
  if(needCandidate||preserve&&(savedFocus==='candidate'||savedDisplay!=='single'||state.models.candidate?.meta.assetId===d.project.activeAssetId))wanted.candidate=d.project.slots.candidate;
  const preferred=Object.fromEntries(slots.map(slot=>[slot,observation?.slots?.[slot]?.clip||old?.slots?.[slot]?.clip]));
  if(wanted.candidate&&!preferred.candidate)preferred.candidate=preferred.baseline;
  if(!await loadPair(wanted,force,current,observation?observationFrameOptions(observation):null,preferred)||!current())return null;
  if(!state.models.baseline)throw Error('尚无基线素材，请导入原版角色。');
  if(!viewState.markLoaded(ticket,d.project.activeAssetId))return null;
  const prior=state.project;state.project=d.project;state.fps=d.project.fps||30;state.ready=true;
  if(old){
   await Promise.all(slots.map(slot=>{const clip=old.slots[slot]?.clip;if(clip&&state.models[slot]?.clip!==clip&&state.models[slot]?.clips.some(c=>c.name===clip))return selectClip(slot,clip);}));
   if(!current())return null;
   cameraBusy=true;for(const slot of slots){cameras[slot].position.fromArray(old.cameras[slot].position);controls[slot].target.fromArray(old.cameras[slot].target);cameras[slot].fov=old.cameras[slot].fov;cameras[slot].updateProjectionMatrix();controls[slot].update();}cameraBusy=false;
   state.focus=savedFocus;state.display=savedDisplay;state.time=Math.min(duration(),savedTime);state.playing=savedPlaying;
  }else{state.focus='baseline';state.display='single';state.time=0;state.playing=duration()>0;view(state.view==='orbit'?'front':state.view);}
  if(state.target&&state.models[state.target.slot]?.meta.sha256!==state.target.assetSha256)state.target=null;
  $('stageLoading').hidden=true;drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();render();
  return {candidateChanged:prior?.slots?.candidate?.sha256!==state.project.slots.candidate?.sha256,observationTicket:ticket};
 }finally{if(viewState.isUnchanged(ticket)){state.loading=false;$('stageLoading').hidden=true;drawMetadata();drawLatestJob();renderLoop?.wake();}}
}
// Shared by draft/history restoration and candidate comparison. Async identity
// checks stay at the caller boundary. Resolve selected clips before applying
// transport and camera settings.
async function applyObservation(ctx,options={}){
 const plan=planObservationRestore(ctx,state.models,options),settings=plan.settings;
 await Promise.all(Object.entries(plan.clips).map(([slot,clip])=>selectClip(slot,clip,options.isCurrent)));
 if(options.isCurrent&&!options.isCurrent())return false;
 restoreOfflinePreset(ctx);
 state.playing=false;state.display=plan.display;state.focus=plan.focus;
 $('lockRoot').checked=settings.rootLocked;$('linkCameras').checked=settings.linkedCameras;$('progress').checked=settings.mode==='progress';$('scaleMode').value=settings.scaleMode;
 state.speed=settings.speed;$('speed').value=String(state.speed);state.loop=settings.loop;drawLoop();
 state.observationTransform=plan.normalization?{...plan.normalization,sha256:state.models.baseline?.meta.sha256,assetId:state.models.baseline?.meta.assetId||state.project?.activeAssetId}:null;normalizePair();state.time=restoredTransportTime(plan,state.models);state.view=settings.view;const scale=activeModel()?.frame?.distanceScale||1;for(const slot of slots){cameras[slot].near=Math.max(.00001,.01*scale);cameras[slot].far=Math.max(1000,1000*scale);controls[slot].minDistance=.45*scale;controls[slot].maxDistance=40*scale;}
 cameraBusy=true;try{for(const [slot,camera] of Object.entries(plan.cameras)){cameras[slot].position.fromArray(camera.position);controls[slot].target.fromArray(camera.target);if(camera.fov)cameras[slot].fov=camera.fov;cameras[slot].updateProjectionMatrix();controls[slot].update();}}finally{cameraBusy=false;}
 setViewButtons();$('focusSlot').value=state.focus;return true;
}
async function restoreContext(ctx,{isCurrent=()=>true}={}){
 if(!ctx)return;const appearanceTicket=viewState.capture();
 const appearanceChanged=await appearance.chooseRecorded(ctx.appearance,state.project?.activeAssetId,()=>isCurrent()&&viewState.isUnchanged(appearanceTicket));
 if(!isCurrent()||appearanceChanged===null||!viewState.isUnchanged(appearanceTicket))return;
 const needsCandidate=Boolean(ctx.slot==='candidate'||ctx.focus==='candidate'||ctx.display&&ctx.display!=='single');
 if(appearanceChanged||appearance.mode==='project'||needsCandidate&&!state.models.candidate){const refreshed=await refreshModels({force:appearanceChanged||appearance.mode==='project',selectionTicket:appearanceTicket,observation:ctx,needCandidate:needsCandidate});if(!isCurrent()||!refreshed||!viewState.isCurrentMutation(appearanceTicket)||!viewState.isUnchanged(refreshed.observationTicket))return;}
 const ticket=viewState.capture();
 if(await applyObservation(ctx,{isCurrent:()=>isCurrent()&&viewState.isUnchanged(ticket)})===false)return;drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();render();resourcePanels[activeSlot()].restore(ctx.resourceObservation);render();
 if(ctx.selection){const selected=ctx.selection,m=state.models[selected.slot];if(m?.meta.sha256===selected.assetSha256&&(!selected.bone||joint(m,selected.bone,selected.nodeIndex)))setTarget(structuredClone(selected));else clearTarget();}
}

function viewMatchesJob(job,needCandidateVisible=false){return Boolean((job.assetId||state.project?.legacyAssetId||'legacy')===state.project?.activeAssetId&&job.candidate&&state.models.candidate?.meta.sha256===job.candidate.sha256&&state.models.baseline?.meta.sha256===jobSourceAsset(job)?.sha256&&(!needCandidateVisible||state.display!=='single'||state.focus==='candidate'));}
async function showCandidate(job,{restoreAppearance=false,feedbackPoint=null}={}){
 if(job?.summaryOnly){const ticket=viewState.capture();job=await ensureJobDetail(job);if(!job||!viewState.isUnchanged(ticket,job.assetId))return false;}
 const assetId=job?.assetId||state.project?.legacyAssetId||'legacy';
 if(assetId!==state.project?.activeAssetId)throw Error('请先打开这条任务所属的模型。');
 if(state.switching||state.capturing||feedbackPoint&&state.loading)return false;
 if(!job?.candidate||!job.inputs?.baseline||!jobSourceAsset(job))throw Error('此任务没有完整的归档候选信息。');
 const ticket=viewState.beginLoad();if(!ticket)return false;
 state.playing=false;const archived=!currentComparison(job,state.project);
 const inputSlot=job.slot||'baseline',observation=feedbackPoint?feedbackObservation(job.context||{},feedbackPoint,inputSlot,{comparison:true}):job.context||{};
 state.loading=true;drawMetadata();
 try{
  const appearanceChanged=restoreAppearance?await appearance.chooseRecorded(job.context?.appearance,assetId,()=>viewState.isUnchanged(ticket,assetId)):false;if(appearanceChanged===null)return false;
  const wanted={baseline:jobSourceAsset(job),candidate:job.candidate};
  if(!await loadPair(wanted,appearanceChanged,()=>viewState.isUnchanged(ticket,assetId),observationFrameOptions(observation,inputSlot)))return false;
  if(!viewState.markLoaded(ticket,assetId))return false;
  state.selectedJob=job.id;state.panelMode='task';state.archivedJobId=archived?job.id:null;state.display='split';state.focus='candidate';
  const missingClip=feedbackPoint&&!state.models.candidate.clips.some(c=>c.name===feedbackPoint.clip);
  if(missingClip)selectClip('candidate',null);
  if(await applyObservation(observation,{inputSlot,fallbackClip:job.clip,isCurrent:()=>viewState.isUnchanged(ticket,assetId)})===false)return false;
  state.reviewFeedbackPoint=feedbackPoint?{jobId:job.id,id:feedbackPoint.id}:null;
  $('focusSlot').value='candidate';clearTarget();
  const target=feedbackPoint?feedbackPoint.target:job.target;
  const matched=correspondingJoint(state.models.candidate,state.models.baseline,target);
  if(matched&&!missingClip){setTarget({slot:'candidate',assetSha256:state.models.candidate.meta.sha256,bone:rawName(state.models.candidate,matched),nodeIndex:state.models.candidate.parser?.associations?.get(matched)?.nodes,space:'bone-local',inferred:false});}
  else if(feedbackPoint?.target)setTarget({...target,slot:'baseline',assetSha256:feedbackPoint.assetSha256});
  drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();drawLatestJob();render();const curve=job.context?.resourceObservation||resourcePanels.baseline.observe();if(curve){for(const slot of slots)resourcePanels[slot].restore(curve);render();}
  const alignment=missingClip?'候选缺少这个动作，右侧显示静止姿态。':feedbackPoint&&feedbackPoint.time>state.models.candidate.duration+.001?'标记时间超出候选长度，右侧停在最后一帧。':null;
  notice(alignment||(archived?'正在比较此历史任务修改前后的版本。当前工作区素材没有改变；返回当前素材后可继续发起修改。':(job.review||job.reviews?.at(-1))?.decision==='accept-candidate'?'已保留此版本，可准备接入游戏或继续比较。':'候选已载入，镜头与时刻已对齐。请检查完整动作后再决定。'));return true;
 }finally{if(viewState.isUnchanged(ticket)){state.loading=false;drawMetadata();drawLatestJob();renderLoop?.wake();}}
}

function currentJob(){return state.jobs.find(x=>x.id===state.selectedJob)||[...state.jobs].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''))[0];}
function activeTask(){return activeStudioJob(state.jobs,state.project?.activeAssetId);}
function workspaceCandidate(){return currentStudioCandidate(state.jobs,state.project,state.candidateJobId);}
function candidateViewed(job){return state.selectedJob===job.id&&viewMatchesJob(job);}
function staleWorkspaceView(){
 return !state.archivedJobId&&!state.motionPreview&&workspaceViewOutdated(state.project,{
  baseline:state.models.baseline?.meta,candidate:state.models.candidate?.meta
 },activeSlot())&&!state.jobs.some(job=>job.state==='complete'&&
   job.id===state.selectedJob&&viewMatchesJob(job)&&job.candidate.sha256===state.project?.slots.candidate?.sha256);
}
function drawStudioSync(){
 const banner=$('studioSyncBanner'),status=$('studioSyncStatus'),action=$('studioSyncAction');
 const running=activeTask(),candidate=workspaceCandidate();
 const ready=candidate&&!candidateViewed(candidate)&&(!candidate.review&&!candidate.artisticDecision||state.archivedJobId||staleWorkspaceView());
 const stale=state.archivedJobId||staleWorkspaceView();
 const kind=running?'busy':ready?'ready':stale?'stale':'';
 banner.hidden=!kind;banner.dataset.kind=kind;
 let message,label;
 if(kind==='busy'){
  const who=running.executor==='local'?'本地微调':running.delivery==='chat'?callerLabel(running.caller):executorLabel(running.provider);
  const phase={queued:'等待领取',running:'正在修改','needs-input':'等待补充'}[running.state];
  message=who+' · '+phase+(running.clip?' · '+running.clip:'')+'。可预览和写草稿，当前角色暂不可提交修改。';
  label='查看任务';
 }else if(kind==='ready'){
  message=state.archivedJobId?'当前画面是历史对照。新候选已就绪。':'新候选已就绪。可随时查看前后对照。';
  label='查看最新对照';
 }else if(kind==='stale'){
  message=state.archivedJobId?'正在查看历史版本。':'素材已更新，画面仍为先前版本。';
  label='返回当前素材';
 }
 if(status.textContent!==(message||''))status.textContent=message||'';
 if(action.textContent!==(label||''))action.textContent=label||'';
 action.disabled=state.loading||state.switching||state.capturing||state.submitting;
 const disabled=Boolean(running)||Boolean(stale);
 $('submitRequest').disabled=disabled||!state.initialized||!state.ready||!activeModel()?.capabilities.canInspect||
   state.loading||state.switching||state.submitting||Boolean(state.motionPreview);
 $('saveQueued').disabled=$('submitRequest').disabled;
 $('localEdit').disabled=!canLocalEdit()||disabled;
 $('localPreview').disabled=!canLocalEdit();
 undoControls.draw();
}
async function openSyncedJob(job){
 if(!job||state.loading||state.switching||state.capturing||state.submitting)return;
 persistView();
 const ticket=viewState.beginMutation();if(!ticket)return;
 let full=await ensureJobDetail(job);
 if(!full||!viewState.isUnchanged(ticket,job.assetId))return;
 if(full.state==='complete'&&job.state!=='complete'){
  await pollStudio();
  if(!viewState.isUnchanged(ticket,job.assetId))return;
  const current=workspaceCandidate();
  if(current?.id!==full.id)return;
  full=await ensureJobDetail(current);
  if(!full||!viewState.isUnchanged(ticket,job.assetId))return;
 }
 runtimeStage.stop();
 clearMotionTrial(false);clearLocalPreview();
 castBrowser?.setMode('studio');
 state.selectedJob=full.id;state.panelMode='task';state.explicitCompose=false;
 if(full.state==='complete')await showCandidate(full,{restoreAppearance:true});
 else{jobsRenderSignature='';drawJobs();}
 persistView();
}
$('studioSyncAction').onclick=()=>{
 const pending=activeTask(),job=workspaceCandidate();
 if(pending||job&&!candidateViewed(job))openSyncedJob(pending||job).catch(fail);
 else returnCurrentVersion().catch(fail);
};
const phaseNames={reading:'理解要求与检查素材',editing:'正在修改素材',checking:'检查修改结果',exporting:'导出并载入候选'};
function elapsedLabel(date){if(!date)return'尚未开始';const n=Math.max(0,Math.floor((Date.now()-new Date(date).getTime())/1000));return n<60?n+'秒':n<3600?Math.floor(n/60)+'分 '+n%60+'秒':Math.floor(n/3600)+'小时 '+Math.floor(n%3600/60)+'分';}
function queuedAhead(job){return state.jobs.filter(j=>j.id!==job.id&&j.executor!=='local'&&j.delivery!=='chat'&&(j.provider||'codex')===(job.provider||'codex')&&(['queued','running'].includes(j.state))&&(j.createdAt||'')<(job.createdAt||'')).length;}
function jobText(job){
 const recovery=job.reviews?.at(-1)?.recovery;if(recovery?.direction==='undo')return'已恢复此前的选择。候选文件仍保留，可重做或重新查看对照。';
 if(job.state==='queued'){if(job.delivery==='chat')return'任务与观察现场已保存，等待 '+callerLabel(job.caller)+' 的原对话领取。';if(job.executor==='local')return'正在准备本地数值工具，未调用 AI。';if(!state.agent?.connected||state.agent.provider!==(job.provider||'codex'))return'修改要求和当前画面已经保存。连接 '+executorLabel(job.provider)+' 后即可开始。';const ahead=queuedAhead(job);return ahead?'本机 Agent 会按顺序处理，前方还有 '+ahead+' 个任务。':'所选执行器已连接，正在等待它领取这条任务。';}
 if(job.state==='running')return job.executor==='local'?'正在按你指定的倍率调整旋转摆幅，未调用 AI。':'原版独立保留。Agent 将根据你的要求生成一个修改候选。';
 if(job.state==='complete'&&(job.review||job.reviews?.at(-1))?.decision==='accept-candidate')return'此版本已保留。可以准备接入游戏，或在这版上继续调整。';
 if(job.state==='complete')return job.executor==='local'?'本地数值候选已生成，未调用 AI。请播放完整动作检查。':'修改后的版本已返回。请播放完整动作，检查它是否符合你的想法。';
 if(job.state==='interrupted')return job.error?errorString(job.error):'本轮执行已中断。要求和已有输出已保留，可以在原输入版本上重新执行。';
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
 const candidate=workspaceCandidate(),attention=activeTask()||candidate&&!candidate.review&&!candidate.artisticDecision&&!candidateViewed(candidate)?1:0;if(attention&&document.body.dataset.mode==='library')$('modeStudio').dataset.badge=String(attention);else delete $('modeStudio').dataset.badge;
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
function agentSwitch(provider){
 const agent=state.agent;
 if(!agent?.active||agent.provider===provider)return null;
 return {label:executorLabel(agent.provider),busy:Boolean(agent.jobId||agent.state==='claiming')};
}
async function connectAgent(provider=$('executorProvider').value){
 try{
  const result=await api('/api/agent/connect','POST',{provider});
  if(result.error||!result.connected||result.provider!==provider)throw Error(result.error||'连接已取消，请重试。');
  return result;
 }finally{await pollStudio();}
}
async function beginCompose({job=null,source=null,prefill=false}={}){
 runtimeStage.stop();
 if(state.motionPreview){notice('请使用试播栏的“以此动作继续修改”，先准备固定的工作版本。');return;}
 if(state.switching||state.loading||state.capturing)return;const ticket=viewState.capture();
 if(state.archivedJobId){notice('这是一条归档任务。请先返回当前素材，再继续修改。');return;}
 if(source==='candidate'&&job&&job.state==='complete'&&!viewMatchesJob(job)){if(!await showCandidate(job)||!viewState.isCurrent(ticket))return;}
 if(state.archivedJobId){notice('这是一条归档任务。请先返回当前素材，再继续修改。');return;}
 const matchingSlot=prefill&&(job?.feedbackPoints?.length||job?.footRepair)&&[job.slot,...slots].find(s=>state.project.slots[s]?.sha256===jobSourceAsset(job)?.sha256);
 const focus=source||matchingSlot||activeSlot(),sourceTime=matchingSlot?job.context?.time??0:localTime(focus),target=state.target?structuredClone(state.target):null,targetModel=state.target?state.models[state.target.slot]:null;
 // Comparisons temporarily load this round's input into the baseline canvas.
 // New tasks must bind the untouched canonical project slots again.
 if(!await refreshModels({preserve:true,needCandidate:focus==='candidate'})||!viewState.isCurrent(ticket))return;state.focus=focus;state.display='single';
 if(matchingSlot===focus&&jobSourceAsset(job)?.sha256===activeModel()?.meta.sha256){
  await selectClip(focus,job.clip);
  const range=job.scope?.wholeClip===false;
  $('scopeMode').value=range?'range':'whole';$('scopeInputs').hidden=!range;$('scopeStart').disabled=$('scopeEnd').disabled=!range;
  if(range){$('scopeStart').value=String(job.scope.start);$('scopeEnd').value=String(job.scope.end);}
 }
 state.time=Math.min(activeModel()?.duration||0,sourceTime);$('focusSlot').value=focus;
 if(target&&target.slot===focus&&target.assetSha256===state.models[focus]?.meta.sha256)setTarget(target);
 else if(target?.bone&&correspondingJoint(state.models[focus],targetModel,target)){const m=state.models[focus],bone=correspondingJoint(m,targetModel,target);setTarget({slot:focus,assetSha256:m.meta.sha256,bone:rawName(m,bone),nodeIndex:m.parser?.associations?.get(bone)?.nodes,space:'bone-local',inferred:target.inferred});}
 state.panelMode='compose';state.explicitCompose=true;state.composerSource=focus;state.lineageParentJobId=focus==='candidate'&&job?.candidate?.sha256===activeModel()?.meta.sha256?job.id:null;
 if(prefill&&job){
  $('request').value=job.pointOnly?'':job.request;$('preserve').value=job.preserve||'';
  const model=activeModel(),points=(job.feedbackPoints||[]).filter(p=>p.assetSha256===model?.meta.sha256&&!state.feedbackPoints.some(draft=>draft.id===p.id));
  if(points.length)state.feedbackPoints=[...state.feedbackPoints,...points].slice(0,MAX_FEEDBACK_POINTS);
  if(job.footRepair&&job.footRepair.assetSha256===model?.meta.sha256&&!state.footRepair)setFootRepairDraft(validateFootRepair(job.footRepair));
  if(job.feedbackPoints?.some(p=>!state.feedbackPoints.some(draft=>draft.id===p.id)))toast('有些标记未带入草稿。请查看原任务的标记，并在当前版本上重新定位。');
 }
 if(job)$('lockOtherClips').checked=job.lockOtherClips===true;
 if($('lockOtherClips').checked)$('clipLockOption').closest('details').open=true;
 $('composeKicker').textContent=focus==='candidate'?'基于当前版本':'提出修改';$('composeTitle').textContent=focus==='candidate'?'还想怎样调整？':'你想改哪里？';$('composeIntro').textContent=focus==='candidate'?'下一次会在当前版本上修改，最初原版继续保留。':'描述你想要的变化，让 Agent 处理余下的细节。';
 drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();jobsRenderSignature='';drawJobs();if(prefill)persistView();$('taskPanel').scrollIntoView({block:'nearest',behavior:'smooth'});$('request').focus({preventScroll:true});return true;
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
 drawStudioSync();
 if($('motionTrialInspector'))$('motionTrialInspector').hidden=!state.motionPreview;if(state.motionPreview){$('composeActions').hidden=true;$('reviewActions').hidden=true;$('composePanel').hidden=true;$('latestJob').hidden=true;return;}
 const count=state.jobCounts?.[state.project?.activeAssetId]?.total??state.jobs.length;
 $('jobCount').textContent=count;$('headerJobCount').textContent=count;
 const history=state.historyAssetId===state.project?.activeAssetId?state.historyJobs:[],historyKey=history.map(j=>j.id+':'+j.detailRevision).join('|');
 if(historyKey!==historyRenderSignature){historyRenderSignature=historyKey;const host=$('historyList');host.replaceChildren();
  for(const job of history){const card=el('button',undefined,'history-card');card.append(el('span',job.review?.decision==='accept-candidate'?'已保留候选':job.review?.decision==='keep-baseline'?'已保留修改前':statusNames[job.state]||job.state,'status-label '+job.state),el('strong',job.request),el('small',(job.clip||'静态资源')+' · '+new Date(job.createdAt||Date.now()).toLocaleString([],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})));card.onclick=async()=>{const ticket=viewState.capture();try{const full=await ensureJobDetail(job);if(!full||!viewState.isUnchanged(ticket,job.assetId))return;state.selectedJob=job.id;state.panelMode='task';castBrowser?.setMode('studio');$('libraryDialog').close();if(full.state==='complete')await showCandidate(full,{restoreAppearance:true});else drawLatestJob();$('taskPanel').scrollIntoView({block:'nearest',behavior:'smooth'});}catch(e){fail(e);}};host.append(card);}
  if(!history.length)host.append(el('p',count?'打开修改记录后按需读取历史。':'每一次要求、候选和决定都会保存在这里。','clip-empty'));
 }
 $('historyMore').hidden=$('historyList').hidden||!state.historyHasMore||state.historyAssetId!==state.project?.activeAssetId;$('historyMore').textContent='加载更多记录（已显示 '+history.length+' / '+(state.historyTotal||count)+'）';
 const j=currentJob(),switching=agentSwitch(j?.provider||'codex'),signature=[j?.id,j?.detailRevision,j?.updatedAt,j?.state,state.selectedJob,state.panelMode,state.agent?.connected,state.agent?.provider,switching?.busy,state.models.baseline?.meta.sha256,state.models.candidate?.meta.sha256,state.display,state.focus,activeTask()?.id,state.archivedJobId].join('|');
 if(signature===jobsRenderSignature){updateTaskClock();return;}jobsRenderSignature=signature;drawLatestJob();
}
function taskDetails(job,disclosures){
 const d=el('details');d.dataset.disclosure='execution';d.open=disclosures.get('execution')||false;d.append(el('summary','任务与执行详情'));
 if(job.providerSession)d.append(el('p','后台客户端：'+executorLabel(job.providerSession.provider)),el('p','独立会话：'+job.providerSession.sessionId),actionButton('复制后台会话编号',()=>copyText(job.providerSession.sessionId),'text-button'));
 const cmd=job.agentCommand||job.command,command=Array.isArray(cmd)?cmd.join(' '):cmd;
 if(command){d.append(actionButton('复制任务给其他 Agent',()=>copyText(command),'text-button'),el('pre',command));}
 const outputs=el('details');outputs.dataset.disclosure='outputs';outputs.append(el('summary','本轮输出与执行记录'));let outputLoading=false;outputs.addEventListener('toggle',async()=>{if(!outputs.open||outputLoading||outputs.dataset.loaded)return;outputLoading=true;const ticket=viewState.capture();try{const result=await api('/api/jobs/'+job.id+'/artifacts','GET',undefined,{signal:ticket.signal});if(!viewState.isUnchanged(ticket,job.assetId)||currentJob()?.id!==job.id)return;outputs.dataset.loaded='true';if(result.outputDirectory)outputs.append(el('p',result.outputDirectory));for(const file of result.files||[]){const link=el('a',file.file+' · '+(file.size/1024).toFixed(1)+' KB','download-candidate');link.href='/api/jobs/'+job.id+'/artifacts?file='+encodeURIComponent(file.file);link.download=file.file.split('/').at(-1);outputs.append(link);}if(!result.files?.length)outputs.append(el('p','这次执行尚未留下可下载文件。'));}catch(error){if(viewState.isUnchanged(ticket,job.assetId))outputs.append(el('p',error.message,'error-copy'));}finally{outputLoading=false;}});d.append(outputs);
 d.append(el('p','任务编号：'+job.id));if(job.taskPath||job.taskFile)d.append(el('p','任务文件：'+(job.taskPath||job.taskFile)));
 if(job.candidate)d.append(el('p','候选文件：'+job.candidate.file),el('p','候选 SHA-256：'+job.candidate.sha256));
 const trace=[...(job.events||[]),...(job.progressEvents||[])].sort((a,b)=>(a.at||'').localeCompare(b.at||''));for(const ev of trace.slice(-24))d.append(el('p',(ev.at?new Date(ev.at).toLocaleTimeString()+' · ':'')+(ev.phase?(phaseNames[ev.phase]||ev.phase)+' · ':'')+(typeof ev==='string'?ev:ev.message||ev.detail||ev.state||ev.type||JSON.stringify(ev))));
 return d;
}
function drawLatestJob(){
 const reviewDock=$('reviewActions');$('composeActions').hidden=true;reviewDock.hidden=true;reviewDock.replaceChildren();
 if(!state.initialized){$('composePanel').hidden=true;$('latestJob').hidden=true;return;}
 const job=currentJob(),card=$('latestJob'),show=state.panelMode==='task'&&Boolean(job);$('backFromCompose').hidden=show;$('composePanel').hidden=show;$('composeActions').hidden=show||Boolean(state.motionPreview);card.hidden=!show;updateWorkflow();if(!show){const candidate=state.composerSource==='candidate';$('composeKicker').textContent=candidate?'基于当前版本':'提出修改';$('composeTitle').textContent=candidate?'还想怎样调整？':'你想改哪里？';$('composeIntro').textContent=candidate?'下一次会在当前版本上修改，最初原版继续保留。':'描述你想要的变化，让 Agent 处理余下的细节。';return;}
 if(job.summaryOnly){card.replaceChildren(el('p','正在读取这条任务的详情…'));ensureJobDetail(job).then(full=>{if(full&&currentJob()?.id===full.id){jobsRenderSignature='';drawJobs();}}).catch(error=>{if(currentJob()?.id===job.id)card.replaceChildren(el('p',error.message,'error-copy'),actionButton('重新读取',()=>{jobsRenderSignature='';drawJobs();}));});return;}
 const same=card.dataset.jobId===job.id,disclosures=same?new Map([...card.querySelectorAll('details[data-disclosure]')].map(d=>[d.dataset.disclosure,d.open])):new Map();const reply=same?card.querySelector('#jobReply')?.value||'':'';const reviewReason=same?card.querySelector('#reviewReason')?.value||'':'',reviewText=same?card.querySelector('#reviewText')?.value||'':'';const transition=!same||card.dataset.state!==job.state;card.dataset.jobId=job.id;card.dataset.state=job.state;card.replaceChildren();
 const pending=['queued','running','needs-input'].includes(job.state),complete=job.state==='complete';
 const recovery=job.reviews?.at(-1)?.recovery;
 const titles={queued:job.executor==='local'?'准备本地微调':job.delivery==='chat'?'等待 '+callerLabel(job.caller)+' 领取':state.agent?.connected?'任务已排队':'等待连接 Agent',running:job.executor==='local'?'正在生成数值候选':'Agent 正在修改',complete:recovery?.direction==='undo'?'已撤销'+recovery.label:(job.review||job.reviews?.at(-1))?.decision==='accept-candidate'?'已采用这版':'修改候选已返回','needs-input':'需要你补充一句',failed:'这次没有完成',cancelled:'任务已停止',stale:'素材版本已变化',interrupted:'执行已中断'};
 const symbol=el('div',job.state==='running'?undefined:complete?'✓':['failed','needs-input'].includes(job.state)?'!':'◷','state-symbol '+job.state);symbol.setAttribute('aria-hidden','true');card.append(symbol,el('span',complete?'检查结果':pending?'修改进展':'修改记录','section-kicker'),el('h2',titles[job.state]||statusNames[job.state]),el('p',jobText(job),job.state==='failed'?'error-copy':'task-explanation'));
 if(job.caller)card.append(el('p','本次由 '+callerLabel(job.caller)+' 原对话处理','task-next'));
 if(job.state==='running'){
  const progress=el('div',undefined,'progress-card');progress.append(el('span','当前进度','progress-kicker'),el('h3',job.executor==='local'?'按指定倍率调整摆幅':phaseNames[job.progress?.phase]||'Agent 正在执行'),el('p',job.progress?.message||(job.executor==='local'?'数值工具正在执行，不调用 AI。':'正在执行修改任务，尚未上报具体阶段。')));card.append(progress);
  const timing=el('div',undefined,'task-timing');const total=el('span');total.append(document.createTextNode('已用时 '),el('b','—'));total.dataset.clock='elapsed';const last=el('span');last.append(document.createTextNode('最近更新 '),el('b','—'));last.dataset.clock='last';timing.append(total,last);card.append(timing);
  if(job.activity?.message&&job.activity.message!==job.progress?.message){const activity=el('div',undefined,'activity-card');activity.append(el('small','最近活动'),el('p',job.activity.message));card.append(activity);}card.append(el('p','无需操作。你可以继续观察，候选返回后可在这里查看对照。','task-next'));const stale=el('p','','task-next');stale.dataset.clock='stale';card.append(stale);
 }
 if(job.state==='queued'){
  const provider=job.provider||'codex',connected=state.agent?.connected&&state.agent.provider===provider,chat=job.delivery==='chat',local=job.executor==='local';
  const switching=!chat&&!local&&agentSwitch(provider),info=el('div',undefined,'progress-card');
  let title=connected?'任务已排队':'连接所选客户端，开始修改',detail=connected?'无需操作，按队列顺序处理。':'使用任务指定客户端的账户及正常用量。';
  if(chat){
   title='交给 '+callerLabel(job.caller);
   detail='复制任务，粘贴到'+(job.caller?'打开动作台的 '+callerLabel(job.caller)+' 原对话':'当前对话')+'。领取后这里会显示进度。';
  }else if(local){title='等待数值工具';detail='数值工具即将处理已保存的要求。';}
  else if(switching?.busy){title=switching.label+' 正在处理任务';detail='这条要求已保存。当前任务结束后，可在这里切换到 '+executorLabel(provider)+' 开始修改。';}
  else if(switching){title='可以切换到 '+executorLabel(provider);detail='当前客户端空闲，点击下方按钮即可切换并处理这条任务。';}
  info.append(el('span','下一步','progress-kicker'),el('h3',title),el('p',detail));card.append(info);
  if(chat)card.append(actionButton('复制任务给 '+callerLabel(job.caller),()=>copyText(taskHandoff(job,state.paths)),'primary-button'));
  else if(!connected&&!local&&!switching?.busy){
   card.append(actionButton((switching?'切换到 ':'连接 ')+executorLabel(provider)+' 并开始修改',()=>connectAgent(provider),'primary-button'));
   if(!switching&&(state.agent?.lastError||state.agent?.error))card.append(el('p',errorString(state.agent.lastError||state.agent.error),'error-copy'));
  }
 }
 if(job.state==='needs-input'){
  const form=el('form',undefined,'answer-form'),label=el('label','补充给 Agent');label.htmlFor='jobReply';const input=el('textarea');input.id='jobReply';input.rows=3;input.required=true;input.placeholder='用一句话说明即可…';input.value=reply;const send=el('button','补充并继续','primary-button');send.type='submit';form.append(label,input,send);form.onsubmit=async e=>{e.preventDefault();if(!input.value.trim())return;send.disabled=true;try{await api('/api/jobs/'+job.id+'/reply','POST',{message:input.value.trim()});await pollStudio();}catch(error){fail(error);send.disabled=false;}};card.append(form);
 }
 if(job.feedbackPoints?.length){
  const section=el('section',undefined,'feedback-points review-feedback-points'),heading=el('div',undefined,'feedback-points-heading');
  heading.append(el('h3','本轮反馈标记'));section.append(heading);
  if(complete)section.append(el('p','点选标记，回到同一时刻和镜头。','feedback-points-hint'));
  const activeId=state.reviewFeedbackPoint?.jobId===job.id?state.reviewFeedbackPoint.id:null;
  const onSeek=complete?async point=>{
   try{if(await showCandidate(job,{feedbackPoint:point}))revealFeedbackPoint(card,point);}
   catch(error){fail(error);}
  }:null;
  section.append(feedbackPointList(job.feedbackPoints,{describe:feedbackPart,activeId,onSeek}));card.append(section);
 }
 if(complete){
  if(!viewMatchesJob(job)){card.append(el('p','当前画面是另一版本。先打开这条任务的修改前后，避免看错结果。','task-next'),actionButton('打开这次修改的对照',()=>showCandidate(job,{restoreAppearance:true}),'primary-button'));}
  if(job.footRepair)card.append(footRepairEvidence(job,{partName:name=>semanticPart(name)||name,onError:fail,onSeek:async()=>{
   if(!await showCandidate(job))return;
   $('lockRoot').checked=false;$('progress').checked=false;updateDisplay();seek(job.footRepair.time[0]);$('stage').scrollIntoView({block:'nearest'});
  }}));
  card.append(candidateDiffEvidence(job,{open:disclosures.get('candidate-diff')}));
  if(job.summary){card.append(el('span','这次改了什么','result-label'));if(job.summary.length>420){card.append(el('p',job.summary.slice(0,350)+'…','result-summary'));const full=el('details');full.dataset.disclosure='summary';full.open=disclosures.get('summary')||false;full.append(el('summary','展开完整修改说明'),el('p',job.summary));card.append(full);}else card.append(el('p',job.summary,'result-summary'));}else card.append(el('p','候选已经生成。Agent 没有附上额外说明，请以动作与验证记录为准。','result-summary'));
  const checks=resultEvidence(job,{onSeek:time=>{if(!viewMatchesJob(job))return;const plan={timeSlot:'candidate',localTime:time,display:state.display,focus:state.focus,settings:{mode:$('progress').checked?'progress':'elapsed'}};seek(restoredTransportTime(plan,state.models));$('stage').scrollIntoView({block:'nearest'});}});const disclosure=checks.querySelector('details[data-disclosure]');if(disclosure)disclosure.open=disclosures.get('evidence')||false;card.append(checks);
  const versions=el('details',undefined,'version-provenance');versions.append(el('summary','本轮版本与来源'));const reviewDecision=job.review||job.reviews?.at(-1);
  versions.append(el('small','最初原版 · '+(job.inputs.baseline?.sha256?.slice(0,10)||'未知')),el('small','本轮修改前 · '+(jobSourceAsset(job)?.sha256?.slice(0,10)||'未知')),el('small',(reviewDecision?.decision==='accept-candidate'?'已认可候选':'本轮候选')+' · '+(job.candidate?.sha256?.slice(0,10)||'未知')));card.append(versions);
  const blocked=protectionMessage(job);
  const actions=el('div',undefined,'result-actions');const next=actionButton(state.archivedJobId?'返回当前素材后继续':blocked?'从修改前继续':'继续调整',()=>blocked?recordDecision(job,'keep-baseline'):beginCompose({job,source:'candidate'}),'secondary-button');next.disabled=Boolean(state.archivedJobId)||Boolean(blocked&&activeTask())||!viewMatchesJob(job);
  if(job.candidate){const download=el('a','下载修改后的 GLB ↓','download-candidate');download.href='/workspace/'+job.candidate.file;download.download=job.candidate.label||'candidate.glb';actions.append(download);}
  const feedback=el('details',undefined,'review-feedback');feedback.dataset.disclosure='review';feedback.open=disclosures.get('review')||false;feedback.append(el('summary','评审意见（可选）'));
  const reasonLabel=el('label','未采用或继续修改的原因'),reason=el('select');reason.id='reviewReason';reasonLabel.htmlFor=reason.id;for(const [value,label] of [['','不选择原因'],['direction','修改方向不符合预期'],['too-much','变化幅度过大'],['too-little','变化不明显'],['regression','影响了需要保持的部分'],['quality','动作或模型出现问题'],['other','其他原因']]){const option=el('option',label);option.value=value;reason.append(option);}reason.value=reviewReason;
  const textLabel=el('label','补充说明'),text=el('textarea');text.id='reviewText';text.rows=2;text.placeholder='可以留空；例如右脚仍然滑动，希望继续修正。';text.value=reviewText;textLabel.htmlFor=text.id;feedback.append(reasonLabel,reason,textLabel,text);actions.append(feedback);
  const accepted=(job.reviews?.at(-1)?.decision==='accept-candidate'?job.reviews.at(-1):null);
  const yes=actionButton(accepted?'已采用':'采用这版',()=>recordDecision(job,'accept-candidate'),'primary-button'),keep=actionButton('不用这版',()=>recordDecision(job,'keep-baseline'),'secondary-button');yes.disabled=Boolean(activeTask())||Boolean(accepted)||!viewMatchesJob(job,true)||Boolean(blocked);if(blocked)yes.title=blocked;keep.disabled=Boolean(activeTask())||!viewMatchesJob(job);reviewDock.append(yes,next,keep);reviewDock.hidden=false;card.append(actions);
  if(accepted)card.append(actionButton('接入游戏…',()=>integrationPanel.open({jobId:job.id}),'text-button'));
  if(accepted&&state.archivedJobId){const restore=actionButton('恢复这条已认可版本',async()=>{const ticket=viewState.beginMutation();if(!ticket)return;const result=await api('/api/jobs/'+job.id+'/restore','POST',{checkpointId:accepted.id,expectedRevision:state.project.revision});if(!viewState.isUnchanged(ticket,job.assetId))return;state.archivedJobId=null;state.project=result.project;if(!await refreshModels({preserve:true})||!viewState.isCurrentMutation(ticket,job.assetId))return;state.studioRevision=null;await pollStudio();if(!viewState.isCurrentMutation(ticket,job.assetId))return;notice('已将这条已认可版本恢复为当前候选，可继续查看或调整。');toast('已恢复这条已认可版本。');},'secondary-button');restore.disabled=Boolean(activeTask());card.append(restore);}
  const review=job.review||job.reviews?.at(-1),integrated=review?.decision==='accept-candidate'?job.integrations?.at(-1):null,integratedFiles=integrated?integrated.files.slice(0,3).join('、')+(integrated.files.length>3?' 等 '+integrated.files.length+' 个文件':''):'';
  if(review&&!review.recovery)card.append(el('p',review.decision==='accept-candidate'?(integrated?'已接入游戏：'+integratedFiles+(integrated.gameChecked?'。':'。尚未记录游戏内检查。'):'已记录保留此候选，游戏文件保持。要放进游戏，回到对话让 Agent 接入。'):review.decision==='keep-baseline'?'已记录保留本轮修改前的版本。候选仍在历史中保留。':'已记录继续修改。','review-note'));if(review?.outcome)card.append(el('p',review.outcome,'review-note'));
 }else if(['failed','cancelled','stale','interrupted'].includes(job.state)){
  const actions=el('div',undefined,'task-action-stack');if(['failed','interrupted'].includes(job.state)){const retry=actionButton('重新执行这条任务',async()=>{const ticket=viewState.beginMutation();const result=await api('/api/jobs/'+job.id+'/retry','POST',{});if(!viewState.isUnchanged(ticket,job.assetId))return;commitJobResult(result,ticket);state.studioRevision=null;await pollStudio();},'secondary-button');retry.disabled=Boolean(activeTask());actions.append(retry);}actions.append(actionButton(job.state==='stale'?'返回当前素材，重新确认':'沿用要求，修改后重试',async()=>{if(state.archivedJobId||job.state==='stale'){state.archivedJobId=null;await refreshModels({preserve:true});}await beginCompose({job,prefill:true});},'primary-button'));card.append(actions);
 }
 const request=el('details');request.dataset.disclosure='request';request.open=disclosures.get('request')||false;request.append(el('summary','我的修改要求'),el('p',job.request,'request-quote'));if(job.lockOtherClips)request.append(el('p','本轮已锁定其他动作。'));if(job.preserve)request.append(el('p','需要保持：'+job.preserve));for(const answer of job.clarifications||[])request.append(el('p','补充：'+answer.message));card.append(request);
 if(job.state==='running'&&(job.executionHealth?.status||job.executionHealth)==='unresponsive')card.append(el('p','暂未收到执行器响应，可以停止生成；已保存的输入和产物会保留。','error-copy'));
 if(pending){reviewDock.append(actionButton('编辑下一轮草稿',async()=>{
  if(state.archivedJobId)await returnCurrentVersion();
  await beginCompose();
 },'secondary-button'),actionButton(job.state==='queued'?'取消排队':job.state==='running'?'停止生成':'取消任务',async()=>{const ticket=viewState.beginMutation();if(!ticket)return;const result=await api('/api/jobs/'+job.id+'/cancel','POST',{});if(!viewState.isUnchanged(ticket,job.assetId))return;commitJobResult(result,ticket);state.studioRevision=null;await pollStudio();await undoControls.refresh();toast(job.state==='queued'?'已取消排队':'已停止生成，已有版本保留');},'secondary-button'));reviewDock.hidden=false;}
 card.append(frozenProjectDetails(job,disclosures),taskDetails(job,disclosures));updateTaskClock();if(transition)requestAnimationFrame(()=>document.querySelector('.task-scroll').scrollTop=0);
}
function updateTaskClock(){const j=currentJob();if(!j||state.panelMode!=='task')return;const started=j.claimedAt||j.startedAt||j.updatedAt,last=j.lastActivityAt||j.activity?.at||j.progress?.at||j.updatedAt;const card=$('latestJob'),a=card.querySelector('[data-clock="elapsed"] b'),b=card.querySelector('[data-clock="last"] b'),c=card.querySelector('[data-clock="stale"]');if(a)a.textContent=elapsedLabel(started);if(b)b.textContent=elapsedLabel(last)+'前';if(c){const seconds=(Date.now()-new Date(last).getTime())/1000;c.hidden=seconds<60;c.textContent=seconds>=60?'暂未收到新进展，上次实际更新在 '+elapsedLabel(last)+'前。任务仍保留，可继续等待或停止。':'';}}
const pendingDecisions=new Map();
async function recordDecision(job,decision){
 if(activeTask())throw Error('当前角色已有任务，请先处理这条任务再记录评审。');
 if(state.loading||state.switching||state.capturing||state.submitting)throw Error('正在准备当前画面，请稍候再记录决定。');
 const ticket=viewState.beginMutation();if(!ticket)return;
 if(!viewMatchesJob(job,decision==='accept-candidate'))throw Error('当前画面与此任务版本不一致，请先打开该任务的候选对照。');
 const currentHead=currentComparison(job,state.project);
 const reason=$('reviewReason'),note=$('reviewText')?.value.trim(),reasonText=decision!=='accept-candidate'&&reason?.value?reason.options[reason.selectedIndex].textContent:'';const outcome=[decision==='accept-candidate'?'用户在动作台选择保留此候选；游戏接入仍需单独验证。':'用户选择保留本轮修改前的版本，不采用本轮候选。',reasonText?'原因：'+reasonText:'',note?'评审意见：'+note:''].filter(Boolean).join('\n');
 const decisionKey=job.id+'|'+decision+'|'+outcome;let decisionId=pendingDecisions.get(decisionKey);if(!decisionId){decisionId=crypto.randomUUID();pendingDecisions.set(decisionKey,decisionId);}const result=await api('/api/jobs/'+job.id+'/review','POST',{decision,outcome,decisionId});pendingDecisions.delete(decisionKey);
 if(!viewState.isCurrentMutation(ticket)||state.switching)return result;commitJobResult(result,ticket);
 const restored=decision==='keep-baseline'&&currentHead&&result.restoredSource?.sha256===jobSourceAsset(job)?.sha256;
 if(restored){state.archivedJobId=null;if(!await refreshModels({preserve:true,needCandidate:true})||!viewState.isCurrentMutation(ticket))return result;state.focus='candidate';state.display='single';$('focusSlot').value='candidate';clearTarget();}
 await pollStudio();if(!viewState.isCurrentMutation(ticket)||state.switching)return result;
 if(restored){await beginCompose({source:'candidate'});if(!viewState.isCurrentMutation(ticket)||state.switching)return result;const parent=state.jobs.find(j=>j.id===job.parentJobId&&j.candidate?.sha256===state.models.candidate?.meta.sha256);if(parent){state.lineageParentJobId=parent.id;scheduleProjectPreview();}toast('已保留本轮修改前的版本，可在这版上继续。被撤下的候选仍在记录中。');}
 else toast(decision==='accept-candidate'?'已记录保留候选，游戏文件保持。要放进游戏，回到对话让 Agent 接入。':'已记录保留该任务修改前的版本，当前工作区未切换。');
 await offerUndo(decision==='accept-candidate'?'已采用这版':'已回到修改前');persistView();
 return result;
}
function drawAgent(){
 const connected=Boolean(state.agent?.connected),chat=$('executionMode').value==='chat',label=callerLabel(state.caller);
 $('executorPicker').hidden=chat;
 $('executionMode').querySelector('option[value="chat"]').textContent=state.caller?'当前 '+label+' 对话':'当前对话处理';
 $('agentDot').classList.toggle('connected',!chat&&connected);$('agentLabel').textContent=chat?'当前对话 · '+label:connected?executorLabel(state.agent?.provider)+' 后台已连接':'后台未连接';
 $('agentConnect').disabled=chat;$('agentConnect').title=chat?'保存后等待原对话领取；不会自动唤醒客户端。':connected?'点击断开后台执行器。':'连接所选客户端后台处理。';
 const provider=$('executorProvider').value,switching=provider&&agentSwitch(provider);
 $('submitRequest').firstElementChild.textContent=state.submitting?'正在保存当前画面…':chat?'保存并交给 '+label:switching?switching.busy?'保存修改要求':'切换并开始修改':connected&&state.agent.provider===provider?'开始修改':'连接并开始修改';
 $('submitHint').textContent=chat?'保存后复制任务到原对话，领取后开始修改。':switching?.busy?switching.label+' 正在处理任务，完成后可以从任务卡切换。':switching?'提交后将切换到 '+executorLabel(provider)+'。':connected?'完成后可查看前后对照。':'使用所选客户端的账户、模型和正常用量。';
 $('saveQueued').hidden=chat;updateWorkflow();
}

let scanningExecutors=false;
async function scanExecutors(){
 if(scanningExecutors)return;scanningExecutors=true;$('scanExecutors').disabled=true;$('executorNote').textContent='正在检测本机客户端，不会启动修改任务…';
 try{const data=await api('/api/agents'),select=$('executorProvider'),previous=select.value||state.savedProvider;state.providers=data.providers;select.replaceChildren();
 for(const p of data.providers){const option=el('option',p.label+(p.available?'':p.status==='unsupported'?' · 尚未接入':p.status==='missing'?' · 未发现':' · 需配置'));option.value=p.id;option.disabled=!p.available;select.append(option);}
 const available=data.providers.filter(p=>p.available);select.value=previous?(available.some(p=>p.id===previous)?previous:''):available.find(p=>p.id===state.caller?.client)?.id||available[0]?.id||'';
 $('executorNote').textContent=available.length?'已扫描；登录、额度和工具权限在执行时验证。未接入的客户端可用原对话交接。':'暂无可用后台执行器；安装 Codex CLI、Claude Code 或 DeepSeek Harness 后重新扫描，也可用原对话处理。';drawAgent();
 }catch(e){$('executorNote').textContent='扫描失败：'+e.message;}finally{scanningExecutors=false;$('scanExecutors').disabled=false;}
}
$('scanExecutors').onclick=scanExecutors;$('executorProvider').onchange=()=>{state.savedProvider=$('executorProvider').value;drawAgent();persistView();};
let polling=false,pollErrors=0,syncTimer,syncRequested=false;
function scheduleStudioSync(){
 syncRequested=true;
 if(syncTimer||polling)return;
 syncTimer=setTimeout(()=>{syncTimer=null;void pollStudio();},40);
}
function pollBlocked(){return state.loading||state.switching||state.capturing||state.submitting;}
function followingCandidate(job){
 return canFollowCandidate(job&&!job.review&&!job.artisticDecision?job:null,{selectedJob:state.selectedJob,mode:castBrowser?.mode(),
  panel:state.panelMode,archived:state.archivedJobId,
  preview:state.motionPreview||localPreview||runtimeStage.active,
  dialog:document.querySelector('dialog[open]'),viewed:job&&candidateViewed(job)});
}
async function pollStudio(){
 if(polling){syncRequested=true;return;}
 if(pollBlocked()){if(syncRequested)scheduleStudioSyncLater();return;}
 polling=true;syncRequested=false;
 let ticket=viewState.capture();
 try{
  const d=await api('/api/studio','GET',undefined,{assetId:ticket.assetId,signal:ticket.signal,
   compact:true,since:state.studioAssetId===ticket.assetId?state.studioRevision:null});
  const assetId=d.unchanged?d.assetId:d.project?.activeAssetId;
  if(!assetId||!viewState.isUnchanged(ticket,assetId))return;
  if(pollBlocked()){syncRequested=true;return;}
  let resume=null;
  if(!d.unchanged){
   const prior=state.project;
   state.project=d.project;
   state.candidateJobId=d.candidateJobId??null;
   state.allJobs=Array.isArray(d.jobs)?d.jobs:[];
   state.jobs=state.allJobs.filter(j=>(j.assetId||d.project.legacyAssetId||'legacy')===assetId);
   if(d.version===3){
    state.jobs=state.jobs.map(mergeJobSummary);state.jobCounts=d.jobCounts||{};
    state.totalJobs=d.totalJobs;state.jobsRevision=d.jobsRevision;
    if(!$('historyList').hidden&&state.historyRevision!==d.jobsRevision)loadJobHistory().catch(fail);
    drawCatalog();
   }
   state.agent=d.agent||d.capabilities?.agent?.worker||null;
   if(d.capabilities?.runtime)environmentPanel.update(d.capabilities.runtime);
   const selected=state.jobs.find(j=>j.id===state.selectedJob);
   if(selected?.state==='complete'&&viewMatchesJob(selected)&&
    !currentComparison(selected,d.project)){
    state.archivedJobId=selected.id;
    $('returnCurrent').hidden=false;
    $('stageEyebrow').textContent='历史版本';
    $('stageStatus').textContent='历史对照 · 当前素材已更新';
   }
   if(!state.initialized&&!state.explicitCompose&&castBrowser?.mode()==='studio'){
    const candidate=workspaceCandidate();
    const wanted=(state.panelMode==='task'&&selected)||activeTask()||
     (candidate&&!candidate.review&&!candidate.artisticDecision?candidate:null);
    if(wanted){
     state.selectedJob=wanted.id;state.panelMode='task';
     if(wanted.state==='complete')resume=wanted;
    }
   }
   if(d.version===3){state.studioRevision=d.revision;state.studioAssetId=assetId;}
   drawAgent();drawJobs();updateDisplay();castBrowser?.draw();
   if(prior?.revision!==d.project.revision)void undoControls.refresh();
  }
  const current=workspaceCandidate();
  let result=resume||(followingCandidate(current)?current:null);
  if(result?.summaryOnly){
   result=await ensureJobDetail(result);
   if(!result||!viewState.isUnchanged(ticket,assetId)||pollBlocked()||!resume&&!followingCandidate(result))return;
  }
  if(result){
   if(!await showCandidate(result)||!viewState.isCurrentMutation(ticket,assetId))return;
   ticket=viewState.capture();drawStudioSync();
  }
  updateTaskClock();pollErrors=0;
 }catch(e){
  if(viewState.isCurrentMutation(ticket))state.studioRevision=null;
  if(e.name!=='AbortError'&&viewState.isCurrentMutation(ticket)&&!state.switching&&!state.submitting&&++pollErrors===2)
   notice('任务状态暂时无法同步：'+e.message+'。查看与已写意见保留。',true);
 }finally{
  polling=false;
  if(syncRequested)scheduleStudioSync();
 }
}
function scheduleStudioSyncLater(){
 if(syncTimer)return;
 syncTimer=setTimeout(()=>{syncTimer=null;void pollStudio();},180);
}

function commitJobResult(job,ticket){
 if(!job?.id||!viewState.isUnchanged(ticket,job.assetId)||state.project?.activeAssetId!==job.assetId||viewState.loadedAssetId!==job.assetId)return false;
 state.jobs=[job,...state.jobs.filter(j=>j.id!==job.id)];state.allJobs=[job,...(state.allJobs||[]).filter(j=>j.id!==job.id)];state.selectedJob=job.id;state.panelMode='task';drawJobs();updateClock();return true;
}
async function createJob(request,{local=false,operationTicket=null}={}){
 if(state.motionPreview)throw Error('请先将试播动作准备为独立工作版本，再提交修改');
 clearTimeout(projectPreviewTimer);projectPreviewSeq++;projectPreviewPendingKey=null;state.projectPreviewPending=false;
 if(activeTask())throw Error('当前角色已有任务，草稿已保留。');
 if(!state.ready||state.loading||state.switching||!viewState.loadedAssetId)throw Error('请先载入角色素材。');if(state.archivedJobId)throw Error('正在查看历史版本，请先返回当前素材，再创建修改任务。');state.playing=false;clearLocalPreview();render();const ctx=context(),range=scope();
 const ticket=operationTicket||viewState.beginMutation();if(!ticket||!viewState.isUnchanged(ticket))throw Error('观察版本已变化，请重新确认当前角色。');
 if(!local&&$('executionMode').value==='worker'&&!state.providers?.find(p=>p.id===$('executorProvider').value&&p.available))throw Error('请先选择扫描到的可用执行客户端');
 const feedbackPoints=local?[]:activeFeedbackPoints(),footRepair=local?null:footRepairForSubmission();
 const body={provider:local?undefined:$('executorProvider').value,assetId:viewState.loadedAssetId,request:request.trim(),preserve:$('preserve').value.trim(),lockOtherClips:Boolean(ctx.clip&&$('lockOtherClips').checked),target:state.target?structuredClone(state.target):null,scope:range,context:ctx,slot:activeSlot(),parentJobId:parentJobId(),executor:local?'local':'agent',delivery:local?'worker':$('executionMode').value,screenshot:captureStage().toDataURL('image/png'),feedbackPoints,footRepair};
 const result=await api('/api/jobs','POST',body);if(result.assetId!==body.assetId||!result.id)throw Error('服务返回的任务不属于提交的模型。');commitJobResult(result,ticket);return result;
}
async function submitRequest({connect=$('executionMode').value==='worker'}={}){
 if(activeTask()||staleWorkspaceView()||state.archivedJobId)return;
 if(state.submitting||state.switching||state.loading)return;const request=$('request').value.trim();
 const points=activeFeedbackPoints();let repair;
 try{repair=footRepairForSubmission();if(points.length)validateFeedbackPoints(points,{scope:scope()});}catch(error){toast(error.message);return;}
 if(state.footRepair&&!repair){toast('请切回诊断对应的动作和版本，或移除诊断后再提交。');return;}
 if(!request&&!points.length&&!repair){toast(state.feedbackPoints.length?'请切回标记所在的动作和版本，或填写本次修改要求。':'请填写修改要求，或标记当前画面。');return $('request').focus();}
 const side=updateSideWarning(),sideKey=side?side.bone+'|'+request:'';if(side&&sideAcknowledged!==sideKey){sideAcknowledged=sideKey;$('sideWarning').scrollIntoView({block:'nearest',behavior:'smooth'});toast('左右可能不一致：改选另一侧，或再次提交按当前选择发送。');return;}const ticket=viewState.beginMutation();if(!ticket)return;state.submitting=true;state.submissionOwner=ticket;drawMetadata();
 try{const result=await createJob(request,{operationTicket:ticket});if(!viewState.isUnchanged(ticket,result.assetId))return;
  if(result.feedbackPoints?.length){const submitted=new Set(result.feedbackPoints.map(p=>p.id));state.feedbackPoints=state.feedbackPoints.filter(p=>!submitted.has(p.id));}
  if(result.footRepair)setFootRepairDraft(null);
  $('request').value='';persistView();notice('');if(connect&&result.delivery!=='chat'&&(!state.agent?.connected||state.agent.provider!==result.provider))try{await connectAgent(result.provider||'codex');}catch(error){if(error.code!=='AGENT_BUSY'&&viewState.isCurrentMutation(ticket))notice('任务已保存，连接没有完成：'+error.message,true);}if(viewState.isCurrentMutation(ticket))toast('修改要求与当前画面已保存，原版保持。');}
 catch(error){if(viewState.isCurrentMutation(ticket)){persistView();fail(error);}}finally{if(state.submissionOwner===ticket){state.submissionOwner=null;state.submitting=false;drawMetadata();drawLatestJob();scheduleStudioSync();}}
}
$('requestForm').onsubmit=e=>{e.preventDefault();submitRequest();};$('saveQueued').onclick=()=>{$('executionMode').value='chat';drawAgent();submitRequest({connect:false});};$('executionMode').onchange=()=>{drawAgent();persistView();};

function canLocalEdit(){
 const model=activeModel();
 return state.initialized&&state.ready&&viewState.loadedAssetId&&model?.action&&model.capabilities.canLocalRotate&&!activeFootRepair()&&
  !state.motionPreview&&!state.archivedJobId&&!state.submitting&&!state.switching&&!state.loading&&!state.capturing;
}
function localPreviewCurrent(){
 return localPreview.model===activeModel()&&localPreview.target===state.target&&localPreview.source===activeModel().action?.getClip()&&
  $('localTools').open&&state.display==='single'&&state.panelMode==='compose'&&castBrowser?.mode()==='studio'&&canLocalEdit();
}
function localPreviewStatus(message){
 $('localPreviewStatus').textContent=message;$('localPreviewStatus').hidden=!message;
}
function clearLocalPreview(){
 if(!localPreview)return;
 const {model,clip}=localPreview;
 model.previewAction.stop();model.mixer.uncacheAction(clip);delete model.previewAction;model.poseStamp=null;
 localPreview=null;
 $('localPreview').textContent='试播调整';$('localPreview').setAttribute('aria-pressed','false');
 $('localPreviewBadge').hidden=true;localPreviewStatus('');
}
function localEditParameters(){
 const model=activeModel(),target=state.target;
 const node=target?.slot===activeSlot()&&target.assetSha256===model.meta.sha256?joint(model,target.bone,target.nodeIndex):null;
 if(!node){
  $('targetDialog').showModal();$('boneSelect').focus();localPreviewStatus('先选择一个带旋转轨道的部位。');
  return null;
 }
 const range=scope(),axis=$('localAxis').value,degrees=Number($('localAngle').value);
 const options=$('localEditMode').value==='offset'?{offset:{axis,degrees}}:{factor:Number($('swingFactor').value)};
 const source=model.action.getClip(),bone=rawName(model,node),index=model.parser.associations.get(node)?.nodes;
 const json=model.parser.json,definition=json.animations?.[model.clips.indexOf(source)];
 const channels=definition?.channels.filter(c=>c.target?.node===index&&c.target.path==='rotation')||[];
 const sampler=channels.length===1?definition.samplers[channels[0].sampler]:null;
 const supportedAccessor=id=>{
  const a=json.accessors?.[id],v=json.bufferViews?.[a?.bufferView];
  return a?.componentType===5126&&!a.sparse&&(!v||(v.buffer??0)===0&&!json.buffers?.[0]?.uri&&!v.extensions?.EXT_meshopt_compression&&!v.extensions?.KHR_meshopt_compression);
 };
 const track=source.tracks.find(t=>t.name===(node.name||node.uuid)+'.quaternion');
 if(!Number.isInteger(index)||!track||!sampler||(sampler.interpolation||'LINEAR')!=='LINEAR'||!supportedAccessor(sampler.input)||!supportedAccessor(sampler.output))throw Error('此部位没有可直接微调的旋转轨道。可选择其他部位，或交给 Agent。');
 return {model,target,source,track,bone,range,options};
}
function localEditTrack({track,range,options}){
 if(track.times.length>200000)throw Error('本地微调最多处理 20 万个关键帧。');
 const values=Array.from({length:track.times.length},(_,i)=>Array.from(track.values.subarray(i*4,i*4+4)));
 return editRotationTrack(track.times,values,{...options,...(range.wholeClip?{}:{start:range.start,end:range.end})});
}
function refreshLocalPreview(start=false){
 const starting=start===true;
 if(!starting&&!localPreview)return;
 clearLocalPreview();
 if(!canLocalEdit()||state.display!=='single')return render();
 try{
  const params=localEditParameters();if(!params)return render();
  const {model,target,source,track,range,options}=params;
  let replacement=track;
  if(options.offset?options.offset.degrees!==0:options.factor!==1){
   const {times,output}=localEditTrack(params);
   replacement=new T.QuaternionKeyframeTrack(track.name,times,output.flat());
  }
  const clip=new T.AnimationClip(source.name,source.duration,source.tracks.map(t=>t===track?replacement:t));
  model.action.stop();model.previewAction=model.mixer.clipAction(clip);model.previewAction.setLoop(T.LoopOnce,1);model.previewAction.clampWhenFinished=true;
  localPreview={model,target,source,clip};
  $('localPreview').textContent='结束试播';$('localPreview').setAttribute('aria-pressed','true');$('localPreviewBadge').hidden=false;
  localPreviewStatus('试播中，可以播放或拖动时间轴。生成候选后再比较。');
  if(starting){const time=localTime(activeSlot());seek(!range.wholeClip&&(time<=range.start||time>=range.end)?(range.start+range.end)/2:time);}
  else render();
 }catch(error){localPreviewStatus(error.message);render();}
}
function drawLocalEditOptions(){
 const offset=$('localEditMode').value==='offset',angle=Number($('localAngle').value);
 $('localOffsetFields').hidden=!offset;$('localSwingFields').hidden=offset;
 $('factorLabel').textContent=Math.round(Number($('swingFactor').value)*100)+'%';
 $('localAngleLabel').textContent=(angle>0?'+':'')+angle+'°';
 refreshLocalPreview();
}
$('localPreview').onclick=()=>{
 if(localPreview){clearLocalPreview();render();return;}
 if(state.display!=='single'){localPreviewStatus('切到单个版本后即可试播微调。');return;}
 refreshLocalPreview(true);
};
$('localTools').addEventListener('toggle',()=>{if(!$('localTools').open&&localPreview){clearLocalPreview();render();}});
for(const id of ['localEditMode','localAxis','localAngle','swingFactor'])$(id).addEventListener('input',drawLocalEditOptions);

async function runLocalEdit(){
 if(!canLocalEdit()||activeTask()||staleWorkspaceView())return;
 let params;
 try{params=localEditParameters();if(!params)return;localEditTrack(params);}catch(error){localPreviewStatus(error.message);return;}
 const {bone,range,options}=params;
 let ticket=viewState.beginMutation();if(!ticket)return;const owner=ticket,assetId=viewState.loadedAssetId;let job,result;
 const current=()=>viewState.isCurrentMutation(ticket,assetId)&&viewState.loadedAssetId===assetId&&state.project?.activeAssetId===assetId&&!state.switching;
 state.submitting=true;state.submissionOwner=owner;drawMetadata();$('localEdit').disabled=true;$('localEdit').textContent='正在生成数值候选…';
 try{
  const change=options.offset?'绕自身 '+options.offset.axis.toUpperCase()+' 轴旋转 '+options.offset.degrees+'°':'摆幅调整为原来的 '+Math.round(options.factor*100)+'%';
  job=await createJob('本地数值微调：'+bone+' '+change+'。',{local:true,operationTicket:ticket});
  if(!current()||!viewState.isUnchanged(ticket,job.assetId))return;
  result=await api('/api/jobs/'+job.id+'/local-edit','POST',{bone,...options,...(range.wholeClip?{}:{start:range.start,end:range.end})});
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
$('agentConnect').onclick=async()=>{if($('executionMode').value==='chat')return;const connected=Boolean(state.agent?.connected);$('agentConnect').disabled=true;try{const result=await api(connected?'/api/agent/disconnect':'/api/agent/connect','POST',connected?{}:{provider:$('executorProvider').value});await pollStudio();if(result.error)throw Error(errorString(result.error));toast(connected?'已断开本机 Agent。':'连接请求已提交，等待状态确认。');}catch(e){fail(e);}finally{drawAgent();}};
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
  if(!await refreshModels({preserve:false,selectionTicket:ticket,needCandidate:slot==='candidate'})||!viewState.isCurrent(ticket,imported.assetId))return;
  state.focus=slot;state.display='single';state.panelMode='compose';state.explicitCompose=true;state.composerSource=slot;state.lineageParentJobId=null;state.selectedJob=null;state.archivedJobId=null;
 if(slot==='baseline'){$('request').value='';$('preserve').value='';$('lockOtherClips').checked=false;state.feedbackPoints=[];setFootRepairDraft(null);}
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
$('sidebarImport').onclick=()=>$('openAssets').click();
$('quickFit').onclick=()=>$('fitView').click();$('quickSnapshot').onclick=()=>$('snapshotButton').click();
$('openLibrary').onclick=()=>{setLibraryTab(false);$('libraryDialog').showModal();};$('mobileHistory').onclick=$('menuHistory').onclick=$('openHistory').onclick=()=>{setLibraryTab(true);$('libraryDialog').showModal();};$('motionSelect').onchange=e=>selectMotion(e.target.value);
$('importDone').onclick=()=>{$('importDialog').close();$('stage').scrollIntoView({block:'center',behavior:'smooth'});};$('importMine').onclick=()=>$('importDialog').showModal();$('openSettings').onclick=()=>$('settingsDialog').showModal();$('projectButton').onclick=()=>openProjectDialog();$('linkProjectInline').onclick=()=>openProjectDialog();$('projectContextDetails').addEventListener('click',e=>{if(e.target===$('projectContextSummary')&&state.projectLink?.status!=='linked'){e.preventDefault();openProjectDialog();}});$('projectContextDetails').addEventListener('toggle',()=>{if($('projectContextDetails').open)scheduleProjectPreview();});$('request').addEventListener('input',()=>scheduleProjectPreview());
$('useSuggestedProject').onclick=()=>openLinkedProject(state.projectLink?.suggested?.root);$('projectPathForm').onsubmit=e=>{e.preventDefault();openLinkedProject($('projectPath').value);};$('confirmProjectFolder').onclick=()=>openLinkedProject(selectedProjectFolder);$('pickProjectFolder').onclick=async()=>{if(projectBusy)return;projectBusy=true;$('pickProjectFolder').disabled=true;projectStatus('请选择项目文件夹…');try{const result=await api('/api/project/select-folder','POST',{});if(result.cancelled){projectStatus('已取消选择，当前工作区保持。');return;}if(!result.path)throw Error('没有收到文件夹路径。');selectedProjectFolder=result.path;$('projectPath').value=result.path;$('projectSelectedPath').textContent=result.path;$('projectSelection').hidden=false;projectStatus('');}catch(error){projectStatus(error.message+'。也可以粘贴文件夹路径。',true);$('projectPathFallback').open=true;}finally{projectBusy=false;$('pickProjectFolder').disabled=false;}};
$('showAllBones').onchange=updateBoneChoices;$('openTarget').onclick=()=>$('targetDialog').showModal();$('localTarget').onclick=()=>$('targetDialog').showModal();
for(const id of ['openScope','scopeChip','localScope'])$(id).onclick=()=>$('scopeDialog').showModal();$('applyScope').onclick=()=>{try{scope();updateScopeVisual();$('scopeDialog').close();}catch(e){fail(e);}};
$('mobileTaskAction').onclick=()=>{castBrowser?.setMode('studio');$('taskPanel').scrollIntoView({block:'start',behavior:'smooth'});if(state.panelMode==='compose')setTimeout(()=>$('request').focus({preventScroll:true}),250);};
async function showVersion(display,focus=state.focus){
 if(state.loading||state.switching||state.submitting||state.capturing||state.motionPreview)return;
 if((display!=='single'||focus==='candidate')&&(!state.models.candidate||
  !state.archivedJobId&&state.models.candidate.meta.sha256!==state.project?.slots.candidate?.sha256)){
  if(!state.project?.slots.candidate)return toast('请先载入候选素材。');
  if(!await refreshModels({needCandidate:true}))return;
 }
 state.display=display;state.focus=focus;state.time=Math.min(state.time,duration());
 clearTarget();drawLibrary();updateBoneChoices();drawMetadata();updateDisplay();drawJobs();
}
document.querySelectorAll('[data-version]').forEach(button=>button.onclick=()=>showVersion(button.dataset.version==='compare'?'split':'single',button.dataset.version==='baseline'?'baseline':'candidate').catch(fail));

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
async function returnCurrentVersion(){
 const job=workspaceCandidate();
 if(job&&!candidateViewed(job))return openSyncedJob(job);
 if(!await refreshModels({preserve:true}))return;
 state.archivedJobId=null;state.selectedJob=job?.id??null;
 drawMetadata();drawJobs();notice('已返回当前素材，历史版本保持归档。');
 persistView();
}
$('returnCurrent').onclick=()=>returnCurrentVersion().catch(fail);
$('focusSlot').onchange=()=>showVersion('single',$('focusSlot').value).catch(fail);
document.querySelectorAll('[data-display]').forEach(button=>button.onclick=()=>showVersion(button.dataset.display).catch(fail));document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>view(b.dataset.view));$('fitView').onclick=()=>view(state.view==='orbit'?'front':state.view);$('search').oninput=drawLibrary;
function setLibraryTab(history){if(history)loadJobHistory().catch(fail);$('search').closest('label').hidden=history;$('clipList').hidden=history;$('historyList').hidden=!history;$('historyMore').hidden=!history||!state.historyHasMore;$('clipsTab').classList.toggle('active',!history);$('historyTab').classList.toggle('active',history);}$('historyMore').onclick=()=>loadJobHistory({more:true}).catch(fail);$('clipsTab').onclick=()=>setLibraryTab(false);$('historyTab').onclick=()=>setLibraryTab(true);
function rangeAroundCurrent(){const d=activeModel()?.duration||0,t=localTime(activeSlot());$('scopeStart').value=String(Math.max(0,t-.15));$('scopeEnd').value=String(Math.min(d,t+.15));updateScopeVisual();}
$('scopeMode').onchange=()=>{const range=$('scopeMode').value==='range';$('scopeInputs').hidden=!range;$('scopeStart').disabled=!range;$('scopeEnd').disabled=!range;if(range)rangeAroundCurrent();updateScopeVisual();};$('scopeStart').oninput=updateScopeVisual;$('scopeEnd').oninput=updateScopeVisual;$('scopeDialog').addEventListener('close',refreshLocalPreview);$('useCurrentTime').onclick=rangeAroundCurrent;
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{$('request').value=b.dataset.prompt;$('request').focus();updateSideWarning();scheduleProjectPreview();});$('request').addEventListener('input',updateSideWarning);$('retryLoad').onclick=()=>refreshModels({force:true}).catch(e=>fail(e,true));
installShortcuts({undo:()=>undoControls.run('undo'),redo:()=>undoControls.run('redo'),mode:()=>castBrowser.mode(),search:mode=>{if(mode==='library')$('abSearch').focus();else{setLibraryTab(false);$('libraryDialog').showModal();$('search').focus();}},play:()=>runtimeStage.active?runtimeStage.toggle():$('play').click(),step:n=>runtimeStage.active?runtimeStage.step(n):seek(state.time+n/state.fps),clear:()=>{if(runtimeStage.active)runtimeStage.stop();else if(document.body.classList.contains('preview-focused'))setPreviewFocus(false);else if(state.motionPreview)void endMotionTrial();else clearTarget();}});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();state.playing=false;fail(Error('三维画面暂时中断。反馈已经保留，请刷新页面恢复。'),true);});
new ResizeObserver(size).observe($('stage'));
function continuousFrames(){return !runtimeStage.active&&!runtimePreviewDialog.open&&Boolean(appearanceRecovery||state.ready&&!state.loading&&!state.capturing&&(state.playing&&duration()||Object.values(state.models).some(m=>m.appearance&&(m.appearance.update||m.appearance.render))));}
let lastDOM=0;
renderLoop=createDemandLoop({requestFrame:requestAnimationFrame,cancelFrame:cancelAnimationFrame,shouldContinue:continuousFrames,onFrame(now,dt){
 if(runtimeStage.active||runtimePreviewDialog.open)return;
 if(appearanceRecovery&&!state.loading&&!state.switching&&!state.capturing&&!state.submitting){appearanceRecovery=false;if(Object.values(state.models).some(m=>m.appearance)){void refreshModels({force:true}).catch(fail);return;}}
 if(!state.ready||state.loading||state.capturing)return;
 const wasPlaying=state.playing;
 if(state.playing&&duration()){state.time+=dt*state.speed;if(state.time>duration()){if(state.loop)state.time%=duration();else{state.time=duration();state.playing=false;}}}
 render();if(state.playing&&now-lastDOM>60||wasPlaying&&!state.playing){updateClock();lastDOM=now;}
}});

async function loadCase(){try{const r=await fetch('/case/case.json');if(!r.ok)return;const c=await r.json();for(const section of c.sections||[]){$('caseContent').append(el('h3',section.title));for(const p of section.paragraphs||[])$('caseContent').append(el('p',p));if(section.quote)$('caseContent').append(el('blockquote',section.quote));for(const item of section.images||[]){const img=el('img');img.src='/case/'+item.file;img.alt=item.caption;$('caseContent').append(img,el('p',item.caption));}}const link=el('a','查看证据与来源记录');link.href='/case/evidence.json';link.target='_blank';$('caseContent').append(link);}catch{}}
const workspaceDrafts=createDraftSync({
 load:id=>api('/api/drafts/'+encodeURIComponent(id)),
 save:(id,data)=>api('/api/drafts/'+encodeURIComponent(id),'POST',data),
 onStatus(id,status){if(id!==viewState.loadedAssetId)return;const copy={saved:'草稿已保存在工作区',saving:'正在保存草稿…',offline:'暂未同步到工作区；本页草稿仍保留',conflict:'其他窗口更新了草稿，请选择保留哪份。'};$('draftStatus').textContent=copy[status];$('draftConflict').hidden=status!=='conflict';}
});
$('draftUseRemote').onclick=async()=>{const id=viewState.loadedAssetId;await workspaceDrafts.resolve(id,'remote');if(id===viewState.loadedAssetId)await restoreModelDraft();};
$('draftKeepLocal').onclick=()=>workspaceDrafts.resolve(viewState.loadedAssetId,'local');
let persistTimer,draftInputTimer;
function persistView(){
 if(state.motionPreview)return false;
 const id=viewState.persistableAssetId(state);if(!id)return false;
 const draft={assetId:id,context:context(),pausedTime:state.playing?null:state.time,request:$('request').value,preserve:$('preserve').value,feedbackPoints:state.feedbackPoints,footRepair:state.footRepair,lockOtherClips:$('lockOtherClips').checked,executionMode:$('executionMode').value,provider:$('executorProvider').value||state.savedProvider||null,callerKey:callerKey(state.caller),selectedJob:state.selectedJob,panelMode:state.panelMode,comparisonPair:state.comparisonPair,composerSource:state.composerSource,lineageParentJobId:state.lineageParentJobId,composerIntent:state.panelMode==='compose'&&Boolean(state.composerSource||$('request').value.trim()||state.feedbackPoints.length||state.footRepair)};
 const stored=saveViewDraft(()=>localStorage,viewState,state,()=>draft);workspaceDrafts.persist(id,draft);return stored;
}
for(const id of ['request','preserve','lockOtherClips','executionMode'])$(id).addEventListener('input',()=>{clearTimeout(draftInputTimer);draftInputTimer=setTimeout(persistView,350);});
window.addEventListener('beforeunload',persistView);document.addEventListener('visibilitychange',()=>{if(document.hidden)persistView();});persistTimer=setInterval(persistView,5000);
try{await refreshModels();await restoreModelDraft();await pollStudio();state.initialized=true;$('taskRestoring').hidden=true;$('taskFooter').hidden=false;drawMetadata();drawLatestJob();updateDisplay();}catch(e){state.initialized=true;$('taskRestoring').hidden=true;$('taskFooter').hidden=false;drawLatestJob();fail(e,true);}scanExecutors();undoControls.refresh();setInterval(()=>{undoControls.refresh();if(!document.hidden&&currentPlans().length)void refreshReplacementPlans();},3000);castBrowser.loadCast();loadProjectIdentity().catch(error=>{$('projectButton').title='项目状态暂未同步：'+error.message;});loadCase();refreshCatalog().catch(e=>catalogMessage(e.message,true));const studioStream=typeof EventSource==='function'?new EventSource('/api/studio/events'):null;studioStream?.addEventListener('studio',scheduleStudioSync);window.addEventListener('focus',scheduleStudioSync);document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleStudioSync();});setInterval(()=>{if(studioStream?.readyState!==1||!document.hidden)pollStudio();if(state.catalog?.scan?.state==='scanning'||$('modelCatalogDialog').open)refreshCatalog().catch(e=>catalogMessage(e.message,true));},1800);setInterval(updateTaskClock,1000);
window.motionReview={state,castBrowser,thumbnailStudio,openCatalogModel,refreshCatalog,seek,view,refresh:refreshModels,render,context,cameras,controls,showCandidate,pollStudio,clearTarget,selectMotion};
