import {readFile,readdir,realpath,stat,lstat,open} from 'node:fs/promises';
import {resolve,relative,dirname,basename,extname,isAbsolute,sep,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomic,inside,ROOT} from './core.mjs';

// This module only observes an explicitly linked project. It never executes a
// project script, edits a game file, or treats retrieved prose as instructions.
const LIMITS=Object.freeze({maxFiles:4000,maxDirectories:1200,maxDepth:14,maxTextFileBytes:256*1024,maxTextBytes:8*1024*1024,maxHashBytes:768*1024*1024,maxHashFileBytes:512*1024*1024,maxBinaryHashes:40,maxGLBJsonBytes:2*1024*1024,maxCharacters:24000,maxCode:12,maxSources:12,maxHistory:6});
const SKIP_DIRS=new Set(['.git','.hg','.svn','node_modules','dist','dist-builda','builda-release','.builda-agent','.agents','.claude','.codex','.cursor','.vscode','.idea','.motion-studio','.ssh','.aws','.config','.cache','.venv','venv','__pycache__','.godot','Library','Temp','obj','coverage']);
const TEXT=new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.gd','.cs','.cpp','.cc','.h','.hpp','.c','.sh','.ps1','.lua','.rs','.java','.json','.gltf','.yaml','.yml','.toml','.md','.txt','.rst','.cfg','.ini','.tres','.tscn']);
const CODE=new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.gd','.cs','.cpp','.cc','.h','.hpp','.c','.sh','.ps1','.lua','.rs','.java']);
const MODELS=new Set(['.glb','.fbx','.blend','.bvh','.abc','.usd','.usda','.usdc','.ma','.mb','.uasset','.vrm','.obj','.c4d']);
const REF_EXT='(?:glb|gltf|fbx|blend|bvh|abc|usd|usda|usdc|ma|mb|uasset|vrm|obj|c4d|json|mjs|cjs|js|ts|tsx|jsx|py|gd|cs|sh|md|txt|tres|tscn)';
const GENERIC=new Set(('asset assets model models character characters motion motions animation animations original candidate baseline source sources converted editable mesh material materials scene rig node default public private true false null glb fbx blend json mixamo mixamorig tripo arm left right hand run walk walking running idle rotation scale swing keep preserve reduce clip data runtime sourcefps hips spine bone bones torso root local quaternion translate translation body armature atlas skeleton humanoid human geometry object diffuse basecolor normal texture textures and other the with from for this that approved unchanged').split(' '));
const HAN_STOP=new Set(['角色','动作','修改','保持','保留','左臂','右臂','左手','右手','行走','摆动','一点','原版','整个','现在','希望','请把','这个','一下','候选','当前','缩小','其他','制作','检查']);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(v);
const digest=b=>createHash('sha256').update(b).digest('hex');
const slash=p=>p.split(sep).join('/');
const inRoot=(root,path)=>{const r=relative(root,path);return r===''||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
const shorten=(v,n=220)=>String(v??'').slice(0,n);
async function exists(path,kind){try{const s=await stat(path);return kind==='dir'?s.isDirectory():kind==='file'?s.isFile():true;}catch{return false;}}
async function canonical(path){try{return await realpath(resolve(path));}catch(e){if(e.code==='ENOENT')return resolve(path);throw e;}}
function sensitive(path){const n=basename(path).toLowerCase();return n==='.env'||n.startsWith('.env.')||['.envrc','.npmrc','.netrc','.pypirc','id_rsa','id_ed25519'].includes(n)||/\.(?:pem|key|p12|pfx|keystore|lock)$/.test(n)||/(?:^|[-_.])(?:lock|credentials?|secrets?|passwords?|tokens?)(?:[-_.]|$)/.test(n)||['package-lock.json','packages-lock.json','pnpm-lock.yaml','yarn.lock','composer.lock','gemfile.lock','poetry.lock','uv.lock','cargo.lock'].includes(n);}
function excludedName(name){return SKIP_DIRS.has(name)||name.startsWith('.motion-studio')||/^motion[-_](?:stage|studio|feedback|review|atelier)(?:[-_]|$)/i.test(name)||/^animation-agent-benchmark(?:[-_]|$)/i.test(name);}
function safeExcerpt(line){return /(?:\b(?:api[_-]?key|secret|password|authorization|credential)\b\s*[:=]|\b(?:sk-[A-Za-z0-9]{16}|ghp_[A-Za-z0-9]{16}|github_pat_[A-Za-z0-9]{16}|AKIA[A-Z0-9]{12}))/i.test(line)?'[credential-like line omitted]':shorten(line,240);}
async function smallJSON(path,max=256*1024){const s=await stat(path);if(!s.isFile()||s.size>max)throw Error('项目关联配置过大或不是文件');return JSON.parse(await readFile(path,'utf8'));}

export async function detectProjectRoot(start){
 let path=await canonical(start);try{if((await stat(path)).isFile())path=dirname(path);}catch{path=dirname(path);}
 for(;;){
  if(await exists(join(path,'.git'))||await exists(join(path,'project.godot'),'file')||await exists(join(path,'package.json'),'file')&&await exists(join(path,'src'),'dir')||await exists(join(path,'Assets'),'dir')&&(await exists(join(path,'ProjectSettings','ProjectVersion.txt'),'file')||await exists(join(path,'Packages','manifest.json'),'file')))return path;
  const parent=dirname(path);if(parent===path)return null;path=parent;
 }
}

function mappings(value){if(!Array.isArray(value))return[];return value.slice(0,64).filter(v=>v&&typeof v==='object'&&!Array.isArray(v)).map(v=>({asset:{...(typeof v.asset?.sha256==='string'?{sha256:shorten(v.asset.sha256,64).toLowerCase()}:{}),...(typeof v.asset?.originalName==='string'?{originalName:shorten(v.asset.originalName,240)}:{}),...(typeof v.asset?.path==='string'?{path:shorten(v.asset.path,1000)}:{})},...Object.fromEntries(['code','sources','history'].map(k=>[k,Array.isArray(v[k])?v[k].filter(x=>typeof x==='string').slice(0,24).map(x=>shorten(x,1000)):[]]))}));}
export async function getProjectLink(work){
 const workspace=await canonical(work);let config;
 try{config=await smallJSON(await inside(workspace,'project-link.json'));}catch(e){if(e.code==='ENOENT')return null;throw Error('无法读取项目关联：'+e.message);}
 if(!uuid(config.projectId)||typeof config.rootRelative!=='string'||!config.rootRelative||config.rootRelative.length>4096||isAbsolute(config.rootRelative))throw Error('项目关联格式无效：需要 projectId 与相对 rootRelative');
 const root=await canonical(resolve(workspace,config.rootRelative)),available=await exists(root,'dir');
 return{version:1,status:available?'linked':'missing',id:config.projectId,name:shorten(config.projectName||basename(root),160),root,workspace,rootRelative:config.rootRelative,exists:available,linkedAt:config.linkedAt||null,assetLinks:mappings(config.assetLinks)};
}
export async function linkProject(work,root,{name}={}){
 const workspace=await realpath(resolve(work)),projectRoot=await realpath(resolve(root));if(!await exists(projectRoot,'dir'))throw Error('选择的项目不是文件夹');
 let previous=null;try{previous=await getProjectLink(workspace);}catch{}
 let inherited=null;try{const p=await realpath(join(projectRoot,'.motion-studio','project-link.json'));if(inRoot(projectRoot,p))inherited=await smallJSON(p);}catch{}
 const same=previous?.root===projectRoot,id=same?previous.id:uuid(inherited?.projectId)?inherited.projectId:randomUUID();
 const config={version:1,projectId:id,projectName:shorten(typeof name==='string'&&name.trim()?name.trim():same?previous.name:inherited?.projectName||basename(projectRoot),160),rootRelative:relative(workspace,projectRoot)||'.',linkedAt:same?previous.linkedAt||new Date().toISOString():new Date().toISOString()};
 const assetLinks=same?previous.assetLinks:mappings(inherited?.assetLinks);if(assetLinks.length)config.assetLinks=assetLinks;
 await atomic(await inside(workspace,'project-link.json'),config);return getProjectLink(workspace);
}

function category(path){const e=extname(path).toLowerCase();if(CODE.has(e))return'code';if(MODELS.has(e)||['.gltf','.tres','.tscn'].includes(e))return'sources';if(/(?:^|\/)(?:feedback|motion-feedback|reviews?|history|decisions?)(?:\/|[-_.])|retrospective/i.test(path))return'history';if(['.json','.yaml','.yml','.toml','.cfg','.ini'].includes(e))return'metadata';return'history';}
function tokens(value){const out=[];for(const m of String(value||'').replace(/([a-z])([A-Z])/g,'$1 $2').matchAll(/[a-z][a-z0-9]{2,}|[\p{Script=Han}]+/giu)){const s=m[0].toLowerCase();if(/[\p{Script=Han}]/u.test(s)){for(let i=0;i<s.length-1&&i<80;i++){const w=s.slice(i,i+2);if(!HAN_STOP.has(w))out.push(w);}}else if(!GENERIC.has(s)&&!/^[a-f0-9]{8,}$/.test(s)&&!/^\d/.test(s)&&s.length<45)out.push(s);}return[...new Set(out)].slice(0,64);}
function identity(job){return Object.entries(job.inputs||{}).filter(([slot,a])=>['baseline','candidate'].includes(slot)&&a&&typeof a==='object').slice(0,2).map(([slot,a])=>({slot,role:slot===(job.slot||'baseline')?'source':'comparison',...Object.fromEntries(['sha256','file','label','generator'].filter(k=>typeof a[k]==='string').map(k=>[k,shorten(a[k],320)])),...(a.source?{source:{...Object.fromEntries(['sha256','file','path','originalName','editablePath','projectRelativePath','format'].filter(k=>typeof a.source[k]==='string').map(k=>[k,shorten(a.source[k],500)]))}}:{})}));}
async function glbMetadata(path,limit){let fh;try{fh=await open(path,'r');const head=Buffer.alloc(20);if((await fh.read(head,0,20,0)).bytesRead!==20||head.readUInt32LE(0)!==0x46546c67||head.readUInt32LE(16)!==0x4e4f534a)return null;const length=head.readUInt32LE(12),s=await fh.stat();if(length>limit||20+length>s.size)return null;const bytes=Buffer.alloc(length);await fh.read(bytes,0,length,20);const d=JSON.parse(bytes.toString('utf8').trim());return{generator:shorten(d.asset?.generator,160),clipNames:(d.animations||[]).slice(0,32).map(a=>shorten(a.name,80)),names:[...(d.nodes||[]),...(d.meshes||[]),...(d.materials||[])].map(n=>n.name).filter(n=>typeof n==='string'&&!/mixamorig|tripo|^[a-f0-9_-]{12,}$/i.test(n)).slice(0,48).map(n=>shorten(n,80)),characterName:shorten(d.asset?.extras?.characterName||d.extras?.characterName||'',100),meshCount:d.meshes?.length||0,skinCount:d.skins?.length||0,animationCount:d.animations?.length||0};}catch{return null;}finally{await fh?.close();}}
function references(text,path=''){
 const out=new Map(),ranges=[],markdown=/\.(?:md|txt|rst)$/i.test(path),extension=new RegExp('\\.'+REF_EXT+'(?:[?#][^\\s]*)?$','i');
 const command=/^(?:[A-Za-z_][\w]*=\S+\s+)*(?:node|npm|npx|python\d*|blender|bash|sh|zsh|git|curl|ffmpeg|ffprobe|env)\s/i;
 const token=new RegExp('(?<![\\p{L}\\p{N}_./-])(?:\\.{1,2}[\\/]|[\\/]|[\\p{L}\\p{N}_@.-]+[\\/])(?:[\\p{L}\\p{N}_@.-]+[\\/])*[\\p{L}\\p{N}_@.-]+\\.'+REF_EXT+'(?:[?#][^\\s"\'`<>]*)?','giu');
 const add=(raw,index,literal=false,direct=false)=>{const ref=raw.trim().replace(/\\\\/g,'\\'),name=basename(ref.split(/[?#]/)[0]);if(ref.length>1999||/[{}$;|<>]/.test(ref)||name.lastIndexOf('.')<=0||sensitive(ref)||!extension.test(ref))return;const value={reference:ref,line:text.slice(0,index).split('\n').length,literal,reportMissing:direct&&!(/\s/.test(ref)||markdown&&!/[\\/]/.test(ref))};const prior=out.get(ref);if(!prior||literal&&!prior.literal||value.reportMissing&&!prior.reportMissing)out.set(ref,value);};
 const extractTokens=(value,index)=>{for(const m of value.matchAll(token)){if(/[a-z][\w+.-]*:\/?$/i.test(value.slice(0,m.index)))continue;add(m[0],index+m.index,false);}};
 // Paired quotes only. Apostrophes inside English words are not delimiters.
 for(const m of text.matchAll(/(?<![\p{L}\p{N}_])(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/gu)){
  ranges.push([m.index,m.index+m[0].length]);const value=m[2].trim(),plain=extension.test(value)&&!command.test(value)&&!/[{}$;|<>]/.test(value)&&(!value.includes(':')||/^(?:[A-Za-z]:[\\/]|[a-z][\w+.-]*:\/\/)/i.test(value));
  if(plain)add(value,m.index+1,!markdown,true);else extractTokens(value,m.index+1);
 }
 // Unquoted paths in prose/commands are weak mentions, not verified sources.
 for(const m of text.matchAll(token))if(!ranges.some(([a,b])=>m.index>=a&&m.index<b))extractTokens(m[0],m.index);
 return[...out.values()].slice(0,120);
}

export async function buildProjectContext(work,job={}){
 const link=await getProjectLink(work),ids=identity(job),packet={version:1,status:link?.status||'unlinked',project:link?Object.fromEntries(Object.entries(link).filter(([k])=>k!=='assetLinks')):null,suggestion:null,task:{slot:job.slot||null,clip:shorten(job.clip,120),assetIdentities:ids},code:[],sources:[],history:[],references:[],scan:{visitedFiles:0,visitedDirectories:0,readFiles:0,hashedFiles:0,readBytes:0,hashedBytes:0,skippedFiles:0,truncated:false,limits:{...LIMITS}},budget:{maxCharacters:LIMITS.maxCharacters,usedCharacters:0,truncated:false},warnings:[]};
 if(!link){const root=await detectProjectRoot(work);packet.suggestion=root?{root,name:basename(root),reason:'nearest-project-marker'}:null;packet.budget.usedCharacters=JSON.stringify(packet).length;return packet;}
 if(!link.exists){packet.warnings.push('已关联的项目文件夹不存在；请重新选择或恢复项目位置。');packet.budget.usedCharacters=JSON.stringify(packet).length;return packet;}
 const root=link.root,workspace=await realpath(resolve(work)),index=new Map(),hashCache=new Map(),ranked=new Map(),anchors=new Map(),hashes=new Set(),names=new Set(),query=new Set(),refResults=new Set(),activeIds=ids.filter(a=>a.role==='source'),projectCharacterNames=new Set();let binaryHashes=0;
 const warn=s=>{if(packet.warnings.length<16&&!packet.warnings.includes(s))packet.warnings.push(shorten(s,260));};
 const excluded=path=>{if(path===workspace||inRoot(workspace,path)||path===ROOT||inRoot(ROOT,path))return true;const rel=slash(relative(root,path)),parts=rel.split('/');return parts.some(excludedName)||sensitive(path)||/^(?:AGENTS|SKILL|CLAUDE)\.md$/i.test(basename(path))||/^tools\/builda(?:\/|$)/.test(rel);};
 for(const a of activeIds){for(const h of[a.sha256,a.source?.sha256])if(/^[a-f0-9]{64}$/i.test(h||''))hashes.add(h.toLowerCase());for(const n of[a.label,a.source?.originalName])if(n){names.add(basename(n.replaceAll('\\','/')).toLowerCase());for(const t of tokens(basename(n)))query.add(t);}}
 const identityTerms=new Set(query);
 for(const t of tokens([job.request,job.preserve,job.context?.characterId,job.context?.characterName,job.target?.characterName].filter(Boolean).join(' ')))query.add(t);
 for(const t of tokens([job.context?.characterId,job.context?.characterName,job.target?.characterName].filter(Boolean).join(' ')))identityTerms.add(t);
 const initialJobSource=job.source||{};for(const h of[initialJobSource.sha256])if(/^[a-f0-9]{64}$/i.test(h||''))hashes.add(h.toLowerCase());if(initialJobSource.originalName){names.add(basename(initialJobSource.originalName).toLowerCase());for(const t of tokens(initialJobSource.originalName))query.add(t);}
 // Intake metadata is available before walking the project, so a generic
 // filename can still prioritize this character rather than global translations.
 for(const a of activeIds)if(a.file&&a.file.toLowerCase().endsWith('.glb')){try{const p=await inside(workspace,a.file),meta=await glbMetadata(p,LIMITS.maxGLBJsonBytes);if(meta){a.metadata=meta;for(const t of tokens([meta.characterName,...meta.names].join(' '))){if(query.size<70)query.add(t);identityTerms.add(t);}}}catch{warn('工作区GLB元信息不可读：'+shorten(a.file,160));}}
 const request=String(job.request||''),requested={audio:/音频|音效|音乐|声音|配音|台词|旁白|\b(?:audio|voice|sfx|music|sound)\b/i.test(request),locale:/翻译|多语言|本地化|字幕|\b(?:i18n|translat\w*|locale\w*)\b/i.test(request),art:/封面|插画|海报|立绘|肖像|界面|图标|书法|\b(?:ui|cover|illustrat\w*|portrait|uikit|thumbnail|calligraph\w*)\b/i.test(request)};
 const offDomain=path=>{const p=path.toLowerCase();return !requested.audio&&/(?:^|[\/_.-])(?:audio|voice|voices|sfx|music|sound|sounds)(?:[\/_.-]|$)/.test(p)||!requested.locale&&/(?:^|[\/_.-])(?:i18n|locale|locales|translation|translations)(?:[\/_.-]|$)/.test(p)||!requested.art&&/(?:^|[\/_.-])(?:ui|uikit|ui-kit|cover|covers|illus|illustration|illustrations|portrait|portraits|calligraphy|posters|thumbnails)(?:[\/_.-]|$)/.test(p);};
 const ownsIdentity=r=>[...identityTerms].some(t=>r.relativePath.toLowerCase().includes(t));
 const foreignCharacter=r=>{const p=r.relativePath.toLowerCase(),m=p.match(/(?:^|\/)(?:characters|heroes|actors)\/([^/]+)\//i);if(!identityTerms.size||ownsIdentity(r))return false;return Boolean(m&&!['pipeline','shared','common','sources','reference'].includes(m[1])||[...projectCharacterNames].some(name=>p.split(/[\/_.-]/).includes(name)));};
 const strong=r=>r.evidence.some(e=>['asset-sha256','asset-sha256-record','task-source-path','configured-source-map','asset-path-reference'].includes(e.kind));
 const is3D=r=>MODELS.has(r.ext)||['.gltf','.tres','.tscn'].includes(r.ext)||(r.refs||[]).some(ref=>/\.(?:glb|gltf|fbx|blend|bvh|abc|usd[ac]?|vrm|uasset)(?:[?#]|$)/i.test(ref.reference))||/(?:^|\/)(?:models|rigs|meshes|animations|motion|cloth|garments)(?:\/|[-_.])/.test(r.relativePath.toLowerCase())||/(?:^|\/)(?:characters|heroes|actors)\//.test(r.relativePath)&&/"(?:bones|joints|skeleton|skinJoints|morphTargets|animations|retarget|clips|tracks)"\s*:/.test(r.text||'');
 const relevant=r=>(!offDomain(r.relativePath)||strong(r)||is3D(r))&&(!foreignCharacter(r)||strong(r))&&(r.category!=='metadata'||is3D(r)||strong(r)||requested.audio||requested.art||requested.locale);
 const scorePath=path=>{const p=path.toLowerCase();let n=/^(src|scripts|characters|models|assets|public)\//.test(p)?12:0;if(/manifest|recipe|pipeline|motion-feedback|review|history/.test(p))n+=8;for(const q of query)if(p.includes(q))n+=12;for(const name of names)if(basename(p)===name)n+=40;return n-(offDomain(path)?150:0);};
 async function addFile(path){
  try{const real=await realpath(path);if(!inRoot(root,real)||excluded(real))return null;const rel=slash(relative(root,real));if(index.has(rel))return index.get(rel);if(index.size>=LIMITS.maxFiles){packet.scan.truncated=true;return null;}const s=await stat(real);if(!s.isFile())return null;const e=extname(rel).toLowerCase();if(!TEXT.has(e)&&!MODELS.has(e)){packet.scan.skippedFiles++;return null;}const r={relativePath:rel,path:real,bytes:s.size,ext:e,category:category(rel),score:0,evidence:[],confidence:'candidate'};index.set(rel,r);return r;}catch{return null;}
 }
 // Breadth first, with project source directories before recordings/caches.
 const queue=[{path:root,depth:0}];for(let q=0;q<queue.length;q++){
  if(packet.scan.visitedDirectories>=LIMITS.maxDirectories||packet.scan.visitedFiles>=LIMITS.maxFiles){packet.scan.truncated=true;break;}
  const dir=queue[q];packet.scan.visitedDirectories++;let entries;try{entries=await readdir(dir.path,{withFileTypes:true});}catch{continue;}
  if(dir.path!==root&&await exists(join(dir.path,'feedback.json'),'file')&&await exists(join(dir.path,'project.json'),'file'))continue;
  entries.sort((a,b)=>scorePath(slash(relative(root,join(dir.path,b.name))))-scorePath(slash(relative(root,join(dir.path,a.name))))||a.name.localeCompare(b.name));
  for(const e of entries){const path=join(dir.path,e.name);if(e.isSymbolicLink()||excluded(path)){packet.scan.skippedFiles++;continue;}if(e.isDirectory()){if(dir.depth<LIMITS.maxDepth)queue.push({path,depth:dir.depth+1});else packet.scan.truncated=true;}else if(e.isFile()){packet.scan.visitedFiles++;await addFile(path);if(packet.scan.visitedFiles>=LIMITS.maxFiles){packet.scan.truncated=true;break;}}}
 }
 for(const r of index.values()){const m=r.relativePath.match(/(?:^|\/)(?:characters|heroes|actors)\/([^/]+)\//i);if(m&&!['pipeline','shared','common','sources','reference'].includes(m[1].toLowerCase()))projectCharacterNames.add(m[1].toLowerCase());}
 async function hashFile(r){if(hashCache.has(r.path))return hashCache.get(r.path);if(r.bytes>LIMITS.maxHashFileBytes||packet.scan.hashedBytes+r.bytes>LIMITS.maxHashBytes){r.hashStatus='budget-limit';packet.scan.truncated=true;return null;}let fh;try{fh=await open(await inside(root,r.relativePath),'r');const before=await fh.stat();if(!before.isFile()||before.size!==r.bytes)return null;packet.scan.hashedBytes+=r.bytes;const h=createHash('sha256');let count=0;for await(const b of fh.createReadStream({autoClose:false})){count+=b.length;if(count>LIMITS.maxHashFileBytes)throw Error('file grew beyond hash budget');h.update(b);}const after=await fh.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs){r.hashStatus='changed-during-read';return null;}r.sha256=h.digest('hex');packet.scan.hashedFiles++;hashCache.set(r.path,r.sha256);return r.sha256;}catch{r.hashStatus='unavailable';return null;}finally{await fh?.close();}}
 function addEvidence(r,score,kind,detail,{line,linked=false,from}={}){if(!r)return;r.score=Math.max(r.score,score);if(linked&&!r.mismatch)r.confidence='linked';if(!r.evidence.some(e=>e.kind===kind&&e.detail===detail)&&r.evidence.length<8)r.evidence.push({kind,detail:shorten(detail,260),...(line?{line}:{}),...(from?{from}:{})});ranked.set(r.relativePath,r);}
 function recordRef(from,reference,status,why){const clean=reference.split(/[?#]/)[0].replaceAll('\\','/').replace(/^\.\//,''),key=clean+'|'+status;if(refResults.has(key)||packet.references.length>=24)return;refResults.add(key);packet.references.push({from:shorten(from,260),reference:shorten(clean,400),status,why});}
 async function resolveReference(raw,from='',report=false){
  if(typeof raw!=='string'||!raw.trim()||raw.length>2048)return null;const value=raw.trim().replaceAll('\\','/').split(/[?#]/)[0];if(sensitive(value))return null;
  if(/^[a-z][a-z0-9+.-]*:/i.test(value)&&!(/^[a-z]:\//i.test(value))){if(report)recordRef(from,raw,'external','外部引用仅记录，不读取。');return null;}
  const candidates=[];if(isAbsolute(value)){
   if(inRoot(root,resolve(value)))candidates.push(resolve(value));
   else if(from&&/^\/(?:models|assets|textures|images|audio|data)\//.test(value))candidates.push(resolve(root,'public',value.slice(1)),resolve(root,value.slice(1)));
   else{if(report)recordRef(from,raw,'external','制作源在关联项目之外，不自动读取。');return null;}
  }else candidates.push(resolve(root,value),resolve(root,dirname(from),value),resolve(root,'public',value));
  for(const p of [...new Set(candidates)]){
   if(!inRoot(root,p))continue;let real;try{real=await realpath(p);}catch{continue;}
   if(!inRoot(root,real)){if(report)recordRef(from,raw,'external','符号链接指向项目之外，未跟进。');return null;}if(excluded(real))return null;
   const r=await addFile(real);if(r)return r;
  }
  if(report)recordRef(from,raw,candidates.some(p=>!inRoot(root,p))?'external':'missing','未在关联项目的允许范围内找到该引用。');return null;
 }
 // Exact original project paths and hashes are stronger than names or keywords.
 for(const source of[initialJobSource,...activeIds.map(a=>a.source).filter(Boolean)])for(const key of['projectRelativePath','path','editablePath'])if(source[key]){const r=await resolveReference(source[key],'',true);if(r){const actual=await hashFile(r),expected=key!=='editablePath'&&/^[a-f0-9]{64}$/i.test(source.sha256||'')?source.sha256.toLowerCase():null;if(expected&&actual&&actual!==expected){r.mismatch=true;addEvidence(r,105,'source-hash-mismatch','任务来源路径存在，但其SHA-256与当前任务来源不同。');warn('任务来源文件已变化：'+r.relativePath);}else{addEvidence(r,105,'task-source-path','任务明确记录的项目内来源路径。',{linked:true});anchors.set(r.relativePath,r);}}}
 const modelCandidates=[...index.values()].filter(r=>MODELS.has(r.ext)).sort((a,b)=>scorePath(b.relativePath)-scorePath(a.relativePath)||a.bytes-b.bytes);
 for(const r of modelCandidates){if(binaryHashes>=LIMITS.maxBinaryHashes){packet.scan.truncated=true;break;}binaryHashes++;const h=await hashFile(r);if(hashes.has(h)){anchors.set(r.relativePath,r);addEvidence(r,120,'asset-sha256','文件SHA-256与任务资产一致：'+h,{linked:true});}else if(names.has(basename(r.relativePath).toLowerCase()))addEvidence(r,48,'original-name','原始文件名相同；尚未证明字节或制作链一致。');}
 const textRecords=[...index.values()].filter(r=>TEXT.has(r.ext)&&!MODELS.has(r.ext)).sort((a,b)=>scorePath(b.relativePath)-scorePath(a.relativePath)||a.relativePath.localeCompare(b.relativePath));
 for(const r of textRecords){if(r.bytes>LIMITS.maxTextFileBytes){packet.scan.skippedFiles++;continue;}if(packet.scan.readBytes+r.bytes>LIMITS.maxTextBytes){packet.scan.truncated=true;break;}try{const b=await readFile(await inside(root,r.relativePath));if(b.length>LIMITS.maxTextFileBytes||b.includes(0)){packet.scan.skippedFiles++;continue;}r.text=b.toString('utf8');r.lines=r.text.split(/\r?\n/);r.refs=references(r.text,r.relativePath);r.sha256=digest(b);hashCache.set(r.path,r.sha256);packet.scan.readBytes+=b.length;packet.scan.readFiles++;}catch{}}
 for(const r of textRecords){if(!r.text)continue;const lower=r.text.toLowerCase();for(const h of hashes)if(lower.includes(h))addEvidence(r,115,'asset-sha256-record','文本记录了任务资产SHA-256：'+h,{line:r.lines.findIndex(l=>l.toLowerCase().includes(h))+1,linked:true});
  for(const name of names)if(lower.includes(name))addEvidence(r,52,'original-name-reference','提到原始文件名 '+name+'；文件名关系需要核对。',{line:r.lines.findIndex(l=>l.toLowerCase().includes(name))+1});
  const matches=[...query].filter(q=>lower.includes(q)||r.relativePath.toLowerCase().includes(q));if(matches.length)addEvidence(r,Math.min(42,12+matches.length*5)+(r.category==='history'&&/feedback|review|decision/i.test(r.relativePath)?4:0),'keyword','候选关键词：'+matches.slice(0,6).join('、'),{line:r.lines.findIndex(l=>matches.some(q=>l.toLowerCase().includes(q)))+1});
  for(const ref of r.refs||[]){const raw=ref.reference.split(/[?#]/)[0],paths=[resolve(root,raw.replace(/^\//,'')),resolve(root,'public',raw.replace(/^\//,'')),resolve(dirname(r.path),raw)];const a=[...anchors.values()].find(a=>paths.includes(a.path));if(a)addEvidence(r,ref.literal?100:58,ref.literal?'asset-path-reference':'path-mention',(ref.literal?'明确引用已核对资产 ':'文档或命令提及路径，尚未确认来源关系：')+a.relativePath,{line:ref.line,linked:ref.literal});}
 }
 // Explicit optional JSON mappings are scoped to this project. Name-only
 // selectors deliberately remain candidates, including duplicate basenames.
 for(const mapping of link.assetLinks){const selectedHash=mapping.asset.sha256&&hashes.has(mapping.asset.sha256),selectedName=mapping.asset.originalName&&names.has(basename(mapping.asset.originalName).toLowerCase()),selectedPath=mapping.asset.path&&anchors.has(slash(mapping.asset.path));if(!selectedHash&&!selectedName&&!selectedPath)continue;
  for(const kind of['code','sources','history'])for(const p of mapping[kind]){const r=await resolveReference(p,'project-link.json',true);if(r){r.category=kind;addEvidence(r,118,'configured-source-map',selectedHash||selectedPath?'显式项目映射匹配当前资产身份。':'显式映射仅匹配文件名，仍需确认当前资产。',{linked:Boolean(selectedHash||selectedPath),from:'project-link.json'});}}
 }
 // Read only a few lines of the ranked documents into the final packet, but
 // follow their literal source/manifest references to the actual authoring files.
 for(let depth=0;depth<2;depth++){
  const parents=[...ranked.values()].filter(r=>r.text&&relevant(r)&&(r.score>=48||r.confidence==='linked'||ownsIdentity(r)&&is3D(r))).sort((a,b)=>b.score-a.score+(ownsIdentity(b)?50:0)-(ownsIdentity(a)?50:0)).slice(0,28);
  for(const parent of parents){
   if(parent.ext==='.json'){try{const doc=JSON.parse(parent.text),declared=[];const visit=(v,n=0)=>{if(n>16||!v||typeof v!=='object')return;if(!Array.isArray(v)){const p=v.path||v.file||v.url;if(typeof p==='string'&&/^[a-f0-9]{64}$/i.test(v.sha256||''))declared.push({path:p,sha256:v.sha256.toLowerCase()});}for(const c of Object.values(v))if(c&&typeof c==='object')visit(c,n+1);};visit(doc);for(const d of declared.slice(0,64)){const target=await resolveReference(d.path,parent.relativePath);if(target&&anchors.has(target.relativePath)){const actual=await hashFile(target);if(actual&&actual!==d.sha256){parent.confidence='candidate';parent.mismatch=true;addEvidence(parent,parent.score,'manifest-hash-mismatch','清单记录SHA '+d.sha256+' 与当前文件 '+actual+' 不同；不能据此确认当前制作链。',{line:parent.lines.findIndex(l=>l.includes(d.sha256))+1});warn('制作清单哈希与当前文件不同：'+parent.relativePath+' → '+target.relativePath);}}}}catch{}}
   for(const ref of(parent.refs||[]).slice(0,45)){const r=await resolveReference(ref.reference,parent.relativePath,ref.reportMissing);if(!r||r===parent)continue;const confirmed=parent.confidence==='linked'&&ref.literal;addEvidence(r,confirmed?90:58,ref.literal?'manifest-reference':'path-mention','由 '+parent.relativePath+(ref.literal?' 的明确路径引用定位。':' 的路径提及定位；仅作候选。'),{line:ref.line,from:parent.relativePath,linked:confirmed});}
  }
 }
 async function item(r){if(!r.sha256)await hashFile(r);let metadata;if(r.ext==='.glb')metadata=await glbMetadata(r.path,LIMITS.maxGLBJsonBytes);const evidence=r.evidence.slice(0,4),excerpts=[];if(r.lines){const chosen=[...new Set(evidence.filter(e=>e.line&&!e.from).map(e=>e.line))].slice(0,2);for(const line of chosen){const start=Math.max(1,line-1),end=Math.min(r.lines.length,line+1);excerpts.push({startLine:start,endLine:end,text:r.lines.slice(start-1,end).map(safeExcerpt).join('\n')});}}return{relativePath:r.relativePath,sha256:r.sha256||null,bytes:r.bytes,confidence:r.confidence,why:evidence.map(e=>e.detail).slice(0,2).join(' '),evidence,excerpts,...(metadata?{metadata}:{}),...(!r.sha256?{hashStatus:r.hashStatus||'unavailable'}:{})};}
 for(const r of ranked.values())if(r.category==='metadata')r.category=is3D(r)||r.evidence.some(e=>e.kind==='configured-source-map')?'sources':'history';
 const priority=r=>r.score+(ownsIdentity(r)?65:0)+(r.category==='code'&&/^(?:src|Source|Assets\/Scripts)\//.test(r.relativePath)?50:0)-(offDomain(r.relativePath)?120:0);
 const groups=Object.fromEntries(['code','sources','history'].map(k=>[k,[...ranked.values()].filter(r=>r.category===k&&r.score>0&&relevant(r)&&(k!=='sources'||is3D(r)||r.evidence.some(e=>e.kind==='configured-source-map'))).sort((a,b)=>priority(b)-priority(a)||a.relativePath.localeCompare(b.relativePath))]));
 const sequence=[];for(let i=0;i<12;i++)for(const kind of['sources','code','history'])if(i<({sources:12,code:12,history:6})[kind]&&groups[kind][i])sequence.push({kind,r:groups[kind][i]});
 if(packet.scan.truncated)warn('项目索引触及扫描、读取或哈希上限；未检索到不代表项目中不存在。');
 if(!ranked.size)warn('没有找到可追溯的项目材料；请核对项目选择，或在 project-link.json 添加 assetLinks。');
 for(const {kind,r}of sequence){const value=await item(r);packet[kind].push(value);if(JSON.stringify(packet).length>LIMITS.maxCharacters-100){packet[kind].pop();packet.budget.truncated=true;}}
 // Also bound pathological identity metadata and external-reference lists,
 // rather than merely bounding each retrieved excerpt independently.
 while(JSON.stringify(packet).length>LIMITS.maxCharacters-100){packet.budget.truncated=true;const group=['history','code','sources'].find(k=>packet[k].length);if(group)packet[group].pop();else if(packet.references.length)packet.references.pop();else{const a=ids.find(a=>a.metadata);if(a)delete a.metadata;else if(ids.length)ids.pop();else break;}}
 packet.budget.usedCharacters=JSON.stringify(packet).length;packet.budget.usedCharacters=JSON.stringify(packet).length;return packet;
}
