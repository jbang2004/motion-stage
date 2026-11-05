// Clip data is immutable. Each target instance owns bindings/actions and pose state.
export async function runtimeMotionClips(T,clips,resolveNode){
 const properties={rotation:'quaternion',translation:'position',scale:'scale'};
 class Cubic extends T.Interpolant{
  constructor(times,values,size,result,quaternion){super(times,values,size,result);this.quaternion=quaternion;}
  copySampleValue_(i){const n=this.valueSize;for(let j=0;j<n;j++)this.resultBuffer[j]=this.sampleValues[i*n*3+n+j];return this.resultBuffer;}
  interpolate_(i,t0,t,t1){const n=this.valueSize,v=this.sampleValues,out=this.resultBuffer,u=(t-t0)/(t1-t0),u2=u*u,u3=u2*u,dt=t1-t0,a=(i-1)*n*3,b=i*n*3;
   for(let j=0;j<n;j++)out[j]=(2*u3-3*u2+1)*v[a+n+j]+(u3-2*u2+u)*dt*v[a+2*n+j]+(-2*u3+3*u2)*v[b+n+j]+(u3-u2)*dt*v[b+j];
   if(this.quaternion){let squared=0;for(let j=0;j<n;j++)squared+=out[j]*out[j];const length=Math.sqrt(squared);if(length)for(let j=0;j<n;j++)out[j]/=length;}return out;
  }
 }
 return Promise.all(clips.map(async clip=>{
  const tracks=await Promise.all(clip.tracks.map(async track=>{
   const node=await resolveNode(track.node),property=properties[track.path];if(!node||!property)throw Error('此动作包含需要单独适配的轨道');
   const Class=track.path==='rotation'?T.QuaternionKeyframeTrack:T.VectorKeyframeTrack;
   const out=new Class(node.uuid+'.'+property,track.times,track.values,track.interpolation==='STEP'?T.InterpolateDiscrete:T.InterpolateLinear);
   if(track.interpolation==='CUBICSPLINE'){out.createInterpolant=function(result){return new Cubic(this.times,this.values,track.path==='rotation'?4:3,result,track.path==='rotation');};out.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline=true;}
   return out;
  }));return new T.AnimationClip(clip.name,-1,tracks);
 }));
}
