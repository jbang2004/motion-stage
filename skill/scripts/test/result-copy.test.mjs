import test from 'node:test';
import assert from 'node:assert/strict';
import {limitationText} from '../../assets/viewer/result-copy.mjs';

test('built-in local edit limitations display in Chinese while their report remains intact',()=>{
 const report={kind:'deterministic-local-edit',limitations:[
  'Only the selected local rotation channel changes; descendant world poses follow the edited parent.',
  'This is a parameterized tool, not an AI artistic judgment.',
  'No proof of collision-free motion, contact retention or engine integration.'
 ]},original=JSON.stringify(report),display=report.limitations.map(value=>limitationText(value,report.kind));
 assert.deepEqual(display,['仅修改选中的局部旋转轨道；子节点的整体姿态会随父节点变化。','本地微调按指定参数执行，效果需要你来判断。','尚未验证动作碰撞、接触点保持及游戏内表现。']);assert.equal(JSON.stringify(report),original);
});
test('unknown agent limitations and non-local reports retain their original text',()=>{
 const text='No proof of collision-free motion, contact retention or engine integration.';assert.equal(limitationText('Custom agent caveat','deterministic-local-edit'),'Custom agent caveat');assert.equal(limitationText(text,'agent-audit'),text);assert.equal(limitationText(text),text);
});
