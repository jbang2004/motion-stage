import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseGlb,encodeGlb,readAccessor} from '../asset-tools.mjs';
import {checkMotion,compareMotionChecks} from '../motion-checks.mjs';

const demo=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));

// A minimal leg: Root > Pelvis > Hip > Knee > Foot, 0.45 m thigh and shin, Y up.
// tracks: [{node, path, times, values, interpolation}]
function leg(tracks){
 const nodes=[{name:'Root',children:[1]},{name:'Pelvis',translation:[0,.9,0],children:[2]},{name:'LeftHip',children:[3]},{name:'LeftKnee',translation:[0,-.45,0],children:[4]},{name:'LeftFoot',translation:[0,-.45,0]}];
 const chunks=[],accessors=[],views=[];let offset=0;
 const put=(arr,type)=>{const flat=arr.flat(),b=Buffer.alloc(flat.length*4);flat.forEach((v,i)=>b.writeFloatLE(v,i*4));views.push({buffer:0,byteOffset:offset,byteLength:b.length});chunks.push(b);offset+=b.length;
  const a={bufferView:views.length-1,componentType:5126,count:arr.length,type};if(type==='SCALAR'){a.min=[Math.min(...flat)];a.max=[Math.max(...flat)];}return accessors.push(a)-1;};
 const samplers=[],channels=[];
 for(const t of tracks){const input=put(t.times.map(v=>[v]),'SCALAR'),output=put(t.values,t.path==='rotation'?'VEC4':'VEC3');channels.push({sampler:samplers.push({input,output,interpolation:t.interpolation||'LINEAR'})-1,target:{node:nodes.findIndex(n=>n.name===t.node),path:t.path}});}
 const bin=Buffer.concat(chunks);
 return encodeGlb({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes,accessors,bufferViews:views,buffers:[{byteLength:bin.length}],animations:[{name:'Clip',samplers,channels}]},bin);
}
const xRot=deg=>{const h=deg*Math.PI/360;return[Math.sin(h),0,0,Math.cos(h)];};
const times=n=>Array.from({length:n+1},(_,i)=>i/30);

test('teaching rig: no rotation flips and both leg chains are found by name',()=>{
 const r=checkMotion(demo,{clip:'Run'});
 assert.equal(r.checks.rotationFlips.findings.length,0);
 assert.deepEqual(r.checks.limbExtension.map(l=>l.chain.join('>')),['LeftHip>LeftKnee>LeftFoot','RightHip>RightKnee>RightFoot']);
 assert.equal(r.footSelection,'name-hint');assert(r.limitations.some(l=>/按名称推测/.test(l)));
});

test('a planted 180-degree key is reported as a fast turn at that time',()=>{
 const a=parseGlb(demo),anim=a.doc.animations[0],node=a.doc.nodes.findIndex(n=>n.name==='LeftShoulder');
 const ch=anim.channels.find(c=>c.target.node===node&&c.target.path==='rotation'),s=anim.samplers[ch.sampler],ts=readAccessor(a.doc,a.bin,s.input).flat(),qs=readAccessor(a.doc,a.bin,s.output);
 const k=Math.floor(qs.length/2),[x,y,z,w]=qs[k],flipped=[w,-z,y,-x]; // q * (180 deg about X)
 const b=Buffer.alloc(qs.length*16);qs.forEach((q,i)=>(i===k?flipped:q).forEach((v,j)=>b.writeFloatLE(v,i*16+j*4)));
 const off=a.bin.length;a.doc.bufferViews.push({buffer:0,byteOffset:off,byteLength:b.length});a.doc.accessors.push({bufferView:a.doc.bufferViews.length-1,componentType:5126,count:qs.length,type:'VEC4'});
 anim.samplers.push({...s,output:a.doc.accessors.length-1});ch.sampler=anim.samplers.length-1;const bin=Buffer.concat([a.bin,b]);a.doc.buffers[0].byteLength=bin.length;
 const r=checkMotion(encodeGlb(a.doc,bin),{clip:'Run',checks:['rotationFlips']}),hits=r.findings.filter(f=>f.kind==='fast_turn'||f.kind==='ambiguous_segment');
 assert(hits.length>=1);assert(hits.every(f=>f.node==='LeftShoulder'));assert(hits.some(f=>f.time[0]<=ts[k]+1e-6&&f.time[1]>=ts[k]-1e-6));
 const cmp=compareMotionChecks(checkMotion(demo,{clip:'Run',checks:['rotationFlips']}),r);
 assert(cmp.summary.newWarnings>=1);assert(cmp.findings.every(f=>f.status==='new'));
});

test('quaternion sign flips are harmless on LINEAR and a warning on CUBICSPLINE',()=>{
 const q=[xRot(10),xRot(20).map(v=>-v),xRot(30)],t=[0,.5,1];
 const lin=checkMotion(leg([{node:'LeftKnee',path:'rotation',times:t,values:q}]),{checks:['rotationFlips']});
 assert.deepEqual(lin.findings.map(f=>[f.kind,f.severity]),[['quat_sign_flip','info'],['quat_sign_flip','info']]);
 const cubic=q.flatMap(v=>[[0,0,0,0],v,[0,0,0,0]]);
 const cub=checkMotion(leg([{node:'LeftKnee',path:'rotation',times:t,values:cubic,interpolation:'CUBICSPLINE'}]),{checks:['rotationFlips']});
 assert(cub.findings.some(f=>f.kind==='quat_sign_flip'&&f.severity==='warning'));
});

test('foot slip: still foot is planted, root-motion drag is slip, in-place linear drift is treadmill',()=>{
 const still=checkMotion(leg([{node:'LeftKnee',path:'rotation',times:[0,1],values:[xRot(0),xRot(0)]}]),{checks:['footSlip']});
 assert.deepEqual(still.checks.footSlip[0].contacts.map(c=>c.kind),['planted']);assert.equal(still.findings.length,0);
 // The pelvis carries the whole leg forward 0.3 m while the foot stays at floor height.
 const dragged=checkMotion(leg([{node:'Pelvis',path:'translation',times:[0,1],values:[[0,.9,0],[0,.9,.3]]}]),{checks:['footSlip']});
 assert.equal(dragged.checks.footSlip[0].inPlace,false);assert.equal(dragged.findings[0].kind,'foot_slip');assert(Math.abs(dragged.findings[0].slide-.3)<1e-3);
 // The pelvis stays put and the hip slides backward at a constant 0.6 m/s: an in-place walk's stance.
 const tread=checkMotion(leg([{node:'LeftHip',path:'translation',times:[0,.5],values:[[0,0,.15],[0,0,-.15]]}]),{checks:['footSlip']});
 const c=tread.checks.footSlip[0];assert.equal(c.inPlace,true);assert.equal(c.contacts[0].kind,'treadmill');assert(Math.abs(c.contacts[0].speed-.6)<1e-3);assert.equal(tread.findings.length,0);
 // Explicit contact windows override the height heuristic.
 const given=checkMotion(leg([{node:'Pelvis',path:'translation',times:[0,1],values:[[0,.9,0],[0,.9,.3]]}]),{checks:['footSlip'],feet:['LeftFoot'],contacts:{LeftFoot:[[0,.1]]}});
 assert.equal(given.footSelection,'given');assert.equal(given.checks.footSlip[0].contactSource,'given');assert(Math.abs(given.checks.footSlip[0].contacts[0].slide-.03)<2e-3);
});

test('limb extension: a one-frame snap to straight is a pop, a lengthened shin is a stretch',()=>{
 const t=times(10),bend=t.map((_,i)=>xRot(i<5?30:i===5?2:2));
 const pop=checkMotion(leg([{node:'LeftKnee',path:'rotation',times:t,values:bend}]),{checks:['limbExtension']});
 const p=pop.findings.find(f=>f.kind==='limb_pop');assert(p);assert.deepEqual(p.chain,['LeftHip','LeftKnee','LeftFoot']);assert(Math.abs(p.time[0]-4/30)<1e-3);
 const smooth=checkMotion(leg([{node:'LeftKnee',path:'rotation',times:[0,1],values:[xRot(30),xRot(2)]}]),{checks:['limbExtension']});
 assert.equal(smooth.findings.length,0);
 const stretch=checkMotion(leg([{node:'LeftKnee',path:'translation',times:[0,1],values:[[0,-.45,0],[0,-.55,0]]}]),{checks:['limbExtension']});
 const s=stretch.findings.find(f=>f.kind==='limb_stretch');assert(s);assert(Math.abs(s.maxRatio-1.1111)<1e-3);
});

test('missing feet and bad options are reported, not guessed',()=>{
 const a=parseGlb(leg([{node:'LeftKnee',path:'rotation',times:[0,1],values:[xRot(0),xRot(10)]}]));a.doc.nodes[4].name='Paw';
 const r=checkMotion(encodeGlb(a.doc,a.bin));assert(r.limitations.some(l=>/没有找到名称像脚/.test(l)));assert.deepEqual(r.checks.footSlip,[]);
 assert.throws(()=>checkMotion(demo),/--clip/);assert.throws(()=>checkMotion(demo,{clip:'Run',fps:0}),/帧率/);assert.throws(()=>checkMotion(demo,{clip:'Run',feet:['Nope']}),/找不到节点/);
});
