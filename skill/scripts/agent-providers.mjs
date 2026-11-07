import {prepareDeepSeekProfile} from './deepseek-profile.mjs';
import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {resolveExecutable,execExecutable,commandSpec} from './platform-runtime.mjs';
export const providers=[{id:'codex',label:'Codex',command:'codex',adapter:true},{id:'claude',label:'Claude Code',command:'claude',adapter:true},{id:'workbuddy',label:'WorkBuddy',command:'workbuddy',apps:['WorkBuddy.app']},{id:'deepseek',label:'DeepSeek Harness',command:'dsh',adapter:true,apps:['DeepSeek Harness.app']},{id:'ollama',label:'Ollama',command:'ollama',apps:['Ollama.app']}];
export function providerInfo(id){const p=providers.find(p=>p.id===id);if(!p?.adapter)throw Error('此客户端尚未接入后台执行，请使用原对话交接');return p;}
export function providerLocations(id,{env=process.env,platform=process.platform}={}){
 const p=providerInfo(id),explicit=env[id.toUpperCase()+'_EXECUTABLE']||(id==='deepseek'?env.DSH_EXECUTABLE:undefined);
 const candidates=id==='deepseek'&&platform==='darwin'?['/Applications',join(homedir(),'Applications')].map(root=>join(root,'DeepSeek Harness.app','Contents','Resources','runtime','cli','bin','dsh')):[];
 return {name:p.command,options:{explicit,env,platform,candidates}};
}
export async function probeProvider(id,{env=process.env,platform=process.platform,resolveProgram=resolveExecutable,execProgram=execExecutable}={}){
 const p=providerInfo(id);let executable;
 try{const location=providerLocations(id,{env,platform});executable=await resolveProgram(location.name,location.options);const r=await execProgram(executable,['--version'],{kind:id,env,timeout:8000,maxBuffer:65536});
 if(id==='claude'){const h=await execProgram(executable,['--help'],{kind:id,env,timeout:8000,maxBuffer:131072});if(!['--print','--output-format','--json-schema'].every(f=>String(h.stdout).includes(f)))throw Error('Claude Code 版本缺少所需后台输出接口，请升级后重新扫描');}
 if(id==='deepseek'){const h=await execProgram(executable,['headless','--help'],{kind:id,env,timeout:8000,maxBuffer:131072});if(!['--json','--permission-mode','--approval-policy'].every(f=>String(h.stdout).includes(f)))throw Error('DeepSeek Harness 缺少所需 headless 接口，请升级后重新扫描');}
 return {available:true,executable,version:String(r.stdout||r.stderr||'').trim().slice(0,200),auth:'not-checked'};
 }catch(e){return {available:false,error:String(e.message).replace(/BLENDER_EXECUTABLE/g,id.toUpperCase()+'_EXECUTABLE'),installed:Boolean(executable)};}
}
export async function scanProviders({env=process.env,platform=process.platform,resolveProgram=resolveExecutable,execProgram=execExecutable,exists=async p=>access(p).then(()=>true,()=>false)}={}){
 return {scannedAt:new Date().toISOString(),providers:await Promise.all(providers.map(async p=>{
  if(p.adapter){const result=await probeProvider(p.id,{env,platform,resolveProgram,execProgram});return {id:p.id,label:p.label,...result,status:result.available?'ready':result.installed?'unavailable':'missing',note:result.available?'支持后台任务；登录、额度和工具权限在执行时验证':result.error};}
  let installed=false;try{await resolveProgram(p.command,{env,platform});installed=true;}catch{}
  if(!installed&&platform==='darwin')for(const app of p.apps||[]){if(await exists(join('/Applications',app))||await exists(join(homedir(),'Applications',app))){installed=true;break;}}
  return {id:p.id,label:p.label,available:false,status:installed?'unsupported':'missing',note:installed?'已发现；尚无后台文件修改适配器，可通过原对话交接':'未发现本机客户端'};
 }))};
}
export async function providerCommand(id,{dir,schemaPath,resultPath,schema,images=[]}={}){
 const location=providerLocations(id),executable=await resolveExecutable(location.name,location.options);
 const patch=id==='deepseek'?await prepareDeepSeekProfile(dir):null;
 const args=id==='codex'?['exec','--sandbox','workspace-write','--skip-git-repo-check','--json','--color','never','-C',dir,'--output-schema',schemaPath,'--output-last-message',resultPath,...images.flatMap(p=>['--image',p]),'-']:id==='deepseek'?['--profile','headless','--patch',patch.file,'--json','--permission-mode','workspace-write','--approval-policy','never','-']:['--print','--verbose','--output-format','stream-json','--json-schema',JSON.stringify(schema)];
 return commandSpec(executable,args,{kind:id});
}
