import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateCandidate} from '../candidate-validation.mjs';
import {parseGlb,encodeGlb,editGlb} from '../asset-tools.mjs';
import {atomic,importAsset,json} from '../core.mjs';
import {createJob,claimJob,completeJob,getJob} from '../jobs.mjs';

const demo=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
const clips=[{name:'Run'},{name:'Salute'}];
function changed(fn){const p=parseGlb(demo);fn(p.doc,p.bin);return encodeGlb(p.doc,p.bin);}
function location(doc,accessor){const a=doc.accessors[accessor];return (doc.bufferViews[a.bufferView].byteOffset||0)+(a.byteOffset||0);}

test('direct curve edits pass file checks without external tools or artistic approval',()=>{
 const bytes=editGlb(demo,{clip:'Run',bone:'LeftShoulder',factor:.7}).bytes;
 const check=validateCandidate(bytes,clips);
 assert.equal(check.kind,'candidate-file-check');assert.ok(check.floatValuesChecked>1000);
 assert.deepEqual(check.requiredClips,['Run','Salute']);assert.deepEqual(check.limitations,[]);
 assert.equal(check.artisticAcceptance,'pending-user-review');
});

test('static and embedded-data-URI candidates remain supported',()=>{
 const staticBytes=changed(d=>{d.animations=[];});assert.deepEqual(validateCandidate(staticBytes).requiredClips,[]);
 const p=parseGlb(demo);p.doc.buffers[0].uri='data:application/octet-stream;base64,'+p.bin.toString('base64');
 assert.equal(validateCandidate(encodeGlb(p.doc,Buffer.alloc(0)),clips).floatValuesChecked,validateCandidate(demo,clips).floatValuesChecked);
 p.doc.buffers[0].uri='data:application/octet-stream,'+[...p.bin].map(n=>'%'+n.toString(16).padStart(2,'0')).join('');
 assert.equal(validateCandidate(encodeGlb(p.doc,Buffer.alloc(0)),clips).floatValuesChecked,validateCandidate(demo,clips).floatValuesChecked);
});

test('truncated containers, incomplete buffers and out-of-bounds views/accessors are rejected',()=>{
 assert.throws(()=>validateCandidate(demo.subarray(0,-4)),/GLB|glTF/);
 for(const mutate of [d=>{d.buffers[0].byteLength+=100;},d=>{d.bufferViews[0].byteLength+=1e6;},d=>{d.accessors[0].count+=1e6;},d=>{d.accessors[0].bufferView=99999;}]){
  assert.throws(()=>validateCandidate(changed(mutate)),/buffer|accessor/);
 }
 const p=parseGlb(demo);assert.throws(()=>validateCandidate(encodeGlb(p.doc,Buffer.alloc(0))),/缺少嵌入/);
});

test('external dependencies and lost clips cannot bypass completion checks',()=>{
 assert.throws(()=>validateCandidate(changed(d=>{d.images=[{uri:'texture.png'}];})),/自包含/);
 assert.throws(()=>validateCandidate(changed(d=>{d.animations.pop();}),clips),/缺少原有动作 Salute/);
});

test('non-finite geometry, animation values and invalid node transforms are rejected',()=>{
 assert.throws(()=>validateCandidate(changed((d,b)=>{b.writeFloatLE(NaN,location(d,0));})),/非有限/);
 assert.throws(()=>validateCandidate(changed((d,b)=>{b.writeFloatLE(Infinity,location(d,d.animations[0].samplers[0].output));})),/非有限/);
 assert.throws(()=>validateCandidate(changed(d=>{d.nodes[0].translation=[0,null,0];})),/节点变换/);
});

test('animation time order, duration metadata, targets and sample dimensions must agree',()=>{
 for(const [mutate,reason] of [
  [(d,b)=>{const n=location(d,d.animations[0].samplers[0].input);b.writeFloatLE(b.readFloatLE(n),n+4);},/严格递增/],
  [d=>{d.accessors[d.animations[0].samplers[0].input].max=[2];},/时间范围/],
  [d=>{d.animations[0].channels[0].target.node=99999;},/目标/],
  [d=>{d.animations[0].channels[0].sampler=99999;},/采样器/],
  [d=>{d.animations[0].channels.push(structuredClone(d.animations[0].channels[0]));},/通道重复/],
  [d=>{d.accessors[d.animations[0].samplers[0].output].count--;},/数量不匹配/],
  [(d,b)=>{b.fill(0,location(d,d.animations[0].samplers[0].output),location(d,d.animations[0].samplers[0].output)+16);},/零旋转/],
 ])assert.throws(()=>validateCandidate(changed(mutate)),reason);
});

test('STEP and CUBICSPLINE animation keys use their proper output counts and tangents',()=>{
 assert.doesNotThrow(()=>validateCandidate(changed(d=>{d.animations[0].samplers[0].interpolation='STEP';})));
 const p=parseGlb(demo),s=p.doc.animations[0].samplers[0],a=p.doc.accessors[s.output],start=location(p.doc,s.output),data=Buffer.alloc(a.count*48);
 for(let i=0;i<a.count;i++)p.bin.copy(data,i*48+16,start+i*16,start+(i+1)*16);
 const view=p.doc.bufferViews.push({buffer:0,byteOffset:p.bin.length,byteLength:data.length})-1;
 s.output=p.doc.accessors.push({bufferView:view,componentType:5126,count:a.count*3,type:'VEC4'})-1;s.interpolation='CUBICSPLINE';
 const bin=Buffer.concat([p.bin,data]);p.doc.buffers[0].byteLength=bin.length;
 assert.doesNotThrow(()=>validateCandidate(encodeGlb(p.doc,bin)));
});

test('morph animation output counts follow the mesh target count',()=>{
 const p=parseGlb(demo),input=p.doc.animations[0].samplers[0].input,count=p.doc.accessors[input].count;
 const node=p.doc.nodes.findIndex(n=>n.mesh!==undefined),mesh=p.doc.meshes[p.doc.nodes[node].mesh],position=mesh.primitives[0].attributes.POSITION;
 for(const primitive of mesh.primitives)primitive.targets=[{POSITION:position},{POSITION:position}];
 const data=Buffer.alloc(count*2*4),view=p.doc.bufferViews.push({buffer:0,byteOffset:p.bin.length,byteLength:data.length})-1;
 const output=p.doc.accessors.push({bufferView:view,componentType:5126,count:count*2,type:'SCALAR'})-1;
 p.doc.animations[0].samplers=[{input,output}];p.doc.animations[0].channels=[{sampler:0,target:{node,path:'weights'}}];
 const bin=Buffer.concat([p.bin,data]);p.doc.buffers[0].byteLength=bin.length;
 assert.doesNotThrow(()=>validateCandidate(encodeGlb(p.doc,bin)));
 p.doc.accessors[output].count--;assert.throws(()=>validateCandidate(encodeGlb(p.doc,bin)),/数量不匹配/);
});

test('sparse float values are checked while unexpanded animation ordering is disclosed',()=>{
 const p=parseGlb(demo),s=p.doc.animations[0].samplers[0],a=p.doc.accessors[s.input],values=a.bufferView;
 const data=Buffer.alloc(Math.ceil(a.count/4)*4);for(let i=0;i<a.count;i++)data[i]=i;
 const indices=p.doc.bufferViews.push({buffer:0,byteOffset:p.bin.length,byteLength:a.count})-1;
 a.sparse={count:a.count,indices:{bufferView:indices,componentType:5121},values:{bufferView:values,byteOffset:a.byteOffset||0}};delete a.bufferView;delete a.byteOffset;
 const bin=Buffer.concat([p.bin,data]);p.doc.buffers[0].byteLength=bin.length;
 assert.match(validateCandidate(encodeGlb(p.doc,bin)).limitations.join(' '),/稀疏/);
 bin.writeFloatLE(NaN,p.doc.bufferViews[values].byteOffset||0);
 assert.throws(()=>validateCandidate(encodeGlb(p.doc,bin)),/非有限/);
});

test('compression is disclosed as undecoded and invalid compressed ranges still fail',()=>{
 // Deliberately tests the container boundary, not decoder validity or rendering.
 const p=parseGlb(demo),view=p.doc.bufferViews[p.doc.accessors[p.doc.animations[0].samplers[0].output].bufferView];
 view.extensions={EXT_meshopt_compression:{buffer:0,byteOffset:view.byteOffset||0,byteLength:view.byteLength,byteStride:16,count:view.byteLength/16,mode:'ATTRIBUTES'}};
 assert.match(validateCandidate(encodeGlb(p.doc,p.bin)).limitations.join(' '),/压缩/);
 view.extensions.EXT_meshopt_compression.byteLength=p.bin.length+100;
 assert.throws(()=>validateCandidate(encodeGlb(p.doc,p.bin)),/压缩 bufferView/);
});

test('shared completion gate preserves the head on a bad candidate despite a claimed successful audit',async()=>{
 const work=await mkdtemp(join(tmpdir(),'motion-validation-'));
 try{
  await atomic(join(work,'project.json'),{version:2,slots:{}});await atomic(join(work,'feedback.json'),{version:1,notes:[]});
  await importAsset(work,'baseline',demo,'base');const before=await json(join(work,'project.json'));
  const job=await createJob(work,{request:'Adjust left arm',slot:'baseline',clip:'Run',context:{asset:before.slots.baseline,clip:'Run',time:.25}}),claim=await claimJob(work,job.id);
  const path=join(work,'candidate.glb');await writeFile(path,changed((d,b)=>b.writeFloatLE(NaN,location(d,d.animations[0].samplers[0].output))));
  await assert.rejects(completeJob(work,job.id,{lease:claim.lease,candidatePath:path,summary:'Agent claims success',audit:{allChecksPassed:true}}),/非有限/);
  assert.equal((await getJob(work,job.id)).state,'running');assert.deepEqual((await json(join(work,'project.json'))).slots,before.slots);
  await writeFile(path,editGlb(demo,{clip:'Run',bone:'LeftShoulder',factor:.7}).bytes);
  const done=await completeJob(work,job.id,{lease:claim.lease,candidatePath:path,summary:'Ready for comparison'});
  assert.equal(done.state,'complete');assert.equal(done.audit,null);assert.ok(done.validation.floatValuesChecked>0);assert.equal(done.automaticArtisticApproval,false);
 }finally{await rm(work,{recursive:true,force:true});}
});

test('normalized integer quaternion animation remains valid and zero quaternions are still rejected',()=>{
 const p=parseGlb(demo),s=p.doc.animations[0].samplers[0],a=p.doc.accessors[s.output],data=Buffer.alloc(a.count*8),original=readAccessorForTest(p,s.output);
 for(let i=0;i<a.count;i++)for(let k=0;k<4;k++)data.writeInt16LE(Math.round(original[i][k]*32767),i*8+k*2);
 const view=p.doc.bufferViews.push({buffer:0,byteOffset:p.bin.length,byteLength:data.length})-1;
 s.output=p.doc.accessors.push({bufferView:view,componentType:5122,normalized:true,count:a.count,type:'VEC4'})-1;const bin=Buffer.concat([p.bin,data]);p.doc.buffers[0].byteLength=bin.length;
 assert.doesNotThrow(()=>validateCandidate(encodeGlb(p.doc,bin)));bin.fill(0,p.bin.length,p.bin.length+8);assert.throws(()=>validateCandidate(encodeGlb(p.doc,bin)),/零旋转/);
});
function readAccessorForTest(p,index){const a=p.doc.accessors[index],offset=location(p.doc,index);return Array.from({length:a.count},(_,i)=>Array.from({length:4},(_,k)=>p.bin.readFloatLE(offset+i*16+k*4)));}
