// Local/CI acceptance page only; never shipped in the installed Skill.
import {createServer} from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,extname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.json':'application/json','.wasm':'application/wasm','.glb':'model/gltf-binary'};
export async function serveRealAssets({skillRoot,samples,port=0}){
 const skill=await realpath(resolve(skillRoot)),sampleRoot=await realpath(resolve(samples)),lock=JSON.parse(await readFile(new URL('./samples.lock.json',import.meta.url))),bySHA=new Map(lock.cases.map(c=>[c.sha256,c]));
 const server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://localhost').pathname;let file;
  if(path==='/samples.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(lock.cases));}
  if(path==='/'||path==='/acceptance.mjs')file=new URL(path==='/'?'./index.html':'./acceptance.mjs',import.meta.url);
  else if(path.startsWith('/vendor/')||path.startsWith('/viewer/')){file=resolve(skill,'assets','.'+path);const rel=relative(resolve(skill,'assets'),file);if(rel.startsWith('..'+sep)||rel==='..')throw Error('Path outside test root');}
  else{const m=/^\/workspace\/assets\/([a-f0-9]{64})\.glb$/.exec(path),c=m&&bySHA.get(m[1]);if(!c){res.writeHead(404);return res.end('Not found');}file=resolve(sampleRoot,c.file);}
  const bytes=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file instanceof URL?file.pathname:file)]||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);
 }catch(error){res.writeHead(500);res.end(error.message);}});
 await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
 const server=await serveRealAssets({skillRoot:option('skill-root','skill'),samples:option('samples','qa/real-assets-20261104/samples'),port:Number(option('port','57267'))});console.log('Real sample acceptance: http://127.0.0.1:'+server.address().port);
}
