import {readFile,stat,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {inside,atomic,sha,readProject,modelSlots,withWorkspaceLock} from './core.mjs';
import {getProjectLink} from './project-context.mjs';
import {characterProfileDigest} from './source-dependencies.mjs';
const CONFIG='appearance.json',MAX=24*1024*1024;
const check=(ok,message)=>{if(!ok)throw Error(message);};
function relative(value){check(typeof value==='string'&&value.length>0&&value.length<=1000,'外观包需要相对路径');const path=value.replaceAll('\\','/');check(!/[\x00-\x1f\x7f?#%:]/.test(path)&&!path.startsWith('/')&&!path.split('/').some(n=>!n||n==='..'||n==='.'),'外观包需要规范的相对路径');return path;}
function normalize(input){
 check(input?.version===1&&typeof input.label==='string'&&input.label.length<=120,'外观包需要 version:1 和名称');
 check(/^\d{1,4}$/.test(input.threeRevision),'请声明适配的 Three.js revision');
 const entry=relative(input.entry);check(/\.(mjs|js)$/.test(entry),'适配入口需要 JavaScript 模块');
 check(Array.isArray(input.files)&&input.files.length>0&&input.files.length<=80,'外观包最多 80 个文件');
 const names=new Set(),files=input.files.map(f=>{const path=relative(typeof f==='string'?f:f.path);check(/\.(mjs|js|json)$/.test(path)&&!names.has(path)&&path!=='manifest.json','外观文件格式不支持或路径重复');names.add(path);return {path,...(f.sha256?{sha256:f.sha256}:{})};});check(names.has(entry),'入口未包含在 files 中');
 check(input.profiles&&typeof input.profiles==='object'&&!Array.isArray(input.profiles)&&Object.keys(input.profiles).length<=500,'请声明适用的角色或主模型相对路径');
 const profiles=JSON.parse(JSON.stringify(input.profiles));check(Buffer.byteLength(JSON.stringify(profiles))<=256*1024,'外观参数过大');
 check(!input.evidence||Array.isArray(input.evidence)&&input.evidence.length<=40,'来源依据最多 40 项');
 check(!input.limitations||Array.isArray(input.limitations)&&input.limitations.length<=20&&input.limitations.every(s=>typeof s==='string'&&s.length<=500),'外观限制说明无效');
 return {version:1,label:input.label,threeRevision:String(input.threeRevision),entry,files,profiles,evidence:(input.evidence||[]).map(e=>({file:relative(e.file),...(e.sha256?{sha256:e.sha256}:{})})),limitations:input.limitations||[]};
}
async function bounded(root,path,max=MAX){const full=await inside(root,path),s=await stat(full);check(s.isFile()&&s.size<=max,'外观文件不存在或超过读取预算：'+path);const bytes=await readFile(full);check(bytes.length<=max,'外观文件超过读取预算');return bytes;}
// Registration copies reviewed code; scanning never imports or executes project modules.
export async function installAppearance(work,manifestPath){
 const raw=await readFile(manifestPath);check(raw.length<=1024*1024,'外观声明超过 1 MiB');const config=normalize(JSON.parse(raw)),link=await getProjectLink(work);check(link?.exists,'请先关联项目');
 const buffers=new Map();let total=0;
 for(const file of config.files){const bytes=await bounded(dirname(manifestPath),file.path,8*1024*1024);total+=bytes.length;check(total<=MAX,'外观包超过 24 MiB');const digest=sha(bytes);if(file.sha256)check(digest===file.sha256,'外观文件校验失败：'+file.path);file.sha256=digest;buffers.set(file.path,bytes);}
 for(const e of config.evidence){const digest=sha(await bounded(link.root,e.file,4*1024*1024));if(e.sha256)check(e.sha256===digest,'项目外观依据已变化：'+e.file);e.sha256=digest;}
 config.projectId=link.id;config.bundle=characterProfileDigest(config);
 await withWorkspaceLock(work,async()=>{
  check((await getProjectLink(work))?.id===link.id,'项目关联已变化');
  const dir=await inside(work,'appearance/'+config.bundle);await mkdir(dir,{recursive:true});
  for(const [path,bytes]of buffers)await atomic(await inside(dir,path),bytes);
  await atomic(await inside(dir,'manifest.json'),config);await atomic(await inside(work,CONFIG),config);
 });return {bundle:config.bundle,label:config.label,files:config.files.length};
}
export async function appearanceStatus(work,assetId){
 try{
  const config=JSON.parse(await bounded(work,CONFIG,1024*1024)),normalized=normalize(config);
  check(config.bundle===characterProfileDigest({...normalized,projectId:config.projectId}),'外观声明校验失败，请重新安装已审阅的适配包');
  const [cfg,link]=await Promise.all([readProject(work),getProjectLink(work)]);check(link?.exists&&link.id===config.projectId,'外观包所属项目不可用');
  const source=modelSlots(cfg,assetId||cfg.activeAssetId).baseline?.source,key=source?.assembly?.profileId||source?.projectRelativePath;
  const profile=Object.hasOwn(config.profiles,key)?config.profiles[key]:Object.hasOwn(config.profiles,source?.projectRelativePath)?config.profiles[source.projectRelativePath]:null;check(profile&&typeof profile==='object'&&!Array.isArray(profile),'此角色尚未配置项目外观');
  for(const file of config.files)check(sha(await bounded(work,'appearance/'+config.bundle+'/'+file.path,8*1024*1024))===file.sha256,'外观文件已变化：'+file.path);
  for(const e of config.evidence)check(sha(await bounded(link.root,e.file,4*1024*1024))===e.sha256,'项目外观依据已变化，请审阅后更新适配包：'+e.file);
  return {status:'ready',label:config.label,bundle:config.bundle,threeRevision:config.threeRevision,module:'/appearance/'+config.bundle+'/'+config.entry,profile,limitations:config.limitations,evidence:config.evidence};
 }catch(error){return {status:'unavailable',message:error.code==='ENOENT'?'此项目尚未安装外观适配包':error.message};}
}
export async function appearanceFile(work,bundle,path){
 check(/^[a-f0-9]{64}$/.test(bundle),'外观包 ID 无效');path=relative(path);
 const dir='appearance/'+bundle,config=JSON.parse(await bounded(work,dir+'/manifest.json',1024*1024));
 const normalized=normalize(config);check(config.bundle===bundle&&bundle===characterProfileDigest({...normalized,projectId:config.projectId}),'外观包清单无效');
 const item=config.files.find(f=>f.path===path);check(item,'外观文件未登记');const bytes=await bounded(work,dir+'/'+path,8*1024*1024);check(sha(bytes)===item.sha256,'外观文件校验失败');return bytes;
}
