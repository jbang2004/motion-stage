import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProject,modelSlots,setModelSlots,projectView} from '../core.mjs';

const slots = name => ({baseline:{sha256:name+'-base'},candidate:{sha256:name+'-candidate'}});
test('v3 migration adopts the old active projection once and preserves other models',()=>{
 const cfg=normalizeProject({version:3,activeAssetId:'A',slots:slots('active'),models:{A:{slots:slots('stale')},B:{slots:slots('B')}}});
 assert.equal(cfg.version,4);
 assert.deepEqual(modelSlots(cfg,'A'),slots('active'));
 assert.deepEqual(modelSlots(cfg,'B'),slots('B'));
 const serialized=JSON.parse(JSON.stringify(cfg));serialized.slots=slots('bad-projection');
 const reloaded=normalizeProject(serialized);
 assert.deepEqual(modelSlots(reloaded,'A'),slots('active'));
 assert.deepEqual(reloaded.slots,slots('active'));
});
test('active projections are detached and switching never writes one model into another',()=>{
 const cfg=normalizeProject({version:4,activeAssetId:'A',models:{A:{slots:slots('A')},B:{slots:slots('B')}}});
 cfg.slots.candidate.sha256='projection-mutation';
 assert.equal(modelSlots(cfg,'A').candidate.sha256,'A-candidate');
 setModelSlots(cfg,'B',slots('B-new'),{activate:true});
 assert.deepEqual(cfg.slots,slots('B-new'));
 assert.deepEqual(modelSlots(cfg,'A'),slots('A'));
 setModelSlots(cfg,'A',slots('A-edited'),{activate:false});
 assert.deepEqual(cfg.slots,slots('B-new'));
 assert.deepEqual(projectView(cfg,'A').slots,slots('A-edited'));
 assert.deepEqual(JSON.parse(JSON.stringify(cfg)).slots,slots('B-new'));
});
test('legacy single-model and empty workspaces retain compatible views',()=>{
 const cfg=normalizeProject({version:2,slots:slots('old')});
 assert.equal(cfg.activeAssetId,'legacy');assert.deepEqual(cfg.slots,slots('old'));
 const empty=normalizeProject({version:2,slots:{}});
 assert.deepEqual(empty.slots,{});assert.deepEqual(modelSlots(empty,'missing'),{});
});
