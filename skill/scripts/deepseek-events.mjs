// The headless CLI emits committed events. Reasoning/tool bodies are not UI progress.
export function createDeepSeekEvents({onSession=()=>{},onActivity=()=>{}}={}){
 let sessionId=null,final=null,error=null;
 const validSession=id=>typeof id==='string'&&/^session-[A-Za-z0-9-]{1,100}$/.test(id);
 return {
  receive(e){
   if(!e||typeof e!=='object')return null;
   if(e.type==='session'){
    if(!validSession(e.sessionId)||sessionId&&sessionId!==e.sessionId){error='DeepSeek Harness 返回了不一致的会话标识';return null;}
    if(!sessionId){sessionId=e.sessionId;onSession(sessionId);}
    return {type:'session',sessionId};
   }
   if(e.type==='status'&&e.phase==='turn_start'){onActivity('DeepSeek Harness 已开始读取任务。');return {type:'status',phase:e.phase};}
   if(e.type==='tool_call'){onActivity('DeepSeek Harness 正在调用制作工具。');return {type:e.type,callId:e.callId};}
   if(e.type==='tool_result'){onActivity(e.status==='error'?'制作工具返回问题，DeepSeek Harness 正在检查。':'制作工具已返回，DeepSeek Harness 正在处理结果。');return {type:e.type,callId:e.callId,status:e.status};}
   if(e.type==='error'){error=String(e.message||'DeepSeek Harness 执行失败').slice(0,1500);return {type:'error',message:error};}
   if(e.type==='final'){
    if(final||!sessionId||e.sessionId!==sessionId){error='DeepSeek Harness 终态与执行会话不匹配';return null;}
    final=e;return {type:'final',sessionId,reason:e.reason,text:e.text};
   }
   return null;
  },
  result(){
   if(error)throw Error(error);
   if(!final||final.reason?.kind!=='completed')throw Error(final?.reason?.error?.message||'DeepSeek Harness 未正常完成任务；不会载入未完成的候选');
   let value;try{const raw=String(final.text||'').trim().replace(/^```json\s*([\s\S]*?)\s*```$/,'$1');value=JSON.parse(raw);}catch{throw Error('DeepSeek Harness 最终回复不是有效任务 JSON，请检查任务结果');}
   if(!value||!['complete','needs-input'].includes(value.status)||typeof value.summary!=='string'||typeof value.candidate!=='string'||typeof value.reason!=='string')throw Error('DeepSeek Harness 返回的任务结果字段不完整');
   return value;
  },
  get error(){return error;}
 };
}
