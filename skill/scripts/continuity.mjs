import {readFile,readdir,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';

// This is a projection of recorded facts, never a history writer or a language
// model. In particular, a completed instruction is NOT a new edit instruction.
const SHA=/^[a-f0-9]{64}$/;
const DECISIONS=new Set(['accept-candidate','keep-baseline','revise']);
const userDecision=r=>DECISIONS.has(r?.decision)&&r.actor!=='agent'&&r.automatic!==true&&r.automaticArtisticApproval!==true;
const MAX_ANCESTRY=32;
const str=x=>typeof x==='string'?x:'';
const hash=x=>SHA.test(typeof x==='string'?x:x?.sha256||'')?(typeof x==='string'?x:x.sha256):null;
const clone=x=>x===undefined?null:structuredClone(x);
const clipOf=j=>{const c=j.clip??j.context?.clip??'';return c===null||c==='静态姿态'?'':str(c);};
const slotOf=j=>j.slot||j.context?.slot||'baseline';
const sourceOf=j=>hash(j.inputs?.[slotOf(j)]||j.context?.asset||j.asset);
const candidateOf=j=>hash(j.candidate);
const stamp=x=>Number.isFinite(Date.parse(x))?Date.parse(x):null;
const timeOf=j=>stamp(j.finishedAt)||stamp(j.createdAt)||0;
const clarifications=j=>(Array.isArray(j.clarifications)?j.clarifications:[]).map(c=>typeof c==='string'?{message:c}:{message:str(c.message),...(c.at?{at:c.at}:{})}).filter(c=>c.message);
const scopeOf=j=>clone(j.scope||{clip:clipOf(j),...(Number.isFinite(j.time)?{time:j.time,wholeClip:false}:{})});
const fingerprint=j=>JSON.stringify([sourceOf(j),clipOf(j),j.parentJobId||null,str(j.request),str(j.preserve),clarifications(j).map(c=>c.message),j.scope||null,j.target||null]);

/** Read-only metadata projection, portable across workspace moves. GLB byte
 * integrity remains the job/asset validator's responsibility. No stored absolute
 * authoring path is followed, and no AI summary is promoted into a requirement. */
export async function buildContinuity(work,job){
 const base=await realpath(resolve(work)),warnings=[],ambiguities=[];
 const warn=message=>{if(!warnings.includes(message))warnings.push(message);};
 async function read(name,{optional=false}={}){
  try{
   const file=await realpath(resolve(base,name)),rel=relative(base,file);
   if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('outside workspace');
   return JSON.parse(await readFile(file,'utf8'));
  }catch(e){if(e.code==='ENOENT'&&optional)return null;warn('无法读取历史记录 '+name+'；该记录未被当作连续修改依据。');return null;}
 }
 const sourceSha256=sourceOf(job),clip=clipOf(job);
 if(!sourceSha256)throw Error('连续修改需要选定输入的有效 SHA-256。');
 let entries=[];
 try{entries=await readdir(resolve(base,'jobs'),{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')warn('无法读取任务历史目录。');}
 const rows=[];
 for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isDirectory())continue;
  const row=await read('jobs/'+entry.name+'/job.json',{optional:true});
  if(!row)continue;
  if(!row.id||row.id!==entry.name||typeof row.id!=='string'){warn('忽略任务身份不匹配的记录 jobs/'+entry.name+'/job.json。');continue;}
  // Equal bytes in two catalog entries do not establish common authorship.
  // Unscoped historic jobs belong to the original, migrated model only.
  if(job.assetId&&((row.assetId||'legacy')!==job.assetId))continue;
  if(row.id!==job.id)rows.push(row);
 }
 const feedback=await read('feedback.json',{optional:true}),marks=await read('marks.json',{optional:true});
 const byId=new Map(rows.map(j=>[j.id,j]));
 const completed=rows.filter(j=>j.state==='complete'&&sourceOf(j)&&candidateOf(j)&&sourceOf(j)!==candidateOf(j));
 const owners=new Map(),edges=new Map();
 function link(a,b){if(!edges.has(a))edges.set(a,new Set());edges.get(a).add(b);}
 for(const row of completed){
  const a=sourceOf(row),b=candidateOf(row);link(a,b);link(b,a);
  if(!owners.has(b))owners.set(b,[]);owners.get(b).push(row);
 }
 // A legacy *version-bound user decision* supplies a family association, but
 // cannot invent a producing job or parent. A comparison or preference alone
 // does not: two unrelated characters can occupy the two preview slots.
 for(const n of Array.isArray(feedback?.notes)?feedback.notes:[]){
  if(!n||typeof n!=='object')continue;
  if(job.assetId&&(n.assetId||'legacy')!==job.assetId)continue;
  if(clipOf(n)!==clip)continue;
  const rs=Array.isArray(n.reviews)&&n.reviews.length?n.reviews:n.decision&&n.reviewedAssets?[{decision:n.decision,assets:n.reviewedAssets}]:[];
  for(const r of rs){const a=hash(r?.assets?.baseline),b=hash(r?.assets?.candidate);if(userDecision(r)&&a&&b&&(hash(n.asset)===a||hash(n.asset)===b)){link(a,b);link(b,a);}}
 }
 const family=new Set([sourceSha256]),pending=[sourceSha256];
 while(pending.length)for(const next of edges.get(pending.pop())||[])if(!family.has(next)){family.add(next);pending.push(next);}

 // Asset ancestry may bridge another clip, but its instructions never leak into
 // this clip's requirements. Merely occupying the other comparison slot is not
 // a provenance edge and never joins two characters into one family.
 const nearest=[],visited=new Set([job.id].filter(Boolean));let child=job,sha=sourceSha256,parentJobId=null,completeLineage=true,parentSelection='new-branch';
 for(;;){
  const childTime=stamp(child.createdAt);
  const eligible=row=>row.id!==child.id&&(!childTime||!timeOf(row)||timeOf(row)<=childTime);
  let matches=(owners.get(sha)||[]).filter(eligible),parent;
  const explicit=typeof child.parentJobId==='string'&&child.parentJobId?child.parentJobId:null;
  if(explicit){
   const wanted=byId.get(explicit);
   if(wanted&&matches.some(r=>r.id===wanted.id))parent=wanted;
   else warn('任务 '+(child.id||'当前任务')+' 的 parentJobId 没有匹配选定输入版本，未盲目继承它。');
  }
  if(!parent&&matches.length===1)parent=matches[0];
  if(!parent&&matches.length>1){
   if(new Set(matches.map(fingerprint)).size===1){
    parent=matches.sort((a,b)=>timeOf(b)-timeOf(a)||b.id.localeCompare(a.id))[0];
    warn('源版本 '+sha+' 有重复的等价产出记录；沿用有相同用户要求和父链证据的最近记录。');
   }else{
    ambiguities.push({kind:'multiple-candidate-owners',sha256:sha,jobIds:matches.map(j=>j.id).sort()});
    warn('源版本 '+sha+' 对应多条不同修改链；需要确认父任务，未合并这些要求。');
    completeLineage=false;if(!nearest.length)parentSelection='ambiguous';break;
   }
  }
  if(!parent)break;
  if(visited.has(parent.id)){warn('检测到候选父链循环，已停止追溯；没有重复合并要求。');completeLineage=false;break;}
  if(!nearest.length){parentJobId=parent.id;parentSelection=explicit===parent.id?'explicit':'source-sha256';}
  visited.add(parent.id);nearest.push(parent);child=parent;sha=sourceOf(parent);
 }
 const fullChain=nearest.reverse(),related=rows.filter(j=>clipOf(j)===clip&&family.has(sourceOf(j)));
 const relevantChain=fullChain.filter(j=>clipOf(j)===clip);
 const lineageShas=new Set([sourceSha256,...fullChain.flatMap(j=>[sourceOf(j),candidateOf(j)])]);
 const ancestorIds=new Set(relevantChain.map(j=>j.id));
 const inheritedRequirements=[],historicalInstructions=[];
 for(const row of relevantChain){
  if(str(row.preserve).trim())inheritedRequirements.push({id:'job:'+row.id+':preserve',text:row.preserve,sourceJobId:row.id,kind:'preserve',scope:scopeOf(row),status:'inherited-unless-current-user-overrides'});
  if(str(row.request).trim())historicalInstructions.push({id:'job:'+row.id+':request',text:row.request,sourceJobId:row.id,kind:'request',scope:scopeOf(row),role:'completed-goal-background; inspect preservation clauses, do not repeat the old goal'});
  clarifications(row).forEach((c,index)=>historicalInstructions.push({id:'job:'+row.id+':clarification:'+index,text:c.message,sourceJobId:row.id,kind:'clarification',scope:scopeOf(row),role:'historical-user-clarification; current explicit user instruction takes precedence'}));
 }

 const reviews=[];
 function addReview(row,r,index,{legacy=false,referenceId=null}={}){
  if(!DECISIONS.has(r?.decision))return;
  if(!userDecision(r)){warn('记录 '+(referenceId||row.id)+' 的自动评审未被当作用户验收或拒绝。');return;}
  const candidateSha=hash(r.assets?.candidate),sourceSha=sourceOf(row),baselineSha=hash(r.assets?.baseline);
  if(!candidateSha){warn('历史决定 '+(referenceId||row.id)+' 缺少当时的候选身份；保留原话但不建立已验收版本。');return;}
  if(!legacy&&candidateSha!==candidateOf(row)){warn('任务 '+row.id+' 的决定与候选身份不一致，未当作验收事实。');return;}
  if(!family.has(candidateSha))return;
  reviews.push({jobId:legacy?null:row.id,referenceId,origin:legacy?'legacy-feedback':'job-review',decision:r.decision,decisionAt:r.at||null,outcome:str(r.outcome),scope:clone(r.scope||scopeOf(row)),target:clone(row.target||{}),sourceSha,candidateSha,chosenSha:r.decision==='accept-candidate'?candidateSha:r.decision==='keep-baseline'?baselineSha:null,request:str(row.request),preserve:str(row.preserve),clarifications:clarifications(row),summary:str(row.summary),index,orderKey:legacy?referenceId:row.id,onSourceAncestry:lineageShas.has(candidateSha)});
 }
 for(const row of related){
  if(row.state!=='complete')continue;
  const list=Array.isArray(row.reviews)?row.reviews:row.review?[row.review]:[];
  list.forEach((r,i)=>addReview(row,r,i));
 }

 const legacyReferences=[];
 const assetShas=assets=>Object.values(assets||{}).map(hash).filter(Boolean);
 const touches=shas=>shas.some(s=>family.has(s));
 if(feedback&&Array.isArray(feedback.notes))for(const [index,n] of feedback.notes.entries()){
  if(!n||typeof n!=='object'){warn('feedback.json 含有无法辨认的旧反馈，已跳过。');continue;}
  if(job.assetId&&(n.assetId||'legacy')!==job.assetId)continue;
  if(clipOf(n)!==clip)continue;
  const ownSha=hash(n.asset),anchored=assets=>Boolean(ownSha&&assetShas(assets).includes(ownSha));
  const bound=[ownSha,...assetShas(n.comparison?.slots),...(anchored(n.reviewedAssets)?assetShas(n.reviewedAssets):[]),...(Array.isArray(n.reviews)?n.reviews:[]).filter(r=>anchored(r?.assets)).flatMap(r=>assetShas(r.assets))].filter(Boolean);
  if(!touches(bound))continue;
  const id='feedback:'+(n.id||index),scope=scopeOf(n),list=Array.isArray(n.reviews)?n.reviews.filter(r=>r&&typeof r==='object'):[];
  const exactReviews=list.length?list.filter(r=>anchored(r.assets)):n.decision&&anchored(n.reviewedAssets)?[{decision:n.decision,outcome:n.outcome,assets:n.reviewedAssets,at:n.updatedAt}]:n.decision&&n.slot==='candidate'&&hash(n.asset)?[{decision:n.decision,outcome:n.outcome,assets:{candidate:n.asset},at:n.updatedAt}]:[];
  legacyReferences.push({id,kind:'feedback',file:'feedback.json',recordId:n.id||null,assetSha:hash(n.asset),clip,scope,status:n.status||null,observed:str(n.observed),expected:str(n.expected),acceptance:str(n.acceptance),preserve:str(n.preserve),reference:str(n.reference),decision:n.decision||null,outcome:str(n.outcome),reviews:exactReviews.map(r=>({decision:r.decision,outcome:str(r.outcome),at:r.at||null,baselineSha:hash(r.assets?.baseline),candidateSha:hash(r.assets?.candidate)})),relation:lineageShas.has(hash(n.asset))?'source-lineage':'explicit-legacy-comparison-reference',instructionRole:'historical user evidence; not an automatic new edit instruction'});
  const row={...n,request:str(n.request)||str(n.expected),scope,inputs:{[n.slot||'baseline']:n.asset},slot:n.slot||'baseline'};
  exactReviews.forEach((r,i)=>{if(touches([hash(r.assets?.candidate),hash(r.assets?.baseline),hash(n.asset)].filter(Boolean)))addReview(row,r,i,{legacy:true,referenceId:id});});
  const exactAcceptedOnLineage=exactReviews.some(r=>r.decision==='accept-candidate'&&lineageShas.has(hash(r.assets?.candidate)));
  if(str(n.preserve).trim()&&(lineageShas.has(hash(n.asset))||exactAcceptedOnLineage))inheritedRequirements.push({id:'legacy:'+id+':preserve',text:n.preserve,sourceJobId:null,sourceLegacyId:id,kind:'preserve',scope,status:'inherited-unless-current-user-overrides'});
  if(n.decision&&!exactReviews.length)warn('旧反馈 '+(n.id||index)+' 的决定没有冻结候选版本，仅作为历史原话参考。');
 }
 if(feedback&&!Array.isArray(feedback.notes))warn('feedback.json 没有可读取的 notes 列表。');
 const markRows=Array.isArray(marks?.reviews)?marks.reviews:Object.values(marks?.reviews||{});
 if(marks&&(!marks.reviews||typeof marks.reviews!=='object'))warn('marks.json 没有可读取的 reviews 列表。');
 for(const [index,m] of markRows.entries()){
  if(!m||typeof m!=='object')continue;
  if(job.assetId&&(m.assetId||'legacy')!==job.assetId)continue;
  if(clipOf(m)!==clip)continue;
  const own=[hash(m.asset),hash(m.reference),...assetShas(m.context?.slots)].filter(Boolean);
  const history=(Array.isArray(m.history)?m.history:[]).filter(h=>{if(!h||typeof h!=='object')return false;const frozen=assetShas(h.context?.slots);return touches(frozen.length?frozen:own);});
  if(!touches(own)&&!history.length)continue;
  legacyReferences.push({id:'mark:'+(m.key||index),kind:'motion-mark',file:'marks.json',assetSha:hash(m.asset)||hash(m.sha256),referenceSha:hash(m.reference),clip,verdict:str(m.verdict),choice:str(m.choice),note:str(m.note),history:history.map(h=>({verdict:str(h.verdict),choice:str(h.choice),note:str(h.note),at:h.at||null,baselineSha:hash(h.context?.slots?.baseline),candidateSha:hash(h.context?.slots?.candidate)})),relation:'legacy-preference-reference',instructionRole:'preference is not formal acceptance; an empty latest choice is not an accepted checkpoint'});
 }

 // Reviews are append-only. Within each record, its last appended decision wins
 // even if a machine clock moved backwards. Across records use recorded time;
 // conflicting undated decisions are explicitly ambiguous rather than guessed.
 const latestByRecordCandidate=new Map();
 for(const r of reviews)latestByRecordCandidate.set(r.orderKey+'|'+r.candidateSha,r);
 const latestByCandidate=new Map();
 for(const r of latestByRecordCandidate.values()){
  const prior=latestByCandidate.get(r.candidateSha);
  if(!prior){latestByCandidate.set(r.candidateSha,r);continue;}
  const a=stamp(prior.decisionAt),b=stamp(r.decisionAt);
  if(a!==null&&b!==null&&a!==b){if(b>a)latestByCandidate.set(r.candidateSha,r);}
  else if(prior.decision!==r.decision){
   latestByCandidate.set(r.candidateSha,{...r,decision:'ambiguous'});
   ambiguities.push({kind:'conflicting-user-decisions',sha256:r.candidateSha,records:[prior.orderKey,r.orderKey]});
   warn('版本 '+r.candidateSha+' 的用户决定缺少可判定先后顺序；没有把它标作当前已验收版本。');
  }else if((r.orderKey||'').localeCompare(prior.orderKey||'')>0)latestByCandidate.set(r.candidateSha,r);
 }
 const acceptedCheckpoints=reviews.filter(r=>r.decision==='accept-candidate').map(r=>({jobId:r.jobId,referenceId:r.referenceId,sha256:r.candidateSha,decisionAt:r.decisionAt,outcome:r.outcome,scope:r.scope,origin:r.origin,reviewIndex:r.index,onSourceAncestry:r.onSourceAncestry,stillAccepted:latestByCandidate.get(r.candidateSha)?.decision==='accept-candidate',active:false}));
 const sourceDecisions=[...latestByCandidate.values()].filter(r=>r.onSourceAncestry).sort((a,b)=>(stamp(b.decisionAt)||0)-(stamp(a.decisionAt)||0)||b.orderKey.localeCompare(a.orderKey));
 let latestSourceDecision=sourceDecisions[0]||null;
 if(sourceDecisions.length>1&&(sourceDecisions.some(r=>stamp(r.decisionAt)===null)||stamp(sourceDecisions[0].decisionAt)===stamp(sourceDecisions[1].decisionAt))){
  ambiguities.push({kind:'undetermined-latest-source-decision',sha256:sourceSha256,records:sourceDecisions.map(r=>r.orderKey)});
  warn('源祖先的多个用户决定没有明确先后时间；保留所有检查点，但不猜测当前已验收版本。');
  latestSourceDecision=null;
 }
 let activeAcceptedCheckpoint=null;
 if(latestSourceDecision?.decision==='accept-candidate'){
  activeAcceptedCheckpoint=acceptedCheckpoints.findLast(r=>r.sha256===latestSourceDecision.candidateSha&&r.jobId===latestSourceDecision.jobId&&r.referenceId===latestSourceDecision.referenceId&&r.reviewIndex===latestSourceDecision.index)||null;
  if(activeAcceptedCheckpoint)activeAcceptedCheckpoint.active=true;
 }
 const rejectedApproaches=reviews.filter(r=>r.decision==='keep-baseline'||r.decision==='revise').map(r=>({...r,superseded:latestByCandidate.get(r.candidateSha)!==r,instructionRole:'user-rejected historical approach; use the quoted reason, do not automatically reapply the old goal'}));
 const allAncestry=relevantChain.map(j=>({id:j.id,request:str(j.request),preserve:str(j.preserve),clarifications:clarifications(j),summary:str(j.summary),decision:latestByRecordCandidate.get(j.id+'|'+candidateOf(j))?.decision||null,sourceSha:sourceOf(j),candidateSha:candidateOf(j),scope:scopeOf(j),target:clone(j.target||{}),goalState:'completed-background-only'}));
 if(allAncestry.length>MAX_ANCESTRY)warn('祖先展示仅保留最近 '+MAX_ANCESTRY+' 条，省略 '+(allAncestry.length-MAX_ANCESTRY)+' 条；完整用户原话、明确保留条件及验收清单仍在本包，完整历史仍在磁盘。');
 return {
  version:1,sourceSha256,clip,parentJobId,parentSelection,provenanceChain:fullChain.map(j=>({id:j.id,slot:slotOf(j),clip:clipOf(j),sourceSha256:sourceOf(j),candidateSha256:candidateOf(j)})),ancestry:allAncestry.slice(-MAX_ANCESTRY),ancestryTotal:allAncestry.length,lineageComplete:completeLineage,
  bridgeJobs:fullChain.filter(j=>clipOf(j)!==clip).map(j=>({id:j.id,clip:clipOf(j),sourceSha:sourceOf(j),candidateSha:candidateOf(j),role:'asset-provenance-only; other-clip instructions excluded'})),
  familySha256:[...family].sort(),inheritedRequirements,historicalInstructions,acceptedCheckpoints,activeAcceptedCheckpoint,
  latestSourceDecision:latestSourceDecision?{jobId:latestSourceDecision.jobId,referenceId:latestSourceDecision.referenceId,decision:latestSourceDecision.decision,decisionAt:latestSourceDecision.decisionAt,sha256:latestSourceDecision.candidateSha,outcome:latestSourceDecision.outcome}:null,
  rejectedApproaches,legacyReferences,ambiguities,requiresClarification:ambiguities.length>0,warnings,
  requirementsPolicy:{precedence:'Current explicit user request and clarification override conflicting inherited conditions. Otherwise retain applicable preserve conditions; ask when a conflict is ambiguous.',historicalGoals:'Old goals and AI summaries are background, never new instructions. Read historical user requests for preservation clauses even when preserve was empty.',legacy:'Version-bound legacy evidence is retained. Comparison references and preferences alone do not establish production ancestry or artistic acceptance.'},
  summary:{ancestorCount:allAncestry.length,inheritedRequirementCount:inheritedRequirements.length,historicalInstructionCount:historicalInstructions.length,acceptedCheckpointCount:acceptedCheckpoints.length,activeAcceptedSha256:activeAcceptedCheckpoint?.sha256||null,rejectedApproachCount:rejectedApproaches.length,legacyReferenceCount:legacyReferences.length,needsClarification:ambiguities.length>0}
 };
}
