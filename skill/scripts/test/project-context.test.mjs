import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp,rename,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {detectProjectRoot,getProjectLink,linkProject,buildProjectContext} from '../project-context.mjs';
import {atomic} from '../core.mjs';
import {buildDemo} from '../practice.mjs';
import {parseGlb,encodeGlb} from '../asset-tools.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
async function put(root,path,content){const file=join(root,path);await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,typeof content==='object'&&!Buffer.isBuffer(content)?JSON.stringify(content,null,2):content);return file;}
async function fixture(run){const base=await realpath(await mkdtemp(join(tmpdir(),'project-context-')));try{const root=join(base,'game'),work=join(root,'.motion-studio');await mkdir(work,{recursive:true});await put(root,'package.json',{name:'sample-game'});await put(root,'src/main.js','export const game = true;');await run({base,root,work});}finally{await rm(base,{recursive:true,force:true});}}
async function assetFixture(root,work){
 const bytes=await buildDemo(false),sha=hash(bytes);await put(root,'public/models/haru.glb',bytes);await put(work,'assets/'+sha+'.glb',bytes);
 await put(root,'src/haru.js',"export const model = '/models/haru.glb';\nexport const clips = ['Run'];\n");
 await put(root,'characters/haru/recipe.json',{id:'haru',runtime:{path:'public/models/haru.glb',sha256:sha},source:'characters/haru/author.blend',builder:'tools/haru.py',review:'docs/feedback/haru.md'});
 await put(root,'characters/haru/author.blend',Buffer.from('BLENDER_BINARY_CONTENT_NOT_AN_EXCERPT'));
 await put(root,'tools/haru.py',"# haru authoring\nSOURCE = 'characters/haru/author.blend'\n");await put(root,'docs/feedback/haru.md','# haru feedback\nReview public/models/haru.glb and preserve the right arm.\n');
 return{request:'Haru 左上臂缩小摆动，腿和另一只手保持。',preserve:'right arm and legs',slot:'baseline',clip:'Run',target:{bone:'LeftArm'},inputs:{baseline:{sha256:sha,label:'haru.glb',file:'assets/'+sha+'.glb',source:{format:'glb',originalName:'haru.glb',projectRelativePath:'public/models/haru.glb',sha256:sha}}},source:{format:'glb',originalName:'haru.glb',projectRelativePath:'public/models/haru.glb',sha256:sha},context:{}};
}
const all=p=>[...p.code,...p.sources,...p.history];

test('project detection is nearest-marker only and unlinked context does not index',()=>fixture(async({base,root,work})=>{
 const nested=join(root,'src/feature');await mkdir(nested,{recursive:true});await put(root,'.git','gitdir: /not/read/or/followed');assert.equal(await detectProjectRoot(nested),root);
 const inner=join(nested,'subproject');await put(inner,'project.godot','config_version=5');assert.equal(await detectProjectRoot(inner),inner);
 const unity=join(base,'unity');await put(unity,'ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000');await mkdir(join(unity,'Assets'),{recursive:true});assert.equal(await detectProjectRoot(join(unity,'Assets')),unity);
 assert.equal(await getProjectLink(work),null);const result=await buildProjectContext(work,{request:'haru'});assert.equal(result.status,'unlinked');assert.equal(result.suggestion.root,root);assert.equal(result.scan.visitedFiles,0);assert.equal(all(result).length,0);assert.equal(await getProjectLink(work),null);
}));

test('link identity survives project movement and is inherited from the canonical workspace',()=>fixture(async({base,root,work})=>{
 const before=await readFile(join(root,'src/main.js'),'utf8'),first=await linkProject(work,root,{name:'My game'}),again=await linkProject(work,root);assert.equal(first.id,again.id);assert.equal(first.rootRelative,'..');assert.equal(first.name,'My game');assert.equal(await readFile(join(root,'src/main.js'),'utf8'),before);
 const outside=join(base,'other-review');await mkdir(outside);const inherited=await linkProject(outside,root);assert.equal(inherited.id,first.id);
 const moved=join(base,'moved-game');await cp(root,moved,{recursive:true});const link=await getProjectLink(join(moved,'.motion-studio'));assert.equal(link.root,moved);assert.equal(link.id,first.id);assert.equal(link.workspace,join(moved,'.motion-studio'));
 await rename(root,join(base,'temporarily-elsewhere'));const missing=await getProjectLink(outside);assert.equal(missing.status,'missing');assert.equal(missing.exists,false);const packet=await buildProjectContext(outside,{});assert.equal(packet.status,'missing');assert.equal(packet.scan.visitedFiles,0);
}));

test('asset hashes and literal manifest references find bounded runtime, authoring source and feedback',()=>fixture(async({root,work})=>{
 const job=await assetFixture(root,work);await linkProject(work,root);const packet=await buildProjectContext(work,job);
 assert.equal(packet.status,'linked');const runtime=packet.code.find(x=>x.relativePath==='src/haru.js');assert.ok(runtime,JSON.stringify(packet));assert.equal(runtime.confidence,'linked');assert.ok(runtime.evidence.some(e=>e.line===1));assert.ok(runtime.excerpts.some(e=>e.text.includes('/models/haru.glb')));assert.match(runtime.sha256,/^[a-f0-9]{64}$/);
 const recipe=packet.sources.find(x=>x.relativePath==='characters/haru/recipe.json');assert.ok(recipe);assert.equal(recipe.confidence,'linked');const author=packet.sources.find(x=>x.relativePath==='characters/haru/author.blend');assert.ok(author);assert.equal(author.sha256,hash(await readFile(join(root,author.relativePath))));assert.deepEqual(author.excerpts,[]);assert.ok(packet.history.some(x=>x.relativePath==='docs/feedback/haru.md'));
 assert.ok(!JSON.stringify(packet).includes('BLENDER_BINARY_CONTENT_NOT_AN_EXCERPT'));assert.ok(JSON.stringify(packet).length<=24000);assert.ok(packet.code.length<=12&&packet.sources.length<=12&&packet.history.length<=6);
 for(const item of all(packet)){assert.ok(item.why&&item.evidence.length);assert.equal(item.relativePath.startsWith('/'),false);}
}));

test('same names remain candidates and stale manifest hashes cannot certify the current source chain',()=>fixture(async({root,work})=>{
 const job=await assetFixture(root,work);await put(root,'other/haru.glb',await buildDemo(true));await put(root,'characters/haru/recipe.json',{id:'haru',runtime:{path:'public/models/haru.glb',sha256:'f'.repeat(64)},source:'characters/haru/author.blend'});await linkProject(work,root);
 const result=await buildProjectContext(work,job),copy=result.sources.find(x=>x.relativePath==='other/haru.glb');assert.ok(copy);assert.equal(copy.confidence,'candidate');const recipe=result.sources.find(x=>x.relativePath==='characters/haru/recipe.json');assert.ok(recipe);assert.equal(recipe.confidence,'candidate');assert.ok(recipe.evidence.some(e=>e.kind==='manifest-hash-mismatch'));assert.ok(result.warnings.some(w=>w.includes('哈希')));
}));

test('an unrelated comparison character is metadata, never an anchor for the selected source',()=>fixture(async({root,work})=>{
 const job=await assetFixture(root,work),other=await buildDemo(true),sha=hash(other);await put(root,'public/models/sora.glb',other);await put(root,'src/sora.js',"export const model='/models/sora.glb';\n");await put(work,'assets/'+sha+'.glb',other);
 job.inputs.candidate={sha256:sha,label:'sora.glb',file:'assets/'+sha+'.glb',source:{sha256:sha,originalName:'sora.glb',projectRelativePath:'public/models/sora.glb'}};await linkProject(work,root);
 const result=await buildProjectContext(work,job);assert.equal(result.task.assetIdentities.find(a=>a.slot==='candidate').role,'comparison');assert.ok(!all(result).some(i=>i.relativePath==='src/sora.js'||i.relativePath==='public/models/sora.glb'));assert.ok(result.code.some(i=>i.relativePath==='src/haru.js'&&i.confidence==='linked'));
 const selected={...job,slot:'candidate',source:job.inputs.candidate.source,request:'Sora arm change',context:{}};const reverse=await buildProjectContext(work,selected);assert.ok(reverse.code.some(i=>i.relativePath==='src/sora.js'&&i.confidence==='linked'));assert.ok(!all(reverse).some(i=>i.relativePath==='src/haru.js'));
}));

test('excluded workspaces, secrets and external references are never injected or followed',()=>fixture(async({base,root,work})=>{
 const job=await assetFixture(root,work);for(const p of['.env','credentials.json','package-lock.json','node_modules/pkg/haru.js','.git/config.json','.agents/private/haru.md','.motion-studio.init-abc/haru.md','recordings/motion-studio-review/haru.md'])await put(root,p,'SECRET_EXCLUDED_SENTINEL haru /models/haru.glb');
 const external=await put(base,'outside.blend','EXTERNAL_CONTENT_SENTINEL');await symlink(process.platform==='win32'?base:external,join(root,'characters/haru/escape.blend'),process.platform==='win32'?'junction':'file');
 await put(root,'characters/haru/recipe.json',{id:'haru',runtime:{path:'public/models/haru.glb',sha256:job.inputs.baseline.sha256},sources:['characters/haru/escape.blend',external,'../outside.blend','characters/haru/missing.blend']});await linkProject(work,root);
 const result=await buildProjectContext(work,job),serialized=JSON.stringify(result);assert.doesNotMatch(serialized,/SECRET_EXCLUDED_SENTINEL|EXTERNAL_CONTENT_SENTINEL/);assert.ok(result.references.some(r=>r.status==='external'));assert.ok(result.references.some(r=>r.status==='missing'));assert.ok(!all(result).some(x=>x.relativePath.includes('escape.blend')));
}));

test('optional source maps match actual identity, with name-only maps explicitly tentative',()=>fixture(async({root,work})=>{
 const job=await assetFixture(root,work);await put(root,'tools/precise.py','# explicitly mapped authoring tool');await put(root,'docs/notes.md','# explicit name-only history');await linkProject(work,root);
 const file=join(work,'project-link.json'),config=JSON.parse(await readFile(file));config.assetLinks=[{asset:{sha256:job.inputs.baseline.sha256},code:['tools/precise.py']},{asset:{originalName:'haru.glb'},history:['docs/notes.md']}];await atomic(file,config);
 const result=await buildProjectContext(work,job);assert.equal(result.code.find(x=>x.relativePath==='tools/precise.py').confidence,'linked');assert.equal(result.history.find(x=>x.relativePath==='docs/notes.md').confidence,'candidate');
}));

test('large text is not injected and the serialized context obeys its total budget',()=>fixture(async({root,work})=>{
 const job=await assetFixture(root,work);for(let i=0;i<35;i++)await put(root,'src/haru-'+i+'.js',"// haru\nexport const model='/models/haru.glb';\n"+'// '+('long_line '.repeat(250))+'\n');await put(root,'docs/haru-large.md','LARGE_TEXT_SENTINEL /models/haru.glb\n'+'x'.repeat(270000));await linkProject(work,root);const result=await buildProjectContext(work,job);assert.ok(JSON.stringify(result).length<=24000);assert.ok(result.code.length<=12);assert.doesNotMatch(JSON.stringify(result),/LARGE_TEXT_SENTINEL/);assert.ok(result.scan.skippedFiles>0);assert.ok(result.scan.readBytes<=result.scan.limits.maxTextBytes);
}));

test('a 3D motion request prioritizes metadata-identified controller over translations, audio and portraits',()=>fixture(async({root,work})=>{
 const job=await assetFixture(root,work),parsed=parseGlb(await buildDemo(false));parsed.doc.nodes[0].name='Haru_Rig';parsed.doc.nodes.push({name:'Body'},{name:'Armature'},{name:'Atlas'});const bytes=encodeGlb(parsed.doc,parsed.bin,parsed.extra),sha=hash(bytes);await put(work,'assets/'+sha+'.glb',bytes);
 job.inputs.baseline={sha256:sha,file:'assets/'+sha+'.glb',label:'角色 · 原版',source:{sha256:sha,originalName:'baseline.glb'}};job.source=job.inputs.baseline.source;job.request='Walking arm movement smaller, keep the model unchanged';job.preserve='keep other motion';
 await put(root,'src/controllers/haru.js','// Haru Walking arm movement controller\nexport const updatePose = rig => rig.update();');
 await put(root,'src/i18n/en.js','export const notes = "Haru Walking arm movement model unchanged";');await put(root,'src/audio/lines.js','export const lines = "Haru Walking arm movement model unchanged";');
 await put(root,'assets/audio/provenance.json',{character:'Haru',voice:'haru.wav'});await put(root,'assets/illustrations/manifest.json',{character:'Haru',portrait:'haru.png'});await put(root,'characters/other/README.md','Haru Walking arm movement model unchanged');await linkProject(work,root);
 const result=await buildProjectContext(work,job);assert.equal(result.code[0].relativePath,'src/controllers/haru.js');assert.ok(!all(result).some(i=>/i18n|audio|illustrations|characters\/other/.test(i.relativePath)));assert.ok(result.sources.every(i=>!i.relativePath.includes('provenance')&&!i.relativePath.includes('illustrations')));
 const requested=await buildProjectContext(work,{...job,request:'Please edit Haru audio voice lines'});assert.ok(requested.code.some(i=>i.relativePath==='src/audio/lines.js'),'an explicit audio task restores audio context');
}));

test('reference extraction preserves real spaced literals without reporting commands or prose as missing paths',()=>fixture(async({root,work})=>{
 const job=await assetFixture(root,work),spaced='characters/haru/My Rig/author source.blend',missing='characters/haru/definitely-missing.blend';await put(root,spaced,Buffer.from('NATIVE_SOURCE_WITH_SPACES'));await put(root,'tools/command-only.mjs','export const ready=true;');
 await put(root,'characters/haru/recipe.json',{id:'haru',runtime:{path:'public/models/haru.glb',sha256:job.inputs.baseline.sha256},source:spaced,missing});
 await put(root,'src/haru-comment.js',"// Haru's numbers (brain.js; the rules they are for: src/haru.js)\nconst source='"+spaced+"';\nconst missing='"+missing+"';\n");
 await put(root,'docs/feedback/haru.md','# Haru '+job.inputs.baseline.sha256+'\n'+[
  '`BEFORE=1 node tools/command-only.mjs`',
  '`node --test tools/test/not-present.mjs tools/test/also-missing.mjs`',
  '`moves.js; src/haru.js`',
  'The owner\'s numbers (brain.js; the rules they are for: src/haru.js).',
  '`basename-only.js`',
  '`'+missing+'`',
 ].join('\n'));
 await linkProject(work,root);const result=await buildProjectContext(work,job);assert.ok(result.sources.some(i=>i.relativePath===spaced),'quoted filenames containing spaces remain resolvable');assert.ok(!result.references.some(i=>/BEFORE=|node --test|numbers|rules they|moves\.js;|basename-only|not-present|also-missing/.test(i.reference)));assert.equal(result.references.filter(i=>i.reference===missing).length,1,'same missing path across documents is reported once');
 const mentioned=result.code.find(i=>i.relativePath==='tools/command-only.mjs');assert.ok(mentioned);assert.equal(mentioned.confidence,'candidate','a command mention must not certify an authoring-source binding');
}));
