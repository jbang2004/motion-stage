import {projectCharacterProfiles} from './character-library.mjs';
import {readFile,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readProject,modelSlots,inside,sha,atomic,withWorkspaceLock,readWorkspaceJSON,glbInfo,importAsset,projectView} from './core.mjs';
import {readCatalog,readProjectModel} from './asset-catalog.mjs';
import {getProjectLink} from './project-context.mjs';
import {parseGlb} from './asset-tools.mjs';
import {extractMotionPack,gltfClips,assembleCharacter} from './motion-assembly.mjs';

const FILE='motion-library.json',ENGINE='direct-bind-v1',resolvedClips=new Map();let resolvedBytes=0;
// Disposable, bounded derived data; immutable source bytes are still verified on reuse.
function remember(key,clips){const weight=Buffer.byteLength(JSON.stringify(clips));if(weight>16*1024*1024)return;while(resolvedClips.size&&(resolvedClips.size>=32||resolvedBytes+weight>16*1024*1024)){const oldest=resolvedClips.keys().next().value;resolvedBytes-=resolvedClips.get(oldest).weight;resolvedClips.delete(oldest);}resolvedClips.set(key,{clips,weight});resolvedBytes+=weight;}
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const label=(value,fallback)=>String(value||fallback).trim().slice(0,160);
const hash=value=>sha(Buffer.from(JSON.stringify(value)));
const empty=()=>({version:1,revision:0,packs:[],mappings:[],characters:{}});
async function readLibrary(work){try{const value=await readWorkspaceJSON(work,FILE);requireValue(value.version===1&&Array.isArray(value.packs)&&Array.isArray(value.mappings)&&value.characters&&Number.isSafeInteger(value.revision),'动作库版本或结构不支持');return value;}catch(e){if(e.code==='ENOENT')return empty();throw e;}}
async function assetBytes(work,asset){requireValue(asset?.file==='assets/'+asset?.sha256+'.glb','资源身份无效');const bytes=await readFile(await inside(work,asset.file));requireValue(sha(bytes)===asset.sha256,'资源内容已变化或损坏');return bytes;}
function targetAsset(cfg,input){const id=input.assetId||cfg.activeAssetId,slot=input.slot||'baseline';requireValue(['baseline','candidate'].includes(slot),'无效版本');const asset=modelSlots(cfg,id)?.[slot];requireValue(asset,'请先选择角色模型');if(input.expectedModelSha)requireValue(input.expectedModelSha===asset.sha256,'角色版本已变化，请重新试播');return {id,slot,asset};}
function selectMotion(lib,input){const pack=lib.packs.find(p=>p.id===input.packId),version=pack?.versions.find(v=>v.id===input.versionId);requireValue(version&&version.id===version.sha256,'动作版本不存在或身份无效，请刷新动作库');requireValue(version.clips.some(c=>c.name===input.clip),'动作不属于该版本');const mapping=input.mappingId?lib.mappings.find(m=>m.id===input.mappingId):null;if(input.mappingId)requireValue(mapping,'骨架映射不存在');return {pack,version,mapping};}
async function save(work,lib){lib.revision++;await atomic(await inside(work,FILE),lib);}
function checkRevision(lib,revision){requireValue(Number.isSafeInteger(revision)&&revision===lib.revision,'动作库已被其他操作更新，请刷新后重试');}
export async function motionLibrary(work){return withWorkspaceLock(work,async()=>{
 const [lib,cfg]=await Promise.all([readLibrary(work),readProject(work)]);
 let models=Object.values(cfg.models).map(m=>{const heads=modelSlots(cfg,m.id),a=heads.baseline;return {id:m.id,name:m.name,origin:m.origin,headRevision:m.headRevision,active:m.id===cfg.activeAssetId,capabilities:a?.capabilities,versions:[...Object.entries(heads).map(([slot,asset])=>({slot,asset})),...(m.revisions||[]).slice().reverse().flatMap((r,i)=>Object.entries(r.slots||{}).map(([slot,asset])=>({slot,asset,archived:true,at:r.at,index:i})))],actions:lib.characters[m.id]||[]};});
 const projectCharacters=await projectCharacterProfiles(work);const declared=new Set(projectCharacters.map(m=>m.id));models=[...projectCharacters.map(m=>({...m,actions:lib.characters[m.id]||[]})),...models.filter(m=>!declared.has(m.id))];
 const catalog=await readCatalog(work).catch(()=>({entries:[]}));
 const sources=(catalog.entries||[]).filter(e=>e.status==='available'&&['glb','gltf'].includes(e.format)&&e.metadata?.clips?.length).map(e=>({id:e.id,name:e.name,relativePath:e.relativePath,clips:e.metadata.clips}));
 return {...lib,models,sources,projectCharacterIds:[...declared],projectFileCount:catalog.entries.length,activeAssetId:cfg.activeAssetId};
});}
export async function registerMotionPack(work,input={}){return withWorkspaceLock(work,async()=>{
 const lib=await readLibrary(work);checkRevision(lib,input.expectedRevision);
 let bytes,source,key;
 if(input.sourceId){const [catalog,link]=await Promise.all([readCatalog(work),getProjectLink(work)]),entry=catalog.entries.find(e=>e.id===input.sourceId);requireValue(link?.exists&&['glb','gltf'].includes(entry?.format)&&entry.status==='available','请选择有效 GLB 或 glTF 动作来源，FBX 请先导入转换');
  if(entry.format==='gltf'){const model=await readProjectModel(link.root,entry.relativePath,{maxBytes:50*1024*1024});bytes=model.bytes;source={file:entry.relativePath,sha256:model.sha256,name:entry.name,dependencies:model.dependencies};}
  else{const file=await inside(link.root,entry.relativePath),before=await stat(file,{bigint:true});requireValue(before.isFile()&&before.size<=50n*1024n*1024n,'动作来源超过 50 MB 或不是普通文件');bytes=await readFile(file);const after=await stat(file,{bigint:true});requireValue(['dev','ino','size','mtimeNs','ctimeNs'].every(key=>before[key]===after[key])&&BigInt(bytes.length)===before.size,'动作来源在读取期间变化，请重试');source={file:entry.relativePath,sha256:sha(bytes),name:entry.name};}key='project:'+entry.relativePath;
 }else{const cfg=await readProject(work),{id,slot,asset}=targetAsset(cfg,input);bytes=await assetBytes(work,asset);source={assetId:id,slot,sha256:asset.sha256,name:asset.label};key='model:'+id;}
 const packed=await extractMotionPack(bytes,{clips:input.clips});requireValue(packed.length<=50*1024*1024,'提取后的公共动作包超过 50 MB，请拆分动作来源');const digest=sha(packed),info=glbInfo(packed);requireValue(info.clips.length,'来源没有骨架动作');
 if(input.clips)key+='\0'+input.clips.join('\0');
 let pack=lib.packs.find(p=>p.id===(input.packId||hash(key).slice(0,32)));
 if(input.packId)requireValue(pack,'待更新动作库不存在');
 if(!pack){pack={id:hash(key).slice(0,32),name:label(input.name,source.name),createdAt:new Date().toISOString(),versions:[]};lib.packs.push(pack);}
 const existing=pack.versions.find(v=>v.id===digest);if(existing)return {pack,version:existing,revision:lib.revision,reused:true};
 await atomic(await inside(work,'assets/'+digest+'.glb'),packed);
 const version={id:digest,number:pack.versions.length+1,file:'assets/'+digest+'.glb',bytes:packed.length,sha256:digest,clips:info.clips,source,createdAt:new Date().toISOString()};pack.versions.push(version);await save(work,lib);return {pack,version,revision:lib.revision,reused:false};
});}
export async function saveMotionMapping(work,input={}){return withWorkspaceLock(work,async()=>{
 const lib=await readLibrary(work);checkRevision(lib,input.expectedRevision);const cfg=await readProject(work),target=targetAsset(cfg,input);
 const pack=lib.packs.find(p=>p.id===input.packId),version=pack?.versions.find(v=>v.id===input.versionId);requireValue(version,'来源版本不存在');
 const map=input.nodeMap||{};requireValue(map&&typeof map==='object'&&!Array.isArray(map)&&Object.keys(map).length<=2000&&Object.values(map).every(n=>typeof n==='string'&&n.length<=200),'骨骼映射格式无效');
 const model=await assetBytes(work,target.asset),source=await assetBytes(work,version);
 // A saved mapping is only accepted after all selected curves pass real rest/hierarchy checks.
 await gltfClips(parseGlb(model).doc,source,{nodeMap:map});
 const body={targetSha:target.asset.sha256,sourceSha:version.sha256,nodeMap:map,engine:ENGINE},id=hash(body);
 let mapping=lib.mappings.find(m=>m.id===id);if(mapping)return {mapping,revision:lib.revision};
 mapping={...body,id,name:label(input.name,'骨架映射'),createdAt:new Date().toISOString()};lib.mappings.push(mapping);await save(work,lib);return {mapping,revision:lib.revision};
});}
async function resolve(work,lib,cfg,input){
 const target=targetAsset(cfg,input),{pack,version,mapping}=selectMotion(lib,input),model=await assetBytes(work,target.asset),source=await assetBytes(work,version);
 if(mapping){requireValue(mapping.targetSha===target.asset.sha256&&mapping.sourceSha===version.sha256,'骨架映射不属于当前模型与动作版本');requireValue(mapping.id===hash({targetSha:mapping.targetSha,sourceSha:mapping.sourceSha,nodeMap:mapping.nodeMap,engine:mapping.engine}),'骨架映射身份校验失败');}
 const options={clips:[input.clip],nodeMap:mapping?.nodeMap||{}},cacheKey=hash({target:target.asset.sha256,source:version.sha256,clip:input.clip,mapping:mapping?.id||null,engine:ENGINE});
 let clips;const cached=resolvedClips.get(cacheKey);if(cached){clips=cached.clips;resolvedClips.delete(cacheKey);resolvedClips.set(cacheKey,cached);}else{clips=await gltfClips(parseGlb(model).doc,source,options);remember(cacheKey,clips);}
 requireValue(clips.length===1&&clips[0].tracks.length,'所选动作没有可用轨道');
 const recipe={assetId:target.id,slot:target.slot,modelSha:target.asset.sha256,modelFile:target.asset.file,packId:pack.id,packName:pack.name,versionId:version.id,versionNumber:version.number,motionFile:version.file,clip:input.clip,mappingId:mapping?.id||null,engine:ENGINE};
 return {target,version,source,model,options,clips,recipe:{...recipe,id:hash(recipe)}};
}
export async function previewMotion(work,input={}){return withWorkspaceLock(work,async()=>{const r=await resolve(work,await readLibrary(work),await readProject(work),input);return {recipe:r.recipe,clips:structuredClone(r.clips),model:r.target.asset,status:'compatible'};});}
export async function adoptMotion(work,input={}){return withWorkspaceLock(work,async()=>{
 const lib=await readLibrary(work);checkRevision(lib,input.expectedRevision);const r=await resolve(work,lib,await readProject(work),input);
 requireValue(input.previewId===r.recipe.id,'试播组合已变化，请重新试播后收录');const actions=lib.characters[r.target.id]??=[];
 const existing=actions.find(a=>a.recipe.id===r.recipe.id);if(existing)return {action:existing,revision:lib.revision,reused:true};
 const name=label(input.name,input.clip),previous=actions.filter(a=>a.name===name),action={id:randomUUID(),name,number:previous.length+1,recipe:r.recipe,createdAt:new Date().toISOString(),parentId:previous.at(-1)?.id||null};actions.push(action);await save(work,lib);return {action,revision:lib.revision};
});}
async function assemble(r){const result=await assembleCharacter(r.model,[{file:r.version.file,format:'glb',bytes:r.source,...r.options,replace:true}]);requireValue(result.sources[0]?.status==='ready',result.sources[0]?.error);return result;}
export const readMotionLibrary=work=>withWorkspaceLock(work,()=>readLibrary(work));
export function findAdoptedAction(lib,actionId){for(const [assetId,actions] of Object.entries(lib.characters||{})){const action=actions.find(a=>a.id===actionId);if(action)return {assetId,action,latest:actions.filter(a=>a.name===action.name).at(-1)};}return null;}
// Game-integration export of an adopted action, pinned to what the user adopted:
// a moved model head or source identity refuses instead of exporting something else.
export async function exportAdoptedAction(work,{actionId}={}){return withWorkspaceLock(work,async()=>{
 const lib=await readLibrary(work),cfg=await readProject(work),found=findAdoptedAction(lib,actionId);requireValue(found,'没有找到这条收录动作，请用 integrations 查看收录动作 ID');
 const pinned=found.action.recipe,head=modelSlots(cfg,found.assetId)[pinned.slot];
 requireValue(head?.sha256===pinned.modelSha,'角色模型在收录后已更新，这条收录固定在旧模型上；请在动作库对当前模型重新试播并收录后再导出。');
 const r=await resolve(work,lib,cfg,{assetId:found.assetId,slot:pinned.slot,expectedModelSha:pinned.modelSha,packId:pinned.packId,versionId:pinned.versionId,clip:pinned.clip,mappingId:pinned.mappingId||undefined});
 requireValue(['modelSha','versionId','motionFile','clip','mappingId','engine'].every(k=>(r.recipe[k]??null)===(pinned[k]??null)),'收录时固定的动作来源已变化，请重新试播并收录后再导出。');
 const {bytes}=await assemble(r);return {bytes,sha256:sha(bytes),assetId:found.assetId,action:found.action,recipe:pinned};
});}
export async function materializeMotion(work,input={}){return withWorkspaceLock(work,async()=>{
 const lib=await readLibrary(work),cfg=await readProject(work),r=await resolve(work,lib,cfg,input);requireValue(input.previewId===r.recipe.id,'预览已变化，请重新试播');
 // Explicit task/export bridge. Ordinary previews and adoption never copy model bytes.
 const result=await assemble(r);
 if(input.exportOnly)return {bytes:result.bytes,recipe:r.recipe};
 const {readJobIndex,activeJobStates}=await import('./job-index.mjs');const busy=(await readJobIndex(work)).rows.find(j=>j.assetId===r.target.id&&activeJobStates.has(j.state));requireValue(!busy,'当前角色已有未完成任务，请先处理或取消后再准备修改');
 (cfg.models[r.target.id].revisions??=[]).push({slots:structuredClone(modelSlots(cfg,r.target.id)),at:new Date().toISOString(),kind:'motion-preparation'});
 const asset=await importAsset(work,'candidate',result.bytes,'动作工作版本 · '+input.clip,{locked:true,project:cfg,assetId:r.target.id,activate:false,source:{...(r.target.asset.source||{}),motionBinding:r.recipe}});
 return {project:projectView(await readProject(work),r.target.id),asset,recipe:r.recipe};
});}
export async function motionRigOptions(work,input={}){return withWorkspaceLock(work,async()=>{
 const lib=await readLibrary(work),target=targetAsset(await readProject(work),input),{version}=selectMotion(lib,input),source=parseGlb(await assetBytes(work,version)).doc,model=parseGlb(await assetBytes(work,target.asset)).doc;
 requireValue((source.nodes?.length||0)<=5000&&(model.nodes?.length||0)<=5000,'骨架节点过多，请拆分资源后配置');
 const parents=new Map();for(const [i,n]of (source.nodes||[]).entries())for(const child of n.children||[])parents.set(child,i);
 const required=new Set();for(const a of source.animations||[])for(const c of a.channels||[]){let at=c.target?.node;while(at!==undefined&&!required.has(at)){required.add(at);at=parents.get(at);}}
 return {source:source.nodes.map((n,index)=>({index,name:n.name||'',required:required.has(index)})).filter(n=>n.required),target:model.nodes.map((n,index)=>({index,name:n.name||''})).filter(n=>n.name),modelSha:target.asset.sha256,sourceSha:version.sha256};
});}
