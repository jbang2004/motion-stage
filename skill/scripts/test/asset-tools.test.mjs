import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspectAsset,editGlb,parseGlb,readAccessor,encodeGlb} from '../asset-tools.mjs';

const demo=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
test('a short local-axis offset inserts eased keys and keeps all original samples outside the window',()=>{
 const start=Math.fround(.203),end=Math.fround(.21);
 const {bytes,report}=editGlb(demo,{clip:'Run',bone:'LeftShoulder',offset:{axis:'z',degrees:-25},start,end});
 const before=parseGlb(demo),after=parseGlb(bytes),index=before.doc.nodes.findIndex(n=>n.name==='LeftShoulder');
 const sampler=({doc},path)=>{const clip=doc.animations[0];return clip.samplers[clip.channels.find(c=>c.target.node===index&&c.target.path===path).sampler];};
 const read=(asset,accessor)=>readAccessor(asset.doc,asset.bin,accessor);
 const original=sampler(before,'rotation'),result=sampler(after,'rotation');
 const originalTimes=read(before,original.input).flat(),changedTimes=read(after,result.input).flat();
 const originalValues=read(before,original.output),changedValues=read(after,result.output);
 assert.equal(report.method,'local-axis-offset');assert.equal(report.degrees,-25);
 assert.equal(report.insertedBoundaryKeyframes,4);assert.equal(report.changedKeyframes,2);
 assert.deepEqual(report.timeRange,[start,end]);
 assert.ok(changedTimes.includes(start)&&changedTimes.includes(end));
 for(const [i,time] of originalTimes.entries())assert.deepEqual(changedValues[changedTimes.indexOf(time)],originalValues[i]);
 assert.deepEqual(after.doc.animations[1],before.doc.animations[1]);
 assert.deepEqual(after.bin.subarray(0,before.bin.length),before.bin);
 const full=editGlb(demo,{clip:'Run',bone:'LeftShoulder',offset:{axis:'z',degrees:90}});
 const transformed=parseGlb(full.bytes);
 const q=originalValues[20],[x,y,z,w]=q,expected=[x+y,y-x,z+w,w-z].map(v=>v/Math.sqrt(2));
 assert.ok(read(transformed,sampler(transformed,'rotation').output)[20].every((v,i)=>Math.abs(v-expected[i])<1e-6));
});
test('inspect original teaching rig reports exact animated nodes and clips',()=>{
 const d=inspectAsset(demo);assert.equal(d.kind,'animated-model');assert.deepEqual(d.clips.map(c=>c.name),['Run','Salute']);assert(d.bones.some(b=>b.name==='LeftShoulder'));assert(d.meshes.length>1);assert.equal(d.clips[0].duration,1);
});
test('bounded quaternion edit keeps source, geometry and unrelated clip/channel bytes',()=>{
 const before=Buffer.from(demo),result=editGlb(demo,{clip:'Run',bone:'LeftShoulder',factor:.7});assert.deepEqual(demo,before);assert.notDeepEqual(result.bytes,demo);
 const a=parseGlb(demo),b=parseGlb(result.bytes);assert.deepEqual(b.doc.meshes,a.doc.meshes);assert.deepEqual(b.doc.nodes,a.doc.nodes);assert.deepEqual(b.doc.animations[1],a.doc.animations[1]);assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);
 assert.equal(result.report.agentGenerated,false);assert.equal(result.report.preserved.otherChannels,true);assert(Math.abs(result.report.afterMaxDegrees/result.report.beforeMaxDegrees-.7)<1e-5);
 const old=a.doc.animations[0],edited=b.doc.animations[0],oldChannel=old.channels.find(c=>c.target.node===a.doc.nodes.findIndex(n=>n.name==='LeftShoulder')),newChannel=edited.channels.find(c=>c.target.node===b.doc.nodes.findIndex(n=>n.name==='LeftShoulder'));
 const out=readAccessor(b.doc,b.bin,edited.samplers[newChannel.sampler].output);assert(out.every(q=>Math.abs(Math.hypot(...q)-1)<1e-6));assert.equal(old.samplers[oldChannel.sampler].input,edited.samplers[newChannel.sampler].input);
});
test('partial scope is blended and does not modify outside samples',()=>{
 const {bytes}=editGlb(demo,{clip:'Run',bone:'LeftShoulder',factor:.5,start:.2,end:.8});const a=parseGlb(demo),b=parseGlb(bytes);const node=a.doc.nodes.findIndex(n=>n.name==='LeftShoulder');const get=d=>{const x=d.doc.animations[0],c=x.channels.find(c=>c.target.node===node);return readAccessor(d.doc,d.bin,x.samplers[c.sampler].output);};const before=get(a),after=get(b);
 for(const i of [0,1,2,10,50,60])assert(before[i].every((v,j)=>Math.abs(v-after[i][j])<1e-6));assert.notDeepEqual(before[25],after[25]);
});
test('static files inspect; bad targets, times and unsupported interpolation fail clearly',()=>{
 const a=parseGlb(demo);a.doc.animations=[];assert.equal(inspectAsset(encodeGlb(a.doc,a.bin)).kind,'static-model');
 assert.throws(()=>editGlb(demo,{clip:'Run',bone:'absent',factor:.7}),/找不到指定骨骼/);assert.throws(()=>editGlb(demo,{clip:'Run',bone:'LeftShoulder',factor:NaN}),/系数/);assert.throws(()=>editGlb(demo,{clip:'Run',bone:'LeftShoulder',factor:.7,start:.9,end:.3}),/时间段/);
 const c=parseGlb(demo);c.doc.animations[0].samplers[0].interpolation='CUBICSPLINE';assert.throws(()=>editGlb(encodeGlb(c.doc,c.bin),{clip:'Run',bone:'LeftShoulder',factor:.7}),/CUBICSPLINE/);
});
test('non-key scope boundaries insert unchanged source poses and retain original sample values outside window',()=>{
 const {bytes,report}=editGlb(demo,{clip:'Run',bone:'LeftShoulder',factor:.6,start:.213,end:.787});assert.equal(report.insertedBoundaryKeyframes,2);
 const before=parseGlb(demo),after=parseGlb(bytes),node=before.doc.nodes.findIndex(n=>n.name==='LeftShoulder');
 function data(parsed){const a=parsed.doc.animations[0],channel=a.channels.find(c=>c.target.node===node),s=a.samplers[channel.sampler];return{t:readAccessor(parsed.doc,parsed.bin,s.input).flat(),q:readAccessor(parsed.doc,parsed.bin,s.output)};}
 const a=data(before),b=data(after);for(let i=0;i<a.t.length;i++)if(a.t[i]<.213||a.t[i]>.787){const j=b.t.findIndex(t=>t===a.t[i]);assert.deepEqual(b.q[j],a.q[i]);}
});
test('meshopt-compressed animation refuses local editing instead of reading compressed bytes',()=>{
 const a=parseGlb(demo),sampler=a.doc.animations[0].samplers[0];a.doc.bufferViews[a.doc.accessors[sampler.output].bufferView].extensions={EXT_meshopt_compression:{}};
 assert.throws(()=>editGlb(encodeGlb(a.doc,a.bin),{clip:'Run',bone:'LeftShoulder',factor:.7}),/压缩/);
});
