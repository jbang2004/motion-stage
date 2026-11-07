import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {atomic} from './core.mjs';
// Read only the declarative model selector, never credentials or executable YAML tags.
export function desktopModelSelection(text){
 const rows=String(text).split(/(?=^-\s+id:)/m),row=rows.find(r=>/^-\s+id:\s*['"]?agent-default-model['"]?\s*$/m.test(r));
 if(!row)return null;
 const result={};for(const field of ['provider','model','reasoningEffort']){
  const m=row.match(new RegExp('^    '+field+':\\s*(.+?)\\s*$','m'));if(!m){if(field==='reasoningEffort')continue;throw Error('Harness 桌面模型配置不完整，请在其模型设置中重新选择');}
  let value=m[1];if(value.startsWith('"')){try{value=JSON.parse(value);}catch{throw Error('Harness 桌面模型配置格式不受支持');}}else if(value.startsWith("'")){if(!value.endsWith("'"))throw Error('Harness 桌面模型配置格式不受支持');value=value.slice(1,-1).replaceAll("''", "'");}
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value))throw Error('Harness 桌面模型配置需为普通名称；不执行配置表达式');result[field]=value;
 }
 return result;
}
export async function prepareDeepSeekProfile(dir,{env=process.env}={}){
 const home=env.DSH_HOME||join(homedir(),'.dsh');let selection;
 try{selection=desktopModelSelection(await readFile(join(home,'profiles','desktop','cordis.patch.yml'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 // The public headless profile intentionally disables the managed login store.
 // Enable it for this invocation, using Harness's documented overlay mechanism.
 const patch=[{id:'credentials',disabled:false},{id:'authorization',disabled:false},{id:'deepseek-account',disabled:false}];
 if(selection)patch.push({id:'agent-default-model',config:selection});
 const file=join(dir,'harness-profile.json');await atomic(file,patch);
 await atomic(join(dir,'harness-runtime.json'),{profile:'headless',modelSelection:selection||null,selectionSource:selection?'desktop-default':'headless-default',authentication:'harness-managed-store',permissionMode:'workspace-write',approvalPolicy:'never'});
 return {file,selection};
}
