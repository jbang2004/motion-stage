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
