import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {importAsset, readProject} from '../core.mjs';
import {linkProject} from '../project-context.mjs';
import {initializeWorkspace} from '../project-workspaces.mjs';
import {serve} from '../server.mjs';
import {connectRuntimePreview, offlinePreviewStatus, runtimePreviewStatus} from '../runtime-preview.mjs';
import {findStageState} from '../../assets/viewer/runtime-stage.mjs';
import {createManagedPreview, trustManagedPreview} from '../managed-preview.mjs';
import {bindOfflineAttachments, modelPreviewStates, parseOfflineState, poseOfflineAttachments, resetOfflineAttachments} from '../../assets/viewer/offline-state.mjs';
import * as THREE from '../../assets/vendor/three/build/three.module.js';

test('runtime catalog is opt-in, refreshed from the game and scoped to the linked character', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'motion-runtime-')));
 const work = join(root, 'workspace'), project = join(root, 'project');
 let requested = 0, redirect = false;
 const state = {id: 'ready', label: '待机', path: '/preview?state=ready'};
 const catalog = {version: 1, characters: {'models/hero.glb': [state]}};
 const game = createServer((req, res) => {
  requested++;
  if (redirect) {
   res.writeHead(302, {location: '/preview'});
   res.end();
   return;
  }
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify(catalog));
 });
 try {
  await new Promise(resolve => game.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + game.address().port;
  await mkdir(project);
  await initializeWorkspace(work);
  await linkProject(work, project);
  const bytes = await readFile(new URL('../../assets/demo/baseline.glb', import.meta.url));
  const hero = await importAsset(work, 'baseline', bytes, 'Hero', {newModel: true, source: {projectRelativePath: 'models/hero.glb'}});
  const other = await importAsset(work, 'baseline', bytes, 'Other', {newModel: true, source: {projectRelativePath: 'models/other.glb'}});
  const before = await readProject(work);

  assert.match((await runtimePreviewStatus(work, hero.assetId)).message, /尚未连接/);
  await assert.rejects(connectRuntimePreview(work, 'https://example.invalid/catalog'), /127\.0\.0\.1/);
  await connectRuntimePreview(work, origin + '/catalog');
  assert.match((await runtimePreviewStatus(work, hero.assetId, origin)).message, /独立/);
  assert.equal(requested, 0);
  assert.deepEqual((await runtimePreviewStatus(work, hero.assetId)).states, [{id: state.id, label: state.label, url: origin + state.path}]);
  assert.deepEqual((await runtimePreviewStatus(work, other.assetId)).states, []);
  state.stage = {file:'models/hero.glb',clip:'Hero_Idle',key:'Idle'};
  const staged = (await runtimePreviewStatus(work, hero.assetId)).states;
  assert.deepEqual(staged[0].stage, state.stage);
  assert.equal(findStageState(staged, state.stage), staged[0]);
  assert.equal(findStageState(staged, {...state.stage,file:'models/other.glb'}), null);
  assert.equal(findStageState([...staged, ...staged], state.stage), null);
  state.stage.character='hero';
  assert.equal((await runtimePreviewStatus(work, hero.assetId)).states[0].stage.character,'hero');
  state.capabilities = {characterMaterials:true, liveCloth:false, futureExtension:true};
  assert.deepEqual((await runtimePreviewStatus(work, hero.assetId)).states[0].capabilities, {characterMaterials:true, liveCloth:false});
  state.capabilities.liveCloth = 'yes';
  assert.match((await runtimePreviewStatus(work, hero.assetId)).message, /能力声明无效/);
  delete state.capabilities;
  state.stage.file = '../outside.glb';
  assert.match((await runtimePreviewStatus(work, hero.assetId)).message, /动作来源无效/);
  delete state.stage;
  state.label = '更新后的待机';
  assert.equal((await runtimePreviewStatus(work, hero.assetId)).states[0].label, state.label);
  state.path = '//example.invalid/preview';
  assert.match((await runtimePreviewStatus(work, hero.assetId)).message, /路径无效/);
  redirect = true;
  const beforeRedirect = requested;
  assert.match((await runtimePreviewStatus(work, hero.assetId)).message, /无法读取/);
  assert.equal(requested, beforeRedirect + 1);
  assert.deepEqual(await readProject(work), before);

  await linkProject(work, root);
  assert.match((await runtimePreviewStatus(work, hero.assetId)).message, /当前游戏项目/);
 } finally {
  if (game.listening) await new Promise(resolve => game.close(resolve));
  await rm(root, {recursive: true, force: true});
 }
});

test('first-time setup sends only the selected project role and original action to the bound caller, or returns a copyable handoff', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'motion-preview-handoff-')));
 const work = join(root, 'workspace'), project = join(root, 'game');
 const caller = {client:'codex',sessionId:'original-chat'};
 let server, delivered, deliveryConfirmed = false, deliveries = 0;
 try {
  await mkdir(project);
  await initializeWorkspace(work);
  await linkProject(work, project);
  const bytes = await readFile(new URL('../../assets/demo/baseline.glb', import.meta.url));
  const source = {projectRelativePath:'models/pilot.glb',assembly:{profileId:'pilot',clips:{}}};
  const pilot = await importAsset(work, 'baseline', bytes, 'Pilot', {newModel:true, source});
  const model = (await readProject(work)).models[pilot.assetId];
  const clip = model.slots.baseline.clips[0].name;
  source.assembly.clips[clip] = {file:'moves/pilot.glb',sourceClip:'Wave'};
  await importAsset(work, 'baseline', bytes, 'Pilot', {assetId:pilot.assetId, source});
  const before = await readProject(work);
  server = await serve(work, 0, {caller, sendToCaller: async message => {
   deliveries++;
   delivered = message;
   if (!deliveryConfirmed) throw Error('Host unavailable');
   return true;
  }});
  const origin = 'http://127.0.0.1:' + server.address().port;
  const session = await fetch(origin+'/api/session').then(res => res.json());
  const post = (action, input, token = session.token) => fetch(origin+'/api/runtime-preview/'+action, {
   method:'POST', headers:{'x-motion-token':token,'content-type':'application/json'}, body:JSON.stringify(input),
  });
  const unconfigured = await post('open', {assetId:pilot.assetId,lease:'11111111-1111-1111-1111-111111111111'});
  assert.equal((await unconfigured.json()).code, 'PREVIEW_SETUP_REQUIRED');
  assert.equal(deliveries, 0);
  const input = {assetId:pilot.assetId, clip, caller:{client:'codex',sessionId:'other-chat'}};
  assert.equal((await post('handoff', input, 'bad-token')).status, 403);
  assert.equal((await post('handoff', {...input,clip:'wrong-clip'})).status, 400);
  assert.equal(deliveries, 0);
  const fallback = await post('handoff', input).then(res => res.json());
  assert.equal(fallback.delivery, 'copy');
  assert.equal(fallback.task.project.root, project);
  assert.equal(fallback.task.character.assetId, pilot.assetId);
  assert.equal(fallback.task.character.profileId, 'pilot');
  assert.deepEqual(fallback.task.action, {name:clip,file:'moves/pilot.glb',clip:'Wave'});
  assert.equal(delivered.caller.sessionId, 'original-chat');
  assert.ok(fallback.prompt.includes('moves/pilot.glb'));
  deliveryConfirmed = true;
  const sent = await post('handoff', input).then(res => res.json());
  assert.equal(sent.delivery, 'sent');
  assert.deepEqual(sent.task, fallback.task);
  assert.equal(deliveries, 2);
  assert.deepEqual(await readProject(work), before);
 } finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, {recursive:true,force:true});
 }
});

test('a linked project can expose offline states with its own role and node names without a game service', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'motion-offline-')));
 try {
  const work = join(root, 'workspace'), project = join(root, 'project');
  await mkdir(project);
  await initializeWorkspace(work);
  await linkProject(work, project);
  const bytes = await readFile(new URL('../../assets/demo/baseline.glb', import.meta.url));
  const source = {projectRelativePath: 'Characters/Pilot.glb'};
  const pilot = await importAsset(work, 'baseline', bytes, 'Pilot', {newModel: true, source});
  const other = await importAsset(work, 'baseline', bytes, 'Robot', {newModel: true, source: {projectRelativePath: 'Robot.glb'}});
  const path = join(project, 'motion-stage.states.json');
  const state = {id: 'stowed', label: '工具归位', clip: 'Salute', attachments: [{node: 'Tool', parent: 'Belt'}]};
  const catalog = {version: 1, characters: {[source.projectRelativePath]: [state]}};
  assert.match((await offlinePreviewStatus(work, pilot.assetId)).message, /尚未提供/);
  await writeFile(path, JSON.stringify(catalog));
  const result = await offlinePreviewStatus(work, pilot.assetId);
  assert.equal(result.states[0].clip, 'Salute');
  assert.deepEqual(result.states[0].attachments[0], {node: 'Tool', parent: 'Belt', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1]});
  assert.deepEqual((await offlinePreviewStatus(work, other.assetId)).states, []);
  state.attachments[0].parent = 'Tool';
  await writeFile(path, JSON.stringify(catalog));
  assert.match((await offlinePreviewStatus(work, pilot.assetId)).message, /挂点无效/);
 } finally {
  await rm(root, {recursive: true, force: true});
 }
});

test('an offline prop follows its animated socket while keeping the asset hierarchy and restoring its own pose', () => {
 const scene = new THREE.Scene(), root = new THREE.Group();
 const hand = new THREE.Bone(), belt = new THREE.Bone(), tool = new THREE.Group();
 scene.add(root);
 root.add(hand, belt);
 hand.add(tool);
 root.scale.setScalar(2);
 hand.position.set(1, 2, 3);
 tool.position.set(0, .4, 0);
 belt.position.set(-1, 0, 1);
 belt.rotation.z = .75;
 const parser = {associations: new Map([[tool, {nodes: 0}], [belt, {nodes: 1}]]), json: {nodes: [{name: 'Tool'}, {name: 'Belt'}]}};
 const model = {root, scene, parser};
 const state = parseOfflineState({id: 'carry', label: '收起工具', clip: 'Carry', attachments: [{node: 'Tool', parent: 'Belt', position: [0, -.1, 0]}]});
 model.offlineBindings = bindOfflineAttachments(THREE, model, state.attachments);
 const offset = new THREE.Matrix4().makeTranslation(0, -.1, 0);
 for (const x of [-1, 2]) {
  resetOfflineAttachments(model.offlineBindings);
  belt.position.x = x;
  scene.updateMatrixWorld(true);
  poseOfflineAttachments(model);
  const target = belt.matrixWorld.clone().multiply(offset);
  assert.ok(tool.matrixWorld.elements.every((value, index) => Math.abs(value - target.elements[index]) < 1e-10));
  assert.equal(tool.parent, hand);
 }
 resetOfflineAttachments(model.offlineBindings);
 scene.updateMatrixWorld(true);
 assert.equal(tool.matrixAutoUpdate, true);
 assert.deepEqual(tool.getWorldPosition(new THREE.Vector3()).toArray(), [2, 4.8, 6]);
});

test('projects without a catalog can preview asset clips shared by both loaded versions', () => {
 const baseline = {clips: [{name: 'Salute'}, {name: 'Carry'}]}, candidate = {clips: [{name: 'Carry'}]};
 assert.deepEqual(modelPreviewStates([baseline, candidate], baseline).map(state => [state.clip, state.modelOnly]), [['Carry', true]]);
});

test('project-declared preview is trusted per project, shared by windows and released after the last lease', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'motion-managed-')));
 const work = join(root, 'workspace'), project = join(root, 'other-game'), trust = join(root, 'host-trust');
 const manager = createManagedPreview(work, {trustDirectory: trust});
 try {
  await mkdir(project);
  await initializeWorkspace(work);
  await linkProject(work, project);
  assert.equal(await manager.acquire('one'), null);
  const launcher = join(project, 'preview.mjs');
  const source = `
   import {createServer} from 'node:http';
   const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({version:1,characters:{'models/robot.glb':[
     {id:'wave',label:'招手',path:'/render?move=wave'}
    ]}}));
   });
   process.on('disconnect', () => { server.close(); server.closeAllConnections(); });
   server.listen(0, '127.0.0.1', () => process.send({type:'motion-stage-ready',port:server.address().port}));
  `;
  await writeFile(launcher, source);
  await writeFile(join(project, 'motion-stage.preview.json'), JSON.stringify({version:1,entry:'preview.mjs',catalog:'/catalog'}));
  const bytes = await readFile(new URL('../../assets/demo/baseline.glb', import.meta.url));
  const robot = await importAsset(work, 'baseline', bytes, 'Robot', {newModel:true, source:{projectRelativePath:'models/robot.glb'}});
  await assert.rejects(manager.acquire('one'), /runtime-trust/);
  await trustManagedPreview(work, trust);
  const [one, two] = await Promise.all([manager.acquire('one'), manager.acquire('two')]);
  assert.equal(one.href, two.href);
  const result = await runtimePreviewStatus(work, robot.assetId, undefined, one);
  assert.deepEqual(result.states, [{id:'wave',label:'招手',url:one.origin+'/render?move=wave'}]);
  await manager.release('one');
  assert.equal(manager.renew('two'), true);
  assert.equal((await fetch(one)).status, 200);
  await manager.release('two');
  assert.equal(manager.renew('two'), false);
  await assert.rejects(fetch(one));

  await writeFile(launcher, source + '\n// Updated entry.');
  await assert.rejects(manager.acquire('three'), /runtime-trust/);
 } finally {
  await manager.close();
  await rm(root, {recursive:true, force:true});
 }
});
