// Browser-rendered preview images (character portraits, action key poses).
// They are a regenerable cache: keys are content-derived by the viewer, the
// folder lives under the workspace's git-ignored cache/, and deleting it is
// always safe.
import {readdir,mkdir,unlink} from 'node:fs/promises';
import {inside,atomic} from './core.mjs';

export const THUMBNAIL_DIR='cache/thumbnails';
const KEY=/^[a-z0-9][a-z0-9-]{7,95}$/;
const MAX_BYTES=1024*1024;
const TYPES={png:'89504e470d0a1a0a',webp:'52494646'};

function imageType(bytes){
 if(bytes.subarray(0,8).toString('hex')===TYPES.png)return 'png';
 if(bytes.subarray(0,4).toString('hex')===TYPES.webp&&bytes.subarray(8,12).toString('latin1')==='WEBP')return 'webp';
 return null;
}

export function validThumbnailKey(key){return typeof key==='string'&&KEY.test(key);}

export async function listThumbnails(work){
 let names=[];
 try{names=await readdir(await inside(work,THUMBNAIL_DIR));}catch(error){if(error.code!=='ENOENT')throw error;}
 const files={};
 for(const name of names){const match=name.match(/^([a-z0-9][a-z0-9-]{7,95})\.(png|webp)$/);if(match)files[match[1]]='/workspace/thumbnails/'+name;}
 return {files,count:Object.keys(files).length};
}

export async function saveThumbnail(work,key,bytes){
 if(!validThumbnailKey(key))throw Error('缩略图标识无效');
 if(!bytes?.length||bytes.length>MAX_BYTES)throw Error('缩略图需要小于 1 MB');
 const type=imageType(bytes);if(!type)throw Error('缩略图需要 PNG 或 WebP');
 const dir=await inside(work,THUMBNAIL_DIR);await mkdir(dir,{recursive:true});
 const other=type==='png'?'webp':'png';
 try{await unlink(await inside(work,THUMBNAIL_DIR+'/'+key+'.'+other));}catch(error){if(error.code!=='ENOENT')throw error;}
 const file=THUMBNAIL_DIR+'/'+key+'.'+type;await atomic(await inside(work,file),bytes);
 return {key,url:'/workspace/thumbnails/'+key+'.'+type};
}

// Static route helper: /workspace/thumbnails/<key>.<png|webp> -> workspace path.
export function thumbnailPath(pathname){
 const match=pathname.match(/^\/workspace\/thumbnails\/([a-z0-9][a-z0-9-]{7,95}\.(?:png|webp))$/);
 return match?THUMBNAIL_DIR+'/'+match[1]:null;
}
