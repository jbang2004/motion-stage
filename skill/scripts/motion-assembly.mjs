import {parseSampledTracks} from './curve-resources.mjs';
import {Matrix4,Quaternion,Vector3,PropertyBinding} from '../assets/vendor/three/build/three.core.js';
import {parseGlb,encodeGlb,animationAccessorReader} from './asset-tools.mjs';

const requireValue=(value,message)=>{if(!value)throw Error(message);};
const shapes={translation:'VEC3',rotation:'VEC4',scale:'VEC3',weights:'SCALAR'};
const paths={position:'translation',quaternion:'rotation',scale:'scale',morphTargetInfluences:'weights'};
const finite=values=>values.every(Number.isFinite);

function graph(doc){
 const nodes=doc.nodes||[],names=new Map(),parents=new Map(),worlds=new Map();
 for(const[n,node]of nodes.entries()){
  for(const name of new Set([node.name, node.name&&PropertyBinding.sanitizeNodeName(node.name)]))if(name){if(!names.has(name))names.set(name,new Set());names.get(name).add(n);}
  for(const child of node.children||[]){requireValue(nodes[child]&&!parents.has(child),'节点层级无效或有多个父节点');parents.set(child,n);}
 }
 const local=i=>{const n=nodes[i];return n.matrix?new Matrix4().fromArray(n.matrix):new Matrix4().compose(new Vector3(...(n.translation||[0,0,0])),new Quaternion(...(n.rotation||[0,0,0,1])),new Vector3(...(n.scale||[1,1,1])));};
 const resolve=name=>{const found=names.get(name);requireValue(found?.size===1,'目标节点不存在或名称不唯一：'+name);return [...found][0];};
 function world(i){
  const path=[],seen=new Set();let at=i;
  while(at!==undefined&&!worlds.has(at)){requireValue(!seen.has(at),'骨架层级存在循环');seen.add(at);path.push(at);at=parents.get(at);}
  let matrix=at===undefined?new Matrix4():worlds.get(at);
  for(const n of path.reverse()){matrix=matrix.clone().multiply(local(n));worlds.set(n,matrix);}
  return worlds.get(i);
 }
 return {nodes,parents,local,world,resolve};
}
// Same-rig tolerance. A Blender glTF round trip of an unchanged Mixamo-style rig
// (import, delete mesh, export actions) moves rest-matrix elements by up to
// ~2.5e-5; distinct characters on that rig differ by ~1–2. 1e-4 accepts the
// former with margin and is still four orders of magnitude below the latter.
const REST_TOLERANCE=1e-4;
function equalMatrix(a,b){return a.elements.every((value,i)=>Number.isFinite(value)&&Math.abs(value-b.elements[i])<=REST_TOLERANCE*Math.max(1,Math.abs(value),Math.abs(b.elements[i])));}

export function motionTargetResolver(base,source,nodeMap={}){
 const from=graph(source),to=graph(base),mapped=new Map();
 function target(index){
  if(mapped.has(index))return mapped.get(index);
  const name=from.nodes[index]?.name;requireValue(name,'动画目标节点缺少名称，无法跨文件绑定');
  const dest=to.resolve(Object.hasOwn(nodeMap,name)?nodeMap[name]:name);
  requireValue(equalMatrix(from.local(index),to.local(dest))&&equalMatrix(from.world(index),to.world(dest)),'需要重定向：节点参考姿势或坐标不同：'+name);
  let parent=from.parents.get(index),destParent=to.parents.get(dest);
  while(parent!==undefined&&destParent!==undefined){const p=from.nodes[parent].name;requireValue((!p||to.nodes[destParent].name===(Object.hasOwn(nodeMap,p)?nodeMap[p]:p))&&equalMatrix(from.local(parent),to.local(destParent)),'需要重定向：父骨骼不同：'+name);parent=from.parents.get(parent);destParent=to.parents.get(destParent);}
  requireValue(parent===destParent,'需要重定向：父骨架深度不同：'+name);
  mapped.set(index,dest);return dest;
 }
 return target;
}

export async function gltfClips(base,bytes,options={}){
 const source=parseGlb(bytes);
 const read=animationAccessorReader(source.doc,source.bin);
 const target=motionTargetResolver(base,source.doc,options.nodeMap||{});
 return (source.doc.animations||[]).map((animation,index)=>({animation,index})).filter(({animation,index})=>!options.clips||options.clips.includes(animation.name||'animation_'+index)).map(({animation,index})=>{
  const name=animation.name||'animation_'+index;
  return {name,tracks:(animation.channels||[]).map(channel=>{
   const sampler=animation.samplers[channel.sampler],input=source.doc.accessors[sampler?.input],output=source.doc.accessors[sampler?.output],path=channel.target?.path;
   const component=output?.componentType===5126||['rotation','weights'].includes(path)&&output?.normalized&&[5120,5121,5122,5123].includes(output.componentType);
   requireValue(input&&output&&input.type==='SCALAR'&&input.componentType===5126&&component&&output.type===shapes[path]&&input.count<=200000&&output.count<=600000&&shapes[path],'动画轨道类型不支持或关键帧过多');
   return {node:target(channel.target.node),path,interpolation:sampler.interpolation||'LINEAR',times:read(sampler.input).flat(),values:read(sampler.output).flat(),type:output.type};
  })};
 });
}
function sampledClips(base,bytes,options){
 const nodes=graph(base),clips=parseSampledTracks(JSON.parse(bytes.toString('utf8')));
 return clips.filter(c=>!options.clips||options.clips.includes(c.name)).map(clip=>({name:clip.name,tracks:clip.tracks.map(t=>{
  const {binding,kind,width,times,values}=t,split=binding.lastIndexOf('.'),path=paths[binding.slice(split+1)];
  requireValue(split>0&&path&&(path==='weights'?kind==='number':path==='rotation'?kind==='quaternion'&&width===4:kind==='vector'&&width===3),'采样轨道目标或维度不正确：'+binding);
  const name=binding.slice(0,split);return {node:nodes.resolve(options.nodeMap?.[name]||name),path,interpolation:'LINEAR',times,values,type:shapes[path]};
 })}));
}

/** Compile declared sources into an owned preview. Each source is all-or-nothing;
 * incompatible or unsupported sources stay visible and do not hide base clips. */
export async function assembleCharacter(input,sources=[]){
 const {doc,bin,extra}=parseGlb(input),parts=[bin],origins=new Map(),reports=[];let length=bin.length;
 for(const[a,index]of (doc.animations||[]).map((a,i)=>[a,i]))origins.set(a.name||'animation_'+index,{file:null,sourceClip:a.name||'animation_'+index,format:'embedded'});
 doc.bufferViews??=[];doc.accessors??=[];doc.animations??=[];
 function accessor(values,type){
  const data=Buffer.alloc(values.length*4);values.forEach((v,i)=>data.writeFloatLE(v,i*4));
  const view=doc.bufferViews.push({buffer:0,byteOffset:length,byteLength:data.length})-1;parts.push(data);length+=data.length;
  const width={SCALAR:1,VEC3:3,VEC4:4}[type];requireValue(width&&values.length%width===0,'动画 accessor 维度无效');
  return doc.accessors.push({bufferView:view,componentType:5126,count:values.length/width,type,...(type==='SCALAR'?{min:[values.reduce((a,b)=>Math.min(a,b),Infinity)],max:[values.reduce((a,b)=>Math.max(a,b),-Infinity)]}:{})})-1;
 }
 for(const source of sources){
  const report={file:source.file,format:source.format,status:'ready',clips:[]};
  try{
   requireValue(source.bytes,'动作来源文件缺失或无法读取');
   requireValue(source.bytes.length<=50*1024*1024,'动作来源超过 50 MB，请拆分后关联');
   requireValue(doc.buffers?.[0]&&!doc.buffers[0].uri,'此主模型不支持追加动作，需要嵌入 BIN');
   let clips=['glb','gltf'].includes(source.format)?await gltfClips(doc,source.bytes,source):source.format==='sampled-tracks-v1'?sampledClips(doc,source.bytes,source):null;
   requireValue(clips,'此动作格式需要转换或项目导出器');
   if(source.clips){const wanted=new Set(source.clips);requireValue(source.clips.every(name=>clips.some(c=>c.name===name)),'指定的动作在来源中不存在');clips=clips.filter(c=>wanted.has(c.name));}
   requireValue(clips.length,'来源中没有可用动作');
   const names=new Set();
   for(const clip of clips){
    clip.outputName=(source.prefix||'')+clip.name;requireValue(!names.has(clip.outputName),'来源的动作名称重复');names.add(clip.outputName);
    requireValue(!origins.has(clip.outputName)||source.replace===true,'动作名称冲突，请设置前缀或明确覆盖规则：'+clip.outputName);
    requireValue(clip.tracks.length,'动作没有可绑定的轨道');
    const targets=new Set();
    for(const t of clip.tracks){
     t.times=t.times.map(Math.fround);t.values=t.values.map(Math.fround);
     const key=t.node+':'+t.path;requireValue(!targets.has(key),'动作目标轨道重复');targets.add(key);
     const factor=t.interpolation==='CUBICSPLINE'?3:1,width=t.path==='rotation'?4:t.path==='weights'?(doc.meshes?.[doc.nodes[t.node].mesh]?.primitives?.[0]?.targets?.length||0):3;
     requireValue(width>0&&['LINEAR','STEP','CUBICSPLINE'].includes(t.interpolation)&&t.values.length===t.times.length*width*factor&&finite(t.times)&&finite(t.values)&&t.times.every((v,i)=>v>=0&&(!i||v>t.times[i-1])),'动作的时间、数据或目标维度无效：'+clip.name);
     if(t.path==='rotation')for(let i=0;i<t.times.length;i++){const offset=(i*factor+(factor===3?1:0))*4;requireValue(Math.hypot(...t.values.slice(offset,offset+4))>1e-10,'动画含有零旋转四元数');}
    }
   }
   const added=clips.reduce((sum,c)=>sum+c.tracks.reduce((n,t)=>n+4*(t.times.length+t.values.length)+512,0),0);
   requireValue(input.length+length-bin.length+added<=200*1024*1024,'合成预览超过 200 MB，请减少所选动作');
   // No mutation above this point: a failed source cannot leave half its tracks.
   for(const clip of clips){
    const animation={name:clip.outputName,channels:[],samplers:[]};
    for(const t of clip.tracks){const sampler=animation.samplers.push({input:accessor(t.times,'SCALAR'),output:accessor(t.values,t.path==='weights'?'SCALAR':shapes[t.path]),interpolation:t.interpolation})-1;animation.channels.push({sampler,target:{node:t.node,path:t.path}});}
    const previous=doc.animations.findIndex(a=>a.name===clip.outputName);if(previous>=0)doc.animations[previous]=animation;else doc.animations.push(animation);
    origins.set(clip.outputName,{file:source.file,sourceClip:clip.name,format:source.format});report.clips.push(clip.outputName);
   }
  }catch(error){report.status=/重定向/.test(error.message)?'needs-retarget':/冲突|不唯一/.test(error.message)?'needs-confirmation':/转换|不支持/.test(error.message)?'unsupported':'unavailable';report.error=error.message;}
  reports.push(report);
 }
 const changed=parts.length>1;
 if(changed){requireValue(doc.buffers?.[0]&&!doc.buffers[0].uri,'预览合成需要嵌入 BIN 的主模型');doc.buffers[0].byteLength=length;}
 return {bytes:changed?encodeGlb(doc,Buffer.concat(parts),extra):Buffer.from(input),sources:reports,clips:Object.fromEntries(origins)};
}

/** A portable animation source: only reference nodes and selected curves, no geometry. */
export async function extractMotionPack(bytes,{clips}={}){
 const {doc}=parseGlb(bytes);
 const nodes=(doc.nodes||[]).map(n=>Object.fromEntries(Object.entries(n).filter(([k])=>['name','children','translation','rotation','scale','matrix'].includes(k))));
 const skeleton={asset:{version:'2.0',generator:'MotionStage shared motion pack'},nodes,scene:0,scenes:[{nodes:nodes.map((_,i)=>i).filter(i=>!nodes.some(n=>n.children?.includes(i)))}],buffers:[{byteLength:0}]};
 const result=await assembleCharacter(encodeGlb(skeleton,Buffer.alloc(0)),[{file:'motion-source',format:'glb',bytes,clips}]);
 if(result.sources[0]?.status!=='ready')throw Error(result.sources[0]?.error||'没有可提取的骨架动作');
 return result.bytes;
}
