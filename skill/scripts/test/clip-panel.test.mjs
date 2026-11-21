import test from 'node:test';
import assert from 'node:assert/strict';
import {jobForClip,otherClipJobs,jobPair} from '../../assets/viewer/studio-sync.mjs';

const job=(id,clip,state,extra={})=>({id,assetId:'A',clip,state,createdAt:'2026-11-'+String(10+Number(id.slice(1))).padStart(2,'0'),inputs:{baseline:{sha256:'base'}},...extra});

test('the panel shows the clip on screen\'s task, never another clip\'s',()=>{
 const jobs=[job('j1','ExecThrust','complete'),job('j2','Run','queued'),job('j3','Walk','complete',{review:{decision:'keep-baseline'}})];
 assert.equal(jobForClip(jobs,{assetId:'A',clip:'Muichiro_Run',selectedJob:'j1',baselineSha:'base'}),null,'a task opened on another clip is not this clip\'s');
 assert.equal(jobForClip(jobs,{assetId:'A',clip:'Run',baselineSha:'base'}).id,'j2');
 assert.equal(jobForClip(jobs,{assetId:'A',clip:'Walk',baselineSha:'base'}),null,'a decided task is history');
 assert.equal(jobForClip(jobs,{assetId:'A',clip:'Walk',selectedJob:'j3',baselineSha:'base'}).id,'j3','opened from the history it is shown');
 assert.equal(jobForClip(jobs,{assetId:'B',clip:'Run'}),null,'another model\'s');
});

test('a task the game source overtook, or one made on an older source, is history',()=>{
 const jobs=[job('j1','Run','complete',{sourceUpdate:{status:'changed'}}),job('j2','Run','complete',{inputs:{baseline:{sha256:'old'}}})];
 assert.equal(jobForClip(jobs,{assetId:'A',clip:'Run',baselineSha:'base'}),null);
});

test('other clips\' live tasks are listed under the composer; a carried task opens on its new pair',()=>{
 const jobs=[job('j1','ExecThrust','running'),job('j2','Run','complete'),job('j3','Walk','complete',{sourceUpdate:{status:'removed'}})];
 assert.deepEqual(otherClipJobs(jobs,{assetId:'A',clip:'Run'}).map(j=>j.id),['j1']);
 const rebased={baseline:{sha256:'nb',file:'assets/nb.glb'},candidate:{sha256:'nc',file:'assets/nc.glb'}};
 assert.deepEqual(jobPair({...jobs[1],candidate:{sha256:'c'},sourceUpdate:{status:'unchanged',rebased}}),rebased);
 assert.deepEqual(jobPair({...jobs[1],candidate:{sha256:'c'}}),{baseline:{sha256:'base'},candidate:{sha256:'c'}});
});
