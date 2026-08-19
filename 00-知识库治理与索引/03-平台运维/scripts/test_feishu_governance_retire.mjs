#!/usr/bin/env node

// 用途：使用本地回环模拟飞书 API，验证退役工具的范围门禁、正文复核、删除读回和状态落盘。
// 边界：只监听随机回环端口，不访问真实飞书，不读取钥匙串。

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { blocksForContent } from './feishu-governance-publish.mjs';
import { planDigest } from './lib/feishu-governance-core.mjs';

const SCRIPT = resolve(fileURLToPath(new URL('./feishu-governance-retire.mjs', import.meta.url)));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try { resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function run(argumentsList, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...argumentsList], {
      env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      try { resolvePromise({ code, report: JSON.parse(lines.at(-1) || '{}'), stderr }); }
      catch { reject(new Error(`退役工具输出不是 JSON：${stdout}\n${stderr}`)); }
    });
  });
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'qianli-feishu-retire-test-'));
const projectRoot = join(temporaryRoot, 'project');
const statePath = join(temporaryRoot, 'runtime', 'state.json');
const manifestPath = join(temporaryRoot, 'manifest.json');
const retirementPlanPath = join(temporaryRoot, 'retirement-plan.json');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(dirname(statePath), { recursive: true });
const keepBody = '# 保留正文\n';
const removeBody = '# 过程文件\n\n仅用于退役测试。\n';
writeFileSync(join(projectRoot, 'keep.md'), keepBody, 'utf8');
writeFileSync(join(projectRoot, 'remove.md'), removeBody, 'utf8');
writeFileSync(manifestPath, `${JSON.stringify({
  schema_version: '1.0', description_cn: '退役回环测试发布清单。',
  default_action: 'deny', files: ['keep.md'], directory_roots: [],
}, null, 2)}\n`, 'utf8');

const removeHash = hash(removeBody);
const removeBlocks = blocksForContent({ kind: 'file', path: 'remove.md', hash: removeHash }, removeBody)
  .map((block, index) => ({ ...block, block_id: `blk-remove-${index + 1}`, parent_id: 'doc-remove' }));
const nodes = new Map([
  ['wik-parent', { space_id: 'space-test', node_token: 'wik-parent', obj_token: 'doc-parent', obj_type: 'docx', parent_node_token: '', title: '授权父节点' }],
  ['wik-root', { space_id: 'space-test', node_token: 'wik-root', obj_token: 'doc-root', obj_type: 'docx', parent_node_token: 'wik-parent', title: 'qianli-drive-Corpus' }],
  ['wik-keep', { space_id: 'space-test', node_token: 'wik-keep', obj_token: 'doc-keep', obj_type: 'docx', parent_node_token: 'wik-root', title: 'keep.md' }],
  ['wik-remove', { space_id: 'space-test', node_token: 'wik-remove', obj_token: 'doc-remove', obj_type: 'docx', parent_node_token: 'wik-root', title: 'remove.md' }],
]);
const blocks = new Map([['doc-remove', removeBlocks]]);
let deleteCalls = 0;

writeFileSync(statePath, `${JSON.stringify({
  schema_version: '1.0', parent_node_ref: hash('wik-parent').slice(0, 10), space_id: 'space-test',
  nodes: {
    '.': { kind: 'directory', title: 'qianli-drive-Corpus', parent_path: null, node_token: 'wik-root', obj_token: 'doc-root', status: 'complete', source_hash: hash('directory:.'), block_count: 2 },
    'keep.md': { kind: 'file', title: 'keep.md', parent_path: '.', node_token: 'wik-keep', obj_token: 'doc-keep', status: 'complete', source_hash: hash(keepBody), block_count: 2 },
    'remove.md': { kind: 'file', title: 'remove.md', parent_path: '.', node_token: 'wik-remove', obj_token: 'doc-remove', status: 'complete', source_hash: removeHash, block_count: removeBlocks.length },
  },
}, null, 2)}\n`, 'utf8');

const approvedPlan = {
  schema_version: '1.0', plan_id: '2026-08-14-loopback-retirement',
  created_at: '2026-08-14T00:00:00Z', purpose_cn: '本地回环退役测试。', executable: true,
  expected_counts: { total: 1, files: 1, directories: 0 },
  protected_paths: [
    '.', '00-知识库治理与索引/01-面向AI',
    '00-知识库治理与索引/01-面向AI/02-AI-Agent使用契约.md',
    '00-知识库治理与索引/01-面向AI/04-索引准入与同步规范.md',
    '00-知识库治理与索引/01-面向AI/08-检索与回答评测规范.md',
  ],
  targets: [{ target_id: 'F-001', path: 'remove.md', kind: 'file', reason_code: 'R2', node_ref: hash('wik-remove').slice(0, 10) }],
};
approvedPlan.plan_digest = planDigest(approvedPlan);
writeFileSync(retirementPlanPath, `${JSON.stringify(approvedPlan, null, 2)}\n`, 'utf8');

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal' && request.method === 'POST') {
      const body = await readJson(request);
      assert(body.app_secret === 'test-only', '模拟认证 secret 不匹配');
      respond(response, 200, { code: 0, msg: 'success', tenant_access_token: 'test-token' });
      return;
    }
    if (request.headers.authorization !== 'Bearer test-token') {
      respond(response, 401, { code: 99991663, msg: 'unauthorized' });
      return;
    }
    if (url.pathname === '/open-apis/application/v6/scopes' && request.method === 'GET') {
      const scopes = ['wiki:node:read', 'wiki:node:retrieve', 'docx:document:readonly', 'space:document:delete']
        .map((scope_name) => ({ grant_status: 1, scope_name, scope_type: 'tenant' }));
      respond(response, 200, { code: 0, msg: 'success', data: { scopes } });
      return;
    }
    if (url.pathname === '/open-apis/wiki/v2/spaces/get_node' && request.method === 'GET') {
      const node = nodes.get(url.searchParams.get('token'));
      respond(response, node ? 200 : 400, node ? { code: 0, msg: 'success', data: { node } } : { code: 131005, msg: 'not found' });
      return;
    }
    const wikiNodes = url.pathname.match(/^\/open-apis\/wiki\/v2\/spaces\/([^/]+)\/nodes$/);
    if (wikiNodes && request.method === 'GET') {
      const parent = url.searchParams.get('parent_node_token');
      const items = [...nodes.values()].filter((node) => node.parent_node_token === parent);
      respond(response, 200, { code: 0, msg: 'success', data: { items, has_more: false } });
      return;
    }
    const children = url.pathname.match(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/children$/);
    if (children && request.method === 'GET') {
      respond(response, 200, { code: 0, msg: 'success', data: { items: blocks.get(children[1]) || [], has_more: false } });
      return;
    }
    const deletion = url.pathname.match(/^\/open-apis\/drive\/v1\/files\/([^/]+)$/);
    if (deletion && request.method === 'DELETE') {
      assert(url.searchParams.get('type') === 'docx', '删除类型必须为 docx');
      const node = [...nodes.values()].find((candidate) => candidate.obj_token === deletion[1]);
      assert(node, '待删除对象不存在');
      nodes.delete(node.node_token);
      deleteCalls += 1;
      respond(response, 200, { code: 0, msg: 'success', data: {} });
      return;
    }
    respond(response, 404, { code: 404, msg: `unhandled ${request.method} ${url.pathname}` });
  } catch (error) {
    respond(response, 500, { code: 500, msg: error.message });
  }
});

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const address = server.address();
const environment = {
  FEISHU_API_BASE: `http://127.0.0.1:${address.port}`,
  FEISHU_RETIRE_TEST_MODE: '1', FEISHU_RETIRE_TEST_SECRET: 'test-only',
  FEISHU_RETIRE_TEST_PARENT_NODE: 'wik-parent', FEISHU_RETIRE_MIN_DELAY_MS: '0',
};

try {
  const common = [
    '--project-root', projectRoot, '--state', statePath,
    '--publication-manifest', manifestPath, '--retirement-plan', retirementPlanPath,
  ];
  const plan = await run(['plan', ...common], environment);
  assert(plan.code === 0 && plan.report.remaining_retirement_nodes === 1
    && plan.report.plan_digest === approvedPlan.plan_digest, '退役计划统计或摘要不正确');
  const rejected = await run([
    'apply', ...common, '--execute', '--confirm-count', '2',
    '--confirm-plan-digest', approvedPlan.plan_digest,
  ], environment);
  assert(rejected.code !== 0 && deleteCalls === 0, '错误确认数量必须在删除前被拒绝');
  const wrongDigest = await run([
    'apply', ...common, '--execute', '--confirm-count', '1', '--confirm-plan-digest', '0'.repeat(64),
  ], environment);
  assert(wrongDigest.code !== 0 && deleteCalls === 0, '错误计划摘要必须在删除前被拒绝');
  const applied = await run([
    'apply', ...common, '--execute', '--confirm-count', '1',
    '--confirm-plan-digest', approvedPlan.plan_digest,
  ], environment);
  assert(applied.code === 0 && applied.report.deleted_nodes === 1 && deleteCalls === 1, '受控删除未完成');
  const finalState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert(!finalState.nodes['remove.md'] && finalState.nodes['keep.md'], '状态未按远端结果更新');
  assert(finalState.retirement_history?.length === 1, '缺少退役审计记录');
  approvedPlan.executable = false;
  approvedPlan.completed_at = '2026-08-14T00:01:00Z';
  approvedPlan.evidence_ref = 'loopback-evidence.md';
  approvedPlan.plan_digest = planDigest(approvedPlan);
  writeFileSync(retirementPlanPath, `${JSON.stringify(approvedPlan, null, 2)}\n`, 'utf8');
  const completed = await run(['plan', ...common], environment);
  assert(completed.code === 0 && completed.report.result === 'archived'
    && completed.report.remaining_retirement_nodes === 0
    && completed.report.already_retired_nodes === 1, '完成后的退役计划不正确');
  const replay = await run([
    'apply', ...common, '--execute', '--confirm-count', '1',
    '--confirm-plan-digest', approvedPlan.plan_digest,
  ], environment);
  assert(replay.code !== 0 && deleteCalls === 1, '历史 executable=false 计划不得再次执行');
  console.log(JSON.stringify({
    result: 'passed', cases: [
      'count_gate', 'plan_digest_gate', 'exact_content_preflight', 'leaf_delete_readback',
      'state_audit', 'historical_plan_replay_denied',
    ],
    delete_calls: deleteCalls, network: 'loopback_only',
  }, null, 2));
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
