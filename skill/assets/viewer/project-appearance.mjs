// Optional project code runs only after explicit selection. Every application
// starts from a fresh GLB pair; neutral mode never imports a project module.
export function createAppearanceController({loadStatus,importModule=url=>import(url),revision,runCreate=(fn,ctx)=>fn(ctx),timeoutMs=5000,onChange=()=>{}}){
 let mode='neutral',descriptor=null,error='',generation=0,request=0,loading=false;
 const publish=()=>onChange({mode,descriptor,error,loading});
 const fail=message=>{mode='neutral';error=message;generation++;publish();};
 const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('项目外观载入超时')),timeoutMs);})]);}finally{clearTimeout(timer);}};
 return {
  get mode(){return mode;},
  get descriptor(){return descriptor;},
  get error(){return error;},
  select(next){if(!['neutral','project'].includes(next))throw Error('未知外观模式');mode=next;error='';generation++;publish();},
  fail,
  async chooseRecorded(snapshot,assetId,isCurrent=()=>true){
   const prior=mode,priorBundle=descriptor?.bundle;
   if(snapshot?.mode==='project'){
    let status;try{status=await loadStatus(assetId);}catch(e){status={status:'unavailable',message:e.message};}
    if(!isCurrent())return null;
    if(status.status==='ready'&&status.bundle===snapshot.bundle){descriptor=status;mode='project';error='';}
    else {mode='neutral';error='记录中的项目外观已不可用，使用中性检查。';}
   }else mode='neutral';
   const changed=prior!==mode||mode==='project'&&priorBundle!==descriptor?.bundle;
   if(changed)generation++;publish();return changed;
  },
  async prepare(models,isCurrent=()=>true){
   const ticket=generation,flight=++request,wanted=mode;loading=wanted==='project';publish();
   const current=()=>ticket===generation&&flight===request&&isCurrent();
   if(wanted==='neutral'){
    void Promise.resolve().then(()=>loadStatus(models[0]?.meta?.assetId)).then(status=>{if(current()){descriptor=status;publish();}}).catch(e=>{if(current()){descriptor={status:'unavailable',message:e.message};publish();}});
    return 'ready';
   }
   try{
    const status=await bounded(loadStatus(models[0]?.meta?.assetId));if(!current())return 'retired';descriptor=status;
    if(status.status!=='ready')throw Error(status.message||'项目外观不可用');
    if(status.threeRevision!==String(revision))throw Error('项目外观需要 Three.js r'+status.threeRevision+'，当前为 r'+revision);
    const module=await bounded(importModule(status.module));if(!current())return 'retired';
    if(module.version!==1||typeof module.create!=='function')throw Error('外观适配接口不兼容');
    for(const model of models){
     // Register cleanup before creating resources, including when create throws.
     model.appearanceCleanups=[];model.appearanceDisposed=false;
     const cleanup=fn=>{if(typeof fn!=='function')throw Error('外观清理函数无效');if(model.appearanceDisposed)fn();else model.appearanceCleanups.push(fn);};
     const handle=runCreate(module.create,{...model.appearanceContext,profile:status.profile,cleanup});
     if(handle?.then){void Promise.resolve(handle).catch(()=>{});throw Error('外观 create 必须同步返回，异步资源应在模块载入前准备');}
     if(handle?.render&&typeof handle.render!=='function'||handle?.update&&typeof handle.update!=='function')throw Error('外观适配返回值无效');
     model.appearance=handle||{};model.appearanceInfo={mode:'project',bundle:status.bundle,label:status.label,profile:status.profile,evidence:status.evidence,limitations:status.limitations};
     if(!current())return 'retired';
    }
    return 'ready';
   }catch(e){if(!current())return 'retired';if(wanted==='neutral'){descriptor={status:'unavailable',message:e.message};publish();return 'ready';}fail('项目外观不可用，已恢复中性检查：'+e.message);return 'fallback';}
   finally{if(flight===request){loading=false;publish();}}
  },
  snapshot(model){return model?.appearanceInfo||{mode:'neutral'};},
 };
}
export function renderAppearance(model,{renderer,THREE,camera,viewport,time=0}){
 const previous=renderer.debug.onShaderError;
 try{
  if(model.appearance)renderer.debug.onShaderError=()=>{throw Error('项目外观着色器编译失败');};
  return withRendererState(renderer,THREE,()=>{
   model.appearance?.update?.({time,viewport});
   if(model.appearance?.render)return model.appearance.render({renderer,scene:model.scene,camera,viewport});
   renderer.render(model.scene,camera);
  });
 }finally{renderer.debug.onShaderError=previous;}
}
export function disposeAppearance(model){
 if(model)model.appearanceDisposed=true;
 const callbacks=model?.appearanceCleanups?.splice(0)||[];
 for(const cleanup of callbacks.reverse())try{cleanup();}catch{}
 if(model){model.appearance=null;model.appearanceInfo=null;}
}
// Keep input resources reachable even when a project replaces materials or
// removes a display mesh. Source normal/roughness maps still need releasing.
export function captureResources(scene,prior){
 const resources=Object.fromEntries(['geometries','materials','textures','skeletons'].map(k=>[k,new Set(prior?.[k]||[])]));
 scene.traverse(o=>{
  if(o.geometry)resources.geometries.add(o.geometry);
  if(o.skeleton)resources.skeletons.add(o.skeleton);
  for(const material of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]){resources.materials.add(material);for(const value of Object.values(material))if(value?.isTexture)resources.textures.add(value);}
 });return resources;
}
export function disposeResources(resources){
 const images=new Set();for(const t of resources.textures){for(const img of Array.isArray(t.image)?t.image:[t.image])if(img)images.add(img);t.dispose();}
 for(const image of images)image.close?.();
 for(const key of ['geometries','materials','skeletons'])for(const value of resources[key])value.dispose();
}
// A composer may change render target, viewport, scissor and output transforms.
// Restore them even when a project hook throws, so another slot stays usable.
export function withRendererState(renderer,THREE,run){
 const saved={target:renderer.getRenderTarget(),viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),test:renderer.getScissorTest(),autoClear:renderer.autoClear,toneMapping:renderer.toneMapping,exposure:renderer.toneMappingExposure,colorSpace:renderer.outputColorSpace};
 try{return run();}finally{renderer.setRenderTarget(saved.target);renderer.setViewport(saved.viewport);renderer.setScissor(saved.scissor);renderer.setScissorTest(saved.test);renderer.autoClear=saved.autoClear;renderer.toneMapping=saved.toneMapping;renderer.toneMappingExposure=saved.exposure;renderer.outputColorSpace=saved.colorSpace;}
}
