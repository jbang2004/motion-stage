import {curveDescriptor,meshoptExtension} from '../assets/viewer/resource-capabilities.mjs';
import {glbInfo} from './core.mjs';
import {parseGlb} from './asset-tools.mjs';

const widths={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
const sizes={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const requireValue=(ok,message)=>{if(!ok)throw Error('候选校验失败：'+message);};
function uriBytes(payload){
 const raw=Buffer.from(payload),out=Buffer.allocUnsafe(raw.length);let size=0;
 const hex=c=>c>=48&&c<=57?c-48:(c|32)>=97&&(c|32)<=102?(c|32)-87:-1;
 for(let i=0;i<raw.length;i++){
  if(raw[i]===37&&i+2<raw.length){const hi=hex(raw[i+1]),lo=hex(raw[i+2]);if(hi>=0&&lo>=0){out[size++]=hi*16+lo;i+=2;continue;}}
  out[size++]=raw[i];
 }
 return out.subarray(0,size);
}

// A bounded file/data check, not a second renderer or an artistic approval.
// Compressed payloads remain the existing viewer decoder's responsibility.
export function validateCandidate(bytes,requiredClips=[],requiredCapabilities){
 requireValue(bytes.length<=200*1024*1024,'模型超过 200 MB');
 const info=glbInfo(bytes),{doc,bin}=parseGlb(bytes),limitations=new Set();
 if(requiredCapabilities?.hasMesh)requireValue(info.capabilities.hasMesh,'候选丢失了原有模型网格');
 if(requiredCapabilities?.hasRig)requireValue(info.capabilities.hasRig,'候选丢失了原有骨架信息');
 if(requiredCapabilities?.preview==='curves')requireValue(info.capabilities.preview==='curves','候选丢失了原有采样曲线');
 const missing=requiredClips.filter(c=>!info.clips.some(x=>x.name===c.name));
 requireValue(!missing.length,'候选缺少原有动作 '+missing.map(c=>c.name).join('、')+'；其他已存在动作必须保留');
 const buffers=(doc.buffers||[]).map((b,i)=>{
  requireValue(integer(b.byteLength,1),'buffer 长度无效');
  let data;
  if(b.uri){
   const match=/^data:([^,]*),(.*)$/s.exec(b.uri);
   requireValue(match,'buffer 需要嵌入 BIN 或 data URI');
   data=/;base64$/i.test(match[1])?Buffer.from(match[2],'base64'):uriBytes(match[2]);
  }else if(i===0&&bin.length)data=bin;
  if(data)requireValue(data.length>=b.byteLength,'buffer 数据不完整');
  else requireValue(meshoptExtension(b)?.fallback===true,'缺少嵌入 buffer 数据');
  return data;
 });
 function view(index){const v=doc.bufferViews?.[index];requireValue(integer(index)&&v,'bufferView 引用无效');return v;}
 function region(index,offset,length){
  const v=view(index),b=doc.buffers?.[v.buffer],start=(v.byteOffset||0)+offset;
  requireValue(b&&integer(offset)&&integer(length)&&offset+length<=v.byteLength,'accessor 超出 bufferView 范围');
  if(meshoptExtension(v)||!buffers[v.buffer]){
   limitations.add('压缩数据仅检查容器与引用，实际解码由工作台预览完成。');return null;
  }
  return {data:buffers[v.buffer],start};
 }
 for(const v of doc.bufferViews||[]){
  const b=doc.buffers?.[v.buffer];
  requireValue(integer(v.buffer)&&b&&integer(v.byteOffset||0)&&integer(v.byteLength,1)&&(v.byteOffset||0)+v.byteLength<=b.byteLength,'bufferView 超出 buffer 范围');
  if(v.byteStride!==undefined)requireValue(integer(v.byteStride,4)&&v.byteStride<=252&&v.byteStride%4===0,'bufferView 步长无效');
  const e=meshoptExtension(v);
  if(e){const data=buffers[e.buffer];requireValue(data&&integer(e.byteOffset||0)&&integer(e.byteLength,1)&&(e.byteOffset||0)+e.byteLength<=data.length,'压缩 bufferView 数据不完整');}
 }
 let floatValuesChecked=0;
 const accessors=(doc.accessors||[]).map(a=>{
  const width=widths[a.componentType],size=sizes[a.type];
  requireValue(width&&size&&integer(a.count,1),'accessor 类型或数量无效');
  const columns=/^MAT/.test(a.type)?Number(a.type.at(-1)):1;
  const elementBytes=columns>1?columns*Math.ceil(columns*width/4)*4:size*width;
  let base=null,stride=elementBytes;
  if(a.bufferView!==undefined){
   const v=view(a.bufferView);stride=v.byteStride||elementBytes;
   requireValue(stride>=elementBytes&&stride%width===0,'accessor 步长无效');
   base=region(a.bufferView,a.byteOffset||0,(a.count-1)*stride+elementBytes);
  }else requireValue(!a.byteOffset,'没有 bufferView 的 accessor 不能有偏移');
  function finiteFloats(r,count,step){
   if(a.componentType!==5126||!r)return;
   for(let i=0;i<count;i++)for(let k=0;k<size;k++){
    requireValue(Number.isFinite(r.data.readFloatLE(r.start+i*step+k*4)),'模型含有非有限数值');floatValuesChecked++;
   }
  }
  finiteFloats(base,a.count,stride);
  if(a.sparse){
   const s=a.sparse,w=widths[s.indices?.componentType];
   requireValue(integer(s.count,1)&&s.count<=a.count&&[5121,5123,5125].includes(s.indices?.componentType),'sparse accessor 描述无效');
   const indices=region(s.indices.bufferView,s.indices.byteOffset||0,s.count*w),values=region(s.values?.bufferView,s.values?.byteOffset||0,s.count*elementBytes);
   if(indices){let last=-1;for(let i=0;i<s.count;i++){const n=indices.data.readUIntLE(indices.start+i*w,w);requireValue(n>last&&n<a.count,'sparse 索引无效');last=n;}}
   finiteFloats(values,s.count,elementBytes);
  }
  const readable=!a.sparse&&(a.bufferView===undefined||base);
  return {a,read:readable?(i,k=0)=>{
   if(!base)return 0;const at=base.start+i*stride+k*width;
   let value=a.componentType===5126?base.data.readFloatLE(at):[5120,5122].includes(a.componentType)?base.data.readIntLE(at,width):base.data.readUIntLE(at,width);
   if(a.normalized&&a.componentType!==5126)value=[5120,5122].includes(a.componentType)?Math.max(-1,value/(2**(8*width-1)-1)):value/(2**(8*width)-1);
   return value;
  }:null};
 });
 // JSON overflow (for example 1e999) must not bypass binary float checks.
 const pending=[doc];while(pending.length){const value=pending.pop();if(typeof value==='number')requireValue(Number.isFinite(value),'场景含有非有限数值');else if(value&&typeof value==='object')for(const child of Object.values(value))pending.push(child);}
 for(const node of doc.nodes||[])for(const[key,size]of [['translation',3],['rotation',4],['scale',3],['matrix',16]])if(node[key]!==undefined)requireValue(Array.isArray(node[key])&&node[key].length===size&&node[key].every(Number.isFinite),'节点变换无效');
 for(const animation of doc.animations||[]){
  const checkedTimes=new Set(),targets=new Set();
  requireValue(animation.channels?.length&&animation.samplers?.length,'动作缺少通道或采样器');
  for(const channel of animation.channels){
   const sampler=animation.samplers[channel.sampler],input=accessors[sampler?.input],output=accessors[sampler?.output],path=channel.target?.path;
   requireValue(integer(channel.sampler)&&sampler&&integer(sampler.input)&&integer(sampler.output)&&input&&output,'动画采样器或 accessor 引用无效');
   requireValue(integer(channel.target?.node)&&doc.nodes?.[channel.target.node]&&['translation','rotation','scale','weights'].includes(path),'动画目标无效');
   const key=channel.target.node+':'+path;requireValue(!targets.has(key),'动画目标通道重复');targets.add(key);
   const interpolation=sampler.interpolation||'LINEAR',factor=interpolation==='CUBICSPLINE'?3:1;
   requireValue(['LINEAR','STEP','CUBICSPLINE'].includes(interpolation),'动画插值方式无效');
   const outputType=output.a.componentType===5126||['rotation','weights'].includes(path)&&output.a.normalized&&[5120,5121,5122,5123].includes(output.a.componentType);
   requireValue(input.a.type==='SCALAR'&&input.a.componentType===5126&&outputType,'动画 accessor 类型无效');
   const count=input.a.count*factor;
   const morphs=doc.meshes?.[doc.nodes[channel.target.node].mesh]?.primitives?.[0]?.targets?.length||0;
   requireValue(path==='weights'?output.a.type==='SCALAR'&&morphs>0&&output.a.count===count*morphs:output.a.type===(path==='rotation'?'VEC4':'VEC3')&&output.a.count===count,'动画输入输出数量不匹配');
   if(input.read&&!checkedTimes.has(sampler.input)){
    let previous=-1;for(let i=0;i<input.a.count;i++){const t=input.read(i);requireValue(t>=0&&t>previous,'动画时间必须非负且严格递增');previous=t;}
    requireValue(Math.abs(previous-input.a.max?.[0])<=1e-5*Math.max(1,previous),'动画时间范围与数据不一致');checkedTimes.add(sampler.input);
   }else if(!input.read)limitations.add('稀疏或压缩动画的时间顺序由工作台解码检查，未作数据展开。');
   if(path==='rotation'&&output.read)for(let i=0;i<input.a.count;i++){
    const row=i*factor+(factor===3?1:0);requireValue(Math.hypot(...[0,1,2,3].map(k=>output.read(row,k)))>1e-10,'动画含有零旋转四元数');
   }
  }
 }
 const curves=curveDescriptor(doc);
 for(const clip of curves?.clips||[])for(const track of clip.tracks){
  const input=accessors[track.input],output=accessors[track.output];requireValue(input?.read&&output?.read,'曲线数据必须可直接读取');
  let previous=-1;for(let i=0;i<input.a.count;i++){const t=input.read(i);requireValue(t>=0&&t>previous&&t<=clip.duration+1e-5,'曲线时间超出动作或没有严格递增');previous=t;}
  requireValue(Math.abs(previous-clip.duration)<=1e-5*Math.max(1,clip.duration),'曲线没有覆盖声明的动作时长');
  if(track.kind==='quaternion')for(let i=0;i<input.a.count;i++)requireValue(Math.hypot(...[0,1,2,3].map(k=>output.read(i*4+k)))>1e-10,'曲线含有零旋转四元数');
 }
 return {kind:'candidate-file-check',floatValuesChecked,requiredClips:requiredClips.map(c=>c.name),limitations:[...limitations],artisticAcceptance:'pending-user-review'};
}
