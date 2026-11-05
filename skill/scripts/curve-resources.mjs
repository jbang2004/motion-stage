import {resourceCapabilities} from '../assets/viewer/resource-capabilities.mjs';
import {encodeGlb} from './asset-tools.mjs';
const check=(ok,message)=>{if(!ok)throw Error(message);};
export function isSampledTracks(data){return data?.format==='sampled-tracks-v1'||data?.clips&&typeof data.clips==='object'&&Object.values(data.clips).some(c=>Array.isArray(c?.tracks));}
export function parseSampledTracks(data){
 check(Number.isFinite(data?.fps)&&data.fps>0&&data.fps<=240&&data.clips&&typeof data.clips==='object'&&!Array.isArray(data.clips),'采样动作需要有效 fps 和 clips 对象');
 const entries=Object.entries(data.clips);check(entries.length>0&&entries.length<=1000,'采样动作数量需要为 1–1000');let valuesRead=0,storedValues=0;
 return entries.map(([name,clip])=>{
  check(name.length>0&&name.length<=200&&Number.isFinite(clip?.duration)&&clip.duration>0&&Number.isFinite(Math.fround(clip.duration))&&Math.fround(clip.duration)>0&&Array.isArray(clip.tracks)&&clip.tracks.length>0&&clip.tracks.length<=2000,'采样动作缺少有效名称、时长或轨道');
  const bindings=new Set();return {name,duration:Math.fround(clip.duration),tracks:clip.tracks.map(track=>{
   check(Array.isArray(track)&&track.length===4,'采样轨道需要名称、类型、维度和数据');const[binding,kind,width,raw]=track;
   check(typeof binding==='string'&&binding.length>0&&binding.length<=1000&&!bindings.has(binding),'采样轨道名称无效或重复');bindings.add(binding);
   check(['quaternion','vector','number'].includes(kind)&&Number.isInteger(width)&&width>=1&&width<=64&&(kind!=='quaternion'||width===4)&&Array.isArray(raw)&&raw.length>0&&raw.length%width===0,'采样轨道类型或维度无效：'+binding);
   check((valuesRead+=raw.length)<=12000000,'采样动作超过数据预算');const values=raw.map(Math.fround),count=values.length/width;check(values.every(Number.isFinite)&&count<=200000&&(count-1)/data.fps<=clip.duration+.5/data.fps,'采样动作数据、时长或关键帧数量无效');
   const times=Array.from({length:count},(_,i)=>Math.fround(Math.min(i/data.fps,clip.duration)));
   if(times.at(-1)<clip.duration-1e-6){times.push(Math.fround(clip.duration));values.push(...values.slice(-width));}
   check((storedValues+=values.length)<=13000000,'采样动作展开后超过数据预算');
   check(times.every((v,i)=>v>=0&&(!i||v>times[i-1]))&&times.at(-1)>0,'采样动作的时间无效');
   if(kind==='quaternion')for(let i=0;i<values.length;i+=4)check(Math.hypot(...values.slice(i,i+4))>1e-10,'动画含有零旋转四元数');
   return {binding,kind,width,times,values};
  })};
 });
}
export function sampledMetadata(data){const clips=parseSampledTracks(data);const capabilities=resourceCapabilities({extras:{motionStudio:{version:1,resource:'sampled-tracks-v1',clips}}});return {clips:clips.map(c=>({name:c.name,duration:c.duration})),static:false,kind:capabilities.kind,capabilities};}
export function createCurveResource(input){
 const data=JSON.parse(Buffer.from(input).toString('utf8')),clips=parseSampledTracks(data),parts=[],doc={asset:{version:'2.0',generator:'MotionStage curve inspection'},scene:0,scenes:[{nodes:[]}],nodes:[],buffers:[{byteLength:0}],bufferViews:[],accessors:[]};let size=0;
 const accessor=values=>{const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeFloatLE(v,i*4));const view=doc.bufferViews.push({buffer:0,byteOffset:size,byteLength:b.length})-1;parts.push(b);size+=b.length;return doc.accessors.push({bufferView:view,componentType:5126,count:values.length,type:'SCALAR',min:[values.reduce((a,b)=>Math.min(a,b),Infinity)],max:[values.reduce((a,b)=>Math.max(a,b),-Infinity)]})-1;};
 doc.extras={motionStudio:{version:1,resource:'sampled-tracks-v1',fps:data.fps,clips:clips.map(c=>({name:c.name,duration:c.duration,tracks:c.tracks.map(t=>({binding:t.binding,kind:t.kind,width:t.width,input:accessor(t.times),output:accessor(t.values)}))}))}};doc.buffers[0].byteLength=size;
 return encodeGlb(doc,Buffer.concat(parts));
}
