// Action taxonomy: raw clip names -> category, friendly Chinese label, cleaned English title, search metadata.
// Pure ES module: no imports, no DOM, no Node APIs.

export const ACTION_CATEGORIES = [
  { id: 'idle', label: '待机', en: 'Idle' },
  { id: 'move', label: '移动', en: 'Move' },
  { id: 'attack', label: '攻击', en: 'Attack' },
  { id: 'skill', label: '技能', en: 'Skill' },
  { id: 'defense', label: '防御/闪避', en: 'Defense' },
  { id: 'hit', label: '受击', en: 'Hit' },
  { id: 'air', label: '跳跃', en: 'Air' },
  { id: 'down', label: '倒地', en: 'Down' },
  { id: 'emote', label: '表演', en: 'Emote' },
  { id: 'other', label: '其他', en: 'Other' },
];

const CATEGORY_BY_ID = new Map(ACTION_CATEGORIES.map((category, order) => [category.id, { ...category, order }]));
const SOURCE_TAGS = ['探索', '导演'];
const NOISE_WORDS = new Set(['arpg', 'as', 'seq', 'anim', 'x']);
const LABEL_SKIPPED_WORDS = new Set(['nodachi', 'loop']);
const ANGLES = new Set(['0', '45', '90', '135', '180', '225', '270', '315']);
const DIRECTION_WORDS = {
  forward: 'F', forwards: 'F', fwd: 'F', front: 'F', backward: 'B', backwards: 'B', back: 'B', left: 'L', right: 'R',
};
const DIRECTION_ZH = { F: '前', B: '后', L: '左', R: '右', FL: '前左', FR: '前右', BL: '后左', BR: '后右' };
const DIRECTION_TAGS = { F: 'forward', B: 'back', L: 'left', R: 'right' };

// Chinese glossary, lowercase English token -> label text.
const GLOSSARY = new Map(Object.entries({
  // stillness
  idle: '待机', breathe: '呼吸', in: '吸入', out: '呼出', stance: '架势', wait: '等待', rest: '休息', stand: '站立',
  // locomotion
  walk: '行走', run: '奔跑', sprint: '冲刺', strafe: '侧移', dash: '突进', turn: '转身', start: '起步', stop: '停步',
  brake: '刹停', step: '步', lean: '倾斜', jog: '慢跑', explore: '探索',
  // attacks
  slash: '斩击', cut: '斩', inward: '内', outward: '外', downward: '下劈', upward: '上挑', spin: '回旋', combo: '连招',
  attack: '攻击', strike: '打击', punch: '拳击', kick: '踢击', stab: '刺击', thrust: '突刺', swing: '挥击',
  heavy: '重击', finisher: '终结技', execute: '处决', exec: '处决', execution: '处决', iai: '居合', draw: '拔刀',
  sheathe: '收刀', uppercut: '上勾拳', hook: '勾拳', lunge: '扑击', slam: '猛击', stomp: '踩踏', cleave: '劈砍',
  leap: '飞跃', flurry: '连打', barrage: '乱击', rising: '上升', flying: '飞', wheel: '回旋', elbow: '肘',
  blade: '刀刃', cross: '十字', axe: '斧', katana: '太刀', two: '双', hand: '手', low: '低', lower: '下',
  // skills
  charge: '蓄力', hold: '保持', skill: '技能', special: '特殊', ultimate: '终极', cast: '施法', power: '强力',
  buff: '强化', target: '目标', counter: '反击',
  // defense
  guard: '防御', block: '格挡', parry: '格挡', dodge: '闪避', evade: '回避', roll: '翻滚', backstep: '后撤步',
  weave: '闪转', ease: '缓步', break: '破防',
  // reactions
  hit: '受击', damage: '受伤', hurt: '受伤', stagger: '踉跄', knockback: '击退', flinch: '退缩', collide: '碰撞',
  wall: '墙壁', gut: '腹部', impact: '冲击', stunned: '眩晕', launched: '击飞', reel: '摇晃', head: '头部',
  body: '身体', behind: '背后',
  // air
  jump: '跳跃', air: '空中', fall: '坠落', land: '落地', flip: '翻身', rise: '上升', airborne: '浮空', dive: '俯冲',
  recover: '恢复',
  // down
  death: '死亡', die: '死亡', dead: '死亡', knockdown: '倒地', getup: '起身', kipup: '鲤鱼打挺', kneel: '跪地',
  // performance
  victory: '胜利', taunt: '嘲讽', emote: '表情', dance: '舞蹈', wave: '挥手', talk: '交谈', story: '剧情',
  director: '导演', roar: '咆哮', look: '张望', salute: '敬礼', bow: '鞠躬', cheer: '欢呼', clap: '鼓掌',
  // modifiers
  combat: '战斗', fast: '快速', big: '大型', large: '大型', end: '结束', floor: '地面', up: '上', down: '下',
  double: '二段', all: '全部', from: '来自', second: '第二',
  // Generic English names (Mixamo descriptions, asset packs, auto-rig exports).
  crawl: '爬行', climb: '攀爬', swim: '游泳', sneak: '潜行', shuffle: '拖步', advance: '推进', hop: '小跳',
  carry: '搬运', crouch: '蹲', sit: '坐', lie: '躺', ladder: '梯子',
  shoot: '射击', smash: '猛击', bash: '重击', melee: '近战', throw: '投掷', swipe: '横扫', chop: '劈砍',
  bite: '撕咬', claw: '爪击', tackle: '冲撞', headbutt: '头槌', reload: '换弹', aim: '瞄准',
  spell: '法术', magic: '魔法', summon: '召唤', heal: '治疗', duck: '闪躲',
  react: '受击', reaction: '反应', defeat: '战败', faint: '昏倒', collapse: '倒下',
  fly: '飞行', glide: '滑翔', hover: '悬停',
  conversation: '交谈', laugh: '大笑', yell: '喊叫', shout: '喊叫', cry: '哭泣', angry: '生气', sad: '伤心',
  happy: '开心', terrified: '害怕', scared: '害怕', point: '指向', gesture: '手势', greet: '问候', nod: '点头',
  shrug: '耸肩', celebrate: '庆祝', pray: '祈祷', battlecry: '战吼', equip: '装备', ask: '询问', question: '提问',
  spawn: '出场', awaken: '苏醒', withdraw: '拔出',
  pick: '拾', push: '推', pull: '拉', open: '打开', door: '门', interact: '互动', object: '物体', ground: '地面',
  enter: '进入', exit: '退出',
  sword: '剑', shield: '盾', rifle: '步枪', pistol: '手枪', gun: '枪', spear: '长矛', staff: '法杖', dagger: '匕首',
  arrow: '箭', bayonet: '刺刀', unarmed: '徒手', swordsman: '剑客',
  quick: '快速', slow: '慢速', small: '小', high: '高', female: '女性', male: '男性', pose: '姿势', mirror: '镜像',
  executed: '被处决', fire: '火', around: '四周', neutral: '自然', backhand: '反手', foot: '脚', shot: '击', headshot: '爆头',
  powershot: '强力射击', ready: '预备', standard: '标准', old: '老人', hide: '躲藏', stomach: '俯卧', hilt: '剑柄',
  unblocked: '未格挡', work: '工作', three: '三',
}));

// Multi-word phrases are matched before single words.
const PHRASES = new Map([
  ['double jump', '二段跳'], ['step back', '后撤步'], ['get up', '起身'], ['knock down', '倒地'],
  ['hit from behind', '背后受击'], ['air wave', '空中冲击波'], ['power up', '强化'], ['kip up', '鲤鱼打挺'], ['kneel rise', '跪地起身'], ['kneel up', '跪地起身'], ['kneel down', '跪下'], ['wall hit', '撞墙受击'],
  ['stand up', '起身'], ['pick up', '拾取'], ['knock out', '击倒'], ['knock over', '撞倒'], ['spell cast', '施法'],
  ['one hand', '单手'], ['two hand', '双手'], ['hip hop', '街舞'], ['bind pose', '绑定姿势'], ['open door', '开门'],
  ['fire arrow', '放箭'], ['two hit', '二连击'], ['three hit', '三连击'], ['weight shift', '重心转移'],
]);

// English glue words carry no action; they are dropped from labels. "in"/"out"
// only mean 吸入/呼出 next to breathing, "with" becomes 持 before a weapon.
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'and', 'of', 'or', 'while', 'being', 'for', 'his', 'her', 'its', 'it', 'is', 'at', 'on', 'into', 'by', 'from', 'in', 'out', 'with', 'to', 'man', 'receive', 'recieve']);
const WEAPONS = new Set(['sword', 'shield', 'rifle', 'pistol', 'gun', 'spear', 'staff', 'dagger', 'arrow', 'bayonet', 'axe', 'katana', 'blade', 'bow']);
const ARCHERY_WORDS = new Set(['arrow', 'quiver', 'aim', 'shoot', 'nock', 'equip']);
// Posture participles describe how, not what: "Standing Aim Fire" is not idle.
const STEM_BLOCKED = new Set(['standing']);

// Modifiers move to the front of their segment: "Run Combat Fast" -> 战斗快速奔跑.
const FRONT_MODIFIERS = new Set(['combat', 'fast', 'air', 'big', 'large', 'quick', 'slow']);

// Named techniques (character moves) that are always skills.
const TECHNIQUE_WORDS = new Set([
  'enrai', 'inadama', 'dengoraigo', 'raigo', 'rai', 'netsukai', 'netsukairai', 'hinokami', 'shubun', 'shubunseirai',
  'annihilation', 'final', 'disorder', 'compass', 'crown', 'messhiki', 'kagura', 'review', 'rumble', 'invite',
]);

const KEYWORDS = {
  down: ['death', 'die', 'dead', 'knockdown', 'getup', 'kipup', 'kneel', 'defeat', 'faint', 'collapse', 'executed'],
  hit: ['hit', 'damage', 'hurt', 'stagger', 'knockback', 'flinch', 'collide', 'impact', 'stunned', 'launched', 'reel', 'react', 'reaction'],
  skill: ['skill', 'ultimate', 'special', 'cast', 'charge', 'buff', 'powerup', 'spell', 'magic', 'summon', 'heal'],
  defense: ['guard', 'block', 'parry', 'dodge', 'evade', 'roll', 'backstep', 'weave', 'duck'],
  idle: ['idle', 'breathe', 'stance', 'wait', 'rest', 'stand'],
  attack: ['slash', 'cut', 'attack', 'combo', 'strike', 'punch', 'kick', 'stab', 'thrust', 'swing', 'heavy', 'finisher',
    'execute', 'exec', 'execution', 'iai', 'slam', 'uppercut', 'hook', 'lunge', 'spin', 'stomp', 'cleave', 'flurry',
    'barrage', 'elbow', 'cross', 'shoot', 'fire', 'smash', 'bash', 'melee', 'throw', 'swipe', 'chop', 'bite', 'claw',
    'tackle', 'headbutt'],
  air: ['jump', 'air', 'fall', 'land', 'flip', 'leap', 'airborne', 'dive', 'fly', 'flying', 'glide', 'hover', 'hop'],
  emote: ['victory', 'taunt', 'emote', 'dance', 'wave', 'talk', 'story', 'director', 'draw', 'sheathe', 'roar', 'look', 'salute', 'bow', 'cheer', 'clap',
    'conversation', 'laugh', 'yell', 'shout', 'cry', 'angry', 'terrified', 'scared', 'point', 'gesture', 'greet', 'nod',
    'shrug', 'celebrate', 'pray', 'battlecry', 'equip', 'ask', 'question', 'spawn', 'awaken', 'withdraw'],
  move: ['walk', 'run', 'sprint', 'strafe', 'turn', 'start', 'stop', 'brake', 'step', 'dash', 'lean', 'jog', 'ease',
    'crawl', 'climb', 'swim', 'sneak', 'shuffle', 'advance', 'carry'],
};
// Held postures count as idle only when nothing else names the action ("Crouch Walk" moves).
const POSTURE_WORDS = ['crouch', 'sit', 'lie', 'aim'];
const KEYWORD_SET = new Set(Object.values(KEYWORDS).flat());

const LOCOMOTION_WORDS = ['walk', 'run', 'sprint', 'strafe', 'jog', 'crawl', 'sneak', 'shuffle', 'swim'];
const ONE_SHOT_CATEGORIES = new Set(['attack', 'skill', 'defense', 'hit', 'down']);
const TRANSITION_WORDS = ['start', 'stop', 'turn', 'end', 'brake'];

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
const isNumber = (word) => /^\d+$/.test(word);
const isCjk = (text) => /[一-鿿]/.test(text);

// Every word the taxonomy knows; inflected forms resolve to one of these.
const VOCAB = new Set([
  ...GLOSSARY.keys(), ...KEYWORD_SET, ...POSTURE_WORDS, ...WEAPONS, ...ARCHERY_WORDS, ...TECHNIQUE_WORDS,
  ...[...PHRASES.keys()].flatMap((phrase) => phrase.split(' ')),
]);
// English inflections seen in descriptive names: Walking, Knocked, Slashes, Dying, Hits.
function inflections(word) {
  const forms = [word];
  const stem = (base) => {
    if (base.length < 2) return;
    forms.push(base, base + 'e');
    if (/([b-df-hj-np-tv-z])\1$/.test(base)) forms.push(base.slice(0, -1));
  };
  if (word.length > 4 && word.endsWith('ing')) {
    const base = word.slice(0, -3);
    stem(base);
    if (base.endsWith('y')) forms.push(base.slice(0, -1) + 'ie');
  } else if (word.length > 4 && word.endsWith('ied')) forms.push(word.slice(0, -3) + 'y');
  else if (word.length > 3 && word.endsWith('ed')) stem(word.slice(0, -2));
  else if (word.length > 3 && word.endsWith('es')) forms.push(word.slice(0, -2), word.slice(0, -1));
  else if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) forms.push(word.slice(0, -1));
  return forms;
}
const canon = (word) => inflections(word).find((form) => VOCAB.has(form)) ?? word;
// "Walking With Bow", "Bow_Shoot", "Equipping Bow" hold a weapon; a lone "Bow" is a gesture.
function bowIsWeapon(lex) {
  const at = lex.indexOf('bow');
  return at >= 0 && (lex.some((word) => ARCHERY_WORDS.has(word)) || lex[at - 1] === 'with' ||
    ['and', 'for', 'shoot', 'draw', 'attack', 'idle', 'walk', 'run'].includes(lex[at + 1]));
}
const nextContent = (lex, position) => lex.slice(position + 1).find((word) => !FUNCTION_WORDS.has(word));

function stripWrappers(raw) {
  let rest = raw.trim();
  let sourceTag = null;
  const studioPrefix = SOURCE_TAGS.find((tag) => rest.startsWith(`${tag}__`));
  if (studioPrefix) {
    sourceTag = studioPrefix;
    rest = rest.slice(studioPrefix.length + 2);
  }
  rest = rest.replace(/^.*\|/, '').replace(/^mixamo\.com$/i, '');
  let rootMotion = null;
  const motionSuffix = rest.match(/__(RM|IP)$/);
  if (motionSuffix) {
    rootMotion = motionSuffix[1] === 'RM' ? 'root' : 'in-place';
    rest = rest.slice(0, -motionSuffix[0].length);
  }
  rest = rest.replace(/_Seq$/i, '').replace(/^[A-Za-z0-9]+_AS_/, '').replace(/^.*?_ANIM_/i, '');
  // "Zenitsu_ArpgCombo1": a proper-name prefix directly followed by one CamelCase word.
  const characterPrefix = rest.match(/^([A-Z][a-z]+)_(?=[A-Z][A-Za-z0-9]*$)/);
  if (characterPrefix) {
    const prefix = characterPrefix[1].toLowerCase();
    if (!VOCAB.has(canon(prefix))) rest = rest.slice(characterPrefix[0].length);
  }
  return { rest, sourceTag, rootMotion };
}

function splitWords(text) {
  return text.match(/\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\d+|\p{Lo}+/gu) ?? [];
}

// Pulls F/B/L/R (and FL/FR/BL/BR) tokens and angles out of the word list.
function extractDirectionAndAngle(tokens) {
  const letters = [];
  const kept = [];
  const hasDirection = tokens.some((token) => /^[FBLR]{1,2}$/.test(token) || token.toLowerCase() in DIRECTION_WORDS);
  let angle = null;
  tokens.forEach((token, index) => {
    const lower = token.toLowerCase();
    const previous = (tokens[index - 1] ?? '').toLowerCase();
    if (/^[FBLR]{1,2}$/.test(token) && (token.length === 1 || DIRECTION_ZH[token])) letters.push(...token);
    else if (lower in DIRECTION_WORDS && previous !== 'step') letters.push(DIRECTION_WORDS[lower]);
    else if (ANGLES.has(token) && angle === null && (hasDirection || previous === 'turn')) angle = Number(token);
    else kept.push(token);
  });
  const vertical = letters.find((letter) => letter === 'F' || letter === 'B') ?? '';
  const horizontal = letters.find((letter) => letter === 'L' || letter === 'R') ?? '';
  return { words: kept, direction: vertical + horizontal || null, angle };
}

export function parseActionName(rawName) {
  const raw = String(rawName ?? '');
  const { rest, sourceTag, rootMotion } = stripWrappers(raw);
  const tokens = splitWords(rest).filter((token) => !NOISE_WORDS.has(token.toLowerCase()));
  const { words, direction, angle } = extractDirectionAndAngle(tokens);
  const numbers = words.filter(isNumber);
  return { raw, sourceTag, words, title: buildTitle(words), direction, angle, rootMotion, index: numbers.length ? numbers.join('-') : null };
}

function buildTitle(words) {
  const parts = [];
  words.forEach((word, position) => {
    if (isNumber(word) && isNumber(words[position - 1] ?? '')) parts[parts.length - 1] += `-${word}`;
    else parts.push(word.toLowerCase() === 'to' ? 'to' : isNumber(word) ? word : capitalize(word));
  });
  return parts.join(' ');
}

// Converts words into label pieces: {text, cjk, front, arrow}.
function labelPieces(words, category) {
  const lex = words.map((word) => canon(word.toLowerCase()));
  const breathing = lex.includes('breathe');
  const bowWeapon = bowIsWeapon(lex);
  const pieces = [];
  for (let position = 0; position < words.length; position += 1) {
    const word = lex[position];
    if (words.length === 1 && word === 'down') { pieces.push({ text: '倒下', cjk: true }); continue; }
    const phrase = [3, 2].map((size) => lex.slice(position, position + size).join(' ')).find((text) => PHRASES.has(text));
    if (phrase) {
      pieces.push({ text: PHRASES.get(phrase), cjk: true, keyword: true });
      position += phrase.split(' ').length - 1;
    } else if (isNumber(word) && pieces.at(-1)?.number) pieces.at(-1).text += `-${words[position]}`;
    else if (isNumber(word)) pieces.push({ text: words[position], number: true });
    else if (word === 'to' && pieces.length && position < words.length - 1) pieces.push({ text: '→', arrow: true });
    else if (LABEL_SKIPPED_WORDS.has(word)) continue;
    else if ((word === 'in' || word === 'out') && breathing) pieces.push({ text: GLOSSARY.get(word), cjk: true });
    else if ((word === 'with' || word === 'hold') && WEAPONS.has(nextContent(lex, position)) && (nextContent(lex, position) !== 'bow' || bowWeapon)) pieces.push({ text: '持', cjk: true });
    // A trailing "A" is a variant letter (GuardHitA, Death_A); "A_Pose" is the A-pose.
    else if ((word === 'a' || word === 'an') && (!lex.slice(position + 1).some((next) => !isNumber(next)) || /pose$/.test(lex[position + 1] ?? ''))) pieces.push({ text: words[position].toUpperCase(), cjk: false });
    else if (FUNCTION_WORDS.has(word)) continue;
    else if (word === 'bow' && bowWeapon) pieces.push({ text: '弓', cjk: true });
    else if (word === 'wave' && category !== 'emote') pieces.push({ text: '冲击波', cjk: true });
    else if (GLOSSARY.has(word)) pieces.push({ text: GLOSSARY.get(word), cjk: true, front: FRONT_MODIFIERS.has(word), keyword: KEYWORD_SET.has(word) });
    else pieces.push({ text: isCjk(word) ? words[position] : capitalize(words[position]), cjk: isCjk(word), foreign: !isCjk(word) });
  }
  return pieces;
}

function hoistModifiers(pieces) {
  const segments = [[]];
  for (const piece of pieces) {
    if (piece.arrow) segments.push([]);
    else segments.at(-1).push(piece);
  }
  const arrow = pieces.find((piece) => piece.arrow);
  return segments.map((segment) => [...segment.filter((piece) => piece.front), ...segment.filter((piece) => !piece.front)])
    .flatMap((segment, position) => (position ? [arrow, ...segment] : segment));
}

function joinPieces(pieces) {
  let text = '';
  pieces.forEach((piece, position) => {
    if (position === 0) text = piece.text;
    else if (piece.cjk && pieces[position - 1].cjk) text += piece.text;
    else text += ` ${piece.text}`;
  });
  return text.replace(/\s+/g, ' ').trim();
}

function buildLabel(parsed, category) {
  let pieces = labelPieces(parsed.words, category);
  // Sentence-like names (generated prompts, long descriptions) keep only the
  // translated action words: "Facing forward, a man drives a fast deep lunge" -> 快速扑击 · 前.
  if (parsed.words.length >= 8) {
    pieces = pieces.filter((piece) => piece.keyword || piece.front || piece.number);
    if (!pieces.some((piece) => piece.keyword)) return parsed.title || parsed.raw.trim() || '未命名动作';
  }
  const body = joinPieces(hoistModifiers(pieces));
  const suffix = [parsed.direction && DIRECTION_ZH[parsed.direction], parsed.angle ? `${parsed.angle}°` : null].filter(Boolean).join(' ');
  const label = suffix ? `${body} · ${suffix}`.replace(/^ · /, '') : body;
  return label || parsed.title || parsed.raw.trim() || '未命名动作';
}

// Category priority (first match wins), so mixed names resolve predictably:
//  1 director source -> emote           2 guarded locomotion (Walk_Block) -> move
//  3 down  4 hit (Guard/Block + Hit is claimed by defense first)  5 named techniques / skill words
//  6 defense (Roll_Combat_to_Run, Dodge_Air stay defense)  7 idle  8 attack (Combo_Attack_Air stays attack)
//  9 air (Run_Jump_Land)  10 emote  11 move  12 other
function pickCategory(parsed) {
  const lowered = parsed.words.map((word) => word.toLowerCase());
  const lex = lowered.map(canon);
  const bowWeapon = bowIsWeapon(lex);
  const words = new Set(lex);
  const keys = new Set(lowered.map((word, index) => (STEM_BLOCKED.has(word) ? word : lex[index]))
    .filter((word) => !(word === 'bow' && bowWeapon) && !(word === 'hop' && words.has('hip'))));
  const has = (...names) => names.some((name) => words.has(name));
  // In a sentence-like description a stance is the setup, not the action.
  const setup = parsed.words.length >= 8 ? ['stance', 'stand'] : [];
  const matches = (id) => KEYWORDS[id].some((name) => keys.has(name) && !setup.includes(name));
  const only = parsed.words.filter((word) => !isNumber(word));
  if (parsed.sourceTag === '导演') return 'emote';
  if (has('block', 'guard') && has(...LOCOMOTION_WORDS, 'turn')) return 'move';
  if (has('block', 'guard') && has('hit', 'break')) return 'defense';
  if (matches('down') || (has('kip') && has('up')) || (has('knock') && has('down', 'out', 'over')) || (has('get', 'stand') && has('up')) || (only.length === 1 && has('down'))) return 'down';
  if (has('combo') && has('hit') && !has('guard', 'block')) return 'attack';
  if (matches('hit')) return 'hit';
  if (matches('skill') || (has('power') && has('up')) || lowered.some((word) => TECHNIQUE_WORDS.has(word))) return 'skill';
  if (has('aim') && has(...LOCOMOTION_WORDS)) return 'move';
  for (const id of ['defense', 'idle', 'attack', 'air', 'emote', 'move']) if (matches(id)) return id;
  if ([...POSTURE_WORDS, ...setup].some((word) => keys.has(word))) return 'idle';
  return 'other';
}

function detectLoop(parsed, category, words) {
  if (words.includes('loop')) return true;
  if (words.some((word) => TRANSITION_WORDS.includes(word) || word === 'to')) return false;
  if (category === 'idle') return true;
  if (category === 'move') return words.some((word) => LOCOMOTION_WORDS.includes(word)) ? true : null;
  return ONE_SHOT_CATEGORIES.has(category) ? false : null;
}

export function classifyAction(rawName, { duration } = {}) {
  const parsed = parseActionName(rawName);
  const words = parsed.words.map((word) => canon(word.toLowerCase()));
  const raw = parsed.raw;
  const category = pickCategory(parsed);
  const pose = Number.isFinite(duration) && duration < 0.1;
  const loop = detectLoop(parsed, category, words);
  const tags = [];
  const addTag = (condition, tag) => { if (condition && !tags.includes(tag)) tags.push(tag); };
  addTag(loop === true, 'loop');
  addTag(parsed.rootMotion === 'in-place', 'in-place');
  addTag(parsed.rootMotion === 'root', 'root-motion');
  addTag(words.includes('to'), 'transition');
  addTag(words.includes('combat'), 'combat');
  addTag(pose, 'pose');
  addTag(/nodachi/i.test(raw), 'nodachi');
  addTag(words.includes('hit') && category !== 'hit', 'hit');
  addTag(words.includes('guard') || words.includes('block'), 'guard');
  addTag(words.includes('fast'), 'fast');
  addTag(Boolean(parsed.sourceTag), parsed.sourceTag === '探索' ? 'explore' : 'cinematic');
  for (const letter of parsed.direction ?? '') addTag(true, DIRECTION_TAGS[letter]);
  return {
    category, label: buildLabel(parsed, category), title: parsed.title || raw.trim(), tags, loop, pose,
    direction: parsed.direction, angle: parsed.angle, rootMotion: parsed.rootMotion, sourceTag: parsed.sourceTag,
  };
}

export function actionSearchText(rawName, classified = classifyAction(rawName)) {
  const category = CATEGORY_BY_ID.get(classified.category) ?? CATEGORY_BY_ID.get('other');
  return [rawName, classified.title, classified.label, category.label, category.en, classified.sourceTag, ...classified.tags]
    .filter(Boolean).join(' ').toLowerCase();
}

function naturalCompare(left, right) {
  const leftParts = left.toLowerCase().match(/\d+|\D+/g) ?? [];
  const rightParts = right.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let position = 0; position < Math.min(leftParts.length, rightParts.length); position += 1) {
    const a = leftParts[position];
    const b = rightParts[position];
    if (a === b) continue;
    if (isNumber(a) && isNumber(b)) return Number(a) - Number(b) || a.length - b.length;
    return a < b ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

function resolveAction(action) {
  const raw = action.raw ?? action.name ?? '';
  const classified = action.category && action.title ? action : classifyAction(raw, { duration: action.duration });
  return { classified, raw: String(raw) };
}

// Category order, then plain loops (idle/walk/run basics) before variants, single-frame poses last,
// then natural title order (numbers numeric), then raw name so the result is deterministic.
export function compareActions(a, b) {
  const left = resolveAction(a);
  const right = resolveAction(b);
  const categoryOrder = (item) => (CATEGORY_BY_ID.get(item.classified.category) ?? CATEGORY_BY_ID.get('other')).order;
  const basicRank = (item) => (item.classified.pose ? 2 : item.classified.loop === true ? 0 : 1);
  return categoryOrder(left) - categoryOrder(right)
    || basicRank(left) - basicRank(right)
    || naturalCompare(left.classified.title, right.classified.title)
    || naturalCompare(left.raw, right.raw);
}
