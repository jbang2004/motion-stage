#!/usr/bin/env node
import {motionLibrary,registerMotionPack,saveMotionMapping,previewMotion,adoptMotion,materializeMotion} from './motion-library.mjs';
import {mkdir,readFile,cp,lstat} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {ROOT,VERSION,json,atomic,importAsset,validateFeedback,sha,readMarks} from './core.mjs';
import {serve} from './server.mjs';
import {buildDemo,measureDemo} from './practice.mjs';
import {listJobs,getJob,createJob,claimJob,completeJob,failJob,cancelJob,localEditJob,reviewJob,inspectSlot,checkMotionSlot,importFile,validateJobs,updateJobProgress,replyJob,getJobProjectContext,previewProjectContext,retryJob,restoreJob,interruptJob,jobArtifacts} from './jobs.mjs';
import {projectStatus,prepareProject,initializeWorkspace} from './project-workspaces.mjs';
import {diagnoseRuntime} from './runtime-diagnostics.mjs';
import {catalogPage,startCatalogScan,waitForCatalogScan,openCatalogAsset,stopCatalogScan} from './asset-catalog.mjs';
import {stopCharacterActionDiscovery} from './character-actions.mjs';
import {characterPage,openCharacter,saveCharacterMap,associateCharacterMotion} from './character-library.mjs';
import {appearanceStatus,installAppearance} from './project-appearance.mjs';
import {actionCatalog,formatActionCatalog} from './action-catalog.mjs';
const args=process.argv.slice(2),cmd=args.shift();
const val=k=>{const i=args.indexOf('--'+k);return i<0?undefined:args[i+1];};
const usage=`动作台 MotionStage ${VERSION} · Node >=22\n\ndoctor                        检查 Node、Blender、Codex 可用能力\ninit --workspace PATH           创建独立练习工作区\nserve --workspace PATH [--port 5178]  启动本地查看器（--port 0 自动分配）\nadd --workspace PATH --slot baseline|candidate --file MODEL.glb|MODEL.fbx|MOTION.json [--new-model | --asset-id ID]\nappearance --workspace PATH [--asset-id ID]  查看可选项目外观\nappearance-install --workspace PATH --file MANIFEST.json  安装已审阅的外观适配包\nmotion-library --workspace PATH  查看角色、公共动作、映射与收录版本\nmotion-register|motion-preview|motion-mapping|motion-adopt|motion-prepare --workspace PATH --file PARAMS.json\ncharacters --workspace PATH [--query TEXT]\nactions --workspace PATH [--asset-id ID] [--category attack] [--query TEXT] [--limit 200] [--no-wait] [--json]  角色自带与自动匹配的动作，按类别列出（默认等匹配完成）\ncharacter-map --workspace PATH --file MAP.json  保存已核对的项目角色关联\nopen-character --workspace PATH --asset-id ID [--refresh-source]\nassociate-motion --workspace PATH --asset-id CHARACTER_ID --source-id FILE_ID\nmodels --workspace PATH [--query TEXT] [--offset 0] [--limit 100]\nscan-models --workspace PATH     刷新关联项目模型目录\nopen-model --workspace PATH --asset-id ID [--refresh-source]\ninspect --workspace PATH [--slot baseline] [--asset-id ID]\nmotion-check [--workspace PATH --slot baseline|candidate --asset-id ID | --file MODEL.glb] --clip NAME [--baseline-slot baseline | --baseline-file INPUT.glb] [--feet A,B] [--fps 30] [--options PARAMS.json]  测量旋转翻转、脚滑、膝肘弹直\nproject --workspace PATH        查看关联项目与最近项目\nproject-open --workspace PATH --path PROJECT [--empty] 关联项目并创建项目内工作区\nproject-context --workspace PATH [--job ID | --request TEXT --slot baseline]\njobs --workspace PATH           列出待处理和历史任务\njob --workspace PATH --job ID    读取冻结任务与来源映射\nclaim --workspace PATH --job ID [--owner NAME]\nprogress --workspace PATH --job ID --lease TOKEN --phase reading|editing|checking|exporting --message TEXT\nreply --workspace PATH --job ID --message TEXT\ncomplete --workspace PATH --job ID --lease TOKEN --candidate FILE --summary TEXT\nfail|needs-input --workspace PATH --job ID --lease TOKEN --error TEXT\ncancel --workspace PATH --job ID\ninterrupt --workspace PATH --job ID\nretry --workspace PATH --job ID\nartifacts --workspace PATH --job ID\nrestore --workspace PATH --job ID --expected-revision N [--checkpoint ID]\nlocal-edit --workspace PATH --job ID --bone NAME --factor 0.7\nworker --workspace PATH [--once] 明确启动本机 Codex 自动处理\nmcp --workspace PATH            启动 stdio MCP 工具\npractice --workspace PATH       生成原创练习的修正版与测量报告\nreport --workspace PATH         读取反馈、版本和决定\nvalidate --workspace PATH       核对反馈、版本身份、截图\ninstall --target PATH           安装完整 Skill（目标不得存在）\n\n不写正式游戏文件；全部数据保存在指定工作区。`;
try{
 if(Number(process.versions.node.split('.')[0])<22)throw Error('请安装 Node.js 22 或更高版本');
 if(!cmd||cmd==='help'||cmd==='--help'){console.log(usage);process.exit(0);}
 if(cmd==='install'){
  if(!val('target'))throw Error('需要 --target，例如 ~/.codex/skills/motion-stage');const target=resolve(val('target'));
  try{await lstat(target);throw Error('安装目标已存在，保留原目录；请选择新目录');}catch(e){if(e.code!=='ENOENT')throw e;}
  await mkdir(resolve(target,'..'),{recursive:true});await cp(ROOT,target,{recursive:true,force:false,errorOnExist:true});console.log('已安装：'+target);process.exit(0);
 }
 if(cmd==='doctor'){console.log(JSON.stringify(await diagnoseRuntime({workspace:val('workspace')?resolve(val('workspace')):undefined}),null,2));process.exit(0);}
 if(cmd==='motion-check'){
  const list=k=>val(k)?val(k).split(',').map(x=>x.trim()).filter(Boolean):undefined,extra=val('options')?JSON.parse(await readFile(resolve(val('options')),'utf8')):{};
  const r=await checkMotionSlot(val('workspace')?resolve(val('workspace')):undefined,{...extra,slot:val('slot')||'baseline',assetId:val('asset-id'),file:val('file'),baselineSlot:val('baseline-slot'),baselineFile:val('baseline-file'),clip:val('clip')??extra.clip,fps:val('fps')?Number(val('fps')):extra.fps,feet:list('feet')??extra.feet,checks:list('checks')??extra.checks});
  console.log(JSON.stringify(r,null,2));process.exit(0);
 }
 if(!val('workspace'))throw Error('需要 --workspace PATH');const work=resolve(val('workspace'));
 if(cmd==='motion-library'){console.log(JSON.stringify(await motionLibrary(work),null,2));
 }else if(['motion-register','motion-preview','motion-mapping','motion-adopt','motion-prepare'].includes(cmd)){if(!val('file'))throw Error('需要 --file 指定操作参数 JSON');const fn={'motion-register':registerMotionPack,'motion-preview':previewMotion,'motion-mapping':saveMotionMapping,'motion-adopt':adoptMotion,'motion-prepare':materializeMotion}[cmd];console.log(JSON.stringify(await fn(work,await json(resolve(val('file')))),null,2));
 }else if(cmd==='init'){
  await mkdir(work,{recursive:true});try{await lstat(resolve(work,'project.json'));throw Error('工作区已存在，不覆盖');}catch(e){if(e.code!=='ENOENT')throw e;}
  await initializeWorkspace(work,{title:'动作反馈练习'});
  await cp(resolve(ROOT,'assets/templates/task.md'),resolve(work,'task.md'));console.log('工作区已创建：'+work+'\n下一步：node "'+resolve(ROOT,'scripts/motion-feedback.mjs')+'" serve --workspace "'+work+'"');
 }else if(cmd==='serve'){
  const port=val('port')===undefined?5178:Number(val('port'));if(!Number.isInteger(port)||port<0||port>65535)throw Error('无效端口');const s=await serve(work,port);console.log('动作台 MotionStage：http://127.0.0.1:'+s.address().port+'\n工作区：'+work+'\n保持此终端运行；Ctrl+C 停止。');
 }else if(cmd==='add'){
  if(!val('file'))throw Error('需要 --file');const p=resolve(val('file')),info=await importFile(work,val('slot'),p,{fps:val('fps')?Number(val('fps')):undefined,newModel:args.includes('--new-model'),assetId:val('asset-id')});console.log(JSON.stringify(info,null,2));
 }else if(cmd==='project'){
  console.log(JSON.stringify(await projectStatus(work),null,2));
 }else if(cmd==='appearance'){
  console.log(JSON.stringify(await appearanceStatus(work,val('asset-id')),null,2));
 }else if(cmd==='appearance-install'){
  if(!val('file'))throw Error('需要 --file 外观包清单');console.log(JSON.stringify(await installAppearance(work,resolve(val('file'))),null,2));
 }else if(cmd==='actions'){
  // A CLI run is its own process: matching state does not survive it, so wait
  // by default and stop the background scan before exiting.
  try{const r=await actionCatalog(work,{assetId:val('asset-id'),slot:val('slot')||'baseline',category:val('category'),query:val('query')||'',limit:val('limit'),wait:!args.includes('--no-wait')});
  console.log(args.includes('--json')?JSON.stringify(r,null,2):formatActionCatalog(r));}finally{await stopCharacterActionDiscovery(work);await stopCatalogScan(work);}
 }else if(cmd==='characters'){
  console.log(JSON.stringify(await characterPage(work,{query:val('query'),offset:val('offset'),limit:val('limit')}),null,2));
 }else if(cmd==='character-map'){
  if(!val('file'))throw Error('需要 --file 映射文件');console.log(JSON.stringify(await saveCharacterMap(work,JSON.parse(await readFile(resolve(val('file')),'utf8'))),null,2));
 }else if(cmd==='open-character'){
  console.log(JSON.stringify(await openCharacter(work,val('asset-id'),{refreshSource:args.includes('--refresh-source')}),null,2));
 }else if(cmd==='associate-motion'){
  console.log(JSON.stringify(await associateCharacterMotion(work,val('asset-id'),{assetId:val('source-id')}),null,2));
 }else if(cmd==='models'){
  console.log(JSON.stringify(await catalogPage(work,{query:val('query'),offset:val('offset'),limit:val('limit')}),null,2));
 }else if(cmd==='scan-models'){
  await startCatalogScan(work,{force:true});await waitForCatalogScan(work);console.log(JSON.stringify(await catalogPage(work),null,2));
 }else if(cmd==='open-model'){
  console.log(JSON.stringify(await openCatalogAsset(work,val('asset-id'),{refreshSource:args.includes('--refresh-source')}),null,2));
 }else if(cmd==='project-open'){
  const opened=await prepareProject(work,val('path'),{adoptCurrent:!args.includes('--empty')});await startCatalogScan(opened.workspace,{force:true});await waitForCatalogScan(opened.workspace);console.log(JSON.stringify({...opened,catalog:await catalogPage(opened.workspace)},null,2));
 }else if(cmd==='project-context'){
  console.log(JSON.stringify(val('job')?await getJobProjectContext(work,val('job')):await previewProjectContext(work,{request:val('request')||'',slot:val('slot')||'baseline',clip:val('clip'),parentJobId:val('parent-job')}),null,2));
 }else if(cmd==='jobs'){
  console.log(JSON.stringify({jobs:await listJobs(work)},null,2));
 }else if(cmd==='job'){
  console.log(JSON.stringify(await getJob(work,val('job')),null,2));
 }else if(cmd==='enqueue'){
  const input=JSON.parse(await readFile(resolve(val('input')),'utf8'));console.log(JSON.stringify(await createJob(work,input),null,2));
 }else if(cmd==='claim'){
  console.log(JSON.stringify(await claimJob(work,val('job'),{owner:val('owner')||'agent'}),null,2));
 }else if(cmd==='progress'){
  console.log(JSON.stringify(await updateJobProgress(work,val('job'),{lease:val('lease'),phase:val('phase'),message:val('message'),source:val('source')||'agent'}),null,2));
 }else if(cmd==='reply'){
  console.log(JSON.stringify(await replyJob(work,val('job'),{message:val('message')}),null,2));
 }else if(cmd==='complete'){
  const audit=val('audit')?await json(resolve(val('audit'))):null;console.log(JSON.stringify(await completeJob(work,val('job'),{lease:val('lease'),candidatePath:val('candidate'),summary:val('summary'),audit}),null,2));
 }else if(cmd==='fail'||cmd==='needs-input'){
  console.log(JSON.stringify(await failJob(work,val('job'),{lease:val('lease'),error:val('error'),state:cmd==='needs-input'?'needs-input':'failed'}),null,2));
 }else if(cmd==='interrupt'){
  console.log(JSON.stringify(await interruptJob(work,val('job')),null,2));
 }else if(cmd==='retry'){
  console.log(JSON.stringify(await retryJob(work,val('job')),null,2));
 }else if(cmd==='artifacts'){
  console.log(JSON.stringify(await jobArtifacts(work,val('job')),null,2));
 }else if(cmd==='restore'){
  console.log(JSON.stringify(await restoreJob(work,val('job'),{checkpointId:val('checkpoint'),expectedRevision:Number(val('expected-revision'))}),null,2));
 }else if(cmd==='cancel'){
  console.log(JSON.stringify(await cancelJob(work,val('job')),null,2));
 }else if(cmd==='review'){
  console.log(JSON.stringify(await reviewJob(work,val('job'),{decision:val('decision'),outcome:val('outcome')||''}),null,2));
 }else if(cmd==='local-edit'){
  console.log(JSON.stringify(await localEditJob(work,val('job'),{bone:val('bone'),factor:val('factor')===undefined?.7:Number(val('factor'))}),null,2));
 }else if(cmd==='inspect'){
  console.log(JSON.stringify(await inspectSlot(work,val('slot')||'baseline',val('asset-id')),null,2));
 }else if(cmd==='worker'){
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());const {startWorker}=await import('./agent-worker.mjs');await startWorker(work,{once:args.includes('--once'),signal:controller.signal,onState:s=>console.error(JSON.stringify(s))});
 }else if(cmd==='mcp'){
  const {startMcp}=await import('./mcp.mjs');await startMcp(work);
 }else if(cmd==='practice'){
  const d=await json(resolve(work,'project.json')),original=await buildDemo(false);if(d.slots.baseline?.sha256!==sha(original))throw Error('practice 只用于原始教学角色，不适用于自有模型');
  const info=await importAsset(work,'candidate',await buildDemo(true),'原创示例 · 放松左臂候选');
  const report={type:'teaching-reconstruction',automaticArtisticApproval:false,change:'左臂从嵌向躯干改为稍向外展开；右臂、腿和周期保留',baseline:d.slots.baseline.sha256,candidate:info.sha256,checks:await measureDemo()};
  await atomic(resolve(work,'practice-report.json'),report);console.log(JSON.stringify(report,null,2));
 }else if(cmd==='report'||cmd==='validate'){
  const d=await validateFeedback(work),marks=Object.values((await readMarks(work)).reviews),tasks=await validateJobs(work);console.log(JSON.stringify(cmd==='report'?{...d,version:2,marks,jobs:tasks.jobs}:{valid:true,notes:d.notes.length,marks:marks.length,jobsCount:tasks.jobsCount,assetVersionsChecked:tasks.assetVersionsChecked},null,2));
 }else throw Error('未知命令\n'+usage);
}catch(e){console.error('错误：'+(['EACCES','EPERM','EROFS','ENOSPC'].includes(e.code)?'记录目录操作失败，请检查读写权限和磁盘空间，或选择本机可写目录。\n':'')+e.message);process.exitCode=1;}
