import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalogRequests,createModelCatalog} from '../../assets/viewer/model-catalog.mjs';
import {createCatalogDocument} from './viewer-dom-fixture.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const page=(entries,extra={})=>({entries,hasMore:true,linked:false,scan:{state:'complete'},...extra});
function harness(initial){
 const calls=[],commits=[];let displayed=initial,displayedQuery='';
 const requests=createCatalogRequests({fetchPage:args=>{const response=deferred();calls.push({...args,...response});return response.promise;},readCatalog:query=>query===displayedQuery?displayed:null,commit:(data,ticket)=>{displayed=data;displayedQuery=ticket.query;commits.push({data,query:ticket.query});}});
 return {requests,calls,commits,get displayed(){return displayed;}};
}

test('many polling periods reuse one slow flight and its eventual response is committed rather than starved',async()=>{
 const h=harness(),first=h.requests.request();for(let tick=0;tick<50;tick++)assert.equal(h.requests.request(),first);
 assert.equal(h.calls.length,1);h.calls[0].resolve(page(['slow but current']));assert.equal((await first).data.entries[0],'slow but current');assert.equal(h.commits.length,1);
 const next=h.requests.request();assert.equal(h.calls.length,2);h.calls[1].resolve(page(['next snapshot']));await next;assert.deepEqual(h.displayed.entries,['next snapshot']);
});

test('only the latest query is queued while an obsolete request completes, without aborting it',async()=>{
 const h=harness();h.requests.setQuery('A');const a=h.requests.request();h.requests.setQuery('B');const b=h.requests.request();h.requests.setQuery('C');const c=h.requests.request();
 assert.equal(await b,null);assert.equal(h.calls.length,1);h.calls[0].resolve(page(['obsolete A']));assert.equal(await a,null);assert.equal(h.commits.length,0);assert.equal(h.calls.length,2);assert.equal(h.calls[1].query,'C');
 h.calls[1].resolve(page(['current C']));await c;assert.deepEqual(h.commits.map(x=>x.query),['C']);
});

test('search ABA retires the first A response immediately, before the debounced replacement request exists',async()=>{
 const h=harness();h.requests.setQuery('A');const old=h.requests.request();h.requests.setQuery('B');h.requests.setQuery('A');
 h.calls[0].resolve(page(['first A must not display']));assert.equal(await old,null);assert.equal(h.commits.length,0);assert.equal(h.calls.length,1);
 const current=h.requests.request();h.calls[1].resolve(page(['new A']));await current;assert.deepEqual(h.displayed.entries,['new A']);
});

test('load-more waits for a refresh, recomputes its offset, and survives coalesced polling',async()=>{
 const h=harness(page(['old 0','old 1'])),refresh=h.requests.request(),more=h.requests.request({more:true});
 assert.equal(h.requests.request({more:true}),more);for(let tick=0;tick<20;tick++)assert.equal(h.requests.request(),refresh);assert.equal(h.calls.length,1);
 h.calls[0].resolve(page(['fresh 0','fresh 1','fresh 2']));await refresh;assert.equal(h.calls.length,2);assert.equal(h.calls[1].offset,3);assert.equal(h.calls[1].limit,100);
 for(let tick=0;tick<20;tick++){assert.equal(h.requests.request(),more);assert.equal(h.requests.request({more:true}),more);}
 h.calls[1].resolve(page(['next 3','next 4'],{hasMore:false}));await more;assert.deepEqual(h.displayed.entries,['fresh 0','fresh 1','fresh 2','next 3','next 4']);assert.equal(h.displayed.hasMore,false);assert.equal(h.calls.length,2);
});

test('query changes retire a pending more intent and never append old-query entries to new-query results',async()=>{
 const h=harness(page(['old base'])),refresh=h.requests.request(),more=h.requests.request({more:true});h.requests.setQuery('new & 中文');const current=h.requests.request();
 assert.equal(await more,null);h.calls[0].resolve(page(['obsolete base']));assert.equal(await refresh,null);assert.equal(h.calls[1].offset,0);assert.equal(h.calls[1].query,'new & 中文');
 h.calls[1].resolve(page(['new result']));await current;assert.deepEqual(h.displayed.entries,['new result']);
});

test('a large refresh paginates sequentially and a new query prevents further obsolete pages',async()=>{
 const h=harness(page(Array.from({length:450},(_,i)=>i))),first=h.requests.request();assert.equal(h.calls.length,1);assert.equal(h.calls[0].limit,200);
 h.calls[0].resolve(page(Array.from({length:200},(_,i)=>i)));await Promise.resolve();assert.equal(h.calls.length,2);assert.equal(h.calls[1].offset,200);
 h.requests.setQuery('latest');const latest=h.requests.request();h.calls[1].resolve(page(['obsolete second page']));assert.equal(await first,null);assert.equal(h.calls.length,3);assert.equal(h.calls[2].query,'latest');assert.equal(h.calls[2].offset,0);assert.equal(h.commits.length,0);
 h.calls[2].resolve(page(['fresh latest']));await latest;assert.deepEqual(h.displayed.entries,['fresh latest']);
});

test('all sequential refresh pages commit together with their original order and final hasMore',async()=>{
 const h=harness(page(Array.from({length:450},(_,i)=>'old '+i))),pending=h.requests.request();
 for(const [index,length]of [[0,200],[1,200],[2,50]]){assert.equal(h.calls.length,index+1);assert.equal(h.calls[index].offset,index*200);assert.equal(h.calls[index].limit,length);h.calls[index].resolve(page(Array.from({length},(_,i)=>index*200+i),{hasMore:index<2}));await Promise.resolve();if(index<2)assert.equal(h.commits.length,0);}
 await pending;assert.deepEqual(h.displayed.entries,Array.from({length:450},(_,i)=>i));assert.equal(h.displayed.hasMore,false);assert.equal(h.commits.length,1);
});

test('obsolete failures are discarded while current failures reject and a later request retries',async()=>{
 const h=harness();h.requests.setQuery('old');const old=h.requests.request();h.requests.setQuery('new');const current=h.requests.request();h.calls[0].reject(Error('old HTTP failure'));
 assert.equal(await old,null);h.calls[1].reject(Error('current HTTP failure'));await assert.rejects(current,/current HTTP failure/);assert.equal(h.commits.length,0);
 const retry=h.requests.request();assert.equal(h.calls.length,3);h.calls[2].resolve(page(['retry success']));await retry;assert.deepEqual(h.displayed.entries,['retry success']);
});

const view=()=>({activeAssetId:'A',jobs:[],switching:false,allowAutomaticOpen:false});
test('automatic opening can await another actual module refresh after the original flight is released',async()=>{
 const document=createCatalogDocument();let fetches=0,opens=0,catalog;
 const first={id:'project GLB',name:'Project.glb',format:'glb',status:'available',origin:'project'};
 catalog=createModelCatalog({document,getView:()=>({...view(),allowAutomaticOpen:true}),
  api:async()=>{fetches++;return page([first],{linked:true});},
  onOpen:async id=>{assert.equal(id,first.id);opens++;await catalog.refresh();},
  onError:error=>assert.fail(error.message),onChooseFolder:()=>{}});
 await catalog.refresh();assert.equal(opens,1);assert.equal(fetches,2);
});

test('actual search event retires the old intent before debounce and dispatches the newest query', {timeout:1500},async()=>{
 const document=createCatalogDocument(),old=deferred(),started=deferred(),committed=deferred(),snapshots=[];let calls=0;
 const catalog=createModelCatalog({document,getView:view,onOpen:()=>{},onChooseFolder:()=>{},onError:error=>assert.fail(error.message),
  api:path=>{calls++;if(calls===1)return old.promise;started.resolve(path);return Promise.resolve(page([]));},
  onChange:data=>{snapshots.push(data);committed.resolve();}});
 const initial=catalog.refresh(),input=document.getElementById('modelSearch');input.value='old search';input.oninput();input.value='new & 中文';input.oninput();
 old.resolve(page([]));await initial;assert.equal(snapshots.length,0);assert.equal(calls,1);
 const path=await started.promise;assert.equal(path,'/api/characters?preferMapped=true&query='+encodeURIComponent('new & 中文')+'&offset=0&limit=100');
 await committed.promise;assert.equal(snapshots.length,1);assert.ok(document.getElementById('modelList').textContent.includes('没有匹配的模型'));
});

test('character/file view ABA retires old responses and never appends a different view',async()=>{
 const document=createCatalogDocument(),old=deferred(),latest=deferred(),snapshots=[],calls=[];
 const catalog=createModelCatalog({document,getView:view,onOpen:()=>{},onChooseFolder:()=>{},onError:e=>assert.fail(e.message),onChange:data=>snapshots.push(data),api:path=>{calls.push(path);return calls.length===1?old.promise:latest.promise;}});
 const initial=catalog.refresh(),files=document.getElementById('catalogFiles').onclick(),characters=document.getElementById('catalogCharacters').onclick();old.resolve(page([{id:'old'}]));await initial;assert.equal(snapshots.length,0);assert.equal(calls.length,2);assert.ok(calls[1].startsWith('/api/characters?'));
 latest.resolve(page([],{total:0,matched:0}));await Promise.all([files,characters]);assert.equal(snapshots.length,1);assert.equal(document.getElementById('modelList').querySelectorAll('.model-card').length,0);
});
