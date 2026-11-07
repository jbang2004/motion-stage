// 动作库 — the character rail, the cast gallery and the per-character action
// grid. Pure presentation + request fencing; the stage, clip bindings and
// model heads stay owned by app.js and are reached only through callbacks.
import {ACTION_CATEGORIES, classifyAction, actionSearchText, compareActions} from './action-taxonomy.mjs';
import {icon, element as el} from './ui.mjs';

const PAGE = 48;
const MODE_KEY = 'motion-stage-mode';
const CATEGORY_KEY = 'motion-stage-category';
const HOVER_DELAY = 260;
const CATEGORY_ICON = {
  all: 'grid', idle: 'cat-idle', move: 'cat-move', attack: 'cat-attack', skill: 'cat-skill', defense: 'cat-defense',
  hit: 'cat-hit', air: 'cat-air', down: 'cat-down', emote: 'cat-emote', other: 'cat-other'
};
const SHORT_LABEL = {defense: '防御'};

export const categoryLabel = id => SHORT_LABEL[id] || ACTION_CATEGORIES.find(c => c.id === id)?.label || '全部';
export function formatSeconds(value) {
  const seconds = Number(value) || 0;
  return seconds >= 10 ? Math.round(seconds) + 's' : seconds.toFixed(seconds < 1 ? 2 : 1) + 's';
}

// Pure model of the grid: filter, group and order rows. Exported for tests.
export function buildSections({own = [], matched = [], saved = [], category = 'all', query = ''}) {
  const q = query.trim().toLowerCase();
  const pass = row => (category === 'all' || row.info.category === category) && (!q || row.search.includes(q));
  const searchOnly = row => !q || row.search.includes(q);
  const pool = [...saved, ...own, ...matched].filter(searchOnly);
  const counts = {all: pool.length};
  for (const row of pool) counts[row.info.category] = (counts[row.info.category] || 0) + 1;
  const sections = [
    {id: 'saved', title: '常用', rows: saved.filter(pass)},
    {id: 'own', title: '角色自带', rows: own.filter(pass)},
    {id: 'matched', title: '匹配动作', rows: matched.filter(pass)}
  ].filter(section => section.rows.length);
  return {sections, counts};
}

export function describeRow(kind, source) {
  const name = kind === 'saved' ? source.recipe?.clip || source.name : source.name;
  const duration = Number(source.duration ?? source.recipe?.duration) || 0;
  const info = classifyAction(name, {duration});
  const id = kind === 'own' ? 'own:' + name : kind === 'saved' ? 'saved:' + source.id : source.id;
  return {
    kind, id, name, duration, info, source,
    label: kind === 'saved' ? source.name : info.label,
    search: actionSearchText(name, info) + ' ' + String(source.sourceName || '').toLowerCase() + (kind === 'saved' ? ' ' + String(source.name).toLowerCase() : '')
  };
}

export function createCastBrowser({
  api, studio, getStage, openCharacter, playOwn, playShared, playSaved, onEdit,
  onModeChange = () => {}, onError = console.error, documentRef = globalThis.document
}) {
  const $ = id => documentRef.getElementById(id);
  const body = documentRef.body;
  const hoverCapable = globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  let cast = [], castLoaded = false, castTicket = 0;
  let identity = '', generation = 0, playTicket = 0;
  let own = [], matched = [], saved = [], scan = null, loadingActions = false, pollTimer = null, needsReload = false;
  let category = readStored(CATEGORY_KEY) || 'all', query = '', pages = {};
  let subject = null, subjectSha = null;
  let activeId = null, pendingId = null, openingId = null;
  let hoverTimer = null, liveCard = null;
  const portraits = new Map();
  const portraitNodes = new Map();
  const cardObserver = globalThis.IntersectionObserver ? new IntersectionObserver(onCardsVisible, {root: $('abScroll'), rootMargin: '240px 0px'}) : null;
  const pageObserver = globalThis.IntersectionObserver ? new IntersectionObserver(onSentinel, {root: $('abScroll'), rootMargin: '600px 0px'}) : null;
  const portraitObserver = globalThis.IntersectionObserver ? new IntersectionObserver(onPortraitsVisible, {rootMargin: '200px'}) : null;

  function readStored(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function store(key, value) { try { localStorage.setItem(key, value); } catch {} }

  // ----------------------------------------------------------------- mode ---
  function setMode(mode, {silent = false} = {}) {
    const next = mode === 'studio' ? 'studio' : 'library';
    const changed = body.dataset.mode !== next;
    body.dataset.mode = next;
    for (const tab of [$('modeLibrary'), $('modeStudio')]) {
      if (!tab) continue;
      const selected = tab.id === (next === 'studio' ? 'modeStudio' : 'modeLibrary');
      tab.setAttribute('aria-selected', String(selected));
      tab.classList.toggle('active', selected);
    }
    store(MODE_KEY, next);
    if (next !== 'library') stopHover();
    if (changed && !silent) onModeChange(next);
    if (next === 'library') draw();
  }
  $('modeLibrary')?.addEventListener('click', () => setMode('library'));
  $('modeStudio')?.addEventListener('click', () => setMode('studio'));

  // ----------------------------------------------------------------- cast ---
  async function loadCast() {
    const ticket = ++castTicket;
    try {
      const data = await api('/api/cast');
      if (ticket !== castTicket) return;
      cast = data.entries || [];
      castLoaded = true;
      drawRail();
      if ($('castGallery')?.open) drawGallery();
    } catch (error) {
      if (ticket === castTicket) setRailMessage('角色列表暂不可用：' + error.message);
    }
  }

  function railEntries() {
    const stage = getStage();
    const confirmed = cast.filter(entry => entry.confirmed);
    let list = confirmed.length ? confirmed : cast.filter(entry => entry.kind === 'character').slice(0, 12);
    if (!list.length) list = cast.slice(0, 12);
    if (stage?.assetId && !list.some(entry => entry.id === stage.assetId)) {
      const current = cast.find(entry => entry.id === stage.assetId);
      if (current) list = [current, ...list];
    }
    return list;
  }

  function setRailMessage(text) {
    const host = $('castList');
    if (!host) return;
    host.replaceChildren(el('p', text, 'rail-message'));
  }

  function initials(name) {
    const text = String(name || '?').trim();
    return /^[一-鿿]/.test(text) ? text.slice(0, 1) : text.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  }

  function portraitNode(entry, className) {
    const holder = el('span', undefined, className);
    holder.append(el('span', initials(entry.name), 'portrait-initial'));
    const image = documentRef.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    holder.append(image);
    holder._image = image;
    holder.dataset.entry = entry.id;
    if (!portraitNodes.has(entry.id)) portraitNodes.set(entry.id, new Set());
    portraitNodes.get(entry.id).add(holder);
    const known = portraits.get(entry.id);
    if (known) applyPortrait(holder, known);
    else if (entry.portrait) portraitObserver ? portraitObserver.observe(holder) : requestPortrait(entry, holder);
    return holder;
  }

  function applyPortrait(holder, result) {
    const image = holder._image;
    if (!image || !result?.url) return;
    if (image.getAttribute('src') !== result.url) {
      image.onload = () => { holder.classList.add('loaded'); tintFromImage(holder, image); };
      image.src = result.url;
    }
  }

  function tintFromImage(holder, image) {
    try {
      const canvas = documentRef.createElement('canvas');
      canvas.width = 24; canvas.height = 32;
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      ctx.drawImage(image, 0, 0, 24, 32);
      const data = ctx.getImageData(0, 0, 24, 32).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 180) continue;
        const max = Math.max(data[i], data[i + 1], data[i + 2]), min = Math.min(data[i], data[i + 1], data[i + 2]);
        const weight = 0.2 + (max - min) / 255;
        r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight; n += weight;
      }
      if (n) holder.style.setProperty('--tint', [r / n, g / n, b / n].map(Math.round).join(','));
    } catch {}
  }

  function onPortraitsVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      portraitObserver.unobserve(entry.target);
      const row = cast.find(item => item.id === entry.target.dataset.entry);
      if (row) requestPortrait(row, entry.target);
    }
  }

  async function requestPortrait(entry, holder) {
    try {
      const result = await studio.portrait(entry, {priority: entry.confirmed ? 0 : 3, wanted: () => holder.isConnected});
      if (!result) return;
      portraits.set(entry.id, result);
      for (const node of portraitNodes.get(entry.id) || []) {
        if (node.isConnected) applyPortrait(node, result); else portraitNodes.get(entry.id).delete(node);
      }
    } catch (error) {
      holder.classList.add('failed');
      holder.title = '预览图暂不可用：' + error.message;
    }
  }

  function actionCountOf(entry) { return (entry.embeddedCount || 0) + (entry.externalCount || 0); }

  function drawRail() {
    const host = $('castList');
    if (!host) return;
    if (!castLoaded) return;
    const stage = getStage();
    const list = railEntries();
    if (!list.length) { setRailMessage('还没有角色。导入 GLB，或关联游戏项目。'); return; }
    host.replaceChildren(...list.map(entry => {
      const tile = el('button', undefined, 'cast-tile');
      tile.type = 'button';
      tile.setAttribute('role', 'option');
      const selected = entry.id === stage?.assetId;
      tile.setAttribute('aria-selected', String(selected));
      tile.classList.toggle('active', selected);
      tile.classList.toggle('opening', entry.id === openingId);
      tile.title = entry.name + (entry.relativePath ? '\n' + entry.relativePath : '');
      tile.append(portraitNode(entry, 'cast-portrait'), el('span', entry.name, 'cast-name'));
      const count = actionCountOf(entry);
      if (count) tile.append(el('span', String(count), 'cast-count'));
      tile.onclick = () => chooseCharacter(entry);
      return tile;
    }));
    $('castTotal') && ($('castTotal').textContent = cast.length > list.length ? String(cast.length) : '');
  }

  async function chooseCharacter(entry, {fromGallery = false} = {}) {
    const stage = getStage();
    if (entry.id === stage?.assetId) { if (fromGallery) $('castGallery')?.close(); setMode('library'); return; }
    if (openingId) return;
    openingId = entry.id;
    drawRail();
    if (fromGallery) $('castGallery')?.close();
    try {
      await openCharacter(entry);
      setMode('library', {silent: true});
    } catch (error) {
      onError(error);
    } finally {
      openingId = null;
      drawRail();
      void loadCast();
    }
  }

  // -------------------------------------------------------------- gallery ---
  function drawGallery() {
    const host = $('castGalleryBody');
    if (!host) return;
    const q = ($('castGallerySearch')?.value || '').trim().toLowerCase();
    const match = entry => !q || (entry.name + ' ' + (entry.relativePath || '')).toLowerCase().includes(q);
    const groups = [
      ['项目角色', '在角色声明中确认的角色', cast.filter(e => e.confirmed && match(e))],
      ['其他角色模型', '项目里带骨骼或动作的 GLB，可直接打开预览', cast.filter(e => !e.confirmed && e.kind === 'character' && match(e))],
      ['工作区模型', '导入或示例素材', cast.filter(e => e.kind === 'model' && match(e))]
    ].filter(([, , rows]) => rows.length);
    if (!groups.length) { host.replaceChildren(el('p', castLoaded ? '没有符合的角色。' : '正在读取角色…', 'gallery-empty')); return; }
    const stage = getStage();
    host.replaceChildren(...groups.map(([title, hint, rows]) => {
      const section = el('section', undefined, 'gallery-section');
      const head = el('header', undefined, 'gallery-section-head');
      head.append(el('h3', title), el('span', String(rows.length), 'gallery-count'), el('p', hint));
      const grid = el('div', undefined, 'gallery-grid');
      grid.append(...rows.slice(0, 120).map(entry => {
        const card = el('button', undefined, 'gallery-card');
        card.type = 'button';
        card.classList.toggle('active', entry.id === stage?.assetId);
        const count = actionCountOf(entry);
        const text = el('span', undefined, 'gallery-text');
        text.append(el('b', entry.name), el('small', count ? count + ' 个动作' : entry.format?.toUpperCase() || '模型'));
        card.append(portraitNode(entry, 'gallery-portrait'), text);
        card.title = entry.relativePath || entry.name;
        card.onclick = () => chooseCharacter(entry, {fromGallery: true});
        return card;
      }));
      if (rows.length > 120) grid.append(el('p', '还有 ' + (rows.length - 120) + ' 个，搜索名称即可找到。', 'gallery-more'));
      section.append(head, grid);
      return section;
    }));
  }

  function openGallery() {
    const dialog = $('castGallery');
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    drawGallery();
    if (!castLoaded) void loadCast();
    setTimeout(() => $('castGallerySearch')?.focus(), 30);
  }
  $('castGalleryButton')?.addEventListener('click', openGallery);
  $('castGallerySearch')?.addEventListener('input', () => drawGallery());

  // -------------------------------------------------------------- actions ---
  function target() {
    const stage = getStage();
    return stage?.ready && stage.assetId && stage.modelSha
      ? {assetId: stage.assetId, slot: stage.slot || 'baseline', expectedModelSha: stage.modelSha}
      : null;
  }
  const keyOf = value => value ? value.assetId + '|' + value.slot + '|' + value.expectedModelSha : '';
  const current = (ticket, key) => ticket === generation && key === keyOf(target());

  function ensureSubject() {
    const stage = getStage();
    if (!stage?.model?.root || !stage.modelSha || !studio?.available()) return null;
    if (subject && subjectSha === stage.modelSha) return subject;
    subject?.dispose();
    try {
      subject = studio.createSubject(stage.model.root, {parser: stage.model.parser, id: stage.modelSha});
      subjectSha = stage.modelSha;
    } catch (error) {
      subject = null; subjectSha = null;
      onError(error);
    }
    return subject;
  }

  function readOwnClips() {
    const stage = getStage();
    return (stage?.ownClips || []).filter(clip => clip.tracks?.length).map(clip => ({...describeRow('own', clip), clip}));
  }

  async function loadActions(force = false) {
    const value = target();
    if (!value) return;
    if (loadingActions) { needsReload = true; return; }
    const ticket = generation, key = keyOf(value);
    loadingActions = true;
    try {
      const result = await api('/api/actions?' + new URLSearchParams({...value, ...(force ? {refresh: '1'} : {})}));
      if (!current(ticket, key)) return;
      scan = result;
      matched = (result.actions || []).map(row => describeRow('matched', row));
      saved = (result.saved || []).filter(a => result.saved.findLast(x => x.name === a.name)?.id === a.id).map(a => describeRow('saved', a));
      draw();
      clearTimeout(pollTimer);
      if (result.state === 'scanning') pollTimer = setTimeout(() => loadActions(), 1200);
    } catch (error) {
      if (current(ticket, key)) { scan = {state: 'failed', error: error.message}; drawStatus(); }
    } finally {
      loadingActions = false;
      if (needsReload) { needsReload = false; void loadActions(); }
    }
  }

  function sync() {
    const value = target();
    const next = keyOf(value);
    if (next !== identity) {
      const previousAsset = identity.split('|')[0];
      identity = next;
      generation++;
      playTicket++;
      pendingId = null;
      activeId = null;
      clearTimeout(pollTimer);
      stopHover();
      scan = null; matched = []; saved = [];
      pages = {};
      if (value && value.assetId !== previousAsset) { query = ''; if ($('abSearch')) $('abSearch').value = ''; }
      $('abScroll')?.scrollTo?.({top: 0});
      own = value ? readOwnClips() : [];
      cards.clear();
      if (value) void loadActions();
      drawRail();
    } else if (value) {
      // Clips can be swapped back after a trial; refresh own rows cheaply.
      const names = own.map(r => r.name).join('\n'), fresh = readOwnClips();
      if (fresh.map(r => r.name).join('\n') !== names) own = fresh;
    }
    const stage = getStage();
    if (stage && !stage.previewing && pendingId === null) activeId = stage.currentClip ? 'own:' + stage.currentClip : null;
    const signature = [identity, own.length, matched.length, saved.length, scan?.state, stage?.name].join('|');
    if (signature !== drawnSignature) draw(); else { markActive(); drawStatus(); }
  }

  function drawStatus() {
    const status = $('abStatus');
    if (!status) return;
    const stage = getStage();
    status.replaceChildren();
    status.dataset.state = scan?.state || (target() ? 'loading' : 'idle');
    if (!target()) { status.textContent = stage?.loading ? '正在打开角色…' : '选择一个角色查看动作'; return; }
    if (!scan) { status.textContent = '正在为角色匹配动作…'; return; }
    if (scan.state === 'scanning') {
      const progress = el('span', undefined, 'ab-progress');
      const fill = el('i');
      fill.style.width = Math.round(100 * (scan.checked || 0) / Math.max(1, scan.total || 1)) + '%';
      progress.append(fill);
      status.append(el('span', '正在从项目中匹配动作 · ' + (scan.checked || 0) + ' / ' + (scan.total || 0)), progress);
      return;
    }
    if (scan.state === 'failed') { status.textContent = '匹配未完成：' + (scan.error || '未知原因'); return; }
    const name = stage?.name || '角色';
    const text = matched.length
      ? '已为' + name + '匹配 ' + matched.length + ' 个骨架一致的动作' + (scan.state === 'partial' ? '（部分结果）' : '')
      : '项目中暂未找到与' + name + '骨架一致的其他动作';
    status.append(el('span', text));
    const refresh = el('button', '重新匹配', 'ab-refresh');
    refresh.type = 'button';
    refresh.onclick = () => { clearTimeout(pollTimer); void loadActions(true); };
    status.append(refresh);
  }

  function drawChips(counts) {
    const host = $('abCategories');
    if (!host) return;
    const items = [{id: 'all'}, ...ACTION_CATEGORIES].filter(c => c.id === 'all' || counts[c.id] || c.id === category);
    if (category !== 'all' && !counts[category] && !query) category = 'all';
    host.replaceChildren(...items.map(c => {
      const chip = el('button', undefined, 'ab-chip');
      chip.type = 'button';
      chip.dataset.cat = c.id;
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(category === c.id));
      chip.classList.toggle('active', category === c.id);
      chip.append(icon(CATEGORY_ICON[c.id] || 'grid'), el('span', categoryLabel(c.id)), el('small', String(counts[c.id] || 0)));
      chip.onclick = () => {
        category = c.id; store(CATEGORY_KEY, category); pages = {};
        $('abScroll')?.scrollTo?.({top: 0});
        draw();
        chip.scrollIntoView?.({inline: 'nearest', block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth'});
      };
      return chip;
    }));
  }

  let drawnSignature = '';
  const cards = new Map();
  function draw() {
    const host = $('abSections');
    if (!host) return;
    const stage = getStage();
    drawnSignature = [identity, own.length, matched.length, saved.length, scan?.state, stage?.name].join('|');
    if ($('abTitle')) $('abTitle').textContent = stage?.name ? stage.name + '的动作' : '动作库';
    const {sections, counts} = buildSections({own, matched, saved, category, query});
    if ($('abCount')) $('abCount').textContent = target() ? String(own.length + matched.length + saved.length) : '';
    drawChips(counts);
    drawStatus();
    cardObserver?.disconnect();
    pageObserver?.disconnect();
    if (!target()) {
      host.replaceChildren(emptyState(stage?.loading ? '正在打开角色' : '选择角色', stage?.loading ? '首次打开会整理角色的全部动作。' : '从左侧选择角色，即可浏览它能做的所有动作。'));
      return;
    }
    if (!sections.length) {
      const settled = scan && scan.state !== 'scanning';
      if (!query && !own.length && !matched.length && !saved.length && settled) {
        // Rigged-but-unanimated models (auto-rigged exports) are common; say what is missing.
        const others = Number(scan.incompatible) || 0;
        host.replaceChildren(emptyState('这个角色还没有可播放的动作', others
          ? '模型不带动作；项目里另有 ' + others + ' 段动作骨架或参考姿势不同，需要先重定向，可在“修改”里交给 Agent。'
          : '模型不带动作，项目里也没有骨架一致的动作。导入同一骨架导出的 GLB 动作，或交给 Agent 重定向。'));
        return;
      }
      host.replaceChildren(emptyState(query ? '没有找到“' + query + '”' : '这个类别暂无动作', query ? '试试中文名、英文名或原始动作名。' : '换个类别，或等待匹配完成。'));
      return;
    }
    host.replaceChildren(...sections.map(drawSection));
  }

  function emptyState(title, text) {
    const box = el('div', undefined, 'ab-empty');
    box.append(icon('cat-other'), el('b', title), el('p', text));
    return box;
  }

  function drawSection(section) {
    const node = el('section', undefined, 'ab-section');
    node.dataset.section = section.id;
    const head = el('header', undefined, 'ab-section-head');
    head.append(el('h3', section.title), el('span', String(section.rows.length), 'ab-section-count'));
    if (section.id === 'matched') head.append(el('p', '来自项目其他文件，骨架与静止姿态一致，可直接预览。'));
    if (section.id === 'saved') head.append(el('p', '已加入常用的固定版本。'));
    const grid = el('div', undefined, 'ab-grid');
    const limit = pages[section.id] || PAGE;
    for (const row of section.rows.slice(0, limit)) grid.append(card(row));
    node.append(head, grid);
    if (section.rows.length > limit) {
      const sentinel = el('div', undefined, 'ab-sentinel');
      sentinel.dataset.section = section.id;
      const more = el('button', '显示更多 · 还有 ' + (section.rows.length - limit) + ' 个', 'ab-more');
      more.type = 'button';
      more.onclick = () => { pages[section.id] = limit + PAGE * 2; draw(); };
      sentinel.append(more);
      node.append(sentinel);
      pageObserver?.observe(sentinel);
    }
    return node;
  }

  function card(row) {
    const reused = cards.get(row.id);
    if (reused) {
      const selected = row.id === activeId;
      reused.classList.toggle('active', selected);
      reused.classList.toggle('pending', row.id === pendingId);
      reused.setAttribute('aria-pressed', String(selected));
      if (!reused.classList.contains('has-thumb')) cardObserver?.observe(reused);
      return reused;
    }
    const button = el('button', undefined, 'action-card');
    cards.set(row.id, button);
    button.type = 'button';
    button.dataset.id = row.id;
    button.dataset.cat = row.info.category;
    const selected = row.id === activeId;
    button.classList.toggle('active', selected);
    button.classList.toggle('pending', row.id === pendingId);
    button.setAttribute('aria-pressed', String(selected));
    const media = el('span', undefined, 'ac-media');
    media.append(icon(CATEGORY_ICON[row.info.category] || 'cat-other', 'ac-glyph'));
    const image = documentRef.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    media.append(image);
    button._image = image;
    button._media = media;
    // Saved recipes carry no duration; an unknown length is omitted, not shown as 0s.
    if (row.duration > 0) media.append(el('span', formatSeconds(row.duration), 'ac-duration'));
    if (row.info.loop) media.append(icon('loop', 'ac-loop'));
    if (row.kind === 'matched' && row.source.presetVariant) media.append(el('span', '其他版本', 'ac-badge'));
    if (row.kind === 'saved') media.append(el('span', 'v' + row.source.number, 'ac-badge'));
    media.append(el('span', undefined, 'ac-playing'));
    const text = el('span', undefined, 'ac-text');
    text.append(el('b', row.label), el('small', row.info.title && row.info.title !== row.label ? row.info.title : row.name));
    button.append(media, text);
    button.title = row.name + ' · ' + categoryLabel(row.info.category) + (row.duration > 0 ? ' · ' + formatSeconds(row.duration) : '') + (row.source.sourceName ? '\n来源：' + row.source.sourceName : '');
    button.onclick = () => choose(row);
    if (hoverCapable) {
      button.onpointerenter = () => scheduleHover(button, row);
      button.onpointerleave = () => stopHover(button);
    }
    button._row = row;
    const known = cachedThumb(row);
    if (known) showThumb(button, known); else cardObserver ? cardObserver.observe(button) : void requestThumb(button, row);
    return button;
  }

  // ---------------------------------------------------------- thumbnails ---
  const thumbs = new Map();
  function cachedThumb(row) { return thumbs.get(subjectSha + '|' + row.id) || null; }
  function showThumb(button, url) {
    const image = button._image;
    if (!image) return;
    image.onload = () => button.classList.add('has-thumb');
    image.src = url;
  }

  function onCardsVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      cardObserver.unobserve(entry.target);
      if (entry.target._row) void requestThumb(entry.target, entry.target._row);
    }
  }

  function onSentinel(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.dataset.section;
      pages[id] = (pages[id] || PAGE) + PAGE;
      pageObserver.unobserve(entry.target);
      const scroller = $('abScroll'), top = scroller?.scrollTop;
      draw();
      if (scroller && top != null) scroller.scrollTop = top;
    }
  }

  async function requestThumb(button, row) {
    const value = target(), rig = ensureSubject();
    if (!value || !rig) return;
    const key = keyOf(value), wanted = () => button.isConnected && key === keyOf(target());
    try {
      let url = null;
      if (row.kind === 'own') url = await studio.ownAction(rig, row.clip, {priority: 1, wanted});
      else if (row.kind === 'matched') url = await studio.sharedAction(rig, value, row.source, {priority: 2, wanted});
      else if (row.kind === 'saved' && row.source.recipe?.id && studio.savedAction) {
        const {packId, versionId, clip, mappingId} = row.source.recipe;
        url = await studio.savedAction(rig, {...value, packId, versionId, clip, ...(mappingId ? {mappingId} : {})}, row, {priority: 2, wanted});
      }
      if (!url) return;
      thumbs.set(subjectSha + '|' + row.id, url);
      if (button.isConnected) showThumb(button, url);
    } catch (error) {
      button.classList.add('thumb-failed');
    }
  }

  // ---------------------------------------------------------------- hover ---
  function scheduleHover(button, row) {
    clearTimeout(hoverTimer);
    if (row.kind === 'saved') return;
    hoverTimer = setTimeout(() => void startHover(button, row), HOVER_DELAY);
  }

  async function startHover(button, row) {
    const value = target(), rig = ensureSubject();
    if (!value || !rig || !button.isConnected || body.dataset.mode !== 'library') return;
    let clip = row.clip;
    try {
      if (!clip) {
        const samples = Math.min(120, Math.max(12, Math.ceil(row.duration * 30) + 1));
        clip = await studio.sharedClip(rig, value, row.id, samples);
      }
    } catch { return; }
    if (button.matches?.(':hover') === false || !button.isConnected) return;
    liveCard = button;
    button.classList.add('live');
    studio.startLive(button._media, {subject: rig, clip});
  }

  function stopHover(button) {
    clearTimeout(hoverTimer);
    if (button && liveCard && button !== liveCard) return;
    liveCard?.classList.remove('live');
    liveCard = null;
    studio?.stopLive();
  }

  // ---------------------------------------------------------------- play ---
  async function choose(row) {
    const value = target();
    if (!value) return;
    stopHover();
    const ticket = generation, key = keyOf(value), mine = ++playTicket;
    if (row.kind === 'own') {
      pendingId = null;
      activeId = row.id;
      playOwn(row.name);
      markActive();
      return;
    }
    pendingId = row.id;
    markActive();
    const isCurrent = () => current(ticket, key) && mine === playTicket;
    try {
      if (row.kind === 'saved') await playSaved(row.source, isCurrent);
      else await playShared(row.source, isCurrent);
      if (!isCurrent()) return;
      activeId = row.id;
    } catch (error) {
      if (isCurrent()) onError(error);
    } finally {
      if (mine === playTicket) pendingId = null;
      markActive();
    }
  }

  function markActive() {
    for (const node of cards.values()) {
      const on = node.dataset.id === activeId;
      node.classList.toggle('active', on);
      node.classList.toggle('pending', node.dataset.id === pendingId);
      node.setAttribute('aria-pressed', String(on));
    }
  }

  // -------------------------------------------------------------- search ---
  let searchTimer;
  $('abSearch')?.addEventListener('input', event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = event.target.value; pages = {}; draw(); }, 90);
  });
  documentRef.addEventListener('keydown', event => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
    const tag = documentRef.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || body.dataset.mode !== 'library') return;
    event.preventDefault();
    $('abSearch')?.focus();
  });
  $('editThisAction')?.addEventListener('click', () => onEdit?.());

  const initialMode = readStored(MODE_KEY);
  setMode(initialMode === 'studio' ? 'studio' : 'library', {silent: true});

  return {
    sync,
    draw,
    setMode,
    mode: () => body.dataset.mode,
    loadCast,
    openGallery,
    refresh() { clearTimeout(pollTimer); void loadActions(); },
    cancelPreview() { playTicket++; pendingId = null; markActive(); },
    activeRow() {
      const all = [...saved, ...own, ...matched];
      return all.find(row => row.id === activeId) || null;
    }
  };
}
