import {element as el} from './ui.mjs';
import {limitationText} from './result-copy.mjs';
const metricLabels={slide:'滑移（场景单位）',degrees:'角度（°）',extension:'超伸比例',speedSpread:'着地速度差比例'};
const rows=value=>Array.isArray(value)?value.filter(f=>f&&typeof f==='object'):[];
const statuses={new:'新增',worsened:'加重',improved:'改善',existing:'已有',resolved:'已解决',unverified:'未验证'};
const kinds={foot_slip:'脚底滑动',limb_pop:'膝肘突跳',limb_stretch:'肢体拉伸',fast_turn:'旋转突跳',ambiguous_segment:'旋转方向不确定',quat_sign_flip:'四元数符号变化',treadmill_speed_mismatch:'着地速度不一致'};
const trackProperties={rotation:'旋转',translation:'位移',scale:'缩放',weights:'形变权重',quaternion:'旋转',vector:'向量',number:'数值'};
const diffLabels={time:'关键帧时间',values:'关键帧数值',interpolation:'插值',added:'新增',removed:'移除',unverified:'未验证'};
export function protectionMessage(job){
 if(!job.lockOtherClips||job.candidateDiff?.protection==='verified')return '';
 return job.candidateDiff?.protection==='violated'?'锁定的其他动作已变化，暂不能采用这版。':'锁定的其他动作尚未验证，暂不能采用这版。';
}
export function candidateDiffEvidence(job,{open=false,documentRef=globalThis.document}={}){
 const node=(tag,text,cls)=>el(tag,text,cls,documentRef);
 const section=node('section',undefined,'result-evidence candidate-diff');
 section.append(node('b','动作改动清单'));
 const diff=job.candidateDiff;
 if(!diff){section.append(node('p','此任务未记录逐轨比较。','evidence-summary'));return section;}
 const {changed,added,removed,unchanged,unverified}=diff.tracks;
 const summary=[changed&&`修改 ${changed} 条`,added&&`新增 ${added} 条`,removed&&`移除 ${removed} 条`,unchanged&&`${unchanged} 条保持一致`].filter(Boolean);
 section.append(node('p',summary.join(' · ')||(unverified||diff.unverifiedClips?'暂无可确认的轨道差异。':'没有可比较的动作轨道。'),'evidence-summary'));
 if(diff.keyframeTimes==='changed')section.append(node('p','有轨道的关键帧时间发生变化。','evidence-summary'));
 if(diff.keyframeTimes==='unchanged'&&changed+unchanged>0)section.append(node('p','关键帧时间保持一致。','evidence-summary'));
 const warning=protectionMessage(job);
 if(warning)section.append(node('p',warning,'candidate-diff-warning'));
 else if(diff.outside)section.append(node('p',`本轮所选动作之外，还有 ${diff.outside} 个动作发生变化。`,'candidate-diff-warning'));
 else if(job.lockOtherClips)section.append(node('p','已验证锁定的其他动作。','evidence-summary'));
 if(unverified||diff.unverifiedClips)section.append(node('p',[`${unverified} 条轨道`,`${diff.unverifiedClips} 个动作`].filter((_,i)=>i?diff.unverifiedClips:unverified).join('、')+'未验证。','evidence-summary'));
 const details=node('details');details.dataset.disclosure='candidate-diff';details.open=open;
 details.append(node('summary','查看逐项差异'));
 for(const clip of diff.clips){
  const group=node('div',undefined,'candidate-diff-group');
  group.append(node('strong',clip.name+(clip.outside?' · 所选动作之外':'')));
  if(clip.status)group.append(node('p','动作'+diffLabels[clip.status]));
  if(clip.durationChanged)group.append(node('p','声明时长变化'));
  for(const row of clip.rows){
   const fields=row.fields.map(field=>diffLabels[field]).join('、');
   group.append(node('p',row.target+' · '+(trackProperties[row.property]||row.property)+' · '+(fields?fields+'变化':diffLabels[row.status])));
  }
  if(clip.unpaired)group.append(node('p','有轨道无法匹配到唯一目标。'));
  if(clip.omittedRows)group.append(node('p',`另有 ${clip.omittedRows} 条轨道计入摘要。`));
  details.append(group);
 }
 if(diff.omittedClips)details.append(node('p',`另有 ${diff.omittedClips} 个动作计入摘要。`));
 if(diff.unverifiedClips||unverified)details.append(node('p','名称不唯一、数据格式不受支持或超出比较预算时，会标为未验证。'));
 details.append(node('p','基于本轮修改前的版本，比较动作轨道、关键帧数据和插值。网格、材质、骨架静止姿势和动作自然度需要另行检查。'));
 section.append(details);return section;
}
export function motionReport(audit){return audit?.kind==='motion-checks'?audit:audit?.motionChecks?.kind==='motion-checks'?audit.motionChecks:null;}
export function resultEvidence(job,{onSeek,documentRef=globalThis.document}={}){
 const node=(tag,text,cls)=>el(tag,text,cls,documentRef),section=node('section',undefined,'result-evidence'),audit=job.audit||{},report=motionReport(job.footRepairResult?.motionChecks)||motionReport(audit);
 const heading=node('div',undefined,'evidence-heading');heading.append(node('b','检查结果'),node('span',job.validation?'文件校验通过':'文件检查未记录','check-badge'));section.append(heading);
 if(report){
  const findings=[...rows(report.findings),...rows(report.unverified)],compared=Boolean(report.baselineSha256)||findings.some(f=>f.status),important=findings.filter(f=>f.severity==='warning'&&(!compared||['new','worsened','unverified'].includes(f.status)));
  const summary=report.summary||{};section.append(node('p',`当前 ${summary.warnings??findings.filter(f=>f.severity==='warning').length} 项警告（含原有问题）`,'evidence-summary'));if(compared)section.append(node('p',`${summary.newWarnings||0} 项新增 · ${summary.worsenedWarnings||0} 项加重 · ${summary.improvedWarnings||0} 项改善 · ${summary.resolvedWarnings||0} 项解决 · ${summary.unverifiedWarnings||0} 项未验证`,'evidence-summary'));else section.append(node('p','仅检查当前版本，未与本轮输入比较。','evidence-summary'));
  const list=node('div',undefined,'finding-list');
  const addFinding=(finding,host)=>{
   const time=Array.isArray(finding.time)&&finding.time.length===2&&finding.time.every(Number.isFinite)?finding.time:null;
   const row=node('button',undefined,'finding '+(finding.status||''));row.type='button';row.append(node('strong',(statuses[finding.status]||'发现')+' · '+(kinds[finding.kind]||finding.kind)),node('span',[finding.node||finding.chain?.join(' → '),time?time.map(x=>x.toFixed(2)).join('–')+' 秒':''].filter(Boolean).join(' · ')));
   const deltas=Object.entries(finding.metrics||{}).filter(([key,m])=>key!=='duration'&&Number.isFinite(m?.before)&&Number.isFinite(m?.after)).map(([key,m])=>`${metricLabels[key]||key} ${Number(m.before.toFixed(4))} → ${Number(m.after.toFixed(4))}`);if(deltas.length)row.append(node('small',deltas.join(' · ')));
   row.disabled=!onSeek||!time;row.onclick=()=>{if(onSeek&&time)onSeek(time[0]);};host.append(row);
  };
  important.slice(0,8).forEach(f=>addFinding(f,list));
  section.append(list);if(important.length>8)section.append(node('p',`另有 ${important.length-8} 项，请展开技术记录查看。`,'evidence-summary'));if(compared&&!important.length)section.append(node('p','本次采样未报告新增或加重的警告；仍需播放检查效果。','evidence-summary'));
   const others=[...findings.filter(f=>!important.includes(f)),...rows(report.resolved)];if(others.length){const disclosure=node('details');disclosure.append(node('summary',`已有、改善与其他发现（${others.length}）`));others.slice(0,12).forEach(f=>addFinding(f,disclosure));if(others.length>12)disclosure.append(node('p','其余发现见原始检查 JSON。'));section.append(disclosure);}
 }else section.append(node('p',audit.kind==='deterministic-local-edit'?'已执行参数变换；自然度、碰撞与接触保持未检查。':'尚未附上运动检查结果。','evidence-summary'));
 const details=node('details');details.dataset.disclosure='evidence';details.append(node('summary','检查范围与技术记录'));
 for(const [key,label]of Object.entries({changedKeyframes:'修改关键帧',factor:'幅度倍率',degrees:'局部旋转角度',axis:'局部旋转轴',bone:'目标部位',clip:'动作',protectedWorldMaxDifference:'保护部位最大差异',sampling:'采样范围'}))if(audit[key]!==undefined)details.append(node('p',label+'：'+(key==='factor'&&Number.isFinite(audit[key])?Math.round(audit[key]*100)+'%':key==='degrees'&&Number.isFinite(audit[key])?audit[key]+'°':typeof audit[key]==='object'?JSON.stringify(audit[key]):audit[key])));
 const limitations=[...(Array.isArray(audit.limitations)?audit.limitations:[]),...(report!==audit&&Array.isArray(report?.limitations)?report.limitations:[]),...(Array.isArray(job.validation?.limitations)?job.validation.limitations:[])];
 for(const value of limitations)details.append(node('p',limitationText(value,audit.kind)));
 if(job.footRepairResult?.motionCheckError)details.append(node('p','脚滑候选的动作检查未完成。'+job.footRepairResult.motionCheckError));
 details.append(node('p','文件与数值检查不代表艺术认可；游戏内表现需在接入时检查。'));
 const raw=node('details');raw.append(node('summary','原始检查 JSON'),node('pre',JSON.stringify({audit:job.audit,validation:job.validation,footRepair:job.footRepairResult},null,2)));details.append(raw);section.append(details);return section;
}
