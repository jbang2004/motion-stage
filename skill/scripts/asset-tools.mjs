import {resourceCapabilities,curveDescriptor,curveClips,meshoptExtension} from '../assets/viewer/resource-capabilities.mjs';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,stat,realpath,mkdtemp,symlink,unlink,rmdir} from 'node:fs/promises';
import {resolve,dirname,basename,join,parse,relative,isAbsolute,posix} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {blenderExecutable,commandSpec,pathWithin} from './platform-runtime.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const sizes={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
const components={5120:[1,'readInt8'],5121:[1,'readUInt8'],5122:[2,'readInt16LE'],5123:[2,'readUInt16LE'],5125:[4,'readUInt32LE'],5126:[4,'readFloatLE']};
const bounds=values=>values.reduce(([lo,hi],v)=>[Math.min(lo,v),Math.max(hi,v)],[Infinity,-Infinity]);
export function parseGlb(input){
 const bytes=Buffer.from(input);
 if(bytes.length<20||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw Error('需要完整的 glTF 2.0 GLB 文件。');
 let doc,bin=Buffer.alloc(0),offset=12;const extra=[];
 while(offset<bytes.length){if(offset+8>bytes.length)throw Error('GLB 数据块头不完整。');const n=bytes.readUInt32LE(offset),type=bytes.readUInt32LE(offset+4);offset+=8;if(n%4||offset+n>bytes.length)throw Error('GLB 数据块长度或对齐无效。');const data=bytes.subarray(offset,offset+n);if(type===0x4e4f534a){if(doc)throw Error('GLB JSON 重复。');doc=JSON.parse(data.toString('utf8').trim());}else if(type===0x004e4942)bin=data;else extra.push({type,data});offset+=n;}
 if(!doc||doc.asset?.version!=='2.0')throw Error('GLB 缺少 glTF 2.0 场景描述。');
 for(const a of [...(doc.buffers||[]),...(doc.images||[])])if(a.uri&&!a.uri.startsWith('data:'))throw Error('请提供贴图和几何数据都已嵌入的自包含 GLB。');
 return{doc,bin,extra};
}
export function encodeGlb(doc,bin,extra=[]){
 const raw=Buffer.from(JSON.stringify(doc)),json=Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,32)]),chunks=[{type:0x4e4f534a,data:json}];
 if(bin.length)chunks.push({type:0x004e4942,data:Buffer.concat([bin,Buffer.alloc((4-bin.length%4)%4)])});chunks.push(...extra);
 const total=12+chunks.reduce((n,c)=>n+8+c.data.length,0),out=Buffer.alloc(total);out.writeUInt32LE(0x46546c67);out.writeUInt32LE(2,4);out.writeUInt32LE(total,8);let p=12;
 for(const c of chunks){out.writeUInt32LE(c.data.length,p);out.writeUInt32LE(c.type,p+4);c.data.copy(out,p+8);p+=8+c.data.length;}return out;
}
// A .gltf names its buffers and images by URIs relative to the .gltf file.
// Returns each external reference as a normalized project-relative path; data:
// URIs stay inline. Schemes, absolute paths and paths leaving the project fail.
export function gltfReferences(doc,file='model.gltf'){
 const dir=posix.dirname(String(file).replaceAll('\\','/')),refs=[];
 for(const kind of ['buffers','images'])(doc[kind]||[]).forEach((item,index)=>{
  if(item?.uri===undefined||String(item.uri).startsWith('data:'))return;
  let name;try{name=decodeURIComponent(String(item.uri)).replaceAll('\\','/');}catch{throw Error('glTF 文件引用编码无效：'+item.uri);}
  if(!name||name.includes('\0')||name.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(name))throw Error('glTF 只能引用项目内的相对文件：'+item.uri);
  const path=posix.normalize(posix.join(dir,name));
  if(path==='.'||path.split('/').includes('..'))throw Error('glTF 引用的文件不在项目内：'+item.uri);
  refs.push({kind,index,uri:item.uri,path});
 });
 return refs;
}
const IMAGE_TYPES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ktx2':'image/ktx2','.avif':'image/avif'};
function imageType(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
 if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
 if(bytes.subarray(0,4).toString('latin1')==='RIFF'&&bytes.subarray(8,12).toString('latin1')==='WEBP')return 'image/webp';
 if(bytes.subarray(1,7).toString('latin1')==='KTX 20')return 'image/ktx2';
 if(bytes.subarray(4,8).toString('latin1')==='ftyp'&&/^avi[fs]$/.test(bytes.subarray(8,12).toString('latin1')))return 'image/avif';
 return null;
}
function dataUri(uri){
 const comma=uri.indexOf(',');if(comma<0)throw Error('glTF data URI 无效');
 const head=uri.slice(5,comma),body=uri.slice(comma+1);
 return {mimeType:head.split(';')[0]||null,bytes:/;base64$/i.test(head)?Buffer.from(body,'base64'):Buffer.from(body.replace(/%([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))),'latin1')};
}
// Packs a parsed .gltf plus its referenced files (Map of project-relative path
// to bytes, keyed as gltfReferences returns them) into one self-contained GLB:
// every data buffer becomes a 4-byte-aligned slice of the BIN chunk and every
// external or data: image becomes a bufferView with a mimeType. Pure; no IO.
export function packGltf(input,files=new Map(),file='model.gltf',{maxBytes=200*1024*1024}={}){
 const doc=structuredClone(input);if(doc.asset?.version!=='2.0')throw Error('需要 glTF 2.0 模型');
 const paths=new Map(gltfReferences(doc,file).map(r=>[r.kind+':'+r.index,r.path])),parts=[];let length=0;
 const append=data=>{const start=length+(4-length%4)%4;if(start>length)parts.push(Buffer.alloc(start-length));parts.push(data);length=start+data.length;if(length>maxBytes)throw Error('glTF 打包后超过 '+Math.round(maxBytes/1048576)+' MB');return start;};
 const payload=(item,kind,index)=>{
  if(String(item.uri).startsWith('data:'))return dataUri(item.uri);
  const path=paths.get(kind+':'+index),bytes=files.get(path);if(!bytes?.length)throw Error('缺少 glTF 引用的文件或文件为空：'+path);return {bytes:Buffer.from(bytes),path};
 };
 const buffers=doc.buffers||[],fallback=b=>meshoptExtension(b)?.fallback===true;
 const placed=buffers.map((b,index)=>{
  if(!Number.isSafeInteger(b?.byteLength)||b.byteLength<1)throw Error('glTF buffer 长度无效');
  if(b.uri===undefined){if(fallback(b))return null;throw Error('glTF buffer 缺少数据；请导出带 .bin 的 glTF 或 GLB');}
  const {bytes,path}=payload(b,'buffers',index);if(bytes.length<b.byteLength)throw Error('glTF buffer 数据不完整：'+(path||'data URI'));
  return append(bytes.subarray(0,b.byteLength));
 });
 const images=(doc.images||[]).map((image,index)=>{
  if(image.uri===undefined)return null;
  const {bytes,mimeType,path}=payload(image,'images',index),type=image.mimeType||mimeType||imageType(bytes)||IMAGE_TYPES[posix.extname(path||'').toLowerCase()];
  if(!type)throw Error('无法识别 glTF 贴图格式：'+(path||'data URI'));
  return {start:append(bytes),length:bytes.length,type};
 });
 const out=length?[{byteLength:length}]:[],target=placed.map((start,i)=>start===null?{buffer:out.push(buffers[i])-1,offset:0}:{buffer:0,offset:start});
 const move=view=>{
  const at=target[view.buffer];if(!Number.isInteger(view.buffer)||!at)throw Error('glTF bufferView 引用无效');
  if(!Number.isSafeInteger(view.byteLength)||(view.byteOffset||0)+view.byteLength>buffers[view.buffer].byteLength)throw Error('glTF bufferView 超出 buffer 范围');
  view.buffer=at.buffer;if(at.offset)view.byteOffset=(view.byteOffset||0)+at.offset;
 };
 for(const view of doc.bufferViews||[]){move(view);for(const name of ['EXT_meshopt_compression','KHR_meshopt_compression'])if(view.extensions?.[name])move(view.extensions[name]);}
 images.forEach((slot,index)=>{if(!slot)return;const image=doc.images[index];delete image.uri;image.mimeType=slot.type;image.bufferView=(doc.bufferViews??=[]).push({buffer:0,byteOffset:slot.start,byteLength:slot.length})-1;});
 if(out.length)doc.buffers=out;else delete doc.buffers;
 return encodeGlb(doc,Buffer.concat(parts));
}
export function readAccessor(doc,bin,index){
 const a=doc.accessors?.[index],size=sizes[a?.type],component=components[a?.componentType];
 if(!a||!size||!component||!Number.isInteger(a.count)||a.count<0||a.count>20_000_000)throw Error('无法读取动画或网格 accessor。');
 if(a.sparse)throw Error('此操作暂不支持 sparse accessor；请用 Blender 重新导出未压缩动画。');
 const v=doc.bufferViews?.[a.bufferView];if(!v)return Array.from({length:a.count},()=>Array(size).fill(0));
 if(meshoptExtension(v))throw Error('此动画数据已压缩；请先在 Blender 中解码并重新导出，再进行本地微调。');
 if((v.buffer??0)!==0||doc.buffers?.[0]?.uri)throw Error('本地微调只支持嵌入 BIN 数据块的动画；请用 Blender 重新导出标准 GLB。');
 const [width,read]=component,stride=v.byteStride||size*width,start=(v.byteOffset||0)+(a.byteOffset||0);
 if(stride<size*width||start<0||a.count&&start+(a.count-1)*stride+size*width>bin.length||a.count&&((a.byteOffset||0)+(a.count-1)*stride+size*width>v.byteLength))throw Error('Accessor 超出二进制数据范围。');
 return Array.from({length:a.count},(_,i)=>Array.from({length:size},(_,j)=>{
  let n=bin[read](start+i*stride+j*width);if(!Number.isFinite(n))throw Error('模型含有非有限数值。');
  if(a.normalized){if(a.componentType===5121)n/=255;else if(a.componentType===5123)n/=65535;else if(a.componentType===5120)n=Math.max(-1,n/127);else if(a.componentType===5122)n=Math.max(-1,n/32767);}return n;
 }));
}
export function inspectAsset(bytes){
 const{doc:d,bin}=parseGlb(bytes),nodes=d.nodes||[],parents=new Map();nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parents.set(c,i)));
 const jointSkins=new Map();(d.skins||[]).forEach((s,i)=>(s.joints||[]).forEach(j=>{if(!jointSkins.has(j))jointSkins.set(j,[]);jointSkins.get(j).push(i);}));
 const animated=new Set((d.animations||[]).flatMap(a=>(a.channels||[]).map(c=>c.target?.node)).filter(Number.isInteger));
 const limitations=[];
 const clips=curveClips(d)||(d.animations||[]).map((a,index)=>{
  const ts=[];for(const s of a.samplers||[]){try{const input=readAccessor(d,bin,s.input).flat();if(input.length)ts.push(...bounds(input));}catch(e){const ac=d.accessors?.[s.input];if(ac?.min?.length&&ac?.max?.length)ts.push(ac.min[0],ac.max[0]);limitations.push(e.message);}}
  const startTime=ts.length?Math.min(...ts):0,endTime=ts.length?Math.max(...ts):0;
  return{name:a.name||'animation_'+index,index,duration:endTime,startTime,endTime,channels:(a.channels||[]).length,targets:(a.channels||[]).map(c=>({nodeIndex:c.target?.node,name:nodes[c.target?.node]?.name||'node_'+c.target?.node,path:c.target?.path}))};
 });
 const bones=nodes.flatMap((n,nodeIndex)=>jointSkins.has(nodeIndex)||animated.has(nodeIndex)?[{name:n.name||'node_'+nodeIndex,nodeIndex,parentIndex:parents.get(nodeIndex)??null,children:n.children||[],translation:n.translation||[0,0,0],rotation:n.rotation||[0,0,0,1],scale:n.scale||[1,1,1],matrix:n.matrix||null,skinIndices:jointSkins.get(nodeIndex)||[],animated:animated.has(nodeIndex)}]:[]);
 const meshes=nodes.flatMap((n,nodeIndex)=>Number.isInteger(n.mesh)?[(()=>{const m=d.meshes[n.mesh],ps=m.primitives||[],weights={sampledVertices:0,scanComplete:true,minimumSum:Infinity,maximumSum:-Infinity,jointNames:[]},names=new Set();
  for(const p of ps){if(p.attributes?.WEIGHTS_0===undefined)continue;try{const ws=readAccessor(d,bin,p.attributes.WEIGHTS_0),js=readAccessor(d,bin,p.attributes.JOINTS_0),take=Math.min(ws.length,4096);weights.scanComplete&&=take===ws.length;
   const sets=Object.keys(p.attributes).filter(k=>/^WEIGHTS_[1-9]/.test(k)).map(k=>({w:readAccessor(d,bin,p.attributes[k]),j:readAccessor(d,bin,p.attributes[k.replace('WEIGHTS_','JOINTS_')])}));
   for(let i=0;i<take;i++){let sum=0;for(const {w,j} of [{w:ws,j:js},...sets])for(let k=0;k<w[i].length;k++){sum+=w[i][k];if(w[i][k]>1e-5){const index=d.skins?.[n.skin]?.joints?.[j[i][k]];if(index!==undefined)names.add(nodes[index]?.name||'node_'+index);}}weights.minimumSum=Math.min(weights.minimumSum,sum);weights.maximumSum=Math.max(weights.maximumSum,sum);}weights.sampledVertices+=take;
  }catch(e){weights.scanComplete=false;limitations.push(e.message);}}
  weights.jointNames=[...names];if(!weights.sampledVertices){weights.minimumSum=null;weights.maximumSum=null;}
  return{name:n.name||m.name||'mesh_'+n.mesh,nodeIndex,meshIndex:n.mesh,skinIndex:n.skin??null,vertices:ps.reduce((v,p)=>v+(d.accessors?.[p.attributes?.POSITION]?.count||0),0),triangles:ps.reduce((v,p)=>v+((p.mode??4)===4?Math.floor((d.accessors?.[p.indices]?.count||d.accessors?.[p.attributes?.POSITION]?.count||0)/3):0),0),hasWeights:ps.some(p=>p.attributes?.WEIGHTS_0!==undefined),influenceSets:ps.reduce((v,p)=>Math.max(v,Object.keys(p.attributes||{}).filter(k=>/^WEIGHTS_/.test(k)).length),0),influenceSummary:weights,materialNames:[...new Set(ps.map(p=>d.materials?.[p.material]?.name||'material_'+p.material))]};})()]:[]);
 if(!clips.length)limitations.push('静态角色：可以检查外观与骨架；需要兼容动作后才能审阅运动。');
 if(!jointSkins.size&&meshes.some(m=>m.hasWeights===false))limitations.push('未发现蒙皮骨架。动画节点可能是分段角色或刚体，不代表已完成自动绑定。');
 return{version:1,kind:resourceCapabilities(d).kind,capabilities:resourceCapabilities(d),curveResource:curveDescriptor(d),sha256:digest(bytes),bytes:bytes.length,generator:d.asset?.generator||null,bones,meshes,clips,nodes:nodes.map((n,nodeIndex)=>({name:n.name||'node_'+nodeIndex,nodeIndex,parentIndex:parents.get(nodeIndex)??null,children:n.children||[],translation:n.translation||[0,0,0],rotation:n.rotation||[0,0,0,1],scale:n.scale||[1,1,1],matrix:n.matrix||null})),rigs:(d.skins||[]).map((s,index)=>{let inverseBindMatrices=null;try{if(s.inverseBindMatrices!==undefined)inverseBindMatrices=readAccessor(d,bin,s.inverseBindMatrices);}catch(e){limitations.push(e.message);}return{index,name:s.name||'skin_'+index,joints:s.joints||[],skeletonRoot:s.skeleton??null,inverseBindMatricesAccessor:s.inverseBindMatrices??null,inverseBindMatrices};}),materials:(d.materials||[]).map((m,index)=>({index,name:m.name||'material_'+index})),sourceCoordinates:{up:'Y',units:'meter',rotation:'xyzw'},limitations:[...new Set(limitations)],extensions:d.extensionsUsed||[]};
}
const norm=q=>{const n=Math.hypot(...q);if(n<1e-10||!Number.isFinite(n))throw Error('动画中存在无效旋转四元数。');return q.map(v=>v/n);};
const dot=(a,b)=>a.reduce((v,n,i)=>v+n*b[i],0);
function slerp(a,b,t){let c=dot(a,b);if(c<0){b=b.map(v=>-v);c=-c;}if(c>.9995)return norm(a.map((v,i)=>v+(b[i]-v)*t));const angle=Math.acos(Math.min(1,c)),s=Math.sin(angle);return norm(a.map((v,i)=>(v*Math.sin((1-t)*angle)+b[i]*Math.sin(t*angle))/s));}
const angle=(a,b)=>2*Math.acos(Math.min(1,Math.abs(dot(a,b))));
export function editGlb(input,{clip,bone,factor=.7,start,end}={}){
 const original=Buffer.from(input),{doc:d,bin,extra}=parseGlb(original);
 if(!Number.isFinite(factor)||factor<0||factor>2)throw Error('摆动系数需要在 0 到 2 之间；0.7 表示约保留七成摆动。');
 const matches=(d.nodes||[]).map((n,i)=>({n,i})).filter(({n,i})=>typeof bone==='number'?i===bone:(n.name||'node_'+i)===bone);
 if(matches.length!==1)throw Error(matches.length?'骨骼名称重复，请使用明确的节点索引。':'找不到指定骨骼，请先在角色上选择身体部位。');
 const nodeIndex=matches[0].i,nodeName=matches[0].n.name||'node_'+nodeIndex;
 const ai=(d.animations||[]).findIndex((a,i)=>(a.name||'animation_'+i)===clip);if(ai<0)throw Error('找不到指定动作，请重新选择动作。');
 const a=d.animations[ai],channels=a.channels.filter(c=>c.target.node===nodeIndex&&c.target.path==='rotation');
 if(channels.length!==1)throw Error('所选部位没有唯一的旋转动画轨道，无法使用摆动微调。可交给 Agent 进行更完整的修改。');
 const channel=channels[0],sampler=a.samplers[channel.sampler];if((sampler.interpolation||'LINEAR')!=='LINEAR')throw Error('本地摆动微调只支持 LINEAR 旋转轨道；STEP 或 CUBICSPLINE 请交给 Blender 处理。');
 const ta=d.accessors[sampler.input],oa=d.accessors[sampler.output];if(ta?.type!=='SCALAR'||oa?.type!=='VEC4'||oa.componentType!==5126)throw Error('动画轨道不是标准浮点旋转轨道。');
 const times=readAccessor(d,bin,sampler.input).flat(),rawQs=readAccessor(d,bin,sampler.output);
 if(times.length!==rawQs.length||times.length<2||times.length>200000||times.some((t,i)=>t<0||i&&t<=times[i-1]))throw Error('动画时间必须严格递增且与旋转关键帧一一对应；本地微调最多处理 20 万个关键帧。');
 const first=times[0],last=times.at(-1),lo=start===undefined?first:start,hi=end===undefined?last:end;
 if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo<first-1e-5||hi>last+1e-5||hi<=lo)throw Error('修改时间段需要落在当前动作内，并且结束时间大于开始时间。');
 const full=lo<=first+1e-5&&hi>=last-1e-5;let inserted=0;
 if(!full)for(const boundary of [lo,hi]){
  if(times.some(t=>Math.abs(t-boundary)<1e-7))continue;
  const i=times.findIndex(t=>t>boundary);if(i<1)continue;
  const q=slerp(norm(rawQs[i-1]),norm(rawQs[i]),(boundary-times[i-1])/(times[i]-times[i-1]));times.splice(i,0,boundary);rawQs.splice(i,0,q);inserted++;
 }
 const qs=rawQs.map(norm),chosen=qs.filter((q,i)=>times[i]>=lo-1e-7&&times[i]<=hi+1e-7);if(chosen.length<2)throw Error('所选时间段不足两个旋转关键帧，请扩大范围或交给 Agent。');
 const ref=chosen[0],aligned=chosen.map(q=>dot(ref,q)<0?q.map(v=>-v):q),mean=norm(aligned.reduce((sum,q)=>sum.map((v,i)=>v+q[i]),[0,0,0,0]));
 const ramp=(hi-lo)*.2;let changed=0;
 const output=qs.map((q,i)=>{
  const t=times[i];if(t<lo||t>hi)return rawQs[i];
  let w=1;if(!full){const x=Math.max(0,Math.min(1,(t-lo)/ramp,(hi-t)/ramp));w=x*x*(3-2*x);}
  if(w===0)return rawQs[i];const next=slerp(mean,q,1+(factor-1)*w);if(angle(q,next)>1e-7)changed++;return next;
 });
 if(!changed)throw Error('这次参数没有产生可见的旋转变化，请调整摆动系数或时间范围。');
 const bytes=Buffer.alloc(output.length*16);output.forEach((q,i)=>q.forEach((v,j)=>bytes.writeFloatLE(v,i*16+j*4)));
 const byteOffset=bin.length+(4-bin.length%4)%4,timeBytes=inserted?Buffer.alloc(times.length*4):Buffer.alloc(0);times.forEach((t,i)=>{if(inserted)timeBytes.writeFloatLE(t,i*4);});const newBin=Buffer.concat([bin,Buffer.alloc(byteOffset-bin.length),bytes,timeBytes]);
 d.bufferViews??=[];d.accessors??=[];const view=d.bufferViews.push({buffer:0,byteOffset,byteLength:bytes.length})-1,accessor=d.accessors.push({bufferView:view,componentType:5126,count:output.length,type:'VEC4'})-1;
 // Append and redirect only this channel. Existing shared accessors and samplers remain untouched.
 let inputAccessor=sampler.input;if(inserted){const timeView=d.bufferViews.push({buffer:0,byteOffset:byteOffset+bytes.length,byteLength:timeBytes.length})-1;inputAccessor=d.accessors.push({bufferView:timeView,componentType:5126,count:times.length,type:'SCALAR',min:[first],max:[last]})-1;}
 channel.sampler=a.samplers.push({...sampler,input:inputAccessor,output:accessor})-1;d.buffers[0].byteLength=newBin.length;
 const encoded=encodeGlb(d,newBin,extra),degrees=180/Math.PI;
 return{bytes:encoded,report:{kind:'deterministic-local-edit',agentGenerated:false,method:'quaternion-slerp-about-mean',sourceSha256:digest(original),candidateSha256:digest(encoded),clip,bone:nodeName,nodeIndex,factor,timeRange:[lo,hi],edgeBlend:full?'whole-clip':'smoothstep-20-percent',insertedBoundaryKeyframes:inserted,changedKeyframes:changed,totalKeyframes:times.length,beforeMaxDegrees:chosen.reduce((v,q)=>Math.max(v,angle(mean,q)),0)*degrees,afterMaxDegrees:output.reduce((v,q,i)=>times[i]>=lo&&times[i]<=hi?Math.max(v,angle(mean,q)):v,0)*degrees,preserved:{sourceBytes:true,geometry:true,skinWeights:true,materials:true,restPose:true,otherChannels:true,otherClips:true,inputTimes:!inserted},limitations:['Only the selected local rotation channel changes; descendant world poses follow the edited parent.','This is a parameterized tool, not an AI artistic judgment.','No proof of collision-free motion, contact retention or engine integration.'],artisticAcceptance:'pending-user-review'}};
}
export async function findBlender(explicit){
 return blenderExecutable({explicit});
}
/** Short native Windows access to existing files/directories (including packed
 * .blend files for a fresh-open check). Paths are valid only inside callback.
 * Junctions refer to the original directories; no project/model copy is made.
 * toOwned maps report paths back before the aliases are removed. */
export async function withBlenderFileAccess(paths,callback,{platform=process.platform}={}){
 const originals=paths.map(path=>resolve(path)),aliases=new Map();let temporary,failure;
 const toOwned=value=>{
  if(typeof value!=='string'||!isAbsolute(value))return value;
  for(const [target,alias]of aliases)if(pathWithin(alias,value))return join(target,relative(alias,value));
  return value;
 };
 try{
  const accessible=[];
  for(const path of originals){
   if(platform!=='win32'||path.length<=220){accessible.push(path);continue;}
   const isDirectory=(await stat(path)).isDirectory();let directory=isDirectory?path:dirname(path);
   temporary??=await mkdtemp(join(tmpdir(),'motion-blender-'));let alias=join(temporary,String(aliases.size));
   if(alias.length+1+(isDirectory?40:basename(path).length)>240)throw Error('Blender 临时路径过长；请将 TMP/TEMP 配置为较短的可写目录。');
   // Keep as much original directory topology as the short path budget allows,
   // so ../ texture references still resolve inside the original project tree.
   while(dirname(directory)!==directory&&join(alias,relative(dirname(directory),path)).length<=220)directory=dirname(directory);
   if(aliases.has(directory))alias=aliases.get(directory);
   else{await symlink(await realpath(directory),alias,'junction');aliases.set(directory,alias);}
   accessible.push(join(alias,relative(directory,path)));
  }
  return await callback(accessible,toOwned,[...aliases].map(([owned,native])=>({owned,native})));
 }catch(error){failure=error;throw error;}
 finally{
  try{
   // Never recursively remove an alias: unlink removes only the junction,
   // and rmdir succeeds only for the now-empty private temporary container.
   for(const alias of [...aliases.values()].reverse())await unlink(alias);
   if(temporary)await rmdir(temporary);
  }catch(error){if(failure&&error!==failure)error.cause??=failure;throw error;}
 }
}
async function runConversion(launch,timeoutMs){
 return new Promise(resolveRun=>{
  let child,stdout='',stderr='',settled=false,failure=null,timedOut=false,stopping=false,timer,killTimer,launchFailureTimer,stopError=null;
  const finish=(code=null,signal=null)=>{
   if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);clearImmediate(launchFailureTimer);
   resolveRun({code,signal,stdout,stderr,failure,timedOut,stopError});
  };
  const kill=signal=>{try{child.kill(signal);}catch(error){stopError??=error;}};
  const stop=()=>{
   if(stopping||settled)return;stopping=true;clearTimeout(timer);
   if(!child.pid){launchFailureTimer=setImmediate(()=>finish());return;}
   kill('SIGTERM');if(settled)return;
   killTimer=setTimeout(()=>{kill('SIGKILL');child.stdout?.destroy();child.stderr?.destroy();finish(null,'SIGKILL');},5000);
  };
  const fail=(stage,error)=>{
   if(settled)return;
   // A spawn failure may first surface as a broken pipe. Prefer the actual
   // child-process error if it follows, while keeping handlers on both pipes.
   if(!failure||stage==='launch')failure={stage,error};stop();
  };
  try{
   // Script, input and output arguments are absolute. Windows CreateProcessW
   // rejects cwd > MAX_PATH even when long file arguments are supported. The
   // executable's volume root is stable and independent of output nesting.
   child=spawn(launch.command,launch.args,{cwd:parse(launch.command).root,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});
  }catch(error){failure={stage:'launch',error};finish();return;}
  child.stdout?.on('error',error=>fail('stdout',error));child.stderr?.on('error',error=>fail('stderr',error));
  child.on('error',error=>fail('launch',error));child.on('close',finish);
  child.stdout?.on('data',b=>{stdout=(stdout+b).slice(-150000);});child.stderr?.on('data',b=>{stderr=(stderr+b).slice(-150000);});
  timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
 });
}
export async function convertFbx(sourcePath,outputDir,{blenderPath,fps,timeoutMs=180000}={}){
 const source=resolve(sourcePath),out=resolve(outputDir);if(fps!==undefined&&fps!==0&&(!Number.isInteger(fps)||fps<1||fps>240))throw Error('FBX 帧率应为 1 到 240；0 或不指定时自动读取文件。');
 const input=await readFile(source);if(!input.length||input.length>200*1024*1024)throw Error('FBX 文件为空或超过 200 MB。');
 try{await lstat(out);throw Error('转换目标已存在；请选择新的输出目录以保留历史。');}catch(e){if(e.code!=='ENOENT')throw e;}
 await mkdir(dirname(out),{recursive:true});try{await mkdir(out);}catch(e){if(e.code==='EEXIST')throw Error('转换目标已存在；请选择新的输出目录以保留历史。');throw e;}const blender=await findBlender(blenderPath),script=resolve(import.meta.dirname,'blender/convert_fbx.py');
 return withBlenderFileAccess([source,script,out],async([nativeSource,nativeScript,nativeOut],toOwned,mappings)=>{
 const args=['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',nativeScript,'--','--input',nativeSource,'--owned-input',source,'--output',nativeOut,'--owned-output',out,'--path-map',JSON.stringify(mappings),...(fps===undefined?[]:['--fps',String(fps)])];
 const launch=await commandSpec(blender,args);
 const run=await runConversion(launch,timeoutMs),failure=run.failure;
 await writeFile(join(out,'conversion.log'),run.stdout+'\n'+run.stderr+(failure?'\n['+failure.stage+'] '+(failure.error.stack||failure.error.message):'')+(run.timedOut?'\n[timeout] Blender conversion deadline exceeded':'')+(run.stopError?'\n[stop] '+run.stopError.message:''));
 if(failure){const error=Error((failure.stage==='launch'?'Blender 启动失败：':'Blender 输出管道失败（'+failure.stage+'）：')+failure.error.message,{cause:failure.error});error.code=failure.error.code;if(run.stopError)error.stopError=run.stopError;throw error;}
 if(run.timedOut||run.code!==0){let reason='';if(!run.timedOut)try{reason=JSON.parse(await readFile(join(out,'error.json'),'utf8')).error;}catch{}throw Error(reason|| (run.timedOut||run.signal?'FBX 转换超时或被中止；原文件已保留。':'FBX 转换失败，请查看转换日志。'));}
 const restore=value=>Array.isArray(value)?value.map(restore):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restore(item)])):toOwned(value);
 const report=restore(JSON.parse(await readFile(join(out,'source-map.json'),'utf8'))),glbPath=join(out,'converted.glb');inspectAsset(await readFile(glbPath));if(report.source.sha256!==digest(input))throw Error('转换期间源文件发生变化；已保留转换现场，请重新导入固定版本。');
 report.source.path=source;
 for(const image of report.externalImages||[])image.path=await realpath(image.path);
 await writeFile(join(out,'source-map.json'),JSON.stringify(report,null,2)+'\n');
 return{glbPath,source:report.source,report};
 });
}
