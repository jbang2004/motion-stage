// Measured motion checks on a self-contained GLB: rotation flips, planted-foot slip and
// limb extension (knee/elbow pop). Pure Node, no Blender. The check definitions follow
// scenario-labs/skills `scenario-blender-animation/scripts/bx_anim.py` (MIT); see THIRD_PARTY.md.
// These are evidence for the agent and the user, never a completion gate or artistic approval.
import {createHash} from 'node:crypto';
import {parseGlb,readAccessor} from './asset-tools.mjs';

const DEG=180/Math.PI;
const digest=b=>createHash('sha256').update(b).digest('hex');
const round=(v,n=4)=>v===null||v===undefined||!Number.isFinite(v)?v:Number(v.toFixed(n));

// ---- math (glTF: column-major 4x4, quaternions xyzw, Y up) ----
const qnorm=q=>{const n=Math.hypot(...q);return n<1e-12||!Number.isFinite(n)?[0,0,0,1]:q.map(v=>v/n);};
const qdot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3];
const qangle=(a,b)=>2*Math.acos(Math.min(1,Math.abs(qdot(qnorm(a),qnorm(b)))));
function qslerp(a,b,t){
 // Shortest path, as the glTF reference implementation and three.js both interpolate.
 let c=qdot(a,b);if(c<0){b=b.map(v=>-v);c=-c;}
 if(c>.9995)return qnorm(a.map((v,i)=>v+(b[i]-v)*t));
 const w=Math.acos(Math.min(1,c)),s=Math.sin(w);return a.map((v,i)=>(v*Math.sin((1-t)*w)+b[i]*Math.sin(t*w))/s);
}
function compose(t=[0,0,0],r=[0,0,0,1],s=[1,1,1]){
 const [x,y,z,w]=qnorm(r),[sx,sy,sz]=s;
 return [(1-2*(y*y+z*z))*sx,2*(x*y+z*w)*sx,2*(x*z-y*w)*sx,0,2*(x*y-z*w)*sy,(1-2*(x*x+z*z))*sy,2*(y*z+x*w)*sy,0,2*(x*z+y*w)*sz,2*(y*z-x*w)*sz,(1-2*(x*x+y*y))*sz,0,t[0],t[1],t[2],1];
}
function mul(a,b){const o=Array(16).fill(0);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let v=0;for(let k=0;k<4;k++)v+=a[k*4+r]*b[c*4+k];o[c*4+r]=v;}return o;}
const pos=m=>[m[12],m[13],m[14]];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const len=v=>Math.hypot(...v);
const vangle=(a,b)=>{const la=len(a),lb=len(b);if(la<1e-9||lb<1e-9)return 0;return Math.acos(Math.max(-1,Math.min(1,(a[0]*b[0]+a[1]*b[1]+a[2]*b[2])/(la*lb))));};
const horiz=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);

// ---- glTF animation sampling ----
function loadClip(doc,bin,clipName){
 const anims=doc.animations||[];
 const index=clipName===undefined?(anims.length===1?0:-1):anims.findIndex((a,i)=>(a.name||'animation_'+i)===clipName);
 if(index<0)throw Error(anims.length?'请用 --clip 指定动作：'+anims.map((a,i)=>a.name||'animation_'+i).join('、'):'模型没有动作，无法做运动检查。');
 const a=anims[index],channels=[];let start=Infinity,end=-Infinity;
 for(const c of a.channels||[]){
  const node=c.target?.node,path=c.target?.path;if(!Number.isInteger(node)||!['translation','rotation','scale'].includes(path))continue;
  const s=a.samplers[c.sampler],times=readAccessor(doc,bin,s.input).flat(),values=readAccessor(doc,bin,s.output),interpolation=s.interpolation||'LINEAR';
  if(!times.length)continue;
  if(values.length!==times.length*(interpolation==='CUBICSPLINE'?3:1))throw Error('动作轨道的时间与数值数量不一致。');
  channels.push({node,path,times,values,interpolation});start=Math.min(start,times[0]);end=Math.max(end,times.at(-1));
 }
 if(!channels.length)throw Error('所选动作没有可采样的节点轨道。');
 return{name:a.name||'animation_'+index,index,channels,start,end};
}
function sampleChannel(ch,t){
 const {times,values,interpolation,path}=ch,n=times.length,cubic=interpolation==='CUBICSPLINE',val=i=>cubic?values[i*3+1]:values[i];
 const fix=v=>path==='rotation'?qnorm(v):v;
 if(t<=times[0]||n===1)return fix(val(0));if(t>=times[n-1])return fix(val(n-1));
 let lo=0,hi=n-1;while(hi-lo>1){const m=(lo+hi)>>1;if(times[m]<=t)lo=m;else hi=m;}
 const td=times[hi]-times[lo],u=(t-times[lo])/td,a=val(lo),b=val(hi);
 if(interpolation==='STEP')return fix(a);
 if(cubic){
  const out=values[lo*3+2],inn=values[hi*3],u2=u*u,u3=u2*u;
  return fix(a.map((v,i)=>(2*u3-3*u2+1)*v+td*(u3-2*u2+u)*out[i]+(-2*u3+3*u2)*b[i]+td*(u3-u2)*inn[i]));
 }
 return path==='rotation'?qslerp(qnorm(a),qnorm(b),u):a.map((v,i)=>v+(b[i]-v)*u);
}
function sampleTimes(clip,fps){
 const out=[],count=Math.max(1,Math.round((clip.end-clip.start)*fps));
 for(let i=0;i<=count;i++)out.push(Math.min(clip.end,clip.start+i/fps));
 if(out.at(-1)<clip.end-1e-6)out.push(clip.end);return out;
}
function makePoser(doc,clip){
 const nodes=doc.nodes||[],parents=new Map();nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parents.set(c,i)));
 const byNode=new Map();for(const ch of clip?.channels||[]){if(!byNode.has(ch.node))byNode.set(ch.node,{});byNode.get(ch.node)[ch.path]=ch;}
 const local=(i,t)=>{const n=nodes[i],c=byNode.get(i);if(n.matrix&&!c)return n.matrix;
  return compose(c?.translation&&t!==null?sampleChannel(c.translation,t):n.translation,c?.rotation&&t!==null?sampleChannel(c.rotation,t):n.rotation,c?.scale&&t!==null?sampleChannel(c.scale,t):n.scale);};
 // t===null gives the rest pose (node defaults).
 return{parents,nodes,world(i,t){const cache=new Map(),go=j=>{if(cache.has(j))return cache.get(j);const p=parents.get(j),m=p===undefined?local(j,t):mul(go(p),local(j,t));cache.set(j,m);return m;};return go(i);},
  worldPos(list,t){const cache=new Map(),go=j=>{if(cache.has(j))return cache.get(j);const p=parents.get(j),m=p===undefined?local(j,t):mul(go(p),local(j,t));cache.set(j,m);return m;};return list.map(j=>pos(go(j)));}};
}
function resolveNode(nodes,ref){
 if(typeof ref==='number'||/^\d+$/.test(String(ref))){const i=Number(ref);if(!nodes[i])throw Error('找不到节点索引 '+ref);return i;}
 const hits=nodes.map((n,i)=>(n.name||'node_'+i)===ref?i:-1).filter(i=>i>=0);
 if(hits.length!==1)throw Error(hits.length?'节点名称重复：'+ref+'，请改用节点索引。':'找不到节点：'+ref);return hits[0];
}
const nameOf=(nodes,i)=>nodes[i]?.name||'node_'+i;
function sideOf(name){
 if(/(^|[^a-z])(left|l)([^a-z]|$)|left|\.l$|_l$|^l_/i.test(name))return'left';
 if(/(^|[^a-z])(right|r)([^a-z]|$)|right|\.r$|_r$|^r_/i.test(name))return'right';return null;
}
function guessFeet(doc){
 const nodes=doc.nodes||[],joints=new Set((doc.skins||[]).flatMap(s=>s.joints||[]));
 const ok=(n,i)=>/foot|ankle/i.test(n.name||'')&&!/toe|ik|pole|ctrl|ctl|target|end|nub|shell|mesh/i.test(n.name||'')&&(!joints.size||joints.has(i));
 const all=nodes.map((n,i)=>ok(n,i)?i:-1).filter(i=>i>=0),parents=new Map();nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parents.set(c,i)));
 // Keep the top-most candidate of each branch so a nested "FootShell" never duplicates its foot.
 const set=new Set(all);return all.filter(i=>{let p=parents.get(i);while(p!==undefined){if(set.has(p))return false;p=parents.get(p);}return true;});
}

// ---- checks ----
export function rotationFlips(doc,clip,{fps=30,maxStepDegrees=90}={}){
 const nodes=doc.nodes||[],findings=[],checkedNodes=[],times=sampleTimes(clip,fps);let checked=0;
 for(const ch of clip.channels.filter(c=>c.path==='rotation')){
  checked++;checkedNodes.push(ch.node);const node=nameOf(nodes,ch.node),keys=ch.interpolation==='CUBICSPLINE'?ch.times.map((_,i)=>ch.values[i*3+1]):ch.values;
  for(let i=1;i<keys.length;i++){
   const a=qnorm(keys[i-1]),b=qnorm(keys[i]),deg=qangle(a,b)*DEG;
   if(deg>=170)findings.push({kind:'ambiguous_segment',severity:'warning',node,nodeIndex:ch.node,time:[round(ch.times[i-1]),round(ch.times[i])],degrees:round(deg,1),note:'相邻关键帧相差接近 180°，插值方向不确定，不同引擎可能转向不同方向。'});
   else if(qdot(a,b)<0)findings.push({kind:'quat_sign_flip',severity:ch.interpolation==='CUBICSPLINE'?'warning':'info',node,nodeIndex:ch.node,time:[round(ch.times[i-1]),round(ch.times[i])],note:ch.interpolation==='CUBICSPLINE'?'CUBICSPLINE 按分量插值，四元数符号翻转会绕远路转一大圈。':'LINEAR 轨道在动作台和 glTF 参考实现中按最短路径插值，画面不受影响；按分量插值的导入器可能绕远路。'});
  }
  let run=null;const flush=()=>{if(run){findings.push({kind:'fast_turn',severity:'warning',node,nodeIndex:ch.node,time:[round(run.t0),round(run.t1)],degrees:round(run.max,1),note:'采样间隔内转动超过 '+maxStepDegrees+'°（'+fps+' fps），通常是烘焙或欧拉角翻转造成的突跳。'});run=null;}};
  let prev=sampleChannel(ch,times[0]);
  for(let i=1;i<times.length;i++){const q=sampleChannel(ch,times[i]),deg=qangle(prev,q)*DEG;
   if(deg>maxStepDegrees){if(run){run.t1=times[i];run.max=Math.max(run.max,deg);}else run={t0:times[i-1],t1:times[i],max:deg};}else flush();prev=q;}
  flush();
 }
 return{checkedChannels:checked,checkedNodes,maxStepDegrees,findings};
}

function chainFor(doc,end,given){
 const nodes=doc.nodes||[];if(given)return given.map(r=>resolveNode(nodes,r));
 const parents=new Map();nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parents.set(c,i)));
 const mid=parents.get(end),root=mid===undefined?undefined:parents.get(mid);
 return root===undefined?null:[root,mid,end];
}
export function limbExtension(poser,clip,chain,{fps=30,threshold=.99,popDegrees=20}={}){
 const {nodes}=poser,times=sampleTimes(clip,fps),rest=poser.worldPos(chain,null);
 let full=0;for(let i=1;i<rest.length;i++)full+=len(sub(rest[i],rest[i-1]));
 if(full<1e-9)throw Error('四肢链的静止长度为 0：'+chain.map(i=>nameOf(nodes,i)).join(' > '));
 const rows=times.map(t=>{const p=poser.worldPos(chain,t);return{time:t,ratio:len(sub(p.at(-1),p[0]))/full,bend:vangle(sub(p[1],p[0]),sub(p.at(-1),p.at(-2)))*DEG};});
 const runs=(mask)=>{const out=[];let s=-1;mask.forEach((m,i)=>{if(m&&s<0)s=i;if(!m&&s>=0){out.push([s,i-1]);s=-1;}});if(s>=0)out.push([s,mask.length-1]);return out;};
 const stretched=runs(rows.map(r=>r.ratio>1.001)),straight=runs(rows.map(r=>r.ratio>=threshold)),pops=[];
 for(let i=1;i<rows.length;i++){const d=Math.abs(rows[i].bend-rows[i-1].bend);if(d>popDegrees&&Math.max(rows[i].ratio,rows[i-1].ratio)>.97)pops.push({time:[round(rows[i-1].time),round(rows[i].time)],bendChangeDegrees:round(d,1)});}
 const label=chain.map(i=>nameOf(nodes,i)),findings=[];
 for(const p of pops)findings.push({kind:'limb_pop',severity:'warning',chain:label,time:p.time,degrees:p.bendChangeDegrees,note:'接近伸直时一帧内弯曲变化超过 '+popDegrees+'°，会看到膝/肘“弹直”。'});
 for(const [a,b] of stretched)findings.push({kind:'limb_stretch',severity:'warning',chain:label,time:[round(rows[a].time),round(rows[b].time)],maxRatio:round(Math.max(...rows.slice(a,b+1).map(r=>r.ratio))),note:'四肢长度超过静止长度，通常是 IK 拉伸或平移/缩放动画拉长了骨骼。'});
 return{chain:label,nodeIndices:chain,restLength:round(full),maxRatio:round(Math.max(...rows.map(r=>r.ratio))),minBendDegrees:round(Math.min(...rows.map(r=>r.bend)),1),straightRanges:straight.map(([a,b])=>[round(rows[a].time),round(rows[b].time)]),threshold,popDegrees,findings};
}

export function footSlip(poser,clip,foot,{fps=30,legLength,pelvis,contacts,floor,tolerance,contactHeight}={}){
 const {nodes}=poser,times=sampleTimes(clip,fps),scale=legLength||1;
 const tol=tolerance??.01*scale,hTol=contactHeight??.03*scale;
 const pts=times.map(t=>poser.worldPos([foot],t)[0]),ys=pts.map(p=>p[1]),ground=floor??Math.min(...ys);
 let ranges;
 if(contacts)ranges=contacts.map(([a,b])=>{const idx=times.map((t,i)=>t>=a-1e-6&&t<=b+1e-6?i:-1).filter(i=>i>=0);return idx.length?[idx[0],idx.at(-1)]:null;}).filter(Boolean);
 else{ranges=[];let s=-1;ys.forEach((y,i)=>{const c=y-ground<=hTol;if(c&&s<0)s=i;if(!c&&s>=0){if(i-s>=3)ranges.push([s,i-1]);s=-1;}});if(s>=0&&ys.length-s>=3)ranges.push([s,ys.length-1]);}
 let inPlace=null;if(pelvis!==undefined){const pp=times.map(t=>poser.worldPos([pelvis],t)[0]);inPlace=Math.max(...pp.map(p=>horiz(p,pp[0])))<.1*scale;}
 const runs=ranges.map(([a,b])=>{
  const p0=pts[a],dur=times[b]-times[a],end=pts[b],v=dur>0?[(end[0]-p0[0])/dur,(end[2]-p0[2])/dur]:[0,0];
  let slide=0,residual=0,lift=0;for(let i=a;i<=b;i++){const p=pts[i],dt=times[i]-times[a];slide=Math.max(slide,horiz(p,p0));residual=Math.max(residual,Math.hypot(p[0]-p0[0]-v[0]*dt,p[2]-p0[2]-v[1]*dt));lift=Math.max(lift,p[1]-ground);}
  const speed=Math.hypot(...v),treadmill=inPlace===true&&slide>tol&&residual<=tol;
  return{time:[round(times[a]),round(times[b])],samples:b-a+1,slide:round(slide),lift:round(lift),speed:round(speed),kind:slide<=tol?'planted':treadmill?'treadmill':'slip'};
 });
 const name=nameOf(nodes,foot),findings=runs.filter(r=>r.kind==='slip').map(r=>({kind:'foot_slip',severity:'warning',node:name,nodeIndex:foot,time:r.time,slide:r.slide,note:'着地期间水平漂移超过容差 '+round(tol)+'。'}));
 return{foot:name,nodeIndex:foot,floor:round(ground),tolerance:round(tol),contactHeight:round(hTol),contactSource:contacts?'given':'auto-height',inPlace,contacts:runs,findings};
}

// ---- entry point ----
export const CHECK_NAMES=['rotationFlips','footSlip','limbExtension'];
export function checkMotion(bytes,{clip,fps=30,feet,chains,checks=CHECK_NAMES,maxStepDegrees=90,popDegrees=20,contacts,floor,tolerance}={}){
 if(!Number.isFinite(fps)||fps<1||fps>240)throw Error('采样帧率需要在 1 到 240 之间。');
 const unknown=(Array.isArray(checks)?checks:[checks]).filter(c=>!CHECK_NAMES.includes(c));if(unknown.length)throw Error('未知检查项：'+unknown.join(', ')+'。可用：'+CHECK_NAMES.join(', '));
 const {doc,bin}=parseGlb(bytes),nodes=doc.nodes||[],c=loadClip(doc,bin,clip),poser=makePoser(doc,c),limitations=[],result={};
 if(checks.includes('rotationFlips'))result.rotationFlips=rotationFlips(doc,c,{fps,maxStepDegrees});
 const wantsLegs=checks.includes('footSlip')||checks.includes('limbExtension');
 let footList=feet?feet.map(r=>resolveNode(nodes,r)):wantsLegs?guessFeet(doc):[],selection=feet?'given':'name-hint';
 if(wantsLegs&&!footList.length)limitations.push('没有找到名称像脚的节点；脚滑和四肢检查已跳过。请用 --feet 指定脚踝节点。');
 if(!feet&&footList.length)limitations.push('脚节点按名称推测：'+footList.map(i=>nameOf(nodes,i)).join('、')+'。名称不能确认解剖身份，结果仅供参考；可用 --feet 指定。');
 const legChains=footList.map(f=>({foot:f,chain:chainFor(doc,f)})).filter(x=>x.chain);
 const extra=(chains||[]).map(ch=>chainFor(doc,null,ch));
 if(checks.includes('limbExtension'))result.limbExtension=[...legChains.map(x=>x.chain),...extra].map(ch=>limbExtension(poser,c,ch,{fps,popDegrees}));
 if(checks.includes('footSlip'))result.footSlip=footList.map(f=>{
  const leg=legChains.find(x=>x.foot===f)?.chain,rest=leg&&poser.worldPos(leg,null);
  const legLength=rest?len(sub(rest[1],rest[0]))+len(sub(rest[2],rest[1])):undefined,pelvis=leg?poser.parents.get(leg[0]):undefined;
  if(!legLength)limitations.push(nameOf(nodes,f)+' 没有完整腿链，容差按 1 个场景单位估算。');
  return footSlip(poser,c,f,{fps,legLength,pelvis,contacts:contacts?.[nameOf(nodes,f)]??contacts?.[f],floor,tolerance});
 });
 const tread=(result.footSlip||[]).flatMap(r=>r.contacts.filter(x=>x.kind==='treadmill').map(x=>({foot:r.foot,speed:x.speed})));
 const findings=[...(result.rotationFlips?.findings||[]),...(result.limbExtension||[]).flatMap(r=>r.findings),...(result.footSlip||[]).flatMap(r=>r.findings)];
 if(tread.length>1){const s=tread.map(x=>x.speed),lo=Math.min(...s),hi=Math.max(...s);if(hi>0&&(hi-lo)/hi>.15)findings.push({kind:'treadmill_speed_mismatch',severity:'warning',speeds:tread.map(x=>({foot:x.foot,speed:x.speed})),note:'原地动作中各次着地的后移速度不一致（相差超过 15%），游戏按固定速度移动角色时会有一只脚打滑。'});}
 if(tread.length)limitations.push('原地动作：着地脚匀速后移是预期的（treadmill），游戏移动速度应与之一致，约 '+round(tread.reduce((v,x)=>v+x.speed,0)/tread.length,3)+' 单位/秒。');
 limitations.push('按 '+fps+' fps 采样关节位置；不能证明网格无穿插、动作自然或运行时 IK/布料正确。');
 return{version:1,kind:'motion-checks',sha256:digest(Buffer.from(bytes)),clip:c.name,timeRange:[round(c.start),round(c.end)],fps,footSelection:wantsLegs?selection:null,checks:result,summary:{warnings:findings.filter(f=>f.severity==='warning').length,info:findings.filter(f=>f.severity==='info').length},findings,limitations:[...new Set(limitations)],source:'Check definitions adapted from scenario-labs/skills bx_anim.py (MIT).'};
}

// Marks each candidate finding as new or already present in the baseline, so an edit is
// judged on what it introduced rather than on pre-existing defects.
export function compareMotionChecks(baseline,candidate){
 const key=f=>[f.kind,f.nodeIndex??f.node??'',(f.chain||[]).join('>')].join('|');
 const near=(a,b)=>!a.time||!b.time||(a.time[0]<=b.time[1]+.05&&b.time[0]<=a.time[1]+.05);
 const metrics=f=>Object.fromEntries([
  ['slide',f.slide],['degrees',f.degrees],['extension',Number.isFinite(f.maxRatio)?Math.max(0,f.maxRatio-1):undefined],
  ['duration',f.time?Math.max(0,f.time[1]-f.time[0]):undefined],
  ['speedSpread',f.speeds?.length?(Math.max(...f.speeds.map(x=>x.speed))-Math.min(...f.speeds.map(x=>x.speed)))/Math.max(1e-8,...f.speeds.map(x=>x.speed)):undefined]
 ].filter(([,v])=>Number.isFinite(v)));
 const trend=(a,b)=>{
  const before=metrics(a),after=metrics(b),delta={};let up=a.severity==='info'&&b.severity==='warning',down=a.severity==='warning'&&b.severity==='info';
  for(const k of Object.keys(after))if(before[k]!==undefined){const difference=after[k]-before[k],epsilon=Math.max(k==='duration'?.05:1e-4,Math.abs(before[k])*.05);delta[k]={before:before[k],after:after[k],difference:round(difference)};if(difference>epsilon)up=true;else if(difference< -epsilon)down=true;}
  return {status:up?'worsened':down?'improved':'existing',previousSeverity:a.severity,metrics:delta};
 };
 const covered=(f,report)=>{
  if(baseline.fps&&candidate.fps&&baseline.fps!==candidate.fps)return false;
  if(report.timeRange&&f.time&&(f.time[0]<report.timeRange[0]-.001||f.time[1]>report.timeRange[1]+.001))return false;
  if(!report.checks)return true; // Compatibility with older evidence packets.
  if(f.kind.startsWith('foot_'))return report.checks.footSlip?.some(x=>x.nodeIndex===f.nodeIndex)??false;
  if(f.kind.startsWith('limb_'))return report.checks.limbExtension?.some(x=>x.chain.join('>')===(f.chain||[]).join('>'))??false;
  if(f.kind==='treadmill_speed_mismatch')return (report.checks.footSlip?.length||0)>=2;
  const rotation=report.checks.rotationFlips;return rotation?.checkedNodes?rotation.checkedNodes.includes(f.nodeIndex):(rotation?.checkedChannels||0)>0;
 };
 const used=new Set(),marked=candidate.findings.map(f=>{
  const i=baseline.findings.findIndex((b,j)=>!used.has(j)&&key(b)===key(f)&&near(b,f));
  if(i>=0){used.add(i);return {...f,...(covered(f,baseline)&&covered(baseline.findings[i],candidate)?trend(baseline.findings[i],f):{status:'unverified'})};}
  return {...f,status:covered(f,baseline)?'new':'unverified'};
 });
 const missing=baseline.findings.filter((_,j)=>!used.has(j)),resolved=missing.filter(f=>covered(f,candidate)).map(f=>({...f,status:'resolved'})),unverified=missing.filter(f=>!covered(f,candidate)).map(f=>({...f,status:'unverified'}));
 const count=status=>marked.filter(f=>f.status===status&&(f.severity==='warning'||f.previousSeverity==='warning')).length;
 return{...candidate,baselineSha256:baseline.sha256,findings:marked,resolved,unverified,summary:{...candidate.summary,newWarnings:count('new'),worsenedWarnings:count('worsened'),improvedWarnings:count('improved'),unverifiedWarnings:count('unverified')+unverified.filter(f=>f.severity==='warning').length,resolvedWarnings:resolved.filter(f=>f.severity==='warning').length}};
}
