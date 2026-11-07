import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './viewer-dom-fixture.mjs';
import {buildSections, describeRow, formatSeconds, createCastBrowser} from '../../assets/viewer/cast-browser.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };

const OWN = [
  {name: 'Zenitsu_ArpgIdle', duration: 1, tracks: [{}]},
  {name: 'Zenitsu_ArpgCombo1', duration: 0.83, tracks: [{}]},
  {name: 'Zenitsu_Empty', duration: 1, tracks: []}
];
const MATCHED = {
  state: 'ready', checked: 3, total: 3, saved: [],
  actions: [
    {id: 'm-run', name: 'NODACHI_AS_Run_Fast_Loop_F_0_Seq__RM', duration: 0.47, sourceName: 'run.glb', sourceCount: 1, presetVariant: false},
    {id: 'm-combo', name: 'NODACHI_AS_Combo_Attack_03_02_Seq', duration: 2.58, sourceName: 'combo.glb', sourceCount: 2, presetVariant: true}
  ]
};
const CAST = [
  {id: 'A', kind: 'character', name: '善逸', confirmed: true, embeddedCount: 97, externalCount: 6, portrait: null},
  {id: 'B', kind: 'character', name: '炭治郎', confirmed: true, embeddedCount: 67, externalCount: 11, portrait: null},
  {id: 'C', kind: 'character', name: 'akaza', confirmed: false, embeddedCount: 8, externalCount: 0, portrait: null}
];

function page() {
  const doc = createDocument();
  for (const id of ['modeLibrary', 'modeStudio', 'castGalleryButton', 'editThisAction']) doc.add('button', id);
  for (const id of ['castList', 'castTotal', 'castGalleryBody', 'abTitle', 'abCount', 'abCategories', 'abStatus', 'abScroll', 'abSections']) doc.add('div', id);
  doc.add('dialog', 'castGallery');
  doc.add('input', 'castGallerySearch');
  doc.add('input', 'abSearch');
  return doc;
}

function setup({actions = MATCHED, mode = null, studio = null} = {}) {
  const doc = page(), store = new Map(mode ? [['motion-stage-mode', mode]] : []);
  globalThis.document = doc;
  globalThis.localStorage = {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value))};
  const stage = {value: {ready: true, assetId: 'A', slot: 'baseline', modelSha: 'sha-a', name: '善逸', model: studio ? {root: {}, parser: {}} : null, ownClips: OWN, currentClip: 'Zenitsu_ArpgIdle', previewing: false}};
  const calls = [], events = [];
  let release = null;
  const api = async path => {
    calls.push(path);
    if (path === '/api/cast') return {entries: CAST};
    if (path.startsWith('/api/actions?')) return structuredClone(actions);
    throw Error('unexpected ' + path);
  };
  const browser = createCastBrowser({
    api, documentRef: doc, getStage: () => stage.value,
    studio: studio || {available: () => false, stopLive() {}, portrait: async () => null},
    openCharacter: async entry => { events.push(['open', entry.id]); },
    playOwn: name => events.push(['own', name]),
    playShared: (row, isCurrent) => new Promise(resolve => { release = () => { events.push(['shared', row.id, isCurrent()]); resolve(); }; }),
    playSaved: async row => events.push(['saved', row.id]),
    onEdit: () => events.push(['edit'])
  });
  const sections = () => doc.getElementById('abSections').children.filter(node => node.className === 'ab-section');
  const cards = () => doc.getElementById('abSections').querySelectorAll('.action-card');
  const chip = id => doc.getElementById('abCategories').children.find(node => node.dataset.cat === id);
  return {doc, stage, browser, calls, events, sections, cards, chip, store, release: () => release?.()};
}

test('grid model groups saved, own and matched rows and counts categories under the current search', () => {
  const own = OWN.slice(0, 2).map(clip => describeRow('own', clip));
  const matched = MATCHED.actions.map(row => describeRow('matched', row));
  const all = buildSections({own, matched});
  assert.deepEqual(all.sections.map(s => [s.id, s.rows.length]), [['own', 2], ['matched', 2]]);
  assert.equal(all.counts.all, 4);
  assert.equal(all.counts.attack, 2);
  const attacks = buildSections({own, matched, category: 'attack'});
  assert.deepEqual(attacks.sections.map(s => s.rows.map(r => r.name)), [['Zenitsu_ArpgCombo1'], ['NODACHI_AS_Combo_Attack_03_02_Seq']]);
  const chinese = buildSections({own, matched, query: '连招'});
  assert.equal(chinese.counts.all, 2);
  const raw = buildSections({own, matched, query: 'run_fast'});
  assert.deepEqual(raw.sections.map(s => s.rows.map(r => r.id)), [['m-run']]);
  assert.equal(describeRow('own', OWN[0]).id, 'own:Zenitsu_ArpgIdle');
  assert.equal(describeRow('own', OWN[1]).label, '连招 1');
  assert.equal(formatSeconds(0.47), '0.47s');
  assert.equal(formatSeconds(2.58), '2.6s');
  assert.equal(formatSeconds(11.2), '11s');
});

test('rail lists declared characters, marks the stage character and opens another one', async () => {
  const h = setup();
  await h.browser.loadCast();
  const tiles = h.doc.getElementById('castList').children;
  assert.deepEqual(tiles.map(tile => tile.querySelector('.cast-name').textContent), ['善逸', '炭治郎']);
  assert.equal(tiles[0].getAttribute('aria-selected'), 'true');
  assert.equal(tiles[0].querySelector('.cast-count').textContent, '103');
  await tiles[1].onclick();
  await settle();
  assert.deepEqual(h.events, [['open', 'B']]);
  assert.equal(h.doc.getElementById('castTotal').textContent, '3');
});

test('selecting a character shows playable own clips and auto-matched actions with category chips', async () => {
  const h = setup();
  h.browser.sync();
  await settle();
  assert.ok(h.calls.some(path => path.startsWith('/api/actions?') && path.includes('assetId=A') && path.includes('expectedModelSha=sha-a')));
  assert.deepEqual(h.sections().map(s => s.dataset.section), ['own', 'matched']);
  assert.equal(h.cards().length, 4, 'clips without tracks are not offered');
  assert.equal(h.doc.getElementById('abTitle').textContent, '善逸的动作');
  assert.equal(h.doc.getElementById('abCount').textContent, '4');
  assert.deepEqual(h.doc.getElementById('abCategories').children.map(c => c.dataset.cat), ['all', 'idle', 'move', 'attack']);
  const active = h.cards().find(card => card.classList.contains('active'));
  assert.equal(active.dataset.id, 'own:Zenitsu_ArpgIdle');
  assert.equal(h.cards().find(card => card.dataset.id === 'm-combo').querySelector('.ac-badge').textContent, '其他版本');

  h.chip('attack').onclick();
  assert.deepEqual(h.cards().map(card => card.dataset.id), ['own:Zenitsu_ArpgCombo1', 'm-combo']);
  assert.equal(h.store.get('motion-stage-category'), 'attack');
  h.chip('all').onclick();

  h.doc.getElementById('abSearch').dispatch('input', {target: {value: '奔跑'}});
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(h.cards().map(card => card.dataset.id), ['m-run']);
});

test('own clips play at once; matched actions are fenced against character switches', async () => {
  const h = setup();
  h.browser.sync();
  await settle();
  h.cards().find(card => card.dataset.id === 'own:Zenitsu_ArpgCombo1').onclick();
  assert.deepEqual(h.events.at(-1), ['own', 'Zenitsu_ArpgCombo1']);

  const matched = h.cards().find(card => card.dataset.id === 'm-run');
  const pending = matched.onclick();
  assert.ok(matched.classList.contains('pending'));
  h.release();
  await pending;
  assert.deepEqual(h.events.at(-1), ['shared', 'm-run', true]);
  assert.ok(matched.classList.contains('active'));

  const second = h.cards().find(card => card.dataset.id === 'm-combo').onclick();
  h.stage.value = {...h.stage.value, assetId: 'B', modelSha: 'sha-b', name: '炭治郎', currentClip: null};
  h.browser.sync();
  h.release();
  await second;
  assert.deepEqual(h.events.at(-1), ['shared', 'm-combo', false], 'a stale trial is reported as not current');
  await settle();
  assert.ok(h.calls.some(path => path.includes('assetId=B')));
});

test('library and studio modes switch from the top bar and persist', async () => {
  const h = setup({mode: 'studio'});
  assert.equal(h.doc.body.dataset.mode, 'studio');
  h.doc.getElementById('modeLibrary').dispatch('click');
  assert.equal(h.doc.body.dataset.mode, 'library');
  assert.equal(h.store.get('motion-stage-mode'), 'library');
  assert.equal(h.doc.getElementById('modeLibrary').getAttribute('aria-selected'), 'true');
  h.doc.getElementById('editThisAction').dispatch('click');
  assert.deepEqual(h.events, [['edit']]);
});

test('scanning shows real progress and an unopened stage asks for a character', async () => {
  const h = setup({actions: {...MATCHED, state: 'scanning', checked: 12, total: 48, actions: []}});
  h.browser.sync();
  await settle();
  assert.match(h.doc.getElementById('abStatus').textContent, /正在从项目中匹配动作 · 12 \/ 48/);
  h.browser.cancelPreview();
  h.stage.value = {ready: false, loading: false};
  h.browser.sync();
  assert.match(h.doc.getElementById('abSections').textContent, /选择角色/);
});

test('a rigged model with no playable actions says so instead of blaming the category', async () => {
  const h = setup({actions: {state: 'ready', checked: 9, total: 9, incompatible: 83, saved: [], actions: []}});
  h.stage.value = {...h.stage.value, ownClips: []};
  h.browser.sync();
  await settle();
  const text = h.doc.getElementById('abSections').textContent;
  assert.match(text, /这个角色还没有可播放的动作/);
  assert.match(text, /83 段动作骨架或参考姿势不同/);
  assert.doesNotMatch(text, /换个类别/);
});

test('saved actions without a recorded length show no 0s badge', async () => {
  const h = setup({actions: {...MATCHED, saved: [{id: 's1', name: 'run_wide_arms', number: 1, recipe: {clip: 'run_wide_arms'}}]}});
  h.browser.sync();
  await settle();
  const card = h.cards().find(node => node.dataset.id === 'saved:s1');
  assert.ok(card);
  assert.equal(card.querySelector('.ac-duration'), null);
});

test('saved 常用 cards request a key-pose thumbnail from their recipe', async () => {
  const requests = [];
  const studio = {available: () => true, stopLive() {}, portrait: async () => null, known: () => null, createSubject: () => ({dispose() {}}),
    ownAction: async () => 'own.png', sharedAction: async () => 'shared.png',
    savedAction: async (subject, request, row) => { requests.push({request, recipe: row.source.recipe.id}); return 'saved.png'; }};
  const recipe = {id: 'recipe-1', packId: 'p1', versionId: 'v1', clip: 'run_wide_arms', mappingId: 'map-1'};
  const h = setup({studio, actions: {...MATCHED, saved: [{id: 's1', name: 'run_wide_arms', number: 1, recipe}]}});
  h.browser.sync();
  await settle(8);
  assert.deepEqual(requests, [{request: {assetId: 'A', slot: 'baseline', expectedModelSha: 'sha-a', packId: 'p1', versionId: 'v1', clip: 'run_wide_arms', mappingId: 'map-1'}, recipe: 'recipe-1'}]);
  const card = h.cards().find(node => node.dataset.id === 'saved:s1');
  assert.equal(card.querySelector('img').src, 'saved.png');
});
