const localEditLimitations=new Map([
 ['Only the selected local rotation channel changes; descendant world poses follow the edited parent.','仅修改选中的局部旋转轨道；子节点的整体姿态会随父节点变化。'],
 ['This is a parameterized tool, not an AI artistic judgment.','本地微调按指定参数执行，效果需要你来判断。'],
 ['No proof of collision-free motion, contact retention or engine integration.','尚未验证动作碰撞、接触点保持及游戏内表现。']
]);

export function limitationText(value,reportKind){
 return reportKind==='deterministic-local-edit'?localEditLimitations.get(value)||value:value;
}
