import {
  readFile,
  writeFile,
  mkdir,
  rename,
  realpath,
  lstat,
  rm,
  open,
  stat,
  readdir,
} from 'node:fs/promises';
import {resolve, dirname, sep} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {AsyncLocalStorage, AsyncResource} from 'node:async_hooks';
import {channel} from 'node:diagnostics_channel';
import {pathWithin} from './platform-runtime.mjs';

const JOURNAL = '.motion-transaction.json';
const TICKET = /^\.motion-write\.ticket-([a-f0-9-]{36})\.json$/;
const ownership = new AsyncLocalStorage();
const pendingReleases = new Map();
const processQueues = new Map();
const windowsBusy = new Set(['EPERM', 'EACCES', 'EBUSY']);
const ioRetries = channel('motion-workspace.io-retry');

const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
const missing = error => error.code === 'ENOENT';
const pause = () => new Promise(resolve => setTimeout(resolve, 20));

function busy(phase) {
  return Object.assign(Error('工作区正在写入或恢复，请稍后重试'), {
    code: 'WORKSPACE_BUSY',
    workspaceLock: {phase},
  });
}

function beforeDeadline(deadline, phase) {
  if (Date.now() >= deadline) throw busy(phase);
}

// Windows sharing violations: retry the same operation, never unlink a target
// before replacing it or fall back to writing in place. Exhausted errors retain
// native details; the diagnostic channel reports retries and their outcome.
async function windowsIO(operation, paths, run) {
  const started = Date.now();
  const maxAttempts = 12;

  for (let attempts = 1; ; attempts++) {
    let result;
    try {
      result = await run();
    } catch (error) {
      const retry = process.platform === 'win32' && windowsBusy.has(error.code);
      const details = {
        operation,
        ...paths,
        attempts,
        elapsedMs: Date.now() - started,
        code: error.code,
        maxAttempts,
      };

      if (!retry || attempts === maxAttempts) {
        if (attempts > 1) {
          error.workspaceIO = details;
          ioRetries.publish({status: 'failed', ...details});
          error.message += ' (Windows ' + operation + ' failed after ' + attempts
            + ' attempts in ' + details.elapsedMs + ' ms)';
        }
        throw error;
      }

      // Jitter avoids colliding with peers polling tickets every 20 ms.
      const delayMs = Math.min(10 * 2 ** (attempts - 1), 100) + Math.floor(Math.random() * 10);
      ioRetries.publish({status: 'retrying', ...details, delayMs});
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    if (attempts > 1) {
      ioRetries.publish({status: 'recovered', operation, ...paths, attempts, elapsedMs: Date.now() - started});
    }
    return result;
  }
}

const replaceFile = (source, path) => windowsIO('replace', {source, path}, () => rename(source, path));
const removePath = (path, options) => windowsIO('remove', {path}, () => rm(path, options));
const readStoredFile = (path, ...options) => windowsIO('read', {path}, () => readFile(path, ...options));

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code);
    const windowsDirectory = process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code);
    if (!unsupported && !windowsDirectory) throw error;
  } finally {
    await handle?.close();
  }
}

async function preparedFile(path, data) {
  await mkdir(dirname(path), {recursive: true});
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomic(path, value, {durable = false} = {}) {
  const data = Buffer.isBuffer(value) ? value : encode(value);
  const temp = path + '.' + randomUUID() + '.tmp';
  await mkdir(dirname(path), {recursive: true});
  try {
    if (durable) await preparedFile(temp, data);
    else await writeFile(temp, data);
    await replaceFile(temp, path);
    if (durable) await syncDirectory(dirname(path));
  } finally {
    await removePath(temp, {force: true}).catch(() => {});
  }
}

async function safePath(work, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw Error('无效事务文件路径');
  const path = resolve(work, name);
  if (!pathWithin(work, path)) throw Error('事务文件超出工作区');

  let parent = path;
  for (;;) {
    try {
      if (!pathWithin(work, await realpath(parent))) throw Error('事务符号链接超出工作区');
      break;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    parent = dirname(parent);
  }
  return path;
}

function validTarget(name) {
  const normalized = name.split(sep).join('/');
  return normalized !== JOURNAL
    && !normalized.split('/').includes('.motion-write.lock')
    && !normalized.split('/').includes('..')
    && !normalized.endsWith('.tmp');
}

async function validateJournal(work, journal) {
  if (journal.version !== 1
    || !/^[-a-f0-9]{36}$/.test(journal.id || '')
    || !Array.isArray(journal.writes)
    || !journal.writes.length
    || journal.writes.length > 1000) {
    throw Error('工作区事务日志格式无效；保留现场，未继续写入');
  }

  const files = new Set();
  for (const write of journal.writes) {
    if (!validTarget(write.file)
      || files.has(write.file)
      || typeof write.data !== 'string'
      || digest(write.data) !== write.sha256) {
      throw Error('工作区事务日志校验失败；保留现场');
    }
    files.add(write.file);
    await safePath(work, write.file);
    if (write.temp !== write.file + '.txn-' + journal.id + '.tmp') throw Error('工作区事务暂存路径无效');
    await safePath(work, write.temp);
  }
}

async function applyJournal(work, journal, checkpoint = () => {}) {
  await validateJournal(work, journal);
  for (const [index, write] of journal.writes.entries()) {
    const path = await safePath(work, write.file);
    const temp = await safePath(work, write.temp);
    const existing = await readStoredFile(path).catch(error => {
      if (!missing(error)) throw error;
      return null;
    });

    if (!existing || digest(existing) !== write.sha256) {
      const staged = await readStoredFile(temp).catch(error => {
        if (!missing(error)) throw error;
        return null;
      });
      if (staged && digest(staged) === write.sha256) {
        await replaceFile(temp, path);
        await syncDirectory(dirname(path));
      } else {
        await atomic(path, write.data, {durable: true});
      }
    }
    await checkpoint({phase: 'applied', index, file: write.file, id: journal.id});
  }

  // The journal remains the recovery authority until every target is durable.
  await removePath(resolve(work, JOURNAL));
  await syncDirectory(work);
  for (const write of journal.writes) await removePath(await safePath(work, write.temp), {force: true});
  await checkpoint({phase: 'committed', id: journal.id});
}

async function recoverLocked(work) {
  let raw;
  try {
    const path = resolve(work, JOURNAL);
    if ((await stat(path)).size > 256 * 1024 * 1024) throw Error('工作区事务日志过大；未继续写入');
    raw = await readStoredFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }

  let journal;
  try {
    journal = JSON.parse(raw);
  } catch {
    throw Error('工作区事务日志损坏；保留现场，未继续写入');
  }
  await applyJournal(work, journal);
  return true;
}

// Local FIFO: one filesystem contender per canonical workspace and process.
// Expired waiters never publish tickets. Bound callbacks retain their own async
// context even when the preceding request starts their turn.
function advanceProcessQueue(work, queue) {
  if (queue.active) return;
  let next;
  while ((next = queue.waiting.shift())) {
    clearTimeout(next.timer);
    if (Date.now() >= next.deadline) {
      next.reject(busy('local-queue'));
      continue;
    }

    queue.active = true;
    const finished = () => {
      queue.active = false;
      advanceProcessQueue(work, queue);
    };
    Promise.resolve().then(next.run).then(
      value => { next.resolve(value); finished(); },
      error => { next.reject(error); finished(); },
    );
    return;
  }
  if (processQueues.get(work) === queue) processQueues.delete(work);
}

function expireProcessTurn(work, queue, entry) {
  const index = queue.waiting.indexOf(entry);
  if (index < 0) return;
  queue.waiting.splice(index, 1);
  entry.reject(busy('local-queue'));
  if (!queue.active) advanceProcessQueue(work, queue);
}

function processTurn(work, deadline, run) {
  let queue = processQueues.get(work);
  if (!queue) {
    queue = {active: false, waiting: []};
    processQueues.set(work, queue);
  }

  return new Promise((resolveTurn, reject) => {
    const entry = {deadline, run: AsyncResource.bind(run), resolve: resolveTurn, reject, timer: null};
    entry.timer = setTimeout(() => expireProcessTurn(work, queue, entry), Math.max(0, deadline - Date.now()));
    queue.waiting.push(entry);
    advanceProcessQueue(work, queue);
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// Cross-process bakery tickets have unique paths. Reaping a dead ticket cannot
// delete a newer owner's ticket; compatibility-lock cleanup happens only after
// this ordering grants access.
async function readLiveTickets(work) {
  const rows = [];
  for (const file of await readdir(work)) {
    const match = file.match(TICKET);
    if (!match) continue;
    let raw;
    try {
      raw = await readStoredFile(resolve(work, file), 'utf8');
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }

    let row;
    try {
      row = JSON.parse(raw);
    } catch (cause) {
      throw Error('写入锁票据损坏，未继续写入：' + file, {cause});
    }
    if (row.nonce !== match[1]
      || !Number.isInteger(row.pid)
      || row.pid <= 0
      || !Number.isSafeInteger(row.number)
      || row.number < 0
      || typeof row.choosing !== 'boolean') {
      throw Error('写入锁票据格式无效：' + file);
    }

    if (!isProcessAlive(row.pid)) {
      await removePath(resolve(work, file), {force: true});
      continue;
    }
    rows.push({...row, file});
  }
  return rows;
}

function canPassTicket(current, own) {
  return !current || (!current.choosing && (
    current.number > own.number
    || (current.number === own.number && current.nonce > own.nonce)
  ));
}

async function waitForTicketOrder(work, own, deadline) {
  for (const peer of await readLiveTickets(work)) {
    if (peer.nonce === own.nonce) continue;
    for (;;) {
      await drainPendingReleases(work);
      const current = (await readLiveTickets(work)).find(ticket => ticket.nonce === peer.nonce);
      if (canPassTicket(current, own)) break;
      beforeDeadline(deadline, 'ticket-order');
      await pause();
    }
  }
}

async function acquireTicket(work, deadline) {
  beforeDeadline(deadline, 'ticket-start');
  const nonce = randomUUID();
  const file = '.motion-write.ticket-' + nonce + '.json';
  const path = resolve(work, file);
  const own = {nonce, pid: process.pid, choosing: true, number: 0};
  await atomic(path, own);

  try {
    await drainPendingReleases(work);
    const maximum = (await readLiveTickets(work)).reduce((number, ticket) => Math.max(number, ticket.number), 0);
    own.number = maximum + 1;
    own.choosing = false;
    if (!Number.isSafeInteger(own.number)) throw Error('写入锁票据序号超出范围');
    await atomic(path, own);
    await waitForTicketOrder(work, own, deadline);
    beforeDeadline(deadline, 'ticket-ready');
    return {nonce, path};
  } catch (error) {
    await releaseWhenPossible(work, {ticket: {nonce, path}, acquired: false, failure: error});
    throw error;
  }
}

async function readLockOwner(lock) {
  return JSON.parse(await readStoredFile(resolve(lock, 'owner.json'), 'utf8'));
}

async function removeAbandonedCompatibilityLock(lock) {
  try {
    const owner = await readLockOwner(lock);
    if (Number.isInteger(owner.pid) && owner.pid > 0 && !isProcessAlive(owner.pid)) {
      await removePath(lock, {recursive: true, force: true});
      return true;
    }
  } catch (error) {
    if (!missing(error)) throw error;
    const entry = await lstat(lock).catch(error => {
      if (missing(error)) return null;
      throw error;
    });
    if (entry && Date.now() - entry.mtimeMs > 30000) {
      await removePath(lock, {recursive: true, force: true});
      return true;
    }
  }
  return false;
}

async function acquireCompatibilityLock(work, lock, nonce, deadline) {
  for (;;) {
    beforeDeadline(deadline, 'owner');
    await drainPendingReleases(work);
    try {
      await mkdir(lock);
      try {
        await writeFile(resolve(lock, 'owner.json'), JSON.stringify({pid: process.pid, nonce, at: Date.now()}));
      } catch (error) {
        await removePath(lock, {recursive: true, force: true});
        throw error;
      }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await removeAbandonedCompatibilityLock(lock)) continue;
      beforeDeadline(deadline, 'owner');
      await pause();
    }
  }
}

// Release recovery retains the unique ticket as a barrier until nonce-checked
// directory cleanup and ticket removal finish. Each workspace shares one drain
// promise; later calls can resume a failed or partially completed release.
async function finishRelease(nonce, record) {
  try {
    if (record.acquired && !record.lockReleased) {
      const owner = await readLockOwner(record.lock).catch(error => {
        if (missing(error)) return null;
        throw error;
      });
      if (owner?.nonce === nonce || (!owner && record.removingLock)) {
        record.removingLock = true;
        await removePath(record.lock, {recursive: true, force: true});
      }
      record.lockReleased = true;
    }
    await removePath(record.ticket.path, {force: true});
  } catch (error) {
    if (record.failure && error !== record.failure) error.cause ??= record.failure;
    throw error;
  }
}

async function drainReleaseGroup(work, group) {
  try {
    while (group.records.size) {
      const [nonce, record] = group.records.entries().next().value;
      await finishRelease(nonce, record);
      group.records.delete(nonce);
    }
  } finally {
    group.promise = null;
    if (!group.records.size && pendingReleases.get(work) === group) pendingReleases.delete(work);
  }
}

async function drainPendingReleases(work) {
  const group = pendingReleases.get(work);
  if (!group) return;
  if (!group.promise) group.promise = drainReleaseGroup(work, group);
  return group.promise;
}

function releaseWhenPossible(work, record) {
  let group = pendingReleases.get(work);
  if (!group) {
    group = {records: new Map(), promise: null};
    pendingReleases.set(work, group);
  }
  group.records.set(record.ticket.nonce, record);
  return drainPendingReleases(work);
}

async function runOwnedCallback(work, fn, deadline) {
  const held = new Map(ownership.getStore() || []);
  const ownerToken = {active: true};
  held.set(work, ownerToken);
  try {
    return await ownership.run(held, async () => {
      await recoverLocked(work);
      beforeDeadline(deadline, 'owner-ready');
      return fn();
    });
  } finally {
    ownerToken.active = false;
  }
}

async function runLockedTurn(work, fn, deadline) {
  beforeDeadline(deadline, 'local-ready');
  await drainPendingReleases(work);
  const ticket = await acquireTicket(work, deadline);
  const lock = resolve(work, '.motion-write.lock');
  const release = {ticket, lock, acquired: false, failure: undefined};

  try {
    await acquireCompatibilityLock(work, lock, ticket.nonce, deadline);
    release.acquired = true;
    return await runOwnedCallback(work, fn, deadline);
  } catch (error) {
    release.failure = error;
    throw error;
  } finally {
    await releaseWhenPossible(work, release);
  }
}

export async function withWorkspaceLock(work, fn, {timeoutMs = 20000} = {}) {
  const deadline = Date.now() + timeoutMs;
  work = await realpath(work);
  if (ownership.getStore()?.get(work)?.active) return fn();
  return processTurn(work, deadline, () => runLockedTurn(work, fn, deadline));
}

export async function readWorkspaceJSON(work, file) {
  return withWorkspaceLock(work, async () => JSON.parse(await readStoredFile(await safePath(await realpath(work), file), 'utf8')));
}

export async function recoverWorkspace(work) {
  return withWorkspaceLock(work, () => ({recovered: true}));
}

/** Stage every target before publishing a durable redo journal. A staged-write
 * error leaves all public metadata untouched. After publication, every reader
 * and writer using this store recovers the entire commit before proceeding.
 * checkpoint is an internal observability hook, also used by crash tests. */
export async function commitWorkspace(work, changes, {checkpoint = () => {}} = {}) {
  return withWorkspaceLock(work, async () => {
    work = await realpath(work);
    const id = randomUUID();
    const writes = Object.entries(changes).map(([file, value]) => {
      if (Buffer.isBuffer(value)) throw Error('事务只接受文本元数据；模型文件应先独立保存');
      const data = encode(value);
      return {file, data, sha256: digest(data), temp: file + '.txn-' + id + '.tmp'};
    });
    const journal = {version: 1, id, createdAt: new Date().toISOString(), writes};
    await validateJournal(work, journal);
    let published = false;

    try {
      for (const write of writes) {
        await checkpoint({phase: 'before-stage', id, file: write.file});
        await preparedFile(await safePath(work, write.temp), write.data);
      }
      await checkpoint({phase: 'staged', id});
      await atomic(resolve(work, JOURNAL), journal, {durable: true});
      published = true;
      await checkpoint({phase: 'prepared', id});
      await applyJournal(work, journal, checkpoint);
      return {id, committed: true};
    } finally {
      if (!published) {
        for (const write of writes) await removePath(await safePath(work, write.temp), {force: true}).catch(() => {});
      }
    }
  });
}
