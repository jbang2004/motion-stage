import {element, createActionButton} from './ui.mjs';

export function projectArray(value) {
  return Array.isArray(value) ? value : [];
}

function readableText(value) {
  if (typeof value === 'string') return value;
  return value?.text || value?.userInstruction || value?.userText || value?.instruction ||
    value?.message || value?.outcome || value?.request || value?.detail || value?.reason || '';
}

function scopeLabel(scope, describeBone) {
  if (typeof scope === 'string') return scope;
  if (scope?.wholeClip) return '整个动作';
  if (Number.isFinite(scope?.start) && Number.isFinite(scope?.end)) {
    return scope.start.toFixed(3) + '–' + scope.end.toFixed(3) + ' 秒';
  }
  if (scope?.bone) return describeBone(scope.bone) || '原任务指定部位';
  if (scope?.clip) return scope.clip;
  return '沿用原任务的适用范围';
}

function appendRequirements(host, requirements, el, describeScope) {
  if (!requirements.length) return;
  host.append(el('h4', '明确写下的保留条件'));
  for (const requirement of requirements) {
    const item = el('div', undefined, 'project-context-item');
    item.append(el('b', readableText(requirement)));
    if (requirement.scope) item.append(el('p', '适用范围：' + describeScope(requirement.scope)));
    host.append(item);
  }
}

function appendCheckpoints(host, checkpoints, el, describeScope) {
  const active = checkpoints.filter(point => point.active === true && point.stillAccepted !== false);
  if (active.length) host.append(el('h4', '当前有效的用户验收检查点'));
  for (const point of active) {
    const item = el('div', undefined, 'project-context-item');
    item.append(el('b', point.outcome || '用户已接受这个精确版本'));
    if (point.scope) item.append(el('p', '检查范围：' + describeScope(point.scope)));
    host.append(item);
  }
  const history = checkpoints.filter(point => !active.includes(point));
  if (!history.length) return;
  const past = el('details');
  past.append(el('summary', '历史接受记录（不是当前验收）'));
  for (const point of history) {
    const item = el('div', undefined, 'project-context-item');
    const reason = point.stillAccepted === false ? '该接受决定后来已撤回或更改。' :
      point.onSourceAncestry === false ? '这是其他分支上的历史决定。' :
        '历史记录，当前未作为有效验收检查点。';
    item.append(el('b', point.outcome || '历史用户决定'), el('p', reason));
    past.append(item);
  }
  host.append(past);
}

function appendInstructions(host, instructions, el, describeScope) {
  if (!instructions.length) return;
  const words = el('details');
  words.append(el('summary', '沿用的历史原话（含保留要求）'));
  for (const instruction of instructions) {
    const item = el('div', undefined, 'project-context-item');
    item.append(el('b', instruction.text || instruction.request || ''));
    if (instruction.scope) item.append(el('p', '当时范围：' + describeScope(instruction.scope)));
    words.append(item);
  }
  host.append(words);
}

function appendFiles(host, context, el) {
  for (const [key, title] of [['code', '相关代码'], ['sources', '相关制作源'], ['history', '相关项目记录']]) {
    const files = projectArray(context[key]);
    if (!files.length) continue;
    host.append(el('h4', title));
    for (const file of files) {
      const item = el('div', undefined, 'project-context-item');
      if (file.confidence === 'candidate') {
        item.append(el('span', '可能相关 · 尚未确认绑定', 'context-confidence'));
      }
      item.append(el('b', file.relativePath || file.path || '相关文件'));
      if (file.why) item.append(el('p', file.why));
      const excerpts = projectArray(file.excerpts);
      if (excerpts.length) {
        const original = el('details');
        original.append(el('summary', '查看相关原文'));
        for (const excerpt of excerpts) {
          const lines = excerpt.startLine ? '第 ' + excerpt.startLine +
            (excerpt.endLine && excerpt.endLine !== excerpt.startLine ? '–' + excerpt.endLine : '') + ' 行\n' : '';
          original.append(el('pre', lines + (excerpt.text || '')));
        }
        item.append(original);
      }
      host.append(item);
    }
  }
}

function appendAncestry(host, ancestry, el) {
  if (!ancestry.length) return;
  const past = el('details');
  past.append(el('summary', '此前已完成的修改（仅作背景）'));
  for (const ancestor of ancestry) {
    const item = el('div', undefined, 'project-context-item');
    if (ancestor.request) item.append(el('b', ancestor.request));
    if (ancestor.summary) item.append(el('p', '当时的完成说明：' + ancestor.summary));
    past.append(item);
  }
  host.append(past);
}

function appendReferences(host, references, el) {
  const noteworthy = references.filter(reference => ['missing', 'external'].includes(reference.status));
  if (!noteworthy.length) return;
  host.append(el('h4', '需要留意的素材引用'));
  for (const reference of noteworthy) {
    const item = el('div', undefined, 'project-context-item');
    item.append(el('b', (reference.status === 'missing' ? '缺少引用：' : '外部引用：') +
      (reference.reference || reference.from || '未命名引用')));
    if (reference.why) item.append(el('p', reference.why));
    host.append(item);
  }
}

function appendRejected(host, rejected, el) {
  if (!rejected.length) return;
  host.append(el('h4', '避免重复的方案'));
  for (const approach of rejected) {
    const item = el('div', undefined, 'project-context-item');
    const outcome = approach.outcome || readableText(approach);
    if (outcome) item.append(el('b', outcome));
    if (approach.request) item.append(el('p', '当时修改目标（背景）：' + approach.request));
    if (approach.superseded) item.append(el('p', '之后还有新的用户决定；此处仅保留历史。'));
    host.append(item);
  }
}

// A deterministic DOM projection. Preview I/O, historical snapshot caches and
// view ownership remain in the host; this function never changes the payload.
export function renderProjectContext(host, payload, {
  frozen = false, onLinkProject = () => {}, onError = console.error, describeBone = () => null
} = {}) {
  const document = host.ownerDocument;
  const el = (tag, text, className) => element(tag, text, className, document);
  const describeScope = scope => scopeLabel(scope, describeBone);
  const context = payload?.projectContext || null;
  const continuity = payload?.continuity || {};
  host.replaceChildren();
  host.classList.add('project-context-content');

  if (payload?.source === 'legacy' || payload?.status === 'legacy' || context?.status === 'legacy') {
    host.append(el('p', '这条旧任务创建时没有保存项目资料快照。原有反馈和素材版本仍保留，不会用现在的资料补写历史。', 'context-note'));
    return;
  }
  if (!context || context.status === 'unlinked') {
    host.append(el('p', frozen ? '这条任务创建时没有关联项目。素材版本与观察现场仍保存在任务中。' :
      '关联一次游戏项目，就能按本次修改自动找到相关代码、制作源和历史要求。'));
    if (!frozen) host.append(createActionButton('关联游戏项目 →', onLinkProject, {
      className: 'text-button', ownerDocument: document, onError
    }));
    return;
  }
  if (context.status === 'missing') {
    host.append(el('p', '关联的项目文件夹暂时无法读取。任务仍会保留，缺少的资料请在下方查看。', 'context-note'));
  }
  if (frozen) host.append(el('p', '以下是提交这条任务时保存的资料，不随当前项目变化。', 'context-note'));

  const requirements = projectArray(continuity.inheritedRequirements);
  const checkpoints = projectArray(continuity.acceptedCheckpoints);
  appendRequirements(host, requirements, el, describeScope);
  appendCheckpoints(host, checkpoints, el, describeScope);
  appendInstructions(host, projectArray(continuity.historicalInstructions), el, describeScope);
  appendFiles(host, context, el);
  appendAncestry(host, projectArray(continuity.ancestry), el);
  appendReferences(host, projectArray(context.references), el);
  appendRejected(host, projectArray(continuity.rejectedApproaches), el);
  for (const warning of [...projectArray(context.warnings), ...projectArray(continuity.warnings)]) {
    const text = readableText(warning);
    if (text) host.append(el('p', text, 'context-note'));
  }
  if (!requirements.length && !checkpoints.length &&
      !projectArray(context.code).length && !projectArray(context.sources).length && !projectArray(context.history).length) {
    host.append(el('p', '这次暂未找到可确认关联的项目资料。Agent 会根据任务现场继续检查，不会将猜测当作已绑定的制作源。'));
  }
  host.append(el('p', frozen ? '记录保留的是本次任务资料。“保留候选”与正式替换游戏文件分别处理。' :
    '以上为当前预览；提交时会重新核对，并将本次资料与要求独立保存。', 'context-note'));
}
