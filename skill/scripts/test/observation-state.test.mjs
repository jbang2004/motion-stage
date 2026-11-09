import {currentComparison} from '../../assets/viewer/studio-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {observationTime,planObservationRestore,restoredTransportTime,observationFrame,observationFrameOptions} from '../../assets/viewer/observation-state.mjs';
import {createDemandLoop} from '../../assets/viewer/render-loop.mjs';
import {createViewState} from '../../assets/viewer/view-state.mjs';
const model=(duration,sha256='input')=>({duration,meta:{sha256},clips:[{name:'Run',duration}]});
const models={baseline:model(4),candidate:model(2,'output')};

test('progress snapshots restore the active clip local second into the longer transport clock',()=>{
 const ctx={slot:'candidate',display:'split',mode:'progress',time:1,slots:{candidate:{sha256:'output',clip:'Run',time:1}}};
 const plan=planObservationRestore(ctx,models),time=restoredTransportTime(plan,models);
 assert.equal(time,2);assert.equal(observationTime(models,'candidate',time,{display:'split',mode:'progress'}),1);
 assert.equal(observationTime(models,'baseline',time,{display:'split',mode:'progress'}),2);
});

test('a continued task maps its actual candidate input time, clip and camera to the new baseline',()=>{
 const oldBase={position:[9,1,1],target:[0,1,0],fov:34},inputCamera={position:[3,2,1],target:[0,1,0],fov:52};
 const ctx={slot:'candidate',display:'split',mode:'progress',time:1,clip:'Run',rootLocked:false,linkedCameras:false,speed:.25,loop:false,scaleMode:'raw',cameras:{baseline:oldBase,candidate:inputCamera},slots:{baseline:{sha256:'old',time:2,clip:'Old'},candidate:{sha256:'input',clip:'Run',time:1}}};
 const pair={baseline:model(2),candidate:model(6,'output')},plan=planObservationRestore(ctx,pair,{inputSlot:'candidate'}),time=restoredTransportTime(plan,pair);
 assert.equal(time,3);assert.equal(observationTime(pair,'baseline',time,{display:'split',mode:'progress'}),1);assert.equal(observationTime(pair,'candidate',time,{display:'split',mode:'progress'}),3);
 assert.deepEqual(plan.clips,{baseline:'Run',candidate:'Run'});assert.deepEqual(plan.cameras,{baseline:inputCamera,candidate:inputCamera});
 assert.equal(plan.settings.rootLocked,false);assert.equal(plan.settings.linkedCameras,false);assert.equal(plan.settings.speed,.25);assert.equal(plan.settings.loop,false);assert.equal(plan.settings.scaleMode,'raw');
});

test('elapsed comparison preserves the input second when output duration changes and safely handles static input',()=>{
 const pair={baseline:model(2),candidate:model(6,'output')},plan=planObservationRestore({time:1.5,mode:'elapsed'},pair,{inputSlot:'candidate'});
 assert.equal(restoredTransportTime(plan,pair),1.5);
 assert.equal(restoredTransportTime({...plan,settings:{mode:'progress'}},{baseline:model(0),candidate:model(3)}),0);
 assert.deepEqual(planObservationRestore({speed:NaN,cameras:{baseline:{position:[NaN,0,1],target:[0,0,0]}}},models).cameras,{});
});

test('shared frame preserves a doubled candidate size and displaced origin; raw frame preserves authored units',()=>{
 const input={min:{x:1,y:2,z:-1},max:{x:3,y:6,z:1}},candidate={min:{x:2,y:4,z:-2},max:{x:6,y:12,z:2}},frame=observationFrame(input);
 const transform=(point,axis)=>point*frame.factor+frame.offset[axis];
 const inputHeight=transform(input.max.y,1)-transform(input.min.y,1),candidateHeight=transform(candidate.max.y,1)-transform(candidate.min.y,1);
 assert.equal(candidateHeight/inputHeight,2);assert.equal(transform(candidate.min.y,1),1);assert.deepEqual(frame.offset,[-1,-1,-0]);
 const raw=observationFrame(input,'raw');assert.equal(raw.factor,1);assert.deepEqual(raw.offset,[0,0,0]);assert.deepEqual(raw.target,[2,4,0]);assert.equal(raw.distanceScale,2);
});

function loopFixture(){let id=0,continuous=false;const frames=new Map(),seen=[];const loop=createDemandLoop({requestFrame:fn=>{frames.set(++id,fn);return id;},cancelFrame:id=>frames.delete(id),shouldContinue:()=>continuous,onFrame:(now,dt)=>seen.push({now,dt})});return {loop,frames,seen,setContinuous(value){continuous=value;},frame(now){const [id,fn]=frames.entries().next().value;frames.delete(id);fn(now);}};}
test('paused neutral views schedule no idle RAF, coalesce events and resume without counting idle time',()=>{
 const h=loopFixture();assert.equal(h.frames.size,0);h.loop.wake();h.loop.wake();assert.equal(h.frames.size,1);h.frame(100);assert.equal(h.frames.size,0);
 h.setContinuous(true);h.loop.wake();h.frame(10000);assert.equal(h.seen.at(-1).dt,0);h.frame(10016);assert.equal(h.seen.at(-1).dt,.016);
 h.setContinuous(false);h.frame(10032);assert.equal(h.frames.size,0);h.loop.wake();h.loop.dispose();assert.equal(h.frames.size,0);h.loop.wake();assert.equal(h.frames.size,0);
});
test('appearance-only animation keeps frames alive while paused and caps a delayed browser frame',()=>{
 const h=loopFixture();h.setContinuous(true);h.loop.wake();h.frame(0);h.frame(1000);assert.equal(h.seen.at(-1).dt,.1);assert.equal(h.frames.size,1);h.setContinuous(false);h.frame(1016);assert.equal(h.frames.size,0);
});

const app=await readFile(new URL('../../assets/viewer/app.js',import.meta.url),'utf8');
const extract=(from,to)=>app.slice(app.indexOf(from),app.indexOf(to,app.indexOf(from)));
test('production snapshot application restores settings and camera FOV before deriving progress transport time',async()=>{
 const fields=new Map(),$=id=>{if(!fields.has(id))fields.set(id,{value:'shared'});return fields.get(id);};
 const state={models:structuredClone(models),playing:true},cameras={},controls={};let normalized=0;
 const vector=()=>({value:null,fromArray(a){this.value=[...a];}});
 for(const slot of ['baseline','candidate']){cameras[slot]={position:vector(),updateProjectionMatrix(){}};controls[slot]={target:vector(),update(){}};}
 const ctx=vm.createContext({state,slots:['baseline','candidate'],$,cameras,controls,planObservationRestore,restoredTransportTime,activeModel:()=>state.models.candidate,selectClip(slot,name){state.models[slot].clip=name;},normalizePair(){normalized++;},drawLoop(){},setViewButtons(){},restoreOfflinePreset(){}});
 vm.runInContext('let cameraBusy=false;'+extract('async function applyObservation(','\nasync function restoreContext('),ctx);
 await vm.runInContext('applyObservation',ctx)({slot:'candidate',time:1,mode:'progress',rootLocked:false,linkedCameras:false,speed:.5,loop:false,cameras:{candidate:{position:[2,3,4],target:[0,2,0],fov:55}}},{inputSlot:'candidate'});
 assert.equal(state.playing,false);assert.equal(state.display,'split');assert.equal(state.time,1); // new baseline duration is 4; source local second stays 1
 assert.equal($('progress').checked,true);assert.equal($('lockRoot').checked,false);assert.equal($('linkCameras').checked,false);assert.equal(state.speed,.5);assert.equal(state.loop,false);assert.equal(normalized,1);
 assert.deepEqual(cameras.baseline.position.value,[2,3,4]);assert.equal(cameras.baseline.fov,55);assert.equal(cameras.candidate.fov,55);
});

test('retired asynchronous appearance restoration cannot apply settings to a newly selected model, including ABA',async()=>{
 const view=createViewState('A');view.markLoaded(view.beginLoad(),'A');let release,applications=0;
 const appearance={chooseRecorded:()=>new Promise(resolve=>{release=resolve;})},state={project:{activeAssetId:'A'}};
 const ctx=vm.createContext({state,viewState:view,appearance,applyObservation(){applications++;}});vm.runInContext(extract('async function restoreContext(','\nfunction viewMatchesJob('),ctx);
 const pending=vm.runInContext('restoreContext',ctx)({speed:.25});view.select('B');view.select('A');release(false);await pending;assert.equal(applications,0);
});

test('production pose sampling stays idle for appearance or camera redraws and invalidates after selection and display changes',()=>{
 let samples=0;const no=()=>{},m={action:null,frame:{},capabilities:{hasMesh:true},lines:{visible:false},points:{geometry:{}},nodeAxes:{},joints:[],marker:{visible:false}},state={models:{baseline:m},display:'single',target:null};
 const ctx=vm.createContext({slots:['baseline'],state,$:()=>({checked:false}),timeModel(){samples++;},localTime:()=>1});
 vm.runInContext(extract('function pose(){','\nfunction drawModel('),ctx);const pose=vm.runInContext('pose',ctx);
 pose();pose();assert.equal(samples,1);state.target={slot:'candidate'};pose();assert.equal(samples,2);pose();assert.equal(samples,2);state.display='split';pose();assert.equal(samples,3);m.poseStamp=null;pose();assert.equal(samples,4);
});

test('production candidate display restores the actual input observation only after its load is still current',async()=>{
 const source={sha256:'input'},candidate={sha256:'output'},job={id:'continued',assetId:'A',slot:'candidate',clip:'Run',inputs:{baseline:{sha256:'old'},candidate:source},candidate,context:{time:.75,mode:'progress',speed:.25,rootLocked:false,cameras:{candidate:{position:[3,2,1],target:[0,1,0]}}}};
 const view=createViewState('A');view.markLoaded(view.beginLoad(),'A');const state={project:{activeAssetId:'A',slots:{baseline:job.inputs.baseline,candidate}},models:{baseline:{meta:source},candidate:{meta:candidate}}},applied=[],noop=()=>{};let release;
 const ctx=vm.createContext({state,viewState:view,appearance:{},currentComparison,observationFrameOptions,renderLoop:null,jobSourceAsset:j=>j.inputs[j.slot],loadPair:async(_wanted,_force,current)=>{await new Promise(resolve=>{release=resolve;});return current();},applyObservation:(...args)=>applied.push(args),$:()=>({}),clearTarget:noop,correspondingJoint:()=>null,drawLibrary:noop,updateBoneChoices:noop,drawMetadata:noop,updateDisplay:noop,drawLatestJob:noop,render:noop,notice:noop,resourcePanels:{baseline:{observe:()=>null}}});
 vm.runInContext(extract('async function showCandidate(','\nfunction currentJob('),ctx);const show=vm.runInContext('showCandidate',ctx);
 let pending=show(job);release();assert.equal(await pending,true);assert.equal(applied.length,1);assert.equal(applied[0][0],job.context);assert.equal(applied[0][1].inputSlot,'candidate');
 pending=show(job);view.select('B');release();assert.equal(await pending,false);assert.equal(applied.length,1);
});

test('continuing from a scaled candidate restores its frozen transform for both versions, with a raw override',()=>{
 const box={min:{x:2,y:4,z:-2},max:{x:6,y:12,z:2}},recorded={scale:.5,restOffset:[-1,-1,0]},ctx={slot:'candidate',time:.75,normalization:{baseline:{scale:1,restOffset:[0,0,0]},candidate:recorded}};
 const plan=planObservationRestore(ctx,{baseline:model(2),candidate:model(3)},{inputSlot:'candidate'}),frame=observationFrame(box,'shared',plan.normalization);
 assert.deepEqual(plan.normalization,recorded);assert.equal(frame.factor,.5);assert.deepEqual(frame.offset,[-1,-1,0]);assert.equal(box.min.y*frame.factor+frame.offset[1],1);assert.equal((box.max.y-box.min.y)*frame.factor,4);
 const raw=observationFrame(box,'raw',plan.normalization);assert.equal(raw.factor,1);assert.deepEqual(raw.offset,[0,0,0]);
 for(const invalid of [{scale:0,restOffset:[0,0,0]},{scale:Infinity,restOffset:[0,0,0]},{scale:1,restOffset:[0,NaN,0]},{scale:1,restOffset:[0,0]}])assert.equal(observationFrame(box,'shared',invalid).factor,.25);
});

test('production frame policy includes paused project hooks and suspends the model during game preview',()=>{
 const state={ready:true,playing:false,models:{baseline:{}}},runtimePreviewDialog={open:false},runtimeStage={active:false},ctx=vm.createContext({state,runtimePreviewDialog,runtimeStage,duration:()=>2});
 vm.runInContext('let appearanceRecovery=false;'+extract('function continuousFrames(){','\nlet lastDOM='),ctx);const active=vm.runInContext('continuousFrames',ctx);
 assert.equal(active(),false);state.playing=true;assert.equal(active(),true);state.playing=false;state.models.baseline.appearance={update(){}};assert.equal(active(),true);
 state.loading=true;assert.equal(active(),false);state.loading=false;state.capturing=true;assert.equal(active(),false);state.capturing=false;state.models.baseline.appearance={render(){}};assert.equal(active(),true);
 runtimePreviewDialog.open=true;assert.equal(active(),false);runtimePreviewDialog.open=false;assert.equal(active(),true);
 runtimeStage.active=true;assert.equal(active(),false);runtimeStage.active=false;assert.equal(active(),true);
});

test('project snapshot staging supplies the frozen transform before adapter preparation and rebuilds both handles',async()=>{
 const load=extract('async function loadPair(','\nfunction resolveClip('),box={min:{x:0,y:0,z:0},max:{x:2,y:4,z:2}},wanted={baseline:{sha256:'input'},candidate:{sha256:'output'}},state={models:{baseline:{meta:wanted.baseline},candidate:{meta:wanted.candidate}}},staged=[],frames=[];
 const options={scaleMode:'shared',normalization:{scale:.25,restOffset:[2,-1,0]}};
 const ctx=vm.createContext({slots:['baseline','candidate'],state,cacheKey:()=>'',recentModels:new Map(),setModelClip(){},retireModel(){},pairFrame:(models,options)=>observationFrame(models.baseline.bbox,options?.scaleMode,options?.normalization),observationFrame,$:()=>({value:'raw'}),appearance:{mode:'project',async prepare(models){assert.equal(models.length,2);assert.ok(models.every(m=>m.frame.factor===.25));assert.ok(models.every(m=>m.frame.offset[0]===2));return 'ready';}},loadSlot:async(slot,meta)=>{const m={meta,clips:[],bbox:box,capabilities:{hasMesh:true},appearanceContext:{camera:{}}};staged.push(m);return m;},normalize:(m,frame)=>m.frame=frame,normalizePair:(_models,frameOptions)=>frames.push(frameOptions),renderer:{debug:{},compile(){}},T:{},withRendererState:(_r,_t,run)=>run(),dispose(){},commitModel:(slot,m)=>state.models[slot]=m});
 vm.runInContext(load,ctx);assert.equal(await vm.runInContext('loadPair',ctx)(wanted,false,()=>true,options),true);assert.equal(staged.length,2);assert.equal(frames[0],options);
});

test('an equal file hash in another model cannot borrow the prior model frozen display transform',()=>{
 const box={min:{x:0,y:0,z:0},max:{x:2,y:4,z:2}},state={project:{activeAssetId:'B'},observationTransform:{sha256:'equal',assetId:'A',scale:10,restOffset:[1,2,3]}};
 const ctx=vm.createContext({state,observationFrame,$:()=>({value:'shared'})});vm.runInContext(extract('function recordedFrame(','\nasync function loadSlot('),ctx);
 const frame=vm.runInContext('pairFrame',ctx)({baseline:{meta:{sha256:'equal',assetId:'B'},bbox:box}});assert.equal(frame.factor,.5);assert.equal(frame.offset[1],-0);
});

test('manual scale switching rebuilds project normalization caches and cannot refit a superseding load',async()=>{
 const body=extract("$('scaleMode').onchange=", "$('progress').onchange="),field={},state={view:'side',observationTransform:{scale:10}},viewState=createViewState('A');viewState.markLoaded(viewState.beginLoad(),'A');let release,fit=0,rebuilt=0;
 const ctx=vm.createContext({state,viewState,$:()=>field,appearance:{mode:'project'},refreshModels:async({force})=>{assert.equal(force,true);rebuilt++;const ticket=viewState.beginLoad();await new Promise(resolve=>release=resolve);return {observationTicket:ticket};},normalizePair(){assert.fail('Project adapters must be rebuilt');},view:()=>fit++,fail:assert.fail});
 vm.runInContext(body,ctx);let pending=field.onchange();release();await pending;assert.equal(state.observationTransform,null);assert.equal(rebuilt,1);assert.equal(fit,1);
 pending=field.onchange();viewState.beginLoad();release();await pending;assert.equal(fit,1);
});
