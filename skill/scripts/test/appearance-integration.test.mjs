import {currentComparison} from '../../assets/viewer/studio-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {observationFrame,observationFrameOptions} from '../../assets/viewer/observation-state.mjs';
const source=await readFile(new URL('../../assets/viewer/app.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function loadPair('),source.indexOf('\nfunction resolveClip('));
const draw=source.slice(source.indexOf('function drawModel('),source.indexOf('\nfunction render('));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture({fallback=false,compileError=false,prepareGate=null}={}){
 const original={baseline:{meta:{sha256:'old',assetId:'A'}},candidate:{meta:{sha256:'candidate',assetId:'A'}}},disposed=[],committed=[],created=[];
 const state={models:new Proxy({...original},{set(target,slot,model){committed.push(model);target[slot]=model;return true;}})};let attempts=0,failures=0;
 const appearance={mode:'project',async prepare(){attempts++;if(prepareGate)await prepareGate.promise;if(fallback&&attempts===1){this.mode='neutral';return 'fallback';}return 'ready';},fail(){failures++;this.mode='neutral';}};
 const renderer={debug:{onShaderError:undefined},compile(){if(compileError)throw Error('shader failed');}};
 const ctx=vm.createContext({pairFrame:(models,options)=>observationFrame(models.baseline.bbox,options?.scaleMode||'shared',options?.normalization),observationFrame,normalize(){},normalizePair(){},$:()=>({value:'shared'}),slots:['baseline','candidate'],state,appearance,cacheKey:()=>'',recentModels:new Map(),setModelClip(){},retireModel(){},renderer,T:{},withRendererState:(_r,_t,fn)=>fn(),loadSlot:async(slot,meta)=>{const m={slot,meta,clips:[],bbox:{min:{x:0,y:0,z:0},max:{x:1,y:2,z:1}},capabilities:{hasMesh:true,preview:'model'},appearanceContext:{camera:{}}};created.push(m);return m;},dispose:m=>disposed.push(m),commitModel:(slot,m)=>{committed.push(m);state.models[slot]=m;}});vm.runInContext(body,ctx);
 return {state,original,disposed,committed,created,renderer,ctx,get failures(){return failures;},run:isCurrent=>vm.runInContext('loadPair',ctx)({baseline:{sha256:'new',assetId:'A'},candidate:{sha256:'new-candidate',assetId:'A'}},false,isCurrent)};
}

test('failed appearance application releases both staged models and commits a fresh neutral pair atomically',async()=>{
 const h=fixture({fallback:true});assert.equal(await h.run(()=>true),true);assert.equal(h.created.length,4);assert.deepEqual(h.disposed,h.created.slice(0,2));assert.deepEqual(h.committed,h.created.slice(2));assert.equal(h.state.models.candidate.meta.sha256,'new-candidate');
});

test('shader compile failure restores debug hooks, releases staging and rebuilds both slots in neutral',async()=>{
 const h=fixture({compileError:true});assert.equal(await h.run(()=>true),true);assert.equal(h.failures,1);assert.equal(h.disposed.length,2);assert.equal(h.committed.length,2);assert.equal(h.renderer.debug.onShaderError,undefined);
});

test('a late appearance setup cannot commit into a newer view or discard its original models',async()=>{
 const gate=deferred(),h=fixture({prepareGate:gate});let current=true;const pending=h.run(()=>current);await new Promise(r=>setImmediate(r));current=false;gate.resolve();assert.equal(await pending,false);assert.deepEqual(h.state.models,h.original);assert.equal(h.committed.length,0);assert.equal(h.disposed.length,2);
});

test('the second slot cannot stop the animation loop when the first slot already requested neutral recovery',()=>{
 let recoveries=0;const ctx=vm.createContext({renderer:{},T:{},appearanceRecovery:true,localTime:()=>0,renderAppearance(){throw Error('render failed');},recoverAppearance(){recoveries++;}});vm.runInContext(draw,ctx);assert.doesNotThrow(()=>vm.runInContext('drawModel',ctx)({appearance:{},capabilities:{hasMesh:true,preview:'model'},appearanceContext:{slot:'baseline'}},{},{}));assert.equal(recoveries,1);
});

test('a mode retired inside an otherwise current view rebuilds using the latest mode',async()=>{
 const h=fixture();let attempts=0;h.ctx.appearance.prepare=async()=>{if(++attempts===1){h.ctx.appearance.mode='neutral';return 'retired';}return 'ready';};assert.equal(await h.run(()=>true),true);assert.equal(h.disposed.length,2);assert.equal(h.committed.length,2);
});

test('automatic candidate presentation preserves the user appearance choice; explicit history restores recorded appearance',async()=>{
 const body=source.slice(source.indexOf('async function showCandidate('),source.indexOf('\nfunction currentJob('));let restores=0;const forces=[];
 const baseline={sha256:'base'},candidate={sha256:'new'},job={id:'job',assetId:'A',inputs:{baseline},candidate,context:{appearance:{mode:'neutral'},time:.2}};
 const state={project:{activeAssetId:'A',slots:{baseline,candidate}},models:{baseline:{meta:baseline},candidate:{meta:candidate}}};
 const noop=()=>{};const ctx=vm.createContext({state,currentComparison,observationFrameOptions,renderLoop:null,applyObservation(){},slots:[],resourcePanels:{baseline:{observe:()=>null}},viewState:{beginLoad:()=>({}),isUnchanged:()=>true,markLoaded:()=>true},appearance:{chooseRecorded:async()=>{restores++;return true;}},jobSourceAsset:j=>j.inputs.baseline,correspondingJoint:()=>null,loadPair:async(_wanted,force)=>{forces.push(force);return true;},duration:()=>1,setViewButtons:noop,$:()=>({}),clearTarget:noop,drawLibrary:noop,updateBoneChoices:noop,drawMetadata:noop,updateDisplay:noop,drawLatestJob:noop,render:noop,notice:noop});vm.runInContext('let cameraBusy=false;'+body,ctx);const show=vm.runInContext('showCandidate',ctx);
 await show(job);assert.equal(restores,0);assert.equal(forces[0],false);await show(job,{restoreAppearance:true});assert.equal(restores,1);assert.equal(forces[1],true);
});

test('restoring an obsolete appearance during character navigation can rebuild neutral inside its owned selection',async()=>{
 const body=source.slice(source.indexOf('async function restoreContext('),source.indexOf('\nfunction viewMatchesJob('));const ticket={assetId:'B'},state={switching:true,time:0,project:{activeAssetId:'B'},models:{baseline:{appearance:{}}}};let rebuilt=false;
 const noop=()=>{};const ctx=vm.createContext({state,applyObservation(ctx){state.time=ctx.time;},slots:[],appearance:{chooseRecorded:async()=>true},viewState:{capture:()=>ticket,isUnchanged:()=>true,isCurrentMutation:()=>true},refreshModels:async options=>{if(state.switching&&!options.selectionTicket)return null;assert.equal(options.selectionTicket,ticket);rebuilt=true;state.models.baseline.appearance=null;return {observationTicket:ticket};},duration:()=>1,activeSlot:()=> 'baseline',resourcePanels:{baseline:{restore(){}}},$:()=>({}),setViewButtons:noop,drawLibrary:noop,updateBoneChoices:noop,drawMetadata:noop,updateDisplay:noop,render:noop});vm.runInContext('let cameraBusy=false;'+body,ctx);await vm.runInContext('restoreContext',ctx)({slot:'baseline',time:.4,appearance:{mode:'project',bundle:'obsolete'}});assert.equal(rebuilt,true);assert.equal(state.models.baseline.appearance,null);assert.equal(state.time,.4);
});

test('candidate restoration uses the frozen curve observation instead of a newly loaded default track',async()=>{
 const body=source.slice(source.indexOf('async function showCandidate('),source.indexOf('\nfunction currentJob('));const baseline={sha256:'base'},candidate={sha256:'new'},observation={kind:'curve',clip:'Reach',binding:'strength',component:0,time:.5},job={id:'curve-job',assetId:'A',slot:'baseline',clip:'Reach',inputs:{baseline},candidate,context:{clip:'Reach',time:.5,resourceObservation:observation}};
 const models={baseline:{meta:baseline,clips:[]},candidate:{meta:candidate,clips:[]}},state={project:{activeAssetId:'A',slots:{baseline,candidate}},models},restored=[],noop=()=>{},ctx=vm.createContext({state,currentComparison,observationFrameOptions,renderLoop:null,applyObservation(){},slots:['baseline','candidate'],resourcePanels:{baseline:{observe:()=>({kind:'curve',clip:'Reach',binding:'default-quaternion'}),restore:value=>restored.push(['baseline',value])},candidate:{restore:value=>restored.push(['candidate',value])}},viewState:{beginLoad:()=>({}),isUnchanged:()=>true,markLoaded:()=>true},appearance:{},jobSourceAsset:j=>j.inputs.baseline,correspondingJoint:()=>null,loadPair:async()=>true,duration:()=>1,setViewButtons:noop,$:()=>({}),clearTarget:noop,drawLibrary:noop,updateBoneChoices:noop,drawMetadata:noop,updateDisplay:noop,drawLatestJob:noop,render:noop,notice:noop});vm.runInContext('let cameraBusy=false;'+body,ctx);assert.equal(await vm.runInContext('showCandidate',ctx)(job),true);assert.equal(restored.length,2);assert.ok(restored.every(([,value])=>value===observation));
});

test('draft restoration recovers an indexed selection only for the exact recorded asset',async()=>{const body=source.slice(source.indexOf('async function restoreContext('),source.indexOf('\nfunction viewMatchesJob(')),selected=[],state={project:{activeAssetId:'A'},models:{baseline:{meta:{sha256:'frozen'}}}},noop=()=>{};let cleared=0;const ctx=vm.createContext({state,applyObservation(){},slots:[],structuredClone,appearance:{chooseRecorded:async()=>false},viewState:{capture:()=>({}),isUnchanged:()=>true},activeSlot:()=> 'baseline',resourcePanels:{baseline:{restore:noop}},duration:()=>1,$:()=>({}),setViewButtons:noop,drawLibrary:noop,updateBoneChoices:noop,drawMetadata:noop,updateDisplay:noop,render:noop,joint:(_m,_name,index)=>index===34?{}:null,setTarget:value=>selected.push(value),clearTarget:()=>cleared++});vm.runInContext('let cameraBusy=false;'+body,ctx);const restore=vm.runInContext('restoreContext',ctx);await restore({slot:'baseline',selection:{slot:'baseline',assetSha256:'frozen',bone:'Duplicate',nodeIndex:34}});assert.equal(selected[0].nodeIndex,34);await restore({slot:'baseline',selection:{slot:'baseline',assetSha256:'different',bone:'Duplicate',nodeIndex:34}});assert.equal(selected.length,1);assert.equal(cleared,1);});
