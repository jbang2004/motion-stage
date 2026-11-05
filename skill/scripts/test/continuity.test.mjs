import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {buildContinuity} from '../continuity.mjs';

const sha=name=>createHash('sha256').update(name).digest('hex');
const asset=name=>({sha256:sha(name),file:'assets/'+sha(name)+'.glb',label:name});
const at=n=>new Date(Date.UTC(2026,0,1)+n*1000).toISOString();
function job(id,source,candidate,options={}){
 const n=options.n??1;
 return {version:2,id,state:'complete',slot:'candidate',clip:'Walk',request:'左上臂摆动收小，另一只手与脚步不变。',preserve:'',inputs:{baseline:asset('character-A-original'),candidate:asset(source)},candidate:asset(candidate),scope:{start:0,end:1,wholeClip:true},target:{bone:'LeftArm'},summary:'AI completed the old goal; NOT a new instruction.',createdAt:at(n),finishedAt:at(n+.2),reviews:[],...options};
}
function current(source,options={}){return {version:2,id:'current-task',state:'queued',slot:'candidate',clip:'Walk',request:'现在只改肘部。',preserve:'',inputs:{baseline:asset('character-A-original'),candidate:asset(source)},scope:{start:0,end:1,wholeClip:true},context:{time:.3},createdAt:at(1000),...options};}
function review(j,decision,outcome,n=10,options={}){return {decision,outcome,assets:{baseline:j.inputs.baseline,candidate:j.candidate},at:at(n),...options};}
async function write(w,name,data){const p=resolve(w,name);await mkdir(dirname(p),{recursive:true});await writeFile(p,JSON.stringify(data,null,2)+'\n');}
async function workspace(rows=[]){const w=await mkdtemp(resolve(tmpdir(),'motion-continuity-'));await mkdir(resolve(w,'jobs'));for(const j of rows)await write(w,'jobs/'+j.id+'/job.json',j);return w;}
async function snapshot(w){const result={};async function visit(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){const key=prefix+e.name;if(e.isDirectory())await visit(resolve(dir,e.name),key+'/');else if(e.isFile())result[key]=(await readFile(resolve(dir,e.name))).toString('base64');}}await visit(w);return result;}

test('two real ancestry rounds retain user requirements, exact accepted version and original request clauses',async()=>{
 const first=job('first','character-A-original','A-1',{n:1,preserve:'右臂和腿脚保持。',request:'左臂缩小三成，材质和时长不能动。'});
 first.reviews=[review(first,'accept-candidate','这版摆动自然，保留。',2)];
 const second=job('second','A-1','A-2',{n:3,parentJobId:'first',preserve:'保留已满意的肩部，只微调肘部。',clarifications:[{message:'说的是角色自己的左侧。',at:at(3.1)}],error:'曾经缺源的旧错误，不应继续污染',summary:'AI猜测：下一轮应该放大头部。'});
 const w=await workspace([first,second]);
 try{
  const before=await snapshot(w),input=current('A-2',{parentJobId:'second'}),unchanged=structuredClone(input);
  const packet=await buildContinuity(w,input);
  assert.deepEqual(packet.ancestry.map(j=>j.id),['first','second']);assert.equal(packet.parentJobId,'second');assert.equal(packet.parentSelection,'explicit');
  assert.equal(packet.inheritedRequirements.length,2);assert.equal(packet.inheritedRequirements[0].text,'右臂和腿脚保持。');
  assert.ok(packet.historicalInstructions.some(r=>r.text==='左臂缩小三成，材质和时长不能动。'));
  assert.ok(packet.historicalInstructions.some(r=>r.text==='说的是角色自己的左侧。'));
  assert.equal(packet.activeAcceptedCheckpoint.sha256,sha('A-1'));assert.equal(packet.activeAcceptedCheckpoint.outcome,'这版摆动自然，保留。');
  assert.equal(packet.acceptedCheckpoints.some(r=>r.sha256===sha('A-2')),false,'technical completion is not user acceptance');
  assert.equal(JSON.stringify(packet.inheritedRequirements).includes('放大头部'),false);
  assert.equal(JSON.stringify(packet).includes('曾经缺源的旧错误'),false);
  assert.ok(packet.ancestry.every(r=>r.goalState==='completed-background-only'));
  assert.deepEqual(input,unchanged);assert.deepEqual(await snapshot(w),before,'the projection never changes source files or job facts');
 }finally{await rm(w,{recursive:true,force:true});}
});

test('comparison slots do not join another character; returning to original creates a fresh branch',async()=>{
 const accepted=job('accepted','character-A-original','A-good',{n:1,preserve:'此分支保持脚步。'});accepted.reviews=[review(accepted,'accept-candidate','候选可用',2)];
 const bad=job('bad','character-A-original','A-bad',{n:3,preserve:'这条分支的旧约束'});bad.reviews=[review(bad,'keep-baseline','前臂像锁死，保留原动作。',4)];
 const other=job('other-character','character-B-original','B-1',{n:5,inputs:{baseline:asset('character-A-original'),candidate:asset('character-B-original')},preserve:'B角色绝不能混入',request:'B角色特殊反馈'});other.reviews=[review(other,'accept-candidate','B角色验收',6)];
 const w=await workspace([accepted,bad,other]);
 try{
  const packet=await buildContinuity(w,current('character-A-original'));
  assert.equal(packet.parentJobId,null);assert.equal(packet.parentSelection,'new-branch');assert.deepEqual(packet.ancestry,[]);assert.deepEqual(packet.inheritedRequirements,[]);
  assert.equal(packet.activeAcceptedCheckpoint,null);assert.equal(packet.acceptedCheckpoints.length,1);assert.equal(packet.acceptedCheckpoints[0].onSourceAncestry,false);
  assert.equal(packet.rejectedApproaches[0].outcome,'前臂像锁死，保留原动作。');assert.equal(packet.rejectedApproaches[0].candidateSha,sha('A-bad'));
  assert.equal(JSON.stringify(packet).includes('B角色'),false);assert.equal(packet.familySha256.includes(sha('B-1')),false);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('clip changes bridge asset provenance without importing another motion requirements or approvals',async()=>{
 const walk=job('walk-edit','character-A-original','A-walk',{n:1,preserve:'Walk脚步不变。'});walk.reviews=[review(walk,'accept-candidate','Walk这一版满意',2)];
 const run=job('run-edit','A-walk','A-run',{n:3,clip:'Run',parentJobId:'walk-edit',preserve:'Run独有保留要求，不可混到Walk',request:'Run独有目标'});run.reviews=[review(run,'accept-candidate','Run独有验收',4)];
 const w=await workspace([walk,run]);
 try{
  const packet=await buildContinuity(w,current('A-run'));
  assert.equal(packet.parentJobId,'run-edit');assert.deepEqual(packet.ancestry.map(j=>j.id),['walk-edit']);assert.deepEqual(packet.bridgeJobs.map(j=>j.id),['run-edit']);
  assert.equal(packet.inheritedRequirements.length,1);assert.equal(packet.activeAcceptedCheckpoint.sha256,sha('A-walk'));
  assert.equal(JSON.stringify(packet).includes('Run独有'),false);assert.equal(packet.acceptedCheckpoints.length,1);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('different owners for identical candidate bytes require an explicit valid parent; equivalent duplicate records can use latest',async()=>{
 const one=job('owner-one','character-A-original','same-output',{n:1,preserve:'保留衣料'}),two=job('owner-two','character-A-original','same-output',{n:2,preserve:'这次允许改衣料'});
 const w=await workspace([one,two]);
 try{
  const ambiguous=await buildContinuity(w,current('same-output'));
  assert.equal(ambiguous.parentJobId,null);assert.equal(ambiguous.requiresClarification,true);assert.equal(ambiguous.ambiguities[0].kind,'multiple-candidate-owners');assert.deepEqual(ambiguous.inheritedRequirements,[]);
  const explicit=await buildContinuity(w,current('same-output',{parentJobId:'owner-one'}));assert.equal(explicit.parentJobId,'owner-one');assert.equal(explicit.inheritedRequirements[0].text,'保留衣料');
  const invalid=await buildContinuity(w,current('same-output',{parentJobId:'not-in-this-chain'}));assert.equal(invalid.requiresClarification,true);assert.ok(invalid.warnings.some(s=>s.includes('parentJobId')));
  two.preserve=one.preserve;await write(w,'jobs/owner-two/job.json',two);
  const duplicate=await buildContinuity(w,current('same-output'));assert.equal(duplicate.parentJobId,'owner-two');assert.equal(duplicate.requiresClarification,false);assert.ok(duplicate.warnings.some(s=>s.includes('等价')));
 }finally{await rm(w,{recursive:true,force:true});}
});

test('latest appended user decision supersedes an earlier acceptance without rewriting any review',async()=>{
 const row=job('change-mind','character-A-original','A-1',{n:1,preserve:'保持右臂'});
 row.reviews=[review(row,'accept-candidate','刚开始觉得可以',10),review(row,'revise','回看后觉得肩膀僵硬，撤回这次认可。',9)];
 const w=await workspace([row]);
 try{
  const before=await snapshot(w),p=await buildContinuity(w,current('A-1',{request:'这轮允许改右臂，但保持腿脚。'}));
  assert.equal(p.acceptedCheckpoints.length,1);assert.equal(p.acceptedCheckpoints[0].stillAccepted,false);assert.equal(p.activeAcceptedCheckpoint,null);assert.equal(p.latestSourceDecision.decision,'revise');
  assert.equal(p.rejectedApproaches[0].outcome,'回看后觉得肩膀僵硬，撤回这次认可。');assert.equal(p.rejectedApproaches[0].superseded,false);
  assert.equal(p.inheritedRequirements[0].text,'保持右臂');assert.match(p.requirementsPolicy.precedence,/Current explicit user/);assert.equal(p.inheritedRequirements[0].status,'inherited-unless-current-user-overrides');assert.deepEqual(await snapshot(w),before);
  row.reviews.push(review(row,'accept-candidate','确认这个精确版本可用',11));await write(w,'jobs/change-mind/job.json',row);
  const q=await buildContinuity(w,current('A-1'));assert.equal(q.acceptedCheckpoints.length,2);assert.equal(q.activeAcceptedCheckpoint.outcome,'确认这个精确版本可用');assert.equal(q.rejectedApproaches[0].superseded,true);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('long histories bound the display chain but retain every preserve clause, raw user instruction and accepted checkpoint',async()=>{
 const rows=[];
 for(let i=0;i<40;i++){const row=job('round-'+String(i).padStart(2,'0'),i?'A-'+(i-1):'character-A-original','A-'+i,{n:i+1,preserve:'保留条件 '+i,request:'旧目标 '+i+'，其中还有原话约束。'});if(i===0)row.reviews=[review(row,'accept-candidate','最早已验收版本',1.5)];rows.push(row);}
 const w=await workspace(rows);
 try{
  const p=await buildContinuity(w,current('A-39'));assert.equal(p.ancestry.length,32);assert.equal(p.ancestryTotal,40);assert.equal(p.ancestry[0].id,'round-08');assert.equal(p.inheritedRequirements.length,40);assert.equal(p.historicalInstructions.length,40);assert.equal(p.activeAcceptedCheckpoint.sha256,sha('A-0'));assert.ok(p.warnings.some(s=>s.includes('省略 8 条')));
 }finally{await rm(w,{recursive:true,force:true});}
});

test('legacy exact user reviews and preserve fields survive; marks preferences, cleared choices and other roles do not become approvals',async()=>{
 const w=await workspace();
 try{
  const n={id:'old-note',asset:asset('character-A-original'),slot:'baseline',clip:'Walk',time:.3,observed:'旧观察原话',expected:'左臂放低，同时脚步保持。',acceptance:'同一镜头检查',preserve:'白衣材质保持。',status:'resolved',decision:'accept-candidate',reviews:[{decision:'accept-candidate',outcome:'这次的衣摆可以。',assets:{baseline:asset('character-A-original'),candidate:asset('A-legacy')},at:at(2)}]};
  await write(w,'feedback.json',{version:1,notes:[n,{...n,id:'other-role',asset:asset('B-original'),reviews:[],observed:'其他角色不可混入'},{...n,id:'other-clip',clip:'Run',observed:'其他动作不可混入'}]});
  await write(w,'marks.json',{version:1,reviews:{one:{asset:asset('A-legacy'),reference:asset('character-A-original'),clip:'Walk',choice:'',verdict:'',note:'已清除偏好，不能当认可',history:[{choice:'candidate',note:'只是偏好',at:at(3),context:{slots:{candidate:asset('A-legacy'),baseline:asset('character-A-original')}}},{choice:'',note:'已清除偏好',at:at(4),context:{slots:{candidate:asset('A-legacy'),baseline:asset('character-A-original')}}}]},foreign:{asset:asset('B-original'),clip:'Walk',choice:'candidate',note:'另一角色偏好'}}});
  const p=await buildContinuity(w,current('A-legacy'));
  assert.equal(p.ancestry.length,0,'legacy family association cannot invent a producing parent job');assert.equal(p.acceptedCheckpoints.length,1);assert.equal(p.activeAcceptedCheckpoint.sha256,sha('A-legacy'));assert.equal(p.inheritedRequirements[0].text,'白衣材质保持。');
  assert.equal(p.legacyReferences.length,2);assert.equal(p.legacyReferences[0].expected,'左臂放低，同时脚步保持。');assert.equal(p.legacyReferences[1].choice,'');assert.equal(p.legacyReferences[1].history.length,2);assert.equal(JSON.stringify(p).includes('其他角色不可混入'),false);assert.equal(JSON.stringify(p).includes('另一角色偏好'),false);assert.equal(JSON.stringify(p).includes('其他动作不可混入'),false);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('missing candidate identity cannot turn a legacy decision or AI artisticDecision flag into a checkpoint',async()=>{
 const auto=job('auto-flag','character-A-original','A-1',{artisticDecision:'accept-candidate',automaticArtisticApproval:true});
 auto.reviews=[review(auto,'accept-candidate','AI自行验收不能代表用户',2,{actor:'agent',automatic:true})];
 const w=await workspace([auto]);
 try{
  await write(w,'feedback.json',{version:1,notes:[{id:'unbound',asset:asset('A-1'),slot:'baseline',clip:'Walk',expected:'旧原话',decision:'accept-candidate',outcome:'旧记录缺候选身份',status:'resolved'}]});
  const p=await buildContinuity(w,current('A-1'));assert.deepEqual(p.acceptedCheckpoints,[]);assert.equal(p.activeAcceptedCheckpoint,null);assert.equal(p.legacyReferences.length,1);assert.ok(p.warnings.some(s=>s.includes('没有冻结候选版本')));
 }finally{await rm(w,{recursive:true,force:true});}
});

test('a wrongly attached legacy review and another character in mark history do not contaminate the selected asset',async()=>{
 const a=job('a','character-A-original','A-1');const w=await workspace([a]);
 try{
  await write(w,'feedback.json',{version:1,notes:[{id:'foreign-note',asset:asset('B-original'),slot:'baseline',clip:'Walk',observed:'FOREIGN USER WORDS',expected:'FOREIGN GOAL',preserve:'FOREIGN PRESERVE',reviews:[{decision:'accept-candidate',outcome:'FOREIGN OUTCOME',assets:{baseline:asset('character-A-original'),candidate:asset('A-1')},at:at(2)}]}]});
  await write(w,'marks.json',{version:1,reviews:{mark:{asset:asset('A-1'),clip:'Walk',note:'本角色的标记',choice:'',history:[{note:'FOREIGN MARK HISTORY',choice:'candidate',context:{slots:{baseline:asset('B-original'),candidate:asset('B-1')}}},{note:'本角色历史',choice:'',context:{slots:{candidate:asset('A-1')}}}]}}});
  const p=await buildContinuity(w,current('A-1'));assert.equal(JSON.stringify(p).includes('FOREIGN'),false);assert.equal(p.acceptedCheckpoints.length,0);assert.equal(p.legacyReferences.length,1);assert.equal(p.legacyReferences[0].history.length,1);
 }finally{await rm(w,{recursive:true,force:true});}
});

test('ambiguous ordering of undated approvals keeps history without guessing an active accepted version',async()=>{
 const a=job('a','character-A-original','A-1',{n:1}),b=job('b','A-1','A-2',{n:2});a.reviews=[review(a,'accept-candidate','A1',3,{at:null})];b.reviews=[review(b,'accept-candidate','A2',4)];
 const w=await workspace([a,b]);
 try{const p=await buildContinuity(w,current('A-2'));assert.equal(p.acceptedCheckpoints.length,2);assert.equal(p.activeAcceptedCheckpoint,null);assert.equal(p.requiresClarification,true);assert.ok(p.warnings.some(s=>s.includes('没有明确先后时间')));}finally{await rm(w,{recursive:true,force:true});}
});

test('moving a workspace ignores obsolete absolute metadata paths and leaves all stored bytes unchanged',async()=>{
 const a=job('portable','character-A-original','A-1',{n:1,preserve:'保护手臂',taskPath:'/old/nonexistent-machine/jobs/task.md'});a.inputs.candidate.file='/old/nonexistent-machine/assets/source.glb';a.candidate.file='/old/nonexistent-machine/assets/candidate.glb';a.reviews=[review(a,'accept-candidate','可迁移的验收',2)];
 const w=await workspace([a]),moved=await mkdtemp(resolve(tmpdir(),'motion-continuity-moved-'));
 try{
  await cp(w,moved,{recursive:true});const before=await snapshot(moved),p=await buildContinuity(w,current('A-1')),q=await buildContinuity(moved,current('A-1'));
  assert.deepEqual(p,q);assert.equal(JSON.stringify(q).includes('/old/nonexistent-machine'),false);assert.deepEqual(await snapshot(moved),before);
  const alias=resolve(moved,'workspace-alias');await symlink(w,alias,'junction');assert.deepEqual(await buildContinuity(alias,current('A-1')),p);
 }finally{await rm(w,{recursive:true,force:true});await rm(moved,{recursive:true,force:true});}
});

test('broken parent references, malformed unrelated records and cycles produce visible warnings without fabricated requirements',async()=>{
 const a=job('cycle-a','A-2','A-1',{createdAt:null,finishedAt:null}),b=job('cycle-b','A-1','A-2',{createdAt:null,finishedAt:null});
 const w=await workspace([a,b]);
 try{
  await mkdir(resolve(w,'jobs/broken'));await writeFile(resolve(w,'jobs/broken/job.json'),'{bad json');
  const p=await buildContinuity(w,current('A-2'));assert.equal(p.lineageComplete,false);assert.ok(p.warnings.some(s=>s.includes('循环')));assert.ok(p.warnings.some(s=>s.includes('无法读取历史记录')));assert.equal(new Set(p.ancestry.map(r=>r.id)).size,p.ancestry.length);
  await assert.rejects(buildContinuity(w,{inputs:{},slot:'candidate'}),/有效 SHA-256/);
 }finally{await rm(w,{recursive:true,force:true});}
});
