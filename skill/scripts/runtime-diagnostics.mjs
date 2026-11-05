import {blenderExecutable,resolveExecutable,execExecutable} from './platform-runtime.mjs';
import {mkdtemp,writeFile,rename,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';

const atLeast=(version,minimum)=>{for(let i=0;i<minimum.length;i++){const difference=(version[i]||0)-minimum[i];if(difference)return difference>0;}return true;};

export async function checkWorkspace(workspace){
 let dir;
 try{
  dir=await mkdtemp(join(workspace,'.motion-check-'));
  await writeFile(join(dir,'write'),'motion-ready',{flag:'wx'});
  await rename(join(dir,'write'),join(dir,'read'));
  if(await readFile(join(dir,'read'),'utf8')!=='motion-ready')throw Error('readback mismatch');
  await rm(dir,{recursive:true});dir=null;
  return {status:'ready',path:workspace};
 }catch(e){
  if(dir)try{await rm(dir,{recursive:true});}catch{}
  return {status:'error',path:workspace,error:'工作区无法完成读写、重命名或清理。请选择本机可写目录，检查权限和磁盘空间后重试。',code:e.code||'WORKSPACE_CHECK_FAILED'};
 }
}

/** Capability discovery does not change preferences, log in, or execute a task.
 * Browser graphics and artistic correctness require separate real checks. */
export async function diagnoseRuntime({env=process.env,platform=process.platform,nodeVersion=process.versions.node,workspace,programs=['blender','codex'],timeoutMs=8000,resolveBlender=blenderExecutable,resolveProgram=resolveExecutable,execProgram=execExecutable}={}){
 const nodeSupported=/^\d+\.\d+\.\d+/.test(nodeVersion)&&atLeast(nodeVersion.split('.').map(Number),[22]);
 const probe=async(name)=>{
  if(!programs.includes(name))return {status:'not-checked',available:null,supported:null,...(name==='codex'?{auth:'not-checked'}:{minimumVersion:'4.2.0'})};
  let executable;
  try{
   executable=name==='blender'?await resolveBlender({env,platform}):await resolveProgram('codex',{explicit:env.CODEX_EXECUTABLE,env,platform});
   const result=await execProgram(executable,['--version'],{kind:name==='codex'?'codex':undefined,timeout:timeoutMs,maxBuffer:65536,env});
   const output=String(result.stdout||result.stderr||'').trim(),match=name==='blender'?output.match(/Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i):null;
   if(name==='blender'){
    const version=match?match.slice(1).map(value=>Number(value)||0):null,supported=Boolean(version&&atLeast(version,[4,2]));
    return {status:supported?'ready':'unsupported',available:true,supported,executable,version:version?version.join('.'):output.slice(0,200),minimumVersion:'4.2.0',fbxImporter:'checked-on-import',...(supported?{}:{error:version?'FBX 导入需要 Blender 4.2 或更高版本。':'无法识别 Blender 版本，请检查 BLENDER_EXECUTABLE 指向的程序。'})};
   }
   return {status:'ready',available:true,supported:true,executable,version:output.slice(0,200),auth:'not-checked'};
  }catch(e){return {status:e.code==='EXECUTABLE_NOT_FOUND'?'missing':'error',available:false,supported:false,...(executable?{executable}:{}),error:String(e.message||e)};}
 };
 const [blender,codex,workspaceReport]=await Promise.all([probe('blender'),probe('codex'),workspace?checkWorkspace(workspace):{status:'not-checked'}]);
 const coreReady=nodeSupported&&workspaceReport.status!=='error';
 return {version:1,platform,node:{version:nodeVersion,supported:nodeSupported,minimumVersion:'22.0.0'},workspace:workspaceReport,browser:{webgl2:'not-checked',note:'请在实际浏览器打开工作台检查 WebGL2。'},blender,codex,features:{offlineServer:coreReady,localEdit:coreReady,fbxConversion:coreReady&&blender.supported,automaticAgentExecutable:coreReady&&codex.supported}};
}
