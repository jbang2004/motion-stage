import { createPreviewFrame, createPreviewLease } from './runtime-preview.mjs';

// Match the actual source of the current clip, including composite character banks.
export function findStageState(states, {file, clip}) {
 const matches = states.filter(state => state.stage && state.stage.file === file && state.stage.clip === clip);
 return matches.length === 1 ? matches[0] : null;
}

export function runtimeStageSource(source, clip) {
 const original = source?.assembly?.clips?.[clip];
 return {file:original?.file ?? source?.projectRelativePath, clip:original?.sourceClip ?? clip};
}

export function createRuntimeStage({stage, host, button, assetButton, status, transport, timeline, play, clock, setup, retry, handoff, load, renew, release, current, onMode, onReturn}) {
 let active = false, asset, session, source, frame, origin, selection, pending, timer, observed, framePath, frameAsset;
 const lease = createPreviewLease({renew, release, onExpired: () => { session = null; fail('预览服务已停止，重新切换可连接。'); }});

 function send(message) {
  frame?.contentWindow?.postMessage({channel:'motion-stage', ...message}, origin);
 }
 function clearFrame() {
  clearTimeout(timer);
  frame = origin = selection = pending = observed = framePath = frameAsset = null;
  host.replaceChildren();
  transport.hidden = true;
  setup.hidden = retry.hidden = true;
 }
 function fail(message, canSetUp = false) {
  clearFrame();
  status.textContent = message;
  setup.hidden = !canSetUp;
  retry.hidden = false;
 }
 function stop() {
  if (!active) return;
  active = false;
  session = asset = source = null;
  lease.end();
  clearFrame();
  status.textContent = '';
  stage.classList.remove('runtime-stage-active');
  button.setAttribute('aria-pressed','false');
  assetButton.setAttribute('aria-pressed','true');
  onMode(false);
  onReturn();
 }

 function apply(input) {
  if (!session?.states) return;
  const match = findStageState(session.states, input);
  if (!match) {
   fail(session.message || '当前动作没有对应的游戏效果预览。', Boolean(session.states.length) ||
    ['PREVIEW_SETUP_REQUIRED','PREVIEW_CHARACTER_UNMAPPED'].includes(session.code));
   return;
  }
  observed = null;
  status.textContent = '正在载入游戏效果…';
  transport.hidden = true;
  const url = new URL(match.url);
  const command = {type:'select', key:match.stage.key, character:match.stage.character, time:input.time, playing:input.playing,
   loop:input.loop, speed:input.speed, view:input.view};
  const reuseCharacter=match.stage.character&&selection?.switchCharacter;
  if (!frame || origin !== url.origin || framePath !== url.pathname || frameAsset!==input.assetId&&!reuseCharacter) {
   clearFrame();
   origin = url.origin;
   framePath=url.pathname;
   url.searchParams.set('motionStage', '1');
   url.searchParams.set('parentOrigin', window.location.origin);
   frame = createPreviewFrame({label:'游戏效果 · '+match.label, url:url.href});
   host.append(frame);
  }
  frameAsset=input.assetId;
  pending = {...command, request:crypto.randomUUID()};
  if (selection) send(pending);
  clearTimeout(timer);
  timer = setTimeout(() => fail('游戏效果预览未响应。可切回素材预览后重试。'), 20000);
 }

 async function open(input) {
  const ticket = {id:crypto.randomUUID()};
  session = ticket;
  status.textContent = '正在连接游戏效果预览…';
  try {
   const result = await load(input.assetId, false, undefined, ticket.id);
   if (!active || session !== ticket) {
    if (result.managed) void release(ticket.id).catch(() => {});
    return;
   }
   lease.end();
   if (result.managed) lease.keep(ticket.id);
   Object.assign(ticket, {states:result.states, code:result.code, message:result.message});
   apply(current());
  } catch (error) {
   if (active && session === ticket) {
    lease.end();
    fail(error.message || '无法连接游戏预览。', error.code === 'PREVIEW_TRUST_REQUIRED');
   }
  }
 }

 function sync() {
  if (!active) return;
  const input = current();
  if (input.ineligible) { stop(); return; }
  if (asset !== input.assetId) {
   asset = input.assetId;
   source = input.sourceId;
   clearTimeout(timer);pending=observed=null;transport.hidden=true;
   void open(input);
  } else if (source !== input.sourceId) {
   source = input.sourceId;
   apply(input);
  }
 }

 function observe(data) {
  if (!Number.isFinite(data.duration) || data.duration <= 0 || !Number.isFinite(data.time)) return;
  observed = data;
  timeline.max = String(data.duration);
  timeline.value = String(data.time);
  clock.textContent = data.time.toFixed(3)+' / '+data.duration.toFixed(3)+' s';
  play.textContent = data.playing ? '暂停' : '播放';
 }

 window.addEventListener('message', event => {
  if (!active || !frame || event.source !== frame.contentWindow || event.origin !== origin) return;
  const data = event.data;
  if (data?.channel !== 'motion-stage') return;
  if (data.type === 'ready') { selection = {switchCharacter:data.switchCharacter===true}; if (pending) send(pending); }
  if (!pending||data.request !== pending.request) return;
  if (data.type === 'error') { fail('游戏无法播放当前动作。'); return; }
  if (data.type === 'state') {
   clearTimeout(timer);
   status.textContent = '游戏效果 · 切回素材预览可标记';
   transport.hidden = false;
   observe(data);
  }
 });
 assetButton.onclick = stop;
 setup.onclick = () => { if (active && !setup.hidden) void handoff(current()); };
 retry.onclick = () => {
  if (!active || retry.hidden) return;
  clearFrame();
  void open(current());
 };
 button.onclick = () => {
  if (active) return;
  if (current().ineligible) return;
  active = true;
  button.setAttribute('aria-pressed','true');
  assetButton.setAttribute('aria-pressed','false');
  onMode(true);
  stage.classList.add('runtime-stage-active');
  sync();
 };
 const toggle = () => { if (observed) send({type:'play', playing:!observed.playing}); };
 const seek = time => { if (observed) send({type:'seek', time}); };
 play.onclick = toggle;
 timeline.oninput = () => seek(Number(timeline.value));
 window.addEventListener('pagehide', stop);
 return {get active(){return active;}, sync, stop, toggle, step:n=>seek((observed?.time||0)+n/30)};
}
