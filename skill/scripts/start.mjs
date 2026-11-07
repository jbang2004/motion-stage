import {callerFromArgs,callerLabel} from '../assets/viewer/caller.mjs';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
import {defaultWorkspace} from './default-workspace.mjs';
const i=process.argv.indexOf('--workspace');let work=resolve(i<0?defaultWorkspace():process.argv[i+1]);
try{
 const caller=callerFromArgs(process.argv);
 if(Number(process.versions.node.split('.')[0])<22)throw Error('需要 Node.js >=22');
 const {serve}=await import('./server.mjs'),{prepareProject,recentProjects}=await import('./project-workspaces.mjs');
 const explicitProject=process.argv.indexOf('--project'),adopt=process.argv.includes('--adopt-current');
 if(explicitProject>=0){
  if(!process.argv[explicitProject+1])throw Error('需要 --project PATH');
  if(adopt&&!existsSync(resolve(work,'project.json')))throw Error('要迁入的工作区不存在，请先打开素材或指定已有 --workspace');
  work=(await prepareProject(adopt?work:null,process.argv[explicitProject+1],{adoptCurrent:adopt})).workspace;
 }else{
  if(i<0){for(const item of await recentProjects()){if(item.workspace&&existsSync(resolve(item.workspace,'project.json'))&&existsSync(resolve(item.workspace,'project-link.json'))){work=resolve(item.workspace);break;}}}
  if(!existsSync(resolve(work,'project.json'))){const r=spawnSync(process.execPath,[resolve(import.meta.dirname,'motion-feedback.mjs'),'init','--workspace',work],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
 }
 const server=await serve(work,0,{caller}),url='http://127.0.0.1:'+server.address().port;
 console.log('\n动作台 MotionStage：'+url+'\n工作区：'+work+'\n任务交给：'+callerLabel(caller)+'（保存后等待领取）'+'\n保持终端运行；Ctrl+C 停止。');
 if(!process.argv.includes('--no-open')){
  const command=process.platform==='darwin'?['open',[url]]:process.platform==='win32'?['cmd',['/c','start','',url]]:['xdg-open',[url]];
  const child=spawn(command[0],command[1],{stdio:'ignore'});child.on('error',()=>console.log('请手动打开上方地址'));child.unref();
 }
}catch(e){console.error(e.message);process.exitCode=1;}
