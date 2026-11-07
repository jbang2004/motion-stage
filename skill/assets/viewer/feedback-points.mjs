import {element as el} from './ui.mjs';
import {recordedObservationTransform} from './observation-state.mjs';

export const MAX_FEEDBACK_POINTS=12;
export const pointsForClip=(points,sha,clip)=>points.filter(p=>p.assetSha256===sha&&p.clip===clip);
const vector=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
const name=value=>typeof value==='string'&&value.length<=240?value:undefined;

export function validateFeedbackPoints(input,{sha,clip,duration,scope}={}){
 if(input===undefined)return [];
 if(!Array.isArray(input)||input.length>MAX_FEEDBACK_POINTS)throw Error('每个角色最多保存 '+MAX_FEEDBACK_POINTS+' 条反馈标记。');
 const seen=new Set();
 return input.map(p=>{
  if(!p||!(/^[a-z0-9-]{1,64}$/i.test(p.id||'')&&typeof p.id==='string')||seen.has(p.id)||
    typeof p.assetSha256!=='string'||!(/^[a-f0-9]{64}$/.test(p.assetSha256))||
    typeof p.clip!=='string'||!p.clip||p.clip.length>2048||!Number.isFinite(p.time)||p.time<0||
    typeof p.note!=='string'||!p.note.trim()||p.note.length>600)throw Error('反馈标记缺少有效时间、动作或备注。');
  seen.add(p.id);
  if(sha!==undefined&&(p.assetSha256!==sha||p.clip!==clip||p.time>duration+.001))throw Error('反馈标记与本轮动作或版本不匹配，请重新定位。');
  if(scope&&!scope.wholeClip&&(p.time<scope.start-.000001||p.time>scope.end+.000001))throw Error('反馈标记超出本轮修改范围，请调整范围或移除相应标记。');
  const camera=p.camera;
  if(!vector(camera?.position)||!vector(camera?.target)||!Number.isFinite(camera.fov)||camera.fov<=0||camera.fov>=180)throw Error('反馈标记缺少有效镜头。');
  const t=p.target||{};
  if(t.nodeIndex!==undefined&&(!Number.isSafeInteger(t.nodeIndex)||t.nodeIndex<0||t.nodeIndex>=100000))throw Error('反馈标记的节点索引无效。');
  const target={
   ...(t.nodeIndex===undefined?{}:{nodeIndex:t.nodeIndex}),
   ...(Number.isSafeInteger(t.meshNodeIndex)&&t.meshNodeIndex>=0?{meshNodeIndex:t.meshNodeIndex}:{}),
   ...(Number.isSafeInteger(t.faceIndex)&&t.faceIndex>=0?{faceIndex:t.faceIndex}:{}),
   ...(name(t.bone)?{bone:t.bone}:{}),...(name(t.mesh)?{mesh:t.mesh}:{}),
   ...(vector(t.point)?{point:[...t.point]}:{}),...(vector(t.worldPoint)?{worldPoint:[...t.worldPoint]}:{}),
   ...(typeof t.pickedAt?.clip==='string'&&t.pickedAt.clip.length<=2048&&Number.isFinite(t.pickedAt.time)&&t.pickedAt.time>=0?{pickedAt:{clip:t.pickedAt.clip,time:t.pickedAt.time}}:{}),
   ...(name(t.space)?{space:t.space}:{}),...(t.inferred===true?{inferred:true}:{}),
  };
  return {id:p.id,assetSha256:p.assetSha256,clip:p.clip,time:p.time,note:p.note.trim(),
   target:Object.keys(target).length?target:null,camera:{position:[...camera.position],target:[...camera.target],fov:camera.fov},
   view:['front','side','back','top','orbit'].includes(p.view)?p.view:'orbit',rootLocked:p.rootLocked!==false,
   scaleMode:p.scaleMode==='raw'?'raw':'shared',normalization:recordedObservationTransform(p.normalization)};
 });
}

export function feedbackObservation(ctx,point,slot,{comparison=false}={}){
 return {...ctx,slot,clip:point.clip,time:point.time,display:'single',view:point.view,
  mode:'elapsed',rootLocked:point.rootLocked,scaleMode:point.scaleMode,...(comparison?{linkedCameras:true}:{}),
  slots:{...ctx.slots,[slot]:{sha256:point.assetSha256,clip:point.clip,time:point.time}},
  normalization:{...ctx.normalization,[slot]:point.normalization},
  cameras:{...ctx.cameras,[slot]:point.camera}};
}

export function feedbackPointList(points,{documentRef=globalThis.document,describe,activeId,onSeek,onEdit,onDelete}={}){
 const node=(tag,text,cls)=>el(tag,text,cls,documentRef),list=node('ol',undefined,'feedback-point-list');
 for(const [i,point] of points.entries()){
  const row=node('li',undefined,'feedback-point'),go=node(onSeek?'button':'div',undefined,'feedback-point-jump');
  if(onSeek){go.type='button';go.dataset.feedbackPoint=point.id;if(point.id===activeId)go.setAttribute('aria-current','true');}
  go.append(node('span',(i+1)+'. '+point.time.toFixed(3)+' 秒 · '+describe(point),'feedback-point-time'),node('span',point.note,'feedback-point-note'));
  if(onSeek)go.onclick=()=>onSeek(point);
  row.append(go);
  for(const [label,action] of [['编辑',onEdit],['删除',onDelete]])if(action){
   const button=node('button',label,'text-button');button.type='button';button.setAttribute('aria-label',label+'标记 '+(i+1));button.onclick=()=>action(point);row.append(button);
  }
  list.append(row);
 }
 return list;
}
