import {stat} from 'node:fs/promises';

// Query-independent preview evidence. Every reuse rechecks a high-resolution
// filesystem identity; task freezing and completion never use this cache.
// Keep only bounded, process-local evidence, not authoritative project state.
export function createPreviewIndex({maxEntries=12000,maxBytes=32*1024*1024}={}) {
 const entries=new Map();let bytes=0;
 const signature=s=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':');
 const remove=key=>{const entry=entries.get(key);if(entry){bytes-=entry.bytes;entries.delete(key);}};
 return {
  async read(kind,path,load,{size=value=>Buffer.isBuffer(value)?value.length:Array.isArray(value)?value.reduce((n,item)=>n+128+String(item.name??item).length*2,0):128}={}) {
   const key=kind+'\0'+path;
   let before;
   try{before=await stat(path,{bigint:true});}catch(error){remove(key);throw error;}
   const identity=signature(before),previous=entries.get(key);
   if(previous?.identity===identity){entries.delete(key);entries.set(key,previous);return {value:previous.value,hit:true};}
   remove(key);
   const value=await load(),after=await stat(path,{bigint:true});
   if(signature(after)!==identity)throw Error('项目文件在读取期间发生变化，请重新整理资料');
   const weight=Math.max(0,size(value));
   if(weight<=maxBytes){
    while(entries.size&&(entries.size>=maxEntries||bytes+weight>maxBytes))remove(entries.keys().next().value);
    entries.set(key,{identity,value,bytes:weight});bytes+=weight;
   }
   return {value,hit:false};
  },
  clear(){entries.clear();bytes=0;},
  get size(){return entries.size;},
  get bytes(){return bytes;},
 };
}
export const projectPreviewIndex=createPreviewIndex();
