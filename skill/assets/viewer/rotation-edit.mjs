// Shared by the transient viewport preview and the GLB writer. Angles are
// degrees around the selected node's local axis (post-multiply the pose).
const norm=q=>{const n=Math.hypot(...q);if(n<1e-10||!Number.isFinite(n))throw Error('动画中存在无效旋转四元数。');return q.map(v=>v/n);};
const dot=(a,b)=>a.reduce((v,n,i)=>v+n*b[i],0);
function slerp(a,b,t){let c=dot(a,b);if(c<0){b=b.map(v=>-v);c=-c;}if(c>.9995)return norm(a.map((v,i)=>v+(b[i]-v)*t));const angle=Math.acos(Math.min(1,c)),s=Math.sin(angle);return norm(a.map((v,i)=>(v*Math.sin((1-t)*angle)+b[i]*Math.sin(t*angle))/s));}
const angle=(a,b)=>2*Math.acos(Math.min(1,Math.abs(dot(a,b))));
export function editRotationTrack(sourceTimes,sourceValues,{factor=.7,offset,start,end}={}){
 const times=Array.from(sourceTimes),rawQs=sourceValues.slice();
 if(offset!==undefined){
  if(!offset||!['x','y','z'].includes(offset.axis)||!Number.isFinite(offset.degrees)||Math.abs(offset.degrees)>180)throw Error('旋转偏移需要 X、Y 或 Z 轴以及 −180° 到 180° 的角度。');
 }else if(!Number.isFinite(factor)||factor<0||factor>2)throw Error('摆动系数需要在 0 到 2 之间；0.7 表示约保留七成摆动。');
 const first=times[0],last=times.at(-1);
 if(times.length!==rawQs.length||times.length<2||times.length>200000||times.some((t,i)=>!Number.isFinite(t)||t<0||i&&t<=times[i-1]))throw Error('动画时间必须严格递增且与旋转关键帧一一对应；本地微调最多处理 20 万个关键帧。');
 const lo=start===undefined?first:Math.fround(start),hi=end===undefined?last:Math.fround(end);
 if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo<first-1e-5||hi>last+1e-5||hi<=lo)throw Error('修改时间段需要落在当前动作轨道内，并且结束时间大于开始时间。');
 const full=offset?lo<=first&&hi>=last:lo<=first+1e-5&&hi>=last-1e-5,ramp=(hi-lo)*.2;
 let inserted=0;
 if(!full){
  // Offset needs a plateau even when a short window contains no original keys.
  const boundaries=offset?[lo,Math.fround(lo+ramp),Math.fround(hi-ramp),hi]:[lo,hi];
  for(const boundary of boundaries){
   if(times.some(t=>Math.abs(t-boundary)<1e-7))continue;
   const i=times.findIndex(t=>t>boundary);if(i<1)continue;
   const q=slerp(norm(rawQs[i-1]),norm(rawQs[i]),(boundary-times[i-1])/(times[i]-times[i-1]));
   times.splice(i,0,boundary);rawQs.splice(i,0,q);inserted++;
  }
 }
 const qs=rawQs.map(norm),chosen=qs.filter((q,i)=>times[i]>=lo-1e-7&&times[i]<=hi+1e-7);
 if(chosen.length<2)throw Error('所选时间段不足两个旋转关键帧，请扩大范围或交给 Agent。');
 let mean;
 if(!offset){
  const ref=chosen[0],aligned=chosen.map(q=>dot(ref,q)<0?q.map(v=>-v):q);
  mean=norm(aligned.reduce((sum,q)=>sum.map((v,i)=>v+q[i]),[0,0,0,0]));
 }
 let changed=0;
 const output=qs.map((q,i)=>{
  const t=times[i];
  if(t<lo||t>hi)return rawQs[i];
  let w=1;
  if(!full){const x=Math.max(0,Math.min(1,(t-lo)/ramp,(hi-t)/ramp));w=x*x*(3-2*x);}
  if(w===0)return rawQs[i];
  let next;
  if(offset){
   const half=offset.degrees*w*Math.PI/360,[x,y,z,qw]=q;
   const vector=[0,0,0];vector['xyz'.indexOf(offset.axis)]=Math.sin(half);
   const [a,b,c]=vector,d=Math.cos(half);
   next=norm([qw*a+x*d+y*c-z*b,qw*b+y*d+z*a-x*c,qw*c+z*d+x*b-y*a,qw*d-x*a-y*b-z*c]);
  }else next=slerp(mean,q,1+(factor-1)*w);
  if(angle(q,next)>1e-7)changed++;
  return next;
 });
 if(!changed)throw Error('这次参数没有改变旋转关键帧，请调整数值或时间范围。');
 const degrees=180/Math.PI;
 const metrics=offset?{axis:offset.axis,degrees:offset.degrees}:{
  factor,beforeMaxDegrees:chosen.reduce((v,q)=>Math.max(v,angle(mean,q)),0)*degrees,
  afterMaxDegrees:output.reduce((v,q,i)=>times[i]>=lo&&times[i]<=hi?Math.max(v,angle(mean,q)):v,0)*degrees,
 };
 return {times,output,report:{...metrics,method:offset?'local-axis-offset':'quaternion-slerp-about-mean',
  timeRange:[lo,hi],edgeBlend:full?'whole-clip':'smoothstep-20-percent',
  insertedBoundaryKeyframes:inserted,changedKeyframes:changed,totalKeyframes:times.length}};
}
