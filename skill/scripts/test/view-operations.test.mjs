import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createViewState} from '../../assets/viewer/view-state.mjs';

const app=await readFile(new URL('../../assets/viewer/app.js',import.meta.url),'utf8');
const extract=(from,to)=>{const start=app.indexOf(from),end=app.indexOf(to,start);assert.ok(start>=0&&end>start);return app.slice(start,end);};
const poll=extract('let polling=false,pollErrors=0;','\nfunction commitJobResult(');
const commit=extract('function commitJobResult(','\nasync function createJob(');
const create=extract('async function createJob(','\nasync function submitRequest(');
const submit=extract('async function submitRequest(','\n$(\'requestForm\').onsubmit');
const local=extract('async function runLocalEdit(){',"\n$('localEdit').onclick=runLocalEdit;");
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);
const asset=(id='A',sha256='source')=>({assetId:id,sha256,file:'assets/'+sha256+'.glb'});
const queued={id:'local-job',assetId:'A',state:'queued',slot:'baseline',executor:'local',inputs:{baseline:asset(),candidate:asset()},scope:{wholeClip:false,start:.2,end:.8}};
const complete={...queued,state:'complete',candidate:asset('A','edited'),audit:{factor:.7}};
function harness({createGate,createError,editGate,result=complete,editError,getResult,refreshError,range={wholeClip:false,start:.2,end:.8}}={}){
 const view=createViewState('A');view.markLoaded(view.beginLoad(),'A');
 const state={ready:true,initialized:true,loading:false,switching:false,capturing:false,submitting:false,archivedJobId:null,panelMode:'compose',project:{activeAssetId:'A',slots:{baseline:asset(),candidate:asset()}},models:{baseline:{meta:asset(),action:{}},candidate:{meta:asset(),action:{}}},jobs:[],allJobs:[],agent:{connected:true},target:{bone:'LeftShoulder'}};
 const fields=new Map(),field=id=>{if(!fields.has(id))fields.set(id,{value:'',disabled:false,textContent:'',focus(){},showModal(){}});return fields.get(id);};field('swingFactor').value='.7';field('request').value='Current A draft';field('preserve').value='Keep all other tracks';
 const requests=[],errors=[],shown=[],toasts=[],refreshes=[],pollGates=[],notices=[];let scopeValue=range;
 const api=async(path,method='GET',body,request)=>{
  requests.push({path,method,body,request});
  if(path==='/api/studio'){assert.ok(pollGates.length,'unexpected poll');return pollGates.shift().promise;}
  if(path==='/api/jobs'){if(createError)throw Error(createError);return createGate?createGate.promise:structuredClone(queued);}
  if(path==='/api/jobs/local-job/local-edit'){if(editError)throw Error(editError);return editGate?editGate.promise:structuredClone(result);}
  if(path==='/api/jobs/local-job')return structuredClone(getResult||{...queued,state:'failed',error:'stored failure'});
  throw Error('Unexpected API '+path);
 };
 const ctx=vm.createContext({state,viewState:view,$:field,api,clearTimeout,structuredClone,
  context:()=>({assetId:view.loadedAssetId,slot:'baseline',asset:state.models.baseline.meta}),scope:()=>({...scopeValue}),activeSlot:()=> 'baseline',activeModel:()=>state.models.baseline,parentJobId:()=>null,captureStage:()=>({toDataURL:()=> 'data:image/png;base64,fixture'}),canvas:{toDataURL:()=> 'data:image/png;base64,fixture'},
  updateSideWarning:()=>null,render(){},drawJobs(){},updateClock(){},updateTaskClock(){},drawMetadata(){},drawLatestJob(){},drawAgent(){},drawCatalog(){},loadJobHistory:async()=>{},mergeJobSummary:s=>s,persistView(){},updateDisplay(){},notice:message=>notices.push(message),connectAgent:async()=>assert.fail('Agent must not connect in fixture'),errorString:e=>typeof e==='string'?e:e?.message||'',fail:error=>errors.push(error.message),toast:message=>toasts.push(message),
  refreshModels:async()=>{refreshes.push(true);const ticket=view.beginLoad();assert.ok(ticket);if(refreshError)throw Error(refreshError);assert.ok(view.markLoaded(ticket,'A'));state.project.slots.candidate=asset('A','edited');state.models.candidate.meta=asset('A','edited');return {candidateChanged:true};},
  showCandidate:async job=>{assert.equal(job.state,'complete');assert.ok(job.candidate&&job.inputs.baseline);shown.push(job);const ticket=view.beginLoad();assert.ok(view.markLoaded(ticket,'A'));state.display='split';return true;}
 });
 vm.runInContext('let projectPreviewTimer,projectPreviewSeq=0,projectPreviewPendingKey;\n'+poll+'\n'+commit+'\n'+create+'\n'+submit+'\n'+local,ctx);
 return {view,state,field,ctx,requests,errors,shown,toasts,refreshes,pollGates,notices,setRange:value=>scopeValue=value,
  run:()=>vm.runInContext('runLocalEdit()',ctx),poll:()=>vm.runInContext('pollStudio()',ctx),submit:()=>vm.runInContext('submitRequest({connect:false})',ctx),
  select(id){view.select(id);view.markLoaded(view.beginLoad(),id);state.project={activeAssetId:id,slots:{baseline:asset(id),candidate:asset(id)}};state.models={baseline:{meta:asset(id),action:{}},candidate:{meta:asset(id),action:{}}};state.jobs=[{id:'current-'+id,assetId:id,state:'running'}];field('request').value='Current '+id+' draft';}
 };
}
const studio=(jobs=[queued])=>({project:{activeAssetId:'A',slots:{baseline:asset(),candidate:asset()}},jobs});

test('mutation tickets retire older polls without changing the loaded model identity',()=>{
 const view=createViewState('A');view.markLoaded(view.beginLoad(),'A');const old=view.capture(),write=view.beginMutation();
 assert.equal(view.loadedAssetId,'A');assert.equal(view.isUnchanged(old,'A'),false);assert.equal(view.isCurrentMutation(write,'A'),true);assert.equal(view.beginLoad(old),null);
 const load=view.beginLoad();assert.equal(view.markLoaded(load,'A'),true);assert.equal(view.isCurrentMutation(write,'A'),true);assert.equal(view.isUnchanged(write,'A'),false);
});

for(const arrival of ['during-edit','after-complete'])test(`local POST complete wins over an already in-flight queued poll arriving ${arrival}`,async()=>{
 const editGate=deferred(),oldPoll=deferred(),h=harness({editGate});h.pollGates.push(oldPoll);const polling=h.poll(),editing=h.run();await tick();assert.equal(h.state.jobs[0].state,'queued');
 if(arrival==='during-edit'){oldPoll.resolve(studio());await polling;assert.equal(h.state.submitting,true);}
 editGate.resolve(structuredClone(complete));await editing;
 if(arrival==='after-complete'){oldPoll.resolve(studio());await polling;}
 assert.deepEqual(h.errors,[]);assert.equal(h.shown.length,1);assert.equal(h.shown[0].candidate.sha256,'edited');assert.equal(h.state.jobs[0].state,'complete');assert.equal(h.state.allJobs[0].state,'complete');assert.equal(h.state.submitting,false);assert.equal(h.toasts.length,1);
 // Normal polling resumes, rather than retaining a stuck in-flight flag.
 const fresh=deferred();h.pollGates.push(fresh);const next=h.poll();fresh.resolve({project:h.state.project,jobs:[complete]});await next;assert.equal(h.state.jobs[0].state,'complete');
});

test('failed local result stays failed when an older queued poll arrives, without loading a candidate',async()=>{
 const oldPoll=deferred(),failed={...queued,state:'failed',error:'Unsupported track'},h=harness({result:failed});h.pollGates.push(oldPoll);const polling=h.poll();await h.run();oldPoll.resolve(studio());await polling;
 assert.equal(h.state.jobs[0].state,'failed');assert.equal(h.state.allJobs[0].state,'failed');assert.deepEqual(h.errors,['Unsupported track']);assert.equal(h.refreshes.length,0);assert.equal(h.shown.length,0);assert.equal(h.toasts.length,0);assert.equal(h.state.submitting,false);
});

test('HTTP local-edit failure reads back its stored failure instead of leaving the queued snapshot',async()=>{
 const h=harness({editError:'HTTP conversion error'});await h.run();assert.equal(h.state.jobs[0].state,'failed');assert.equal(h.state.jobs[0].error,'stored failure');assert.deepEqual(h.errors,['HTTP conversion error']);assert.equal(h.shown.length,0);assert.equal(h.state.submitting,false);
});

test('candidate display failure retains the complete task result without a false success toast',async()=>{
 const h=harness({refreshError:'Candidate geometry failed'});await h.run();assert.equal(h.state.jobs[0].state,'complete');assert.equal(h.state.jobs[0].candidate.sha256,'edited');assert.deepEqual(h.errors,['Candidate geometry failed']);assert.equal(h.shown.length,0);assert.equal(h.toasts.length,0);assert.equal(h.state.submitting,false);
});

test('a poll which starts loading geometry cannot adopt a newer foreground mutation after its await',async()=>{
 const h=harness(),reply=deferred();h.state.jobs=[queued];h.pollGates.push(reply);h.ctx.refreshModels=async()=>{h.view.markLoaded(h.view.beginLoad(),'A');h.view.beginMutation();h.state.submitting=true;return {};};
 const pending=h.poll();reply.resolve({project:{activeAssetId:'A',slots:{baseline:asset(),candidate:asset('A','edited')}},jobs:[complete]});await pending;assert.equal(h.shown.length,0);assert.equal(h.toasts.length,0);assert.equal(h.state.submitting,true);
});

test('retired poll errors do not appear as a current task synchronization failure',async()=>{
 const h=harness(),reply=deferred();h.pollGates.push(reply);vm.runInContext('pollErrors=1',h.ctx);const pending=h.poll();await h.run();reply.reject(Error('Old poll failure'));await pending;assert.deepEqual(h.notices,[]);assert.equal(h.state.jobs[0].state,'complete');
});

for(const phase of ['create','edit'])for(const transition of ['different-model','aba'])test(`late ${phase} response cannot submit or display in a ${transition} view`,async()=>{
 const createGate=phase==='create'?deferred():null,editGate=phase==='edit'?deferred():null,h=harness({createGate,editGate});const pending=h.run();await tick();h.select('B');if(transition==='aba')h.select('A');const id=h.state.project.activeAssetId;
 (createGate||editGate).resolve(structuredClone(phase==='create'?queued:complete));await pending;
 assert.equal(h.state.jobs[0].id,'current-'+id);assert.equal(h.field('request').value,'Current '+id+' draft');assert.equal(h.shown.length,0);assert.equal(h.refreshes.length,0);assert.deepEqual(h.errors,[]);assert.equal(h.toasts.length,0);assert.equal(h.state.submitting,false);
 assert.equal(h.requests.filter(r=>r.path.endsWith('/local-edit')).length,phase==='create'?0:1);
});

test('a same-model foreground load retires an operation before it can submit local editing',async()=>{
 const createGate=deferred(),h=harness({createGate}),pending=h.run();await tick();h.view.markLoaded(h.view.beginLoad(),'A');createGate.resolve(structuredClone(queued));await pending;
 assert.equal(h.requests.some(r=>r.path.endsWith('/local-edit')),false);assert.equal(h.shown.length,0);
});

test('a mismatched operation result never becomes another model task or candidate',async()=>{
 const h=harness({result:{...complete,assetId:'B'}});await h.run();assert.equal(h.state.jobs[0].assetId,'A');assert.equal(h.state.jobs[0].state,'queued');assert.equal(h.shown.length,0);assert.match(h.errors[0],/不属于/);assert.equal(h.state.submitting,false);
});

test('local edit retains the submitted scope while the creation response is delayed',async()=>{
 const createGate=deferred(),h=harness({createGate}),pending=h.run();await tick();h.setRange({wholeClip:false,start:.4,end:.5});createGate.resolve(structuredClone(queued));await pending;
 const edit=h.requests.find(r=>r.path.endsWith('/local-edit'));assert.equal(edit.body.start,.2);assert.equal(edit.body.end,.8);assert.deepEqual(h.errors,[]);
});

test('an old operation cannot clear submission state owned by a newer mutation',async()=>{
 const editGate=deferred(),h=harness({editGate}),pending=h.run();await tick();const next=h.view.beginMutation();h.state.submissionOwner=next;h.state.submitting=true;editGate.resolve(structuredClone(complete));await pending;assert.equal(h.state.submissionOwner,next);assert.equal(h.state.submitting,true);assert.equal(h.shown.length,0);
});

test('a delayed ordinary submit cannot clear a newly selected model draft or connect its Agent',async()=>{
 const createGate=deferred(),h=harness({createGate}),pending=h.submit();await tick();h.select('B');createGate.resolve(structuredClone(queued));await pending;assert.equal(h.field('request').value,'Current B draft');assert.equal(h.state.jobs[0].id,'current-B');assert.equal(h.toasts.length,0);assert.deepEqual(h.errors,[]);assert.equal(h.state.submitting,false);
});

for(const failure of ['geometry','detail'])test('compact poll retries the complete response after '+failure+' application fails',async()=>{
 const h=harness();h.state.jobs=[queued];let attempts=0;
 h.ctx.ensureJobDetail=async()=>{attempts++;if(failure==='detail'&&attempts===1)throw Error('Detail unavailable');return complete;};
 const goodRefresh=h.ctx.refreshModels;let geometry=0;h.ctx.refreshModels=async()=>{if(failure==='geometry'&&geometry++===0)throw Error('Geometry unavailable');return goodRefresh();};
 const result={version:3,revision:'revision-1',jobsRevision:'jobs-1',jobCounts:{A:{total:1}},totalJobs:1,project:{activeAssetId:'A',slots:{baseline:asset(),candidate:asset('A','edited')}},jobs:[{...complete,summaryOnly:true,detailRevision:'detail-1'}]};
 let response=deferred();h.pollGates.push(response);const first=h.poll();response.resolve(result);await first;
 assert.equal(h.shown.length,0);assert.equal(h.state.studioRevision,null);assert.equal(h.state.pendingCandidate.id,complete.id);
 response=deferred();h.pollGates.push(response);const second=h.poll();response.resolve(result);await second;
 assert.equal(h.shown.length,1);assert.equal(h.state.studioRevision,'revision-1');assert.equal(h.state.pendingCandidate,null);
 assert.equal(h.requests.filter(r=>r.path==='/api/studio')[1].request.since,null);
});
test('a foreground mutation during complete-detail loading prevents automatic candidate display',async()=>{
 const h=harness(),detail=deferred();h.state.jobs=[queued];h.ctx.ensureJobDetail=()=>detail.promise;
 const response=deferred();h.pollGates.push(response);const pending=h.poll();response.resolve({version:3,revision:'r1',project:{activeAssetId:'A',slots:{baseline:asset(),candidate:asset('A','edited')}},jobs:[{...complete,summaryOnly:true,detailRevision:'d1'}]});await tick();h.view.beginMutation();detail.resolve(complete);await pending;
 assert.equal(h.shown.length,0);assert.notEqual(h.state.studioRevision,'r1');
});

test('a same-model active-task rejection retains the submitted draft and observation',async()=>{
 const h=harness({createError:'MODEL_JOB_ACTIVE'});await h.submit();assert.equal(h.field('request').value,'Current A draft');assert.equal(h.field('preserve').value,'Keep all other tracks');assert.equal(h.state.target.bone,'LeftShoulder');assert.equal(h.state.submitting,false);assert.deepEqual(h.errors,['MODEL_JOB_ACTIVE']);assert.equal(h.state.jobs.length,0);
});
