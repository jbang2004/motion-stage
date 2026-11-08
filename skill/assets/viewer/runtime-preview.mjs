export function createPreviewLease({renew, release, onExpired}) {
 let lease, heartbeat;
 function end() {
  clearInterval(heartbeat);
  const old = lease;
  lease = null;
  if (old) void release(old).catch(() => {});
 }
 function keep(id) {
  end();
  lease = id;
  heartbeat = setInterval(async () => {
   try {
    if ((await renew(id)).active || lease !== id) return;
   } catch { if (lease !== id) return; }
   end();
   onExpired();
  }, 8000);
 }
 return {keep, end, get active(){return Boolean(lease);}};
}

export function createPreviewFrame({label, url}) {
 const frame = document.createElement('iframe');
 frame.title = label;
 frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
 frame.referrerPolicy = 'no-referrer';
 frame.src = url;
 return frame;
}

export function createRuntimePreview({button, dialog, title, status, mode, select, refresh, apply, clear, frameHost, external, currentAsset, currentPreset, loadStates, applyPreset, renew, release}) {
 let request, states = [], applying = false;
 const lease = createPreviewLease({renew, release, onExpired: () => {
  states = [];
  select.replaceChildren(new Option('选择一个状态', ''));
  select.disabled = true;
  showState();
  status.textContent = '预览服务已停止，点刷新状态可重新连接。';
 }});
 const offline = () => mode.value === 'offline';
 const selected = () => states.find(item => item.id === select.value);

 function showState() {
  const state = selected();
  frameHost.replaceChildren();
  apply.hidden = !offline();
  apply.disabled = !state || applying;
  clear.hidden = !offline() || !currentPreset();
  clear.disabled = applying;
  frameHost.hidden = offline() || !state;
  external.hidden = frameHost.hidden || lease.active;
  external.removeAttribute('href');
  if (frameHost.hidden) return;
  external.href = state.url;
  frameHost.append(createPreviewFrame(state));
 }

 async function refreshStates() {
  if (applying) return;
  request?.abort();
  const asset = currentAsset();
  const controller = new AbortController();
  request = controller;
  states = [];
  select.replaceChildren(new Option('选择一个状态', ''));
  select.disabled = true;
  showState();
  title.textContent = asset?.name || '当前角色';
  if (!asset?.id) {
   status.textContent = '请先打开项目里的角色';
   return;
  }
  const local = offline();
  if (local) lease.end();
  const id = local ? null : crypto.randomUUID();
  status.textContent = local ? '正在读取离线状态…' : '正在连接游戏预览服务…';
  try {
   const result = await loadStates(asset.id, local, controller.signal, id);
   if (controller.signal.aborted || !dialog.open || currentAsset()?.id !== asset.id) {
    if (result.managed) void release(id).catch(() => {});
    return;
   }
   if (!local) lease.end();
   if (result.managed) lease.keep(id);
   states = result.states;
   for (const state of states) select.add(new Option(state.label, state.id));
   select.disabled = !states.length;
   const preset = local ? currentPreset() : null;
   if (preset && states.some(state => state.id === preset.id)) select.value = preset.id;
   showState();
   status.textContent = result.message || (preset ? '当前离线状态 · ' + preset.label :
    local ? '选择一个状态，在动作台播放和比较。' : '选择一个状态，由游戏服务渲染预览。');
  } catch (error) {
   if (!controller.signal.aborted && dialog.open) {
    lease.end();
    status.textContent = error.message || '无法读取游戏状态，请刷新重试';
   }
  }
 }

 async function usePreset(preset) {
  if (applying) return;
  applying = true;
  mode.disabled = refresh.disabled = select.disabled = true;
  showState();
  status.textContent = '正在应用状态…';
  try {
   await applyPreset(preset);
   dialog.close();
  } catch (error) {
   status.textContent = error.message;
  } finally {
   applying = false;
   mode.disabled = refresh.disabled = false;
   select.disabled = !states.length;
   showState();
  }
 }

 button.onclick = () => {
  mode.value = 'offline';
  dialog.showModal();
  void refreshStates();
 };
 mode.onchange = refreshStates;
 refresh.onclick = refreshStates;
 select.onchange = showState;
 apply.onclick = () => { const preset = selected(); if (preset) void usePreset(preset); };
 clear.onclick = () => usePreset(null);
 dialog.addEventListener('cancel', event => { if (applying) event.preventDefault(); });
 window.addEventListener('pagehide', () => { request?.abort(); lease.end(); });
 window.addEventListener('pageshow', event => { if (event.persisted && dialog.open) void refreshStates(); });
 dialog.addEventListener('close', () => {
  if (dialog.open) return;
  request?.abort();
  lease.end();
  frameHost.replaceChildren();
 });
}
