import {readFile, stat} from 'node:fs/promises';
import {ROOT, atomic, inside, modelSlots, readProject, withWorkspaceLock} from './core.mjs';
import {getProjectLink} from './project-context.mjs';
import {parseOfflineState} from '../assets/viewer/offline-state.mjs';
import {runtimeStageSource} from '../assets/viewer/runtime-stage.mjs';

const CONFIG = 'runtime-preview.json';
const OFFLINE_CATALOG = 'motion-stage.states.json';
const MAX_CATALOG_BYTES = 256 * 1024;
const CAPABILITIES = ['characterMaterials', 'equipment', 'liveCloth', 'sceneLighting', 'candidateClips'];

function catalogURL(value) {
 const url = new URL(value);
 if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
     url.username || url.password || url.hash) {
  throw Error('游戏状态目录必须使用 http://127.0.0.1:端口/路径');
 }
 return url;
}

export async function connectRuntimePreview(work, address) {
 const catalog = catalogURL(address).href;
 return withWorkspaceLock(work, async () => {
  const link = await getProjectLink(work);
  if (!link?.exists) throw Error('请先关联游戏项目');
  const config = {version: 1, projectId: link.id, catalog};
  await atomic(await inside(work, CONFIG), config);
  return {catalog};
 });
}

async function readCatalog(url) {
 const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(4000)});
 if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
  await response.body?.cancel();
  throw Error('游戏状态目录未返回 JSON，请检查游戏服务和目录地址');
 }
 const chunks = [];
 let size = 0;
 for await (const chunk of response.body) {
  size += chunk.length;
  if (size > MAX_CATALOG_BYTES) throw Error('游戏状态目录超过 256 KiB');
  chunks.push(chunk);
 }
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function characterStates(catalog, keys) {
 if (catalog?.version !== 1 || !catalog.characters ||
     typeof catalog.characters !== 'object' || Array.isArray(catalog.characters)) {
  throw Error('游戏状态目录格式不兼容');
 }
 const key = keys.find(key => Object.hasOwn(catalog.characters, key));
 if (!key) return [];
 const states = catalog.characters[key];
 if (!Array.isArray(states) || states.length > 200) throw Error('每个角色最多可提供 200 个游戏状态');
 return states;
}

function readCapabilities(capabilities) {
 if (capabilities === undefined) return;
 if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities) ||
     CAPABILITIES.some(key => Object.hasOwn(capabilities, key) && typeof capabilities[key] !== 'boolean')) {
  throw Error('游戏预览能力声明无效');
 }
 return Object.fromEntries(CAPABILITIES.filter(key => Object.hasOwn(capabilities, key)).map(key => [key, capabilities[key]]));
}

function readStates(catalog, keys, origin) {
 const states = characterStates(catalog, keys), ids = new Set();
 return states.map(state => {
  const {id, label, path, stage, capabilities} = state || {};
  if (typeof id !== 'string' || !/^[\w.-]{1,80}$/.test(id) || ids.has(id) ||
      typeof label !== 'string' || !label.trim() || label.length > 100 ||
      typeof path !== 'string' || path.length > 2048 || !path.startsWith('/') ||
      path.startsWith('//') || /[\\\s\x00-\x1f\x7f]/.test(path)) {
   throw Error('游戏状态的名称、标识或预览路径无效');
  }
  const url = new URL(path, origin);
  if (url.origin !== origin) throw Error('预览页须由同一个游戏服务提供');
  if (stage !== undefined && (!stage || typeof stage.file !== 'string' || !stage.file || stage.file.length > 500 ||
      stage.file.startsWith('/') || stage.file.includes('\\') || stage.file.split('/').some(part => !part || part === '.' || part === '..') ||
      typeof stage.clip !== 'string' || !stage.clip || stage.clip.length > 300 ||
      typeof stage.key !== 'string' || !stage.key || stage.key.length > 300 ||
      stage.character!==undefined&&(typeof stage.character!=='string'||!/^[-\w]{1,80}$/.test(stage.character)))) {
   throw Error('主视窗预览的动作来源无效');
  }
  ids.add(id);
  return {id, label: label.trim(), url: url.href, ...(stage && {stage:{file:stage.file, clip:stage.clip, key:stage.key,
   ...(stage.character&&{character:stage.character})}}),
   ...(capabilities !== undefined && {capabilities:readCapabilities(capabilities)})};
 });
}

function characterKeys(project, assetId) {
 const source = modelSlots(project, assetId || project.activeAssetId).baseline?.source;
 return [source?.assembly?.profileId, source?.projectRelativePath].filter(Boolean);
}

export async function offlinePreviewStatus(work, assetId) {
 const unavailable = message => ({states: [], message});
 try {
  const [project, link] = await Promise.all([readProject(work), getProjectLink(work)]);
  if (!link?.exists) return unavailable('请先关联游戏项目');
  const keys = characterKeys(project, assetId);
  if (!keys.length) return unavailable('当前素材尚未关联到游戏角色');
  const path = await inside(link.root, OFFLINE_CATALOG);
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CATALOG_BYTES) throw Error('离线状态目录须为 256 KiB 以内的 JSON 文件');
  const bytes = await readFile(path);
  if (bytes.length > MAX_CATALOG_BYTES) throw Error('离线状态目录超过 256 KiB');
  const states = characterStates(JSON.parse(bytes), keys).map(parseOfflineState);
  if (new Set(states.map(state => state.id)).size !== states.length) throw Error('离线状态标识重复');
  return {states, message: states.length ? '' : '游戏未为当前角色提供离线状态'};
 } catch (error) {
  if (error.code === 'ENOENT') return unavailable('此项目尚未提供离线状态');
  if (error instanceof SyntaxError) return unavailable('离线状态目录包含无效的 JSON');
  return unavailable(error.message);
 }
}

export async function runtimePreviewStatus(work, assetId, studioOrigin, managedCatalog) {
 const unavailable = message => ({states: [], message});
 const needsSetup = message => ({states: [], message, code: 'PREVIEW_SETUP_REQUIRED'});
 try {
  const [project, link] = await Promise.all([readProject(work), getProjectLink(work)]);
  if (!link?.exists) return unavailable('请先关联游戏项目');
  const keys = characterKeys(project, assetId);
  if (!keys.length) return unavailable('当前素材尚未关联到游戏角色');
  const config = managedCatalog ? null : await readFile(await inside(work, CONFIG), 'utf8').then(JSON.parse).catch(error => {
   if (error.code === 'ENOENT') return null;
   throw error;
  });
  if (!managedCatalog && (!config || config.projectId !== link.id)) {
   return needsSetup(config ? '请为当前游戏项目连接状态目录' : '此工作区尚未连接游戏状态目录');
  }
  if (config && config.version !== 1) return unavailable('游戏状态连接配置格式不兼容');
  const url = managedCatalog || catalogURL(config.catalog);
  if (url.origin === studioOrigin) return unavailable('游戏服务须使用独立于动作台的端口');
  const states = readStates(await readCatalog(url), keys, url.origin);
  return {states, message: states.length ? '' : '游戏未为当前角色提供可预览的状态',
   ...(!states.length && {code: 'PREVIEW_CHARACTER_UNMAPPED'})};
 } catch (error) {
  if (error instanceof TypeError && error.cause || error.name === 'TimeoutError' || error.name === 'AbortError') {
   return unavailable('无法读取游戏状态目录，请检查游戏服务后刷新');
  }
  if (error instanceof SyntaxError) return unavailable('游戏状态目录包含无效的 JSON');
  return unavailable(error.message);
 }
}

export async function runtimePreviewHandoff(work, {assetId, clip}, caller, sendToCaller) {
 const [project, link] = await Promise.all([readProject(work), getProjectLink(work)]);
 if (!link?.exists) throw Error('请先关联游戏项目');
 if (typeof assetId !== 'string' || !assetId) throw Error('请先选择游戏角色');
 const model = modelSlots(project, assetId).baseline;
 if (!model?.source?.projectRelativePath) throw Error('请先打开项目中的原版素材');
 if (clip !== null && (typeof clip !== 'string' || !model.clips?.some(action => action.name === clip))) {
  throw Error('当前动作已变化，请重新选择');
 }
 const action = clip === null ? null : {name: clip, ...runtimeStageSource(model.source, clip)};
 const task = {
  version: 1, kind: 'runtime-preview-setup', caller, workspace: work,
  project: {name: link.name, root: link.root},
  character: {assetId, name: project.models[assetId].name || model.label,
   profileId: model.source.assembly?.profileId ?? null, modelFile: model.source.projectRelativePath},
  action,
 };
 const prompt = [
  '请为下面的项目接入 MotionStage 的「游戏角色」预览。', JSON.stringify(task, null, 2),
  '先读取接入协议 ' + ROOT + '/references/runtime-preview.md ，再核对项目的角色注册表、动作来源和渲染入口。',
  '优先复用项目现有入口和角色构造逻辑。提供项目级目录及按需启动的预览入口，保留正式角色资产和游戏逻辑。',
  '审阅预览入口后，按协议登记并在动作台主视口验证当前角色和动作，确认关闭后预览服务退出。报告实际覆盖的游戏效果。',
 ].join('\n');
 let delivery = 'copy';
 if (caller && sendToCaller) {
  try {
   if (await sendToCaller({caller, task, prompt}) === true) delivery = 'sent';
  } catch { /* The visible prompt remains available when the host cannot confirm delivery. */ }
 }
 return {task, prompt, delivery};
}
