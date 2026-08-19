// 用途：构建并校验 Git 治理正文提案与飞书现有页面之间的确定性协调计划。
// 边界：本模块不访问网络、不写飞书；任一页面或身份范围漂移会使整份计划失效。

import { planDigest, sha256 } from './feishu-governance-core.mjs';

const ACTIONS = new Set([
  'keep', 'update_body', 'rename_in_place', 'merge_into_target', 'write_legacy_redirect',
]);
const DECISIONS = new Set(['remote_unchanged', 'manual_merge_approved', 'no_write']);

function fail(message) {
  const error = new Error(message);
  error.exitCode = 8;
  throw error;
}

function assertSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value || ''))) fail(`${label} 必须是完整 SHA-256。`);
}

function normalizedRevision(value, label = 'revision_id') {
  if (value === -1 || value === '-1' || value === null || value === undefined || value === '') {
    fail(`${label} 必须是 dry-run 读取到的精确版本，禁止使用 -1。`);
  }
  if (!(Number.isInteger(value) && value >= 0) && !(typeof value === 'string' && value.length > 0)) {
    fail(`${label} 格式不合法。`);
  }
  return value;
}

function expectedRemote(page) {
  const expected = {
    revision_id: normalizedRevision(page.revision_id, `${page.source_path}.revision_id`),
    body_sha256: page.body_sha256,
    title_sha256: page.title_sha256,
    parent_node_ref: page.parent_node_ref,
    marker_sha256: page.marker_sha256,
    scope_sha256: page.scope_sha256,
  };
  for (const field of ['body_sha256', 'title_sha256', 'marker_sha256', 'scope_sha256']) {
    assertSha256(expected[field], `${page.source_path}.${field}`);
  }
  if (!/^[0-9a-f]{10,64}$/.test(String(expected.parent_node_ref || ''))) {
    fail(`${page.source_path}.parent_node_ref 格式不合法。`);
  }
  return expected;
}

function proposalSummary(page) {
  const proposal = {
    git_sha256: page.git_sha256,
    block_signature_sha256: page.proposal_block_signature_sha256,
    resolved_links_sha256: page.resolved_links_sha256,
  };
  for (const [field, value] of Object.entries(proposal)) assertSha256(value, `${page.target_path}.${field}`);
  return proposal;
}

function actionFor(page) {
  if (page.authority_decision === 'no_write') return 'keep';
  if (page.legacy_redirect) return 'write_legacy_redirect';
  if (page.merge_into_target) return 'merge_into_target';
  if (page.source_path !== page.target_path) return 'rename_in_place';
  if (page.remote_block_signature_sha256 === page.proposal_block_signature_sha256) return 'keep';
  return 'update_body';
}

function buildReconciliationPlan({
  generatedAt, publicationManifestSha256, sourceStateSha256, scope, pages,
}) {
  assertSha256(publicationManifestSha256, 'publication_manifest_sha256');
  assertSha256(sourceStateSha256, 'source_state_sha256');
  for (const field of ['app_id_sha256', 'space_id_sha256', 'managed_root_node_sha256']) {
    assertSha256(scope?.[field], `scope.${field}`);
  }
  if (!Array.isArray(pages) || pages.length < 1) fail('协调计划至少需要一个页面动作。');
  const sourcePaths = new Set();
  const actionIds = new Set();
  const actions = pages.map((page, index) => {
    if (!page.source_path || !page.target_path) fail('协调页面缺少 source_path 或 target_path。');
    if (sourcePaths.has(page.source_path)) fail(`协调计划包含重复来源页面：${page.source_path}`);
    sourcePaths.add(page.source_path);
    if (!DECISIONS.has(page.authority_decision)) fail(`未知正文权威决定：${page.source_path}`);
    if (page.authority_decision === 'remote_unchanged'
        && page.remote_block_signature_sha256 !== page.last_synced_block_signature_sha256) {
      fail(`飞书正文自上次同步后发生变化，必须先人工合并：${page.source_path}`);
    }
    for (const field of ['remote_block_signature_sha256', 'last_synced_block_signature_sha256']) {
      assertSha256(page[field], `${page.source_path}.${field}`);
    }
    if (!/^[0-9a-f]{10,64}$/.test(String(page.source_node_ref || ''))
        || !/^[0-9a-f]{10,64}$/.test(String(page.target_node_ref || ''))) {
      fail(`页面节点引用格式不合法：${page.source_path}`);
    }
    const actionId = `REC-${String(index + 1).padStart(3, '0')}`;
    if (actionIds.has(actionId)) fail(`重复动作编号：${actionId}`);
    actionIds.add(actionId);
    const allowedAction = actionFor(page);
    if (!ACTIONS.has(allowedAction)) fail(`未知协调动作：${page.source_path}`);
    const expected = expectedRemote(page);
    const proposal = proposalSummary(page);
    const idempotencyKey = sha256([
      actionId, page.source_path, page.target_path, expected.revision_id,
      expected.body_sha256, proposal.block_signature_sha256, allowedAction,
    ].join('\u0000')).slice(0, 40);
    return {
      action_id: actionId,
      source_path: page.source_path,
      target_path: page.target_path,
      source_node_ref: page.source_node_ref,
      target_node_ref: page.target_node_ref,
      expected_remote: expected,
      proposal,
      authority_decision: page.authority_decision,
      allowed_action: allowedAction,
      idempotency_key: idempotencyKey,
    };
  });
  const plan = {
    schema_version: '1.0',
    generated_at: generatedAt || new Date().toISOString(),
    mode: 'governance_validation',
    publication_manifest_sha256: publicationManifestSha256,
    source_state_sha256: sourceStateSha256,
    scope: {
      app_id_sha256: scope.app_id_sha256,
      space_id_sha256: scope.space_id_sha256,
      managed_root_node_sha256: scope.managed_root_node_sha256,
    },
    actions,
  };
  plan.plan_digest = planDigest(plan);
  return plan;
}

function validatePlanDigest(plan, confirmedDigest = null) {
  assertSha256(plan?.plan_digest, 'plan_digest');
  const actual = planDigest(plan);
  if (actual !== plan.plan_digest) fail('协调计划摘要与计划内容不一致。');
  if (confirmedDigest !== null && confirmedDigest !== actual) fail('显式确认摘要与协调计划不一致。');
  return actual;
}

function assertWholePlanFresh(plan, current) {
  validatePlanDigest(plan);
  if (current.publication_manifest_sha256 !== plan.publication_manifest_sha256
      || current.source_state_sha256 !== plan.source_state_sha256) {
    fail('发布清单或本地发布状态已变化，整份协调计划失效。');
  }
  for (const field of ['app_id_sha256', 'space_id_sha256', 'managed_root_node_sha256']) {
    if (current.scope?.[field] !== plan.scope[field]) fail('应用身份或受控空间范围已变化，整份协调计划失效。');
  }
  const currentById = new Map((current.actions || []).map((action) => [action.action_id, action]));
  if (currentById.size !== plan.actions.length) fail('远端页面集合已变化，整份协调计划失效。');
  for (const action of plan.actions) {
    const snapshot = currentById.get(action.action_id);
    if (!snapshot || snapshot.source_node_ref !== action.source_node_ref
        || snapshot.target_node_ref !== action.target_node_ref) {
      fail(`页面节点绑定已变化，整份协调计划失效：${action.action_id}`);
    }
    const expected = action.expected_remote;
    const actual = snapshot.expected_remote;
    for (const field of [
      'revision_id', 'body_sha256', 'title_sha256', 'parent_node_ref', 'marker_sha256', 'scope_sha256',
    ]) {
      if (actual?.[field] !== expected[field]) {
        fail(`页面远端基线已变化，整份协调计划失效：${action.action_id}.${field}`);
      }
    }
  }
  return true;
}

export {
  assertWholePlanFresh, buildReconciliationPlan, normalizedRevision, validatePlanDigest,
};

