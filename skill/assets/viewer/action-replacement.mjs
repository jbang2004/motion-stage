import {element as el} from './ui.mjs';

export function createReplacementHandoff({api,dialog,list,copyButton,status,preview,copy}){
 function selection(){
  return [...list.querySelectorAll('input:checked')].map(input=>input.value);
 }
 list.onchange=()=>{copyButton.disabled=!selection().length;preview.hidden=true;status.textContent='';};
 copyButton.onclick=async()=>{
  const ids=selection();if(!ids.length)return;
  copyButton.disabled=true;preview.hidden=true;status.textContent='正在准备接入请求…';
  try{
   const result=await api('/api/actions/replacement-handoff','POST',{ids});
   if(!dialog.open||ids.join(',')!==selection().join(','))return;
   preview.value=result.prompt;preview.hidden=false;
   try{await copy(result.prompt);status.textContent='已复制，可粘贴到当前对话。';}
   catch{status.textContent='请手动选择并复制接入请求。';}
  }catch(error){if(dialog.open)status.textContent=error.message;}
  finally{copyButton.disabled=!selection().length;}
 };
 return plans=>{
  const legend=el('legend','待接入方案');
  list.replaceChildren(legend,...plans.map(plan=>{
   const label=el('label'),input=el('input');input.type='checkbox';input.value=plan.id;input.checked=true;
   label.append(input,el('span',plan.clip+' → '+[plan.source.clip,plan.source.sourceName].filter(Boolean).join(' · ')));return label;
  }));
  preview.hidden=true;status.textContent='';copyButton.disabled=!plans.length;
  dialog.showModal();
 };
}
