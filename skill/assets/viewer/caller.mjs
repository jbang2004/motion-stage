// Routing metadata, not authentication or proof that a host can wake a chat.
export function normalizeCaller(value){
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value)||typeof value.client!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(value.client)||typeof value.sessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.sessionId))throw Error('调用来源需要有效的 --caller 客户端和 --session 会话标识');
 if(value.model!==undefined&&(typeof value.model!=='string'||!value.model.trim()||value.model.length>100||/[\x00-\x1f\x7f]/.test(value.model)))throw Error('模型名称需为 1–100 个可见字符');
 return {client:value.client,sessionId:value.sessionId,...(value.model?{model:value.model.trim()}:{}),transport:'handoff'};
}
export function callerFromArgs(args){
 const read=flag=>{const i=args.indexOf(flag);if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(flag+' 缺少值');return args[i+1];};
 const client=read('--caller'),sessionId=read('--session'),model=read('--caller-model');
 return client===undefined&&sessionId===undefined&&model===undefined?null:normalizeCaller({client,sessionId,model});
}
export function callerLabel(caller){return ({codex:'Codex',claude:'Claude',deepseek:'DeepSeek',workbuddy:'WorkBuddy'})[caller?.client]||caller?.client||'当前对话';}
export function callerKey(caller){return caller?caller.client+':'+caller.sessionId:'';}
export function restoredDelivery(saved,caller){return saved?.callerKey===callerKey(caller)&&saved.executionMode==='worker'?'worker':'chat';}
export function assertCaller(expected,actual){
 if(!expected)return;
 const caller=normalizeCaller(actual);
 if(!caller||callerKey(caller)!==callerKey(expected))throw Error('任务属于 '+callerLabel(expected)+' 的原会话，请返回该会话领取；不会自动转给其他客户端');
}

export function executorLabel(provider){return ({codex:"Codex",claude:"Claude Code",deepseek:"DeepSeek Harness"})[provider]||provider||"Codex";}
