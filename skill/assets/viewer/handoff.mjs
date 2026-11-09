import {callerLabel} from './caller.mjs';
import {element as el,createActionButton} from './ui.mjs';

export function taskHandoff(job,paths){
 return `请处理动作台任务 ${job.id}：${job.request}\n工作区：${paths.workspace}\n${job.caller?`处理来源：${callerLabel(job.caller)}；会话：${job.caller.sessionId}。请在原会话处理，不要改用其他客户端。\n`:''}先读取冻结任务，再领取并按任务范围修改；将候选返回此任务。\n${job.agentCommand||`node ${JSON.stringify(paths.cli)} job --workspace ${JSON.stringify(paths.workspace)} --job ${job.id}`}${job.claimCommand?`\n读取后领取：\n${job.claimCommand}`:''}`;
}
export function integrationHandoff(entry,paths){
 const identity=entry.kind==='candidate'?'认可检查点 '+entry.checkpointId:'收录动作 '+entry.actionId;
 return `请将动作台的${identity}接入对应游戏项目。\n工作区：${paths.workspace}\n角色：${entry.model||entry.assetId}；动作：${entry.clip}\n先用 integrations 核对当前状态、分支和游戏源文件，再按这条记录修改、检查游戏并记录接入结果。制作源需要同步时一起处理；存在无法确定的分支或目标文件时再向我确认。\nCLI：${paths.cli}`;
}
export function createRuntimeHandoff({dialog, body, request, copy}) {
 let generation = 0;
 return async ({assetId, selectedClip}) => {
  if (dialog.open) return;
  const ticket = ++generation;
  dialog.showModal();
  body.replaceChildren(el('p', '正在准备接入任务…'));
  try {
   const {task, prompt, delivery} = await request({assetId, clip:selectedClip ?? null});
   if (ticket !== generation || !dialog.open) return;
   const title = [task.project.name, task.character.name, task.action?.name].filter(Boolean).join(' · ');
   const destination = task.caller ? '打开动作台的 '+callerLabel(task.caller)+' 对话' : '当前对话';
   const status = el('p', delivery === 'sent' ? '已发送到'+destination+'。' : '复制接入任务，粘贴到'+destination+'。');
   const text = el('textarea', undefined, 'runtime-handoff-text');
   text.readOnly = true;
   text.value = prompt;
   text.setAttribute('aria-label', '接入任务内容');
   const copyButton = createActionButton('复制接入任务', async () => {
    await copy(prompt);
    status.textContent = delivery === 'sent' ? '已发送到'+destination+'，接入任务也已复制。' : '已复制，粘贴到'+destination+'。';
   }, {
    className: 'primary-button',
    onError(error) { status.textContent = error.message; text.focus(); text.select(); },
   });
   body.replaceChildren(el('h3', title), status, copyButton, text);
  } catch (error) {
   if (ticket === generation && dialog.open) body.replaceChildren(el('p', error.message, 'error-copy'));
  }
 };
}

export function createIntegrationPanel({api,getPaths,copy,onError}){
 const dialog=document.getElementById('integrationDialog'),body=document.getElementById('integrationBody');let generation=0;
 const button=(label,fn)=>createActionButton(label,fn,{onError});
 return {async open({jobId,actionId}={}){
  const ticket=++generation;dialog.showModal();body.replaceChildren(el('p','正在核对版本与游戏文件…'));
  try{
   const data=await api('/api/integrations');if(ticket!==generation||!dialog.open)return;
   body.replaceChildren(el('p',data.project?.name?'关联项目：'+data.project.name:'尚未关联游戏项目。先在左上角“关联项目”选择工程，再由当前对话处理接入。','integration-project'));
   const all=[...data.candidates,...data.actions],rows=all.filter(r=>jobId?r.jobId===jobId:actionId?r.actionId===actionId:r.status==='pending');
   if(!rows.length)body.append(el('p','目前没有等待接入的认可候选或收录动作。先比较并保留一版，或在动作库收录动作。'));
   for(const row of rows){
    const card=el('section',undefined,'integration-card');card.append(el('h3',(row.model||'角色')+' · '+row.clip),el('span',({pending:'待接入',integrated:'已接入',superseded:'已有后续版本',withdrawn:'认可已撤回'})[row.status],'check-badge'),el('p',row.hint));
    if(row.game.modelFile)card.append(el('p','游戏文件：'+row.game.modelFile));
    if(row.references?.some(r=>r.kind==='source'))card.append(el('p','制作源：'+row.references.filter(r=>r.kind==='source').map(r=>r.path).join('、')));
    if(row.status==='pending'){const text=integrationHandoff(row,getPaths());card.append(button('复制接入请求',()=>copy(text)));const details=el('details');details.append(el('summary','查看完整交接内容'),el('pre',text));card.append(details);}
    body.append(card);
   }
  }catch(error){if(ticket===generation)body.replaceChildren(el('p',error.message,'error-copy'),button('重新读取',()=>this.open({jobId,actionId})));}
 }};
}
