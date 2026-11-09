import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createAssetLoader} from '../../assets/viewer/asset-loader.mjs';

const demo=await readFile(new URL('../../assets/demo/baseline.glb',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const metadata=(bytes=demo)=>{const sha256=hash(bytes);return {sha256,file:'assets/'+sha256+'.glb',bytes:bytes.length};};
const arrayBuffer=bytes=>Uint8Array.from(bytes).buffer;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const fakeResponse=bytes=>({ok:true,status:200,arrayBuffer:async()=>arrayBuffer(bytes)});
const mustNotParse={parseAsync:()=>assert.fail('Unverified bytes must never reach GLTFLoader')};
async function httpFixture(handler,run){
 const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await run('http://127.0.0.1:'+server.address().port);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

test('actual native HTTP bytes are verified and the same ArrayBuffer reaches the configured parser with the asset resource path',()=>httpFixture((request,response)=>{
 assert.equal(request.url,'/workspace/'+metadata().file);response.writeHead(200,{'Content-Length':demo.length});response.end(demo);
},async base=>{
 let downloaded;const parsed={scene:'independently parsed scene'},load=createAssetLoader({fetchImpl:async url=>{
  const response=await fetch(base+url);return {ok:response.ok,status:response.status,arrayBuffer:async()=>{downloaded=await response.arrayBuffer();return downloaded;}};
 }});
 const result=await load(metadata(),{parseAsync:async(bytes,path)=>{assert.equal(bytes,downloaded);assert.equal(path,'/workspace/assets/');assert.equal(hash(new Uint8Array(bytes)),hash(demo));assert.deepEqual(Buffer.from(bytes),demo);return parsed;}});
 assert.equal(result,parsed);
}));

test('HTTP errors fail clearly before parsing',()=>httpFixture((request,response)=>{response.writeHead(503);response.end('unavailable');},async base=>{
 const load=createAssetLoader({fetchImpl:url=>fetch(base+url)});await assert.rejects(load(metadata(),mustNotParse),/HTTP 503/);
}));

test('an actual truncated HTTP body fails without parsing',()=>httpFixture((request,response)=>{
 response.writeHead(200,{'Content-Length':demo.length,'Connection':'close'});response.end(demo.subarray(0,200));
},async base=>{
 const load=createAssetLoader({fetchImpl:url=>fetch(base+url)});await assert.rejects(load(metadata(),mustNotParse),/模型下载未完成/);
}));

test('a completed HTTP body with a truncated GLB declaration is rejected',()=>httpFixture((request,response)=>{response.end(demo.subarray(0,demo.length-4));},async base=>{
 const load=createAssetLoader({fetchImpl:url=>fetch(base+url)});await assert.rejects(load(metadata(),mustNotParse),/GLB 声明长度/);
}));

test('complete equal-length bytes with the wrong SHA are rejected before parsing',()=>httpFixture((request,response)=>{
 const wrong=Buffer.from(demo);wrong[wrong.length-1]^=1;response.end(wrong);
},async base=>{
 const load=createAssetLoader({fetchImpl:url=>fetch(base+url)});await assert.rejects(load(metadata(),mustNotParse),/SHA-256 校验失败/);
}));

test('GLB magic, version and minimum header are validated even when the recorded SHA matches',async()=>{
 for(const [kind,message]of [['magic',/文件头无效/],['version',/文件头无效/],['short',/缺少 GLB 文件头/]]){
  const invalid=kind==='short'?demo.subarray(0,12):Buffer.from(demo);if(kind==='magic')invalid.writeUInt32LE(0,0);if(kind==='version')invalid.writeUInt32LE(1,4);
  const meta=metadata(invalid);delete meta.bytes;const load=createAssetLoader({fetchImpl:async()=>fakeResponse(invalid)});
  await assert.rejects(load(meta,mustNotParse),message,kind);
 }
});

test('concurrent slots with the same SHA share one pending download and parse independent scenes',async()=>{
 const ready=deferred();let downloads=0,parses=0;const load=createAssetLoader({fetchImpl:()=>{downloads++;return ready.promise;}}),seen=[];
 const parser={parseAsync:async(bytes,path)=>{seen.push(bytes);assert.equal(path,'/workspace/assets/');return {scene:++parses};}};
 const first=load({...metadata(),assetId:'A'},parser),second=load({...metadata(),assetId:'B'},parser);assert.equal(downloads,1);ready.resolve(fakeResponse(demo));
 const pair=await Promise.all([first,second]);assert.equal(downloads,1);assert.equal(parses,2);assert.notEqual(pair[0],pair[1]);assert.equal(seen[0],seen[1]);
 // A settled download is not a permanent buffer cache, including while its
 // parsed scenes remain live in their respective views.
 await load(metadata(),parser);assert.equal(downloads,2);
});

test('each concurrent caller validates its own optional byte count',async()=>{
 const ready=deferred();let downloads=0,parses=0;const load=createAssetLoader({fetchImpl:()=>{downloads++;return ready.promise;}}),parser={parseAsync:async()=>++parses};
 const valid=load(metadata(),parser),invalid=load({...metadata(),bytes:demo.length+4},mustNotParse);ready.resolve(fakeResponse(demo));
 assert.equal(await valid,1);await assert.rejects(invalid,/版本记录的字节数/);assert.equal(downloads,1);assert.equal(parses,1);
 const withoutCount=metadata();delete withoutCount.bytes;assert.equal(await load(withoutCount,parser),2);
});

test('failed shared downloads are released so a later attempt actually retries',async()=>{
 const failed=deferred();let downloads=0;const load=createAssetLoader({fetchImpl:()=>++downloads===1?failed.promise:Promise.resolve(fakeResponse(demo))});
 const a=load(metadata(),mustNotParse),b=load(metadata(),mustNotParse),settled=Promise.allSettled([a,b]);assert.equal(downloads,1);failed.reject(Error('connection lost'));
 assert.ok((await settled).every(result=>result.status==='rejected'&&result.reason.message==='connection lost'));
 assert.equal(await load(metadata(),{parseAsync:async()=> 'retried'}),'retried');assert.equal(downloads,2);
});

test('a SHA verification failure and a parser rejection also allow a fresh download',async()=>{
 const wrong=Buffer.from(demo);wrong[wrong.length-1]^=1;
 const cacheModes=[],load=createAssetLoader({fetchImpl:async(_url,options)=>{cacheModes.push(options?.cache);return fakeResponse(cacheModes.length===1?wrong:demo);}});
 await assert.rejects(load(metadata(),mustNotParse),/SHA-256/);
 await assert.rejects(load(metadata(),{parseAsync:async()=>{throw Error('unsupported extension');}}),/unsupported extension/);
 assert.equal(await load(metadata(),{parseAsync:async()=> 'fresh scene'}),'fresh scene');
 assert.deepEqual(cacheModes,[undefined,'reload',undefined]);
});

test('invalid identity, byte count and unavailable Web Crypto fail before network or parser work',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return fakeResponse(demo);},load=createAssetLoader({fetchImpl});
 for(const meta of [{...metadata(),sha256:'invalid'},{...metadata(),file:'../source.glb'},{...metadata(),bytes:-1},{...metadata(),bytes:NaN},{...metadata(),bytes:null}])await assert.rejects(load(meta,mustNotParse),/版本记录/);
 await assert.rejects(createAssetLoader({fetchImpl,subtle:null})(metadata(),mustNotParse),/Web Crypto/);assert.equal(calls,0);
 // Explicit WebCrypto injection exercises the same browser API contract.
 assert.equal(await createAssetLoader({fetchImpl,subtle:webcrypto.subtle})(metadata(),{parseAsync:async()=>true}),true);
});
