import {sampledMetadata} from './curve-resources.mjs';
import {readFile,stat} from 'node:fs/promises';
import {basename,extname} from 'node:path';
import {readProject,modelSlots,setModelSlots,inside,atomic,sha,withWorkspaceLock,importAsset,activateModel,glbInfo,stageAsset} from './core.mjs';
import {sortSourceUpdate,applySourceUpdate,storedJobs} from './source-sync.mjs';
import {clipChanges} from './candidate-diff.mjs';
import {readCatalog,catalogPage,glbMetadata,gltfMetadata,gltfDependencyState,readProjectModel,openCatalogAsset} from './asset-catalog.mjs';
import {getProjectLink} from './project-context.mjs';
import {characterProfileDigest,characterBindingDigest,consumedDependencies} from './source-dependencies.mjs';
import {assembleCharacter} from './motion-assembly.mjs';
import {validateCandidate} from './candidate-validation.mjs';

// Header metadata per file identity. Sized for large projects: a cache smaller
// than the candidate count evicts every entry before its next use.
const MAP='character-map.json',cache=new Map(),flights=new Map(),CACHE_LIMIT=4096,LIBRARY_CONCURRENCY=16;
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const stamp=s=>[s.size,s.mtimeMs,s.ctimeMs,s.ino,s.dev].join(':');
const assetId=(project,id)=>'character-'+sha(Buffer.from(project+'\0'+id)).slice(0,32);
const mainSourceFingerprint=(model,source)=>characterProfileDigest({model,sha256:source.sha256,dependencies:consumedDependencies(source).map(d=>[d.projectRelativePath,d.sha256]).sort((a,b)=>a[0].localeCompare(b[0]))});
const modelFormat=file=>({'.glb':'glb','.gltf':'gltf'})[extname(file).toLowerCase()]||'unsupported';
function path(value){requireValue(typeof value==='string'&&value.length>0&&value.length<=2000,'需要项目内相对文件路径');const p=value.replaceAll('\\','/');requireValue(!p.startsWith('/')&&!/^[a-z]:/i.test(p)&&!p.split('/').some(n=>n==='..'||n==='.git'||n==='.ssh'||n==='.aws'),'资源路径必须位于项目内');return p;}
export function normalizeCharacterMap(value){
 requireValue(value?.version===1&&Array.isArray(value.characters)&&value.characters.length<=500,'角色映射需要 version:1 和 characters 数组（最多 500 个角色）');
 const ids=new Set(),models=new Set();
 return {version:1,characters:value.characters.map(c=>{
  requireValue(c&&typeof c.id==='string'&&c.id.length>0&&c.id.length<=200&&!ids.has(c.id),'角色 ID 缺失、过长或重复');ids.add(c.id);
  const model=path(c.model);requireValue(!models.has(model),'同一主模型不能声明两个角色；请为独立角色提供独立主模型');models.add(model);
  requireValue(['.glb','.gltf','.fbx'].includes(extname(model).toLowerCase()),'角色主模型需要 GLB、glTF 或 FBX');
  requireValue(!c.name||typeof c.name==='string'&&c.name.length<=200,'角色名称无效');
  requireValue(!c.animations||Array.isArray(c.animations)&&c.animations.length<=50,'一个角色最多关联 50 个动作来源');
  const animations=(c.animations||[]).map(a=>{
   const file=path(a.file),format=a.format||modelFormat(file);
   requireValue(['glb','gltf','sampled-tracks-v1','unsupported'].includes(format),'未知动作解析格式');
   requireValue(!a.clips||Array.isArray(a.clips)&&a.clips.length<=1000&&a.clips.every(n=>typeof n==='string'&&n.length<=200),'动作选择列表无效');
   requireValue(!a.prefix||typeof a.prefix==='string'&&a.prefix.length<=100,'动作前缀无效');
   requireValue(a.replace===undefined||typeof a.replace==='boolean','覆盖规则需要布尔值');
   requireValue(!a.nodeMap||typeof a.nodeMap==='object'&&!Array.isArray(a.nodeMap)&&Object.keys(a.nodeMap).length<=2000&&Object.values(a.nodeMap).every(n=>typeof n==='string'),'节点映射无效');
   return {file,format,...(a.clips?{clips:a.clips}:{}),...(a.prefix?{prefix:a.prefix}:{}),...(a.replace?{replace:true}:{}),...(a.nodeMap?{nodeMap:a.nodeMap}:{})};
  });
  requireValue(!c.variants||Array.isArray(c.variants)&&c.variants.length<=50,'模型版本列表无效');
  requireValue(!c.evidence||Array.isArray(c.evidence)&&c.evidence.length<=20,'来源依据列表无效');
  return {id:c.id,name:c.name||basename(model,extname(model)),model,variants:(c.variants||[]).map(path),animations,evidence:(c.evidence||[]).map(e=>({file:path(e.file),...(e.sha256?{sha256:e.sha256}:{})}))};
 })};
}
async function mapping(work){
 try{const file=await inside(work,MAP);requireValue((await stat(file)).size<=1024*1024,'角色映射超过 1 MiB');return normalizeCharacterMap(JSON.parse(await readFile(file,'utf8')));}
 catch(error){if(error.code==='ENOENT')return {version:1,characters:[]};throw error;}
}
export async function saveCharacterMap(work,value,{expectedDigest}={}){
 const normalized=normalizeCharacterMap(value),link=await getProjectLink(work);requireValue(link?.exists,'请先关联项目');
 for(const c of normalized.characters){
  await inside(link.root,c.model);
  for(const a of c.animations)await inside(link.root,a.file);
  for(const file of c.variants)await inside(link.root,file);
  for(const e of c.evidence){const b=await stableRead(link.root,e.file,2*1024*1024);if(e.sha256)requireValue(e.sha256===b.sha256,'项目依据文件已变化：'+e.file);e.sha256=b.sha256;}
 }
 requireValue(Buffer.byteLength(JSON.stringify(normalized))<=1024*1024,'角色映射超过 1 MiB');
 await withWorkspaceLock(work,async()=>{if(expectedDigest)requireValue(characterProfileDigest(await mapping(work))===expectedDigest,'角色映射已被其他操作修改，请刷新后重试');requireValue((await getProjectLink(work))?.id===link.id,'项目关联已变化');await atomic(await inside(work,MAP),normalized);});return {characters:normalized.characters.length,file:MAP};
}
async function stableRead(root,file,max=200*1024*1024){
 const full=await inside(root,file),before=await stat(full);requireValue(before.isFile()&&before.size<=max,'资源不是普通文件或超过读取预算：'+file);
 const bytes=await readFile(full),after=await stat(full);requireValue(stamp(before)===stamp(after)&&bytes.length===before.size,'读取期间资源发生变化：'+file);
 return {bytes,sha256:sha(bytes),stamp:stamp(after)};
}
// `known` is the catalog row for this file: when its fingerprint still matches,
// the scan's header metadata is reused instead of reading the file again.
async function fileInfo(root,file,format,known){
 let full,s;
 try{full=await inside(root,file);s=await stat(full);requireValue(s.isFile(),'不是普通文件');}catch(error){return {file,format,status:'missing',count:0,error:'文件缺失或不可读：'+file,stamp:'missing'};}
 const result=await parsedInfo(root,file,format,full,s,known);if(!result.dependencies)return result;
 // A .gltf is only as current as the .bin and images it references.
 const deps=await gltfDependencyState(root,result.dependencies);
 const modelStamp=result.stamp+'|'+deps.stamp;
 // Portraits re-render when a referenced .bin or texture changes, not only the JSON.
 return {...result,stamp:modelStamp,identity:result.identity+':'+sha(Buffer.from(modelStamp)).slice(0,16),...(deps.missing.length&&result.status==='declared'?{status:'unavailable',error:'缺少 glTF 引用的文件：'+deps.missing.slice(0,3).join('、')}:{})};
}
async function parsedInfo(root,file,format,full,s,known){
 const key=full+'|'+stamp(s)+'|'+format;
 if(cache.has(key)){const hit=cache.get(key);cache.delete(key);cache.set(key,hit);return hit;}
 let result={file,format,status:'declared',count:0,stamp:stamp(s),identity:[s.size,Math.round(s.mtimeMs)].join(':')};
 try{
  if(format==='glb'){const info=known?.fingerprint===stamp(s)&&known.metadata?.capabilities?.version===1&&Array.isArray(known.metadata.clips)?known.metadata:await glbMetadata(full);result={...result,info,count:info.clips.length};}
  else if(format==='gltf'){const {info,dependencies}=await gltfMetadata(root,file);result={...result,info,dependencies,count:info.clips.length};}
  else if(format==='sampled-tracks-v1'){
   const {bytes}=await stableRead(root,file,50*1024*1024),data=JSON.parse(bytes.toString('utf8'));
   result.info=sampledMetadata(data);result.count=result.info.clips.length;
  }else result={...result,status:'unsupported',error:'需要转换或项目导出器后才能绑定'};
 }catch(error){result={...result,status:'unavailable',error:error.message};}
 cache.set(key,result);while(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value);return result;
}
async function library(work,{onlyId=null,includeCandidates=true}={}){
 const [link,catalog,cfg,map]=await Promise.all([getProjectLink(work),readCatalog(work),readProject(work),mapping(work).catch(error=>({version:1,characters:[],error:error.message}))]);
 const profiles=[],covered=new Set(),mapped=map.characters;
 for(const c of mapped){covered.add(c.model);c.variants.forEach(f=>covered.add(f));c.animations.forEach(a=>covered.add(a.file));profiles.push({...c,mapped:true});}
 if(includeCandidates&&link?.exists&&catalog.projectId===link.id)for(const e of catalog.entries){
  if(covered.has(e.relativePath)||e.status!=='available'||!['glb','gltf'].includes(e.format))continue;
  if(e.metadata?.meshCount&&(e.metadata.skinCount||e.metadata.clips?.length))profiles.push({id:'file:'+e.relativePath,name:basename(e.name,extname(e.name)),model:e.relativePath,variants:[],animations:[],evidence:[],mapped:false});
 }
 const rows=[],selected=link?.exists?profiles.filter(profile=>!onlyId||assetId(link.id,profile.id)===onlyId):[],models=[];
 // Stat (and, on a miss, read headers of) many files at once; rows keep profile order.
 const scanned=catalog.projectId===link?.id?new Map(catalog.entries.map(e=>[e.relativePath,e])):new Map();
 for(let i=0;i<selected.length;i+=LIBRARY_CONCURRENCY)models.push(...await Promise.all(selected.slice(i,i+LIBRARY_CONCURRENCY).map(profile=>fileInfo(link.root,profile.model,modelFormat(profile.model),scanned.get(profile.model)))));
 for(const [index,profile]of selected.entries()){
  const id=assetId(link.id,profile.id),model=models[index];
  const sources=await Promise.all(profile.animations.map(a=>fileInfo(link.root,a.file,a.format)));
  const evidence=[];
  for(const e of profile.evidence){try{const b=await stableRead(link.root,e.file,2*1024*1024);evidence.push([e.file,b.sha256===e.sha256?'current':'changed']);}catch{evidence.push([e.file,'missing']);}}
  const signature=characterProfileDigest({profile,model:model.stamp,sources:sources.map(s=>[s.file,s.stamp]),evidence});
  const heads=modelSlots(cfg,id),previous=heads.baseline?.source?.assembly,readyEvidence=evidence.every(([,status])=>status==='current');
  const current=previous?.signature===signature;
  const states=sources.map((s,i)=>({...s,...(current?previous.sources?.[i]:{}),...(readyEvidence?{}:{status:'needs-confirmation',error:'项目依据已变化，请重新识别后更新关联'})}));
  const info=current?{...model.info,clips:heads.baseline.clips}:model.info;
  rows.push({id,character:true,profileId:profile.id,name:profile.name,relativePath:profile.model,format:extname(profile.model).slice(1).toLowerCase(),origin:'project',status:model.status==='missing'?'missing':model.status==='unavailable'?'invalid':'available',confirmed:profile.mapped,opened:Boolean(heads.baseline),hasCandidate:Boolean(heads.candidate&&heads.baseline.sha256!==heads.candidate.sha256),sourceChanged:Boolean(previous&&previous.signature!==signature),metadata:info,motionSources:states.map(({stamp,info,identity,...s})=>s),variants:profile.variants,embeddedCount:model.info?.clips.length||0,externalCount:sources.reduce((sum,s)=>sum+s.count,0),error:model.status==='unavailable'?model.error:undefined,profile,signature,readyEvidence,portraitIdentity:model.status==='declared'?model.identity:null});
 }
 // Owned snapshots remain navigable after a mapping/source disappears.
 const ids=new Set(rows.map(r=>r.id));
 for(const m of Object.values(cfg.models))if(m.origin==='character'&&!ids.has(m.id)){const heads=modelSlots(cfg,m.id);if(heads.baseline)rows.push({id:m.id,character:true,name:m.name,relativePath:m.relativePath,format:'glb',origin:'project',status:'missing',opened:true,metadata:heads.baseline,error:'关联已移除或目录不可用；已有预览和历史仍保留。'});}
 return {rows,link,catalog,cfg,map};
}
export async function characterPage(work,{query='',offset=0,limit=100,preferMapped=false}={}){
 let data=await library(work,{includeCandidates:!preferMapped});const q=String(query).trim().toLowerCase();
 // A project without declarations still has characters: the rigged GLBs the
 // 角色 rail shows. Opening one of those (not its file row) keeps a single
 // model identity, so the first automatic open matches a later rail click.
 if(preferMapped&&!data.rows.some(r=>r.confirmed))data=await library(work,{includeCandidates:true});
 if(!data.rows.length){const page=await catalogPage(work,{query,offset,limit});return {...page,kind:'files',scan:{...page.scan,warnings:[...(page.scan.warnings||[]),...(data.map.error?['角色映射无法读取：'+data.map.error]:[])]}};}
 if(preferMapped&&data.rows.some(r=>r.confirmed))data.rows=data.rows.filter(r=>r.confirmed);
 data.rows.sort((a,b)=>Number(Boolean(b.confirmed))-Number(Boolean(a.confirmed))||a.name.localeCompare(b.name,'zh-Hans-CN'));
 const matches=data.rows.filter(r=>(r.name+' '+r.relativePath+' '+(r.metadata?.clips||[]).map(c=>c.name).join(' ')).toLowerCase().includes(q));
 offset=Math.max(0,Math.floor(Number(offset)||0));limit=Math.max(1,Math.min(200,Math.floor(Number(limit)||100)));
 return {entries:matches.slice(offset,offset+limit).map(({profile,signature,readyEvidence,portraitIdentity,...row})=>row),total:data.rows.length,confirmedTotal:data.rows.filter(r=>r.confirmed).length,matched:matches.length,offset,limit,hasMore:offset+limit<matches.length,scan:{...data.catalog.scan,warnings:[...(data.catalog.scan.warnings||[]),...(data.map.error?['角色映射无法读取：'+data.map.error]:[])]},linked:data.link?.status==='linked',activeAssetId:data.cfg.activeAssetId,kind:'characters',sourceTotal:data.catalog.entries.length};
}
// Light roster for the 角色 rail and gallery: declared characters first, then
// other skinned project GLBs, then workspace-only models (demo, imports).
// `portrait` tells the viewer where to read bytes for a preview render; it
// never opens, assembles or activates anything.
export async function castRoster(work,{scope='all'}={}){
 const data=await library(work,{includeCandidates:scope!=='confirmed'}),entries=[],seen=new Set();
 const workspacePortrait=asset=>asset&&(asset.meshCount||0)>0?{source:'workspace',identity:asset.sha256,asset:{sha256:asset.sha256,file:asset.file,bytes:asset.bytes}}:null;
 for(const r of data.rows){
  seen.add(r.id);let portrait=workspacePortrait(modelSlots(data.cfg,r.id).baseline);
  if(!portrait&&['glb','gltf'].includes(r.format)&&r.status==='available'&&r.profile&&r.portraitIdentity)portrait={source:'project',identity:r.portraitIdentity,url:'/api/characters/'+encodeURIComponent(r.id)+'/model'};
  entries.push({id:r.id,kind:'character',name:r.name,confirmed:Boolean(r.confirmed),opened:Boolean(r.opened),status:r.status,format:r.format,relativePath:r.relativePath||null,clipCount:r.metadata?.clips?.length||0,embeddedCount:r.embeddedCount||0,externalCount:r.externalCount||0,portrait});
 }
 for(const [id,m]of Object.entries(data.cfg.models)){
  if(seen.has(id))continue;const base=modelSlots(data.cfg,id).baseline,portrait=workspacePortrait(base);if(!portrait)continue;
  entries.push({id,kind:'model',name:m.name,confirmed:false,opened:true,status:'available',format:'glb',relativePath:m.relativePath||null,clipCount:base.clips?.length||0,embeddedCount:base.clips?.length||0,externalCount:0,portrait});
 }
 const rank=e=>e.confirmed?0:e.kind==='character'?1:2;
 entries.sort((a,b)=>rank(a)-rank(b)||a.name.localeCompare(b.name,'zh-Hans-CN'));
 return {entries,total:entries.length,confirmedTotal:entries.filter(e=>e.confirmed).length,activeAssetId:data.cfg.activeAssetId,linked:data.link?.status==='linked'};
}
// Main model of a declared or discovered GLB/glTF character, for portraits.
async function characterModel(work,id){
 const data=await library(work,{onlyId:id}),row=data.rows.find(r=>r.id===id);
 requireValue(row?.profile&&data.link?.exists,'角色不存在或项目未关联');
 requireValue(['glb','gltf'].includes(row.format)&&row.status==='available','这个角色的模型不能直接预览');
 return {root:data.link.root,file:row.profile.model};
}
export async function characterModelFile(work,id){const {root,file}=await characterModel(work,id);return inside(root,file);}
// GLB bytes; a .gltf is packed in memory with the files it references.
export async function characterModelBytes(work,id){const {root,file}=await characterModel(work,id);return (await readProjectModel(root,file)).bytes;}
// What stops a character's source from being replaced: a task running on it (its agent would finish against a file that is
// gone), and an unsent draft about a clip the new source changed or removed (the draft is the user's words about that motion;
// it is kept and the refresh waits). A candidate does not stop it: source-sync.mjs carries what still applies and archives the
// rest; a queued or waiting task does not either: it is marked stale with the reason.
export async function sourceRefreshBlockers(work,id,newBytes){
 const out=[],cfg=await readProject(work),heads=modelSlots(cfg,id);if(!heads.baseline)return out;
 const {readDraft}=await import('./drafts.mjs'),{readJobIndex}=await import('./job-index.mjs');
 const running=(await readJobIndex(work)).rows.find(j=>j.assetId===id&&j.state==='running');
 if(running)out.push(Object.assign(new String('角色有正在执行的任务（'+(running.clip||running.id)+'），请等它完成或中断后再载入新源'),{code:'MODEL_JOB_ACTIVE',jobId:running.id}));
 const {draft}=await readDraft(work,id);
 if(draft&&(draft.request?.trim()||draft.preserve?.trim()||draft.feedbackPoints?.length||draft.footRepair)){
  const clip=draft.context?.clip||draft.context?.slots?.[draft.context?.slot||'baseline']?.clip||null;
  let status='unverified';
  if(clip&&newBytes){try{status=clipChanges(await readFile(await inside(work,heads.baseline.file)),newBytes,[clip]).get(clip);}catch{}}
  if(status!=='unchanged')out.push('有未提交的草稿'+(clip?'（'+clip+'）':'')+(status==='removed'?'，这个动作已从新源中删除':status==='changed'?'，这个动作在新源中已改变':'')+'；请先提交或清空草稿，草稿仍保留');
 }
 return out;
}

// The game files each declared character is read from (its main model and animation sources), by the stage's model ID: what
// source-watch.mjs watches.
export async function characterTargets(work){
 const link=await getProjectLink(work);if(!link?.exists)return [];
 const map=await mapping(work);
 return map.characters.map(c=>({assetId:assetId(link.id,c.id),profileId:c.id,files:[c.model,...(c.animations||[]).map(a=>a.file)]}));
}

export async function openCharacter(work,id,{refreshSource=false,expectedSource,activate=true}={}){
 const key=work+'|'+id+'|'+refreshSource+'|'+JSON.stringify(expectedSource)+'|'+activate;if(flights.has(key))return flights.get(key);
 const promise=prepareCharacter(work,id,refreshSource,expectedSource,activate);flights.set(key,promise);try{return await promise;}finally{flights.delete(key);}
}
async function prepareCharacter(work,id,refreshSource,expectedSource,activate=true){
 const initial=await readProject(work),old=initial.models[id];
 if(old?.origin==='character'&&modelSlots(initial,id).baseline&&!refreshSource)return activate?activateModel(work,id):null;
 const data=await library(work,{onlyId:id}),row=data.rows.find(r=>r.id===id);requireValue(row?.profile&&data.link?.exists,'角色关联不存在；已有预览可继续打开');
 const profile=row.profile,root=data.link.root;let base,baseSource;
 if(extname(profile.model).toLowerCase()==='.fbx'){
  const entry=data.catalog.entries.find(e=>e.relativePath===profile.model);requireValue(entry,'请先刷新目录，再打开 FBX 角色');
  await openCatalogAsset(work,entry.id,{refreshSource});const cfg=await readProject(work),raw=modelSlots(cfg,entry.id).baseline;
  base=await stableRead(work,raw.file);baseSource=raw.source;
 }else {
  // glTF dependencies join the source identity, so a new .bin is a new version.
  const model=await readProjectModel(root,profile.model);base={bytes:model.bytes,sha256:model.sha256};
  baseSource={format:modelFormat(profile.model)==='gltf'?'gltf':'glb',sha256:model.sha256,projectRelativePath:profile.model,originalName:basename(profile.model),...(model.dependencyKind?{dependencies:model.dependencies,dependencyKind:model.dependencyKind}:{})};
 }
 if(expectedSource)requireValue(profile.model===expectedSource.model&&baseSource.sha256===expectedSource.sha256&&(!expectedSource.fingerprint||mainSourceFingerprint(profile.model,baseSource)===expectedSource.fingerprint),'角色来源与预期安装版本不一致，未刷新');
 const sources=[],reads=[];
 for(const source of profile.animations){
  if(!row.readyEvidence){sources.push({...source});continue;}
  try{const read=await readProjectModel(root,source.file,{maxBytes:50*1024*1024});sources.push({...source,bytes:read.bytes});reads.push({file:source.file,sha256:read.sha256,dependencies:read.dependencies});}catch{sources.push({...source});}
 }
 const result=await assembleCharacter(base.bytes,sources);validateCandidate(result.bytes,glbInfo(base.bytes).clips);
 for(const origin of Object.values(result.clips))if(!origin.file)origin.file=profile.model;
 if(!row.readyEvidence)for(const source of result.sources){source.status='needs-confirmation';source.error='项目依据已变化，请重新识别后更新关联';}
 const used=new Set(result.sources.filter(s=>s.status==='ready').map(s=>s.file));
 const dependencies=reads.filter(r=>used.has(r.file)).flatMap(({file,sha256,dependencies})=>[{projectRelativePath:file,sha256},...dependencies]);
 for(const e of profile.evidence)if(row.readyEvidence)dependencies.push({projectRelativePath:e.file,sha256:e.sha256});
 const assembly={version:1,profileId:profile.id,profileFile:MAP,profileSha256:characterBindingDigest(data.map.characters.find(c=>c.id===profile.id)||null),signature:row.signature,dependencies,clips:result.clips,sources:result.sources};
 const source={...baseSource,previewSha256:sha(result.bytes),assembly};
 const identity=s=>characterProfileDigest({sha256:s?.sha256,previewSha256:s?.previewSha256,profile:s?.assembly?.profileSha256,dependencies:[...consumedDependencies(s),...(s?.assembly?.dependencies||[])]});
 await withWorkspaceLock(work,async()=>{
  const current=await readProject(work);requireValue(current.models[id]?.headRevision===old?.headRevision,'准备期间角色版本已变化，请重新打开');
  const latest=await library(work,{onlyId:id}),fresh=latest.rows.find(r=>r.id===id);requireValue(fresh?.signature===row.signature,'准备期间角色来源或关联已变化，请刷新重试');
  const heads=modelSlots(current,id);
  if(heads.baseline?.source?.assembly?.signature===row.signature)return;
  if(heads.baseline&&identity(heads.baseline.source)===identity(source)){
   current.models[id].name=profile.name;
   const previousSignature=heads.baseline.source.assembly.signature;
   for(const head of Object.values(heads))if(head.source?.assembly?.signature===previousSignature)head.source={...head.source,assembly};
   setModelSlots(current,id,heads);await atomic(await inside(work,'project.json'),current);return;
  }
  // the old version's work, sorted clip by clip before the new source goes in (source-sync.mjs)
  let sorted=null;
  if(heads.baseline){
   const blockers=await sourceRefreshBlockers(work,id,result.bytes),busy=blockers.find(b=>b.code);
   if(blockers.length)throw Object.assign(Error(blockers.join('；')),busy?{code:busy.code,jobId:busy.jobId}:{});
   const {readJobIndex}=await import('./job-index.mjs');
   sorted=await sortSourceUpdate(work,current,id,result.bytes,await storedJobs(work,(await readJobIndex(work)).rows.filter(r=>r.assetId===id).map(r=>r.id)));
   for(const j of sorted.jobs)await atomic(await inside(work,'jobs/'+j.id+'/job.json'),j);
  }
  await importAsset(work,'baseline',result.bytes,profile.name,{locked:true,assetId:id,reset:true,activate:false,source,protectActive:true,model:{name:profile.name,origin:'character',relativePath:profile.model,projectId:data.link.id,characterProfileId:profile.id}});
  if(sorted){
   let next=await readProject(work);const revision=next.models[id].headRevision;next=await applySourceUpdate(work,next,id,{...sorted,jobs:[]},stageAsset);
   next.models[id].headRevision=revision;                                     // (one source update, one head revision: the carry is part of it)
   for(const j of sorted.jobs)if(j.sourceUpdate&&sorted.carry?.jobId===j.id){const head=modelSlots(next,id).candidate;j.sourceUpdate.rebased={baseline:{file:modelSlots(next,id).baseline.file,sha256:modelSlots(next,id).baseline.sha256},candidate:{file:head.file,sha256:head.sha256}};await atomic(await inside(work,'jobs/'+j.id+'/job.json'),j);}
   next.models[id].sourceUpdate={at:new Date().toISOString(),sha256:result.bytes?sha(result.bytes):null,source:source.sha256,...sorted.report};
   await atomic(await inside(work,'project.json'),next);
  }
 });
 return activate?activateModel(work,id):null;
}

// Delivery check for one explicitly declared runtime character. Discovery never
// establishes production ownership; the caller supplies a registry-verified path
// and installed source hash before opting into a refresh.
export async function characterSource(work,{profileId,expectedModel,expectedSha256,expectedFingerprint,refreshSource=false}={}){
 requireValue(typeof profileId==='string'&&profileId.length>0,'需要 --profile-id 指定已声明角色');
 if(expectedSha256)requireValue(/^[a-f0-9]{64}$/.test(expectedSha256),'源 SHA256 无效');
 if(expectedFingerprint)requireValue(/^[a-f0-9]{64}$/.test(expectedFingerprint),'来源指纹无效');
 if(refreshSource)requireValue(expectedModel&&expectedSha256,'刷新需要经游戏注册表核对的 --model 和 --source-sha256');
 const inspect=async()=>{
  const link=await getProjectLink(work);requireValue(link?.exists,link?.warning||'项目目录不可用，请重新打开实际工程');
  const map=await mapping(work),profile=map.characters.find(c=>c.id===profileId);requireValue(profile,'角色未声明；请先核对游戏注册表并保存 character-map');
  const id=assetId(link.id,profile.id),cfg=await readProject(work),heads=modelSlots(cfg,id),row=(await library(work,{onlyId:id})).rows.find(r=>r.id===id);
  const result={version:1,profileId,assetId:id,projectRoot:link.root,workspace:link.workspace,model:profile.model,opened:Boolean(heads.baseline),snapshotSourceSha256:heads.baseline?.source?.sha256||null,previewSha256:heads.baseline?.sha256||null,sourceChanged:Boolean(row?.sourceChanged),motionSources:row?.motionSources||[],blockers:[]};
  if(expectedModel&&profile.model!==path(expectedModel))return {...result,status:'mapping-mismatch'};
  requireValue(['glb','gltf'].includes(modelFormat(profile.model)),'来源校验支持 GLB/glTF；FBX 请走转换与来源依赖验收');
  let current;try{current=await readProjectModel(link.root,profile.model);}catch(error){return {...result,status:'unavailable',error:error.message};}
  result.sourceSha256=current.sha256;result.sourceDependencies=current.dependencies;
  result.sourceFingerprint=mainSourceFingerprint(profile.model,current);
  result.snapshotSourceFingerprint=heads.baseline?.source?mainSourceFingerprint(heads.baseline.source.projectRelativePath,heads.baseline.source):null;
  if(expectedSha256&&current.sha256!==expectedSha256||expectedFingerprint&&result.sourceFingerprint!==expectedFingerprint)return {...result,status:'source-mismatch'};
  if(refreshSource&&modelFormat(profile.model)==='gltf')requireValue(expectedFingerprint,'glTF 刷新还需要 --source-fingerprint 固定主文件及其依赖');
  if(!row?.readyEvidence)result.blockers.push('项目注册依据已变化，请重新阅读并确认角色关联');
  if(heads.baseline&&heads.baseline.source?.sha256!==current.sha256)result.blockers.push(...(await sourceRefreshBlockers(work,id,current.bytes)).map(String));
  const stale=!heads.baseline||heads.baseline.source?.sha256!==current.sha256||row.sourceChanged;
  return {...result,status:stale?heads.baseline?'stale':'unopened':result.motionSources.some(s=>s.status!=='ready')?'incomplete':'current'};
 };
 return withWorkspaceLock(work,async()=>{
  const before=await inspect();if(!refreshSource||before.status==='current')return {...before,refreshed:false};
  requireValue(['stale','unopened'].includes(before.status),'来源校验未通过：'+before.status);
  requireValue(!before.blockers.length,before.blockers.join('；'));
  await openCharacter(work,before.assetId,{refreshSource:true,expectedSource:{model:path(expectedModel),sha256:expectedSha256,fingerprint:expectedFingerprint}});
  return {...await inspect(),refreshed:true,sourceUpdate:(await readProject(work)).models[before.assetId]?.sourceUpdate||null};
 });
}

export async function associateCharacterMotion(work,id,{assetId:sourceId}={}){
 const data=await library(work,{onlyId:id}),row=data.rows.find(r=>r.id===id),entry=data.catalog.entries.find(e=>e.id===sourceId);
 requireValue(row?.profile&&entry,'请选择角色及项目中的动作来源');requireValue(['glb','gltf'].includes(entry.format),'此来源需要先转换为 GLB 或通过项目解析器声明');
 const profile=row.profile;requireValue(entry.relativePath!==profile.model,'主模型自带动作已关联');
 requireValue(modelFormat(profile.model)!=='unsupported','请先将主模型导出为 GLB 或 glTF，再关联外部动作');
 const source={file:entry.relativePath,format:entry.format,prefix:basename(entry.name,extname(entry.name))+'__'};
 const base=await readProjectModel(data.link.root,profile.model),input=await readProjectModel(data.link.root,entry.relativePath,{maxBytes:50*1024*1024});
 const check=await assembleCharacter(base.bytes,[{...source,bytes:input.bytes}]);requireValue(check.sources[0]?.status==='ready',check.sources[0]?.error||'动作无法安全绑定');
 const expectedDigest=characterProfileDigest(data.map),map=data.map,c=map.characters.find(c=>c.id===profile.id)||{...profile};delete c.mapped;
 requireValue(!c.animations.some(a=>a.file===source.file),'此动作来源已经关联');c.animations.push(source);
 if(!map.characters.some(p=>p.id===c.id))map.characters.push(c);
 await saveCharacterMap(work,map,{expectedDigest});return {associated:true,requiresRefresh:true,clips:check.sources[0].clips.length,message:'已保存关联。请载入角色源文件新版本以更新预览，已有版本和候选会保留。'};
}

// The main character picker uses explicit project declarations, never every GLB
// that happens to contain a mesh. No geometry or all-candidate stat walk here.
export async function projectCharacterProfiles(work){
 const [link,map,cfg,catalog]=await Promise.all([getProjectLink(work),mapping(work),readProject(work),readCatalog(work)]);
 if(!link?.exists)return [];
 const files=new Map(catalog.projectId===link.id?catalog.entries.map(e=>[e.relativePath,e]):[]);
 return map.characters.map(c=>{const id=assetId(link.id,c.id),heads=modelSlots(cfg,id),entry=files.get(c.model),a=heads.baseline||entry?.metadata;
  return {id,name:cfg.models[id]?.name||c.name,origin:'character',projectCharacter:true,opened:Boolean(heads.baseline),relativePath:c.model,capabilities:a?.capabilities,embeddedCount:a?.clips?.length||0,headRevision:cfg.models[id]?.headRevision||0,versions:[...Object.entries(heads).map(([slot,asset])=>({slot,asset})),...(cfg.models[id]?.revisions||[]).slice().reverse().flatMap((r,i)=>Object.entries(r.slots||{}).map(([slot,asset])=>({slot,asset,archived:true,at:r.at,index:i})))],actions:[]};
 });
}
