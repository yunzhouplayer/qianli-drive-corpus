#!/usr/bin/env node

// 用途：按“本地受控状态 - 当前显式发布清单”计算待退役节点，逐项核验后删除飞书测试树中的页面。
// 边界：只处理本工具曾创建且正文与原 Git 导入版本一致的 docx 页面；叶子优先；永不删除受控根节点。
// 凭证：默认从 macOS 钥匙串读取；App Secret、访问令牌和原始节点 token 均不写入报告。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  blockSignature, blocksForContent, managedMarker, scanProject,
} from './feishu-governance-publish.mjs';
import {
  FeishuClient, authenticateTenant, fail, loadFeishuConfiguration, loadPublicationState,
  planDigest, safe, saveStateAtomic, sha256, shortHash, sleep, wikiToken,
} from './lib/feishu-governance-core.mjs';

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaffdf087c789bda';
const API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
const TEST_MODE = process.env.FEISHU_RETIRE_TEST_MODE === '1';
const DEFAULT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-publication-state.json';
const LEGACY_STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-import-state.json';
const DEFAULT_MANIFEST_RELATIVE = '00-知识库治理与索引/03-平台运维/02-feishu-publication-manifest.json';
const DEFAULT_RETIREMENT_PLAN_RELATIVE = '00-知识库治理与索引/03-平台运维/retirements/2026-08-14-governance-validation-retirement.json';
const ALWAYS_PROTECTED_PATHS = new Set([
  '.',
  '00-知识库治理与索引/01-面向AI',
  '00-知识库治理与索引/01-面向AI/02-AI-Agent使用契约.md',
  '00-知识库治理与索引/01-面向AI/04-索引准入与同步规范.md',
  '00-知识库治理与索引/01-面向AI/08-检索与回答评测规范.md',
]);

function parseArguments(argv) {
  const mode = argv[0] || 'plan';
  if (!['plan', 'diagnose', 'preflight', 'apply'].includes(mode)) {
    fail('模式只能是 plan、diagnose、preflight 或 apply。', 2);
  }
  const options = {
    mode, execute: false, confirmCount: null, projectRoot: DEFAULT_PROJECT_ROOT,
    statePath: null, publicationManifestPath: null, retirementPlanPath: null,
    confirmPlanDigest: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--confirm-count') options.confirmCount = Number(argv[++index]);
    else if (argument === '--project-root') options.projectRoot = resolve(argv[++index] || '');
    else if (argument === '--state') options.statePath = resolve(argv[++index] || '');
    else if (argument === '--publication-manifest') options.publicationManifestPath = resolve(argv[++index] || '');
    else if (argument === '--retirement-plan') options.retirementPlanPath = resolve(argv[++index] || '');
    else if (argument === '--confirm-plan-digest') options.confirmPlanDigest = String(argv[++index] || '');
    else fail(`未知参数：${argument}`, 2);
  }
  if (mode === 'apply') {
    if (!options.execute) fail('apply 模式必须显式传入 --execute。', 2);
    if (!Number.isInteger(options.confirmCount) || options.confirmCount < 1) {
      fail('apply 模式必须显式传入正整数 --confirm-count。', 2);
    }
    if (!/^[0-9a-f]{64}$/.test(options.confirmPlanDigest || '')) {
      fail('apply 模式必须显式传入完整的 --confirm-plan-digest。', 2);
    }
  } else if (options.execute || options.confirmCount !== null || options.confirmPlanDigest !== null) {
    fail('--execute、--confirm-count 和 --confirm-plan-digest 只能用于 apply 模式。', 2);
  }
  options.statePath ||= join(options.projectRoot, DEFAULT_STATE_RELATIVE);
  options.publicationManifestPath ||= join(options.projectRoot, DEFAULT_MANIFEST_RELATIVE);
  options.retirementPlanPath ||= join(options.projectRoot, DEFAULT_RETIREMENT_PLAN_RELATIVE);
  return options;
}

function loadRetirementPlan(path) {
  if (!existsSync(path)) fail(`退役计划不存在：${path}`, 3);
  let document;
  try { document = JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('退役计划必须是合法 JSON。', 3); }
  if (document.schema_version !== '1.0' || typeof document.executable !== 'boolean'
      || !Array.isArray(document.targets) || !Array.isArray(document.protected_paths)
      || !document.expected_counts || !/^[0-9a-f]{64}$/.test(document.plan_digest || '')) {
    fail('退役计划格式不受支持。', 3);
  }
  const digest = planDigest(document);
  if (digest !== document.plan_digest) fail('退役计划摘要校验失败。', 3);
  const ids = new Set();
  const paths = new Set();
  for (const target of document.targets) {
    if (!/^[FD]-[0-9]{3}$/.test(target.target_id || '')
        || !['file', 'directory'].includes(target.kind)
        || typeof target.path !== 'string' || !target.path
        || !/^R[1-6]$/.test(target.reason_code || '')
        || !/^[0-9a-f]{10,64}$/.test(target.node_ref || '')) {
      fail('退役计划包含不合法目标。', 3);
    }
    if (ids.has(target.target_id) || paths.has(target.path)) fail('退役计划包含重复目标。', 3);
    ids.add(target.target_id);
    paths.add(target.path);
  }
  const files = document.targets.filter((target) => target.kind === 'file').length;
  const directories = document.targets.filter((target) => target.kind === 'directory').length;
  if (document.expected_counts.total !== document.targets.length
      || document.expected_counts.files !== files
      || document.expected_counts.directories !== directories) {
    fail('退役计划目标数量与 expected_counts 不一致。', 3);
  }
  const protectedPaths = new Set(document.protected_paths);
  for (const pathValue of ALWAYS_PROTECTED_PATHS) {
    if (!protectedPaths.has(pathValue)) fail(`退役计划缺少强制保护路径：${pathValue}`, 3);
  }
  const protectedTargets = document.targets.filter((target) => protectedPaths.has(target.path));
  if (protectedTargets.length) fail('退役计划目标与保护路径冲突。', 3);
  return { ...document, path: resolve(path), digest, targetPaths: paths, protectedPaths };
}

function loadState(path, projectRoot) {
  const defaultState = resolve(path) === resolve(projectRoot, DEFAULT_STATE_RELATIVE);
  return loadPublicationState({
    statePath: path,
    legacyStatePath: defaultState ? join(projectRoot, LEGACY_STATE_RELATIVE) : null,
    required: true,
  });
}

function saveState(path, state) {
  saveStateAtomic(path, state);
}

function retirementPlan(scan, state, approvedPlan) {
  const retained = new Set(scan.items.map((item) => item.path));
  const unexpected = Object.keys(state.nodes)
    .filter((path) => !retained.has(path) && !approvedPlan.targetPaths.has(path));
  if (unexpected.length) fail(`本地状态包含退役计划未批准的节点：${unexpected.join(', ')}`, 8);
  const historyByPath = new Map((state.retirement_history || [])
    .filter((item) => item.result === 'deleted_and_absence_verified')
    .map((item) => [item.path, item]));
  const targets = [];
  let retiredPreviously = 0;
  for (const approved of approvedPlan.targets) {
    const record = state.nodes[approved.path];
    if (!record) {
      const history = historyByPath.get(approved.path);
      if (!history || history.kind !== approved.kind || history.node_ref !== approved.node_ref) {
        fail(`退役计划目标既不在受控状态也不在完成历史中：${approved.path}`, 8);
      }
      retiredPreviously += 1;
      continue;
    }
    if (retained.has(approved.path)) fail(`退役计划目标仍在当前发布清单中：${approved.path}`, 8);
    if (record.kind !== approved.kind || shortHash(record.node_token) !== approved.node_ref) {
      fail(`退役计划目标与受控状态不一致：${approved.path}`, 8);
    }
    targets.push({ ...approved, ...record, path: approved.path });
  }
  const invalid = targets.filter((item) => !['file', 'directory'].includes(item.kind)
    || item.status !== 'complete' || !item.node_token || !item.obj_token || !item.source_hash);
  if (invalid.length) fail(`退役范围包含不完整的受控状态：${invalid.map((item) => item.path).join(', ')}`, 8);
  const files = targets.filter((item) => item.kind === 'file').length;
  const directories = targets.filter((item) => item.kind === 'directory').length;
  const targetPaths = new Set(targets.map((item) => item.path));
  for (const item of targets) {
    if (item.parent_path !== '.' && !retained.has(item.parent_path) && !targetPaths.has(item.parent_path)) {
      fail(`待退役节点的父路径既不保留也不在退役范围：${item.path}`, 8);
    }
  }
  targets.sort((left, right) => {
    const depth = (path) => path === '.' ? -1 : path.split('/').length;
    if (depth(left.path) !== depth(right.path)) return depth(right.path) - depth(left.path);
    if (left.kind !== right.kind) return left.kind === 'file' ? -1 : 1;
    return left.path.localeCompare(right.path, 'zh-CN');
  });
  return {
    targets, retainedCount: retained.size, files, directories,
    approvedCount: approvedPlan.expected_counts.total, retiredPreviously,
    planDigest: approvedPlan.digest, executable: approvedPlan.executable,
  };
}

function planReport(scan, state, approvedPlan) {
  const plan = retirementPlan(scan, state, approvedPlan);
  return {
    result: approvedPlan.executable ? 'passed' : 'archived', mode: 'plan',
    plan_id: approvedPlan.plan_id, plan_digest: approvedPlan.digest,
    executable: approvedPlan.executable, retained_nodes: plan.retainedCount,
    approved_retirement_nodes: plan.approvedCount, remaining_retirement_nodes: plan.targets.length,
    already_retired_nodes: plan.retiredPreviously, retirement_files: plan.files,
    retirement_directories: plan.directories, protected_nodes_in_retirement: 0,
    managed_root_in_retirement: false, delete_request_sent: false,
  };
}

function configuration() {
  return loadFeishuConfiguration({
    appId: APP_ID,
    apiBase: API_BASE,
    testMode: TEST_MODE,
    testSecretEnv: 'FEISHU_RETIRE_TEST_SECRET',
    testNodeEnv: 'FEISHU_RETIRE_TEST_PARENT_NODE',
  });
}

class RetireClient extends FeishuClient {
  async requestDelete(label, pathOrUrl, attempt = 0) {
    await this.waitForRateLimit();
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, this.baseUrl);
    const response = await fetch(url, {
      method: 'DELETE', headers: { authorization: `Bearer ${this.token}` },
    });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : { code: response.ok ? 0 : undefined }; }
    catch { fail(`${label} 返回非 JSON 响应。`, 6); }
    if (!response.ok || body?.code !== 0) {
      fail(`${label} 失败：http=${response.status}, code=${body?.code ?? 'unknown'}, msg=${safe(body?.msg)}`, 6);
    }
    return body.data || {};
  }

  async deleteDocument(objectToken) {
    const url = new URL(`/open-apis/drive/v1/files/${encodeURIComponent(objectToken)}`, this.baseUrl);
    url.searchParams.set('type', 'docx');
    return this.requestDelete('删除已核验的飞书页面', url);
  }
}

const SCOPE_REQUIREMENTS = [
  { capability: 'read_node', anyOf: ['wiki:node:read', 'wiki:wiki:readonly', 'wiki:wiki'] },
  { capability: 'list_children', anyOf: ['wiki:node:retrieve', 'wiki:wiki:readonly', 'wiki:wiki'] },
  { capability: 'read_docx', anyOf: ['docx:document:readonly', 'docx:document'] },
  { capability: 'delete_drive_document', anyOf: ['space:document:delete', 'drive:drive'] },
];

function scopeReport(scopes) {
  const granted = scopes.filter((scope) => scope.grant_status === 1);
  const tenant = new Set(granted.filter((scope) => scope.scope_type === 'tenant').map((scope) => scope.scope_name));
  const user = new Set(granted.filter((scope) => scope.scope_type === 'user').map((scope) => scope.scope_name));
  const checks = SCOPE_REQUIREMENTS.map((requirement) => {
    const tenantMatches = requirement.anyOf.filter((scope) => tenant.has(scope));
    const userMatches = requirement.anyOf.filter((scope) => user.has(scope));
    return {
      capability: requirement.capability,
      status: tenantMatches.length ? 'pass' : (userMatches.length ? 'wrong_identity' : 'missing'),
      accepted_scopes: requirement.anyOf,
      tenant_matches: tenantMatches,
      user_matches: userMatches,
    };
  });
  return {
    result: checks.every((check) => check.status === 'pass') ? 'ready' : 'blocked',
    mode: 'diagnose', credential_type: 'tenant_access_token', required_identity: 'tenant',
    checks, write_request_sent: false,
  };
}

function currentBody(projectRoot, path, expectedHash) {
  const absolutePath = resolve(projectRoot, path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return null;
  const body = readFileSync(absolutePath, 'utf8');
  return sha256(body) === expectedHash ? body : null;
}

function historicalBody(projectRoot, path, expectedHash) {
  const current = currentBody(projectRoot, path, expectedHash);
  if (current !== null) return current;
  const log = spawnSync('git', ['log', '--all', '--format=%H', '--', path], {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (log.status !== 0) fail(`无法查询原 Git 导入版本：${path}`, 8);
  for (const commit of log.stdout.split('\n').filter(Boolean)) {
    const shown = spawnSync('git', ['show', `${commit}:${path}`], {
      cwd: projectRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (shown.status === 0 && sha256(shown.stdout) === expectedHash) return shown.stdout;
  }
  fail(`找不到与导入状态哈希一致的 Git 版本：${path}`, 8);
}

function expectedBlocks(projectRoot, item) {
  const body = item.kind === 'file' ? historicalBody(projectRoot, item.path, item.source_hash) : null;
  const blocks = blocksForContent({
    kind: item.kind, path: item.path, hash: item.source_hash,
  }, body);
  if (Number.isInteger(item.block_count) && item.block_count !== blocks.length) {
    fail(`原 Git 版本块数与导入状态不一致：${item.path}`, 8);
  }
  return blocks.map(blockSignature);
}

function contentFromBlock(block) {
  const property = {
    2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
    8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9', 12: 'bullet', 13: 'ordered',
    14: 'code', 15: 'quote',
  }[block.block_type];
  return (block[property]?.elements || []).map((element) => element.text_run?.content || '').join('');
}

async function validateOne(client, state, item, expected, { requireLeaf = false } = {}) {
  const parent = state.nodes[item.parent_path];
  if (!parent?.node_token) fail(`待退役节点父状态缺失：${item.path}`, 8);
  const matches = (await client.listNodes(state.space_id, parent.node_token))
    .filter((node) => node.node_token === item.node_token && node.obj_token === item.obj_token
      && node.title === item.title && node.obj_type === 'docx');
  if (matches.length !== 1) fail(`飞书父子关系、标题或对象类型不一致：${item.path}`, 8);
  const blocks = await client.listDocumentChildren(item.obj_token);
  const marker = managedMarker(contentFromBlock(blocks[0]));
  if (!marker || marker.kind !== item.kind || marker.path !== item.path || marker.sha256 !== item.source_hash) {
    fail(`飞书受控标记与本地状态不一致：${item.path}`, 8);
  }
  const actual = blocks.map(blockSignature);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`飞书正文与原 Git 导入版本存在差异，拒绝删除：${item.path}`, 8);
  }
  if (requireLeaf && item.kind === 'directory') {
    const children = await client.listNodes(state.space_id, item.node_token);
    if (children.length) fail(`目录仍有 ${children.length} 个子节点，拒绝删除：${item.path}`, 8);
  }
}

async function preflightRetirement(client, scan, state, projectRoot, approvedPlan) {
  if (!approvedPlan.executable) fail('该退役计划已完成归档，executable=false，拒绝再次执行。', 8);
  const plan = retirementPlan(scan, state, approvedPlan);
  const targetPaths = new Set(plan.targets.map((item) => item.path));
  const expectedByPath = new Map();
  for (const item of plan.targets) expectedByPath.set(item.path, expectedBlocks(projectRoot, item));
  for (let index = 0; index < plan.targets.length; index += 1) {
    const item = plan.targets[index];
    await validateOne(client, state, item, expectedByPath.get(item.path));
    if (item.kind === 'directory') {
      const children = await client.listNodes(state.space_id, item.node_token);
      const unknown = children.filter((node) => !plan.targets.some((candidate) => candidate.node_token === node.node_token
        && candidate.parent_path === item.path));
      if (unknown.length) fail(`待退役目录包含不在批准范围内的子节点：${item.path}`, 8);
    }
    if ((index + 1) % 10 === 0) console.error(`preflight-progress ${index + 1}/${plan.targets.length}`);
  }
  return { plan, expectedByPath };
}

function finalizeRetirement(state, item) {
  delete state.nodes[item.path];
  delete state.retirement_pending;
  state.retirement_history ||= [];
  state.retirement_history.push({
    path: item.path, kind: item.kind, node_ref: shortHash(item.node_token),
    object_ref: shortHash(item.obj_token), source_hash: item.source_hash,
    retired_at: new Date().toISOString(), result: 'deleted_and_absence_verified',
  });
  state.updated_at = new Date().toISOString();
}

async function recoverPending(client, state, statePath) {
  const pending = state.retirement_pending;
  if (!pending) return 0;
  const item = state.nodes[pending.path];
  if (!item || shortHash(item.node_token) !== pending.node_ref || shortHash(item.obj_token) !== pending.object_ref) {
    fail('退役断点与本地节点状态不一致，拒绝自动恢复。', 8);
  }
  const parent = state.nodes[item.parent_path];
  if (!parent?.node_token) fail('退役断点的父状态缺失。', 8);
  const present = await nodeStillPresent(client, state.space_id, parent.node_token, item.node_token);
  if (present) return 0;
  finalizeRetirement(state, { path: pending.path, ...item });
  saveState(statePath, state);
  return 1;
}

async function nodeStillPresent(client, spaceId, parentNodeToken, nodeToken, attempts = 1) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const present = (await client.listNodes(spaceId, parentNodeToken))
      .some((node) => node.node_token === nodeToken);
    if (!present) return false;
    if (attempt + 1 < attempts) await sleep(Math.min(1000 * (attempt + 1), 5000));
  }
  return true;
}

async function applyRetirement(client, scan, state, options) {
  const recovered = await recoverPending(client, state, options.statePath);
  const { plan, expectedByPath } = await preflightRetirement(
    client, scan, state, options.projectRoot, options.approvedPlan,
  );
  if (options.confirmPlanDigest !== plan.planDigest) {
    fail('显式确认的退役计划摘要与当前计划不一致。', 8);
  }
  if (options.confirmCount !== plan.approvedCount) {
    fail(`显式确认数量与批准范围不一致：confirm=${options.confirmCount}, approved=${plan.approvedCount}`, 8);
  }
  let deleted = 0;
  for (const item of plan.targets) {
    await validateOne(client, state, item, expectedByPath.get(item.path), { requireLeaf: true });
    state.retirement_pending = {
      path: item.path, node_ref: shortHash(item.node_token), object_ref: shortHash(item.obj_token),
      started_at: new Date().toISOString(), expected_source_hash: item.source_hash,
    };
    saveState(options.statePath, state);
    await client.deleteDocument(item.obj_token);
    const parent = state.nodes[item.parent_path];
    const present = await nodeStillPresent(client, state.space_id, parent.node_token, item.node_token, 8);
    if (present) fail(`删除请求后节点仍存在：${item.path}`, 8);
    finalizeRetirement(state, item);
    saveState(options.statePath, state);
    deleted += 1;
    console.error(`retire-progress ${deleted}/${plan.targets.length}`);
  }
  return { recovered, deleted };
}

function assertNoRetirementTargets(scan, state) {
  const retained = new Set(scan.items.map((item) => item.path));
  const extras = Object.keys(state.nodes).filter((path) => !retained.has(path));
  if (extras.length) fail(`清理后仍有 ${extras.length} 个超出发布范围的节点。`, 8);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const scan = scanProject(options.projectRoot, options.publicationManifestPath);
  const approvedPlan = loadRetirementPlan(options.retirementPlanPath);
  options.approvedPlan = approvedPlan;
  let state = loadState(options.statePath, options.projectRoot);
  if (options.mode === 'plan') {
    console.log(JSON.stringify(planReport(scan, state, approvedPlan)));
    return;
  }
  if (!approvedPlan.executable) fail('该退役计划已完成归档，executable=false，拒绝诊断、预检或执行。', 8);
  const config = configuration();
  const parentToken = wikiToken(config.node);
  const accessToken = await authenticateTenant({ apiBase: API_BASE, appId: APP_ID, secret: config.secret });
  config.secret = undefined;
  const client = new RetireClient(API_BASE, accessToken, {
    minimumDelay: Number(process.env.FEISHU_RETIRE_MIN_DELAY_MS ?? (TEST_MODE ? 0 : 650)),
  });
  const diagnostic = scopeReport(await client.listGrantedScopes());
  if (options.mode === 'diagnose' || diagnostic.result !== 'ready') {
    client.token = undefined;
    console.log(JSON.stringify(diagnostic));
    if (diagnostic.result !== 'ready') process.exitCode = 9;
    return;
  }
  const parentNode = await client.resolveNode(parentToken);
  if (state.space_id !== parentNode.space_id || state.parent_node_ref !== shortHash(parentNode.node_token)) {
    fail('本地状态与当前授权父节点不匹配。', 8);
  }
  if (options.mode === 'preflight') {
    const { plan } = await preflightRetirement(client, scan, state, options.projectRoot, approvedPlan);
    client.token = undefined;
    console.log(JSON.stringify({
      result: 'ready', mode: 'preflight', checked_nodes: plan.targets.length,
      checked_files: plan.files, checked_directories: plan.directories,
      content_mismatches: 0, parent_mismatches: 0, unknown_children: 0,
      write_request_sent: false, delete_request_sent: false,
    }));
    return;
  }
  const initialPlan = retirementPlan(scan, state, approvedPlan);
  const { recovered, deleted } = await applyRetirement(client, scan, state, options);
  state = loadState(options.statePath, options.projectRoot);
  assertNoRetirementTargets(scan, state);
  client.token = undefined;
  console.log(JSON.stringify({
    result: 'passed', mode: 'apply', approved_nodes: initialPlan.approvedCount,
    recovered_pending_nodes: recovered, deleted_nodes: deleted,
    retained_nodes: Object.keys(state.nodes).length,
    managed_root_deleted: false, delete_request_sent: deleted > 0,
    production_index_changed: false, state_updated_after_remote_absence: true,
  }));
}

async function runCli(argv = process.argv.slice(2), { deprecatedCommand = null } = {}) {
  if (deprecatedCommand) console.error(`deprecated: ${deprecatedCommand} 已迁移到 03-平台运维/scripts/`);
  try {
    await main(argv);
  } catch (error) {
    console.log(JSON.stringify({ result: 'failed', error: safe(error.message) }));
    process.exitCode = error.exitCode || 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runCli();

export {
  loadRetirementPlan, parseArguments, planReport, retirementPlan, runCli, scopeReport,
};
