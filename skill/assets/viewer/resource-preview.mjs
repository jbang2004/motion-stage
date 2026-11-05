import {resourceCapabilities,curveDescriptor,curveClips} from './resource-capabilities.mjs';

// Use only the scene and transforms authored in the resource. No template rig.
export async function prepareResource(gltf,T){
 const doc=gltf.parser.json,capabilities=resourceCapabilities(doc);curveClips(doc);
 let root=gltf.scene;
 if(!root){root=new T.Group();const children=new Set((doc.nodes||[]).flatMap(n=>n.children||[]));
  for(let i=0;i<(doc.nodes||[]).length;i++)if(!children.has(i))root.add(await gltf.parser.getDependency('node',i));
  if(!doc.nodes?.length)for(let i=0;i<(doc.meshes||[]).length;i++)root.add(await gltf.parser.getDependency('mesh',i));
 }
 root.updateMatrixWorld(true);const meshes=[],joints=[],seen=new Set(),indices=new Set(capabilities.jointIndices);
 const add=o=>{if(!seen.has(o.uuid)){seen.add(o.uuid);joints.push(o);}};
 root.traverse(o=>{if(o.isMesh){meshes.push(o);for(const b of o.skeleton?.bones||[])add(b);}const index=gltf.parser.associations?.get(o)?.nodes;if(o.isBone||indices.has(index)||!capabilities.hasMesh&&index!==undefined)add(o);});
 // Segmented models can animate real transform nodes without a skin.
 for(const clip of gltf.animations)for(const track of clip.tracks){const binding=T.PropertyBinding.parseTrackName(track.name),node=root.getObjectByName(binding.nodeName);if(node&&node!==root&&!node.isMesh)add(node);}
 if(joints.length>5000)throw Error('节点预览超过 5000 个可交互节点，请导出所需骨架或拆分资源；已有版本保持。');
 const bbox=new T.Box3();if(meshes.length)bbox.setFromObject(root);else for(const node of joints)bbox.expandByPoint(node.getWorldPosition(new T.Vector3()));
 if(bbox.isEmpty())bbox.expandByPoint(new T.Vector3());const span=bbox.getSize(new T.Vector3()),height=span.y>1e-6?span.y:Math.max(span.x,span.z,1);
 if(![...bbox.min.toArray(),...bbox.max.toArray(),height].every(Number.isFinite))throw Error('资源的空间变换无效');
 const curves=await Promise.all((curveDescriptor(doc)?.clips||[]).map(async clip=>({...clip,tracks:await Promise.all(clip.tracks.map(async t=>({...t,times:await gltf.parser.getDependency('accessor',t.input),values:await gltf.parser.getDependency('accessor',t.output)})))})));
 return {root,capabilities,meshes,joints,bbox,height,curves,clips:curves.length?curves.map(c=>new T.AnimationClip(c.name,c.duration,[])):gltf.animations};
}
const read=(a,i)=>a.getX(i);
export function curveValue(track,time,component=0){
 const n=track.times.count;let lo=0,hi=n-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(read(track.times,mid)<=time)lo=mid;else hi=mid-1;}
 const next=Math.min(n-1,lo+1),a=read(track.times,lo),b=read(track.times,next),ratio=b>a?Math.max(0,Math.min(1,(time-a)/(b-a))):0;
 return read(track.values,lo*track.width+component)*(1-ratio)+read(track.values,next*track.width+component)*ratio;
}
// Preserve extrema in each bucket so a brief spike does not disappear at zoom-out.
export function curveSamples(track,component=0,budget=600){
 const n=track.times.count,step=Math.max(1,Math.ceil(n/Math.max(2,budget/2))),indices=new Set([0,n-1]);
 for(let start=0;start<n;start+=step){let min=start,max=start;for(let i=start+1;i<Math.min(n,start+step);i++){const v=read(track.values,i*track.width+component);if(v<read(track.values,min*track.width+component))min=i;if(v>read(track.values,max*track.width+component))max=i;}indices.add(min);indices.add(max);}
 return [...indices].sort((a,b)=>a-b).map(i=>[read(track.times,i),read(track.values,i*track.width+component)]);
}
export function createResourcePanel({document=globalThis.document,onChange=()=>{}}={}){
 const element=document.createElement('section');element.className='resource-panel';element.hidden=true;
 const note=document.createElement('p'),select=document.createElement('select'),component=document.createElement('select'),canvas=document.createElement('canvas');select.setAttribute('aria-label','曲线轨道');component.setAttribute('aria-label','曲线分量');canvas.setAttribute('aria-label','动画采样曲线');element.setAttribute('aria-label','资源检查');element.append(select,component,canvas,note);
 let current=null,clip=null,track=null,lastClip=null,samples=[],range=[0,1],sharedRange=null,time=0;
 const option=(text,value)=>{const o=document.createElement('option');o.textContent=text;o.value=String(value);return o;};
 function choose(notify=true){track=clip?.tracks[Number(select.value)||0];component.replaceChildren();if(track){if(track.width<=4)component.append(option('全部分量',-1));for(let i=0;i<track.width;i++)component.append(option('分量 '+(i+1),i));}rebuild(notify);}
 function rebuild(notify=true){samples=[];if(track){const components=Number(component.value)<0?Array.from({length:track.width},(_,i)=>i):[Number(component.value)||0];samples=components.map(i=>({i,points:curveSamples(track,i)}));const values=samples.flatMap(s=>s.points.map(p=>p[1])),lo=Math.min(...values),hi=Math.max(...values),pad=Math.max((hi-lo)*.08,.01);range=[lo-pad,hi+pad];}if(notify)onChange();}
 select.onchange=()=>choose();component.onchange=()=>rebuild();
 function paint(ctx,width,height){
  const domain=sharedRange||range;
  ctx.fillStyle='#161e2a';ctx.fillRect(0,0,width,height);ctx.font='12px sans-serif';ctx.fillStyle='#dce6f6';ctx.fillText((clip?.name||'资源信息')+' · '+time.toFixed(3)+' s',16,22);
  if(!track)return;ctx.fillStyle='#b7c7df';ctx.fillText(track.binding.slice(0,100)+' · '+track.kind,16,43);const x=54,y=54,w=Math.max(1,width-78),h=Math.max(1,height-96),duration=clip.duration||1;
  ctx.strokeStyle='#33445d';ctx.lineWidth=1;for(let i=0;i<=4;i++){const yy=y+h*i/4;ctx.beginPath();ctx.moveTo(x,yy);ctx.lineTo(x+w,yy);ctx.stroke();ctx.fillText((domain[1]-(domain[1]-domain[0])*i/4).toPrecision(3),4,yy+4);}ctx.fillText('0 s',x,y+h+20);ctx.fillText(duration.toFixed(3)+' s',Math.max(x,x+w-58),y+h+20);
  const colors=['#8fbafa','#f2c886','#a3d7b8','#d3adfa'];for(const [j,s]of samples.entries()){ctx.strokeStyle=colors[j%colors.length];ctx.beginPath();for(const [i,p]of s.points.entries()){const px=x+p[0]/duration*w,py=y+(domain[1]-p[1])/(domain[1]-domain[0])*h;i?ctx.lineTo(px,py):ctx.moveTo(px,py);}ctx.stroke();}
  ctx.strokeStyle='#ffffff';ctx.beginPath();ctx.moveTo(x+Math.min(time,duration)/duration*w,y);ctx.lineTo(x+Math.min(time,duration)/duration*w,y+h);ctx.stroke();ctx.fillStyle='#dce6f6';ctx.fillText(samples.map(s=>'v'+(s.i+1)+' = '+curveValue(track,time,s.i).toPrecision(4)).join('   '),16,height-12);
 }
 function render(model,at){current=model;time=at;const visible=model&&['curves','metadata'].includes(model.capabilities.preview);element.hidden=!visible;if(!visible)return;
  const next=model.curves.find(c=>c.name===model.clip)||null;if(next!==lastClip){clip=lastClip=next;select.replaceChildren();for(const [i,t]of clip?.tracks.entries()||[])select.append(option(t.binding,i));choose(false);}
 note.textContent=model.capabilities.limitations.join('；');note.title=note.textContent;select.hidden=component.hidden=canvas.hidden=!clip;
  if(clip){const r=canvas.getBoundingClientRect(),w=Math.max(200,Math.round(r.width)),h=Math.max(200,Math.round(r.height));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}paint(canvas.getContext('2d'),w,h);}
 }
 return {element,render,paint,get range(){return range;},setDomain(value){sharedRange=value;},redraw(){if(clip)paint(canvas.getContext('2d'),canvas.width,canvas.height);},observe:()=>track?{kind:'curve',binding:track.binding,component:Number(component.value),clip:clip.name,time}:null,restore(observation){if(observation?.kind!=='curve'||!clip||observation.clip!==clip.name)return;const i=clip.tracks.findIndex(t=>t.binding===observation.binding);if(i<0)return;select.value=String(i);choose(false);if([...component.options].some(o=>Number(o.value)===observation.component)){component.value=String(observation.component);rebuild(false);}},get model(){return current;}};
}

export function resourceFrame(box){
 const span={x:box.max.x-box.min.x,y:box.max.y-box.min.y,z:box.max.z-box.min.z};
 const extent=Math.max(span.x,span.y,span.z)||1,factor=2/extent;
 return {factor,offset:[-(box.min.x+box.max.x)/2*factor,-box.min.y*factor,-(box.min.z+box.max.z)/2*factor],targetY:span.y*factor/2};
}
