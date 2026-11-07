import {readdir,stat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {atomic,inside,withWorkspaceLock} from './core.mjs';

const ID=/^[a-f0-9-]{36}$/;
export const activeJobStates=new Set(['queued','running','needs-input']);
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const states=new Set(['queued','running','needs-input','complete','failed','cancelled','stale','interrupted']);
function validEntry(id,entry){const j=entry?.summary;return ID.test(id)&&typeof entry.stamp==='string'&&j?.id===id&&typeof j.assetId==='string'&&states.has(j.state)&&j.summaryOnly===true&&typeof j.request==='string'&&j.request.length<=300&&typeof j.createdAt==='string'&&/^[a-f0-9]{64}$/.test(j.detailRevision||'')&&typeof j.executionManaged==='boolean';}
const asset=a=>a?{file:a.file,sha256:a.sha256,label:a.label}:null;
export function summarizeJob(j){
 const review=j.review||j.reviews?.at(-1);
 return {id:j.id,assetId:j.assetId||'legacy',state:j.state,executor:j.executor,delivery:j.delivery,caller:j.caller||null,provider:j.provider||null,executionHealth:j.executionHealth,executionManaged:Boolean(j.execution?.id),request:String(j.request||'').slice(0,300),clip:j.clip||j.context?.clip||'',slot:j.slot,createdAt:j.createdAt,updatedAt:j.updatedAt,claimedAt:j.claimedAt,lastActivityAt:j.lastActivityAt,progress:j.progress,activity:j.activity,artisticDecision:j.artisticDecision,parentJobId:j.parentJobId,candidate:asset(j.candidate),inputs:{baseline:asset(j.inputs?.baseline),candidate:asset(j.inputs?.candidate)},review:review?{id:review.id,decision:review.decision,at:review.at}:null,detailRevision:digest(j),summaryOnly:true};
}

// job.json remains authoritative. Checking every fingerprint makes this cache
// coherent with other server/CLI processes and direct atomic file replacement.
// The disk index is disposable: missing, corrupt or old versions rebuild safely.
export async function readJobIndex(work){return withWorkspaceLock(work,async()=>{
 const file=await inside(work,'job-index.json');let previous;
 try{previous=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
 if(previous?.version!==7||!previous.entries||typeof previous.entries!=='object'||Array.isArray(previous.entries)||previous.integrity!==digest(previous.entries)||!Object.entries(previous.entries).every(([id,entry])=>validEntry(id,entry)))previous={entries:{}};
 const dir=await inside(work,'jobs');let names=[];
 try{names=(await readdir(dir,{withFileTypes:true})).filter(x=>x.isDirectory()&&ID.test(x.name)).map(x=>x.name).sort();}catch(e){if(e.code!=='ENOENT')throw e;}
 const entries={};let changed=names.length!==Object.keys(previous.entries).length;
 // Bound filesystem concurrency for large histories.
 for(let offset=0;offset<names.length;offset+=32)await Promise.all(names.slice(offset,offset+32).map(async id=>{
  const path=await inside(work,'jobs/'+id+'/job.json');
  try{
   let current=stamp(await stat(path)),entry=previous.entries[id];
   if(entry?.stamp!==current||!entry.summary?.detailRevision){
    let j;for(let attempt=0;attempt<3;attempt++){j=JSON.parse(await readFile(path,'utf8'));const after=stamp(await stat(path));if(after===current)break;current=after;if(attempt===2)throw Error('任务正在更新，请稍后重试');}
    if(j.id!==id)throw Error('任务记录身份不一致：'+id);
    entry={stamp:current,summary:summarizeJob(j)};if(!validEntry(id,entry))throw Error('任务摘要格式无效：'+id);changed=true;
   }
   entries[id]=entry;
  }catch(e){if(e.code==='ENOENT'){changed=true;return;}throw e;}
 }));
 const rows=Object.values(entries).map(e=>e.summary).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')||b.id.localeCompare(a.id));
 const revision=digest(rows.map(j=>[j.id,j.detailRevision]));
 if(changed||previous.revision!==revision)await atomic(file,{version:7,revision,entries,integrity:digest(entries)});
 const counts={};for(const j of rows){const c=counts[j.assetId]??={total:0,active:0,queued:0,running:0,needsInput:0};c.total++;if(activeJobStates.has(j.state))c.active++;if(j.state==='queued')c.queued++;if(j.state==='running')c.running++;if(j.state==='needs-input')c.needsInput++;}
 return {revision,rows,counts,total:rows.length};
});}
export async function listQueuedJobSummaries(work){return (await readJobIndex(work)).rows.filter(j=>j.state==='queued'&&j.executor!=='local'&&j.delivery!=='chat').reverse();}
export async function jobsPage(work,{assetId,offset=0,limit=30}={},{index:providedIndex}={}){
 const index=providedIndex||await readJobIndex(work),rows=assetId?index.rows.filter(j=>j.assetId===assetId):index.rows;
 offset=Number.isFinite(Number(offset))?Math.max(0,Math.floor(Number(offset))):0;limit=Number.isFinite(Number(limit))?Math.max(1,Math.min(100,Math.floor(Number(limit)))):30;
 return {jobs:rows.slice(offset,offset+limit),total:rows.length,offset,limit,hasMore:offset+limit<rows.length,revision:index.revision};
}
