import {mkdir,lstat,realpath,cp,readFile,rename,rm,readdir,rmdir,stat} from 'node:fs/promises';
import {resolve,join,dirname,basename,relative,sep,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {atomic,json,inside,importAsset,withWorkspaceLock,sha,stageAsset,commitWorkspace,readProject} from './core.mjs';
import {buildDemo} from './practice.mjs';
import {getProjectLink,linkProject,detectProjectRoot} from './project-context.mjs';

export const projectWorkspaceName='.motion-studio';
const run=promisify(execFile);
const defaultSettings=()=>join(homedir(),'.motion-atelier','recent-projects.json');
const exists=async p=>!!await lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});

export async function initializeWorkspace(work,{title='动作反馈练习'}={}){
 await mkdir(work,{recursive:true});
 return withWorkspaceLock(work,async()=>{
  const present=await exists(join(work,'project.json'));
  const cfg=present?await readProject(work):{version:3,title,fps:30,slots:{},models:{},legacyAssetId:'legacy'};
  const hasPreview=Boolean(cfg.slots?.baseline||Object.values(cfg.models||{}).some(model=>model.slots?.baseline));
  const hasFeedback=await exists(join(work,'feedback.json'));
  if(present&&hasPreview){if(!hasFeedback)throw Error('工作区缺少反馈记录；已保留模型，请从备份恢复 feedback.json');return {created:false,workspace:work};}
  let feedback=hasFeedback?await json(join(work,'feedback.json')):{version:1,notes:[]};
  const jobs=await readdir(join(work,'jobs')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  if(present&&(jobs.length||!Array.isArray(feedback.notes)||feedback.notes.length))throw Error('工作区初始化不完整且已有历史记录；原数据已保留，请检查备份');
  const bytes=await buildDemo(false),baseline=await stageAsset(work,'baseline',bytes,'原创示例 · 修改前',{project:cfg}),candidate=await stageAsset(work,'candidate',bytes,'原创示例 · 尚未修改',{project:baseline.project});
  await commitWorkspace(work,{'project.json':candidate.project,'feedback.json':feedback});
  return {created:!present,recovered:present,workspace:work};
 });
}

export async function recentProjects({settingsPath=defaultSettings()}={}){
 try{const d=await json(settingsPath);return Array.isArray(d.projects)?d.projects.slice(0,12):[];}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return[];throw e;}
}
async function remember(project,options){
 const rows=await recentProjects(options);const row={id:project.id,name:project.name,root:project.root,workspace:project.workspace,lastOpened:new Date().toISOString()};
 await atomic(options?.settingsPath||defaultSettings(),{version:1,projects:[row,...rows.filter(r=>r.root!==row.root)].slice(0,12)});
}
export async function projectStatus(work,options={}){
 const project=await getProjectLink(work);const root=project?null:await detectProjectRoot(work)||await detectProjectRoot(process.cwd());
 return{status:project?.status==='missing'?'missing':project?'linked':'unlinked',project,suggested:root?{root,name:basename(root)}:null,recent:await recentProjects(options)};
}

export async function prepareProject(work,path,{adoptCurrent=true,settingsPath}={}){
 if(typeof path!=='string'||!path.trim())throw Error('请选择或粘贴项目文件夹路径');
 const projectRoot=await realpath(resolve(path.trim()));if(!(await lstat(projectRoot)).isDirectory())throw Error('项目路径必须是文件夹');
 let target=join(projectRoot,projectWorkspaceName);const oldLink=work?await getProjectLink(work):null;
 // Reuse an explicitly linked external workspace after an artist moves their
 // review data out of the game. Reopening must not recreate files in the game.
 const outside=p=>{const r=relative(projectRoot,p);return r==='..'||r.startsWith('..'+sep)||isAbsolute(r);};
 const registered=[...(oldLink?.root===projectRoot?[oldLink]:[]),...(await recentProjects({settingsPath})).filter(r=>r.root===projectRoot)];
 for(const row of registered){
  if(typeof row.workspace!=='string'||!outside(resolve(row.workspace)))continue;
  const linked=await getProjectLink(row.workspace);
  if(!linked||linked.root!==projectRoot||row.id&&linked.id!==row.id)continue;
  const cfg=await json(join(linked.workspace,'project.json'));if(!cfg.slots)throw Error('已关联的外部工作区数据无效，未在游戏目录创建新资料');
  target=linked.workspace;break;
 }
 const crossProject=!!oldLink&&resolve(oldLink.root)!==projectRoot;
 const result=async(created,migrated,reused)=>{
  const project=await linkProject(target,projectRoot,{name:basename(projectRoot)});await remember(project,{settingsPath});
  return{project,workspace:target,created,migrated,reused,migrationSkippedReason:crossProject?'different-linked-project':null};
 };
 if(await exists(target)){
  const s=await lstat(target);if(s.isSymbolicLink()||!s.isDirectory())throw Error('项目工作区路径已被其他文件占用；未覆盖');
  if(await exists(join(target,'project.json'))){const d=await json(join(target,'project.json'));if(!d.slots)throw Error('已有工作区不是动作台数据，未覆盖');return result(false,false,true);}
  if((await readdir(target)).length)throw Error('项目工作区已有未知文件，已保留。请选择其他项目或先整理该目录。');
 }
 const stage=join(projectRoot,'.motion-studio.init-'+randomUUID());await mkdir(stage);let migrated=false;
 try{
  const from=work?await realpath(work):null;
  if(from&&from!==target&&adoptCurrent&&!crossProject){
   await withWorkspaceLock(from,async()=>{
    const jobs=await import('./jobs.mjs');if((await jobs.listJobs(from)).some(j=>['running','queued'].includes(j.state)))throw Error('当前工作区仍有待执行或运行中的任务。请完成或停止后再关联；原工作区保持可用。');
    const filter=async source=>{if((await lstat(source)).isSymbolicLink())throw Error('工作区含符号链接，未自动迁移：'+relative(from,source));return true;};
    for(const name of ['assets','sources','conversions','incoming','jobs','snapshots','checkpoints','decisions'])if(await exists(join(from,name)))await cp(join(from,name),join(stage,name),{recursive:true,errorOnExist:true,force:false,filter});
    for(const name of ['feedback.json','marks.json','task.md','practice-report.json','catalog.json'])if(await exists(join(from,name)))await cp(join(from,name),join(stage,name),{errorOnExist:true,force:false,filter});
    const cfg=await json(join(from,'project.json')),cfgTime=(await stat(join(from,'project.json'))).mtimeMs;
    // Older studios recorded 'return to original' without moving the active head.
    // Honor only an explicit later legacy decision, preserving its exact selected SHA.
    const prior=(await jobs.listJobs(from,{raw:true})).flatMap(j=>{const r=j.reviews?.at(-1);return j.candidate?.sha256===cfg.slots?.candidate?.sha256&&r?.decision==='keep-baseline'&&!r.recordFile&&Date.parse(r.at)>=cfgTime&&r.assets?.baseline?[{j,r}]:[];}).sort((a,b)=>Date.parse(b.r.at)-Date.parse(a.r.at))[0];
    if(prior){const chosen=prior.r.assets.baseline,bytes=await readFile(await inside(from,chosen.file));if(sha(bytes)!==chosen.sha256)throw Error('先前选择保留的版本已损坏，未迁移');cfg.slots.candidate=structuredClone(chosen);cfg.revision=(cfg.revision||0)+1;cfg.migrationNotes=[...(cfg.migrationNotes||[]),{kind:'honored-recorded-legacy-return',jobId:prior.j.id,from:prior.j.candidate.sha256,to:chosen.sha256,userDecisionAt:prior.r.at,at:new Date().toISOString()}];}
    await atomic(join(stage,'project.json'),cfg);migrated=true;
   });
  }
  if(!await exists(join(stage,'project.json')))await initializeWorkspace(stage,{title:basename(projectRoot)+' · 动作工作区'});
  if(!await exists(join(stage,'feedback.json')))await atomic(join(stage,'feedback.json'),{version:1,notes:[]});
  await linkProject(stage,projectRoot,{name:basename(projectRoot)});
  await atomic(join(stage,'README.txt'),'动作台 MotionStage 项目工作区\n\nassets/ 为按内容哈希保存的原版与候选；jobs/ 保存每次修改要求、观察现场、项目上下文快照、执行输出和候选。checkpoints/ 是用户认可的预览版本，decisions/ 保留每次决定。正式游戏文件不会因预览或认可而自动替换。\n\n复制或备份时保留整个工作区。不要只保留JSON而丢掉引用的GLB。大文件可由项目已有Git LFS或资产存储方案管理；程序不会自动提交或上传。\n');
  await atomic(join(stage,'.gitignore'),'.motion-write.lock/\n.motion-write.ticket-*.json\n*.tmp\ncache/\n');
  if(await exists(target))await rmdir(target); // Only succeeds for an empty directory; never removes user files.
  await rename(stage,target);return result(true,migrated,false);
 }catch(e){
  await rm(stage,{recursive:true,force:true});
  if(['EEXIST','ENOTEMPTY'].includes(e.code)&&await exists(join(target,'project.json')))return result(false,false,true);
  throw e;
 }
}

export async function chooseProjectFolder(){
 let command,args;
 if(process.platform==='darwin'){command='osascript';args=['-e','POSIX path of (choose folder with prompt "选择游戏项目文件夹")'];}
 else if(process.platform==='win32'){command='powershell.exe';args=['-NoProfile','-STA','-Command',"Add-Type -AssemblyName System.Windows.Forms; $motionFolderDialog = New-Object System.Windows.Forms.FolderBrowserDialog; $motionFolderDialog.Description = '选择游戏项目文件夹'; if ($motionFolderDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($motionFolderDialog.SelectedPath) } else { exit 2 }"];}
 else{command='zenity';args=['--file-selection','--directory','--title=选择游戏项目文件夹'];}
 try{const{stdout}=await run(command,args,{timeout:300000,maxBuffer:65536});const path=stdout.trim();return path?{path,cancelled:false}:{path:null,cancelled:true};}
 catch(e){if((process.platform==='darwin'&&/-128/.test(e.stderr||''))||(process.platform==='win32'&&e.code===2)||(process.platform==='linux'&&e.code===1))return{path:null,cancelled:true};throw Error('系统文件夹选择器暂不可用，请直接粘贴项目路径。');}
}

export async function revealWorkspace(work){
 const folder=await realpath(work);
 const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open';
 try{await run(command,[folder],{timeout:10000,maxBuffer:65536});return{opened:true};}
 catch(e){if(process.platform==='win32'&&e.code===1)return{opened:true};throw Error('无法打开系统文件管理器，请复制工作区路径：'+folder);}
}
