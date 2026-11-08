import {readFile, stat} from 'node:fs/promises';
import {atomic, inside, modelSlots, readProject, withWorkspaceLock} from './core.mjs';
import {getProjectLink} from './project-context.mjs';
import {parseOfflineState} from '../assets/viewer/offline-state.mjs';

const CONFIG = 'runtime-preview.json';
const OFFLINE_CATALOG = 'motion-stage.states.json';
const MAX_CATALOG_BYTES = 256 * 1024;

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

function readStates(catalog, keys, origin) {
 const states = characterStates(catalog, keys), ids = new Set();
 return states.map(state => {
  const {id, label, path, stage} = state || {};
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
      typeof stage.key !== 'string' || !stage.key || stage.key.length > 300)) {
   throw Error('主视窗预览的动作来源无效');
  }
  ids.add(id);
  return {id, label: label.trim(), url: url.href, ...(stage && {stage:{file:stage.file, clip:stage.clip, key:stage.key}})};
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
 try {
  const config = managedCatalog ? null : JSON.parse(await readFile(await inside(work, CONFIG), 'utf8'));
  const [project, link] = await Promise.all([readProject(work), getProjectLink(work)]);
  if (!link?.exists || config && (config.version !== 1 || config.projectId !== link.id)) {
   return unavailable('请为当前游戏项目连接状态目录');
  }
  const keys = characterKeys(project, assetId);
  if (!keys.length) return unavailable('当前素材尚未关联到游戏角色');
  const url = managedCatalog || catalogURL(config.catalog);
  if (url.origin === studioOrigin) return unavailable('游戏服务须使用独立于动作台的端口');
  const states = readStates(await readCatalog(url), keys, url.origin);
  return {states, message: states.length ? '' : '游戏未为当前角色提供可预览的状态'};
 } catch (error) {
  if (error.code === 'ENOENT') return unavailable('此工作区尚未连接游戏状态目录');
  if (error instanceof TypeError && error.cause || error.name === 'TimeoutError' || error.name === 'AbortError') {
   return unavailable('无法读取游戏状态目录，请检查游戏服务后刷新');
  }
  if (error instanceof SyntaxError) return unavailable('游戏状态目录包含无效的 JSON');
  return unavailable(error.message);
 }
}
