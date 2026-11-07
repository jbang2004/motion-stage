// Left/right consistency between a change request and the picked body part.
// Shared by the viewer (live hint before submitting) and the server (recorded
// on the task so the agent sees the same conflict). Side is always the
// character's own side: facing the camera, its right hand is on screen left.

const ZH_PART = '(?:上|前|小|大)?(?:臂|胳膊|手|腕|肘|掌|指|肩|腿|膝|脚|足|踝|髋|胯|拳)';
const ZH_SIDE = new RegExp('(左右|左|右)(?:侧|边)?(?:的)?' + ZH_PART, 'g');
const EN_SIDE = /\b(left|right)[\s-]*(?:upper[\s-]*)?(?:arm|forearm|hand|wrist|elbow|shoulder|leg|thigh|knee|foot|feet|ankle|hip|toe|finger|shin|calf|fist)s?\b/gi;
export const SIDE_NAMES = {left: '左', right: '右'};

// Sides the request names for a body part ("左臂", "right knee"). "左右手"
// names both; a bare direction ("向左转", "左右摇摆") names none.
export function requestSides(text) {
  const sides = new Set(), value = String(text || '');
  for (const [, side] of value.matchAll(ZH_SIDE)) {
    if (side === '左右') { sides.add('left'); sides.add('right'); }
    else sides.add(side === '左' ? 'left' : 'right');
  }
  for (const [, side] of value.matchAll(EN_SIDE)) sides.add(side.toLowerCase());
  return sides;
}

function tokens(name) {
  return String(name || '').replace(/^.*:/, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_.\-|]+/).filter(Boolean);
}

// Side encoded in a bone name: LeftArm, mixamorig:RightForeArm, arm.L,
// upperarm_r, Bip01 L UpperArm, HandR, LHand, 左臂.
export function boneSide(name) {
  const raw = String(name || '').replace(/^.*:/, '');
  if (!raw) return null;
  const found = new Set();
  if (/left/i.test(raw) || raw.includes('左')) found.add('left');
  if (/right/i.test(raw) || raw.includes('右')) found.add('right');
  for (const token of tokens(raw)) {
    if (/^l$/i.test(token)) found.add('left');
    if (/^r$/i.test(token)) found.add('right');
  }
  if (/[a-z]L$/.test(raw) || /^L[A-Z][a-z]/.test(raw)) found.add('left');
  if (/[a-z]R$/.test(raw) || /^R[A-Z][a-z]/.test(raw)) found.add('right');
  return found.size === 1 ? [...found][0] : null;
}

// The same bone on the other side, by name, for a one-click correction.
export function mirrorBoneName(name) {
  const value = String(name || '');
  const swapped = value
    .replace(/Left|Right|LEFT|RIGHT|left|right/g, m => ({Left: 'Right', Right: 'Left', LEFT: 'RIGHT', RIGHT: 'LEFT', left: 'right', right: 'left'}[m]))
    .replace(/左|右/g, m => (m === '左' ? '右' : '左'));
  if (swapped !== value) return swapped;
  const token = value
    .replace(/(^|[\s_.\-|:])([LlRr])(?=$|[\s_.\-|])/g, (m, pre, s) => pre + ({L: 'R', R: 'L', l: 'r', r: 'l'}[s]))
    .replace(/([a-z])([LR])$/, (m, pre, s) => pre + (s === 'L' ? 'R' : 'L'))
    .replace(/^([LR])(?=[A-Z][a-z])/, s => (s === 'L' ? 'R' : 'L'));
  return token !== value ? token : null;
}

// A conflict only when the request names exactly one side and the picked
// bone clearly belongs to the other one.
export function sideConflict(request, bone) {
  const sides = requestSides(request), picked = boneSide(bone);
  if (sides.size !== 1 || !picked) return null;
  const requested = [...sides][0];
  if (requested === picked) return null;
  return {
    requested, picked, bone: String(bone),
    message: `要求写的是${SIDE_NAMES[requested]}侧，选中的却是角色${SIDE_NAMES[picked]}侧的部位。左右按角色自己算：角色面向镜头时，它的右手在画面左边。`
  };
}
