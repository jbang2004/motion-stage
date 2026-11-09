// Share downloads only while they are pending. Each slot still parses its own
// scene, and loadPair owns the view ticket, commit and disposal transaction.
export function createAssetLoader({fetchImpl=globalThis.fetch,subtle=globalThis.crypto?.subtle}={}){
 const inFlight=new Map(),retryUncached=new Set();
 return async function loadAsset(meta,loader){
  const {sha256,file,bytes:expectedBytes}=meta||{};
  if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||file!=='assets/'+sha256+'.glb')throw Error('模型版本记录无效，无法确认要下载的文件。');
  if(expectedBytes!==undefined&&(!Number.isSafeInteger(expectedBytes)||expectedBytes<20))throw Error('模型版本记录中的文件字节数无效。');
  if(typeof fetchImpl!=='function'||typeof subtle?.digest!=='function')throw Error('此浏览器无法完整下载并校验模型，请使用支持 Web Crypto 的浏览器。');
  let pending=inFlight.get(sha256);
  if(!pending){
   pending=(async()=>{
    const response=await fetchImpl('/workspace/'+file,retryUncached.has(sha256)?{cache:'reload'}:undefined);
    if(!response.ok)throw Error('模型下载失败（HTTP '+response.status+'）。');
    let bytes;try{bytes=await response.arrayBuffer();}catch(error){throw Error('模型下载未完成：'+error.message,{cause:error});}
    if(!(bytes instanceof ArrayBuffer)||bytes.byteLength<20)throw Error('模型下载不完整：缺少 GLB 文件头。');
    const header=new DataView(bytes);
    if(header.getUint32(0,true)!==0x46546c67||header.getUint32(4,true)!==2)throw Error('模型文件头无效，需要 glTF 2.0 GLB 文件。');
    if(header.getUint32(8,true)!==bytes.byteLength)throw Error('模型下载不完整：GLB 声明长度与实际字节数不一致。');
    const digest=await subtle.digest('SHA-256',bytes),actual=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(actual!==sha256)throw Error('模型 SHA-256 校验失败，下载的内容与此版本记录不一致。');
    retryUncached.delete(sha256);
    return bytes;
   })().catch(error=>{
    // A malformed immutable HTTP response may already be in the browser cache.
    retryUncached.add(sha256);
    if(retryUncached.size>32)retryUncached.delete(retryUncached.values().next().value);
    throw error;
   });
   inFlight.set(sha256,pending);
   const release=()=>{if(inFlight.get(sha256)===pending)inFlight.delete(sha256);};
   pending.then(release,release);
  }
  const bytes=await pending;
  // A caller with an inconsistent record must fail even if another slot with
  // the same SHA already started the shared download using valid metadata.
  if(expectedBytes!==undefined&&bytes.byteLength!==expectedBytes)throw Error('模型下载不完整：版本记录的字节数与实际文件不一致。');
  return loader.parseAsync(bytes,'/workspace/assets/');
 };
}
