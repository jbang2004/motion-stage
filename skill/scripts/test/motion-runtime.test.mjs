import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../assets/vendor/three/build/three.core.js';
import {runtimeMotionClips} from '../../assets/viewer/motion-runtime.mjs';
test('separated clips bind exact node instances even with duplicate names and preserve immutable input',async()=>{
 const root=new T.Group(),a=new T.Object3D(),b=new T.Object3D();a.name=b.name='Duplicate';root.add(a,b);
 const data=[{name:'Move',tracks:[{node:1,path:'translation',interpolation:'LINEAR',times:[0,1],values:[0,0,0,2,4,6]}]}],before=JSON.stringify(data);
 const [clip]=await runtimeMotionClips(T,data,i=>[a,b][i]),mixer=new T.AnimationMixer(root);mixer.clipAction(clip).play();mixer.setTime(.5);
 assert.deepEqual(a.position.toArray(),[0,0,0]);assert.deepEqual(b.position.toArray(),[1,2,3]);assert.equal(JSON.stringify(data),before);
 mixer.stopAllAction();mixer.uncacheClip(clip);assert.deepEqual(b.position.toArray(),[0,0,0]);
});
test('step and glTF cubic spline use source interpolation and normalized quaternion samples',async()=>{
 const node=new T.Object3D();const tracks=[{node:0,path:'translation',interpolation:'STEP',times:[0,1],values:[0,0,0,5,0,0]},{node:0,path:'rotation',interpolation:'CUBICSPLINE',times:[0,1],values:[0,0,0,0, 0,0,0,1, 0,0,0,0, 0,0,0,0, 0,1,0,0, 0,0,0,0]}];
 const [clip]=await runtimeMotionClips(T,[{name:'Cubic',tracks}],()=>node),mixer=new T.AnimationMixer(node);mixer.clipAction(clip).play();mixer.setTime(.5);
 assert.equal(node.position.x,0);assert.ok(Math.abs(node.quaternion.length()-1)<1e-6);assert.ok(Math.abs(node.quaternion.y-Math.SQRT1_2)<1e-6);
});
