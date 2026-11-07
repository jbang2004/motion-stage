import {open,readFile,readdir,stat,realpath,mkdir} from 'node:fs/promises';
import {join,relative,extname,dirname,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execExecutable} from './platform-runtime.mjs';
import {ROOT,json,atomic,inside,sha,readProject,projectView,modelSlots,activateModel,importAsset,withWorkspaceLock,glbDocumentInfo,setModelSlots} from './core.mjs';
import {getProjectLink} from './project-context.mjs';
import {convertFbx,findBlender,gltfReferences,packGltf} from './asset-tools.mjs';
import {isSampledTracks,sampledMetadata,createCurveResource} from './curve-resources.mjs';
import {consumedDependencies} from './source-dependencies.mjs';

const SKIP=new Set(['.git','.hg','.svn','node_modules','.agents','.codex','.claude','.cache','.venv','venv','__pycache__','Library','Temp','obj','coverage','dist']);
const FORMATS=new Set(['.json','.glb','.fbx','.gltf','.blend','.obj','.vrm','.bvh','.usd','.usda','.usdc','.abc','.uasset','.ma','.mb','.c4d']);
export const catalogLimits=Object.freeze({maxFiles:100000,maxDirectories:20000,maxDepth:64,maxMs:120000,maxMetadataBytes:8*1024*1024,maxAssetBytes:200*1024*1024});
const scans=new Map(),imports=new Map(),pageIndexes=new Map();
const slash=p=>p.split(sep).join('/');
const fingerprint=s=>[s.size,s.mtimeMs,s.ctimeMs,s.ino,s.dev].join(':');
const now=()=>new Date().toISOString();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const empty=()=>({version:1,projectId:null,entries:[],scan:{state:'idle',visitedFiles:0,visitedDirectories:0,warnings:[]}});
const excluded=name=>SKIP.has(name)||name.startsWith('.motion-studio');

export async function readCatalog(work){
 let data;try{data=await json(await inside(work,'catalog.json'));}catch(e){if(e.code!=='ENOENT')throw e;return empty();}
 if(data.version!==1||!Array.isArray(data.entries))throw Error('模型目录数据格式无效，原记录已保留');
 if(data.scan.state==='scanning'&&!alive(data.scan.pid))data.scan={...data.scan,state:'interrupted',message:'上次扫描被中断，可重新扫描。'};
 return data;
}

export async function catalogPage(work,{query='',offset=0,limit=100}={}){
 work=await realpath(work);
 return withWorkspaceLock(work,async()=>{
  const link=await getProjectLink(work),stamps=await Promise.all(['project.json','catalog.json','project-link.json'].map(async file=>{try{return fingerprint(await stat(await inside(work,file)));}catch(e){if(e.code==='ENOENT')return 'missing';throw e;}}));
  const key=JSON.stringify([stamps,link?.id,link?.status]);let index=pageIndexes.get(work);
  if(index?.key!==key){
   const [catalog,cfg]=await Promise.all([readCatalog(work),readProject(work)]),entries=catalog.projectId&&catalog.projectId!==link?.id?[]:catalog.entries;
   const rows=entries.map(entry=>{
    const model=cfg.models[entry.id],heads=modelSlots(cfg,entry.id);
    return {...entry,opened:Boolean(heads.baseline),hasCandidate:Boolean(heads.candidate&&heads.candidate.sha256!==heads.baseline?.sha256),sourceChanged:Boolean(model?.sourceFingerprint&&entry.fingerprint!==model.sourceFingerprint||model?.dependencyFingerprint&&entry.dependencyFingerprint&&model.dependencyFingerprint!==entry.dependencyFingerprint)};
   }),ids=new Set(rows.map(r=>r.id));
   for(const model of Object.values(cfg.models))if(model.origin!=='character'&&!ids.has(model.id)){
    const heads=modelSlots(cfg,model.id);if(!heads.baseline)continue;
    rows.push({id:model.id,name:model.name,relativePath:model.relativePath||'',format:heads.baseline.source?.format==='sampled-tracks-v1'?'json':'glb',origin:heads.baseline.generator?.includes('original teaching')?'teaching':model.origin||'import',status:'available',opened:true,metadata:heads.baseline,hasCandidate:heads.candidate?.sha256!==heads.baseline.sha256});
   }
   rows.sort((a,b)=>(a.relativePath||a.name).localeCompare(b.relativePath||b.name));
   index={key,rows,search:rows.map(r=>(r.name+' '+r.relativePath).toLowerCase()),queries:new Map(),scan:catalog.scan,activeAssetId:cfg.activeAssetId||null};
   pageIndexes.delete(work);pageIndexes.set(work,index);while(pageIndexes.size>4)pageIndexes.delete(pageIndexes.keys().next().value);
  }
  const q=String(query).trim().toLowerCase();let filtered=q?index.queries.get(q):index.rows;
  if(!filtered){filtered=index.rows.filter((_,i)=>index.search[i].includes(q));index.queries.set(q,filtered);while(index.queries.size>12)index.queries.delete(index.queries.keys().next().value);}
  offset=Number.isFinite(Number(offset))?Math.max(0,Math.floor(Number(offset))):0;limit=Number.isFinite(Number(limit))?Math.max(1,Math.min(200,Math.floor(Number(limit)))):100;
  const scan=structuredClone(index.scan);if(scan.state==='scanning'&&!alive(scan.pid))scan.state='interrupted';
  return {entries:structuredClone(filtered.slice(offset,offset+limit)),total:index.rows.length,matched:filtered.length,offset,limit,hasMore:offset+limit<filtered.length,scan,linked:link?.status==='linked',activeAssetId:index.activeAssetId};
 });
}

export async function glbMetadata(path,limits=catalogLimits){
 const fh=await open(path,'r');try{
  const s=await fh.stat(),head=Buffer.alloc(20);
  if(s.size>limits.maxAssetBytes)throw Error('模型超过 200 MB，暂不支持预览');
  if((await fh.read(head,0,20,0)).bytesRead!==20||head.readUInt32LE(0)!==0x46546c67||head.readUInt32LE(4)!==2||head.readUInt32LE(8)!==s.size||head.readUInt32LE(16)!==0x4e4f534a)throw Error('GLB 文件头无效');
  const length=head.readUInt32LE(12);if(length>limits.maxMetadataBytes||length%4||length+20>s.size)throw Error('GLB 描述块过大或不完整');
  const bytes=Buffer.alloc(length);if((await fh.read(bytes,0,length,20)).bytesRead!==length)throw Error('读取模型时文件发生变化');
  const doc=JSON.parse(bytes.toString('utf8').trim()),info=glbDocumentInfo(doc);
  info.nodeCount=doc.nodes?.length||0;
  if(fingerprint(s)!==fingerprint(await fh.stat()))throw Error('读取模型时文件发生变化，请刷新');
  return info;
 }finally{await fh.close();}
}

// A .gltf is a JSON scene plus the relative files its buffers/images name.
// Metadata comes from the JSON alone; `dependencies` lists those files.
const gltfJson=bytes=>{let doc;try{doc=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{throw Error('glTF JSON 无法解析');}if(!doc||typeof doc!=='object'||Array.isArray(doc))throw Error('glTF 描述无效');return doc;};
const gltfPaths=(doc,rel)=>[...new Set(gltfReferences(doc,rel).map(r=>r.path))];
export async function gltfMetadata(root,rel,limits=catalogLimits){
 const {bytes}=await stableBytes(await inside(root,rel),limits.maxAssetBytes),doc=gltfJson(bytes),strip=list=>list?.map(({uri,...item})=>item);
 const dependencies=gltfPaths(doc,rel),info=glbDocumentInfo({...doc,buffers:strip(doc.buffers),images:strip(doc.images)});
 info.nodeCount=doc.nodes?.length||0;return {info,dependencies};
}
// `stamp` equals dependencyFingerprint for the same paths: it changes when a
// referenced file changes or disappears. `missing` lists unreadable files.
export async function gltfDependencyState(root,dependencies){
 const rows=[],missing=[];let bytes=0;
 for(const dep of dependencies){let value='missing';try{const s=await stat(await inside(root,dep));value=fingerprint(s);if(s.isFile())bytes+=s.size;else missing.push(dep);}catch{missing.push(dep);}rows.push([dep,value]);}
 return {stamp:sha(Buffer.from(JSON.stringify(rows.sort((a,b)=>a[0].localeCompare(b[0]))))),missing,bytes};
}
const gltfLists=new Map();
// Change stamp of a project model without reading geometry. A .gltf stamp
// also covers every file it references, so an edited .bin is never silent.
export async function projectModelStamp(root,rel){
 const path=await inside(root,rel),own=fingerprint(await stat(path));if(extname(rel).toLowerCase()!=='.gltf')return own;
 const key=path+'|'+own;let deps=gltfLists.get(key);
 if(!deps){deps=gltfPaths(gltfJson((await stableBytes(path)).bytes),rel);gltfLists.set(key,deps);while(gltfLists.size>256)gltfLists.delete(gltfLists.keys().next().value);}
 return own+'|'+(await gltfDependencyState(root,deps)).stamp;
}
async function packProjectGltf(root,rel,json,maxBytes=catalogLimits.maxAssetBytes){
 const doc=gltfJson(json),files=new Map(),dependencies=[];let total=json.length;
 for(const path of gltfPaths(doc,rel)){
  let read;try{read=await stableBytes(await inside(root,path),maxBytes-total);}catch(e){throw Error((e.code==='ENOENT'?'缺少 glTF 引用的文件：':'无法读取 glTF 引用的文件（'+e.message+'）：')+path);}
  total+=read.bytes.length;files.set(path,read.bytes);dependencies.push({projectRelativePath:path,sha256:sha(read.bytes)});
 }
 return {bytes:packGltf(doc,files,rel,{maxBytes}),dependencies,dependencyKind:'gltf-references-v1'};
}
// GLB bytes of a project model. A .gltf is packed in memory with the files it
// references; sha256 is the main file's and `dependencies` hashes the rest.
export async function readProjectModel(root,rel,{maxBytes=catalogLimits.maxAssetBytes}={}){
 const main=await stableBytes(await inside(root,rel),maxBytes),own={sha256:sha(main.bytes),fingerprint:main.fingerprint};
 if(extname(rel).toLowerCase()!=='.gltf')return {...own,bytes:main.bytes,dependencies:[]};
 return {...own,...await packProjectGltf(root,rel,main.bytes,maxBytes)};
}

// A bounded asynchronous scan publishes incremental results and never changes
// model heads. Only a completed, exhaustive pass can declare a source missing.
export async function startCatalogScan(work,{force=false,reread=false,limits:overrides={}}={}){
 work=await realpath(work);if(scans.has(work))return readCatalog(work);
 const link=await getProjectLink(work);if(!link||!link.exists)return readCatalog(work);
 const controller=new AbortController(),limits={...catalogLimits,...overrides};
 let owned=false;
 let catalog=await withWorkspaceLock(work,async()=>{
  const current=await readCatalog(work);
  if(current.scan.state==='scanning'&&alive(current.scan.pid))return current;
  if(!force&&current.scan.state==='complete'&&Date.now()-Date.parse(current.scan.finishedAt)<1500)return current;
  const data=current.projectId===link.id?current:empty();
  data.projectId=link.id;data.scan={id:randomUUID(),pid:process.pid,state:'scanning',startedAt:now(),visitedFiles:0,visitedDirectories:0,found:0,warnings:[],truncated:false};
  await atomic(await inside(work,'catalog.json'),data);owned=true;return data;
 });
 if(!owned)return catalog;
 const scan=catalog.scan,previous=new Map(catalog.entries.map(e=>[e.relativePath,e])),found=new Map(),cfg=await readProject(work);
 const publish=async(final=false)=>withWorkspaceLock(work,async()=>{
  const current=await readCatalog(work);if(current.scan.id!==scan.id)return;
  const rows=new Map(previous);for(const [path,e]of found)rows.set(path,e);
  if(final&&scan.state==='complete'&&!scan.truncated&&!scan.warnings.length)for(const [path,e]of rows)if(!found.has(path))rows.set(path,{...e,status:'missing',error:'源文件已不在目录中；已导入版本与历史仍保留。'});
  await atomic(await inside(work,'catalog.json'),{version:1,projectId:link.id,entries:[...rows.values()],scan:{...scan,found:found.size}});
 });
 const promise=(async()=>{
  const started=Date.now(),workspace=await realpath(work),root=await realpath(link.root),queue=[{path:root,depth:0}];let lastPublish=0;
  const warn=message=>{if(scan.warnings.length<20)scan.warnings.push(message);};
  try{
   for(let i=0;i<queue.length;i++){
    if(controller.signal.aborted){scan.state='interrupted';break;}
    if(scan.visitedFiles>=limits.maxFiles||scan.visitedDirectories>=limits.maxDirectories||Date.now()-started>limits.maxMs){scan.truncated=true;break;}
    const dir=queue[i];scan.visitedDirectories++;let entries;
    try{entries=await readdir(dir.path,{withFileTypes:true});}catch(e){if(i===0)throw e;warn('无法读取目录：'+slash(relative(root,dir.path)));continue;}
    // Standalone review workspaces may live inside a linked project as well.
    if(dir.path!==root&&entries.some(e=>e.name==='project.json')&&entries.some(e=>e.name==='feedback.json'))continue;
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries){
     if(controller.signal.aborted)break;
     const path=join(dir.path,entry.name);
     if(entry.isSymbolicLink()||excluded(entry.name)||path===workspace||path===ROOT)continue;
     if(entry.isDirectory()){if(dir.depth<limits.maxDepth)queue.push({path,depth:dir.depth+1});else scan.truncated=true;continue;}
     if(!entry.isFile())continue;scan.visitedFiles++;
     if(scan.visitedFiles>limits.maxFiles||Date.now()-started>limits.maxMs){scan.truncated=true;break;}
     const ext=extname(entry.name).toLowerCase();if(!FORMATS.has(ext))continue;
     const rel=slash(relative(root,path)),old=previous.get(rel);let row={id:old?.id||randomUUID(),name:entry.name,relativePath:rel,format:ext.slice(1),origin:'project',status:['.glb','.gltf','.fbx','.json'].includes(ext)?'available':'source-only'};
     try{
      const s=await stat(await inside(root,rel));row={...row,bytes:s.size,mtimeMs:s.mtimeMs,fingerprint:fingerprint(s)};
      if(ext==='.json'){
       let text;
       if(s.size>limits.maxMetadataBytes){const fh=await open(path,'r');try{const head=Buffer.alloc(8192);const {bytesRead}=await fh.read(head,0,head.length,0);text=head.subarray(0,bytesRead).toString('utf8');}finally{await fh.close();}
        if(!/"format"\s*:\s*"sampled-tracks-v1"/.test(text)&&!(/"fps"\s*:/.test(text)&&/"clips"\s*:/.test(text)))continue;
        if(s.size>50*1024*1024)throw Error('采样动作 JSON 超过 50 MB');row.motionFormat='sampled-tracks-v1';
       }else{
        text=await readFile(path,'utf8');let data;try{data=JSON.parse(text);}catch{if(!old?.motionFormat&&!/"format"\s*:\s*"sampled-tracks-v1"/.test(text))continue;throw Error('采样动作 JSON 无法解析');}
        if(!isSampledTracks(data))continue;row.motionFormat='sampled-tracks-v1';row.metadata=sampledMetadata(data);
       }
       if(fingerprint(s)!==fingerprint(await stat(path)))throw Error('读取动作时文件发生变化，请刷新');
      }
      if(ext==='.glb')row.metadata=!reread&&old?.fingerprint===row.fingerprint&&old.metadata?.capabilities?.version===1?old.metadata:await glbMetadata(path,limits);
      else if(ext==='.gltf'){
       if(!reread&&old?.fingerprint===row.fingerprint&&old.metadata?.capabilities?.version===1&&Array.isArray(old.dependencies)){row.metadata=old.metadata;row.dependencies=old.dependencies;}
       else{const read=await gltfMetadata(root,rel,limits);row.metadata=read.info;row.dependencies=read.dependencies;}
       // Referenced files are part of the source: their stamps are compared
       // with the opened version's, like FBX texture dependencies.
       const deps=await gltfDependencyState(root,row.dependencies);row.dependencyFingerprint=deps.stamp;row.bytes=s.size+deps.bytes;
       if(deps.missing.length)throw Error('缺少 glTF 引用的文件：'+deps.missing.slice(0,3).join('、')+(deps.missing.length>3?' 等 '+deps.missing.length+' 个':''));
       if(row.bytes>limits.maxAssetBytes)throw Error('glTF 及其引用文件超过 200 MB，暂不支持预览');
      }
      else if(ext==='.fbx'&&s.size>limits.maxAssetBytes)throw Error('FBX 超过 200 MB，暂不支持转换');
      if(ext==='.fbx'&&cfg.models[row.id]?.sourceDependencies)row.dependencyFingerprint=await dependencyFingerprint(root,cfg.models[row.id].sourceDependencies);
     }catch(e){row.status='invalid';row.error=e.message;}
     found.set(rel,row);
     if(Date.now()-lastPublish>350){await publish();lastPublish=Date.now();}
    }
   }
   if(controller.signal.aborted)scan.state='interrupted';
   else if(scan.state==='scanning')scan.state=scan.truncated||scan.warnings.length?'partial':'complete';
  }catch(e){scan.state='failed';scan.error=e.message;}
  finally{scan.finishedAt=now();try{await publish(true);}finally{scans.delete(work);}}
 })();
 scans.set(work,{controller,promise});promise.catch(()=>{});return readCatalog(work);
}
export async function waitForCatalogScan(work){await scans.get(await realpath(work))?.promise;return readCatalog(work);}
export async function stopCatalogScan(work){const scan=scans.get(await realpath(work));scan?.controller.abort();await scan?.promise;}

async function stableBytes(path,max=catalogLimits.maxAssetBytes){
 const fh=await open(path,'r');try{
  const before=await fh.stat();if(!before.isFile()||before.size>max)throw Error('模型为空、不是文件或超过 '+Math.max(0,Math.floor(max/1048576))+' MB');
  const bytes=await fh.readFile();if(fingerprint(before)!==fingerprint(await fh.stat())||bytes.length!==before.size)throw Error('读取期间源文件发生变化，请重试');
  return {bytes,fingerprint:fingerprint(before)};
 }finally{await fh.close();}
}
async function hashFile(path){const h=createHash('sha256'),fh=await open(path,'r');try{const before=await fh.stat();for await(const chunk of fh.createReadStream({autoClose:false}))h.update(chunk);if(fingerprint(before)!==fingerprint(await fh.stat()))throw Error('引用文件在读取期间变化');return h.digest('hex');}finally{await fh.close();}}
async function dependencyFingerprint(root,dependencies,{verify=false}={}){
 const result=[];for(const dep of dependencies){let value;try{
  const path=await inside(root,dep.projectRelativePath);value=fingerprint(await stat(path));
  if(verify&&(await hashFile(path)!==dep.sha256||value!==fingerprint(await stat(path))))throw Error('准备期间引用文件发生变化，请刷新重试');
 }catch(e){if(verify)throw e;value='missing';}result.push([dep.projectRelativePath,value]);}
 return sha(Buffer.from(JSON.stringify(result.sort((a,b)=>a[0].localeCompare(b[0])))));
}

// Legacy 2.4 records included neighboring, unused textures. Only reported
// consumed images establish authoring dependencies; cache lookup is separate.
function effectiveSourceIdentity(source,previewSha){
 return sha(Buffer.from(JSON.stringify({format:source?.format||'glb',sourceSha:source?.sha256||previewSha,previewSha,fps:source?.fps||null,frameRange:source?.frameRange||null,dependencies:consumedDependencies(source).map(d=>[d.projectRelativePath,d.sha256]).sort((a,b)=>a[0].localeCompare(b[0]))})));
}

export async function openCatalogAsset(work,id,{refreshSource=false}={}){
 work=await realpath(work);const key=work+'|'+id+'|'+(refreshSource?'refresh':'restore');
 if(imports.has(key))return imports.get(key);
 const promise=prepareCatalogAsset(work,id,{refreshSource});imports.set(key,promise);
 try{return await promise;}finally{imports.delete(key);}
}
async function prepareCatalogAsset(work,id,{refreshSource}){
 const cfg=await readProject(work),existing=Object.hasOwn(cfg.models,id)?cfg.models[id]:null;
 if(existing&&modelSlots(cfg,id).baseline&&!refreshSource)return activateModel(work,id);
 const [catalog,link]=await Promise.all([readCatalog(work),getProjectLink(work)]);
 if(!link?.exists||link.id!==catalog.projectId)throw Error('关联的模型目录不可用，请重新关联');
 const entry=catalog.entries.find(e=>e.id===id);if(!entry)throw Error('模型不存在，请刷新目录');
 if(!['glb','gltf','fbx','json'].includes(entry.format))throw Error('此格式作为制作源保留，请导出 GLB、glTF 或带角色的 FBX');
 if(entry.status==='missing')throw Error('源文件已不存在；可继续查看之前导入的版本');
 const sourcePath=await inside(link.root,entry.relativePath),snapshot=await stableBytes(sourcePath),sourceSha=sha(snapshot.bytes);
 let bytes=snapshot.bytes,source={format:entry.format,sha256:sourceSha,originalName:entry.name,projectRelativePath:entry.relativePath,previewSha256:sourceSha};
 if(entry.format==='json'){
  if(snapshot.bytes.length>50*1024*1024)throw Error('采样动作 JSON 超过 50 MB');
  bytes=createCurveResource(snapshot.bytes);const file='sources/'+sourceSha+'.json';await atomic(await inside(work,file),snapshot.bytes);source={...source,format:'sampled-tracks-v1',file,previewSha256:sha(bytes)};
 }
 // The workspace keeps a self-contained GLB; every referenced file is a
 // hashed dependency, so a changed .bin or texture is a new source identity.
 if(entry.format==='gltf'){const packed=await packProjectGltf(link.root,entry.relativePath,snapshot.bytes);bytes=packed.bytes;source={...source,dependencies:packed.dependencies,dependencyKind:packed.dependencyKind,previewSha256:sha(bytes)};}
 if(entry.format==='fbx'){
  const dependencies=[],blender=await findBlender();
  const version=(await execExecutable(blender,['--version'],{timeout:15000,maxBuffer:65536})).stdout.split('\n')[0];
  const scriptSha=sha(await readFile(join(ROOT,'scripts/blender/convert_fbx.py'))),cacheKey=sha(Buffer.from(JSON.stringify({sourceSha,sourcePath:entry.relativePath,version,scriptSha,fps:'source'})));
  const out=await inside(work,'conversions/catalog-'+cacheKey),cache=await inside(work,'sources/fbx-cache-'+cacheKey+'.json');
  // Check and publish the cache under the conversion queue lock as well. Two
  // processes opening the same model must not convert it twice.
  const lockWork=await inside(work,'conversion-queue');await mkdir(lockWork,{recursive:true});
  await withWorkspaceLock(lockWork,async()=>{let cached;
  try{
   cached=await json(cache);const preview=await readFile(await inside(work,cached.file));
   if(sha(preview)!==cached.sha256)throw Error('转换缓存校验失败');
   for(const dep of cached.source.dependencies||[])if(await hashFile(await inside(link.root,dep.projectRelativePath))!==dep.sha256){cached=null;break;}
   if(cached){bytes=preview;source={...cached.source};}
  }catch(e){if(e.code!=='ENOENT')throw e;cached=null;}
  if(!cached){
   const file='sources/'+sourceSha+'.fbx';await atomic(await inside(work,file),snapshot.bytes);
   // A failed attempt keeps its own evidence without blocking a later retry.
   const result=await convertFbx(sourcePath,out+'-'+randomUUID(),{blenderPath:blender});
   if(result.source.sha256!==sourceSha)throw Error('转换期间模型或贴图发生变化，请刷新重试');
   for(const dep of result.report.externalImages||[]){
    const rel=slash(relative(link.root,dep.path)),path=await inside(link.root,rel);
    if(await hashFile(path)!==dep.sha256)throw Error('转换期间外部贴图发生变化，请重试');
    if(!dependencies.some(d=>d.projectRelativePath===rel))dependencies.push({projectRelativePath:rel,sha256:dep.sha256});
   }
   bytes=await readFile(result.glbPath);source={...result.source,...source,dependencies,dependencyKind:'consumed-images-v1',file,previewSha256:sha(bytes),conversionReport:result.report,cacheKey:sha(Buffer.from(JSON.stringify({cacheKey,dependencies})))};
   await atomic(cache,{file:slash(relative(work,result.glbPath)),sha256:sha(bytes),source});
  }
  },{timeoutMs:600000});
 }
 if(fingerprint(await stat(sourcePath))!==snapshot.fingerprint)throw Error('源文件在准备期间变化，请刷新重试');
 const dependencyStamp=source.dependencies?await dependencyFingerprint(link.root,source.dependencies,{verify:true}):null;
 await withWorkspaceLock(work,async()=>{
  const current=await readProject(work),model=current.models[id];
  if(refreshSource&&existing&&(model?.headRevision!==existing.headRevision||JSON.stringify(modelSlots(current,id))!==JSON.stringify(modelSlots(cfg,id))))throw Error('准备期间此模型的版本已变化，请重新打开');
  if(!refreshSource&&model?.slots?.baseline)return;
  if(fingerprint(await stat(sourcePath))!==snapshot.fingerprint)throw Error('源文件在准备期间变化，请刷新重试');
  if(source.dependencies&&await dependencyFingerprint(link.root,source.dependencies,{verify:true})!==dependencyStamp)throw Error('等待提交期间引用文件发生变化，请刷新重试');
  const heads=modelSlots(current,id),identity=effectiveSourceIdentity(source,sha(bytes));
  if(heads.baseline&&effectiveSourceIdentity(heads.baseline.source,heads.baseline.sha256)===identity){
   // Refresh metadata without changing authored versions, head revision or tasks.
   Object.assign(model,{sourceFingerprint:snapshot.fingerprint,sourceIdentity:identity,...(source.dependencies?{sourceDependencies:source.dependencies,dependencyFingerprint:dependencyStamp}:{})});
   for(const head of Object.values(heads))if(head.source?.sha256===source.sha256&&source.dependencies){head.source={...head.source,dependencies:source.dependencies,dependencyKind:source.dependencyKind||'consumed-images-v1'};}
   setModelSlots(current,id,heads);await atomic(await inside(work,'project.json'),current);return;
  }
  await importAsset(work,'baseline',bytes,entry.name,{locked:true,assetId:id,reset:true,activate:false,source,model:{name:entry.name,origin:'project',relativePath:entry.relativePath,projectId:link.id,sourceFingerprint:snapshot.fingerprint,sourceIdentity:identity,...(source.dependencies?{sourceDependencies:source.dependencies,dependencyFingerprint:dependencyStamp}:{})}});
 });
 return activateModel(work,id);
}
