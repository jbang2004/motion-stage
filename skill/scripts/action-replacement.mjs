import {assertModelAvailable} from './jobs.mjs';
import {randomUUID} from 'node:crypto';
import {ROOT,sha,readProject,modelSlots,readWorkspaceJSON,withWorkspaceLock,commitWorkspace} from './core.mjs';
import {characterActionCurves,previewCharacterAction} from './character-actions.mjs';
import {previewMotion,readMotionLibrary} from './motion-library.mjs';
import {getProjectLink} from './project-context.mjs';
import {projectFiles} from './game-integration.mjs';
import {appendUndo,undoGuard} from './undo.mjs';

export const PLAN_FILE='action-replacement-plans.json';
const check=(condition,message)=>{if(!condition)throw Error(message);};
const digest=value=>sha(Buffer.from(JSON.stringify(value)));
export async function readReplacementPlans(work){
 try{
  const manifest=await readWorkspaceJSON(work,PLAN_FILE);
  check(manifest.version===1&&manifest.characters&&typeof manifest.characters==='object','动作替换方案格式不兼容');
  return manifest;
 }
 catch(error){if(error.code==='ENOENT')return {version:1,characters:{}};throw error;}
}
async function resolveReplacement(work,input){
 const {assetId,slot,expectedModelSha,expectedCandidateSha,clip,source}=input;
 const project=await readProject(work),heads=modelSlots(project,assetId),asset=heads[slot];
 check(['baseline','candidate'].includes(slot)&&asset&&asset.sha256===expectedModelSha&&
  (expectedCandidateSha===undefined||(heads.candidate?.sha256??null)===expectedCandidateSha),'角色版本已变化，请重新选择动作');
 const target=asset.clips.find(action=>action.name===clip);
 check(target&&asset.kind!=='curves','当前版本中找不到可替换的动作');
 let action,request;
 if(source?.kind==='plan'){
  const plan=(await readReplacementPlans(work)).characters[assetId]?.find(row=>row.id===source.id&&row.clip===clip);
  check(plan&&plan.modelSha===asset.sha256,'方案基于旧素材，请重新选择来源');
  if(plan.source.kind==='own')action=asset.clips.find(row=>row.name===plan.source.clip);
  else{
   const result=await previewMotion(work,{...plan.source.request,slot});
   action={...result.clips[0],duration:plan.source.duration,sourceName:plan.source.sourceName};
  }
 }else if(source?.kind==='own'){
  action=asset.clips.find(row=>row.name===source.name&&row.name!==clip);
  check(action,'请选择另一段角色自带动作');
 }else if(source?.kind==='matched'){
  const result=await characterActionCurves(work,{assetId,slot,expectedModelSha,actionIds:[source.id]});
  action=result.clips[source.id];
  check(action?.tracks?.length,action?.error||'匹配动作已变化，请重新选择');
 }else if(source?.kind==='saved'){
  const library=await readMotionLibrary(work),saved=library.characters[assetId]?.find(row=>row.id===source.id);
  check(saved,'常用动作已变化，请重新选择');
  const {packId,versionId,clip:sourceClip,mappingId,modelSha}=saved.recipe;
  request={assetId,slot,expectedModelSha,packId,versionId,clip:sourceClip,
   ...(mappingId&&modelSha===expectedModelSha?{mappingId}:{})};
  const result=await previewMotion(work,request);
  action={...result.clips[0],sourceName:saved.name,duration:Math.max(0,...result.clips[0].tracks.map(track=>track.times.at(-1)||0))};
 }else throw Error('请选择替换动作');
 check(action,'动作来源已变化，请重新选择');
 const previewId=digest({assetId,slot,expectedModelSha,expectedCandidateSha,clip,source,action});
 return {project,heads,asset,target,action,request,previewId};
}

export function previewReplacement(work,input){
 return withWorkspaceLock(work,async()=>{
  const {action,target,previewId}=await resolveReplacement(work,input);
  return {action,target,previewId};
 });
}

export function listReplacementPlans(work,assetId){
 return withWorkspaceLock(work,async()=>{
  const plans=await readReplacementPlans(work);
  return {plans:Object.hasOwn(plans.characters,assetId)?plans.characters[assetId]:[]};
 });
}

async function commitPlans(work,manifest,assetId,before,after,label){
 await assertModelAvailable(work,assetId);
 const beforeGuard=await undoGuard(work,assetId);
 manifest.characters[assetId]=after;
 const changes={[PLAN_FILE]:manifest};
 await appendUndo(work,changes,{assetId,beforeGuard,kind:'replacement-plan',label,before,after});
 await commitWorkspace(work,changes);
}

export function withdrawReplacementPlan(work,{assetId,id}){
 return withWorkspaceLock(work,async()=>{
  const manifest=await readReplacementPlans(work);
  const before=Object.hasOwn(manifest.characters,assetId)?manifest.characters[assetId]:[];
  const plan=before.find(row=>row.id===id);
  check(plan&&!plan.integration,'方案已变化或已接入，请刷新后重试');
  const plans=before.filter(row=>row!==plan);
  await commitPlans(work,manifest,assetId,before,plans,'撤回替换方案 '+plan.clip);
  return {plans};
 });
}

export function replaceAction(work,input){
 return withWorkspaceLock(work,async()=>{
  const {assetId,slot,clip,source}=input;
  const {project,asset,target,action,request,previewId}=await resolveReplacement(work,input);
  check(input.previewId===previewId&&source.kind!=='plan','替换预览已变化，请重新试播');
  const manifest=await readReplacementPlans(work),before=manifest.characters[assetId]||[];
  const previous=before.find(row=>row.clip===clip);
  check((previous?.id??null)===(input.expectedPlanId??null),'这条替换方案已更新，请刷新后重试');
  let binding={kind:'own',clip:action.name,duration:action.duration,file:asset.file,sha256:asset.sha256};
  if(source.kind!=='own'){
   const pinned=request?{request,result:await previewMotion(work,request)}:await previewCharacterAction(work,{
    assetId,slot,expectedModelSha:asset.sha256,actionId:source.id
   });
   const normalize=tracks=>tracks.map(({values,...track})=>({...track,values:values.map(Math.fround)}));
   check(digest(normalize(action.tracks))===digest(normalize(pinned.result.clips[0].tracks)),'动作来源在保存期间变化，请重新试播');
   const recipe=pinned.result.recipe;
   binding={kind:'pack',clip:recipe.clip,duration:action.duration,file:recipe.motionFile,sha256:recipe.versionId,sourceName:action.sourceName||recipe.packName,request:pinned.request};
  }
  const origin=asset.source?.assembly?.clips?.[clip],link=await getProjectLink(work);
  const plan={id:randomUUID(),assetId,slot,modelSha:asset.sha256,modelFile:asset.file,character:project.models[assetId].name,
   clip,duration:target.duration,source:binding,projectId:link?.id??null,
   game:{profileId:asset.source?.assembly?.profileId??null,modelFile:asset.source?.projectRelativePath??null,
    ownerFile:origin?.file??asset.source?.projectRelativePath??null,clip:origin?.sourceClip??clip},
   createdAt:new Date().toISOString()};
  const after=[...before.filter(row=>row.clip!==clip),plan];
  await commitPlans(work,manifest,assetId,before,after,'保存替换方案 '+clip);
  return {plan,plans:after};
 });
}

async function pendingPlans(work,ids,{requireCurrent=true}={}){
 check(Array.isArray(ids)&&ids.length>0&&ids.length<=50&&ids.every(id=>typeof id==='string')&&new Set(ids).size===ids.length,'请选择 1 至 50 条待接入方案');
 const manifest=await readReplacementPlans(work),link=await getProjectLink(work),project=await readProject(work);
 check(link?.exists,'请先关联游戏项目');
 const all=Object.values(manifest.characters).flat();
 const plans=ids.map(id=>all.find(row=>row.id===id));
 for(const plan of plans){
  check(plan&&!plan.integration&&plan.projectId===link.id,'方案已变化或已接入，请重新选择');
  if(requireCurrent)check(Object.values(modelSlots(project,plan.assetId)).some(asset=>asset?.sha256===plan.modelSha),'方案基于旧素材，请重新确认');
 }
 return {manifest,link,plans};
}

export function replacementHandoff(work,ids){
 return withWorkspaceLock(work,async()=>{
  const {link,plans}=await pendingPlans(work,ids);
  const task={kind:'action-replacement-integration',workspace:work,project:link.root,plans};
  const prompt=[
   '请把下面选中的动作替换方案接入游戏。方案只记录预览选择，游戏文件尚未由动作台修改。',
   JSON.stringify(task,null,2),
   '核对游戏实际注册的角色、动作和制作源。保留目标动作的游戏引用，检查时长、循环、根位移、事件和过渡。组合角色按实际动作所有者接入，验证游戏后再记录结果。',
   '每条已验证的方案用以下命令记录。--file 可重复，--plan 可重复以记录同一批一起验证的方案。',
   'node '+JSON.stringify(ROOT+'/scripts/motion-feedback.mjs')+' replacement-integrated --workspace '+JSON.stringify(work)+' --plan PLAN_ID --file GAME_FILE --summary "实际改动" --game-check "实际游戏验证"',
  ].join('\n\n');
  return {task,prompt};
 });
}

export function recordReplacementIntegration(work,{ids,files,summary,gameCheck}){
 return withWorkspaceLock(work,async()=>{
  const {manifest,link,plans}=await pendingPlans(work,ids,{requireCurrent:false});
  check([summary,gameCheck].every(value=>typeof value==='string'&&value.trim()&&value.length<=4000),'请填写实际接入改动与游戏验证结果');
  const changed=await projectFiles(link,files);
  const integration={at:new Date().toISOString(),summary:summary.trim(),gameCheck:gameCheck.trim(),files:changed};
  for(const plan of plans)plan.integration=integration;
  await commitWorkspace(work,{[PLAN_FILE]:manifest});
  return {ids,integration};
 });
}
