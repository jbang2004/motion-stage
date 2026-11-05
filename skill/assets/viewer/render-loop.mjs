// No idle animation callback. Wake after a user event; continuous playback or
// project appearance hooks keep the loop alive only while they need frames.
export function createDemandLoop({requestFrame,cancelFrame,onFrame,shouldContinue}){
 let pending=null,running=false,last=null,disposed=false;
 const tick=now=>{pending=null;running=true;const dt=last===null?0:Math.min(.1,Math.max(0,(now-last)/1000));last=now;
  try{onFrame(now,dt);}finally{running=false;if(!disposed&&shouldContinue())wake();else last=null;}
 };
 function wake(){if(!disposed&&pending===null&&!running)pending=requestFrame(tick);}
 return {wake,dispose(){disposed=true;if(pending!==null)cancelFrame(pending);pending=null;last=null;},get pending(){return pending!==null;}};
}
