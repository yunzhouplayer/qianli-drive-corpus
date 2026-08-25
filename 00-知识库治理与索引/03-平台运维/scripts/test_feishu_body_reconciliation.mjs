#!/usr/bin/env node

// 用途：离线验证正文协调计划摘要、三方比较和整份计划漂移门禁。
// 边界：不访问网络、不读取 Keychain、不写飞书。

import {
  assertWholePlanFresh, buildReconciliationPlan, normalizedRevision, validatePlanDigest,
} from './lib/feishu-body-reconciliation.mjs';
import { sha256 } from './lib/feishu-governance-core.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectFailure(callback, pattern) {
  let message = '';
  try { callback(); } catch (error) { message = error.message; }
  assert(pattern.test(message), `预期失败未发生：${pattern}`);
}

const h = (value) => sha256(value);
const page = {
  source_path: 'old.md', target_path: 'new.md', source_node_ref: h('source').slice(0, 10),
  target_node_ref: h('source').slice(0, 10), revision_id: 7, body_sha256: h('body'),
  title_sha256: h('old title'), parent_node_ref: h('parent').slice(0, 10),
  marker_sha256: h('marker'), scope_sha256: h('scope'), git_sha256: h('git'),
  proposal_block_signature_sha256: h('last'), resolved_links_sha256: h('links'),
  remote_block_signature_sha256: h('last'), last_synced_block_signature_sha256: h('last'),
  authority_decision: 'remote_unchanged',
};
const input = {
  generatedAt: '2026-08-14T00:00:00Z', publicationManifestSha256: h('manifest'),
  sourceStateSha256: h('state'),
  scope: { app_id_sha256: h('app'), space_id_sha256: h('space'), managed_root_node_sha256: h('root') },
  pages: [page],
};
const plan = buildReconciliationPlan(input);
assert(plan.actions[0].allowed_action === 'rename_in_place', '路径变化应生成原位重命名动作');
const renameAndUpdate = buildReconciliationPlan({
  ...input,
  pages: [{ ...page, proposal_block_signature_sha256: h('changed proposal') }],
});
assert(renameAndUpdate.actions[0].allowed_action === 'rename_and_update', '路径和正文同时变化应生成复合动作');
assert(validatePlanDigest(plan, plan.plan_digest) === plan.plan_digest, '计划摘要应通过');
expectFailure(() => validatePlanDigest({ ...plan, generated_at: 'changed' }), /摘要/);
expectFailure(() => normalizedRevision(-1), /禁止使用 -1/);
expectFailure(() => buildReconciliationPlan({
  ...input, pages: [{ ...page, remote_block_signature_sha256: h('manual edit') }],
}), /人工合并/);

const current = {
  publication_manifest_sha256: plan.publication_manifest_sha256,
  source_state_sha256: plan.source_state_sha256,
  scope: { ...plan.scope },
  actions: plan.actions.map((action) => ({
    action_id: action.action_id, source_node_ref: action.source_node_ref,
    target_node_ref: action.target_node_ref, expected_remote: { ...action.expected_remote },
  })),
};
assert(assertWholePlanFresh(plan, current), '未漂移计划应通过');
const drifted = structuredClone(current);
drifted.actions[0].expected_remote.revision_id = 8;
expectFailure(() => assertWholePlanFresh(plan, drifted), /整份协调计划失效/);
const scopeDrift = structuredClone(current);
scopeDrift.scope.app_id_sha256 = h('other-app');
expectFailure(() => assertWholePlanFresh(plan, scopeDrift), /整份协调计划失效/);

console.log(JSON.stringify({
  result: 'passed',
  cases: [
    'deterministic_digest', 'digest_confirmation', 'exact_revision_required', 'rename_and_update',
    'remote_edit_requires_merge', 'whole_plan_revision_drift', 'whole_plan_scope_drift',
  ],
  network: 'none',
}, null, 2));
