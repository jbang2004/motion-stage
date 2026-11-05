import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelCatalog} from '../../assets/viewer/model-catalog.mjs';
import {createCatalogDocument} from './viewer-dom-fixture.mjs';

const row=(id,extra={})=>({id,name:id+'.glb',format:'glb',status:'available',origin:'project',...extra});
const page=(entries,extra={})=>({entries,linked:true,total:entries.length,matched:entries.length,hasMore:false,scan:{state:'complete'},...extra});
function setup(data,{view={},open=async()=>{},choose=()=>{}}={}) {
 const document=createCatalogDocument(),errors=[],changes=[],calls=[];
 const currentView={activeAssetId:'selected',jobs:[],switching:false,allowAutomaticOpen:false,...view};
 const catalog=createModelCatalog({defaultView:'files',document,getView:()=>currentView,onOpen:open,onChooseFolder:choose,onError:error=>errors.push(error),onChange:value=>changes.push(value),api:async(...args)=>{calls.push(args);return data;}});
 return {document,catalog,errors,changes,calls,view:currentView,$:id=>document.getElementById(id)};
}

test('real catalog DOM preserves status badges, invalid-item protection, counts, job identities and source update actions',async()=>{
 const entries=[row('selected',{opened:true}),row('teaching',{origin:'teaching',metadata:{clips:[]}}),row('broken',{status:'invalid',error:'Invalid GLB'}),row('fbx',{format:'fbx',sourceChanged:true,metadata:{clips:[{name:'Run'}]}}),row('source',{format:'blend',status:'source-only'}),row('missing',{status:'missing'})];
 const data=page(entries,{hasMore:true,matched:12}),h=setup(data,{view:{jobs:[{assetId:'selected',state:'running'},{assetId:'different-model',state:'running'}]}});await h.catalog.refresh();
 const cards=h.$('modelList').querySelectorAll('.model-card');assert.equal(cards.length,6);assert.deepEqual(h.changes[0],data);assert.equal(h.changes[0].entries[0],entries[0]);assert.equal(h.$('modelCount').textContent,'6');assert.equal(h.$('sidebarModelCount').textContent,'6');assert.equal(h.$('catalogMore').hidden,false);assert.equal(h.$('catalogMore').textContent,'加载更多（已显示 6 / 12）');
 assert.equal(cards[0].classList.contains('selected'),true);assert.ok(cards[0].textContent.includes('1 条任务处理中'));assert.equal(cards[0].querySelector('button').textContent,'继续查看');assert.ok(cards[1].textContent.includes('原创教学素材'));assert.ok(cards[1].textContent.includes('资源预览'));assert.equal(cards[2].querySelectorAll('button').length,0);assert.ok(cards[2].querySelector('.catalog-error').textContent.includes('Invalid GLB'));assert.ok(cards[3].textContent.includes('首次打开时转换'));assert.deepEqual(cards[3].querySelectorAll('button').map(button=>button.textContent),['预览','载入源文件新版本']);assert.equal(cards[4].querySelectorAll('button').length,0);assert.equal(cards[5].querySelectorAll('button').length,0);
 h.view.switching=true;h.catalog.draw();assert.ok(h.$('modelList').querySelectorAll('button').every(button=>button.disabled));
});

test('catalog actions emit exact model/source intent, preserve disabled lifetime and report open errors through the host',async()=>{
 let release;const calls=[],wait=new Promise(resolve=>{release=resolve;}),h=setup(page([row('A',{sourceChanged:true})]),{open:async(...args)=>{calls.push(args);if(calls.length===1)await wait;else throw Error('open failed');}});await h.catalog.refresh();
 const [open,update]=h.$('modelList').querySelectorAll('button'),pending=open.onclick();assert.equal(open.disabled,true);assert.deepEqual(calls,[['A']]);release();await pending;assert.equal(open.disabled,false);
 await update.onclick();assert.deepEqual(calls[1],['A',{refreshSource:true}]);assert.equal(h.errors[0].message,'open failed');assert.equal(update.disabled,false);
});

test('navigation and scan controls use the existing modal and API contract',async()=>{
 let chosen=0;const h=setup(page([]),{choose:()=>{chosen++;}});await h.$('navCatalog').onclick();assert.equal(h.$('modelCatalogDialog').open,true);assert.equal(h.calls[0][0],'/api/catalog?query=&offset=0&limit=100');
 await h.$('refreshCatalog').onclick();assert.deepEqual(h.calls[1],['/api/catalog/scan','POST',{}]);h.$('catalogChooseFolder').onclick();assert.equal(h.$('modelCatalogDialog').open,false);assert.equal(chosen,1);
});

test('scan and empty states preserve their explanations and failure styling',async()=>{
 const h=setup(page([],{scan:{state:'failed',error:'unreadable',warnings:['Keep source files']}}));await h.catalog.refresh();assert.equal(h.$('catalogStatus').classList.contains('catalog-error'),true);assert.ok(h.$('catalogStatus').textContent.includes('扫描失败：unreadable'));assert.ok(h.$('catalogStatus').textContent.includes('Keep source files'));assert.ok(h.$('modelList').textContent.includes('此目录暂未发现资源'));
 const scanning=setup(page([],{scan:{state:'scanning',visitedFiles:3}}));await scanning.catalog.refresh();assert.equal(scanning.$('refreshCatalog').disabled,true);assert.ok(scanning.$('modelList').textContent.includes('正在发现模型'));assert.ok(scanning.$('catalogStatus').textContent.includes('已检查 3 个文件'));
});

test('automatic selection respects host eligibility and never takes another open dialog',async()=>{
 const h=setup(page([]),{view:{allowAutomaticOpen:false}});await h.catalog.refresh();assert.equal(h.$('modelCatalogDialog').open,false);h.view.allowAutomaticOpen=true;const other=h.document.add('dialog','other');other.showModal();await h.catalog.refresh();assert.equal(h.$('modelCatalogDialog').open,false);other.close();await h.catalog.refresh();assert.equal(h.$('modelCatalogDialog').open,false,'the one-time automatic decision is retained');
});

test('a current catalog failure keeps its previous DOM and displays the error without changing the data mirror',async()=>{
 const document=createCatalogDocument(),changes=[];let failing=false;
 const catalog=createModelCatalog({document,getView:()=>({activeAssetId:'A',jobs:[],switching:false,allowAutomaticOpen:false}),onOpen:()=>{},onChooseFolder:()=>{},onError:()=>{},onChange:data=>changes.push(data),api:async()=>{if(failing)throw Error('Catalog unavailable');return page([row('A')]);}});
 await catalog.refresh();const first=changes[0];failing=true;await document.getElementById('openModelCatalog').onclick();assert.equal(changes.length,1);assert.equal(changes[0],first);assert.ok(document.getElementById('modelList').textContent.includes('A.glb'));assert.equal(document.getElementById('catalogStatus').textContent,'Catalog unavailable');
});

test('character cards show confirmed sources and pass character-specific navigation and allow independent motion preview',async()=>{
 const calls=[],data=page([row('character-A',{character:true,confirmed:true,embeddedCount:2,motionSources:[{file:'run.glb',status:'ready',clips:['Run'],count:1},{file:'broken.glb',status:'needs-retarget',count:1,error:'参考姿势不同'}],sourceChanged:true}),row('animation',{metadata:{kind:'node-animation',capabilities:{preview:'nodes'},clips:[{name:'Run'}]}})],{kind:'characters',confirmedTotal:1,sourceTotal:3});
 const h=setup(data,{open:async(...args)=>calls.push(args)});await h.catalog.refresh();const cards=h.$('modelList').querySelectorAll('.model-card');assert.ok(cards[0].textContent.includes('已载入'));assert.ok(cards[0].textContent.includes('需要重定向'));await cards[0].querySelectorAll('button')[0].onclick();assert.deepEqual(calls[0],['character-A',{character:true}]);await cards[0].querySelectorAll('button')[1].onclick();assert.deepEqual(calls[1],['character-A',{character:true,refreshSource:true}]);assert.equal(cards[1].querySelectorAll('button').length,1);assert.ok(cards[1].textContent.includes('节点预览'));await cards[1].querySelector('button').onclick();assert.deepEqual(calls[2],['animation']);
});

test('an opened project FBX can explicitly adopt a converter fix without pretending its source changed',async()=>{const calls=[],h=setup(page([row('old-fbx',{format:'fbx',opened:true})]),{open:async(...args)=>calls.push(args)});await h.catalog.refresh();const buttons=h.$('modelList').querySelectorAll('button');assert.deepEqual(buttons.map(b=>b.textContent),['打开','重新转换 FBX']);await buttons[1].onclick();assert.deepEqual(calls[0],['old-fbx',{refreshSource:true}]);});
