#!/usr/bin/env node

// 用途：验证旧目录中的 Node/Ruby 命令仍可转发到平台运维实现，并保持 JSON 输出与退出码。
// 边界：只使用临时项目和 plan/只读校验模式，不监听端口、不访问飞书、不读取钥匙串。

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { planDigest, sha256 } from './lib/feishu-governance-core.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runJson(command, argumentsList, environment = {}) {
  const result = spawnSync(command, argumentsList, {
    encoding: 'utf8', env: { ...process.env, ...environment },
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  let report;
  try { report = JSON.parse(lines.join('\n')); }
  catch { throw new Error(`兼容入口输出不是 JSON：${result.stdout}\n${result.stderr}`); }
  return { ...result, report };
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const legacyScripts = join(projectRoot, '00-知识库治理与索引', '01-面向AI', 'scripts');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'qianli-legacy-wrapper-test-'));
const fixtureRoot = join(temporaryRoot, 'project');
const manifestPath = join(temporaryRoot, 'manifest.json');
const statePath = join(temporaryRoot, 'state.json');
const retirementPlanPath = join(temporaryRoot, 'retirement-plan.json');
mkdirSync(fixtureRoot, { recursive: true });
writeFileSync(join(fixtureRoot, 'keep.md'), '# 保留\n', 'utf8');
writeFileSync(join(fixtureRoot, 'remove.md'), '# 退役\n', 'utf8');
writeFileSync(manifestPath, `${JSON.stringify({
  schema_version: '1.0', description_cn: '兼容入口离线测试清单。',
  default_action: 'deny', files: ['keep.md'], directory_roots: [],
}, null, 2)}\n`, 'utf8');
writeFileSync(statePath, `${JSON.stringify({
  schema_version: '1.1', parent_node_ref: 'parent-ref', space_id: 'space-ref',
  nodes: {
    '.': { kind: 'directory', title: 'qianli-drive-Corpus', parent_path: null, status: 'complete' },
    'keep.md': { kind: 'file', title: 'keep.md', parent_path: '.', status: 'complete' },
    'remove.md': {
      kind: 'file', title: 'remove.md', parent_path: '.', status: 'complete',
      node_token: 'wik-remove', obj_token: 'doc-remove', source_hash: sha256('# 退役\n'),
    },
  },
}, null, 2)}\n`, 'utf8');
const retirementPlan = {
  schema_version: '1.0', plan_id: '2026-08-14-legacy-wrapper-retirement',
  created_at: '2026-08-14T00:00:00Z', purpose_cn: '兼容入口测试。', executable: true,
  expected_counts: { total: 1, files: 1, directories: 0 },
  protected_paths: [
    '.', '00-知识库治理与索引/01-面向AI',
    '00-知识库治理与索引/01-面向AI/02-AI-Agent使用契约.md',
    '00-知识库治理与索引/01-面向AI/04-索引准入与同步规范.md',
    '00-知识库治理与索引/01-面向AI/08-检索与回答评测规范.md',
  ],
  targets: [{
    target_id: 'F-001', path: 'remove.md', kind: 'file', reason_code: 'R2',
    node_ref: sha256('wik-remove').slice(0, 10),
  }],
};
retirementPlan.plan_digest = planDigest(retirementPlan);
writeFileSync(retirementPlanPath, `${JSON.stringify(retirementPlan, null, 2)}\n`, 'utf8');

const publish = runJson(process.execPath, [
  join(legacyScripts, 'feishu-governance-import.mjs'), 'plan',
  '--project-root', fixtureRoot, '--publication-manifest', manifestPath,
]);
assert(publish.status === 0 && publish.report.result === 'passed', '旧 import 包装器必须保留 plan 行为');
assert(/deprecated/.test(publish.stderr), '旧 import 包装器必须给出弃用提示');

const retire = runJson(process.execPath, [
  join(legacyScripts, 'feishu-governance-retire.mjs'), 'plan',
  '--project-root', fixtureRoot, '--publication-manifest', manifestPath, '--state', statePath,
  '--retirement-plan', retirementPlanPath,
]);
assert(retire.status === 0 && retire.report.remaining_retirement_nodes === 1, '旧 retire 包装器必须保留 plan 行为');
assert(/deprecated/.test(retire.stderr), '旧 retire 包装器必须给出弃用提示');

for (const script of ['validate_knowledge_structure.rb', 'validate_ai_controls.rb', 'evaluate_retrieval.rb']) {
  const result = runJson('ruby', [join(legacyScripts, script)]);
  assert(result.status === 0 && ['passed', 'not_executed'].includes(result.report.result), `${script} 包装器执行失败`);
  assert(/deprecated/.test(result.stderr), `${script} 包装器缺少弃用提示`);
}

console.log(JSON.stringify({
  result: 'passed',
  cases: ['legacy_publish_wrapper', 'legacy_retire_wrapper', 'legacy_ruby_wrappers'],
  network: 'none',
}, null, 2));
