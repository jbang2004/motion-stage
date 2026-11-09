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
