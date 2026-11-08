import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomic, inside } from './core.mjs';
import { getProjectLink } from './project-context.mjs';

const MANIFEST = 'motion-stage.preview.json';
const LEASE_MS = 60_000;
const START_MS = 20_000;
const MAX_LEASES = 24;

async function smallFile(path, limit) {
 const info = await stat(path);
 if (!info.isFile() || info.size > limit) throw Error('预览声明或启动文件大小无效');
 const bytes = await readFile(path);
 if (bytes.length > limit) throw Error('预览声明或启动文件大小无效');
 return bytes;
}

async function discover(work) {
 const link = await getProjectLink(work);
 if (!link?.exists) return null;
 const root = await realpath(link.root);
 let bytes;
 try { bytes = await smallFile(await inside(root, MANIFEST), 16 * 1024); }
 catch (error) { if (error.code === 'ENOENT') return null; throw error; }
 const {version, entry, catalog} = JSON.parse(bytes.toString('utf8'));
 if (version !== 1 || typeof entry !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*\.mjs$/.test(entry) ||
     entry.split('/').some(part => part === '.' || part === '..') ||
     typeof catalog !== 'string' || !/^\/[\w.-]+(?:\/[\w.-]+)*$/.test(catalog) ||
     catalog.split('/').some(part => part === '.' || part === '..')) {
  throw Error('预览声明需要项目内的 .mjs 启动文件和本地目录路径');
 }
 const launcher = await realpath(await inside(root, entry));
 const source = await smallFile(launcher, 1024 * 1024);
 const fingerprint = createHash('sha256').update(bytes).update('\0').update(source).digest('hex');
 return {root, entry, launcher, catalog, fingerprint};
}

function trustFile(root, directory) {
 const key = createHash('sha256').update(root).digest('hex');
 return join(directory, key + '.json');
}

const defaultTrust = () => join(homedir(), '.motion-stage', 'preview-trust');

export async function trustManagedPreview(work, directory = defaultTrust()) {
 const spec = await discover(work);
 if (!spec) throw Error('关联项目未声明 ' + MANIFEST);
 await mkdir(directory, {recursive: true, mode: 0o700});
 await atomic(trustFile(spec.root, directory), {fingerprint: spec.fingerprint});
 return {project: spec.root, entry: spec.entry};
}

function start(spec) {
 const child = spawn(process.execPath, [spec.launcher], {
  cwd: spec.root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
 });
 let exited = false;
 const done = new Promise(resolve => {
  const finish = () => { exited = true; resolve(); };
  child.once('exit', finish);
  child.once('error', finish);
 });
 const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(Error('游戏预览服务启动超时')), START_MS);
  const onClose = () => finish(Error('游戏预览服务提前退出，请检查项目预览依赖'));
  const onMessage = message => {
   if (message?.type !== 'motion-stage-ready') return;
   const port = message.port;
   if (!Number.isInteger(port) || port < 1 || port > 65535) return finish(Error('游戏预览服务返回了无效端口'));
   finish(null, new URL(spec.catalog, 'http://127.0.0.1:' + port));
  };
  function finish(error, url) {
   clearTimeout(timer);
   child.off('exit', onClose);
   child.off('message', onMessage);
   if (error) reject(error); else resolve(url);
  }
  child.on('error', finish);
  child.once('exit', onClose);
  child.on('message', onMessage);
 });
 return {
  ready, done,
  async stop() {
   if (exited) return;
   // Disconnect lets a cooperative runner close its HTTP server and workers.
   if (child.connected) child.disconnect();
   const terminate = setTimeout(() => child.kill('SIGTERM'), 1200);
   const force = setTimeout(() => child.kill('SIGKILL'), 3500);
   try { await done; } finally { clearTimeout(terminate); clearTimeout(force); }
  },
 };
}

export function createManagedPreview(work, {trustDirectory = defaultTrust(), leaseMs = LEASE_MS} = {}) {
 const leases = new Map();
 let service, stopping, sweep, closed = false;

 function stop() {
  if (!service) return stopping;
  const previous = service;
  service = undefined;
  clearInterval(sweep);
  leases.clear();
  const stopped = previous.process.stop();
  stopping = stopped;
  void stopped.finally(() => { if (stopping === stopped) stopping = undefined; });
  return stopped;
 }

 function renew(id) {
  if (!leases.has(id)) return false;
  leases.set(id, Date.now() + leaseMs);
  return true;
 }

 async function release(id) {
  if (leases.delete(id) && !leases.size) await stop();
 }

 return {
  async acquire(id) {
   const spec = await discover(work);
   if (!spec) return null;
   let fingerprint;
   try { ({fingerprint} = JSON.parse((await smallFile(trustFile(spec.root, trustDirectory), 4096)).toString('utf8'))); }
   catch (error) { if (error.code !== 'ENOENT') throw error; }
   if (fingerprint !== spec.fingerprint) throw Error('请先审阅项目的预览入口，再用 runtime-trust 登记此项目');
   if (stopping) await stopping;
   if (closed) throw Error('动作台正在关闭');
   if (service && (service.root !== spec.root || service.fingerprint !== spec.fingerprint)) {
    throw Error('项目预览入口已变化，请关闭现有预览后再打开');
   }
   if (!leases.has(id) && leases.size >= MAX_LEASES) throw Error('预览窗口过多，请关闭闲置窗口');
   if (!service) {
    const current = {root: spec.root, fingerprint: spec.fingerprint, process: start(spec)};
    service = current;
    void current.process.done.then(() => { if (service === current) void stop(); });
    sweep = setInterval(() => {
     const now = Date.now();
     for (const [key, deadline] of leases) if (deadline <= now) leases.delete(key);
     if (!leases.size) void stop();
    }, Math.min(5000, leaseMs));
    sweep.unref();
   }
   leases.set(id, Date.now() + leaseMs);
   try {
    const url = await service.process.ready;
    if (!renew(id)) throw Error('游戏预览已关闭');
    return url;
   } catch (error) { await release(id); throw error; }
  },
  renew,
  release,
  close() { closed = true; return stop(); },
 };
}
