import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {linkProject} from '../project-context.mjs';
import {startCatalogScan,waitForCatalogScan,stopCatalogScan} from '../asset-catalog.mjs';
import {readProject,modelSlots} from '../core.mjs';
import {parseGlb,encodeGlb,editGlb} from '../asset-tools.mjs';
import {waitForCharacterActions,characterActionCurves,stopCharacterActionDiscovery} from '../character-actions.mjs';
import {castRoster,characterModelFile,saveCharacterMap} from '../character-library.mjs';
import {validThumbnailKey,saveThumbnail,listThumbnails,thumbnailPath} from '../thumbnails.mjs';
import {actionCatalog,formatActionCatalog} from '../action-catalog.mjs';
import {serve} from '../server.mjs';

const base=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(24,1)]);
const WEBP=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBPVP8 '),Buffer.alloc(16,2)]);
function foreign(factor=.5){const edited=editGlb(base,{clip:'Run',bone:'LeftShoulder',factor}),p=parseGlb(edited.bytes);p.doc.animations=[p.doc.animations.find(a=>a.name==='Run')];p.doc.animations[0].name='Borrowed';return encodeGlb(p.doc,p.bin);}
async function fixture(fn){
 const root=await realpath(await mkdtemp(join(tmpdir(),'action-library-'))),project=join(root,'project'),work=join(root,'work');
 await mkdir(join(project,'models'),{recursive:true});await initializeWorkspace(work);await linkProject(work,project);
 const cfg=await readProject(work),asset=modelSlots(cfg).baseline,input={assetId:cfg.activeAssetId,slot:'baseline',expectedModelSha:asset.sha256};
 try{await fn({work,project,input});}finally{await stopCharacterActionDiscovery(work);await stopCatalogScan(work);await rm(root,{recursive:true,force:true});}
}
async function scan(work){await startCatalogScan(work,{force:true});await waitForCatalogScan(work);}
async function server(work,fn){const s=await serve(work,0);try{const url='http://127.0.0.1:'+s.address().port,{token}=await(await fetch(url+'/api/session')).json();await fn({url,token});}finally{await new Promise(r=>s.close(r));}}

test('thumbnail cache accepts only keyed PNG/WebP images and keeps one file per key',()=>fixture(async({work})=>{
 assert.ok(validThumbnailKey('action-0123456789abcdef'));
 for(const bad of ['short','../../project','Action-0123456789','a'.repeat(97),42])assert.equal(validThumbnailKey(bad),false);
 await assert.rejects(saveThumbnail(work,'../escape-key',PNG),/标识无效/);
 await assert.rejects(saveThumbnail(work,'action-0123456789abcdef',Buffer.from('<svg/>')),/PNG 或 WebP/);
 await assert.rejects(saveThumbnail(work,'action-0123456789abcdef',Buffer.alloc(1024*1024+1)),/1 MB/);
 assert.deepEqual(await listThumbnails(work),{files:{},count:0},'a missing cache folder is an empty cache');
 assert.deepEqual(await saveThumbnail(work,'action-0123456789abcdef',PNG),{key:'action-0123456789abcdef',url:'/workspace/thumbnails/action-0123456789abcdef.png'});
 await saveThumbnail(work,'action-0123456789abcdef',WEBP);
 assert.deepEqual(await readdir(join(work,'cache/thumbnails')),['action-0123456789abcdef.webp'],'a re-render in another format replaces the old file');
 assert.deepEqual((await listThumbnails(work)).files,{'action-0123456789abcdef':'/workspace/thumbnails/action-0123456789abcdef.webp'});
 assert.equal(thumbnailPath('/workspace/thumbnails/action-0123456789abcdef.webp'),'cache/thumbnails/action-0123456789abcdef.webp');
 for(const bad of ['/workspace/thumbnails/../project.json','/workspace/thumbnails/x.webp','/workspace/thumbnails/action-0123456789abcdef.svg'])assert.equal(thumbnailPath(bad),null);
}));

test('thumbnail upload is token-gated and served as an immutable private cache',()=>fixture(async({work})=>server(work,async({url,token})=>{
 const upload=(key,body,t=token)=>fetch(url+'/api/thumbnails/'+key,{method:'POST',headers:{'x-motion-token':t},body});
 assert.equal((await upload('portrait-0123456789abcdef',WEBP,'wrong')).status,403);
 assert.equal((await upload('portrait-0123456789abcdef',Buffer.from('nope'))).status,400);
 const saved=await(await upload('portrait-0123456789abcdef',WEBP)).json();
 assert.equal(saved.url,'/workspace/thumbnails/portrait-0123456789abcdef.webp');
 const listed=await(await fetch(url+'/api/thumbnails')).json();assert.equal(listed.count,1);
 const image=await fetch(url+saved.url);
 assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/webp');
 assert.equal(image.headers.get('cache-control'),'private, max-age=31536000, immutable');
 assert.deepEqual(Buffer.from(await image.arrayBuffer()),WEBP);
 assert.equal((await fetch(url+'/workspace/thumbnails/portrait-ffffffffffffffff.webp')).status,404);
})));

test('cast roster lists opened workspace models with a workspace portrait when no characters are declared',()=>fixture(async({work})=>{
 const cast=await castRoster(work),cfg=await readProject(work),asset=modelSlots(cfg).baseline;
 assert.equal(cast.linked,true);assert.equal(cast.confirmedTotal,0);assert.equal(cast.activeAssetId,cfg.activeAssetId);
 const entry=cast.entries.find(e=>e.id===cfg.activeAssetId);
 assert.equal(entry.kind,'model');assert.equal(entry.embeddedCount,asset.clips.length);
 assert.deepEqual(entry.portrait,{source:'workspace',identity:asset.sha256,asset:{sha256:asset.sha256,file:asset.file,bytes:asset.bytes}});
}));

test('declared characters come first with a project portrait that streams the model before it is opened',()=>fixture(async({work,project})=>{
 await writeFile(join(project,'models/hero.glb'),base);await scan(work);
 await saveCharacterMap(work,{version:1,characters:[{id:'hero',name:'角色甲',model:'models/hero.glb',animations:[]}]});
 const before=Object.keys((await readProject(work)).models).length,cast=await castRoster(work),hero=cast.entries[0];
 assert.equal(hero.kind,'character');assert.equal(hero.confirmed,true);assert.equal(hero.name,'角色甲');assert.equal(cast.confirmedTotal,1);
 assert.equal(hero.portrait.source,'project');assert.match(hero.portrait.identity,/^\d+:\d+$/);
 assert.equal(hero.portrait.url,'/api/characters/'+encodeURIComponent(hero.id)+'/model');
 assert.equal(Object.keys((await readProject(work)).models).length,before,'listing the cast imports nothing');
 assert.equal(await characterModelFile(work,hero.id),join(project,'models/hero.glb'));
 await assert.rejects(characterModelFile(work,'missing'),/角色不存在/);
 await server(work,async({url})=>{
  const response=await fetch(url+hero.portrait.url);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'model/gltf-binary');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),base);
 });
}));

test('curve reads for thumbnails are read-only, resampled and fenced against stale sources',()=>fixture(async({work,project,input})=>{
 const path=join(project,'foreign.glb');await writeFile(path,foreign());await scan(work);
 const {actions}=await waitForCharacterActions(work,input),id=actions[0].id;
 const projectBefore=await readFile(join(work,'project.json')),assetsBefore=await readdir(join(work,'assets'));
 const out=await characterActionCurves(work,{...input,actionIds:[id,id,'gone'],samples:5});
 assert.equal(out.modelSha,input.expectedModelSha);
 assert.deepEqual(Object.keys(out.clips).sort(),[id,'gone'].sort(),'duplicate ids are read once');
 const clip=out.clips[id];assert.equal(clip.name,'Borrowed');assert.ok(clip.duration>0);assert.ok(clip.tracks.length>0);
 for(const track of clip.tracks){assert.equal(track.times.length,5);assert.equal(track.times[0],0);assert.ok(Math.abs(track.times.at(-1)-clip.duration)<1e-9);}
 const quat=clip.tracks.find(t=>t.path==='rotation');assert.ok(quat,'the edited shoulder rotation is present');assert.equal(quat.values.length,20);assert.equal(quat.interpolation,'LINEAR');
 for(let i=0;i<20;i+=4)assert.ok(Math.abs(Math.hypot(...quat.values.slice(i,i+4))-1)<1e-6,'resampled rotations stay normalized');
 assert.match(out.clips.gone.error,/重新选择/);
 assert.deepEqual(await readFile(join(work,'project.json')),projectBefore,'no motion pack or head is registered');
 assert.deepEqual(await readdir(join(work,'assets')),assetsBefore);
 await assert.rejects(characterActionCurves(work,{...input,actionIds:[id],samples:1}),/2–120/);
 await assert.rejects(characterActionCurves(work,{...input,actionIds:[]}),/需要选择动作/);
 await writeFile(path,foreign(.8));
 assert.match((await characterActionCurves(work,{...input,actionIds:[id]})).clips[id].error,/来源已变化/);
 await server(work,async({url,token})=>{
  const post=t=>fetch(url+'/api/actions/curves',{method:'POST',headers:{'x-motion-token':t},body:JSON.stringify({...input,actionIds:[id],samples:4})});
  assert.equal((await post('wrong')).status,403);assert.equal((await post(token)).status,200);
 });
}));

test('the agent action catalog merges own and matched actions with categories, filters and a CLI listing',()=>fixture(async({work,project,input})=>{
 await writeFile(join(project,'foreign.glb'),foreign());await scan(work);
 const projectBefore=await readFile(join(work,'project.json'));
 const all=await actionCatalog(work,{wait:true});
 assert.equal(all.assetId,input.assetId);assert.equal(all.scan.state,'ready');
 assert.deepEqual(all.totals,{own:2,matched:1});
 assert.deepEqual(all.actions.map(a=>[a.origin,a.name,a.category]),[['own','Run','move'],['own','Salute','emote'],['matched','Borrowed','other']]);
 assert.equal(all.actions[0].label,'奔跑');assert.equal(all.actions[0].loop,true);assert.ok(all.actions[2].id);
 assert.deepEqual(all.categories.map(c=>[c.id,c.own,c.matched]),[['move',1,0],['emote',1,0],['other',0,1]]);
 assert.deepEqual((await actionCatalog(work,{category:'emote'})).actions.map(a=>a.name),['Salute']);
 assert.deepEqual((await actionCatalog(work,{query:'敬礼'})).actions.map(a=>a.name),['Salute'],'friendly labels are searchable');
 const capped=await actionCatalog(work,{limit:1});assert.equal(capped.actions.length,1);assert.equal(capped.truncated,true);assert.equal(capped.matchedQuery,3);
 await assert.rejects(actionCatalog(work,{category:'flying'}),/未知类别/);
 await assert.rejects(actionCatalog(work,{assetId:'missing'}),/角色尚未打开/);
 const text=formatActionCatalog(all);
 assert.match(text,/自带 2 · 匹配 1/);assert.match(text,/角色自带 \/ 移动/);assert.match(text,/奔跑  ·  Run  ·  \d\.\d\ds · 循环/);assert.match(text,/匹配动作 \/ 其他/);
 assert.deepEqual(await readFile(join(work,'project.json')),projectBefore,'listing never adopts actions');
}));

test('the actions CLI waits for matching by default and always exits on its own',()=>fixture(async({work,project})=>{
 await writeFile(join(project,'foreign.glb'),foreign());await scan(work);
 const cli=fileURLToPath(new URL('../motion-feedback.mjs',import.meta.url)),run=(...args)=>promisify(execFile)(process.execPath,[cli,'actions','--workspace',work,...args],{timeout:30000});
 const waited=JSON.parse((await run('--json')).stdout);
 assert.equal(waited.scan.state,'ready');assert.deepEqual(waited.totals,{own:2,matched:1});
 const quick=await run('--no-wait');
 assert.match(quick.stdout,/自带 2/);assert.equal(quick.stderr,'');
}));
