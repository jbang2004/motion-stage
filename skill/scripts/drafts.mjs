import {inside,readProject,readWorkspaceJSON,atomic,withWorkspaceLock} from './core.mjs';
import {validateFeedbackPoints} from '../assets/viewer/feedback-points.mjs';

async function pathFor(work,assetId){
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(assetId||'')||!(await readProject(work)).models[assetId])throw Error('草稿模型不存在');
 return inside(work,`drafts/${assetId}.json`);
}
export async function readDraft(work,assetId){return withWorkspaceLock(work,async()=>{
 await pathFor(work,assetId);
 try{return await readWorkspaceJSON(work,`drafts/${assetId}.json`);}catch(e){if(e.code!=='ENOENT')throw e;return {version:1,assetId,revision:0,draft:null};}
});}
export async function saveDraft(work,assetId,{expectedRevision,draft}={}){return withWorkspaceLock(work,async()=>{
 const path=await pathFor(work,assetId),current=await readDraft(work,assetId);
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('缺少草稿修订号');
 if(current.revision!==expectedRevision)return {conflict:true,current};
 if(!draft||typeof draft!=='object'||Array.isArray(draft)||draft.assetId!==assetId||draft.context?.assetId!==assetId)throw Error('草稿身份不一致');
 if(Buffer.byteLength(JSON.stringify(draft))>128*1024)throw Error('草稿超过 128 KB');
 if(typeof draft.request!=='string'||typeof draft.preserve!=='string'||draft.request.length>12000||draft.preserve.length>12000)throw Error('草稿文字无效或过长');
 if(draft.feedbackPoints!==undefined)draft={...draft,feedbackPoints:validateFeedbackPoints(draft.feedbackPoints)};
 const record={version:1,assetId,revision:current.revision+1,updatedAt:new Date().toISOString(),draft};
 await atomic(path,record);return record;
});}
