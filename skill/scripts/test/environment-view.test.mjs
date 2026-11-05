import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './viewer-dom-fixture.mjs';
import {createEnvironmentPanel} from '../../assets/viewer/environment-view.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {element} from '../../assets/viewer/ui.mjs';

const report=()=>({node:{version:'22.0.0',supported:true},workspace:{status:'ready'},server:{status:'ready'},blender:{status:'not-checked'},codex:{status:'not-checked'}});
function setup(loadReport=async()=>report()){
 const document=createDocument(),fields={};for(const id of ['button','recheck','close','reload'])fields[id]=document.add('button',id);fields.dialog=document.add('dialog','dialog');fields.body=document.add('div','body');
 let reloads=0;const panel=createEnvironmentPanel({...fields,loadReport,reloadPage:()=>reloads++});return {...fields,document,panel,get reloads(){return reloads;}};
}

test('the production renderer failure leaves diagnostics and page recovery controls working',async()=>{
 const h=setup(),document=h.document;
 for(const id of ['canvas','stageErrorTitle','retryLoad','taskRestoring'])document.add('div',id);
 const source=await readFile(new URL('../../assets/viewer/app.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf("const canvas=$('canvas');let renderer;"),source.indexOf('if(renderer){renderer.setPixelRatio('));assert.ok(code.length>0);
 let failures=0,reloads=0;
 const context=vm.createContext({T:{WebGLRenderer:class{constructor(){throw Error('GPU denied');}}},$:id=>document.getElementById(id),environmentPanel:h.panel,el:(tag,text)=>element(tag,text,'',document),fail:()=>failures++,location:{reload:()=>reloads++}});
 document.getElementById('canvas').addEventListener=()=>{};assert.doesNotThrow(()=>vm.runInContext(code,context));assert.equal(failures,0);
 await h.button.onclick();assert.equal(h.dialog.open,true);assert.equal(h.reload.hidden,false);assert.match(h.body.textContent,/WebGL2 不可用/);
 h.reload.onclick();assert.equal(h.reloads,1);
});

test('opening the cached environment panel does not probe optional programs',async()=>{
 const calls=[],h=setup(async refresh=>{calls.push(refresh);return report();});
 assert.deepEqual(calls,[]);h.panel.setGraphics({status:'ready'});await h.button.onclick();
 assert.deepEqual(calls,[false]);assert.equal(h.dialog.open,true);assert.match(h.body.textContent,/WebGL2 可用/);assert.match(h.body.textContent,/使用时检查/);
 h.close.onclick();assert.equal(h.dialog.open,false);await h.button.onclick();assert.deepEqual(calls,[false]);assert.equal(h.reload.hidden,true);
});

test('server success cannot mask a real graphics failure and the recovery control remains usable',async()=>{
 const h=setup();h.panel.update({...report(),browser:{webgl2:'ready'}});h.panel.setGraphics({status:'error',error:'GPU unavailable'});await h.button.onclick();
 assert.match(h.body.textContent,/GPU unavailable/);assert.doesNotMatch(h.body.textContent,/WebGL2 可用/);assert.equal(h.reload.hidden,false);h.reload.onclick();assert.equal(h.reloads,1);
 h.panel.setGraphics({status:'ready'});assert.match(h.body.textContent,/WebGL2 可用/);assert.equal(h.reload.hidden,true);
});

test('manual checks coalesce, show optional failure independently and do not infer authentication',async()=>{
 let finish,calls=0;const h=setup(()=>{calls++;return new Promise(resolve=>finish=resolve);});h.panel.update(report());await h.button.onclick();
 const first=h.recheck.onclick(),second=h.recheck.onclick();assert.equal(first,second);assert.equal(h.recheck.disabled,true);await Promise.resolve();assert.equal(calls,1);
 const checked=report();checked.blender={status:'missing',error:'Blender missing'};checked.codex={status:'ready',supported:true,version:'Codex test',auth:'not-checked'};finish(checked);await first;
 assert.equal(h.recheck.disabled,false);assert.match(h.body.textContent,/Blender missing/);assert.match(h.body.textContent,/登录和额度会在实际任务中确认/);assert.match(h.body.textContent,/记录目录可读写/);
});

test('a failed recheck stays visible across polling updates and a later successful check recovers',async()=>{
 let fail=true;const h=setup(async()=>{if(fail)throw Error('service unavailable');return report();});h.panel.update(report());await h.button.onclick();
 await h.recheck.onclick();assert.equal(h.recheck.disabled,false);assert.match(h.body.textContent,/service unavailable/);
 h.panel.update(report());assert.match(h.body.textContent,/service unavailable/);
 fail=false;await h.recheck.onclick();assert.doesNotMatch(h.body.textContent,/service unavailable/);assert.match(h.body.textContent,/记录目录可读写/);
});
