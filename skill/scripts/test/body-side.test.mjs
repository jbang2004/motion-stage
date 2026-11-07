import test from 'node:test';
import assert from 'node:assert/strict';
import {requestSides, boneSide, mirrorBoneName, sideConflict} from '../../assets/viewer/body-side.mjs';

test('request sides come from side + body-part phrases, not bare directions', () => {
  const sides = text => [...requestSides(text)].sort();
  assert.deepEqual(sides('左臂摆得太大，收一点，脚步和另一只手保持原样。'), ['left']);
  assert.deepEqual(sides('右边的手抬高一点'), ['right']);
  assert.deepEqual(sides('Left arm swings too much'), ['left']);
  assert.deepEqual(sides('左右手都收一点'), ['left', 'right']);
  assert.deepEqual(sides('左脚着地时右臂别动'), ['left', 'right']);
  assert.deepEqual(sides('向左转身时更快'), []);
  assert.deepEqual(sides('左右摇摆小一点'), []);
  assert.deepEqual(sides('收一点摆臂'), []);
});

test('bone sides cover common rig naming styles and stay silent when unsure', () => {
  const cases = {'mixamorig:RightForeArm': 'right', LeftArm: 'left', 'arm.L': 'left', upperarm_r: 'right', 'Bip01 L UpperArm': 'left', HandR: 'right', LHand: 'left', thigh_l: 'left', 左臂: 'left',
    Root: null, ROOT: null, Leg: null, Spine: null, LOD0: null, Lip: null, Ribcage: null};
  for (const [name, side] of Object.entries(cases)) assert.equal(boneSide(name), side, name);
  assert.equal(mirrorBoneName('mixamorig:RightForeArm'), 'mixamorig:LeftForeArm');
  assert.equal(mirrorBoneName('upperarm_r'), 'upperarm_l');
  assert.equal(mirrorBoneName('Bip01 L UpperArm'), 'Bip01 R UpperArm');
  assert.equal(mirrorBoneName('HandR'), 'HandL');
  assert.equal(mirrorBoneName('Spine'), null);
});

test('a conflict needs exactly one requested side that differs from the picked bone', () => {
  const conflict = sideConflict('左臂摆得太大，收一点', 'mixamorig:RightForeArm');
  assert.deepEqual([conflict.requested, conflict.picked, conflict.bone], ['left', 'right', 'mixamorig:RightForeArm']);
  assert.match(conflict.message, /右手在画面左边/);
  assert.equal(sideConflict('左臂摆得太大', 'mixamorig:LeftArm'), null);
  assert.equal(sideConflict('左右手都收一点', 'mixamorig:RightHand'), null);
  assert.equal(sideConflict('收一点摆臂', 'mixamorig:RightArm'), null);
  assert.equal(sideConflict('左臂摆得太大', 'mixamorig:Spine'), null);
});
