import {open,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {inside,readProject,modelSlots,sha,withWorkspaceLock} from './core.mjs';
import {readCatalog} from './asset-catalog.mjs';
import {getProjectLink} from './project-context.mjs';
import {motionTargetResolver} from './motion-assembly.mjs';
import {motionLibrary,registerMotionPack,previewMotion} from './motion-library.mjs';

const jobs=new Map(),sourceCache=new Map(),inventories=new Map(),MAX_JSON=8*1024*1024,MAX_VIEW=32*1024*1024;
const digest=value=>sha(Buffer.from(JSON.stringify(value)));
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const required=(ok,message)=>{if(!ok)throw Error(message);};
async function header(fh){
 const info=await fh.stat();required(info.isFile()&&info.size<=200*1024*1024,'资源过大');const bytes=Buffer.alloc(20);required((await fh.read(bytes,0,20,0)).bytesRead===20&&bytes.readUInt32LE(0)===0x46546c67&&bytes.readUInt32LE(4)===2&&bytes.readUInt32LE(8)===info.size&&bytes.readUInt32LE(16)===0x4e4f534a,'无效 GLB');
 const length=bytes.readUInt32LE(12);required(length<=MAX_JSON&&length+28<=info.size,'GLB 描述超出预算');const json=Buffer.alloc(length);required((await fh.read(json,0,length,20)).bytesRead===length,'读取未完成');const chunk=Buffer.alloc(8);await fh.read(chunk,0,8,20+length);required(chunk.readUInt32LE(4)===0x004e4942,'需要自包含 GLB');
 const doc=JSON.parse(json.toString('utf8').trim());required(Array.isArray(doc.nodes)&&doc.nodes.length<=5000&&Array.isArray(doc.animations||[])&&(doc.animations?.length||0)<=1000,'节点或动作数量超出预算');required(doc.buffers?.[0]&&!doc.buffers[0].uri,'需要嵌入动画数据');return {doc,info,binOffset:28+length,binLength:chunk.readUInt32LE(0)};
}
// Hash animation bytes and target bindings, never mesh/texture payloads. Only
// exact encodings are deduplicated; uncertain layouts stay separate.
async function curveHash(fh,meta,animation,target,views){
 required(Array.isArray(animation.channels)&&animation.channels.length<=5000&&Array.isArray(animation.samplers)&&animation.samplers.length<=5000,'动画轨道超出预算');const hash=createHash('sha256'),channels=animation.channels.map(c=>({...c,dest:target(c.target.node)})).sort((a,b)=>a.dest-b.dest||a.target.path.localeCompare(b.target.path));
 for(const channel of channels){const path=channel.target.path;required(['rotation','translation','scale'].includes(path),'此轨道需要模型专属适配');const sampler=meta.doc.animations?animation.samplers[channel.sampler]:null;required(sampler&&['LINEAR','STEP','CUBICSPLINE'].includes(sampler.interpolation||'LINEAR'),'不支持的插值');hash.update(JSON.stringify([channel.dest,path,sampler.interpolation||'LINEAR']));
  for(const index of [sampler.input,sampler.output]){
   const a=meta.doc.accessors?.[index],v=meta.doc.bufferViews?.[a?.bufferView];required(a&&v&&!a.sparse,'此 accessor 需要单独检查');const ext=v.extensions?.EXT_meshopt_compression||v.extensions?.KHR_meshopt_compression;
   const start=ext?.byteOffset??v.byteOffset??0,length=ext?.byteLength??v.byteLength,buffer=ext?.buffer??v.buffer??0;required(buffer===0&&Number.isSafeInteger(start)&&start>=0&&Number.isSafeInteger(length)&&length>0&&length<=MAX_VIEW&&start+length<=meta.binLength,'动画数据超出预算');
   const key=start+':'+length;let data=views.get(key);if(!data){data=Buffer.alloc(length);required((await fh.read(data,0,length,meta.binOffset+start)).bytesRead===length,'动画数据未完整读取');if((views.bytes||0)+length<=16*1024*1024){views.set(key,data);views.bytes=(views.bytes||0)+length;}}
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
 if(link?.exists)for(const e of catalog.entries.filter(e=>e.status==='available'&&e.format==='glb'&&e.metadata?.clips?.length).sort((a,b)=>Number(Boolean(a.metadata.meshCount))-Number(Boolean(b.metadata.meshCount))))add({kind:'project',sourceId:e.id,file:await inside(link.root,e.relativePath),name:e.name});
 return {sources,mappings:library.mappings,characters:(library.models.some(m=>m.projectCharacter)?library.models.filter(m=>m.projectCharacter):library.models.filter(m=>m.capabilities?.hasMesh)).map(m=>({id:m.id,name:m.name,projectCharacter:Boolean(m.projectCharacter)})),saved:library.characters,signature:digest({catalog:catalog.scan?.finishedAt,entries:catalog.entries.length,models:sources.map(s=>[s.kind,s.file,s.assetSha||s.versionId]),mappings:library.mappings.map(m=>m.id)})};
}
async function inventory(work){
 const stamps=await Promise.all(['project.json','catalog.json','motion-library.json','character-map.json','project-link.json'].map(async name=>{try{return stamp(await stat(await inside(work,name)));}catch(e){if(e.code==='ENOENT')return null;throw e;}})),key=digest(stamps),previous=inventories.get(work);
 if(previous?.key===key)return previous.promise;
 const promise=buildInventory(work);inventories.set(work,{key,promise});while(inventories.size>6)inventories.delete(inventories.keys().next().value);try{return await promise;}catch(error){if(inventories.get(work)?.promise===promise)inventories.delete(work);throw error;}
}
async function scan(work,job){
 try{
  const fh=await open(await inside(work,job.target.asset.file),'r');let base,preset=new Set();
  try{base=await header(fh);job.presetNames=new Set((base.doc.animations||[]).map(a=>a.name));const actual=await readFile(await inside(work,job.target.asset.file));required(sha(actual)===job.target.asset.sha256,'角色快照已损坏');const resolver=motionTargetResolver(base.doc,base.doc),views=new Map();for(const clip of base.doc.animations||[])try{preset.add(await curveHash(fh,base,clip,resolver,views));}catch{} }finally{await fh.close();}
  const unique=new Map();
  const deadline=Date.now()+120000;for(const source of job.sources){if(job.retired)return;if(Date.now()>deadline){job.state='partial';return;}job.checked++;if(source.file===await inside(work,job.target.asset.file))continue;
   let fh;try{
    fh=await open(source.file,'r');const mapping=source.kind==='pack'?job.mappings.find(m=>m.targetSha===job.target.asset.sha256&&m.sourceSha===source.versionId):null;source.mappingId=mapping?.id;const info=await fh.stat(),fingerprint=stamp(info),key=digest([work,source.file,fingerprint,job.target.asset.sha256,mapping?.id]);let entries=sourceCache.get(key);
    if(!entries){const meta=await header(fh),resolver=motionTargetResolver(base.doc,meta.doc,mapping?.nodeMap||{}),views=new Map();entries=[];let incompatible=0;
     for(const [index,clip]of (meta.doc.animations||[]).entries()){
      try{required(clip.channels?.length,'空动作');const curve=await curveHash(fh,meta,clip,resolver,views);entries.push({clip:clip.name||'animation_'+index,curve,duration:Math.max(0,...clip.samplers.map(s=>meta.doc.accessors?.[s.input]?.max?.[0]||0))});}catch{incompatible++;}
     }
     required(stamp(await fh.stat())===fingerprint,'读取期间来源变化');entries={rows:entries,incompatible};sourceCache.set(key,entries);while(sourceCache.size>1200)sourceCache.delete(sourceCache.keys().next().value);
    }
    job.incompatible+=entries.incompatible;for(const entry of entries.rows){if(preset.has(entry.curve)){job.duplicates++;continue;}const previous=unique.get(entry.curve);if(previous){previous.sourceCount++;job.duplicates++;continue;}
     const row={id:digest([job.target.asset.sha256,source.file,fingerprint,entry.clip]),name:entry.clip,duration:entry.duration,sourceName:source.name,sourceCount:1,origin:'compatible',presetVariant:job.presetNames.has(entry.clip),curve:entry.curve};unique.set(entry.curve,row);job.rows.push(row);job.details.set(row.id,{source,fingerprint,clip:entry.clip});
    }
   }catch{job.errors++;}finally{await fh?.close();}
   // Yield to playback, polling and user actions between every source.
   await new Promise(r=>setTimeout(r,0));
  }
  job.state='ready';
 }catch(e){job.state='failed';job.error=e.message;}
}
export async function discoverCharacterActions(work,input={}){
 const target=await withWorkspaceLock(work,()=>targetInfo(work,input)),data=await inventory(work),key=work+'|'+target.assetId+'|'+target.slot+'|'+target.asset.sha256;let job=jobs.get(key);
 if(!job||job.signature!==data.signature||input.refresh==='1'){
  if(job)job.retired=true;job={target,signature:data.signature,sources:structuredClone(data.sources),mappings:data.mappings,rows:[],details:new Map(),state:'scanning',checked:0,incompatible:0,duplicates:0,errors:0};jobs.set(key,job);while(jobs.size>6){const oldest=jobs.keys().next().value;jobs.get(oldest).retired=true;jobs.delete(oldest);}job.done=scan(work,job);
 }
 return {assetId:target.assetId,modelSha:target.asset.sha256,slot:target.slot,state:job.state,checked:job.checked,total:job.sources.length,incompatible:job.incompatible,duplicates:job.duplicates,error:job.error,characters:data.characters,saved:data.saved[target.assetId]||[],actions:job.rows.map(({curve,...row})=>row)};
}
export async function previewCharacterAction(work,input={}){return withWorkspaceLock(work,async()=>{
 const target=await targetInfo(work,input),key=work+'|'+target.assetId+'|'+target.slot+'|'+target.asset.sha256,job=jobs.get(key),entry=job?.details.get(input.actionId);required(entry&&!job.retired,'动作列表已更新，请重新选择');required(stamp(await stat(entry.source.file))===entry.fingerprint,'动作来源已变化，请重新匹配');
 let request;
 if(entry.source.kind==='pack')request={assetId:target.assetId,slot:target.slot,expectedModelSha:target.asset.sha256,packId:entry.source.packId,versionId:entry.source.versionId,clip:entry.clip,...(entry.source.mappingId?{mappingId:entry.source.mappingId}:{})};
 else{const library=await motionLibrary(work),source=entry.source,pack=await registerMotionPack(work,{...(source.kind==='project'?{sourceId:source.sourceId}:{assetId:source.ownerId,slot:source.slot,expectedModelSha:source.assetSha}),clips:[entry.clip],expectedRevision:library.revision,name:source.name+' / '+entry.clip});request={assetId:target.assetId,slot:target.slot,expectedModelSha:target.asset.sha256,packId:pack.pack.id,versionId:pack.version.id,clip:entry.clip};}
 const result=await previewMotion(work,request);return {result,request};
});}
export async function waitForCharacterActions(work,input={}){const state=await discoverCharacterActions(work,input),key=work+'|'+state.assetId+'|'+state.slot+'|'+state.modelSha;await jobs.get(key)?.done;return discoverCharacterActions(work,input);}

export async function stopCharacterActionDiscovery(work){const pending=[];for(const [key,job]of jobs)if(key.startsWith(work+'|')){job.retired=true;pending.push(job.done);jobs.delete(key);}await Promise.allSettled(pending);}
