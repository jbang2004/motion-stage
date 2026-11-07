import {open,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {inside,readProject,modelSlots,sha,withWorkspaceLock,atomic} from './core.mjs';
import {readCatalog,readProjectModel,projectModelStamp} from './asset-catalog.mjs';
import {getProjectLink} from './project-context.mjs';
import {motionTargetResolver,gltfClips} from './motion-assembly.mjs';
import {parseGlb} from './asset-tools.mjs';
import {motionLibrary,registerMotionPack,previewMotion} from './motion-library.mjs';

const jobs=new Map(),sourceCache=new Map(),inventories=new Map(),MAX_JSON=8*1024*1024,MAX_VIEW=32*1024*1024,MAX_VIEW_CACHE=16*1024*1024,MAX_SPAN=16*1024*1024,HEAD_READ=256*1024,PREFETCH=4;
const digest=value=>sha(Buffer.from(JSON.stringify(value)));
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const required=(ok,message)=>{if(!ok)throw Error(message);};
// A project .gltf source is read as its packed GLB through a read-only memory
// handle; its stamp covers the JSON and every file it references.
const sourceStamp=async source=>source.format==='gltf'?projectModelStamp(source.root,source.relativePath):stamp(await stat(source.file));
const sourceBytes=async source=>source.format==='gltf'?(await readProjectModel(source.root,source.relativePath)).bytes:readFile(source.file);
const memoryFile=bytes=>({stat:async()=>({isFile:()=>true,size:bytes.length}),read:async(target,offset,length,position)=>({bytesRead:position<bytes.length?bytes.copy(target,offset,position,Math.min(bytes.length,position+length)):0}),close:async()=>{}});
// One read covers the GLB header, the JSON chunk and the BIN chunk header for
// nearly every file; matching opens hundreds of sources, so round trips count.
async function header(fh){
 const info=await fh.stat();required(info.isFile()&&info.size<=200*1024*1024,'资源过大');const first=Buffer.allocUnsafe(Math.min(info.size,HEAD_READ)),got=(await fh.read(first,0,first.length,0)).bytesRead;
 required(got>=20&&first.readUInt32LE(0)===0x46546c67&&first.readUInt32LE(4)===2&&first.readUInt32LE(8)===info.size&&first.readUInt32LE(16)===0x4e4f534a,'无效 GLB');
 const length=first.readUInt32LE(12);required(length<=MAX_JSON&&length+28<=info.size,'GLB 描述超出预算');let json,chunk;
 if(28+length<=got){json=first.subarray(20,20+length);chunk=first.subarray(20+length,28+length);}
 else{json=Buffer.allocUnsafe(length);required((await fh.read(json,0,length,20)).bytesRead===length,'读取未完成');chunk=Buffer.alloc(8);await fh.read(chunk,0,8,20+length);}
 required(chunk.readUInt32LE(4)===0x004e4942,'需要自包含 GLB');
 const doc=JSON.parse(json.toString('utf8').trim());required(Array.isArray(doc.nodes)&&doc.nodes.length<=5000&&Array.isArray(doc.animations||[])&&(doc.animations?.length||0)<=1000,'节点或动作数量超出预算');required(doc.buffers?.[0]&&!doc.buffers[0].uri,'需要嵌入动画数据');return {doc,info,binOffset:28+length,binLength:chunk.readUInt32LE(0)};
}
function viewRange(meta,index){
 const a=meta.doc.accessors?.[index],v=meta.doc.bufferViews?.[a?.bufferView];required(a&&v&&!a.sparse,'此 accessor 需要单独检查');const ext=v.extensions?.EXT_meshopt_compression||v.extensions?.KHR_meshopt_compression;
 const start=ext?.byteOffset??v.byteOffset??0,length=ext?.byteLength??v.byteLength,buffer=ext?.buffer??v.buffer??0;required(buffer===0&&Number.isSafeInteger(start)&&start>=0&&Number.isSafeInteger(length)&&length>0&&length<=MAX_VIEW&&start+length<=meta.binLength,'动画数据超出预算');
 return {a,v,ext,start,length};
}
// Exporters write sampler data next to each other, so one read of that span
// replaces thousands of tiny per-accessor reads. A span mostly made of mesh or
// texture bytes (or too large) falls back to reading each view on its own.
function animationReader(fh,meta){
 const seen=new Set();let lo=Infinity,hi=0,total=0;
 for(const animation of Array.isArray(meta.doc.animations)?meta.doc.animations:[])for(const sampler of Array.isArray(animation?.samplers)?animation.samplers:[])for(const index of [sampler?.input,sampler?.output]){
  let range;try{range=viewRange(meta,index);}catch{continue;}const key=range.start+':'+range.length;if(seen.has(key))continue;seen.add(key);
  lo=Math.min(lo,range.start);hi=Math.max(hi,range.start+range.length);total+=range.length;
 }
 const useSpan=hi>lo&&hi-lo<=MAX_SPAN&&hi-lo<=total*2+1024*1024,views=new Map();let span=null,cached=0;
 return async(start,length)=>{
  if(useSpan&&start>=lo&&start+length<=hi){if(!span){const bytes=Buffer.allocUnsafe(hi-lo);required((await fh.read(bytes,0,bytes.length,meta.binOffset+lo)).bytesRead===bytes.length,'动画数据未完整读取');span=bytes;}return span.subarray(start-lo,start-lo+length);}
  const key=start+':'+length;let data=views.get(key);
  if(!data){data=Buffer.allocUnsafe(length);required((await fh.read(data,0,length,meta.binOffset+start)).bytesRead===length,'动画数据未完整读取');if(cached+length<=MAX_VIEW_CACHE){views.set(key,data);cached+=length;}}
  return data;
 };
}
// Hash animation bytes and target bindings, never mesh/texture payloads. Only
// exact encodings are deduplicated; uncertain layouts stay separate.
async function curveHash(meta,animation,target,read){
 required(Array.isArray(animation.channels)&&animation.channels.length<=5000&&Array.isArray(animation.samplers)&&animation.samplers.length<=5000,'动画轨道超出预算');const hash=createHash('sha256'),channels=animation.channels.map(c=>({...c,dest:target(c.target.node)})).sort((a,b)=>a.dest-b.dest||a.target.path.localeCompare(b.target.path));
 for(const channel of channels){const path=channel.target.path;required(['rotation','translation','scale'].includes(path),'此轨道需要模型专属适配');const sampler=meta.doc.animations?animation.samplers[channel.sampler]:null;required(sampler&&['LINEAR','STEP','CUBICSPLINE'].includes(sampler.interpolation||'LINEAR'),'不支持的插值');hash.update(JSON.stringify([channel.dest,path,sampler.interpolation||'LINEAR']));
  for(const index of [sampler.input,sampler.output]){
   const {a,v,ext,start,length}=viewRange(meta,index),data=await read(start,length);
   hash.update(JSON.stringify([a.type,a.componentType,a.count,a.normalized||false,a.byteOffset||0,v.byteStride||0,ext?{mode:ext.mode,filter:ext.filter,count:ext.count,byteStride:ext.byteStride}:null]));hash.update(data);
  }
 }
 return hash.digest('hex');
}
async function targetInfo(work,input){const cfg=await readProject(work),assetId=input.assetId||cfg.activeAssetId,slot=input.slot||'baseline';required(['baseline','candidate'].includes(slot),'无效角色版本');const asset=modelSlots(cfg,assetId)[slot];required(asset&&(!input.expectedModelSha||asset.sha256===input.expectedModelSha),'角色版本已变化');return {cfg,asset,assetId,slot};}
async function buildInventory(work){
 const [catalog,link,library]=await Promise.all([readCatalog(work),getProjectLink(work),motionLibrary(work)]),sources=[],seen=new Set();
 const add=s=>{if(!seen.has(s.file)){sources.push(s);seen.add(s.file);}};
 // Prefer declared/current snapshots over build copies as a source label.
 for(const m of library.models)for(const v of m.versions.filter(v=>!v.archived&&v.asset.clips?.length))add({kind:'model',ownerId:m.id,slot:v.slot,assetSha:v.asset.sha256,file:await inside(work,v.asset.file),name:m.name});
 for(const p of library.packs)for(const v of p.versions)add({kind:'pack',packId:p.id,versionId:v.id,file:await inside(work,v.file),name:p.name});
 if(link?.exists)for(const e of catalog.entries.filter(e=>e.status==='available'&&['glb','gltf'].includes(e.format)&&e.metadata?.clips?.length).sort((a,b)=>Number(Boolean(a.metadata.meshCount))-Number(Boolean(b.metadata.meshCount))))add({kind:'project',sourceId:e.id,file:await inside(link.root,e.relativePath),name:e.name,...(e.format==='gltf'?{format:'gltf',root:link.root,relativePath:e.relativePath}:{})});
 return {sources,mappings:library.mappings,characters:(library.models.some(m=>m.projectCharacter)?library.models.filter(m=>m.projectCharacter):library.models.filter(m=>m.capabilities?.hasMesh)).map(m=>({id:m.id,name:m.name,projectCharacter:Boolean(m.projectCharacter)})),saved:library.characters,signature:digest({catalog:catalog.scan?.finishedAt,entries:catalog.entries.length,models:sources.map(s=>[s.kind,s.file,s.assetSha||s.versionId]),mappings:library.mappings.map(m=>m.id)})};
}
async function inventory(work){
 const stamps=await Promise.all(['project.json','catalog.json','motion-library.json','character-map.json','project-link.json'].map(async name=>{try{return stamp(await stat(await inside(work,name)));}catch(e){if(e.code==='ENOENT')return null;throw e;}})),key=digest(stamps),previous=inventories.get(work);
 if(previous?.key===key)return previous.promise;
 const promise=buildInventory(work);inventories.set(work,{key,promise});while(inventories.size>6)inventories.delete(inventories.keys().next().value);try{return await promise;}catch(error){if(inventories.get(work)?.promise===promise)inventories.delete(work);throw error;}
}
// Match results survive restarts and one-shot CLI runs: one file per target
// model under the git-ignored cache/, keyed by each source's identity stamp.
// Bump the version whenever curve hashing or bone resolution changes.
export const ACTION_CACHE_DIR='cache/actions';
const ACTION_CACHE_VERSION=1,MAX_CACHE_FILE=64*1024*1024,HEX=/^[0-9a-f]{64}$/;
const validEntry=e=>e&&Array.isArray(e.rows)&&Number.isSafeInteger(e.incompatible)&&e.rows.every(r=>r&&typeof r.clip==='string'&&HEX.test(r.curve)&&Number.isFinite(r.duration));
async function loadActionCache(work,targetSha){
 const store={file:await inside(work,ACTION_CACHE_DIR+'/'+targetSha+'.json'),entries:{},used:{}};
 try{const info=await stat(store.file);if(info.size>MAX_CACHE_FILE)return store;const data=JSON.parse(await readFile(store.file,'utf8'));
  if(data?.version===ACTION_CACHE_VERSION&&data.targetSha===targetSha&&data.entries&&typeof data.entries==='object')for(const [key,entry]of Object.entries(data.entries))if(HEX.test(key)&&validEntry(entry))store.entries[key]=entry;
 }catch{}
 return store;
}
async function saveActionCache(store,targetSha,{prune}){
 const entries=prune?store.used:{...store.entries,...store.used},keys=Object.keys(entries);
 if(keys.length===Object.keys(store.entries).length&&keys.every(k=>store.entries[k]))return;
 try{await atomic(store.file,JSON.stringify({version:ACTION_CACHE_VERSION,targetSha,entries}));}catch{} // a cache, never a reason to fail matching
}
const live=job=>!job.retired&&job.state==='scanning';
async function matchSource(work,job,source,base,store){
 const mapping=source.kind==='pack'?job.mappings.find(m=>m.targetSha===job.target.asset.sha256&&m.sourceSha===source.versionId):null;source.mappingId=mapping?.id;
 const gltf=source.format==='gltf',fingerprint=await sourceStamp(source),key=digest([work,source.file,fingerprint,job.target.asset.sha256,mapping?.id]),storeKey=digest([source.file,fingerprint,mapping?.id||null]);
 let entries=sourceCache.get(key)||store.entries[storeKey];
 if(!entries){
  const fh=gltf?memoryFile(await sourceBytes(source)):await open(source.file,'r');
  try{
   if(!gltf)required(stamp(await fh.stat())===fingerprint,'读取期间来源变化');const meta=await header(fh),resolver=motionTargetResolver(base.doc,meta.doc,mapping?.nodeMap||{}),read=animationReader(fh,meta),rows=[];let incompatible=0;
   for(const [index,clip]of (meta.doc.animations||[]).entries()){
    if(!live(job))return null; // a cancelled file is never cached half-read
    try{required(clip.channels?.length,'空动作');const curve=await curveHash(meta,clip,resolver,read);rows.push({clip:clip.name||'animation_'+index,curve,duration:Math.max(0,...clip.samplers.map(s=>meta.doc.accessors?.[s.input]?.max?.[0]||0))});}catch{incompatible++;}
   }
   required((gltf?await sourceStamp(source):stamp(await fh.stat()))===fingerprint,'读取期间来源变化');entries={rows,incompatible};
  }finally{await fh.close();}
 }
 sourceCache.delete(key);sourceCache.set(key,entries);while(sourceCache.size>1200)sourceCache.delete(sourceCache.keys().next().value);
 store.used[storeKey]=entries;return {fingerprint,entries};
}
async function scan(work,job){
 const pending=new Map();
 try{
  const targetFile=await inside(work,job.target.asset.file),fh=await open(targetFile,'r');let base,preset=new Set();
  try{base=await header(fh);job.presetNames=new Set((base.doc.animations||[]).map(a=>a.name));const actual=await readFile(targetFile);required(sha(actual)===job.target.asset.sha256,'角色快照已损坏');const resolver=motionTargetResolver(base.doc,base.doc),read=animationReader(fh,base);for(const clip of base.doc.animations||[]){if(job.retired)return;try{preset.add(await curveHash(base,clip,resolver,read));}catch{}} }finally{await fh.close();}
  const store=await loadActionCache(work,job.target.asset.sha256),unique=new Map(),deadline=Date.now()+120000;
  // A few sources are read ahead while results merge strictly in inventory
  // order, so labels and dedup winners match a one-at-a-time scan.
  const ahead=i=>{for(let k=i;k<Math.min(job.sources.length,i+PREFETCH);k++)if(!pending.has(k)&&job.sources[k].file!==targetFile)pending.set(k,matchSource(work,job,job.sources[k],base,store).catch(error=>({error})));};
  for(const [i,source]of job.sources.entries()){
   if(job.retired)return;if(Date.now()>deadline){job.state='partial';await saveActionCache(store,job.target.asset.sha256,{prune:false});return;}
   job.checked++;if(source.file===targetFile)continue;ahead(i);
   const result=await pending.get(i);pending.delete(i);if(job.retired)return;
   if(!result||result.error){job.errors++;continue;}
   const {fingerprint,entries}=result;job.incompatible+=entries.incompatible;
   for(const entry of entries.rows){if(preset.has(entry.curve)){job.duplicates++;continue;}const previous=unique.get(entry.curve);if(previous){previous.sourceCount++;job.duplicates++;continue;}
    const row={id:digest([job.target.asset.sha256,source.file,fingerprint,entry.clip]),name:entry.clip,duration:entry.duration,sourceName:source.name,sourceCount:1,origin:'compatible',presetVariant:job.presetNames.has(entry.clip),curve:entry.curve};unique.set(entry.curve,row);job.rows.push(row);job.details.set(row.id,{source,fingerprint,clip:entry.clip});
   }
   // Yield to playback, polling and user actions between every source.
   await new Promise(r=>setImmediate(r));
  }
  job.state='ready';await saveActionCache(store,job.target.asset.sha256,{prune:true});
 }catch(e){job.state='failed';job.error=e.message;}
 // Read-ahead work stops at its next clip once the job is no longer live.
 finally{await Promise.allSettled(pending.values());}
}
export async function discoverCharacterActions(work,input={}){
 const target=await withWorkspaceLock(work,()=>targetInfo(work,input)),data=await inventory(work),key=work+'|'+target.assetId+'|'+target.slot+'|'+target.asset.sha256;let job=jobs.get(key);
 if(!job||job.signature!==data.signature||input.refresh==='1'){
  if(job)job.retired=true;job={target,signature:data.signature,sources:structuredClone(data.sources),mappings:data.mappings,rows:[],details:new Map(),state:'scanning',checked:0,incompatible:0,duplicates:0,errors:0};jobs.set(key,job);while(jobs.size>6){const oldest=jobs.keys().next().value;jobs.get(oldest).retired=true;jobs.delete(oldest);}job.done=scan(work,job);
 }
 return {assetId:target.assetId,modelSha:target.asset.sha256,slot:target.slot,state:job.state,checked:job.checked,total:job.sources.length,incompatible:job.incompatible,duplicates:job.duplicates,error:job.error,characters:data.characters,saved:data.saved[target.assetId]||[],actions:job.rows.map(({curve,...row})=>row)};
}
export async function previewCharacterAction(work,input={}){return withWorkspaceLock(work,async()=>{
 const target=await targetInfo(work,input),key=work+'|'+target.assetId+'|'+target.slot+'|'+target.asset.sha256,job=jobs.get(key),entry=job?.details.get(input.actionId);required(entry&&!job.retired,'动作列表已更新，请重新选择');required(await sourceStamp(entry.source)===entry.fingerprint,'动作来源已变化，请重新匹配');
 let request;
 if(entry.source.kind==='pack')request={assetId:target.assetId,slot:target.slot,expectedModelSha:target.asset.sha256,packId:entry.source.packId,versionId:entry.source.versionId,clip:entry.clip,...(entry.source.mappingId?{mappingId:entry.source.mappingId}:{})};
 else{const library=await motionLibrary(work),source=entry.source,pack=await registerMotionPack(work,{...(source.kind==='project'?{sourceId:source.sourceId}:{assetId:source.ownerId,slot:source.slot,expectedModelSha:source.assetSha}),clips:[entry.clip],expectedRevision:library.revision,name:source.name+' / '+entry.clip});request={assetId:target.assetId,slot:target.slot,expectedModelSha:target.asset.sha256,packId:pack.pack.id,versionId:pack.version.id,clip:entry.clip};}
 const result=await previewMotion(work,request);return {result,request};
});}
// Read-only curve resolution for thumbnails and hover previews. Unlike
// previewCharacterAction this never registers a motion pack or touches
// motion-library.json; it re-reads the exact source the scan indexed.
const CURVE_BATCH=12,curveTargets=new Map();
function resampleTrack(track,times){
 const width=track.values.length/Math.max(1,track.times.length),cubic=track.interpolation==='CUBICSPLINE',stride=cubic?width:width,valueWidth=cubic?width/3:width;
 const at=(key,i)=>track.values[key*stride+(cubic?valueWidth:0)+i];
 const values=[];
 for(const t of times){
  let hi=track.times.findIndex(x=>x>=t);if(hi<0)hi=track.times.length-1;const lo=Math.max(0,hi-1);
  const span=track.times[hi]-track.times[lo],f=track.interpolation==='STEP'||span<=0?0:Math.min(1,Math.max(0,(t-track.times[lo])/span));
  const row=[];for(let i=0;i<valueWidth;i++)row.push(at(lo,i)+(at(hi,i)-at(lo,i))*f);
  if(track.path==='rotation'){const n=Math.hypot(...row)||1;for(let i=0;i<row.length;i++)row[i]/=n;}
  values.push(...row);
 }
 return {...track,interpolation:'LINEAR',times,values};
}
async function curveTarget(work,asset){
 const cached=curveTargets.get(asset.sha256);if(cached)return cached;
 const doc=parseGlb(await readFile(await inside(work,asset.file))).doc;
 curveTargets.set(asset.sha256,doc);while(curveTargets.size>4)curveTargets.delete(curveTargets.keys().next().value);return doc;
}
export async function characterActionCurves(work,input={}){
 const ids=[...new Set((Array.isArray(input.actionIds)?input.actionIds:[]).map(String))].slice(0,CURVE_BATCH);
 required(ids.length,'需要选择动作');
 const samples=input.samples==null?null:Math.floor(Number(input.samples));required(samples==null||samples>=2&&samples<=120,'采样数需要在 2–120 之间');
 const target=await withWorkspaceLock(work,()=>targetInfo(work,input)),key=work+'|'+target.assetId+'|'+target.slot+'|'+target.asset.sha256,job=jobs.get(key);
 required(job&&!job.retired,'动作列表已更新，请重新选择');
 const base=await curveTarget(work,target.asset),groups=new Map(),results={};
 for(const id of ids){const entry=job.details.get(id);if(!entry){results[id]={error:'动作列表已更新，请重新选择'};continue;}const list=groups.get(entry.source.file)||[];list.push([id,entry]);groups.set(entry.source.file,list);}
 for(const [file,list]of groups){
  try{
   required(list.every(([,entry])=>entry.fingerprint===list[0][1].fingerprint),'动作来源已变化，请重新匹配');
   const source=list[0][1].source,bytes=await sourceBytes(source);required(await sourceStamp(source)===list[0][1].fingerprint,'动作来源已变化，请重新匹配');
   const mapping=list[0][1].source.mappingId?job.mappings.find(m=>m.id===list[0][1].source.mappingId):null;
   const clips=await gltfClips(base,bytes,{clips:list.map(([,entry])=>entry.clip),nodeMap:mapping?.nodeMap||{}});
   for(const [id,entry]of list){
    const clip=clips.find(c=>c.name===entry.clip);if(!clip?.tracks.length){results[id]={error:'所选动作没有可用轨道'};continue;}
    const duration=Math.max(0,...clip.tracks.map(t=>t.times.at(-1)||0));
    const times=samples?Array.from({length:samples},(_,i)=>duration*i/(samples-1)):null;
    results[id]={name:clip.name,duration,tracks:times?clip.tracks.map(t=>resampleTrack(t,times)):clip.tracks};
   }
  }catch(error){for(const [id]of list)results[id]={error:error.message};}
 }
 return {assetId:target.assetId,slot:target.slot,modelSha:target.asset.sha256,clips:results};
}
export async function waitForCharacterActions(work,input={}){const state=await discoverCharacterActions(work,input),key=work+'|'+state.assetId+'|'+state.slot+'|'+state.modelSha;await jobs.get(key)?.done;return discoverCharacterActions(work,input);}

export async function stopCharacterActionDiscovery(work){const pending=[];for(const [key,job]of jobs)if(key.startsWith(work+'|')){job.retired=true;pending.push(job.done);jobs.delete(key);}await Promise.allSettled(pending);}
