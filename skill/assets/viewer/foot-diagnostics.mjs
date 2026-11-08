import {element as el,createActionButton} from './ui.mjs';

const grades={slip:'疑似滑动',treadmill:'匀速漂移',planted:'接触较稳'};
const seconds=time=>time.map(t=>t.toFixed(3)).join('–')+' 秒';

export function footDiagnosticReport(result,{partName,onSeek,onRepair,canRepair,documentRef=globalThis.document}){
 const node=(tag,text,cls)=>el(tag,text,cls,documentRef);
 const content=node('div'),columns=node('div',undefined,'foot-diagnostic-columns');
 const end=Math.max(...result.reports.map(report=>report.timeRange[1]));
 content.append(node('h3','脚底滑动诊断'),node('p',result.clip+' · 每秒采样 '+result.fps+' 次','foot-diagnostic-caption'));
 for(const report of result.reports){
  const feet=report.checks.footSlip;
  const column=node('div',undefined,'foot-diagnostic-version');
  const title=result.reports.length===1?'当前画面':report.slot==='baseline'?'修改前':'修改后';
  const count=report.findings.filter(f=>f.kind==='foot_slip').length;
  column.append(node('h4',title),node('p',count?count+' 段疑似滑动':feet.some(f=>f.contacts.length)?'采样未发现疑似滑动':'未获得着地时段','foot-diagnostic-caption'));
  if(!feet.length)column.append(node('p','未识别到可检查的脚节点。'));
  for(const foot of feet){
   const name=partName(foot.foot),group=node('div',undefined,'foot-diagnostic-foot');
   group.append(node('strong',name));
   if(!foot.contacts.length){
    group.append(node('p','未推测出着地时段。','foot-diagnostic-caption'));column.append(group);continue;
   }
   const track=node('div',undefined,'foot-diagnostic-track'),list=node('div',undefined,'foot-diagnostic-list');
   track.setAttribute('aria-hidden','true');
   for(const run of foot.contacts){
    const [start,stop]=run.time,segment=node('span',undefined,run.kind);
    segment.style.left=100*start/end+'%';segment.style.width=100*(stop-start)/end+'%';track.append(segment);
    const row=node('button',undefined,'foot-diagnostic-run '+run.kind);row.type='button';
    row.append(node('b',grades[run.kind]),node('span',seconds(run.time)),node('small',
     run.kind==='treadmill'?'漂移速度 '+run.speed+' 场景单位/秒':'水平漂移 '+run.slide+' 场景单位'));
    row.setAttribute('aria-label',title+' '+name+' '+grades[run.kind]+' '+seconds(run.time));
    row.onclick=()=>{
     if(!onSeek({slot:report.slot,foot,time:start}))return;
     content.querySelector('[aria-current]')?.removeAttribute('aria-current');
     row.setAttribute('aria-current','true');
    };
    const actions=node('div',undefined,'foot-diagnostic-actions');actions.append(row);
    if(run.kind==='slip'&&onRepair){
     const repair=node('button','修复此区间','text-button');repair.type='button';
     repair.setAttribute('aria-label',title+' '+name+' 修复此区间 '+seconds(run.time));
     repair.disabled=!canRepair(report.slot,report.sha256);
     if(repair.disabled)repair.title='请打开当前可编辑版本后发起修复。';
     repair.onclick=()=>onRepair({slot:report.slot,assetSha256:report.sha256,clip:result.clip,foot:foot.foot,nodeIndex:foot.nodeIndex,time:run.time,inPlace:foot.inPlace});
     actions.append(repair);
    }
    list.append(actions);
   }
   group.append(track,list);column.append(group);
  }
  if(report.findings.some(f=>f.kind==='treadmill_speed_mismatch'))column.append(node('p','各次着地的漂移速度不同，请结合游戏移动速度检查。','foot-diagnostic-caption'));
  else if(feet.some(f=>f.inPlace))column.append(node('p','原地动作的接触效果还取决于游戏移动速度。','foot-diagnostic-caption'));
  columns.append(column);
 }
 content.append(columns,node('p','按脚节点高度推测着地。点击区间会跳到起点，并显示素材的原始根位移。并排时按同一秒数对齐。','foot-diagnostic-caption'));
 return content;
}

export function footRepairEvidence(job,{onSeek,partName,onError,documentRef=globalThis.document}){
 const node=(tag,text,cls)=>el(tag,text,cls,documentRef);
 const repair=job.footRepair,{after,reason}=job.footRepairResult||{};
 const section=node('section',undefined,'result-evidence foot-repair-result');
 section.append(node('b','脚底漂移对比'),node('p',partName(repair.foot)+' · '+seconds(repair.time)));
 if(repair.runtime)section.append(node('p','模拟沿 '+repair.runtime.direction+' 每动画秒移动 '+repair.runtime.speed+' 场景单位'));
 if(after){
  const table=node('table',undefined,'foot-repair-metrics'),head=node('thead'),header=node('tr'),body=node('tbody');
  header.append(node('th','场景单位'),node('th','修改前'),node('th','修改后'));head.append(header);
  const metrics=repair.runtime?[['模拟移动后','simulated'],['素材原始漂移','raw']]:[['素材原始漂移','raw']];
  for(const [label,key] of metrics){
   const row=node('tr'),name=node('th',label);name.scope='row';
   row.append(name,node('td',repair.before[key].toFixed(4)),node('td',after[key].toFixed(4)));body.append(row);
  }
  table.append(head,body);section.append(table,node('p','最大水平漂移 · 同一观测区间 · 每秒采样 '+after.fps+' 次'));
  if(repair.inPlace&&!repair.runtime)section.append(node('p','可结合游戏跑速和播放倍率解释原地动作的素材漂移。'));
 }else section.append(node('p',reason||'候选尚无对应区间的测量结果。','error-copy'));
 section.append(createActionButton('对比诊断区间',onSeek,{className:'text-button',ownerDocument:documentRef,onError}));
 return section;
}
