import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,utimes,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPreviewIndex} from '../project-preview-index.mjs';

async function fixture(run){const dir=await mkdtemp(join(tmpdir(),'motion-preview-cache-'));try{await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('preview reuses unchanged evidence and detects same-size edits even with restored mtime',()=>fixture(async dir=>{
 const file=join(dir,'source.txt'),cache=createPreviewIndex();await writeFile(file,'first');let reads=0;
 const get=()=>cache.read('text',file,async()=>{reads++;return readFile(file);});
 assert.equal((await get()).hit,false);assert.equal((await get()).hit,true);assert.equal(reads,1);
 const before=await stat(file);await writeFile(file,'other');await utimes(file,before.atime,before.mtime);
 const changed=await get();assert.equal(changed.hit,false);assert.equal(changed.value.toString(),'other');
 await rm(file);await assert.rejects(get(),{code:'ENOENT'});assert.equal(cache.size,0);
}));
test('directory membership changes invalidate preview listings',()=>fixture(async dir=>{
 const cache=createPreviewIndex(),get=()=>cache.read('directory',dir,()=>readdir(dir));
 assert.deepEqual((await get()).value,[]);assert.equal((await get()).hit,true);
 await mkdir(join(dir,'new-authoring'));assert.deepEqual((await get()).value,['new-authoring']);
}));
test('changing evidence during load is rejected, with bounded cache eviction',()=>fixture(async dir=>{
 const file=join(dir,'source'),cache=createPreviewIndex({maxEntries:1,maxBytes:4});await writeFile(file,'one');
 await assert.rejects(cache.read('text',file,async()=>{const old=await readFile(file);await writeFile(file,'changed');return old;}),/读取期间/);
 assert.equal(cache.size,0);
 const a=join(dir,'a'),b=join(dir,'b');await writeFile(a,'aaa');await writeFile(b,'bbb');
 const read=path=>cache.read('text',path,()=>readFile(path));await read(a);await read(b);assert.equal(cache.size,1);assert.equal(cache.bytes,3);assert.equal((await read(a)).hit,false);
}));
