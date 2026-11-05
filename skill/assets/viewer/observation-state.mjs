// Observation time is clip-local. The transport clock can be longer when two
// clips are aligned by progress, so it must be reconstructed after clip choice.
export function observationDuration(models,display='single',focus='baseline'){
 return display==='single'?(models[focus]?.duration||models.baseline?.duration||0):Math.max(0,...Object.values(models).map(m=>m?.duration||0));
}
export function observationTime(models,slot,time,{display='single',focus='baseline',mode='elapsed'}={}){
 const d=models[slot]?.duration||0,total=observationDuration(models,display,focus);
 return Math.max(0,Math.min(d,mode==='progress'&&display!=='single'&&total?time/total*d:time));
}
export function recordedObservationTransform(value){
 return Number.isFinite(value?.scale)&&value.scale>0&&vector(value.restOffset)?{scale:value.scale,restOffset:[...value.restOffset]}:null;
}
const vector=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
function camera(value){
 if(!vector(value?.position)||!vector(value?.target))return null;
 return {position:[...value.position],target:[...value.target],...(Number.isFinite(value.fov)&&value.fov>0&&value.fov<180?{fov:value.fov}:{})};
}
export function observationSettings(ctx={}){
 return {rootLocked:ctx.rootLocked!==false,linkedCameras:ctx.linkedCameras!==false,mode:ctx.mode==='progress'?'progress':'elapsed',scaleMode:ctx.scaleMode==='raw'?'raw':'shared',speed:Number.isFinite(ctx.speed)&&ctx.speed>0?ctx.speed:1,loop:ctx.loop!==false,view:ctx.view||'orbit'};
}
export function observationFrameOptions(ctx={},slot=ctx.slot||'baseline'){
 return {scaleMode:observationSettings(ctx).scaleMode,normalization:recordedObservationTransform(ctx.normalization?.[slot])};
}
export function planObservationRestore(ctx={},models,{inputSlot=null,fallbackClip=null}={}){
 const settings=observationSettings(ctx),comparison=inputSlot!==null;
 const focus=comparison?'candidate':models[ctx.slot]?ctx.slot:'baseline';
 const display=comparison?'split':['single','split','overlay'].includes(ctx.display)?ctx.display:ctx.displayMode==='comparison'?'split':'single';
 const sourceSlot=comparison?inputSlot:focus,clips={},cameras={};
 for(const slot of ['baseline','candidate']){
  const recorded=comparison?ctx.slots?.[sourceSlot]:ctx.slots?.[slot];
  const name=recorded?.clip??ctx.clip??fallbackClip;
  if(models[slot]&&(comparison||recorded?.sha256===models[slot].meta?.sha256)&&models[slot].clips.some(c=>c.name===name))clips[slot]=name;
  // A continued task's input may have occupied the old candidate slot. Its
  // camera now belongs to baseline, and starts the new candidate at that view.
  const value=camera(ctx.cameras?.[comparison?sourceSlot:slot]);if(value)cameras[slot]=value;
 }
 return {settings,focus,display,clips,cameras,normalization:recordedObservationTransform(ctx.normalization?.[sourceSlot]),timeSlot:comparison?'baseline':focus,localTime:Math.max(0,Number(ctx.slots?.[sourceSlot]?.time??ctx.time)||0)};
}
export function restoredTransportTime(plan,models){
 const local=Math.min(models[plan.timeSlot]?.duration||0,plan.localTime),total=observationDuration(models,plan.display,plan.focus),sourceDuration=models[plan.timeSlot]?.duration||0;
 return plan.settings.mode==='progress'&&plan.display!=='single'&&sourceDuration?local/sourceDuration*total:Math.min(total,local);
}
// Both versions use the actual input's coordinate transform. Independently
// fitting each mesh would conceal scale and origin changes in a candidate.
export function observationFrame(box,scaleMode='shared',recorded=null){
 const span=[box.max.x-box.min.x,box.max.y-box.min.y,box.max.z-box.min.z],extent=Math.max(...span)||1;
 const saved=scaleMode==='shared'?recordedObservationTransform(recorded):null;
 const factor=scaleMode==='raw'?1:saved?.scale??2/extent;
 const offset=scaleMode==='raw'?[0,0,0]:saved?.restOffset??[-(box.min.x+box.max.x)/2*factor,-box.min.y*factor,-(box.min.z+box.max.z)/2*factor];
 return {factor,offset,target:[(box.min.x+box.max.x)/2*factor+offset[0],(box.min.y+box.max.y)/2*factor+offset[1],(box.min.z+box.max.z)/2*factor+offset[2]],targetY:(box.min.y+box.max.y)/2*factor+offset[1],distanceScale:extent*factor/2};
}
