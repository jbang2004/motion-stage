import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createViewState,draftStorageKey,saveViewDraft,readViewDraft} from '../../assets/viewer/view-state.mjs';

const app=await readFile(new URL('../../assets/viewer/app.js',import.meta.url),'utf8');
function productionFunction(from,to){const start=app.indexOf(from),end=app.indexOf(to,start);assert.ok(start>=0&&end>start,'production function boundaries must exist');return app.slice(start,end);}
const pollSource=productionFunction('async function pollStudio(){','\nasync function createJob(request');
const pairSource=productionFunction('async function loadPair(','\nfunction selectClip(');
const persistSource=productionFunction('function persistView(){',"window.addEventListener('beforeunload',persistView)");
const refreshSource=productionFunction('async function refreshModels(','\nasync function restoreContext(');
const restoreDraftSource=productionFunction('async function restoreModelDraft(){','\nasync function openCatalogModel(');
const openSource=productionFunction('async function openCatalogModel(','\nfunction drawCatalog(');
const importSource=productionFunction('async function importFile(slot,file){','\nfor(const [slot,id,zone]');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function memoryStorage(){const rows=new Map();return {rows,setItem:(key,value)=>rows.set(key,value),getItem:key=>rows.get(key)||null};}
function loadedView(id='A'){
 const view=createViewState(id),ticket=view.beginLoad();assert.equal(view.markLoaded(ticket,id),true);
 return {view,state:{ready:true,loading:false,switching:false,paths:{workspace:'/review'},project:{activeAssetId:id},models:{baseline:{meta:{assetId:id,sha256:'shared-bytes'}},candidate:{meta:{assetId:id,sha256:'shared-bytes'}}}}};
}
const draft=(id,request)=>({context:{assetId:id,asset:{sha256:'shared-bytes'}},request,preserve:'Keep the legs',panelMode:'compose'});

test('bootstrap binds the identity returned by the first successful load, never the unready selection',()=>{
 const view=createViewState(),ticket=view.beginLoad();assert.equal(view.loadedAssetId,null);assert.equal(view.markLoaded(ticket,'A'),true);
 assert.equal(view.isUnchanged(ticket),true);assert.equal(view.loadedAssetId,'A');assert.equal(view.isCurrent(ticket,'B'),false);
});

test('autosave, visibility changes and unload cannot overwrite a draft during a slow model switch',()=>{
 const {view,state}=loadedView('A'),storage=memoryStorage();
 assert.equal(saveViewDraft(storage,view,state,()=>draft('A','Original A draft')),true);
 storage.setItem(draftStorageKey('/review','B'),JSON.stringify(draft('B','Important B draft')));
 view.select('B');state.switching=true;state.loading=true;state.project={activeAssetId:'B'};
 const ctx=vm.createContext({state,viewState:view,localStorage:storage,saveViewDraft,context:()=>({assetId:view.loadedAssetId,asset:{sha256:'A-version'}}),$:()=>({value:''})});
 vm.runInContext(persistSource,ctx);
 for(let i=0;i<3;i++)assert.equal(vm.runInContext('persistView()',ctx),false);
 assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'B'}).request,'Important B draft');
 const ticket=view.beginLoad();state.models={baseline:{meta:{assetId:'B'}}};assert.equal(view.markLoaded(ticket,'B'),true);state.loading=false;
 assert.equal(saveViewDraft(storage,view,state,()=>draft('B','Still switching')),false);
 assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'B'}).request,'Important B draft');
 state.switching=false;assert.equal(saveViewDraft(storage,view,state,()=>draft('B','B after restoration')),true);
 assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'A'}).request,'Original A draft');
 assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'B'}).request,'B after restoration');
});

test('equal content hashes do not authorize draft writes for another model or mixed model pair',()=>{
 const {view,state}=loadedView('A'),storage=memoryStorage();
 assert.equal(saveViewDraft(storage,view,state,()=>draft('B','Wrong identity')),false);
 state.project.activeAssetId='B';assert.equal(saveViewDraft(storage,view,state,()=>draft('A','Wrong project')),false);
 state.project.activeAssetId='A';state.models.candidate.meta.assetId='B';
 assert.equal(saveViewDraft(storage,view,state,()=>draft('A','Mixed pair')),false);assert.equal(storage.rows.size,0);
});

test('failed switching and returning to the same model reject old responses by generation',()=>{
 const {view,state}=loadedView('A'),old=view.capture();view.select('B');const b=view.beginLoad();
 view.select('A');const a=view.beginLoad();assert.equal(view.markLoaded(a,'A'),true);
 assert.equal(view.markLoaded(b,'B'),false);assert.equal(view.isCurrent(old,'A'),false);
 assert.equal(view.persistableAssetId(state),'A');assert.equal(old.signal.aborted,true);
});

test('the newest load owns commit even when two loads request the same model',()=>{
 const {view}=loadedView('A'),first=view.beginLoad(),second=view.beginLoad();
 assert.equal(view.isUnchanged(first,'A'),false);assert.equal(view.markLoaded(first,'A'),false);
 assert.equal(view.markLoaded(second,'A'),true);
});

test('draft reads preserve legacy storage while rejecting cross-model and malformed records',()=>{
 const storage=memoryStorage();storage.setItem('motion-atelier:C:\\Review',JSON.stringify({request:'Old draft',context:{asset:{sha256:'old'}}}));
 assert.equal(readViewDraft(storage,{workspace:'C:\\Review',assetId:'legacy'}).request,'Old draft');
 assert.equal(readViewDraft(storage,{workspace:'C:\\Review',assetId:'A'}),null);
 storage.setItem(draftStorageKey('/review','A'),JSON.stringify(draft('B','Foreign draft')));assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'A'}),null);
 storage.setItem(draftStorageKey('/review','A'),'{');assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'A'}),null);
 const {view,state}=loadedView();assert.equal(saveViewDraft({setItem(){throw Error('quota');}},view,state,()=>draft('A','Kept in memory')),false);
});

test('session drafts survive unavailable storage, take priority over older disk data, and retain independent snapshots',()=>{
 const {view,state}=loadedView(),storage=memoryStorage(),latest=draft('A','Latest unsaved A request');latest.context.cameras={baseline:{position:[1,2,3]}};
 storage.setItem(draftStorageKey('/review','A'),JSON.stringify(draft('A','Older persisted A request')));
 storage.setItem=()=>{throw Error('quota');};
 assert.equal(saveViewDraft(storage,view,state,()=>latest),false);
 latest.context.cameras.baseline.position[0]=99;
 const saved=readViewDraft(()=>{throw Error('SecurityError');},{workspace:'/review',assetId:'A',view});
 assert.equal(saved.request,'Latest unsaved A request');assert.equal(saved.context.cameras.baseline.position[0],1);
 saved.context.cameras.baseline.position[0]=44;
 assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'A',view}).context.cameras.baseline.position[0],1);
 assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'A'}).request,'Older persisted A request');
 assert.equal(readViewDraft(storage,{workspace:'/another-workspace',assetId:'A',view}),null);
 assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'B',view}),null);
 assert.equal(saveViewDraft(()=>{throw Error('SecurityError');},view,state,()=>draft('A','Newest A request')),false);
 assert.equal(readViewDraft(storage,{workspace:'/review',assetId:'A',view}).request,'Newest A request');
});

test('temporary screenshot camera positions are never saved as the user draft view',()=>{
 const {view,state}=loadedView(),storage=memoryStorage();state.capturing=true;
 assert.equal(saveViewDraft(storage,view,state,()=>draft('A','temporary top view')),false);assert.equal(storage.rows.size,0);
});

function pollHarness(view,state,response){
 let redraws=0;const ctx=vm.createContext({viewState:view,state,api:async()=>response.promise,drawAgent:()=>redraws++,drawJobs:()=>redraws++,updateDisplay:()=>redraws++,notice:()=>redraws++});
 vm.runInContext('let polling=false,pollErrors=0;\n'+pollSource,ctx);
 return {run:()=>vm.runInContext('pollStudio()',ctx),redraws:()=>redraws};
}
function pollingState(id){return {project:{activeAssetId:id},jobs:[{id:'existing-'+id,assetId:id,state:'running'}],allJobs:[],initialized:true,ready:false,loading:false,switching:false,models:{},archivedJobId:null};}

test('production polling discards late A response after B is fully selected, even if fetch could not abort',async()=>{
 const {view}=loadedView('A'),state=pollingState('A'),response=deferred(),harness=pollHarness(view,state,response),pending=harness.run();
 view.select('B');view.markLoaded(view.beginLoad(),'B');state.project={activeAssetId:'B'};state.jobs=[{id:'existing-B',assetId:'B',state:'running'}];
 response.resolve({project:{activeAssetId:'A',slots:{}},jobs:[{id:'late-A',assetId:'A',state:'complete'}]});await pending;
 assert.equal(state.jobs[0].id,'existing-B');assert.equal(harness.redraws(),0);
});

test('production polling rejects A-to-B-to-A ABA responses and same-model foreground load races',async()=>{
 for(const transition of ['aba','foreground-load']){
  const {view}=loadedView('A'),state=pollingState('A'),response=deferred(),harness=pollHarness(view,state,response),pending=harness.run();
  if(transition==='aba'){view.select('B');view.select('A');view.markLoaded(view.beginLoad(),'A');}else view.markLoaded(view.beginLoad(),'A');
  response.resolve({project:{activeAssetId:'A',slots:{}},jobs:[{id:'stale-A',assetId:'A'}]});await pending;
  assert.equal(state.jobs[0].id,'existing-A');assert.equal(harness.redraws(),0);
 }
});

test('production polling applies a current response and retains other-model jobs only in the global catalog list',async()=>{
 const {view}=loadedView('B'),state=pollingState('B'),response=deferred(),harness=pollHarness(view,state,response),pending=harness.run();
 response.resolve({project:{activeAssetId:'B',slots:{}},jobs:[{id:'A-task',assetId:'A'},{id:'B-task',assetId:'B'}]});await pending;
 assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].id,'B-task');assert.equal(state.allJobs.length,2);assert.ok(harness.redraws()>0);
});

test('production pair loading disposes stale completed geometry without committing it into a newer view',async()=>{
 const {view}=loadedView('A'),ticket=view.beginLoad(),one=deferred(),two=deferred(),released=[],committed=[];
 const state={models:{baseline:{meta:{sha256:'old',assetId:'A'}},candidate:{meta:{sha256:'old',assetId:'A'}}}};
 const ctx=vm.createContext({state,slots:['baseline','candidate'],loadSlot:slot=>slot==='baseline'?one.promise:two.promise,dispose:model=>released.push(model.id),commitModel:(slot,model)=>committed.push([slot,model.id])});
 vm.runInContext(pairSource,ctx);ctx.wanted={baseline:{sha256:'new',assetId:'A'},candidate:{sha256:'new',assetId:'A'}};ctx.current=()=>view.isUnchanged(ticket,'A');
 const pending=vm.runInContext('loadPair(wanted,false,current)',ctx);view.select('B');one.resolve({id:'A-baseline'});two.resolve({id:'A-candidate'});
 assert.equal(await pending,false);assert.deepEqual(released.sort(),['A-baseline','A-candidate']);assert.equal(committed.length,0);assert.equal(state.models.baseline.meta.sha256,'old');
});

test('production pair loading releases successful siblings when one load fails, retaining the previous pair',async()=>{
 const released=[],state={models:{baseline:{meta:{sha256:'old'}},candidate:{meta:{sha256:'old'}}}};
 const ctx=vm.createContext({state,slots:['baseline','candidate'],loadSlot:slot=>slot==='baseline'?Promise.resolve({id:'prepared'}):Promise.reject(Error('damaged geometry')),dispose:model=>released.push(model.id),commitModel:()=>assert.fail('must not commit partial pair')});
 vm.runInContext(pairSource,ctx);ctx.wanted={baseline:{sha256:'new'},candidate:{sha256:'new'}};
 await assert.rejects(vm.runInContext('loadPair(wanted)',ctx),/damaged geometry/);assert.deepEqual(released,['prepared']);assert.equal(state.models.candidate.meta.sha256,'old');
});

function selectionHarness({storageFailure,existingA=false}={}){
 const {view,state}=loadedView('A'),storage=memoryStorage(),prepared=deferred(),geometry=deferred(),fields=new Map();
 const field=id=>{if(!fields.has(id))fields.set(id,{value:'',hidden:false,textContent:'',setAttribute(){},removeAttribute(){},close(){}});return fields.get(id);};
 const asset=id=>({assetId:id,sha256:'shared-bytes',file:'assets/shared.glb'}),project=id=>({activeAssetId:id,slots:{baseline:asset(id),candidate:asset(id)}});
 state.project=project('A');state.catalog={entries:[{id:'B',name:'B.glb',format:'glb'}]};field('request').value='Original A draft';field('preserve').value='A preserve';
 storage.setItem(draftStorageKey('/review','B'),JSON.stringify(draft('B','Important B draft')));
 if(existingA)storage.setItem(draftStorageKey('/review','A'),JSON.stringify({...draft('A','Older persisted A request'),preserve:'Older A preserve'}));
 if(storageFailure==='quota')storage.setItem=()=>{throw Error('QuotaExceededError');};
 const requestLog=[];
 const ctx=vm.createContext({state,viewState:view,localStorage:storage,saveViewDraft,readViewDraft,
  $:field,clearTimeout,history:{replaceState(){}},location:{href:'http://local/?asset=A'},
  api:async(path,method,body,request)=>{
   requestLog.push({path,method,body,request});
   if(path==='/api/session')return {token:'test-token',paths:{workspace:'/review'},project:project(request.assetId||state.project.activeAssetId)};
   return prepared.promise;
  },
  loadPair:async(wanted,force,current)=>{if(wanted.baseline.assetId==='B')await geometry.promise;if(!current())return false;state.models={baseline:{meta:wanted.baseline},candidate:{meta:wanted.candidate}};return true;},
  context:()=>({assetId:view.loadedAssetId,asset:{sha256:state.models.baseline.meta.sha256}}),duration:()=>0,
  drawLibrary(){},updateBoneChoices(){},drawMetadata(){},updateDisplay(){},render(){},view(){},drawLatestJob(){},clearTarget(){},drawJobs(){},drawCatalog(){},catalogMessage(){},toast(){},notice(){},restoreContext:async()=>{},pollStudio:async()=>{},refreshCatalog:async()=>{}
 });
 if(storageFailure==='denied')Object.defineProperty(ctx,'localStorage',{get(){throw Error('SecurityError');}});
 vm.runInContext("let cameraBusy=false,projectPreviewTimer,projectPreviewSeq=0,projectPreviewKey='',jobsRenderSignature='';\n"+persistSource+'\n'+refreshSource+'\n'+restoreDraftSource+'\n'+openSource+'\n'+importSource,ctx);
 return {view,state,storage,prepared,geometry,field,requestLog,ctx};
}

test('production model selection restores B draft after delayed geometry, with all intermediate autosaves suppressed',async()=>{
 const h=selectionHarness(),pending=vm.runInContext("openCatalogModel('B')",h.ctx);
 assert.equal(h.state.switching,true);h.prepared.resolve({project:{activeAssetId:'B'}});await new Promise(setImmediate);
 assert.equal(h.state.loading,true);assert.equal(h.state.project.activeAssetId,'B');assert.equal(h.view.loadedAssetId,null);
 assert.equal(vm.runInContext('persistView()',h.ctx),false);assert.equal(readViewDraft(h.storage,{workspace:'/review',assetId:'B'}).request,'Important B draft');
 h.geometry.resolve();await pending;
 assert.equal(h.view.loadedAssetId,'B');assert.equal(h.field('request').value,'Important B draft');assert.equal(h.state.switching,false);assert.equal(h.state.loading,false);
 assert.equal(vm.runInContext('persistView()',h.ctx),true);assert.equal(readViewDraft(h.storage,{workspace:'/review',assetId:'A'}).request,'Original A draft');
});

test('production import invalidates old selection immediately and binds the returned new model identity',async()=>{
 const h=selectionHarness();h.ctx.file={name:'new.glb'};const pending=vm.runInContext("importFile('baseline',file)",h.ctx);
 assert.equal(h.view.loadedAssetId,null);assert.equal(h.state.switching,true);assert.equal(vm.runInContext('persistView()',h.ctx),false);
 h.prepared.resolve({assetId:'B'});await new Promise(setImmediate);assert.equal(h.state.loading,true);assert.equal(vm.runInContext('persistView()',h.ctx),false);
 h.geometry.resolve();await pending;
 assert.equal(h.view.loadedAssetId,'B');assert.equal(h.state.project.activeAssetId,'B');assert.equal(h.field('request').value,'');assert.equal(h.state.switching,false);
 assert.equal(readViewDraft(h.storage,{workspace:'/review',assetId:'A'}).request,'Original A draft');
 assert.equal(h.requestLog.find(r=>r.path==='/api/session').request.assetId,null,'unbound new identity is resolved through the returned project, not the previous view token');
});

test('production failed import returns to A and restores its own draft without altering B',async()=>{
 const h=selectionHarness();h.ctx.file={name:'broken.fbx'};const pending=vm.runInContext("importFile('baseline',file)",h.ctx);h.prepared.reject(Error('conversion failed'));
 await assert.rejects(pending,/conversion failed/);assert.equal(h.view.loadedAssetId,'A');assert.equal(h.state.project.activeAssetId,'A');assert.equal(h.field('request').value,'Original A draft');assert.equal(h.state.switching,false);
 assert.equal(readViewDraft(h.storage,{workspace:'/review',assetId:'B'}).request,'Important B draft');
});

for(const storageFailure of ['quota','denied'])for(const existingA of [false,true]){
 test(`production failed model load restores the latest session draft with ${storageFailure} storage and ${existingA?'older':'no'} disk draft`,async()=>{
  const h=selectionHarness({storageFailure,existingA});h.field('request').value='Latest unsaved A request';h.field('preserve').value='Latest unsaved A preserve';
  h.state.panelMode='compose';h.state.composerSource='candidate';h.state.lineageParentJobId='A-parent';h.state.comparisonPair={baseline:'A-base',candidate:'A-candidate'};
  const pending=vm.runInContext("openCatalogModel('B')",h.ctx),rejected=assert.rejects(pending,/Broken B geometry/);
  h.prepared.resolve({project:{activeAssetId:'B'}});await new Promise(setImmediate);h.geometry.reject(Error('Broken B geometry'));await rejected;
  assert.equal(h.view.loadedAssetId,'A');assert.equal(h.state.project.activeAssetId,'A');assert.equal(h.state.switching,false);
  assert.equal(h.field('request').value,'Latest unsaved A request');assert.equal(h.field('preserve').value,'Latest unsaved A preserve');
  assert.equal(h.state.composerSource,'candidate');assert.equal(h.state.lineageParentJobId,'A-parent');assert.equal(h.state.comparisonPair.candidate,'A-candidate');
  assert.equal(readViewDraft(h.storage,{workspace:'/review',assetId:'B'}).request,'Important B draft');
 });

 test(`production import rollback restores the latest session draft after fields reset with ${storageFailure} storage and ${existingA?'older':'no'} disk draft`,async()=>{
  const h=selectionHarness({storageFailure,existingA});h.field('request').value='Latest unsaved A request';h.field('preserve').value='Latest unsaved A preserve';
  h.ctx.file={name:'new.glb'};h.ctx.refreshCatalog=async()=>{assert.equal(h.field('request').value,'');throw Error('follow-up catalog unavailable');};
  const pending=vm.runInContext("importFile('baseline',file)",h.ctx),rejected=assert.rejects(pending,/follow-up catalog unavailable/);
  h.prepared.resolve({assetId:'B'});await new Promise(setImmediate);h.geometry.resolve();await rejected;
  assert.equal(h.view.loadedAssetId,'A');assert.equal(h.state.project.activeAssetId,'A');assert.equal(h.state.switching,false);
  assert.equal(h.field('request').value,'Latest unsaved A request');assert.equal(h.field('preserve').value,'Latest unsaved A preserve');
  assert.equal(readViewDraft(h.storage,{workspace:'/review',assetId:'B'}).request,'Important B draft');
 });
}

test('a superseded selection cannot clear the busy state owned by a newer selection',async()=>{
 const h=selectionHarness(),pending=vm.runInContext("openCatalogModel('B')",h.ctx);
 h.view.select('C');h.state.project={activeAssetId:'C'};h.state.switching=true;h.prepared.resolve({project:{activeAssetId:'B'}});await pending;
 assert.equal(h.state.project.activeAssetId,'C');assert.equal(h.state.switching,true);assert.equal(h.view.loadedAssetId,null);
});
