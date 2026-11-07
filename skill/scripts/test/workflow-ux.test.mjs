import test from 'node:test';
import assert from 'node:assert/strict';
import {createUndoControls} from '../../assets/viewer/undo-controls.mjs';
import {installShortcuts} from '../../assets/viewer/shortcuts.mjs';
import {resultEvidence,motionReport} from '../../assets/viewer/result-evidence.mjs';
import {taskHandoff,integrationHandoff} from '../../assets/viewer/handoff.mjs';
import {createDocument} from './viewer-dom-fixture.mjs';

test('one shortcut router respects editing, IME, dialogs and the active mode',()=>{
 let handler,mode='library',dialog=false;const calls=[];
 const remove=installShortcuts({windowRef:{addEventListener:(_,fn)=>handler=fn,removeEventListener:(_,fn)=>assert.equal(fn,handler)},documentRef:{querySelector:()=>dialog},mode:()=>mode,search:m=>calls.push(m),play:()=>calls.push('play'),step:n=>calls.push(n),clear:()=>calls.push('clear')});
 const send=extra=>handler({key:'/',target:{tagName:'DIV',closest:()=>null},preventDefault(){this.defaultPrevented=true;},...extra});
 send({});mode='studio';send({});send({defaultPrevented:true});send({isComposing:true});send({ctrlKey:true});send({target:{tagName:'TEXTAREA'}});dialog=true;send({});dialog=false;
 send({key:'ArrowLeft'});send({key:' ',code:'Space',target:{tagName:'BUTTON',closest:()=>({})}});send({key:' ',code:'Space'});send({key:'Escape'});
 assert.deepEqual(calls,['library','studio',-1,'play','clear']);remove();
});
test('tablist navigation takes precedence over animation frame stepping',()=>{
 let handler,selected=-1;const tabs=[0,1,2].map(i=>({focus:()=>{},click:()=>selected=i})),list={querySelectorAll:()=>tabs};
 const target=tabs[1];target.closest=()=>list;
 installShortcuts({windowRef:{addEventListener:(_,fn)=>handler=fn},documentRef:{querySelector:()=>null},step:()=>assert.fail('must not seek')});
 for(const [key,want] of [['ArrowRight',2],['ArrowLeft',0],['Home',0],['End',2]]){handler({key,target,preventDefault(){}});assert.equal(selected,want);}
});
test('evidence distinguishes file checks from measured regression and seeks its exact seconds',()=>{
 const documentRef=createDocument(),times=[],report={kind:'motion-checks',summary:{worsenedWarnings:1},findings:[{kind:'foot_slip',status:'worsened',severity:'warning',node:'LeftFoot',time:[.2,.4],metrics:{slide:{before:.02,after:2}}}],limitations:['仅检查关节位置']};
 assert.equal(motionReport({motionChecks:report}),report);
 const section=resultEvidence({validation:{},audit:{motionChecks:report}},{documentRef,onSeek:t=>times.push(t)});
 assert.match(section.textContent,/文件校验通过/);assert.match(section.textContent,/1 项加重/);assert.match(section.textContent,/0.02 → 2/);assert.match(section.textContent,/不代表艺术认可/);section.querySelectorAll('button')[0].onclick();assert.deepEqual(times,[.2]);
 const local=resultEvidence({audit:{kind:'deterministic-local-edit'}},{documentRef});assert.match(local.textContent,/自然度、碰撞与接触保持未检查/);assert.equal(local.querySelectorAll('button').length,0);
});
test('task and integration handoffs retain the exact task or checkpoint identity',()=>{
 const paths={workspace:'/tmp/审阅 空间',cli:'/app/motion-feedback.mjs'};
 assert.match(taskHandoff({id:'job-A',request:'收小左臂',agentCommand:'exact command'},paths),/job-A[\s\S]*exact command/);
 assert.match(integrationHandoff({kind:'candidate',checkpointId:'point-A',assetId:'hero',clip:'Run'},paths),/认可检查点 point-A[\s\S]*检查游戏并记录接入结果/);
 assert.match(integrationHandoff({kind:'action',actionId:'action-A',clip:'Walk'},paths),/收录动作 action-A/);
});
test('malformed optional evidence cannot break review controls or create unsafe seek targets',()=>{
 const documentRef=createDocument();
 for(const findings of ['invalid',[null,{kind:'foot_slip',severity:'warning',status:'worsened',time:'bad',metrics:{slide:{before:null,after:1}}}]]){
  const section=resultEvidence({audit:{kind:'motion-checks',findings,limitations:'invalid'}},{documentRef,onSeek:()=>assert.fail('invalid time must not seek')});
  for(const button of section.querySelectorAll('button')){assert.equal(button.disabled,true);button.onclick();}
 }
});
test('a single-version motion report does not imply comparison or no new defects',()=>{
 const section=resultEvidence({audit:{kind:'motion-checks',summary:{warnings:1},findings:[{kind:'foot_slip',severity:'warning',node:'LeftFoot',time:[.2,.4]}]}},{documentRef:createDocument(),onSeek:()=>{}});
 assert.match(section.textContent,/未与本轮输入比较/);assert.doesNotMatch(section.textContent,/未报告新增|0 项新增/);assert.equal(section.querySelectorAll('button').length,1);
});
test('content undo shortcuts leave text editing, dialogs and IME with native undo',()=>{
 let handler,dialog=false;const calls=[];installShortcuts({windowRef:{addEventListener:(_,fn)=>handler=fn},documentRef:{querySelector:()=>dialog},undo:()=>calls.push('undo'),redo:()=>calls.push('redo')});
 const send=extra=>handler({key:'z',metaKey:true,target:{tagName:'DIV',closest:()=>null},preventDefault(){calls.push('handled');},...extra});
 send({});send({shiftKey:true});send({metaKey:false,ctrlKey:true});send({target:{tagName:'TEXTAREA'}});send({target:{isContentEditable:true}});send({isComposing:true});dialog=true;send({});
 assert.deepEqual(calls,['handled','undo','handled','redo','handled','undo']);
});

test('undo controls preserve exact entry identity, block double clicks and ignore retired view responses',async()=>{
 const documentRef=createDocument();documentRef.add('button','undoAction');documentRef.add('button','redoAction');let generation=0,resolveWrite,posts=0;const applied=[],errors=[];const target={assetId:'A'},h={assetId:'A',revision:2,undo:{id:'entry-A',label:'采用这版'},reason:''};
 const controls=createUndoControls({documentRef,getTarget:()=>target,begin:()=>({generation}),isCurrent:t=>t.generation===generation,onApplied:r=>applied.push(r),onError:e=>errors.push(e),api:async(_path,method,body,query)=>{if(method==='GET'){assert.equal(query.assetId,target.assetId);return h;}posts++;assert.equal(body.expectedRevision,2);assert.equal(body.entryId,'entry-A');return new Promise(r=>resolveWrite=r);}});
 await controls.refresh();assert.equal(documentRef.getElementById('undoAction').textContent,'撤销采用这版');await controls.run('undo',{assetId:'B',id:'entry-A'});assert.equal(posts,0);
 const pending=controls.run();await controls.run();assert.equal(posts,1);generation+=2;resolveWrite({assetId:'A'});await pending;assert.equal(applied.length,0,'A → B → A cannot apply an old response');assert.equal(errors.length,0);
 target.blocked=true;controls.draw();assert.equal(documentRef.getElementById('undoAction').disabled,true);await controls.run();assert.equal(posts,1);
});
