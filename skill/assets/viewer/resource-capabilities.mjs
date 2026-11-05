export const meshoptExtension=value=>value?.extensions?.KHR_meshopt_compression||value?.extensions?.EXT_meshopt_compression;
// Shared, metadata-only classification. Geometry, joints, skin and animation are
// independent capabilities; an empty node list is never called a skeleton.
export function curveDescriptor(doc){const value=doc.extras?.motionStudio;return value?.version===1&&value.resource==='sampled-tracks-v1'?value:null;}
export function curveClips(doc){
 const value=curveDescriptor(doc);if(!value)return null;
 if(!Number.isFinite(value.fps)||value.fps<=0||value.fps>240||doc.animations?.length||doc.nodes?.length||doc.meshes?.length||!Array.isArray(value.clips)||!value.clips.length||value.clips.length>1000)throw Error('曲线预览容器结构无效');
 let total=0;const names=new Set();
 return value.clips.map((clip,index)=>{
  if(typeof clip.name!=='string'||!clip.name||clip.name.length>200||names.has(clip.name)||!Number.isFinite(clip.duration)||clip.duration<=0||!Array.isArray(clip.tracks)||!clip.tracks.length||clip.tracks.length>2000)throw Error('曲线动作描述无效');names.add(clip.name);const bindings=new Set();
  for(const t of clip.tracks){const input=doc.accessors?.[t.input],output=doc.accessors?.[t.output];if(typeof t.binding!=='string'||!t.binding||t.binding.length>1000||bindings.has(t.binding)||!['quaternion','vector','number'].includes(t.kind)||!Number.isInteger(t.width)||t.width<1||t.width>64||t.kind==='quaternion'&&t.width!==4||!Number.isInteger(t.input)||!Number.isInteger(t.output)||input?.type!=='SCALAR'||output?.type!=='SCALAR'||input.componentType!==5126||output.componentType!==5126||!Number.isInteger(input.count)||!Number.isInteger(output.count)||input.count<1||input.count>200001||output.count!==input.count*t.width||(total+=output.count)>13000000)throw Error('曲线轨道引用、类型或数据数量无效');bindings.add(t.binding);}
  return {name:clip.name,index,duration:clip.duration};
 });
}
export function resourceCapabilities(doc){
 const nodes=doc.nodes||[],meshes=doc.meshes||[],skins=doc.skins||[],parents=new Map(),joints=new Set();
 if(nodes.length>100000)throw Error('节点数量超过预览预算');
 for(const[i,node]of nodes.entries()){
  for(const child of node.children||[]){if(!Number.isInteger(child)||!nodes[child]||parents.has(child))throw Error('节点层级引用无效或有多个父节点');parents.set(child,i);}
  if(node.mesh!==undefined&&(!Number.isInteger(node.mesh)||!meshes[node.mesh]))throw Error('节点网格引用无效');
  if(node.skin!==undefined&&(!Number.isInteger(node.skin)||!skins[node.skin]))throw Error('节点蒙皮引用无效');
  if(node.extras?.motionStudioJoint===true)joints.add(i);
 }
 const depths=new Map();
 for(let i=0;i<nodes.length;i++){
  let at=i;const path=[],seen=new Set();while(at!==undefined&&!depths.has(at)){if(seen.has(at))throw Error('节点层级存在循环');seen.add(at);path.push(at);at=parents.get(at);if(path.length>256)throw Error('节点层级超过 256 层');}
  let depth=at===undefined?0:depths.get(at);for(const n of path.reverse()){if(++depth>256)throw Error('节点层级超过 256 层');depths.set(n,depth);}
 }
 for(const skin of skins)for(const index of skin.joints||[]){if(!Number.isInteger(index)||!nodes[index])throw Error('蒙皮关节引用无效');joints.add(index);}
 for(const scene of doc.scenes||[])for(const index of scene.nodes||[])if(!Number.isInteger(index)||!nodes[index]||parents.has(index))throw Error('场景根节点引用无效');
 const rootIndices=doc.scenes?.length?(doc.scenes[doc.scene??0]?.nodes||[]):nodes.map((_,i)=>i).filter(i=>!parents.has(i));
 if(doc.scene!==undefined&&!doc.scenes?.[doc.scene])throw Error('默认场景引用无效');
 const reachable=new Set(),pending=[...rootIndices];while(pending.length){const i=pending.pop();if(reachable.has(i))continue;reachable.add(i);pending.push(...(nodes[i].children||[]));}
 const visible=[...reachable].map(i=>nodes[i]);
 const libraryMeshes=!nodes.length&&!doc.scenes?.length&&meshes.some(m=>m.primitives?.some(p=>doc.accessors?.[p.attributes?.POSITION]?.count>0));
 const hasMesh=libraryMeshes||visible.some(n=>n.mesh!==undefined&&meshes[n.mesh]?.primitives?.some(p=>doc.accessors?.[p.attributes?.POSITION]?.count>0));
 const hasSkin=hasMesh&&visible.some(n=>n.mesh!==undefined&&n.skin!==undefined);
 const hasRig=[...joints].some(i=>reachable.has(i)),hasNodes=reachable.size>0,hasHierarchy=[...reachable].some(i=>parents.has(i));
 const curves=curveDescriptor(doc),channels=(doc.animations||[]).flatMap(a=>a.channels||[]),hasClips=Boolean(channels.length||curves?.clips?.length);
 const animationTypes=[...new Set(channels.map(c=>c.target?.path==='weights'?'morph':joints.has(c.target?.node)?'joint':'node'))];if(curves)animationTypes.push('curves');
 const hasMorphTargets=meshes.some(m=>m.primitives?.some(p=>p.targets?.length));
 const preview=curves?'curves':hasMesh?'model':hasNodes?hasRig?'skeleton':'nodes':'metadata';
 const kind=curves?'curves':hasMesh?hasSkin?'rigged-model':hasClips?'animated-model':'static-model':hasRig?hasClips?'skeleton-animation':'skeleton':hasNodes?hasClips?'node-animation':'nodes':'empty';
 return {version:1,kind,preview,hasMesh,hasRig,hasSkin,hasNodes,hasHierarchy,hasMorphTargets,hasClips,animationTypes,jointCount:joints.size,jointIndices:[...joints],nodeCount:nodes.length,canPlay:hasClips,canPickSurface:hasMesh,canPickNode:hasNodes,canInspect:preview!=='metadata',canLocalRotate:channels.some(c=>c.target?.path==='rotation'),needsTarget:!hasMesh&&hasClips,limitations:curves?['此资源只有曲线；缺少目标骨架、参考姿势和蒙皮，不能据此验收角色变形。']:!hasMesh&&hasNodes?[hasRig?'仅显示骨架；蒙皮变形需要目标模型。':'仅显示实际节点层级；节点名称不证明它们是角色骨骼。']:!hasMesh?['容器中没有可预览的模型、节点或动作。']:[]};
}
export function resourceLabel(capabilities){return ({model:'模型预览',skeleton:'骨架预览',nodes:'节点预览',curves:'动画曲线',metadata:'资源信息'})[capabilities?.preview]||'资源预览';}
