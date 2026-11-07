import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTION_CATEGORIES,parseActionName,classifyAction,actionSearchText,compareActions} from '../../assets/viewer/action-taxonomy.mjs';

// [raw name, expected category, expected label, extra expectations]
const CLASSIFIED = [
  ['Zenitsu_ArpgIdle', 'idle', '待机'],
  ['Zenitsu_Breathe', 'idle', '呼吸'],
  ['Zenitsu_NodachiIdle', 'idle', '待机', {tags: ['nodachi'], loop: true}],
  ['NODACHI_AS_Idle_to_Idle_Combat_Seq', 'idle', '待机 → 战斗待机', {tags: ['transition'], loop: false}],
  ['NODACHI_AS_Idle_Up_L_Seq', 'idle', '待机上 · 左', {pose: true, duration: 0.03}],
  ['Tanjiro_StrafeLRun', 'move', '侧移奔跑 · 左', {direction: 'L'}],
  ['Zenitsu_ArpgWalkBL', 'move', '行走 · 后左', {direction: 'BL', loop: true}],
  ['Zenitsu_ArpgSprintStart', 'move', '冲刺起步', {loop: false}],
  ['Kaigaku_DashF', 'move', '突进 · 前', {direction: 'F'}],
  ['NODACHI_AS_Run_Fast_Turn_R_Seq__RM', 'move', '快速奔跑转身 · 右', {rootMotion: 'root', direction: 'R', loop: false}],
  ['NODACHI_AS_Walk_Loop_B_R_90_Seq__IP', 'move', '行走 · 后右 90°', {rootMotion: 'in-place', angle: 90, loop: true, tags: ['in-place', 'loop']}],
  ['NODACHI_AS_Run_Combat_Fast_Loop_Seq__RM', 'move', '战斗快速奔跑', {tags: ['combat', 'root-motion', 'fast']}],
  ['NODACHI_AS_Walk_Block_Start_F_0_Seq__RM', 'move', '行走格挡起步 · 前', {tags: ['guard'], angle: 0}],
  ['Kaigaku_GuardRun', 'move', '防御奔跑', {tags: ['guard']}],
  ['Zenitsu_ArpgCombo1', 'attack', '连招 1'],
  ['NODACHI_AS_Combo_Attack_03_02_Seq', 'attack', '连招攻击 03-02', {loop: false}],
  ['Zenitsu_OutwardSlash', 'attack', '外斩击'],
  ['Zenitsu_ArpgHeavy2', 'attack', '重击 2'],
  ['Zenitsu_IaiDrawCut', 'attack', '居合拔刀斩'],
  ['Akaza_Uppercut', 'attack', '上勾拳'],
  ['Nakime_Strike', 'attack', '打击'],
  ['Zenitsu_ArpgCharge', 'skill', '蓄力'],
  ['NODACHI_AS_Skill_06_Start_Seq', 'skill', '技能 06 起步'],
  ['NODACHI_AS_Ultimate_Attack_Air_Start_Seq', 'skill', '空中终极攻击起步'],
  ['Zenitsu_KaguraDash', 'skill', 'Kagura 突进'],
  ['Akaza_CrownSplitter', 'skill', 'Crown Splitter'],
  ['Zenitsu_ArpgGuard', 'defense', '防御'],
  ['Zenitsu_ArpgParry', 'defense', '格挡'],
  ['Zenitsu_ArpgGuardHit1', 'defense', '防御受击 1', {tags: ['hit', 'guard']}],
  ['Tanjiro_DodgeBack', 'defense', '闪避 · 后', {direction: 'B'}],
  ['Zenitsu_ArpgBackstep', 'defense', '后撤步'],
  ['NODACHI_AS_Roll_Combat_to_Run_F_0_Seq__RM', 'defense', '战斗翻滚 → 奔跑 · 前', {tags: ['transition', 'combat'], angle: 0}],
  ['NODACHI_AS_Dodge_Air_B_180_Seq__RM', 'defense', '空中闪避 · 后 180°', {angle: 180}],
  ['Zenitsu_ArpgHit', 'hit', '受击'],
  ['Zenitsu_WallHit', 'hit', '撞墙受击'],
  ['Zenitsu_ArpgHitGut', 'hit', '受击腹部'],
  ['Kaigaku_HitBigR', 'hit', '大型受击 · 右'],
  ['NODACHI_AS_Hit_Air_Large_To_Floor_End_Seq', 'hit', '空中大型受击 → 地面结束'],
  ['Zenitsu_ArpgCollide', 'hit', '碰撞'],
  ['Tanjiro_JumpAir', 'air', '空中跳跃'],
  ['Zenitsu_ArpgLand2', 'air', '落地 2'],
  ['Zenitsu_RunJumpLand', 'air', '奔跑跳跃落地'],
  ['NODACHI_AS_Double_Jump_R_90_Seq', 'air', '二段跳 · 右 90°'],
  ['Kaigaku_FlipB', 'air', '翻身 · 后'],
  ['Zenitsu_ArpgDeath', 'down', '死亡'],
  ['Zenitsu_GetUp', 'down', '起身'],
  ['Zenitsu_KipUp', 'down', '鲤鱼打挺'],
  ['Zenitsu_Kneel', 'down', '跪地'],
  ['NODACHI_AS_Knock_Down_Combat_Death_F_Seq', 'down', '战斗倒地死亡 · 前'],
  ['Tanjiro_Victory', 'emote', '胜利'],
  ['Kaigaku_Taunt', 'emote', '嘲讽'],
  ['Zenitsu_ArpgDraw', 'emote', '拔刀'],
  ['Zenitsu_ArpgSheathe', 'emote', '收刀'],
  ['导演__Director_zn-rokuren', 'emote', '导演 Zn Rokuren', {sourceTag: '导演'}],
  ['探索__Zenitsu_ArpgXLand', 'air', '落地', {sourceTag: '探索', tags: ['explore']}],
  ['探索__Zenitsu_ExploreRun', 'move', '探索奔跑', {sourceTag: '探索'}],
  ['mixamo.com', 'other', 'mixamo.com'],
  ['Armature|Run', 'move', '奔跑'],
  ['Take 001', 'other', 'Take 001'],
  ['CharacterArmature|Idle_Sword', 'idle', '待机剑'],
  ['run_forward', 'move', '奔跑 · 前', {direction: 'F'}],
  ['Walk-Back', 'move', '行走 · 后', {direction: 'B'}],
];

for (const [raw, category, label, extra = {}] of CLASSIFIED) {
  test(`classifies ${raw}`, () => {
    const result = classifyAction(raw, {duration: extra.duration});
    assert.equal(result.category, category);
    assert.equal(result.label, label);
    for (const key of ['direction', 'angle', 'rootMotion', 'loop', 'pose', 'sourceTag']) if (key in extra) assert.equal(result[key], extra[key], key);
    for (const tag of extra.tags ?? []) assert.ok(result.tags.includes(tag), `${raw} missing tag ${tag}`);
  });
}

test('parseActionName strips prefixes and extracts direction, angle, root motion and index', () => {
  const parsed = parseActionName('NODACHI_AS_Combo_Attack_03_02_Seq');
  assert.deepEqual(parsed.words, ['Combo', 'Attack', '03', '02']);
  assert.equal(parsed.title, 'Combo Attack 03-02');
  assert.equal(parsed.index, '03-02');
  const walk = parseActionName('NODACHI_AS_Walk_Loop_B_R_90_Seq__IP');
  assert.deepEqual({words: walk.words, direction: walk.direction, angle: walk.angle, rootMotion: walk.rootMotion}, {words: ['Walk', 'Loop'], direction: 'BR', angle: 90, rootMotion: 'in-place'});
  assert.equal(parseActionName('Zenitsu_ArpgCombo1').title, 'Combo 1');
  assert.equal(parseActionName('Zenitsu_ArpgCombo1').index, '1');
  assert.equal(parseActionName('Zenitsu_ArpgXLand').title, 'Land');
  assert.equal(parseActionName('探索__Zenitsu_ArpgXLand').sourceTag, '探索');
  assert.equal(parseActionName('Armature|Run').title, 'Run');
  assert.equal(parseActionName('NODACHI_AS_Roll_Combat_to_Run_F_0_Seq__RM').title, 'Roll Combat to Run');
});

test('a prefix that is itself an action word is not stripped', () => {
  assert.equal(parseActionName('Idle_Sword').title, 'Idle Sword');
  assert.equal(parseActionName('Zenitsu_Walk').title, 'Walk');
});

test('single frames are marked as poses only below 0.1 seconds', () => {
  assert.equal(classifyAction('NODACHI_AS_Idle_Up_L_Seq', {duration: 0.03}).pose, true);
  assert.equal(classifyAction('NODACHI_AS_Idle_Up_L_Seq', {duration: 1.2}).pose, false);
  assert.equal(classifyAction('NODACHI_AS_Idle_Up_L_Seq').pose, false);
  assert.ok(classifyAction('X', {duration: 0.03}).tags.includes('pose'));
});

test('labels are never empty, even for junk names', () => {
  for (const raw of ['', '   ', 'Arpg', '__RM', 'Seq', 'mixamo.com', '探索__']) assert.notEqual(classifyAction(raw).label, '', JSON.stringify(raw));
});

test('categories keep the documented ids with other last', () => {
  assert.deepEqual(ACTION_CATEGORIES.map((category) => category.id), ['idle', 'move', 'attack', 'skill', 'defense', 'hit', 'air', 'down', 'emote', 'other']);
});

test('actionSearchText is lowercase and covers raw, label, category and tags', () => {
  const text = actionSearchText('NODACHI_AS_Walk_Loop_B_R_90_Seq__IP');
  for (const part of ['nodachi_as_walk', '行走', '移动', 'move', 'in-place', 'loop']) assert.ok(text.includes(part), part);
  assert.equal(text, text.toLowerCase());
  assert.ok(actionSearchText('Zenitsu_Walk', classifyAction('Zenitsu_Walk')).includes('zenitsu_walk'));
});

test('compareActions orders by category, loops first, then natural title order', () => {
  const names = ['Zenitsu_ArpgCombo10', 'Zenitsu_ArpgCombo2', 'Zenitsu_ArpgDeath', 'Zenitsu_ArpgSprintStart', 'Zenitsu_ArpgSprint', 'Zenitsu_ArpgIdle', 'Mystery'];
  const sorted = names.map((name) => ({name})).sort(compareActions).map((item) => item.name);
  assert.deepEqual(sorted, ['Zenitsu_ArpgIdle', 'Zenitsu_ArpgSprint', 'Zenitsu_ArpgSprintStart', 'Zenitsu_ArpgCombo2', 'Zenitsu_ArpgCombo10', 'Zenitsu_ArpgDeath', 'Mystery']);
  const classified = classifyAction('Zenitsu_ArpgIdle');
  assert.equal(compareActions(classified, classified), 0);
  assert.ok(compareActions({name: 'a_Idle', duration: 0.03}, {name: 'b_Idle', duration: 2}) > 0);
});

// Inline sample of the real project action list: [clip name, duration seconds].
const SAMPLE = [
  ['Zenitsu_RunBack', 0.73],
  ['Zenitsu_ChargeHold', 2.00],
  ['Zenitsu_RunJumpLand', 0.33],
  ['Zenitsu_ArpgParry', 0.60],
  ['Zenitsu_ArpgHit', 0.83],
  ['Zenitsu_ArpgAirCutStart', 0.27],
  ['Zenitsu_NodachiStop', 1.03],
  ['Tanjiro_StrafeRRun', 0.63],
  ['Tanjiro_SpinSlash', 1.53],
  ['Tanjiro_HighSpin', 1.70],
  ['Tanjiro_BreatheOut', 1.33],
  ['Kaigaku_BladeSlash', 0.80],
  ['Kaigaku_HitBack', 1.43],
  ['Kaigaku_Launched', 2.67],
  ['Kaigaku_Weave', 1.20],
  ['Kaigaku_Shubun2', 2.08],
  ['Akaza_Invite', 3.13],
  ['Akaza_WalkFwd', 2.80],
  ['Akaza_AdvanceCombo', 1.60],
  ['Akaza_JumpAir', 0.15],
  ['Zenitsu_NodachiWalkF', 1.05],
  ['NODACHI_AS_Attack_Air_to_Floor_02_End_Seq', 1.83],
  ['NODACHI_AS_Combo_Attack_01_01_Seq', 1.83],
  ['NODACHI_AS_Combo_Attack_04_02_Seq', 2.42],
  ['NODACHI_AS_Combo_Attack_Air_Wave_02_Seq', 1.00],
  ['NODACHI_AS_Dodge_Air_B_R_45_Seq__RM', 0.92],
  ['NODACHI_AS_Dodge_Air_Combat_R_90_Seq__IP', 0.92],
  ['NODACHI_AS_Dodge_B_L_45_Seq__RM', 1.67],
  ['NODACHI_AS_Dodge_Combat_L_90_Seq__IP', 1.67],
  ['NODACHI_AS_Dodge_Combat_to_Run_F_R_45_Seq__RM', 1.33],
  ['NODACHI_AS_Dodge_R_90_Seq__IP', 1.67],
  ['NODACHI_AS_Dodge_to_Run_Fast_F_0_Seq__RM', 1.08],
  ['NODACHI_AS_Execution_01_Seq', 2.50],
  ['NODACHI_AS_Hit_B_Seq', 0.83],
  ['NODACHI_AS_Hit_Combat_Large_F_Seq', 1.00],
  ['NODACHI_AS_Idle_Combat_Down_0_Seq', 0.03],
  ['NODACHI_AS_Idle_Seq', 10.00],
  ['NODACHI_AS_Jump_Combat_to_Run_F_0_Seq', 0.83],
  ['NODACHI_AS_Jump_to_Run_B_180_Seq', 0.83],
  ['NODACHI_AS_Parry_Counter_R_Seq', 1.83],
  ['NODACHI_AS_Roll_Combat_F_0_Seq__IP', 1.17],
  ['NODACHI_AS_Roll_Combat_to_Run_B_R_45_Seq__RM', 1.50],
  ['NODACHI_AS_Roll_F_L_45_Seq__IP', 1.17],
  ['NODACHI_AS_Roll_to_Run_F_0_Seq__RM', 1.50],
  ['NODACHI_AS_Run_Combat_Fast_Lean_R_Loop_Seq__IP', 0.47],
  ['NODACHI_AS_Run_Combat_Fast_Stop_Seq__RM', 1.03],
  ['NODACHI_AS_Run_Combat_Loop_F_0_Seq__IP', 0.67],
  ['NODACHI_AS_Run_Combat_Start_B_L_90_Seq__RM', 0.83],
  ['NODACHI_AS_Run_Combat_Start_Fast_B_L_Seq__IP', 0.83],
  ['NODACHI_AS_Run_Combat_Stop_B_R_45_Seq__RM', 1.50],
  ['NODACHI_AS_Run_Fast_Lean_L_Loop_Seq__IP', 0.47],
  ['NODACHI_AS_Run_Fast_Start_Seq__RM', 0.50],
  ['NODACHI_AS_Run_Loop_B_R_90_Seq__IP', 0.67],
  ['NODACHI_AS_Run_Start_B_L_45_Seq__RM', 0.83],
  ['NODACHI_AS_Run_Start_F_R_90_Seq__IP', 0.83],
  ['NODACHI_AS_Run_Stop_B_L_90_Seq__RM', 1.50],
  ['NODACHI_AS_Run_to_Run_Combat_Seq__IP', 0.67],
  ['NODACHI_AS_Turn_180_L_Seq', 1.52],
  ['NODACHI_AS_Ultimate_Attack_Air_Start_Seq', 0.33],
  ['NODACHI_AS_Walk_Block_Loop_F_L_45_Seq__IP', 1.05],
  ['NODACHI_AS_Walk_Block_Start_F_L_45_Seq__IP', 1.83],
  ['NODACHI_AS_Walk_Block_Stop_F_0_Seq__RM', 1.07],
  ['NODACHI_AS_Walk_Combat_Loop_B_R_90_Seq__IP', 1.05],
  ['NODACHI_AS_Walk_Combat_Start_B_L_45_Seq__RM', 1.83],
  ['NODACHI_AS_Walk_Combat_Start_F_R_90_Seq__RM', 1.83],
  ['NODACHI_AS_Walk_Combat_Stop_F_L_90_Seq__IP', 1.07],
  ['NODACHI_AS_Walk_Loop_B_R_45_Seq__RM', 1.05],
  ['NODACHI_AS_Walk_Start_B_L_45_Seq__IP', 1.83],
  ['NODACHI_AS_Walk_Start_F_R_45_Seq__RM', 1.83],
  ['NODACHI_AS_Walk_Stop_F_L_45_Seq__IP', 1.07],
  ['Zenitsu_ArpgXSprint', 0.63],
  ['Zenitsu_Impact', 1.23],
  ['Zenitsu_DownwardSlash', 1.20],
  ['Zenitsu_Sprint', 0.53],
  ['Zenitsu_FallLand', 0.83],
  ['Zenitsu_ExecTurnCut', 1.43],
  ['Zenitsu_ArpgParry', 0.60],
  ['Zenitsu_ArpgBrake2', 0.67],
  ['Zenitsu_ArpgGuardUp', 0.17],
  ['Zenitsu_ArpgBrake', 0.67],
  ['Zenitsu_KashaFlip', 1.63],
  ['Akaza_CrownSplitter', 1.13],
  ['Nakime_Strike', 0.80],
  ['NODACHI_AS_Idle_Up_L_Seq', 0.03],
  ['NODACHI_AS_Roll_Combat_to_Run_F_0_Seq__RM', 1.50]
];

test('real-name sample classifies sanely', () => {
  const ids = new Set(ACTION_CATEGORIES.map((category) => category.id));
  let other = 0;
  for (const [name, duration] of SAMPLE) {
    const result = classifyAction(name, {duration});
    assert.ok(result.label.length > 0, name);
    assert.ok(ids.has(result.category), name);
    if (result.category === 'other') other += 1;
  }
  assert.ok(other / SAMPLE.length <= 0.15, `other share ${other}/${SAMPLE.length}`);
});

// Ordinary projects name clips in plain English: Mixamo descriptions, asset-pack
// exports, auto-rig tools and generated prompts. [raw name, category, label].
const GENERIC = [
  ['Walking', 'move', '行走'],
  ['Running', 'move', '奔跑'],
  ['Dying', 'down', '死亡'],
  ['defeat_02', 'down', '战败 02'],
  ['Falling', 'air', '坠落'],
  ['Crouch', 'idle', '蹲'],
  ['Crouch Walk', 'move', '蹲行走'],
  ['Sitting_Enter', 'idle', '坐进入'],
  ['Rifle Aim', 'idle', '步枪瞄准'],
  ['Walking While Aiming Rifle', 'move', '行走瞄准步枪'],
  ['Hit Reaction From The Left With Axe', 'hit', '受击反应持斧 · 左'],
  ['Knocked Out Falling To Back', 'down', '击倒坠落 · 后'],
  ['Getting Up From Back', 'down', '起身 · 后'],
  ['Walking Forward With Bow', 'move', '行走持弓 · 前'],
  ['Bow', 'emote', '鞠躬'],
  ['Standing Aim Fire Arrow', 'attack', '站立瞄准放箭'],
  ['Three Hit Combo Attack With Axe', 'attack', '三连击连招攻击持斧'],
  ['Death_A', 'down', '死亡 A'],
  ['A_Pose', 'other', 'A 姿势'],
  ['Running With A Sword In The Right Hand', 'move', '奔跑持剑手 · 右'],
  ['Sword And Shield Powering Up', 'skill', '剑盾强化'],
  ['Hip Hop Dancing', 'emote', '街舞舞蹈'],
  ['CharacterArmature|HitRecieve', 'hit', '受击'],
  ['Lie_StandUp', 'down', '躺起身'],
  ['Facing forward, a man drives a fast deep lunge forward, extendi', 'attack', '快速扑击 · 前'],
  ['Archer attack, powerful and cinematic: from a ready stance, step', 'attack', '攻击架势步'],
];

for (const [raw, category, label] of GENERIC) {
  test(`classifies generic ${raw}`, () => {
    const result = classifyAction(raw, {duration: 1});
    assert.equal(result.category, category);
    assert.equal(result.label, label);
  });
}

test('long prompt-like names without a known action keep their English title', () => {
  const raw = 'A Chinese swordsman holding a sword in his right hand raises it';
  assert.equal(classifyAction(raw).label, 'A Chinese Swordsman Holding A Sword In His Hand Raises It');
});

test('English glue words never leak breathing or bowing glosses into labels', () => {
  assert.doesNotMatch(classifyAction('Running With A Sword In The Right Hand').label, /吸入|The/);
  assert.doesNotMatch(classifyAction('Knocked Out Falling To Back').label, /呼出/);
  assert.equal(classifyAction('Tanjiro_BreatheOut').label, '呼吸呼出');
  assert.equal(classifyAction('Tanjiro_GuardHitA').label, '防御受击 A');
});

// Mixamo / asset-pack names, the generic counterpart of SAMPLE above.
const GENERIC_SAMPLE = [
  'Idle', 'Walking', 'Running', 'Jump', 'Death', 'Dying', 'Falling', 'Crouch Walk', 'Sitting Idle', 'Climbing',
  'Swimming', 'Shooting', 'Rifle Aim', 'Throw', 'Hip Hop Dancing', 'Victory', 'Taunt', 'Punch', 'Kick', 'Sword Slash',
  'Spell Cast', 'Block', 'Dodge', 'Roll', 'Hit Reaction', 'Knocked Down', 'Getting Up', 'Strafe Left', 'Turn Right',
  'Talking', 'Yell', 'Laughing', 'Sad Idle', 'Look Around', 'Breathing Idle', 'Walk_Back', 'Run_Fwd', 'Attack_02',
  'Hurt', 'Flying', 'CharacterArmature|Gun_Shoot', 'CharacterArmature|Punch_Left', 'CharacterArmature|Run_Shoot',
  'Sword_AttackFast', 'Staff_Attack', 'Bow_Shoot', 'Unarmed_Idle', 'Swim_Fwd', 'Gesture_Point', 'Death_B',
  'Sword And Shield Slash (combo)', 'Inward Slashing With A Sword Standing Stable', 'Running With A Sword In The Right Hand',
  'Standing React Large From Front', 'Dying Falling Backward', 'Quick Roll To Run', 'Withdrawing A Sword',
  'Sheathing A Sword', 'Jumping Backwards Dodge', 'Knocked Over And Falling To The Ground', 'Getting Up From Stomach',
  'Walking Forward With Axe', 'Charging Bow For Powershot', 'Walking While Aiming Rifle', 'General Conversation',
  'Being Terrified While Standing', 'Asking A Question With Two Hands', 'Slow Old Man Shuffle Walk',
];

test('ordinary English clip names classify sanely', () => {
  let other = 0;
  for (const name of GENERIC_SAMPLE) {
    const result = classifyAction(name, {duration: 1});
    assert.ok(result.label.length > 0, name);
    if (result.category === 'other') other += 1;
  }
  assert.ok(other / GENERIC_SAMPLE.length <= 0.15, `other share ${other}/${GENERIC_SAMPLE.length}`);
  assert.equal(classifyAction('Walking Forward With Bow').category, 'move', 'a held bow is not a bow gesture');
});
