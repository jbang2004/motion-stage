import {resourceLabel} from './resource-capabilities.mjs';
import {element, createActionButton} from './ui.mjs';

// Same-query polls share one flight. New search intent retires old results,
// including A -> B -> A, without aborting an existing transport request.
export function createCatalogRequests({fetchPage, readCatalog = () => null, commit = () => {}}) {
  let query = '';
  let generation = 0;
  let active = null;
  let pending = null;

  const capture = () => ({query, generation});
  const isCurrent = ticket => Boolean(
    ticket && ticket.generation === generation && ticket.query === query
  );

  function item(more) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {...capture(), more, promise, resolve, reject};
  }

  function start(task) {
    active = task;
    void run(task);
  }

  async function run(task) {
    try {
      const existing = readCatalog(task.query);
      const base = [...(existing?.entries || [])];
      const append = task.more && base.length > 0;
      const offset = append ? base.length : 0;
      const wanted = append ? 100 : Math.max(100, base.length);
      const pages = [];

      // Pagination is sequential too; a large catalog cannot create a parallel
      // backlog of metadata reads while the next search waits.
      for (let i = 0; i < wanted; i += 200) {
        if (!isCurrent(task)) break;
        pages.push(await fetchPage({
          query: task.query,
          offset: offset + i,
          limit: Math.min(200, wanted - i)
        }));
      }
      if (!isCurrent(task)) {
        task.resolve(null);
        return;
      }
      const data = {
        ...pages[0],
        hasMore: pages.at(-1).hasMore,
        entries: [...(append ? base : []), ...pages.flatMap(page => page.entries)]
      };
      commit(data, task);
      task.resolve({...capture(), data});
    } catch (error) {
      if (isCurrent(task)) task.reject(error);
      else task.resolve(null);
    } finally {
      if (active === task) active = null;
      const next = pending;
      pending = null;
      if (next) start(next);
    }
  }

  return {
    capture,
    isCurrent,
    setQuery(value) {
      if (value === query) return false;
      query = value;
      generation++;
      if (pending) {
        pending.resolve(null);
        pending = null;
      }
      return true;
    },
    request({more = false} = {}) {
      if (active) {
        if (isCurrent(active) && (!more || active.more)) return active.promise;
        if (pending) {
          if (more) pending.more = true;
          return pending.promise;
        }
        pending = item(more);
        return pending.promise;
      }
      const task = item(more);
      start(task);
      return task.promise;
    }
  };
}

function scanDescription(scan) {
  switch (scan.state) {
    case 'scanning': return '正在扫描 · 已检查 ' + scan.visitedFiles + ' 个文件';
    case 'partial': return '扫描未完整完成，可缩小目录范围后刷新';
    case 'failed': return '扫描失败：' + scan.error;
    case 'interrupted': return '上次扫描被中断，请刷新目录';
    default: return '';
  }
}

function badge(row, selected) {
  if (selected) return '当前模型';
  if (row.origin === 'teaching') return '教学示例';
  if (row.status === 'source-only') return '制作源';
  if (row.status === 'missing') return '源文件缺失';
  if (row.status === 'invalid') return '无法预览';
  if(row.metadata?.capabilities)return resourceLabel(row.metadata.capabilities);
  if (row.metadata?.kind === 'skeleton') return '骨架资源';
  if (row.character) return row.confirmed ? '项目已关联' : '待确认角色';
  return row.format === 'fbx' && !row.opened ? '首次打开时转换' : '可预览';
}

// The catalog owns its data, search and DOM. The host supplies only its current
// selection/jobs and explicit navigation events; model/view transactions stay
// with onOpen in app.js. onChange preserves the public state.catalog snapshot.
export function createModelCatalog({
  api, getView, onOpen, onChooseFolder, onError, onChange = () => {},
  document = globalThis.document, defaultView = 'auto'
}) {
  const $ = id => document.getElementById(id);
  const el = (tag, text, className) => element(tag, text, className, document);
  const button = (label, action, className) => createActionButton(label, action, {
    className, ownerDocument: document, onError
  });
  let data = null;
  let query = '';
  let displayedQuery = null;
  let autoOpened = false;
  let searchTimer;
  let mode = defaultView;
  const intent = () => JSON.stringify([mode, query]);
  const requests = createCatalogRequests({
    fetchPage: ({query: key, offset, limit}) => {
      const [view, text] = JSON.parse(key);
      return api((view !== 'files' ? '/api/characters' : '/api/catalog') +
        '?'+(view==='auto'?'preferMapped=true&':'')+'query=' + encodeURIComponent(text) + '&offset=' + offset + '&limit=' + limit);
    },
    readCatalog: wantedQuery => displayedQuery === wantedQuery ? data : null,
    commit(next, ticket) {
      data = next;
      displayedQuery = ticket.query;
      onChange(data);
      draw();
    }
  });
  requests.setQuery(intent());

  function message(text, error = false) {
    $('catalogStatus').textContent = text;
    $('catalogStatus').classList.toggle('catalog-error', error);
  }

  function rowCard(row, view) {
    const selected = row.id === view.activeAssetId;
    const card = el('article', undefined, 'model-card' + (selected ? ' selected' : ''));
    const copy = el('div', undefined, 'model-card-copy');
    const actions = el('div', undefined, 'model-card-actions');
    copy.append(
      el('strong', row.name),
      el('small', row.relativePath || (row.origin === 'teaching' ? '原创教学素材' : '手动导入的素材'))
    );
    const clips = row.metadata?.clips;
    const info = [
      row.format.toUpperCase(),
      row.bytes !== undefined ? (row.bytes / 1048576).toFixed(1) + ' MB' : '',
      clips ? (clips.length ? clips.length + ' 个动作' : resourceLabel(row.metadata?.capabilities)) : ''
    ];
    copy.append(el('small', info.filter(Boolean).join(' · ')));
    if (row.character) {
      copy.append(el('small', '模型内 ' + row.embeddedCount + ' 个动作' +
        (row.variants?.length ? ' · ' + row.variants.length + ' 个模型版本' : '')));
      if (row.motionSources?.length) {
        const details = el('details');
        details.append(el('summary', '外部动作来源（' + row.motionSources.length + '）'));
        const labels = {ready:'已载入', declared:'待校验', 'needs-retarget':'需要重定向',
          'needs-confirmation':'需要确认', unsupported:'需要转换', missing:'缺失', unavailable:'不可用'};
        for (const source of row.motionSources) details.append(el('small', source.file + ' · ' +
          (labels[source.status] || source.status) + ' · ' + (source.clips?.length ?? source.count) + ' 个动作' +
          (source.error ? ' · ' + source.error : ''), source.error ? 'catalog-error' : ''));
        copy.append(details);
      }
    }
    const jobs = (view.jobs||[]).filter(job => (job.assetId || 'legacy') === row.id);
    const pendingJobs = jobs.filter(job => ['queued', 'running', 'needs-input'].includes(job.state));
    const pendingCount=view.jobCounts?.[row.id]?.active??pendingJobs.length;
    if (pendingCount) copy.append(el('small', pendingCount + ' 条任务处理中'));
    else if (row.hasCandidate) copy.append(el('small', '已有独立候选，可继续查看'));
    if (row.error) copy.append(el('small', row.error, 'catalog-error'));
    actions.append(el('span', badge(row, selected), 'catalog-badge'));

    const previewable = ['glb', 'fbx','json'].includes(row.format);
    const openOptions = row.character ? {character: true} : undefined;
    if (row.opened || previewable && row.status === 'available') {
      const open = button(selected ? '继续查看' : row.opened ? '打开' : '预览',
        () => openOptions ? onOpen(row.id, openOptions) : onOpen(row.id), 'secondary-button');
      open.disabled = view.switching;
      actions.append(open);
    }
    if ((row.sourceChanged || row.opened && row.origin === 'project' && row.format === 'fbx') && row.status === 'available') {
      const update = button(row.sourceChanged ? '载入源文件新版本' : '重新转换 FBX',
        () => onOpen(row.id, {...openOptions, refreshSource: true}), 'text-button');
      update.disabled = view.switching;
      actions.append(update);
    }
    if (!row.character && row.origin === 'project' && row.format === 'glb' && row.status === 'available' &&
      view.activeAssetId?.startsWith('character-')) {
      const associate = button('关联到当前角色', async () => {
        const ticket = requests.capture();
        const result = await api('/api/characters/' + encodeURIComponent(view.activeAssetId) + '/associate', 'POST', {assetId:row.id});
        if (!requests.isCurrent(ticket) || getView().activeAssetId !== view.activeAssetId) return;
        await switchMode('characters');
        message(result.message);
      }, 'text-button');
      associate.disabled = view.switching;
      actions.append(associate);
    }
    card.append(copy, actions);
    return card;
  }

  function draw() {
    if (!data) return;
    const host = $('modelList');
    const view = getView();
    host.replaceChildren();
    $('modelCount').textContent = (data.sourceTotal??data.total)+' 文件';
    if ($('sidebarModelCount')) $('sidebarModelCount').textContent = (data.sourceTotal??data.total)+' 文件';
    const scan = data.scan || {};
    const scanning = scan.state === 'scanning';
    $('refreshCatalog').disabled = scanning;
    const scanLabel = scanDescription(scan);
    const roles = data.kind === 'characters';
    $('catalogCharacters')?.setAttribute('aria-pressed',String(roles));$('catalogFiles')?.setAttribute('aria-pressed',String(!roles));
    const title = data.linked ? roles ? '已关联 ' + data.confirmedTotal + ' 个角色 · ' +
      (data.total - data.confirmedTotal) + ' 个待确认候选 · ' + data.sourceTotal + ' 个项目资源文件' :
      '项目文件共 ' + data.total + ' 项，包含模型、动作、制作源及构建副本；这不是角色数量' : '关联项目文件夹后，自动发现其中的模型';
    message(title + (scanLabel ? ' · ' + scanLabel : '') +
      (scan.warnings?.length ? ' · ' + scan.warnings.join('；') : ''),
      ['failed', 'partial', 'interrupted'].includes(scan.state));
    for (const row of data.entries) host.append(rowCard(row, view));
    if (!data.entries.length) {
      const text = query ? '没有匹配的模型。' : scanning ? '正在发现模型，请稍候…' :
        '此目录暂未发现资源。支持 GLB、采样动作 JSON 和按需转换的 FBX。';
      host.append(el('p', text, 'clip-empty'));
    }
    $('catalogMore').hidden = !data.hasMore;
    $('catalogMore').textContent = '加载更多（已显示 ' + data.entries.length + ' / ' + data.matched + '）';
  }

  async function refresh({more = false} = {}) {
    const ticket = requests.capture();
    let result;
    try {
      result = await requests.request({more});
    } catch (error) {
      if (requests.isCurrent(ticket)) throw error;
      return;
    }
    if (!requests.isCurrent(result) || data !== result.data) return;
    const current = result.data;
    if (!autoOpened && current.linked && current.scan.state !== 'scanning' && getView().allowAutomaticOpen) {
      const playable = row => row.format === 'glb' && row.status === 'available' && row.origin === 'project';
      autoOpened = true;
      // The file view lists paths alphabetically, where the first GLB may be a prop
      // or a motion pack. Start with what the 角色 rail shows first instead: declared
      // characters, else discovered rigged models, opened under the same identity.
      let first = null;
      if (mode === 'files') {
        try { first = (await api('/api/characters?preferMapped=true&query=&offset=0&limit=20')).entries?.find(playable) || null; } catch {}
      }
      first ||= current.entries.find(playable);
      // This runs after the request flight releases. onOpen can refresh the
      // catalog itself without waiting on the promise currently invoking it.
      if (first) await onOpen(first.id, ...(first.character ? [{character:true}] : []));
      else if (!document.querySelector('dialog[open]')) $('modelCatalogDialog').showModal();
    }
  }

  const showError = error => message(error.message, true);
  async function switchMode(next) {
    clearTimeout(searchTimer);
    mode = next;
    requests.setQuery(intent());
    for (const [id, view] of [['catalogCharacters','characters'],['catalogFiles','files']]) {
      $(id)?.setAttribute('aria-pressed', String(mode === view));
    }
    await refresh();
  }
  if ($('catalogCharacters')) $('catalogCharacters').onclick = () => switchMode('characters').catch(showError);
  if ($('catalogFiles')) $('catalogFiles').onclick = () => switchMode('files').catch(showError);
  const openCatalog = () => {
    $('modelCatalogDialog').showModal();
    return refresh().catch(showError);
  };
  $('openModelCatalog').onclick = openCatalog;
  if ($('navCatalog')) $('navCatalog').onclick = openCatalog;
  $('refreshCatalog').onclick = async () => {
    try {
      await api('/api/catalog/scan', 'POST', {});
      await refresh();
    } catch (error) { showError(error); }
  };
  $('catalogChooseFolder').onclick = () => {
    $('modelCatalogDialog').close();
    onChooseFolder();
  };
  $('catalogMore').onclick = () => refresh({more: true}).catch(showError);
  $('modelSearch').oninput = () => {
    clearTimeout(searchTimer);
    query = $('modelSearch').value;
    requests.setQuery(intent());
    searchTimer = setTimeout(() => { refresh().catch(showError); }, 200);
  };
  return {refresh, draw, message};
}
