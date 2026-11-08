import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assembleCharacter} from '../motion-assembly.mjs';
import {parseGlb,encodeGlb,readAccessor} from '../asset-tools.mjs';
import {glbInfo} from '../core.mjs';
import {validateCandidate} from '../candidate-validation.mjs';
import {checkMotion} from '../motion-checks.mjs';
import {compareCandidate} from '../candidate-diff.mjs';
const base=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
const clipNames=b=>glbInfo(b).clips.map(c=>c.name);
function motion(mutate=()=>{}){const p=parseGlb(base);p.doc.animations=[p.doc.animations[0]];p.doc.animations[0].name='External';delete p.doc.meshes;for(const n of p.doc.nodes){delete n.mesh;delete n.skin;}mutate(p.doc,p.bin);return encodeGlb(p.doc,p.bin);}
const source=bytes=>({file:'motions.glb',format:'glb',bytes});
const sampled=(clips,extra={})=>({file:'pack.json',format:'sampled-tracks-v1',bytes:Buffer.from(JSON.stringify({fps:60,clips,...extra}))});
const pose={duration:1,tracks:[['LeftShoulder.quaternion','quaternion',4,[0,0,0,1]]]};

test('animation-only sources bind by unique nodes and retain original clips, geometry and provenance',async()=>{
 const result=await assembleCharacter(base,[source(motion())]);assert.deepEqual(clipNames(result.bytes),['Run','Salute','External']);assert.equal(result.sources[0].status,'ready');assert.equal(result.clips.External.file,'motions.glb');assert.equal(result.clips.Run.format,'embedded');validateCandidate(result.bytes,glbInfo(base).clips);
 const before=parseGlb(base),after=parseGlb(result.bytes);assert.deepEqual(after.doc.meshes,before.doc.meshes);assert.ok(after.bin.subarray(0,before.bin.length).equals(before.bin));
});

test('equal bone names cannot bypass rest pose, ancestry, ambiguity or missing-target checks',async()=>{
 for(const mutate of [d=>{d.nodes.find(n=>n.name==='LeftShoulder').translation=[0,20,0];},d=>{const i=d.nodes.findIndex(n=>n.name==='LeftShoulder'),p=d.nodes.find(n=>n.children?.includes(i));p.name='DifferentParent';},d=>{d.nodes.push({...d.nodes.find(n=>n.name==='LeftShoulder')});},d=>{d.nodes.find(n=>n.name==='LeftShoulder').name='UnknownBone';}]){
  const result=await assembleCharacter(base,[source(motion(mutate))]);assert.notEqual(result.sources[0].status,'ready');assert.ok(result.bytes.equals(base));
 }
 const mapped=await assembleCharacter(base,[{...source(motion(d=>{d.nodes.find(n=>n.name==='LeftShoulder').name='Alias';})),nodeMap:{Alias:'LeftShoulder'}}]);assert.equal(mapped.sources[0].status,'ready');
});

test('a same-rig source after a DCC round trip still binds; a visibly different rest pose does not',async()=>{
 // Blender re-exports of an unchanged Mixamo-style rig drift by ~2.5e-5 in rest matrices.
 const nudge=delta=>motion(d=>{const n=d.nodes.find(n=>n.name==='LeftShoulder');n.translation=(n.translation||[0,0,0]).map((v,i)=>i===1?v+delta:v);});
 assert.equal((await assembleCharacter(base,[source(nudge(3e-5))])).sources[0].status,'ready');
 const moved=await assembleCharacter(base,[source(nudge(2e-3))]);assert.notEqual(moved.sources[0].status,'ready');assert.ok(moved.bytes.equals(base));
});

test('source failures are atomic and independent; collisions require explicit prefix or override',async()=>{
 const conflict=motion(d=>{d.animations[0].name='Run';});
 const result=await assembleCharacter(base,[source(conflict),{...source(conflict),prefix:'shared__'},{file:'missing.glb',format:'glb'},sampled({Pose:pose})]);
 assert.deepEqual(result.sources.map(s=>s.status),['needs-confirmation','ready','unavailable','ready']);assert.deepEqual(clipNames(result.bytes),['Run','Salute','shared__Run','Pose']);
 const replaced=await assembleCharacter(base,[{...source(conflict),replace:true}]);assert.deepEqual(clipNames(replaced.bytes),['Run','Salute']);assert.equal(replaced.clips.Run.file,'motions.glb');
 const bad=motion(d=>{const a=structuredClone(d.animations[0]);a.name='Bad';a.channels[0].target.node=9999;d.animations.push(a);});
 const all=await assembleCharacter(base,[source(bad)]);assert.ok(all.bytes.equals(base),'one bad clip does not leave earlier tracks behind');
 const selected=await assembleCharacter(base,[{...source(bad),clips:['External']}]);assert.equal(selected.sources[0].status,'ready','only selected clips must bind');
});

test('sampled tracks preserve constant duration and tolerate rounded final sample time',async()=>{
 const result=await assembleCharacter(base,[sampled({Pose:pose,Rounded:{duration:.583,tracks:[['LeftShoulder.quaternion','quaternion',4,Array.from({length:36},()=>[0,0,0,1]).flat()]]}})]);
 assert.equal(result.sources[0].status,'ready');assert.equal(glbInfo(result.bytes).clips.find(c=>c.name==='Pose').duration,1);assert.ok(Math.abs(glbInfo(result.bytes).clips.find(c=>c.name==='Rounded').duration-.583)<1e-6);validateCandidate(result.bytes);
});

test('invalid dimensions, float32 overflow, unsupported layouts and zero quaternions leave the base usable',async()=>{
 for(const tracks of [[['LeftShoulder.quaternion','vector',3,[0,0,1]]],[['LeftShoulder.quaternion','quaternion',4,[0,0,0,0]]],[['LeftShoulder.position','vector',3,[1e100,0,0]]]]){
  const result=await assembleCharacter(base,[sampled({Broken:{duration:1,tracks}})]);assert.ok(result.bytes.equals(base));assert.equal(result.sources[0].status,'unavailable');
 }
 const p=parseGlb(base);p.doc.buffers[0].uri='data:application/octet-stream;base64,'+p.bin.toString('base64');const dataUri=encodeGlb(p.doc,Buffer.alloc(0));const result=await assembleCharacter(dataUri,[sampled({Pose:pose})]);assert.equal(result.sources[0].status,'unsupported');assert.ok(result.bytes.equals(dataUri));
});

for(const extension of ['EXT_meshopt_compression','KHR_meshopt_compression'])test(extension+' expands compressed animation accessors without loading source meshes',async()=>{
 // Original two-key test curves encoded with meshoptimizer; no project media.
 const data=[Buffer.from('oAAAATAAAAD/ATAAAAB+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=','base64'),Buffer.from('oAAAAAABMAAAAMsBMAAAAM0BMAAAADIBMAAAAH4AAAAAATAAAABlATAAAABnATAAAABnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA/','base64')];
 const p=parseGlb(base),target=p.doc.nodes.findIndex(n=>n.name==='LeftShoulder');p.doc.animations=[{name:'Compressed',channels:[{sampler:0,target:{node:target,path:'rotation'}}],samplers:[{input:0,output:1}]}];
 p.doc.accessors=[{bufferView:0,componentType:5126,count:2,type:'SCALAR',min:[0],max:[1]},{bufferView:1,componentType:5126,count:2,type:'VEC4'}];let offset=0;
 p.doc.bufferViews=data.map((bytes,i)=>{const out={buffer:1,byteOffset:i?8:0,byteLength:i?32:8,extensions:{[extension]:{buffer:0,byteOffset:offset,byteLength:bytes.length,byteStride:i?16:4,count:2,mode:'ATTRIBUTES',filter:'NONE'}}};offset+=bytes.length;return out;});
 p.doc.buffers=[{byteLength:offset},{byteLength:40,extensions:{[extension]:{fallback:true}}}];
 const compressed=encodeGlb(p.doc,Buffer.concat(data));
 const result=await assembleCharacter(base,[source(compressed)]);assert.equal(result.sources[0].status,'ready',result.sources[0].error);validateCandidate(result.bytes);
 const parsed=parseGlb(result.bytes),s=parsed.doc.animations.at(-1).samplers[0];assert.deepEqual(readAccessor(parsed.doc,parsed.bin,s.input),[[0],[1]]);assert.ok(Math.abs(readAccessor(parsed.doc,parsed.bin,s.output)[1][1]-.6)<1e-6);
 assert.deepEqual(checkMotion(compressed,{clip:'Compressed'}).checks,checkMotion(result.bytes,{clip:'Compressed'}).checks);
 assert.equal(compareCandidate(compressed,compressed).tracks.unchanged,1);
 assert.equal(compareCandidate(compressed,result.bytes,{clip:'Compressed'}).tracks.unchanged,1);
});
