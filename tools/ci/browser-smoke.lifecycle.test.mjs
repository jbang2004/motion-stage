import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {join} from 'node:path';

const source=await readFile(new URL('./browser-smoke.mjs',import.meta.url),'utf8');
const between=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);};
const boundedSource=between('const bounded=','\nlet progressWrites=');
const operationSource=between('const operation=','\n// A timed-out Playwright');
const checkSource=between('const check=','\ntry{');
function harness(){
 const report={checks:[],operations:[]},snapshots=[],logs=[];
 const ctx=vm.createContext({report,setTimeout,clearTimeout,Date,console:{log:message=>logs.push(message)},progress:async()=>snapshots.push(structuredClone(report))});
 vm.runInContext(boundedSource+operationSource+checkSource+'\nthis.api={bounded,operation,check};',ctx);
 return {...ctx.api,report,snapshots,logs};
}

test('the production outer timeout rejects a never-settling browser operation and records its exact phase',async()=>{
 const h=harness();await assert.rejects(h.operation('stuck readPixels',()=>new Promise(()=>{}),10),/stuck readPixels timed out after 10 ms/);
 assert.equal(h.snapshots[0].operations[0].status,'RUNNING');assert.equal(h.report.operations[0].status,'FAIL');assert.ok(h.report.operations[0].elapsedMs>=8);assert.match(h.logs[0],/START stuck readPixels/);assert.match(h.logs.at(-1),/FAIL stuck readPixels/);
});

test('production check progress is written before completion and retains the original functional failure',async()=>{
 const h=harness(),error=Error('search did not show the requested model');
 await assert.rejects(h.check('directory search',async()=>{assert.equal(h.snapshots[0].checks[0].status,'RUNNING');throw error;}),value=>value===error);
 assert.equal(h.report.checks[0].status,'FAIL');assert.match(h.report.checks[0].error,/search did not show/);assert.equal(h.snapshots.at(-1).checks[0].status,'FAIL');assert.match(h.logs.at(-1),/CHECK FAIL directory search/);
});

test('successful production operations return their real value and record completion',async()=>{
 const h=harness(),value={actualBytes:67932};assert.equal(await h.operation('read verified bytes',async()=>value,100),value);assert.equal(h.report.operations[0].status,'PASS');assert.equal(h.snapshots.at(-1).operations[0].status,'PASS');
});

function artifactHarness(fail){
 const report={verdict:'PASS'},writes=[],files=new Map();
 const ctx=vm.createContext({report,setTimeout,clearTimeout,Date,join,output:'artifacts',console:{error:()=>{}},
  writeFile:async(path,bytes)=>{writes.push({path,bytes});if(fail?.(path,writes))throw Error('injected artifact write failure');files.set(path,bytes);},
  rename:async(from,to)=>{files.set(to,files.get(from));files.delete(from);}});
 vm.runInContext(boundedSource+between('let progressWrites=','\n// Publish the authoritative')+between('const finalizeArtifacts=','\nconst operation=')+'\nthis.api={progress,finalizeArtifacts};',ctx);
 return {...ctx.api,report,writes,files,result:()=>JSON.parse(files.get(join('artifacts','browser-smoke-result.json')))};
}

test('a first progress failure during final publication saves FAIL instead of PASS',async()=>{
 let failed=false;const h=artifactHarness(path=>{if(path.endsWith('browser-smoke-progress.json.tmp')&&!failed){failed=true;return true;}return false;});
 await h.finalizeArtifacts();assert.equal(h.report.verdict,'FAIL');assert.equal(h.result().verdict,'FAIL');assert.equal(h.result().progressErrors.length,1);
});

test('supporting artifact failure cannot leave a saved passing verdict',async()=>{
 const h=artifactHarness(path=>path.endsWith('browser-console.json'));await h.finalizeArtifacts();
 assert.equal(h.report.verdict,'FAIL');assert.equal(h.result().verdict,'FAIL');assert.match(h.result().artifactWriteError,/injected artifact/);
 assert.ok(h.writes.filter(row=>row.path.endsWith('browser-smoke-result.json')).every(row=>JSON.parse(row.bytes).verdict==='FAIL'));
});

test('final result is published after its evidence and a failed first result write is retried as FAIL',async()=>{
 const good=artifactHarness();await good.finalizeArtifacts();assert.equal(good.result().verdict,'PASS');assert.ok(good.writes.at(-1).path.endsWith('browser-smoke-result.json'));
 let failed=false;const h=artifactHarness(path=>{if(path.endsWith('browser-smoke-result.json')&&!failed){failed=true;return true;}return false;});
 await h.finalizeArtifacts();assert.equal(h.report.verdict,'FAIL');assert.equal(h.result().verdict,'FAIL');assert.match(h.result().artifactWriteError,/injected artifact/);
});
