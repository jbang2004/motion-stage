const directions={'+X':[1,0],'-X':[-1,0],'+Z':[0,1],'-Z':[0,-1]};
export const FOOT_REPAIR_FPS=30;

export function validateFootRepair(value,{sha,clip,duration,scope}={}){
 if(value==null)return null;
 const {assetSha256,foot,nodeIndex,time,inPlace,runtime}=value;
 if(typeof assetSha256!=='string'||!(/^[a-f0-9]{64}$/.test(assetSha256))||typeof value.clip!=='string'||!value.clip||value.clip.length>2048||
    typeof foot!=='string'||!foot||foot.length>240||!Number.isSafeInteger(nodeIndex)||nodeIndex<0||nodeIndex>=100000||
    !Array.isArray(time)||time.length!==2||!time.every(Number.isFinite)||time[0]<0||time[1]<=time[0]||time[1]>120.001)throw Error('脚滑修复缺少有效的版本、脚节点或诊断区间。');
 if(sha!==undefined&&(assetSha256!==sha||value.clip!==clip||time[1]>duration+.001))throw Error('脚滑修复与当前动作或版本不一致。');
 if(scope&&(scope.start>time[0]+.000001||scope.end<time[1]-.000001))throw Error('修改范围必须包含脚滑诊断区间。');
 let motion=null;
 if(runtime!=null){
  if(!Object.hasOwn(directions,runtime.direction)||!Number.isFinite(runtime.speed)||runtime.speed<=0||runtime.speed>1000)throw Error('请输入大于 0 且不超过 1000 的模拟移动速度。');
  motion={direction:runtime.direction,speed:runtime.speed};
 }
 return {assetSha256,clip:value.clip,foot,nodeIndex,time:[...time],inPlace:inPlace===true,runtime:motion};
}

export function footRepairScope(repair,duration){
 const pad=2/FOOT_REPAIR_FPS;
 return {start:Math.max(0,repair.time[0]-pad),end:Math.min(duration,repair.time[1]+pad),wholeClip:false};
}

export function footRepairVelocity(repair){
 return repair.runtime?directions[repair.runtime.direction].map(axis=>axis*repair.runtime.speed):[0,0];
}
