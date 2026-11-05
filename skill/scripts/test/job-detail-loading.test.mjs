import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createViewState} from '../../assets/viewer/view-state.mjs';
const app=await readFile(new URL('../../assets/viewer/app.js',import.meta.url),'utf8');
const helpers=app.slice(app.indexOf('const jobDetails=new Map()'),app.indexOf('let historyLoading='));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(){const view=createViewState('A');view.markLoaded(view.beginLoad(),'A');const summary={id:'job',assetId:'A',createdAt:'2026',state:'running',summaryOnly:true,detailRevision:'r1'},state={jobs:[summary]},calls=[],pending=[];const ctx=vm.createContext({state,viewState:view,api:(path)=>{calls.push(path);const next=gate();pending.push(next);return next.promise;}});vm.runInContext(helpers,ctx);return {view,state,ctx,summary,calls,pending,load:s=>{ctx.summary=s;return vm.runInContext('ensureJobDetail(summary)',ctx);},merge:s=>{ctx.summary=s;return vm.runInContext('mergeJobSummary(summary)',ctx);}};}
test('selected detail caches only its current revision and external updates invalidate it',async()=>{
 const h=setup(),p=h.load(h.summary);h.pending[0].resolve({id:'job',assetId:'A',createdAt:'2026',state:'running',request:'full original'});const detail=await p;assert.equal(detail.request,'full original');assert.equal(h.merge(h.summary).summaryOnly,undefined);
 const changed={...h.summary,state:'complete',detailRevision:'r2'};assert.equal(h.merge(changed).summaryOnly,true);h.state.jobs=[changed];const next=h.load(changed);h.pending[1].resolve({id:'job',assetId:'A',createdAt:'2026',state:'complete',request:'updated full'});assert.equal((await next).request,'updated full');assert.equal(h.merge(changed).request,'updated full');
});
for(const retirement of ['different-model','aba','mutation','new-summary','new-full'])test('late task detail cannot replace the current view after '+retirement,async()=>{
 const h=setup(),pending=h.load(h.summary);
 if(retirement==='different-model'||retirement==='aba'){h.view.select('B');h.view.markLoaded(h.view.beginLoad(),'B');if(retirement==='aba'){h.view.select('A');h.view.markLoaded(h.view.beginLoad(),'A');}}
 if(retirement==='mutation')h.view.beginMutation();
 if(retirement==='new-summary'||retirement==='new-full')h.state.jobs=[{...h.summary,summaryOnly:retirement!=='new-full',detailRevision:'r2'}];
 h.pending[0].resolve({id:'job',assetId:'A',createdAt:'2026',state:'complete',request:'late'});assert.equal(await pending,null);assert.equal(h.state.jobs[0].summaryOnly,retirement!=='new-full');
});
test('same-revision detail requests share one transport flight',async()=>{
 const h=setup(),first=h.load(h.summary),second=h.load(h.summary);assert.equal(h.calls.length,1);h.pending[0].resolve({id:'job',assetId:'A',createdAt:'2026',state:'running'});assert.equal((await first).id,'job');assert.equal((await second).id,'job');
});
const history=app.slice(app.indexOf('let historyLoading='),app.indexOf('function drawJobs(){'));
test('background history refresh preserves the entire loaded page window',async()=>{
 const view=createViewState('A');view.markLoaded(view.beginLoad(),'A');const rows=Array.from({length:90},(_,i)=>({id:'job-'+i,assetId:'A'})),state={historyAssetId:'A',historyJobs:rows},calls=[];
 const ctx=vm.createContext({state,viewState:view,$:()=>({disabled:false}),drawJobs(){},api:async path=>{calls.push(path);const url=new URL(path,'http://local'),offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));return {jobs:rows.slice(offset,offset+limit).map(j=>({...j,state:'running'})),total:120,hasMore:true,revision:'new'};}});vm.runInContext(history,ctx);await vm.runInContext('loadJobHistory()',ctx);
 assert.equal(state.historyJobs.length,90);assert.equal(state.historyJobs[89].id,'job-89');assert.ok(calls[0].includes('limit=90'));assert.equal(state.historyRevision,'new');
});

const decisions=app.slice(app.indexOf('const pendingDecisions=new Map()'),app.indexOf('function drawAgent(){'));
test('optional review feedback stays optional and a transport retry reuses the decision identity',async()=>{
 const view=createViewState('A');view.markLoaded(view.beginLoad(),'A');const job={id:'job',assetId:'A',candidate:{sha256:'new'},inputs:{baseline:{sha256:'original'}}},state={project:{activeAssetId:'A',slots:{baseline:{sha256:'original'},candidate:{sha256:'new'}}}},requests=[];let uuid=0;
 const ctx=vm.createContext({job,state,viewState:view,crypto:{randomUUID:()=> 'decision-'+(++uuid)},$:()=>null,viewMatchesJob:()=>true,commitJobResult(){},pollStudio:async()=>{},toast(){},api:async(path,method,body)=>{requests.push(body);if(requests.length===1)throw Error('network disconnected after commit');return {...job,artisticDecision:body.decision};}});vm.runInContext(decisions,ctx);
 await assert.rejects(vm.runInContext("recordDecision(job,'accept-candidate')",ctx),/network/);await vm.runInContext("recordDecision(job,'accept-candidate')",ctx);assert.equal(requests[0].decisionId,requests[1].decisionId);assert.equal(requests[0].outcome.includes('评审意见'),false);assert.equal(uuid,1);
});
