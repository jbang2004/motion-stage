const activeStates=new Set(['queued','running','needs-input']);
const sameAsset=(a,b)=>Boolean(a&&b&&a.sha256===b.sha256&&a.file===b.file);

export function activeStudioJob(jobs,assetId){
 return jobs.find(job=>job.assetId===assetId&&activeStates.has(job.state))||null;
}

export function currentStudioCandidate(jobs,project,candidateJobId){
 const head=project?.slots?.candidate;
 return jobs.find(job=>job.assetId===project?.activeAssetId&&job.state==='complete'&&
  (!candidateJobId||job.id===candidateJobId)&&sameAsset(job.candidate,head))||null;
}

export function currentComparison(job,project){
 const head=project?.slots?.candidate,owner=head?.derivedByJobId||head?.source?.derivedByJobId;
 return Boolean((!owner||owner===job.id)&&head?.sha256===job.candidate?.sha256&&
  project?.slots?.baseline?.sha256===job.inputs?.baseline?.sha256);
}

export function canFollowCandidate(job,{selectedJob,mode,panel,archived,preview,dialog,viewed}){
 return Boolean(job&&job.id===selectedJob&&mode==='studio'&&panel==='task'&&
  !archived&&!preview&&!dialog&&!viewed);
}

export function workspaceViewOutdated(project,{baseline,candidate},focus){
 return Boolean(project&&((baseline&&!sameAsset(baseline,project.slots.baseline))||
  (focus==='candidate'&&candidate&&!sameAsset(candidate,project.slots.candidate))));
}

// THE RIGHT PANEL FOLLOWS THE CLIP ON SCREEN. A task is about one clip of one model (job.clip): it is the panel's only while
// that clip is the one shown. Opened from the history it is shown (its own clip is then on screen); otherwise the panel's task
// is the newest of this clip's that is still live — queued, running, waiting, or finished on the current source and not yet
// decided. A task the game's source has overtaken (`sourceUpdate`, source-sync.mjs) is history, never the panel's.
const jobAsset=(job,legacy)=>job.assetId||legacy||'legacy';
export function jobForClip(jobs,{assetId,legacyAssetId,clip,selectedJob,baselineSha}={}){
 const mine=jobs.filter(job=>jobAsset(job,legacyAssetId)===assetId&&(job.clip||job.context?.clip||'')===(clip||''));
 const picked=mine.find(job=>job.id===selectedJob);
 if(picked)return picked;
 const live=job=>activeStates.has(job.state)||job.state==='complete'&&!job.review&&!job.artisticDecision&&!job.sourceUpdate&&
  (!baselineSha||(job.inputs?.[job.slot||'baseline']||job.inputs?.baseline)?.sha256===baselineSha);
 return mine.filter(live).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''))[0]||null;
}
// Tasks of this model about other clips that still want attention (running, queued, waiting, finished and undecided).
export function otherClipJobs(jobs,{assetId,legacyAssetId,clip}={}){
 return jobs.filter(job=>jobAsset(job,legacyAssetId)===assetId&&(job.clip||'')!==(clip||'')&&!job.sourceUpdate&&
  (activeStates.has(job.state)||job.state==='complete'&&!job.review&&!job.artisticDecision));
}
// The pair a task is seen on: its own, or — its candidate carried onto a newer source (source-sync.mjs) — that one.
export function jobPair(job){
 const rebased=job?.sourceUpdate?.rebased;
 return rebased?{baseline:rebased.baseline,candidate:rebased.candidate}:{baseline:job?.inputs?.[job?.slot||'baseline'],candidate:job?.candidate};
}

// WHAT THE STAGE SHOWS AGAINST WHAT THE USER KEPT. The baseline slot is the game's model; an edit stays in the candidate slot
// until someone puts it into the game (accepting it records approval in the studio only). The model's pending edit: the
// candidate slot's version, whose task it is and what was decided on it — or null when there is none (no candidate, the same
// bytes as the baseline, or the user kept the original).
export function pendingEdit(jobs,project){
 const head=project?.slots?.candidate,base=project?.slots?.baseline;
 if(!head?.sha256||head.sha256===base?.sha256)return null;
 const owner=head.derivedByJobId||head.source?.derivedByJobId;
 const job=jobs.find(j=>j.assetId===project.activeAssetId&&j.state==='complete'&&j.candidate?.sha256===head.sha256&&(!owner||j.id===owner))||null;
 const decision=job?.review?.decision||job?.artisticDecision||null;
 if(decision==='keep-baseline')return null;
 return {job,clip:job?.clip||null,status:!job?'imported':decision==='accept-candidate'?'accepted':'review',integrated:Boolean(job?.integrated)};
}
// A new request starts from the newest version the user has not turned down: an edit carries on from the edit.
export function composeSource(edit){return edit?'candidate':'baseline';}
// The line the stage shows while it plays the game's version and an edit waits elsewhere (null: nothing to say). An edit of
// another clip is not this clip's business; a directly loaded version (no task) may touch any clip.
export function versionNotice(edit,{focus,clip}={}){
 if(!edit||focus==='candidate'||edit.integrated||edit.clip&&clip&&edit.clip!==clip)return null;
 if(edit.status==='accepted')return '当前显示游戏里的版本，不含已采用的修改。采用只记在动作台，接入游戏需另外请 Agent 处理。';
 if(edit.status==='review')return '当前显示游戏里的版本。这段动作有一版修改等你评审。';
 return '当前显示游戏里的版本。另有一个修改后的版本（未经任务评审）。';
}
// Agent drafts (proposals.mjs) for the clip on screen first, then the model's others; the newest first.
export function proposalFor(proposals,{assetId,clip}={}){
 const mine=(proposals||[]).filter(p=>p.assetId===assetId).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
 return mine.find(p=>p.clip===clip)||mine[0]||null;
}
