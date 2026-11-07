import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './viewer-dom-fixture.mjs';
import {createMotionWorkspace} from '../../assets/viewer/motion-workspace.mjs';
function fixture(){const document=createDocument(),original=Object.getOwnPropertyDescriptor(globalThis,'document');document.createElementNS=(_,tag)=>document.createElement(tag);
 for(const id of ['motionCurrentContext','motionAssetGrid','motionInspector','motionTabs','motionSearch','motionWorkspaceMessage','motionModelStatLabel','motionKind','mwModelCount','mwPackCount','mwActionCount','motionCollectionTitle','motionCollectionSubtitle','motionPreviewBar','closeMotionWorkspace','motionNewPack','motionWorkspaceImport','motionRefresh'])document.add('div',id);document.add('dialog','motionWorkspace');
 const get=document.getElementById;document.getElementById=id=>get(id)||(function find(n){return n.id===id?n:n.children.map(find).find(Boolean);})(document.body);
 Object.defineProperty(globalThis,'document',{value:document,configurable:true});return {document,cleanup(){if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;}};
}
const result={recipe:{id:'recipe',clip:'Shared attack',packName:'Pack',versionNumber:1}},request={assetId:'A',packId:'P',versionId:'V'};
const library=revision=>({revision,models:[],packs:[],characters:{},mappings:[]});
test('saving a direct trial works without ever opening the advanced source dialog',async()=>{
 const f=fixture();try{const calls=[],adopted=[],errors=[],view=createMotionWorkspace({api:async(path,method,input)=>{calls.push({path,method,input});return path==='/api/motions/adopt'?{saved:true}:library(calls.length);},getTarget:()=>({assetId:'A'}),onPreview:()=>{},onAdopt:r=>adopted.push(r),onError:e=>errors.push(e)});await view.play(result,request);assert.equal(f.document.getElementById('motionWorkspace').open,false);const button=f.document.getElementById('motionPreviewBar').children.find(n=>n.textContent==='加入常用动作');await button.onclick();assert.deepEqual(errors,[]);assert.equal(calls[0].path,'/api/motions');assert.deepEqual(calls[1],{path:'/api/motions/adopt',method:'POST',input:{...request,previewId:'recipe',expectedRevision:1}});assert.deepEqual(adopted,[{saved:true}]);assert.equal(f.document.getElementById('motionPreviewStatus').textContent,'已收录 · 固定版本');}finally{f.cleanup();}
});
test('a superseded trial cannot restore its toolbar after asynchronous clip binding',async()=>{
 const f=fixture();try{let done,current=true;const pending=new Promise(resolve=>done=resolve),view=createMotionWorkspace({getTarget:()=>({}),onPreview:()=>pending});const playing=view.play(result,request,()=>current);current=false;view.clear();done();await playing;assert.equal(f.document.getElementById('motionPreviewBar').hidden,true);}finally{f.cleanup();}
});
test('source tools select the current candidate and retain a loaded model on secondary tabs',async()=>{
 const f=fixture();try{
  const model={id:'A',name:'当前角色',actions:[],versions:[{slot:'baseline',asset:{label:'原版',sha256:'old',bytes:100,clips:[]}},{slot:'candidate',asset:{label:'本轮候选',sha256:'new',bytes:100,clips:[]}}]};
  const view=createMotionWorkspace({api:async()=>({...library(1),models:[model]}),getTarget:()=>({assetId:'A',slot:'candidate',clip:'Run'})});await view.open();
  const inspector=f.document.getElementById('motionInspector');assert.match(inspector.textContent,/本轮候选/);assert.match(f.document.getElementById('motionCurrentContext').textContent,/当前候选 · Run/);
  f.document.getElementById('motionTabs').children.find(b=>b.textContent==='已收录动作').onclick();assert.match(inspector.textContent,/当前角色/);assert.doesNotMatch(inspector.textContent,/先打开|选择一个项目角色/);
 }finally{f.cleanup();}
});
