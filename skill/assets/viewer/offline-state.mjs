const isName = value => typeof value === 'string' && value.trim() && value.length <= 200;
const isVector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);

export function parseOfflineState(value) {
 const {id, label, clip, time = 0, play = false, appearance, attachments = []} = value || {};
 if (typeof id !== 'string' || !/^[\w.-]{1,80}$/.test(id) ||
     !isName(label) || !isName(clip) || !Number.isFinite(time) || time < 0 || typeof play !== 'boolean' ||
     appearance !== undefined && !['neutral', 'project'].includes(appearance) ||
     !Array.isArray(attachments) || attachments.length > 8) throw Error('离线状态配置无效');
 const seen = new Set();
 const bindings = attachments.map(item => {
  const {node, parent, position = [0, 0, 0], quaternion = [0, 0, 0, 1], scale = [1, 1, 1]} = item || {};
  if (!isName(node) || !isName(parent) || node === parent || seen.has(node) ||
      !isVector(position, 3) || !isVector(quaternion, 4) || Math.abs(Math.hypot(...quaternion) - 1) > 0.001 ||
      !isVector(scale, 3) || scale.some(component => component <= 0)) throw Error('离线状态的装备挂点无效');
  seen.add(node);
  return {node, parent, position, quaternion, scale};
 });
 return {id, label, clip, time, play, appearance, attachments: bindings};
}

export function modelPreviewStates(models, primary) {
 if (!primary) return [];
 const clipLists = models.map(model => new Set((model.libraryOriginalClips || model.clips).map(clip => clip.name)));
 return (primary.libraryOriginalClips || primary.clips)
  .filter(clip => clip.name && clipLists.every(list => list.has(clip.name)))
  .map((clip, index) => ({
   id: 'model-' + index, label: clip.name, clip: clip.name, time: 0, play: false, attachments: [], modelOnly: true,
  }));
}

export function bindOfflineAttachments(THREE, model, attachments) {
 if (!attachments.length) return [];
 const nodes = new Map();
 model.root.traverse(object => {
  const index = model.parser?.associations?.get(object)?.nodes;
  const name = model.parser?.json?.nodes?.[index]?.name;
  if (name) nodes.set(name, nodes.has(name) ? null : object);
 });
 const get = name => {
  const object = nodes.get(name);
  if (!object) throw Error('装备节点不存在或重名：' + name);
  return object;
 };
 const bindings = attachments.map(({node, parent, position, quaternion, scale}) => {
  const object = get(node), target = get(parent);
  let movable = object !== model.root;
  object.traverse(child => { if (child.isBone || child.isSkinnedMesh) movable = false; });
  if (!movable) throw Error('装备挂点只能移动刚性节点：' + node);
  const offset = new THREE.Matrix4().compose(
   new THREE.Vector3().fromArray(position), new THREE.Quaternion().fromArray(quaternion).normalize(),
   new THREE.Vector3().fromArray(scale),
  );
  return {object, target, offset, original: new THREE.Matrix4(), autoUpdate: object.matrixAutoUpdate, applied: false};
 });
 for (const {object, target} of bindings) {
  for (const start of [object.parent, target]) {
   for (let ancestor = start; ancestor; ancestor = ancestor.parent) {
    if (bindings.some(binding => binding.object === ancestor)) throw Error('装备挂点不可依赖另一个被移动的装备节点');
   }
  }
 }
 return bindings;
}

export function resetOfflineAttachments(bindings = []) {
 for (const binding of bindings) {
  if (!binding.applied) continue;
  binding.object.matrix.copy(binding.original);
  binding.object.matrixAutoUpdate = binding.autoUpdate;
  binding.object.matrixWorldNeedsUpdate = true;
  binding.applied = false;
 }
}

export function poseOfflineAttachments(model) {
 if (!model.offlineBindings?.length) return;
 for (const binding of model.offlineBindings) {
  const {object, target, offset, original} = binding;
  original.copy(object.matrix);
  // Keep animation bindings and hierarchy intact. Only replace the displayed local matrix.
  object.matrixAutoUpdate = false;
  object.matrix.copy(object.parent.matrixWorld).invert().multiply(target.matrixWorld).multiply(offset);
  object.matrixWorldNeedsUpdate = true;
  binding.applied = true;
 }
 model.scene.updateMatrixWorld(true);
}
