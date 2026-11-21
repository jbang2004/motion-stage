import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {readProject} from './core.mjs';
import {getProjectLink} from './project-context.mjs';

// THE STAGE FOLLOWS THE GAME. Every character opened here from the linked game project is watched at its declared files (the
// main model and its animation sources, character-map.json): a file that changed and then held still for STABLE is loaded as
// that character's new source (character-library.mjs openCharacter with refreshSource, the page left on whatever it shows),
// which sorts the old version's work clip by clip (source-sync.mjs). What stops it (a running task, an unsent draft about a
// clip the new source changed: sourceRefreshBlockers) is reported, per character, as `blocked` with the reasons, and tried
// again when the files or the workspace change, or when the page asks (`sync`). Polled, not fs.watch: an install that writes a
// new file and renames it over the old one leaves a watch on the old inode.
export const SOURCE_POLL_MS=1500,SOURCE_STABLE_MS=1200;

export function createSourceWatcher(work,{onChange=()=>{},interval=SOURCE_POLL_MS,stable=SOURCE_STABLE_MS,refresh,inspect}={}){
 const seen=new Map(),states=new Map();let timer=null,busy=null,starting=null,stopped=false;
 const signature=async path=>{try{const s=await stat(path);return [s.size,s.mtimeMs,s.ino].join(':');}catch{return 'missing';}};
 async function targets(){
  const link=await getProjectLink(work);if(!link?.exists)return [];
  const cfg=await readProject(work),{characterTargets}=await import('./character-library.mjs');
  return (await characterTargets(work)).filter(t=>cfg.models[t.assetId]?.origin==='character'&&cfg.models[t.assetId].slots?.baseline)
   .map(t=>({...t,paths:t.files.map(f=>join(link.root,f))}));
 }
 function set(assetId,next){const prev=states.get(assetId),{at,...rest}=prev||{},same=Boolean(prev)&&JSON.stringify(rest)===JSON.stringify(next);states.set(assetId,{...next,at:same?at:new Date().toISOString()});if(!same)onChange();}
 async function sync(target,{force=false}={}){
  const status=await inspect(target.profileId);
  if(status.status==='current'){if(force||states.get(target.assetId)?.state!=='synced')set(target.assetId,{state:'current',sourceSha256:status.sourceSha256});return states.get(target.assetId);}
  if(!['stale','unopened'].includes(status.status)){set(target.assetId,{state:'waiting',reason:status.error||status.status,sourceSha256:status.sourceSha256||null});return states.get(target.assetId);}
  if(status.blockers.length){set(target.assetId,{state:'blocked',reasons:status.blockers,sourceSha256:status.sourceSha256});return states.get(target.assetId);}
  try{
   const report=await refresh(target.assetId);
   set(target.assetId,{state:'synced',sourceSha256:status.sourceSha256,report});
  }catch(error){set(target.assetId,{state:'blocked',reasons:[error.message],sourceSha256:status.sourceSha256});}
  return states.get(target.assetId);
 }
 async function poll(){
  if(busy||stopped)return busy;
  busy=(async()=>{
   for(const t of await targets()){
    if(stopped)break;
    const sig=(await Promise.all(t.paths.map(signature))).join('|'),last=seen.get(t.assetId),now=Date.now();
    if(!last){seen.set(t.assetId,{sig,since:now,done:false});continue;}
    if(last.sig!==sig){seen.set(t.assetId,{sig,since:now,done:false});set(t.assetId,{state:'changing'});continue;}
    if(!last.done&&now-last.since>=stable){last.done=true;await sync(t);}
   }
  })().catch(()=>{}).finally(()=>{busy=null;});
  return busy;
 }
 return {
  start(){
   // (at start every opened character is checked once: a model installed while the stage was closed is loaded now)
   return starting??=(async()=>{
    try{for(const t of await targets()){if(stopped)break;seen.set(t.assetId,{sig:(await Promise.all(t.paths.map(signature))).join('|'),since:Date.now(),done:true});await sync(t);}}catch{}
    if(!stopped){timer=setInterval(poll,interval);timer.unref?.();}
   })();
  },
  poll,
  async sync(assetId){const t=(await targets()).find(x=>x.assetId===assetId);if(!t)throw Error('这个角色没有关联到游戏文件');return sync(t,{force:true});},
  status(assetId){return states.get(assetId)||null;},
  // (stopped, and settled: a check already under way finishes before the workspace is let go)
  stop(){stopped=true;clearInterval(timer);timer=null;return Promise.all([starting,busy]).then(()=>{},()=>{});},
 };
}
