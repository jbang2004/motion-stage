import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppearanceController,disposeAppearance,withRendererState,renderAppearance,captureResources,disposeResources} from '../../assets/viewer/project-appearance.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const ready={status:'ready',bundle:'a'.repeat(64),module:'/appearance/a/adapter.mjs',threeRevision:'186',label:'Project look',profile:{color:'warm'},limitations:['No game runtime']};
const model=()=>({meta:{assetId:'A'},appearanceContext:{root:{},scene:{}}});
const tick=()=>new Promise(r=>setImmediate(r));
function harness(extra={}){const changes=[],imports=[];const controller=createAppearanceController({loadStatus:async()=>ready,revision:'186',importModule:async url=>{imports.push(url);return {version:1,create:({cleanup})=>{cleanup(()=>{});return {};}};},onChange:value=>changes.push(value),...extra});return {controller,changes,imports};}

test('neutral inspection never waits for optional status or imports project code',async()=>{
 const pending=deferred(),h=harness({loadStatus:()=>pending.promise});assert.equal(await h.controller.prepare([model()]),'ready');assert.equal(h.controller.mode,'neutral');assert.deepEqual(h.imports,[]);pending.reject(Error('optional status failed'));await tick();assert.equal(h.controller.descriptor.status,'unavailable');
});

test('project mode applies the same immutable adapter identity to both slots and cleans each exactly once',async()=>{
 let created=0,disposed=0;const h=harness({importModule:async()=>({version:1,create:({profile,cleanup})=>{assert.equal(profile.color,'warm');created++;cleanup(()=>disposed++);return {render(){}};}})}),models=[model(),model()];h.controller.select('project');assert.equal(await h.controller.prepare(models),'ready');assert.equal(created,2);assert.equal(h.controller.snapshot(models[0]).bundle,ready.bundle);models.forEach(disposeAppearance);models.forEach(disposeAppearance);assert.equal(disposed,2);
});

test('incompatible versions and import/create errors request a clean neutral rebuild and preserve input metadata',async()=>{
 for(const extra of [{loadStatus:async()=>({...ready,threeRevision:'999'})},{importModule:async()=>{throw Error('module failed');}},{importModule:async()=>({version:2,create(){}})},{importModule:async()=>({version:1,create(){throw Error('shader setup failed');}})}]){const h=harness(extra),m=model(),before=structuredClone(m.meta);h.controller.select('project');assert.equal(await h.controller.prepare([m]),'fallback');assert.equal(h.controller.mode,'neutral');assert.deepEqual(m.meta,before);assert.match(h.changes.at(-1).error,/恢复中性/);}
});

test('partial setup registers cleanup before throwing, so a failed second slot can release the whole pair',async()=>{
 let count=0,released=0;const h=harness({importModule:async()=>({version:1,create:({cleanup})=>{cleanup(()=>released++);if(++count===2)throw Error('second failed');return {};}})}),models=[model(),model()];h.controller.select('project');assert.equal(await h.controller.prepare(models),'fallback');models.forEach(disposeAppearance);assert.equal(released,2);
});

test('late module imports and status responses cannot replace another model or a later neutral selection',async()=>{
 const pending=deferred();let creates=0;const h=harness({importModule:()=>pending.promise});h.controller.select('project');const preparing=h.controller.prepare([model()]);await tick();h.controller.select('neutral');pending.resolve({version:1,create(){creates++;return {};}});assert.equal(await preparing,'retired');assert.equal(creates,0);assert.equal(h.controller.mode,'neutral');
 const old=deferred();let calls=0;const other=harness({loadStatus:()=>++calls===1?old.promise:Promise.resolve({...ready,label:'Latest'})});await other.controller.prepare([model()]);await tick();await other.controller.prepare([model()]);await tick();old.resolve({...ready,label:'Old'});await tick();assert.equal(other.controller.descriptor.label,'Latest');
});

test('recorded context restores only an exact available bundle and can retire during a view change',async()=>{
 const h=harness();assert.equal(await h.controller.chooseRecorded({mode:'project',bundle:ready.bundle},'A'),true);assert.equal(h.controller.mode,'project');await h.controller.chooseRecorded({mode:'project',bundle:'different'},'A');assert.equal(h.controller.mode,'neutral');assert.match(h.changes.at(-1).error,/记录/);
 const pending=deferred(),other=harness({loadStatus:()=>pending.promise});const restoring=other.controller.chooseRecorded({mode:'project',bundle:ready.bundle},'A',()=>false);pending.resolve(ready);assert.equal(await restoring,null);assert.equal(other.controller.mode,'neutral');
});

test('renderer state is restored after a composer mutates it and throws',()=>{
 class Vector4{constructor(...values){this.values=values;}}
 const initial={target:'default',viewport:new Vector4(1,2,3,4),scissor:new Vector4(5,6,7,8),test:true};
 const r={...initial,autoClear:false,toneMapping:'neutral',toneMappingExposure:1,outputColorSpace:'srgb',getRenderTarget(){return this.target;},getViewport(){return this.viewport;},getScissor(){return this.scissor;},getScissorTest(){return this.test;},setRenderTarget(v){this.target=v;},setViewport(v){this.viewport=v;},setScissor(v){this.scissor=v;},setScissorTest(v){this.test=v;}};
 const before={...r};assert.throws(()=>withRendererState(r,{Vector4},()=>{Object.assign(r,{target:'offscreen',viewport:new Vector4(),scissor:new Vector4(),test:false,autoClear:true,toneMapping:'none',toneMappingExposure:4,outputColorSpace:'linear'});throw Error('render failed');}),/render failed/);assert.deepEqual(r,before);
});

test('restoring an already neutral draft keeps its pending optional descriptor response eligible',async()=>{
 const pending=deferred(),h=harness({loadStatus:()=>pending.promise});await h.controller.prepare([model()]);assert.equal(await h.controller.chooseRecorded(undefined,'A'),false);pending.resolve(ready);await tick();assert.equal(h.controller.descriptor.status,'ready');
});

test('optional project imports have a deadline and cannot apply after neutral fallback',async()=>{
 let created=0;const pending=deferred(),h=harness({timeoutMs:10,importModule:()=>pending.promise});h.controller.select('project');assert.equal(await h.controller.prepare([model()]),'fallback');assert.match(h.controller.error,/超时/);pending.resolve({version:1,create(){created++;return {};}});await tick();assert.equal(created,0);assert.equal(h.controller.mode,'neutral');
});

test('unsupported async setup cannot register orphaned resources after disposal',async()=>{
 const pending=deferred();let released=0;const h=harness({importModule:async()=>({version:1,create:async({cleanup})=>{await pending.promise;cleanup(()=>released++);throw Error('late failure');}})}),m=model();h.controller.select('project');assert.equal(await h.controller.prepare([m]),'fallback');disposeAppearance(m);pending.resolve();await tick();assert.equal(released,1);
});

test('runtime shader errors propagate to recovery and restore both renderer state and the debug callback',()=>{
 class Vector4{};const previous=()=>{};
 const r={debug:{onShaderError:previous},getRenderTarget(){return null;},getViewport(){return new Vector4();},getScissor(){return new Vector4();},getScissorTest(){return false;},setRenderTarget(){},setViewport(){},setScissor(){},setScissorTest(){},render(){this.debug.onShaderError();}};
 assert.throws(()=>renderAppearance({appearance:{},scene:{}},{renderer:r,THREE:{Vector4},camera:{},viewport:{}}),/编译失败/);assert.equal(r.debug.onShaderError,previous);
});

test('material replacement cannot orphan original GLB textures or close shared images twice',()=>{
 let originalDisposed=0,replacementDisposed=0,texturesDisposed=0,imagesClosed=0;
 const image={close(){imagesClosed++;}},texture={isTexture:true,image,dispose(){texturesDisposed++;}},extra={isTexture:true,image,dispose(){texturesDisposed++;}};
 const node={material:{map:texture,normalMap:extra,dispose(){originalDisposed++;}}},scene={traverse:fn=>fn(node)},input=captureResources(scene);
 node.material={map:texture,dispose(){replacementDisposed++;}};const all=captureResources(scene,input);disposeResources(all);assert.equal(originalDisposed,1);assert.equal(replacementDisposed,1);assert.equal(texturesDisposed,2);assert.equal(imagesClosed,1);
});
