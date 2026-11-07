// Content identity is not event identity: a later edit can intentionally return
// to earlier bytes. Resolve parents within one asset and walk task IDs only.
export function jobAncestors(rows,start){
 const byId=new Map(rows.map(row=>[row.id,row])),seen=new Set([start.id]),ancestors=new Set();
 let child=start;
 while(child){
  const sha=child.inputs?.[child.slot||'baseline']?.sha256;
  const eligible=row=>row.id!==child.id&&row.assetId===child.assetId&&row.state==='complete'&&row.candidate?.sha256===sha&&row.createdAt<=child.createdAt&&!seen.has(row.id);
  let parent;
  if(child.parentJobId){const explicit=byId.get(child.parentJobId);if(explicit&&eligible(explicit))parent=explicit;}
  else{const candidates=rows.filter(eligible);if(candidates.length===1)parent=candidates[0];}
  // Ambiguous legacy histories remain branches; never guess from equal bytes.
  if(!parent)break;
  seen.add(parent.id);ancestors.add(parent.id);child=parent;
 }
 return ancestors;
}
