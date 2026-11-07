import {element as el} from './ui.mjs';
import {limitationText} from './result-copy.mjs';
const metricLabels={slide:'滑移（场景单位）',degrees:'角度（°）',extension:'超伸比例',speedSpread:'着地速度差比例'};
const rows=value=>Array.isArray(value)?value.filter(f=>f&&typeof f==='object'):[];
const statuses={new:'新增',worsened:'加重',improved:'改善',existing:'已有',resolved:'已解决',unverified:'未验证'};
const kinds={foot_slip:'脚底滑动',limb_pop:'膝肘突跳',limb_stretch:'肢体拉伸',fast_turn:'旋转突跳',ambiguous_segment:'旋转方向不确定',quat_sign_flip:'四元数符号变化',treadmill_speed_mismatch:'着地速度不一致'};
export function motionReport(audit){return audit?.kind==='motion-checks'?audit:audit?.motionChecks?.kind==='motion-checks'?audit.motionChecks:null;}
export function resultEvidence(job,{onSeek,documentRef=globalThis.document}={}){
 const node=(tag,text,cls)=>el(tag,text,cls,documentRef),section=node('section',undefined,'result-evidence'),audit=job.audit||{},report=motionReport(audit);
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
 for(const [key,label]of Object.entries({changedKeyframes:'修改关键帧',factor:'幅度倍率',bone:'目标部位',clip:'动作',protectedWorldMaxDifference:'保护部位最大差异',sampling:'采样范围'}))if(audit[key]!==undefined)details.append(node('p',label+'：'+(key==='factor'&&Number.isFinite(audit[key])?Math.round(audit[key]*100)+'%':typeof audit[key]==='object'?JSON.stringify(audit[key]):audit[key])));
 const limitations=[...(Array.isArray(audit.limitations)?audit.limitations:[]),...(report!==audit&&Array.isArray(report?.limitations)?report.limitations:[]),...(Array.isArray(job.validation?.limitations)?job.validation.limitations:[])];
 for(const value of limitations)details.append(node('p',limitationText(value,audit.kind)));
 details.append(node('p','文件与数值检查不代表艺术认可；游戏内表现需在接入时检查。'));
 const raw=node('details');raw.append(node('summary','原始检查 JSON'),node('pre',JSON.stringify({audit:job.audit,validation:job.validation},null,2)));details.append(raw);section.append(details);return section;
}
