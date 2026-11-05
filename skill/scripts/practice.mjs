import * as T from '../assets/vendor/three/build/three.module.js';
import {sha} from './core.mjs';

// Original segmented mannequin and authored curves; no game or purchased assets.
function make(fixed){
 const d={asset:{version:'2.0',generator:'game-motion-feedback original teaching rig v1'},scene:0,scenes:[{nodes:[0]}],nodes:[],meshes:[],materials:[],accessors:[],bufferViews:[],buffers:[],animations:[]},chunks=[];let offset=0;
 function acc(a,type,minmax=false){const bytes=Buffer.from(a.buffer,a.byteOffset,a.byteLength),pad=(4-bytes.length%4)%4,index=d.accessors.length;
  d.bufferViews.push({buffer:0,byteOffset:offset,byteLength:bytes.length});chunks.push(bytes,Buffer.alloc(pad));offset+=bytes.length+pad;
  const size={SCALAR:1,VEC3:3,VEC4:4}[type],x={bufferView:d.bufferViews.length-1,componentType:a instanceof Uint32Array?5125:5126,count:a.length/size,type};
  if(minmax){x.min=Array.from({length:size},(_,j)=>Math.min(...Array.from(a).filter((_,i)=>i%size===j)));x.max=Array.from({length:size},(_,j)=>Math.max(...Array.from(a).filter((_,i)=>i%size===j)));}d.accessors.push(x);return index;
 }
 function mat(name,color,metal=.1){d.materials.push({name,pbrMetallicRoughness:{baseColorFactor:[...color,1],metallicFactor:metal,roughnessFactor:.48}});return d.materials.length-1;}
 const ivory=mat('Ceramic',[.76,.82,.81]),dark=mat('Graphite',[.065,.09,.12]),gold=mat('Brass',[.94,.59,.21],.6),joint=mat('Joint',[.20,.28,.34]);
 const shapes=new Map();function mesh(kind,material){const key=kind+'-'+material;if(shapes.has(key))return shapes.get(key);const g=kind==='sphere'?new T.SphereGeometry(1,20,12):new T.BoxGeometry(1,1,1);
  const primitive={attributes:{POSITION:acc(g.attributes.position.array,'VEC3',true),NORMAL:acc(g.attributes.normal.array,'VEC3')},indices:acc(new Uint32Array(g.index.array),'SCALAR'),material};d.meshes.push({primitives:[primitive]});const i=d.meshes.length-1;shapes.set(key,i);g.dispose();return i;}
 function node(name,parent,translation=[0,0,0],m=null,scale=null){const n={name,translation};if(m!==null)n.mesh=m;if(scale)n.scale=scale;const i=d.nodes.length;d.nodes.push(n);if(parent!==null)(d.nodes[parent].children??=[]).push(i);return i;}
 const root=node('Root',null),hips=node('Hips',root,[0,1.03,0]);node('PelvisShell',hips,[0,.01,0],mesh('box',dark),[.46,.19,.28]);
 const body=node('Spine',hips,[0,.18,0]);node('TorsoShell',body,[0,.13,0],mesh('box',ivory),[.56,.47,.29]);node('ChestBadge',body,[0,.22,.155],mesh('box',gold),[.13,.08,.025]);
 const head=node('Head',body,[0,.62,0]);node('HeadShell',head,[0,0,0],mesh('sphere',ivory),[.19,.22,.18]);node('Visor',head,[0,.015,.16],mesh('box',dark),[.27,.065,.035]);
 const bones={};for(const [side,x]of[['Left',.37],['Right',-.37]]){
  const s=node(side+'Shoulder',body,[x,.32,0]);bones[side+'Shoulder']=s;node(side+'ShoulderJoint',s,[0,0,0],mesh('sphere',gold),[.09,.09,.09]);node(side+'UpperArm',s,[0,-.18,0],mesh('box',dark),[.13,.30,.14]);
  const e=node(side+'Elbow',s,[0,-.36,0]);bones[side+'Elbow']=e;node(side+'ElbowJoint',e,[0,0,0],mesh('sphere',joint),[.08,.08,.08]);node(side+'Forearm',e,[0,-.16,0],mesh('box',ivory),[.12,.26,.13]);node(side+'Hand',e,[0,-.34,0],mesh('sphere',gold),[.08,.105,.075]);
  const h=node(side+'Hip',hips,[x*.46,-.08,0]);bones[side+'Hip']=h;node(side+'Thigh',h,[0,-.22,0],mesh('box',dark),[.18,.36,.20]);const k=node(side+'Knee',h,[0,-.44,0]);bones[side+'Knee']=k;
  node(side+'KneeJoint',k,[0,0,0],mesh('sphere',gold),[.095,.095,.095]);node(side+'Shin',k,[0,-.19,0],mesh('box',ivory),[.15,.30,.17]);node(side+'Foot',k,[0,-.38,.07],mesh('box',dark),[.19,.12,.34]);
 }
 function rotation(name,t,clip){const p=t*Math.PI*2,sign=name.startsWith('Left')?1:-1;let x=0,y=0,z=0;
  if(name.endsWith('Shoulder')){x=.62*Math.sin(p)*sign;z=sign*.10;if(name==='LeftShoulder'&&clip==='Run')z=fixed?.22:-.90;if(clip==='Salute'&&name==='RightShoulder'){x=-.5-Math.sin(t/1.5*Math.PI)*1.5;z=-.2;}}
  if(name.endsWith('Elbow'))x=-.7-.14*Math.sin(p)*sign;
  if(name.endsWith('Hip'))x=-.65*Math.sin(p)*sign;
  if(name.endsWith('Knee'))x=.15+.75*Math.max(0,Math.sin(p)*sign);
  return new T.Quaternion().setFromEuler(new T.Euler(x,y,z)).toArray();
 }
 for(const [clip,dur]of[['Run',1],['Salute',1.5]]){const times=new Float32Array(Array.from({length:Math.round(dur*60)+1},(_,i)=>i/60)),input=acc(times,'SCALAR',true),a={name:clip,samplers:[],channels:[]};
  for(const [name,id]of Object.entries(bones)){const values=new Float32Array(Array.from(times).flatMap(t=>rotation(name,t,clip)));const output=acc(values,'VEC4');a.samplers.push({input,output,interpolation:'LINEAR'});a.channels.push({sampler:a.samplers.length-1,target:{node:id,path:'rotation'}});}d.animations.push(a);
 }
 d.buffers=[{byteLength:offset}];return{d,bin:Buffer.concat(chunks),rotation};
}
export async function buildDemo(fixed){const{d,bin}=make(fixed),raw=Buffer.from(JSON.stringify(d)),j=Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,32)]),h=Buffer.alloc(20),b=Buffer.alloc(8);h.writeUInt32LE(0x46546c67);h.writeUInt32LE(2,4);h.writeUInt32LE(28+j.length+bin.length,8);h.writeUInt32LE(j.length,12);h.writeUInt32LE(0x4e4f534a,16);b.writeUInt32LE(bin.length);b.writeUInt32LE(0x004e4942,4);return Buffer.concat([h,j,b,bin]);}
export async function measureDemo(){
 const before=make(false),after=make(true);let unchanged=true,leftMinBefore=Infinity,leftMinAfter=Infinity;
 for(const [label,m]of[['before',before],['after',after]])for(let i=0;i<=120;i++){
  const t=i/120,q=new T.Quaternion().fromArray(m.rotation('LeftShoulder',t,'Run')),elbow=new T.Quaternion().fromArray(m.rotation('LeftElbow',t,'Run'));
  const wrist=new T.Vector3(0,-.34,0).applyQuaternion(elbow).add(new T.Vector3(0,-.36,0)).applyQuaternion(q).add(new T.Vector3(.37,1.53,0));
  if(label==='before')leftMinBefore=Math.min(leftMinBefore,Math.abs(wrist.x));else leftMinAfter=Math.min(leftMinAfter,Math.abs(wrist.x));
  for(const n of ['RightShoulder','RightElbow','LeftHip','RightHip','LeftKnee','RightKnee'])if(JSON.stringify(before.rotation(n,t,'Run'))!==JSON.stringify(after.rotation(n,t,'Run')))unchanged=false;
 }
 return{sampleCount:121,cycleSeconds:1,otherLimbCurvesUnchanged:unchanged,leftWristMinDistanceFromMidlineBefore:leftMinBefore,leftWristMinDistanceFromMidlineAfter:leftMinAfter,scope:'Joint location only; not continuous mesh collision proof or artistic approval'};
}
