import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {defaultWorkspace,DEFAULT_WORKSPACE_NAME,LEGACY_WORKSPACE_NAME} from '../default-workspace.mjs';

async function home(fn){const base=await mkdtemp(join(tmpdir(),'motion-home-'));try{await fn(base);}finally{await rm(base,{recursive:true,force:true});}}
const workspace=async(base,name)=>{await mkdir(join(base,name),{recursive:true});await writeFile(join(base,name,'project.json'),'{}');};

test('a fresh home uses the MotionStage practice workspace',()=>home(async base=>{
 assert.equal(defaultWorkspace(base),join(base,DEFAULT_WORKSPACE_NAME));
}));

test('an existing pre-rename practice workspace keeps opening',()=>home(async base=>{
 await workspace(base,LEGACY_WORKSPACE_NAME);
 assert.equal(defaultWorkspace(base),join(base,LEGACY_WORKSPACE_NAME));
}));

test('the new workspace wins once it exists, and an empty legacy folder is ignored',()=>home(async base=>{
 await mkdir(join(base,LEGACY_WORKSPACE_NAME));
 assert.equal(defaultWorkspace(base),join(base,DEFAULT_WORKSPACE_NAME));
 await workspace(base,LEGACY_WORKSPACE_NAME);await workspace(base,DEFAULT_WORKSPACE_NAME);
 assert.equal(defaultWorkspace(base),join(base,DEFAULT_WORKSPACE_NAME));
}));
