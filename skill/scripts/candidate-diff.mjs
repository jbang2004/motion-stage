import {parseGlb,readAccessor} from './asset-tools.mjs';
import {curveDescriptor} from '../assets/viewer/resource-capabilities.mjs';

const dimensions={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
const states=()=>({unchanged:0,changed:0,added:0,removed:0,unverified:0});
const extensions=value=>Boolean(Object.keys(value?.extensions||{}).length);
const label=value=>String(value||'').slice(0,180);

// Use named paths, so a re-export may reorder nodes, channels and accessors.
// An unnamed node or ambiguous sibling path cannot be safely paired.
function nodePaths(nodes,interned){
 const parents=new Map(),paths=new Map(),counts=new Map(),identities=new Map();
 for(const [i,node] of nodes.entries())for(const child of node.children||[])parents.set(child,i);
 function path(i,depth=0){
  if(paths.has(i))return paths.get(i);
  const name=nodes[i]?.name;
  if(!name||depth>=256)return null;
  const parent=parents.has(i)?path(parents.get(i),depth+1):0;
  if(parent===null)return null;
  const key=JSON.stringify([parent,name]);
  if(!interned.has(key))interned.set(key,interned.size+1);
  const result=interned.get(key);
  paths.set(i,result);
  counts.set(result,(counts.get(result)||0)+1);
  return result;
 }
 for(const i of nodes.keys())path(i);
 function identity(i){
  if(identities.has(i))return identities.get(i);
  const id=paths.get(i);
  const result=counts.get(id)===1&&(!parents.has(i)||identity(parents.get(i)))?id:null;
  identities.set(i,result);
  return result;
 }
 return identity;
}

function animationData(bytes,interned){
 const {doc,bin}=parseGlb(bytes,{copy:false}),curves=curveDescriptor(doc);
 const raw=curves?.clips||doc.animations||[],counts=new Map();
 for(const {name} of raw)counts.set(name,(counts.get(name)||0)+1);
 const clips=new Map();
 let unidentified=0;
 const pathFor=nodePaths(doc.nodes||[],interned);
 for(const clip of raw){
  if(typeof clip.name!=='string'||!clip.name||counts.get(clip.name)!==1){unidentified++;continue;}
  const tracks=new Map();
  let unpaired=0;
  for(const channel of (curves?clip.tracks:clip.channels)||[]){
   const target=channel.target,sampler=curves?channel:clip.samplers?.[channel.sampler];
   const path=curves?channel.binding:pathFor(target?.node);
   const property=curves?channel.kind:target?.path;
   if(!path||!property||extensions(target)){unpaired++;continue;}
   const key=JSON.stringify([path,curves?'sampled':property]);
   // Duplicate channels in a source must never be silently overwritten.
   if(tracks.has(key)){tracks.set(key,null);unpaired++;continue;}
   tracks.set(key,{target:label(curves?path:doc.nodes[target.node].name),property,input:sampler?.input,output:sampler?.output,
    layout:curves?JSON.stringify([channel.kind,channel.width]):null,interpolation:curves?'sampled':sampler?.interpolation||'LINEAR',
    unsupported:!sampler||extensions(sampler)||extensions(channel)});
  }
  for(const [key,track] of tracks)if(!track){tracks.delete(key);unpaired++;}
  clips.set(clip.name,{tracks,unpaired,unsupported:extensions(clip),duration:curves?clip.duration:undefined});
 }
 const cache=new Map();
 let remaining=1_000_000;
 function accessor(index){
  if(cache.has(index))return cache.get(index);
  let values=null;
  const a=doc.accessors?.[index],view=doc.bufferViews?.[a?.bufferView],size=a?.count*dimensions[a?.type];
  if(Number.isSafeInteger(size)&&size>0&&size<=remaining&&!extensions(a)&&!extensions(view)&&
    (a.bufferView===undefined||view)){
   remaining-=size;
   try{values=readAccessor(doc,bin,index);}catch{/* Unsupported or unreadable data is not equality. */}
  }
  cache.set(index,values);
  return values;
 }
 return {clips,unidentified,accessor};
}

function sameValues(a,b){
 if(a.length!==b.length)return false;
 return a.every((row,i)=>row.length===b[i].length&&row.every((value,j)=>value===b[i][j]));
}

export function compareCandidate(sourceBytes,candidateBytes,{clip,lockOtherClips=false}={}){
 const result={version:1,tracks:states(),outside:0,unverifiedClips:0,clips:[],omittedClips:0,protection:lockOtherClips?'verified':'off',keyframeTimes:'unchanged'};
 const identities=new Map();
 const before=animationData(sourceBytes,identities),after=animationData(candidateBytes,identities);
 result.unverifiedClips=Math.max(before.unidentified,after.unidentified);
 let outsideUnknown=result.unverifiedClips>0;
 for(const name of new Set([...before.clips.keys(),...after.clips.keys()])){
  const a=before.clips.get(name),b=after.clips.get(name);
  const outside=Boolean(clip&&clip!==name),detail={name:label(name),outside,tracks:states(),rows:[],omittedRows:0};
  const record=(status,track,fields=[])=>{
   detail.tracks[status]++;
   if(status==='unchanged')return;
   if(detail.rows.length<24)detail.rows.push({status,target:track.target,property:track.property,fields});
   else detail.omittedRows++;
  };
  if(!a||!b){
   // An unnamed or duplicate clip on the opposite side might be this clip.
   const uncertain=(a?after:before).unidentified>0;
   detail.status=uncertain?'unverified':a?'removed':'added';
   for(const track of (a||b).tracks.values())record(detail.status,track);
  }else{
   detail.durationChanged=a.duration!==b.duration;
   for(const key of new Set([...a.tracks.keys(),...b.tracks.keys()])){
    const first=a.tracks.get(key),second=b.tracks.get(key);
    if(!first||!second){
     record((first?b:a).unpaired?'unverified':first?'removed':'added',first||second);
     continue;
    }
    if(a.unsupported||b.unsupported||first.unsupported||second.unsupported){record('unverified',second);continue;}
    const t0=before.accessor(first.input),t1=after.accessor(second.input),v0=before.accessor(first.output),v1=after.accessor(second.output);
    const fields=[];
    if(t0&&t1){if(!sameValues(t0,t1)){fields.push('time');result.keyframeTimes='changed';}}
    else if(result.keyframeTimes==='unchanged')result.keyframeTimes='unverified';
    if(v0&&v1&&(!sameValues(v0,v1)||first.layout!==second.layout))fields.push('values');
    if(first.interpolation!==second.interpolation)fields.push('interpolation');
    record(fields.length?'changed':t0&&t1&&v0&&v1?'unchanged':'unverified',second,fields);
   }
  }
  detail.unpaired=Math.max(a?.unpaired||0,b?.unpaired||0);
  detail.tracks.unverified+=detail.unpaired;
  const {changed,added,removed,unverified}=detail.tracks;
  const edited=detail.status==='added'||detail.status==='removed'||detail.durationChanged||changed||added||removed;
  const unknown=detail.status==='unverified'||unverified||a?.unsupported||b?.unsupported;
  if(outside&&edited)result.outside++;
  if(outside&&unknown)outsideUnknown=true;
  for(const key of Object.keys(result.tracks))result.tracks[key]+=detail.tracks[key];
  if(edited||unknown){
   if(result.clips.length<32)result.clips.push(detail);
   else result.omittedClips++;
  }
 }
 if(result.keyframeTimes==='unchanged'&&(result.tracks.unverified||result.unverifiedClips||result.tracks.added||result.tracks.removed))result.keyframeTimes='unverified';
 if(lockOtherClips)result.protection=result.outside?'violated':outsideUnknown?'unverified':'verified';
 return result;
}
