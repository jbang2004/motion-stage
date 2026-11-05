import {readFile,writeFile,mkdir,rename,realpath,lstat,rm} from 'node:fs/promises';
import {resolve,relative,dirname,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {resourceCapabilities,curveClips} from '../assets/viewer/resource-capabilities.mjs';
import {pathWithin} from './platform-runtime.mjs';
import {atomic,withWorkspaceLock,readWorkspaceJSON} from './workspace-store.mjs';
export {atomic,withWorkspaceLock,readWorkspaceJSON,commitWorkspace,recoverWorkspace} from './workspace-store.mjs';

export const ROOT=resolve(import.meta.dirname,'..');
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const json=async p=>JSON.parse(await readFile(p,'utf8'));
export const VERSION=(await json(resolve(ROOT,'package.json'))).version;
// slots remains the active-view projection for older clients. Model heads are
// independent of that projection, so browsing never changes another task's input.
export function normalizeProject(cfg){
 if(!cfg.models){
  cfg.models={};cfg.legacyAssetId='legacy';
  if(cfg.slots?.baseline||cfg.slots?.candidate){cfg.activeAssetId='legacy';cfg.models.legacy={id:'legacy',name:cfg.slots.baseline?.label||'已有素材',origin:'import',slots:structuredClone(cfg.slots)};}
 }
 cfg.slots??={};cfg.version=3;return cfg;
}
export const readProject=async work=>normalizeProject(await readWorkspaceJSON(work,'project.json'));
export function modelSlots(cfg,id=cfg.activeAssetId){
 if(!id)return cfg.slots||{};
 if(!Object.hasOwn(cfg.models||{},id))return {};
 return id===cfg.activeAssetId?cfg.slots:cfg.models[id].slots||{};
}
export function projectView(cfg,id=cfg.activeAssetId){if(id&&!Object.hasOwn(cfg.models,id))throw Error('模型不存在');return {version:3,title:cfg.models[id]?.name||cfg.title,fps:cfg.fps,revision:cfg.revision||0,activeAssetId:id||null,legacyAssetId:cfg.legacyAssetId||null,slots:modelSlots(cfg,id)};}
export function setModelSlots(cfg,id,slots,{activate=false}={}){
 if(!Object.hasOwn(cfg.models,id))throw Error('模型不存在');
 if(cfg.activeAssetId&&cfg.models[cfg.activeAssetId])cfg.models[cfg.activeAssetId].slots=structuredClone(cfg.slots);
 cfg.models[id].slots=structuredClone(slots);cfg.models[id].updatedAt=new Date().toISOString();
 if(activate||cfg.activeAssetId===id){cfg.activeAssetId=id;cfg.slots=structuredClone(slots);}
 cfg.revision=(cfg.revision||0)+1;
}
export async function activateModel(work,id){return withWorkspaceLock(work,async()=>{
 const cfg=await readProject(work);if(!Object.hasOwn(cfg.models,id)||!modelSlots(cfg,id).baseline)throw Error('模型尚未准备好');
 setModelSlots(cfg,id,modelSlots(cfg,id),{activate:true});await atomic(await inside(work,'project.json'),cfg);return projectView(cfg);
});}
export const hasClip=(asset,name,time=0)=>asset?.clips?.length?asset.clips.some(c=>c.name===name&&Number.isFinite(time)&&time>=0&&time<=c.duration+.001):(name===null||name===''||name==='静态姿态')&&Number.isFinite(time)&&time>=0&&time<=.001;
export async function inside(root,name){
 const base=await realpath(root),path=resolve(base,name),rel=relative(base,path);
 if(!pathWithin(base,path))throw Error('Path outside workspace');
 let p=path;for(;;){try{const r=await realpath(p);if(!pathWithin(base,r))throw Error('Symlink outside workspace');break;}catch(e){if(e.code!=='ENOENT')throw e;}if(p===base)break;p=dirname(p);}
 return path;
}
export function glbInfo(bytes){
 if(bytes.length<20||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw Error('需要有效的 glTF 2.0 .glb 文件');
 const n=bytes.readUInt32LE(12);if(bytes.readUInt32LE(16)!==0x4e4f534a||20+n>bytes.length)throw Error('GLB JSON chunk 无效');
 const d=JSON.parse(bytes.subarray(20,20+n).toString());
 for(const a of [...(d.buffers||[]),...(d.images||[])])if(a.uri&&!a.uri.startsWith('data:'))throw Error('请导出自包含 GLB，贴图和 buffer 必须嵌入文件');
 return {...glbDocumentInfo(d),sha256:sha(bytes),bytes:bytes.length};
}
export function glbDocumentInfo(d){
 if(d.asset?.version!=='2.0')throw Error('需要 glTF 2.0 模型');
 for(const a of [...(d.buffers||[]),...(d.images||[])])if(a.uri&&!a.uri.startsWith('data:'))throw Error('请导出自包含 GLB，贴图和 buffer 必须嵌入文件');
 const supported=new Set(['KHR_materials_unlit','KHR_materials_clearcoat','KHR_materials_transmission','KHR_materials_volume','KHR_materials_ior','KHR_materials_specular','KHR_materials_sheen','KHR_materials_iridescence','KHR_materials_anisotropy','KHR_materials_emissive_strength','KHR_materials_dispersion','KHR_texture_transform','KHR_mesh_quantization','EXT_meshopt_compression','KHR_meshopt_compression','KHR_draco_mesh_compression','KHR_texture_basisu','EXT_texture_webp','EXT_texture_avif','EXT_mesh_gpu_instancing']);
 const unknown=(d.extensionsRequired||[]).filter(x=>!supported.has(x));if(unknown.length)throw Error('未支持的必需扩展：'+unknown.join(', '));
 const capabilities=resourceCapabilities(d);
 const clips=curveClips(d)||(d.animations||[]).map((a,i)=>{if(!a.samplers?.length||a.samplers.some(s=>!d.accessors?.[s.input]?.max?.length))throw Error('动作缺少有效时间范围，请重新导出带 accessor min/max 的 GLB');return {name:a.name||'animation_'+i,index:i,duration:Math.max(...a.samplers.flatMap(s=>d.accessors[s.input].max))};});
 if(new Set(clips.map(x=>x.name)).size!==clips.length)throw Error('动作名称重复，请在导出前改成唯一名称');
 if(clips.some(c=>!Number.isFinite(c.duration)||c.duration<0))throw Error('动作缺少有效时间范围，请重新导出带 accessor min/max 的 GLB');
 return {clips,static:!clips.length,extensions:d.extensionsUsed||[],generator:d.asset?.generator||null,meshCount:d.meshes?.length||0,skinCount:d.skins?.length||0,kind:capabilities.kind,capabilities};
}
export function validateNote(n){
 if(!n||typeof n!=='object'||!/^[-a-zA-Z0-9_]{1,80}$/.test(n.id||''))throw Error('无效反馈 ID');
 for(const k of ['observed','expected','acceptance'])if(typeof n[k]!=='string'||!n[k].trim()||n[k].length>8000)throw Error('请填写 '+k+'（最多 8000 字符）');
 for(const k of ['reference','preserve','hypothesis'])if(n[k]!==undefined&&(typeof n[k]!=='string'||n[k].length>8000))throw Error('无效字段 '+k);
 if(!['baseline','candidate'].includes(n.slot))throw Error('无效版本槽');
 if(!Number.isFinite(n.time)||n.time<0||!Number.isFinite(n.fps)||n.fps<1||n.fps>240)throw Error('无效时间或帧率');
 if(n.frame!==Math.round(n.time*n.fps))throw Error('帧号与时间不匹配');
 if(!n.asset||!/^[a-f0-9]{64}$/.test(n.asset.sha256)||(typeof n.clip!=='string'&&n.clip!==null))throw Error('缺少资产或动作身份');
 if(!['open','resolved'].includes(n.status))throw Error('无效状态');
 if(!['front','side','back','top','orbit'].includes(n.view))throw Error('无效视角');
 if(n.camera){for(const k of ['position','target'])if(!Array.isArray(n.camera[k])||n.camera[k].length!==3||!n.camera[k].every(Number.isFinite))throw Error('无效镜头');}
 if(n.status==='resolved'&&(!['keep-baseline','accept-candidate'].includes(n.decision)||!n.outcome?.trim()))throw Error('关闭反馈需要决定和验收说明');
 if(n.status==='open'&&n.decision&&!['revise'].includes(n.decision))throw Error('未关闭反馈只能标记继续修改');
 return n;
}
export async function importAsset(work,slot,bytes,label,options={}){
 if(!options.locked)return withWorkspaceLock(work,()=>importAsset(work,slot,bytes,label,{...options,locked:true}));
 if(!['baseline','candidate'].includes(slot))throw Error('slot 必须是 baseline 或 candidate');
 if(options.newModel&&slot!=='baseline')throw Error('新模型请先导入原版 baseline');
 const prepared=await stageAsset(work,slot,bytes,label,options);await atomic(await inside(work,'project.json'),prepared.project);return prepared.asset;
}
export async function stageAsset(work,slot,bytes,label,options={}){
 const {validateCandidate}=await import('./candidate-validation.mjs');validateCandidate(bytes);
 const info=glbInfo(bytes),file='assets/'+info.sha256+'.glb';await atomic(await inside(work,file),bytes);
 const cfg=options.project?normalizeProject(structuredClone(options.project)):await readProject(work),id=options.newModel?randomUUID():options.assetId||cfg.activeAssetId||'legacy';
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||['__proto__','prototype','constructor'].includes(id))throw Error('无效模型 ID');
 if(!Object.hasOwn(cfg.models,id))cfg.models[id]={id,name:String(label||'角色').slice(0,160),origin:'import',slots:{},createdAt:new Date().toISOString()};
 const model=cfg.models[id],heads=structuredClone(modelSlots(cfg,id));
 if(options.reset&&heads.baseline)(model.revisions??=[]).push({slots:structuredClone(heads),at:new Date().toISOString()});
 Object.assign(model,options.model||{});
 if(slot==='baseline'&&!options.model?.name)model.name=String(label||'角色').slice(0,160);
 model.headRevision=(model.headRevision||0)+1;
 heads[slot]={...info,file,label:String(label||slot).slice(0,160),assetId:id,...(options.source?{source:options.source}:{})};
 if(slot==='baseline'&&(options.reset||!heads.candidate||(heads.candidate.generator?.includes('original teaching rig')&&!info.generator?.includes('original teaching rig'))))heads.candidate={...heads.baseline,label:String(label||'原版').slice(0,140)+' · 尚未修改'};
 setModelSlots(cfg,id,heads,{activate:options.activate!==false});
 return {project:cfg,asset:heads[slot]};
}
export async function readMarks(work){try{return await json(await inside(work,'marks.json'));}catch(e){if(e.code==='ENOENT')return{version:1,reviews:{}};throw e;}}
export async function validateFeedback(work){
 const d=await json(await inside(work,'feedback.json'));if(d.version!==1||!Array.isArray(d.notes))throw Error('反馈格式不正确');
 const checked=new Map();async function checkAsset(a){if(!a||!/^[a-f0-9]{64}$/.test(a.sha256||'')||typeof a.file!=='string')throw Error('版本记录无效');const key=a.sha256+'|'+a.file;if(!checked.has(key)){const bytes=await readFile(await inside(work,a.file));if(sha(bytes)!==a.sha256)throw Error('记录的资产已变化');checked.set(key,glbInfo(bytes));}return checked.get(key);}
 const ids=new Set();for(const n of d.notes){validateNote(n);if(ids.has(n.id))throw Error('重复反馈 ID');ids.add(n.id);
  if(!hasClip(await checkAsset(n.asset),n.clip,n.time))throw Error('反馈时间不属于记录动作：'+n.id);
  if(n.comparison){const ctx=n.comparison;if(!['elapsed','progress'].includes(ctx.mode)||typeof ctx.normalized!=='boolean'||!Number.isFinite(ctx.time)||ctx.time<0)throw Error('对比上下文无效');for(const slot of ['baseline','candidate']){const a=ctx.slots?.[slot],info=await checkAsset(a);if(!hasClip(info,a.clip,a.time))throw Error('对比时刻无效');}}
  for(const r of n.reviews||[])for(const a of Object.values(r.assets||{}))await checkAsset(a);
  if(n.snapshot){const p=await inside(work,n.snapshot);if(!(await lstat(p)).isFile())throw Error('缺少截图');}
 }
 const marks=await readMarks(work);if(marks.version!==1||!marks.reviews||Array.isArray(marks.reviews)||typeof marks.reviews!=='object')throw Error('动作标记格式无效');
 for(const r of Object.values(marks.reviews)){const a=await checkAsset(r.asset);if(!hasClip(a,r.clip)||!['all','comparison'].includes(r.displayMode)||!['','fix','review','want'].includes(r.verdict)||!['','candidate','original'].includes(r.choice)||typeof r.note!=='string')throw Error('动作标记记录无效');if(r.reference){const b=await checkAsset(r.reference);if(!hasClip(b,r.reference.clip))throw Error('标记对照动作不存在');}for(const h of r.history||[]){for(const item of Object.values(h.context?.slots||{}))await checkAsset(item);}}
 return d;
}
