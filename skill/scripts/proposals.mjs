// Requests an agent drafts from its chat, for the user to confirm in the page. MotionStage never starts a task by itself: a
// draft only fills the composer (its words, the clip, the version to start from, the task it continues), and the user
// submits it there, which freezes the view as any task does. Drafts live in proposals.json (one file, so the studio's
// workspace watcher sees it change); a draft is dropped when the user opens or dismisses it.
import {randomUUID} from 'node:crypto';
import {inside,readProject,readWorkspaceJSON,atomic,withWorkspaceLock} from './core.mjs';
import {normalizeCaller} from '../assets/viewer/caller.mjs';

const FILE='proposals.json',MAX=20,ID=/^[a-f0-9-]{36}$/;
async function read(work){
 try{const v=await readWorkspaceJSON(work,FILE);return Array.isArray(v?.proposals)?v:{version:1,proposals:[]};}
 catch(e){if(e.code!=='ENOENT')throw e;return {version:1,proposals:[]};}
}
const write=async(work,proposals)=>atomic(await inside(work,FILE),{version:1,proposals});
const clipsOf=model=>new Set(['baseline','candidate'].flatMap(s=>(model?.slots?.[s]?.clips||[]).map(c=>c.name)));

export async function proposeTask(work,{assetId,clip,request,preserve='',source=null,parentJobId=null,caller=null}={}){return withWorkspaceLock(work,async()=>{
 const cfg=await readProject(work),model=cfg.models?.[assetId];
 if(!model)throw Error('模型不存在：'+assetId);
 const names=clipsOf(model);if(!clip||names.size&&!names.has(clip))throw Error('这个模型没有动作：'+clip);
 request=String(request||'').trim();if(!request)throw Error('需要 --request：用户在对话里提出的修改，用原话');
 if(request.length>12000||String(preserve).length>12000)throw Error('文字过长');
 if(source!==null&&!['baseline','candidate'].includes(source))throw Error('--source 只能是 baseline 或 candidate');
 if(source==='candidate'&&!model.slots?.candidate)throw Error('这个模型没有修改后的版本');
 if(parentJobId!==null){
  if(!ID.test(parentJobId))throw Error('无效的父任务标识');
  const parent=await readWorkspaceJSON(work,'jobs/'+parentJobId+'/job.json').catch(()=>null);
  if(!parent||(parent.assetId||'legacy')!==assetId)throw Error('父任务不属于这个模型：'+parentJobId);
 }
 const row={id:randomUUID(),assetId,clip,request,preserve:String(preserve),source,parentJobId,caller:caller?normalizeCaller(caller):null,createdAt:new Date().toISOString()};
 const {proposals}=await read(work);
 await write(work,[...proposals.filter(p=>!(p.assetId===assetId&&p.clip===clip)),row].slice(-MAX));   // (one draft a clip: the newest)
 return row;
});}
export async function listProposals(work,assetId){return withWorkspaceLock(work,async()=>{
 const {proposals}=await read(work);return assetId?proposals.filter(p=>p.assetId===assetId):proposals;
});}
export async function dropProposal(work,id){return withWorkspaceLock(work,async()=>{
 if(!ID.test(id||''))throw Error('无效的草稿标识');
 const {proposals}=await read(work),rest=proposals.filter(p=>p.id!==id);
 if(rest.length!==proposals.length)await write(work,rest);
 return {dropped:rest.length!==proposals.length};
});}
