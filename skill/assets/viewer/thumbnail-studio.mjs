// Thumbnail studio — renders character portraits and action key-pose cards in
// the browser (the Node server has no GPU), uploads them to the workspace
// cache and serves later sessions straight from disk.
//
// One small offscreen WebGL renderer is shared by every render and by the
// live hover preview. Renders are queued, prioritised by visibility and
// yield between jobs so the main stage keeps its frame rate.
import * as T from 'three';
import {clone as cloneSkinned} from 'three/addons/utils/SkeletonUtils.js';
import {runtimeMotionClips} from './motion-runtime.mjs';
import {classifyAction} from './action-taxonomy.mjs';

export const THUMBNAIL_VERSION = 'r4';
const ACTION_SIZE = [288, 360];
const PORTRAIT_SIZE = [360, 480];
const LIVE_FPS = 30;
const GHOST_CATEGORIES = new Set(['attack', 'skill', 'move', 'defense', 'air']);

// Category accents. The card CSS uses the same hues (see library.css).
export const CATEGORY_TINT = {
  idle: '#6f7f99', move: '#1f9d7a', attack: '#e5533d', skill: '#8656f0', defense: '#2f74e0',
  hit: '#ec8a1c', air: '#1599c9', down: '#9a6b4f', emote: '#d8478f', other: '#848a96'
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idle = () => new Promise(resolve => (globalThis.requestIdleCallback
  ? requestIdleCallback(() => resolve(), {timeout: 120})
  : setTimeout(resolve, 16)));

export async function thumbnailKey(kind, ...parts) {
  const text = [THUMBNAIL_VERSION, kind, ...parts].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return kind + '-' + Array.from(new Uint8Array(digest).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}

function parallelTraverse(a, b, visit) {
  visit(a, b);
  for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], visit);
}

const HAND = /(hand|wrist)(?!.*(thumb|index|middle|ring|pinky|finger))/i;
const FOOT = /(foot|ankle)(?!.*toe)/i;
const HEAD = /head(?!.*(top|end|nub))/i;
const LEFT = /(^|[^a-z])l([^a-z]|$)|left|_l\b|\.l\b/i;

function pickJoints(bones) {
  const named = re => bones.filter(b => re.test(b.name));
  const sideOf = list => {
    const left = list.find(b => LEFT.test(b.name));
    const right = list.find(b => b !== left);
    return [left, right].filter(Boolean);
  };
  const hands = sideOf(named(HAND)), feet = sideOf(named(FOOT));
  const head = named(HEAD)[0] || null;
  const hips = bones.find(b => /hips|pelvis/i.test(b.name)) || bones.find(b => /root/i.test(b.name)) || bones[0] || null;
  let extremities = [...hands, ...feet, head].filter(Boolean);
  if (extremities.length < 3) {
    // Non-humanoid rig: use the leaf joints furthest from the hips.
    const leaves = bones.filter(b => !b.children.some(c => c.isBone));
    const origin = hips ? hips.getWorldPosition(new T.Vector3()) : new T.Vector3();
    extremities = leaves
      .map(b => [b, b.getWorldPosition(new T.Vector3()).distanceTo(origin)])
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([b]) => b);
  }
  return {hips, head, hands, feet, extremities};
}

function disposeObject(root) {
  root.traverse(object => {
    object.geometry?.dispose?.();
    for (const material of [object.material].flat().filter(Boolean)) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose?.();
    }
  });
}

export function createThumbnailStudio({api, loader, loadAsset, onError = console.error}) {
  const known = new Map();
  const pending = new Map();
  const queue = [];
  let listing = null, busy = false, rig = null, rigFailed = false, live = null;

  // ---------------------------------------------------------------- rig ---
  function getRig() {
    if (rig || rigFailed) return rig;
    try {
      const canvas = document.createElement('canvas');
      const renderer = new T.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power'});
      renderer.setPixelRatio(1);
      renderer.outputColorSpace = T.SRGBColorSpace;
      renderer.toneMapping = T.NeutralToneMapping;
      renderer.toneMappingExposure = 1.04;
      renderer.setClearColor(0x000000, 0);
      const scene = new T.Scene();
      scene.add(new T.HemisphereLight(0xf5f7ff, 0x9298a6, 1.7));
      const key = new T.DirectionalLight(0xfff0e0, 3.1); key.position.set(2.6, 4.4, 3.8); scene.add(key);
      const fill = new T.DirectionalLight(0xd9e6ff, 1.25); fill.position.set(-3.4, 2.2, 1.6); scene.add(fill);
      const rim = new T.DirectionalLight(0xffffff, 2.6); rim.position.set(-1.6, 3.2, -4.2); scene.add(rim);
      const camera = new T.PerspectiveCamera(26, 1, 0.01, 500);
      const compose = document.createElement('canvas');
      rig = {renderer, scene, camera, canvas, compose, ctx: compose.getContext('2d')};
      canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); rigFailed = true; rig = null; });
    } catch (error) {
      rigFailed = true;
      onError(error);
    }
    return rig;
  }

  // ------------------------------------------------------------ subjects ---
  // A subject is an independent clone of a character with its own mixer, so
  // thumbnails never disturb the stage's pose, clips or selection.
  function createSubject(sourceRoot, {parser = null, id = ''} = {}) {
    const root = cloneSkinned(sourceRoot);
    const map = new Map();
    parallelTraverse(sourceRoot, root, (a, b) => map.set(a, b));
    const holder = new T.Group();
    holder.add(root);
    root.traverse(object => { if (object.isMesh) object.frustumCulled = false; });
    holder.updateMatrixWorld(true);
    const bones = [];
    root.traverse(object => { if (object.isBone) bones.push(object); });
    const box = new T.Box3().setFromObject(root);
    const height = Math.max(1e-3, box.max.y - box.min.y);
    const joints = pickJoints(bones);
    const hipsRest = joints.hips ? joints.hips.getWorldPosition(new T.Vector3()) : box.getCenter(new T.Vector3());
    const mixer = new T.AnimationMixer(root);
    return {
      id, root, holder, mixer, map, parser, bones, joints, height, floor: box.min.y, hipsRest,
      nodeFor: async index => {
        const node = await parser.getDependency('node', index);
        const twin = map.get(node);
        if (!twin) throw Error('动作目标不在角色中');
        return twin;
      },
      dispose() { mixer.stopAllAction(); mixer.uncacheRoot(root); }
    };
  }

  function play(subject, clip) {
    subject.mixer.stopAllAction();
    const action = subject.mixer.clipAction(clip);
    action.setLoop(T.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.enabled = true;
    action.play();
    return action;
  }

  function poseAt(subject, time, {lockRoot = true} = {}) {
    subject.holder.position.set(0, 0, 0);
    subject.mixer.setTime(time);
    subject.holder.updateMatrixWorld(true);
    if (lockRoot && subject.joints.hips) {
      const hips = subject.joints.hips.getWorldPosition(new T.Vector3());
      subject.holder.position.x -= hips.x - subject.hipsRest.x;
      subject.holder.position.z -= hips.z - subject.hipsRest.z;
      subject.holder.updateMatrixWorld(true);
    }
  }

  // Pick the frame that best explains the action: the stride for locomotion,
  // the apex for jumps, the lowest point for falls, the most extreme frame
  // for attacks, skills, hits and dodges.
  function keyPoseTime(subject, clip, category) {
    const duration = clip.duration;
    if (!(duration > 0.05)) return 0;
    if (category === 'idle' || category === 'emote') return duration * 0.4;
    const samples = Math.min(28, Math.max(8, Math.round(duration * 14)));
    const frames = [];
    const {hips, head, feet, extremities} = subject.joints;
    for (let i = 0; i < samples; i++) {
      const time = duration * (0.04 + 0.92 * i / (samples - 1));
      poseAt(subject, time);
      const hipsPos = hips ? hips.getWorldPosition(new T.Vector3()) : new T.Vector3();
      frames.push({
        time,
        hipsY: hipsPos.y,
        headY: head ? head.getWorldPosition(new T.Vector3()).y : hipsPos.y,
        spread: feet.length === 2 ? feet[0].getWorldPosition(new T.Vector3()).distanceTo(feet[1].getWorldPosition(new T.Vector3())) : 0,
        points: extremities.map(b => b.getWorldPosition(new T.Vector3()).sub(hipsPos))
      });
    }
    const pick = score => frames.reduce((best, frame) => (score(frame) > score(best) ? frame : best), frames[0]).time;
    if (category === 'down') return pick(f => -f.headY);
    if (category === 'air') return pick(f => f.hipsY);
    if (category === 'move' && feet.length === 2) return pick(f => f.spread);
    const mean = extremities.map((_, j) => frames.reduce((sum, f) => sum.add(f.points[j]), new T.Vector3()).divideScalar(frames.length));
    // Slight preference for the second half: strikes follow their wind-up.
    return pick(f => f.points.reduce((sum, p, j) => sum + p.distanceTo(mean[j]), 0) * (0.92 + 0.08 * f.time / duration));
  }

  // ------------------------------------------------------------- framing ---
  function frameCamera(subject, camera, aspect, {standard = 1.2, yaw = 0.46, pitch = 0.1, fill = 1.08} = {}) {
    const points = subject.bones.length
      ? subject.bones.map(b => b.getWorldPosition(new T.Vector3()))
      : [new T.Box3().setFromObject(subject.root).getCenter(new T.Vector3())];
    const box = new T.Box3().setFromPoints(points);
    const headroom = subject.height * 0.1;
    box.max.y += headroom;
    box.min.y = Math.min(box.min.y, box.max.y - subject.height * 0.25);
    box.expandByScalar(subject.height * 0.04);
    const center = box.getCenter(new T.Vector3());
    const direction = new T.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    const tanV = Math.tan(T.MathUtils.degToRad(camera.fov / 2)), tanH = tanV * aspect;
    // Distance that fits every joint, never closer than the standard framing
    // so every card of a character shares one scale.
    camera.position.copy(center).addScaledVector(direction, 10);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    const right = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    let distance = (subject.height * standard / 2) / tanV;
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new T.Vector3(x, y, z));
    for (const corner of corners) {
      const offset = corner.clone().sub(center);
      const depth = offset.dot(direction);
      distance = Math.max(distance, depth + Math.abs(offset.dot(right)) * fill / tanH, depth + Math.abs(offset.dot(up)) * fill / tanV);
    }
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.lookAt(center);
    camera.near = Math.max(0.005, distance / 200);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return {center, distance};
  }

  function contactShadow(ctx, subject, camera, width, height, strength = 1) {
    const hips = subject.joints.hips ? subject.joints.hips.getWorldPosition(new T.Vector3()) : new T.Vector3();
    const floor = new T.Vector3(hips.x, subject.floor, hips.z);
    const a = floor.clone().add(new T.Vector3(-subject.height * 0.24, 0, 0)).project(camera);
    const b = floor.clone().add(new T.Vector3(subject.height * 0.24, 0, 0)).project(camera);
    const c = floor.clone().project(camera);
    const cx = (c.x + 1) / 2 * width, cy = (1 - c.y) / 2 * height;
    const rx = Math.abs(b.x - a.x) / 2 * width;
    if (!(rx > 2) || cy < 0 || cy > height * 1.05) return;
    const lift = Math.max(0, Math.min(1, (hips.y - subject.hipsRest.y) / subject.height));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.24);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    gradient.addColorStop(0, `rgba(20,24,34,${(0.28 * (1 - lift * 0.8) * strength).toFixed(3)})`);
    gradient.addColorStop(1, 'rgba(20,24,34,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function render(subject, width, height) {
    const {renderer, scene, camera} = rig;
    renderer.setSize(width, height, false);
    scene.add(subject.holder);
    try {
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
    } finally {
      scene.remove(subject.holder);
    }
    return rig.canvas;
  }

  async function encode(canvas) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.86));
    if (!blob) throw Error('浏览器无法编码缩略图');
    return blob;
  }

  // --------------------------------------------------------------- cache ---
  async function loadListing() {
    listing ??= fetch('/api/thumbnails').then(r => r.json()).then(data => {
      for (const [key, url] of Object.entries(data.files || {})) known.set(key, url);
    }).catch(() => {});
    return listing;
  }

  async function store(key, blob) {
    const result = await api('/api/thumbnails/' + key, 'POST', blob);
    known.set(key, result.url);
    return result.url;
  }

  function schedule(task) {
    return new Promise((resolve, reject) => {
      queue.push({...task, resolve, reject, order: queue.length + Math.random() * 0.01});
      pump();
    });
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        if (live?.running) { await sleep(150); continue; }
        if (document.hidden) { await sleep(400); continue; }
        queue.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
        const task = queue.shift();
        if (task.wanted && !task.wanted()) { task.resolve(null); continue; }
        try { task.resolve(await task.run()); }
        catch (error) { task.reject(error); }
        await idle();
      }
    } finally {
      busy = false;
    }
  }

  // Cached URL, or render + upload once. Concurrent requests share one job.
  async function cached(key, produce, {priority = 1, wanted} = {}) {
    await loadListing();
    if (known.has(key)) return known.get(key);
    if (pending.has(key)) return pending.get(key);
    const job = schedule({priority, wanted, run: async () => {
      if (known.has(key)) return known.get(key);
      if (!getRig()) return null;
      const blob = await produce();
      if (!blob) return null;
      try { return await store(key, blob); }
      catch { return URL.createObjectURL(blob); }
    }}).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  // ------------------------------------------------------------ actions ---
  function drawAction(subject, clip, category, [width, height] = ACTION_SIZE) {
    const {ctx, compose, camera} = rig;
    compose.width = width; compose.height = height;
    ctx.clearRect(0, 0, width, height);
    play(subject, clip);
    const keyTime = keyPoseTime(subject, clip, category);
    poseAt(subject, keyTime);
    frameCamera(subject, camera, width / height, {standard: 1.1, fill: 1.06});
    contactShadow(ctx, subject, camera, width, height);
    if (GHOST_CATEGORIES.has(category) && clip.duration > 0.25) {
      const ghost = new T.MeshBasicMaterial({color: new T.Color(CATEGORY_TINT[category] || CATEGORY_TINT.other)});
      rig.scene.overrideMaterial = ghost;
      try {
        for (const [offset, alpha] of [[0.24, 0.13], [0.12, 0.22]]) {
          const time = keyTime - clip.duration * offset;
          if (time < 0) continue;
          poseAt(subject, time);
          ctx.globalAlpha = alpha;
          ctx.drawImage(render(subject, width, height), 0, 0, width, height);
        }
      } finally {
        rig.scene.overrideMaterial = null;
        ghost.dispose();
        ctx.globalAlpha = 1;
      }
      poseAt(subject, keyTime);
    }
    ctx.drawImage(render(subject, width, height), 0, 0, width, height);
    subject.mixer.stopAllAction();
    return encode(compose);
  }

  async function sharedClip(subject, target, actionId, samples) {
    const result = await api('/api/actions/curves', 'POST', {...target, actionIds: [actionId], ...(samples ? {samples} : {})});
    const data = result.clips?.[actionId];
    if (!data || data.error) throw Error(data?.error || '动作曲线不可用');
    const [clip] = await runtimeMotionClips(T, [{name: data.name, tracks: data.tracks}], subject.nodeFor);
    return clip;
  }

  // ----------------------------------------------------------- portraits ---
  async function portraitSource(entry) {
    const portrait = entry.portrait;
    if (portrait.source === 'workspace') return loadAsset(portrait.asset, loader);
    const response = await fetch(portrait.url);
    if (!response.ok) throw Error('模型读取失败（HTTP ' + response.status + '）');
    return loader.parseAsync(await response.arrayBuffer(), '');
  }

  function portraitClip(animations) {
    const ranked = animations.map(clip => ({clip, info: classifyAction(clip.name, {duration: clip.duration})}));
    const score = ({clip, info}) => (info.category === 'idle' ? 0 : info.category === 'move' ? 2 : info.category === 'emote' ? 3 : 5)
      + (/^idle$|[_|]idle$|idle_?(loop)?$/i.test(clip.name) ? -1 : 0)
      + (info.tags.includes('combat') ? 0.5 : 0) + (info.pose ? 2 : 0) + (clip.duration < 0.2 ? 3 : 0);
    return ranked.sort((a, b) => score(a) - score(b))[0]?.clip || null;
  }

  async function drawPortrait(entry) {
    const gltf = await portraitSource(entry);
    const scene = gltf.scene;
    const subject = createSubject(scene, {parser: gltf.parser, id: entry.id});
    const [width, height] = PORTRAIT_SIZE;
    const {ctx, compose, camera} = rig;
    try {
      compose.width = width; compose.height = height;
      ctx.clearRect(0, 0, width, height);
      const clip = portraitClip(gltf.animations || []);
      if (clip) {
        play(subject, clip);
        poseAt(subject, clip.duration * 0.35);
      } else {
        subject.holder.updateMatrixWorld(true);
      }
      frameCamera(subject, camera, width / height, {standard: 1.08, yaw: 0.42, pitch: 0.04, fill: 1.06});
      contactShadow(ctx, subject, camera, width, height, 0.9);
      ctx.drawImage(render(subject, width, height), 0, 0, width, height);
      const blob = await encode(compose);
      return {blob, tint: averageTint(ctx, width, height)};
    } finally {
      subject.dispose();
      disposeObject(scene);
    }
  }

  // Dominant colour of the opaque pixels; the card background borrows it.
  function averageTint(ctx, width, height) {
    try {
      const data = ctx.getImageData(0, 0, width, height).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4 * 7) {
        if (data[i + 3] < 200) continue;
        const max = Math.max(data[i], data[i + 1], data[i + 2]), min = Math.min(data[i], data[i + 1], data[i + 2]);
        const weight = 0.25 + (max - min) / 255;
        r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight; n += weight;
      }
      return n ? [r / n, g / n, b / n].map(Math.round) : null;
    } catch { return null; }
  }

  const tints = new Map();
  function rememberTint(key, tint) {
    if (!tint) return;
    tints.set(key, tint);
    try { localStorage.setItem('ms-tint-' + key, JSON.stringify(tint)); } catch {}
  }
  function tintFor(key) {
    if (tints.has(key)) return tints.get(key);
    try { const value = JSON.parse(localStorage.getItem('ms-tint-' + key) || 'null'); if (value) tints.set(key, value); return value; } catch { return null; }
  }

  // -------------------------------------------------------------- live ---
  // A looping mini preview drawn into a card's own 2D canvas.
  function startLive(target, {subject, clip}) {
    stopLive();
    if (!getRig() || !subject || !clip) return null;
    const rect = target.getBoundingClientRect();
    const scale = Math.min(2, devicePixelRatio || 1);
    const width = Math.max(64, Math.round(rect.width * scale)), height = Math.max(80, Math.round(rect.height * scale));
    const canvas = document.createElement('canvas');
    canvas.className = 'live-canvas';
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    target.append(canvas);
    play(subject, clip);
    poseAt(subject, 0);
    // Stable framing for the whole loop: fit a few sampled poses once.
    const frames = [0, 0.25, 0.5, 0.75].map(f => f * clip.duration);
    let widest = null;
    for (const time of frames) {
      poseAt(subject, time);
      const framing = frameCamera(subject, rig.camera, width / height, {standard: 1.26});
      if (!widest || framing.distance > widest.distance) widest = {...framing, time};
    }
    poseAt(subject, widest.time);
    frameCamera(subject, rig.camera, width / height, {standard: 1.26});
    const session = {running: true, canvas, start: performance.now(), last: 0, frame: 0};
    const tick = now => {
      if (!session.running) return;
      session.frame = requestAnimationFrame(tick);
      if (now - session.last < 1000 / LIVE_FPS) return;
      session.last = now;
      const time = ((now - session.start) / 1000) % Math.max(clip.duration, 1e-3);
      poseAt(subject, time);
      ctx.clearRect(0, 0, width, height);
      contactShadow(ctx, subject, rig.camera, width, height);
      ctx.drawImage(render(subject, width, height), 0, 0, width, height);
      canvas.classList.add('ready');
    };
    session.frame = requestAnimationFrame(tick);
    session.stop = () => {
      session.running = false;
      cancelAnimationFrame(session.frame);
      subject.mixer.stopAllAction();
      canvas.remove();
    };
    live = session;
    return session;
  }

  function stopLive() {
    live?.stop?.();
    live = null;
    if (queue.length) pump();
  }

  // ---------------------------------------------------------------- API ---
  return {
    available: () => Boolean(getRig()),
    createSubject,
    known: key => known.get(key) || null,
    ready: loadListing,
    tintFor,

    async portrait(entry, {priority = 0, wanted} = {}) {
      if (!entry?.portrait) return null;
      const key = await thumbnailKey('p', entry.id, entry.portrait.identity);
      let tint = null;
      const url = await cached(key, async () => {
        const result = await drawPortrait(entry);
        tint = result.tint;
        return result.blob;
      }, {priority, wanted});
      if (tint) rememberTint(key, tint);
      return url ? {url, key, tint: tintFor(key)} : null;
    },

    async ownAction(subject, clip, {priority = 1, wanted} = {}) {
      const category = classifyAction(clip.name, {duration: clip.duration}).category;
      const key = await thumbnailKey('a', subject.id, 'own', clip.name);
      return cached(key, () => drawAction(subject, clip, category), {priority, wanted});
    },

    async sharedAction(subject, target, row, {priority = 2, wanted} = {}) {
      const category = classifyAction(row.name, {duration: row.duration}).category;
      const key = await thumbnailKey('a', subject.id, 'shared', row.id);
      return cached(key, async () => {
        const clip = await sharedClip(subject, target, row.id, 24);
        return drawAction(subject, clip, category);
      }, {priority, wanted});
    },

    // A 常用 card is a saved recipe: the read-only motion preview resolves its
    // curves (nothing is registered or adopted); the key follows the recipe id.
    async savedAction(subject, request, row, {priority = 2, wanted} = {}) {
      const category = classifyAction(request.clip, {duration: row.duration}).category;
      const key = await thumbnailKey('a', subject.id, 'saved', row.source.recipe.id);
      return cached(key, async () => {
        const result = await api('/api/motions/preview', 'POST', request);
        const data = result.clips?.find(c => c.name === request.clip) || result.clips?.[0];
        if (!data?.tracks?.length) throw Error('动作曲线不可用');
        const [clip] = await runtimeMotionClips(T, [{name: data.name, tracks: data.tracks}], subject.nodeFor);
        return drawAction(subject, clip, category);
      }, {priority, wanted});
    },

    sharedClip,
    startLive,
    stopLive,
    dispose() {
      stopLive();
      queue.splice(0).forEach(task => task.resolve(null));
      rig?.renderer.dispose();
      rig = null;
    }
  };
}
