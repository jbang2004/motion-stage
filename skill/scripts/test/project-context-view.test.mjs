import test from 'node:test';
import assert from 'node:assert/strict';
import {renderProjectContext} from '../../assets/viewer/project-context-view.mjs';
import {createDocument} from './viewer-dom-fixture.mjs';

function host(){const document=createDocument();return document.add('div','context');}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}

test('legacy and frozen unlinked records never receive present-day project facts or a link action',()=>{
 for(const payload of [{source:'legacy'},{status:'legacy'},{projectContext:{status:'legacy',code:[{path:'must-not-appear'}]}}]){
  const node=host();renderProjectContext(node,payload);assert.ok(node.textContent.includes('不会用现在的资料补写历史'));assert.equal(node.querySelectorAll('button').length,0);assert.ok(!node.textContent.includes('must-not-appear'));
 }
 const node=host();renderProjectContext(node,{projectContext:{status:'unlinked'}},{frozen:true});assert.ok(node.textContent.includes('这条任务创建时没有关联项目'));assert.equal(node.querySelectorAll('button').length,0);
});

test('live unlinked context exposes the host link action with shared error and busy behavior',async()=>{
 const node=host(),errors=[];let reject;renderProjectContext(node,null,{onLinkProject:()=>new Promise((resolve,no)=>{reject=no;}),onError:error=>errors.push(error)});
 const button=node.querySelector('button'),pending=button.onclick();assert.equal(button.disabled,true);reject(Error('folder selection failed'));await pending;assert.equal(button.disabled,false);assert.equal(errors[0].message,'folder selection failed');assert.equal(button.className,'text-button');
});

test('frozen context renders every evidence group in order without changing the supplied snapshot',()=>{
 const payload=freeze({projectContext:{status:'linked',code:[{relativePath:'src/角色.js',confidence:'candidate',why:'Matching controller',excerpts:[{startLine:2,endLine:5,text:'literal <script>do not run</script>'}]}],sources:[{path:'rig.blend'}],history:[{relativePath:'notes.md'}],references:[{status:'missing',reference:'missing.png',why:'Not found'},{status:'external',from:'outside.png'},{status:'resolved',reference:'hidden.png'}],warnings:['Project warning']},continuity:{inheritedRequirements:[{text:'Keep the legs',scope:{wholeClip:true}}],acceptedCheckpoints:[{active:true,outcome:'Accepted exact version',scope:{start:.25,end:.5}},{active:true,stillAccepted:false,outcome:'Withdrawn version'},{onSourceAncestry:false,outcome:'Other branch'}],historicalInstructions:[{text:'Earlier words',scope:{bone:'LeftShoulder'}}],ancestry:[{request:'Earlier request',summary:'Earlier completion'}],rejectedApproaches:[{outcome:'Avoid this approach',request:'Prior goal',superseded:true}],warnings:[{reason:'Continuity warning'}]}}),before=structuredClone(payload),node=host();
 renderProjectContext(node,payload,{frozen:true,describeBone:bone=>bone==='LeftShoulder'?'左肩':null});assert.deepEqual(payload,before);
 const text=node.textContent;for(const value of ['不随当前项目变化','Keep the legs','适用范围：整个动作','Accepted exact version','检查范围：0.250–0.500 秒','该接受决定后来已撤回','其他分支上的历史决定','Earlier words','当时范围：左肩','可能相关 · 尚未确认绑定','src/角色.js','第 2–5 行\nliteral <script>do not run</script>','rig.blend','notes.md','此前已完成的修改（仅作背景）','当时的完成说明：Earlier completion','缺少引用：missing.png','外部引用：outside.png','避免重复的方案','当时修改目标（背景）：Prior goal','之后还有新的用户决定','Project warning','Continuity warning','正式替换游戏文件分别处理'])assert.ok(text.includes(value),value);
 assert.ok(text.indexOf('明确写下的保留条件')<text.indexOf('当前有效的用户验收检查点'));assert.ok(text.indexOf('相关代码')<text.indexOf('相关制作源'));assert.ok(!text.includes('hidden.png'));assert.equal(node.querySelectorAll('script').length,0);assert.equal(node.querySelectorAll('button').length,0);
});

test('missing and empty live context preserves warnings, unknown scope fallback and preview wording',()=>{
 const node=host();renderProjectContext(node,{projectContext:{status:'missing'},continuity:{inheritedRequirements:[{userInstruction:'Unchanged timing',scope:{bone:'unknown'}}]}});assert.ok(node.textContent.includes('文件夹暂时无法读取'));assert.ok(node.textContent.includes('适用范围：原任务指定部位'));assert.ok(node.textContent.includes('提交时会重新核对'));
 renderProjectContext(node,{projectContext:{status:'linked'},continuity:{}});assert.ok(node.textContent.includes('暂未找到可确认关联'));assert.ok(!node.textContent.includes('Unchanged timing'));assert.equal(node.classList.contains('project-context-content'),true);
});
