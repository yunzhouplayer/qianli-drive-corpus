#!/usr/bin/env node

// 用途：按“本地受控状态 - 当前显式发布清单”计算待退役节点，逐项核验后删除飞书测试树中的页面。
// 边界：只处理本工具曾创建且正文与原 Git 导入版本一致的 docx 页面；叶子优先；永不删除受控根节点。
// 凭证：默认从 macOS 钥匙串读取；App Secret、访问令牌和原始节点 token 均不写入报告。

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  blockSignature, blocksForContent, managedMarker, scanProject,
} from './feishu-governance-import.mjs';

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaffdf087c789bda';
const API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
const TEST_MODE = process.env.FEISHU_RETIRE_TEST_MODE === '1';
const DEFAULT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-import-state.json';
const DEFAULT_MANIFEST_RELATIVE = '00-知识库治理与索引/01-面向AI/10-feishu-publication-manifest.json';
const EXPECTED_COUNT = TEST_MODE ? Number(process.env.FEISHU_RETIRE_TEST_EXPECTED_COUNT || 1) : 59;
const EXPECTED_FILES = TEST_MODE ? Number(process.env.FEISHU_RETIRE_TEST_EXPECTED_FILES || 1) : 44;
const EXPECTED_DIRECTORIES = TEST_MODE ? Number(process.env.FEISHU_RETIRE_TEST_EXPECTED_DIRECTORIES || 0) : 15;
const PROTECTED_PATHS = new Set([
  '.',
  '00-知识库治理与索引/01-面向AI',
  '00-知识库治理与索引/01-面向AI/02-AI-Agent使用契约.md',
  '00-知识库治理与索引/01-面向AI/04-索引准入与同步规范.md',
  '00-知识库治理与索引/01-面向AI/08-检索与回答评测规范.md',
]);

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shortHash(value) {
  return sha256(String(value)).slice(0, 10);
}

function safe(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b[tu]-[A-Za-z0-9_-]{10,}\b/g, '[TOKEN_REDACTED]')
    .replace(/(?:wik|doc|docx|dox|blk)[A-Za-z0-9_-]{6,}/gi, '[RESOURCE_REDACTED]')
    .slice(0, 500);
}

function parseArguments(argv) {
  const mode = argv[0] || 'plan';
  if (!['plan', 'diagnose', 'preflight', 'apply'].includes(mode)) {
    fail('模式只能是 plan、diagnose、preflight 或 apply。', 2);
  }
  const options = {
    mode, execute: false, confirmCount: null, projectRoot: DEFAULT_PROJECT_ROOT,
    statePath: null, publicationManifestPath: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--confirm-count') options.confirmCount = Number(argv[++index]);
    else if (argument === '--project-root') options.projectRoot = resolve(argv[++index] || '');
    else if (argument === '--state') options.statePath = resolve(argv[++index] || '');
    else if (argument === '--publication-manifest') options.publicationManifestPath = resolve(argv[++index] || '');
    else fail(`未知参数：${argument}`, 2);
  }
  if (mode === 'apply') {
    if (!options.execute) fail('apply 模式必须显式传入 --execute。', 2);
    if (!Number.isInteger(options.confirmCount) || options.confirmCount < 1) {
      fail('apply 模式必须显式传入正整数 --confirm-count。', 2);
    }
  } else if (options.execute || options.confirmCount !== null) {
    fail('--execute 和 --confirm-count 只能用于 apply 模式。', 2);
  }
  options.statePath ||= join(options.projectRoot, DEFAULT_STATE_RELATIVE);
  options.publicationManifestPath ||= join(options.projectRoot, DEFAULT_MANIFEST_RELATIVE);
  return options;
}

function loadState(path) {
  if (!existsSync(path)) fail('缺少本地导入状态，拒绝推断远端节点。', 7);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.schema_version !== '1.0' || !state.nodes || typeof state.nodes !== 'object') {
    fail('本地导入状态格式不受支持。', 7);
  }
  return state;
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function retirementPlan(scan, state) {
  const retained = new Set(scan.items.map((item) => item.path));
  const targets = Object.entries(state.nodes)
    .filter(([path]) => !retained.has(path))
    .map(([path, record]) => ({ path, ...record }));
  const protectedTargets = targets.filter((item) => PROTECTED_PATHS.has(item.path));
  if (protectedTargets.length) fail(`退役范围包含受保护路径：${protectedTargets.map((item) => item.path).join(', ')}`, 8);
  const invalid = targets.filter((item) => !['file', 'directory'].includes(item.kind)
    || item.status !== 'complete' || !item.node_token || !item.obj_token || !item.source_hash);
  if (invalid.length) fail(`退役范围包含不完整的受控状态：${invalid.map((item) => item.path).join(', ')}`, 8);
  const files = targets.filter((item) => item.kind === 'file').length;
  const directories = targets.filter((item) => item.kind === 'directory').length;
  const retiredPreviously = (state.retirement_history || [])
    .filter((item) => item.result === 'deleted_and_absence_verified' && !retained.has(item.path));
  const approvedPaths = new Set([...targets.map((item) => item.path), ...retiredPreviously.map((item) => item.path)]);
  const approvedFiles = files + retiredPreviously.filter((item) => item.kind === 'file').length;
  const approvedDirectories = directories + retiredPreviously.filter((item) => item.kind === 'directory').length;
  if (approvedPaths.size !== EXPECTED_COUNT || approvedFiles !== EXPECTED_FILES
      || approvedDirectories !== EXPECTED_DIRECTORIES) {
    fail(`退役范围与批准清单不一致：total=${approvedPaths.size}, files=${approvedFiles}, directories=${approvedDirectories}`, 8);
  }
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
    approvedCount: approvedPaths.size, retiredPreviously: retiredPreviously.length,
  };
}

function planReport(scan, state) {
  const plan = retirementPlan(scan, state);
  return {
    result: 'passed', mode: 'plan', retained_nodes: plan.retainedCount,
    approved_retirement_nodes: plan.approvedCount, remaining_retirement_nodes: plan.targets.length,
    already_retired_nodes: plan.retiredPreviously, retirement_files: plan.files,
    retirement_directories: plan.directories, protected_nodes_in_retirement: 0,
    managed_root_in_retirement: false, delete_request_sent: false,
  };
}

function readKeychain(account, service) {
  const result = spawnSync('security', ['find-generic-password', '-a', account, '-s', service, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout.trim()) fail(`缺少钥匙串条目：${service}/${account}`, 5);
  return result.stdout.trim();
}

function configuration() {
  if (TEST_MODE) {
    const host = new URL(API_BASE).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) fail('测试模式只允许回环地址。', 5);
    const secret = process.env.FEISHU_RETIRE_TEST_SECRET;
    const node = process.env.FEISHU_RETIRE_TEST_PARENT_NODE;
    if (!secret || !node) fail('测试模式缺少模拟配置。', 5);
    return { secret, node };
  }
  return {
    secret: readKeychain(APP_ID, 'qianli-feishu-smoke'),
    node: readKeychain('authorized-node', 'qianli-feishu-smoke-node'),
  };
}

function wikiToken(value) {
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) {
    const match = new URL(input).pathname.match(/\/wiki\/([^/?#]+)/);
    if (!match) fail('授权节点链接中缺少 Wiki token。', 5);
    return decodeURIComponent(match[1]);
  }
  if (!/^[A-Za-z0-9_-]{6,999}$/.test(input)) fail('授权节点 token 格式不合法。', 5);
  return input;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

class FeishuClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.lastRequestAt = 0;
    this.minimumDelay = Number(process.env.FEISHU_RETIRE_MIN_DELAY_MS ?? (TEST_MODE ? 0 : 650));
  }

  async request(label, pathOrUrl, options = {}, attempt = 0) {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minimumDelay) await sleep(this.minimumDelay - elapsed);
    this.lastRequestAt = Date.now();
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, this.baseUrl);
    const response = await fetch(url, {
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : { code: response.ok ? 0 : undefined }; }
    catch { fail(`${label} 返回非 JSON 响应。`, 6); }
    const retryableRead = (!options.method || options.method === 'GET')
      && (response.status === 429 || body?.code === 99991400 || body?.code === 1061045);
    if (retryableRead && attempt < 5) {
      await sleep((2 ** attempt) * 500 + Math.floor(Math.random() * 200));
      return this.request(label, url, options, attempt + 1);
    }
    if (!response.ok || body?.code !== 0) {
      fail(`${label} 失败：http=${response.status}, code=${body?.code ?? 'unknown'}, msg=${safe(body?.msg)}`, 6);
    }
    return body.data || {};
  }

  async listGrantedScopes() {
    const data = await this.request('查询租户授权状态', '/open-apis/application/v6/scopes');
    return Array.isArray(data.scopes) ? data.scopes : [];
  }

  async resolveNode(nodeToken) {
    const url = new URL('/open-apis/wiki/v2/spaces/get_node', this.baseUrl);
    url.searchParams.set('token', nodeToken);
    const data = await this.request('解析授权节点', url);
    if (!data.node?.space_id || !data.node?.node_token) fail('授权节点响应缺少必要字段。', 6);
    return data.node;
  }

  async listNodes(spaceId, parentNodeToken) {
    const items = [];
    let pageToken;
    do {
      const url = new URL(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, this.baseUrl);
      url.searchParams.set('page_size', '50');
      url.searchParams.set('parent_node_token', parentNodeToken);
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const data = await this.request('枚举子节点', url);
      items.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  async listDocumentChildren(documentId) {
    const items = [];
    let pageToken;
    do {
      const url = new URL(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, this.baseUrl);
      url.searchParams.set('page_size', '50');
      url.searchParams.set('document_revision_id', '-1');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const data = await this.request('读取文档子块', url);
      items.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  async deleteDocument(objectToken) {
    const url = new URL(`/open-apis/drive/v1/files/${encodeURIComponent(objectToken)}`, this.baseUrl);
    url.searchParams.set('type', 'docx');
    return this.request('删除已核验的飞书页面', url, { method: 'DELETE' });
  }
}

async function authenticate(secret) {
  const response = await fetch(new URL('/open-apis/auth/v3/tenant_access_token/internal', API_BASE), {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: secret }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.code !== 0 || !body?.tenant_access_token) {
    fail(`认证失败：http=${response.status}, code=${body?.code ?? 'unknown'}, msg=${safe(body?.msg)}`, 5);
  }
  return body.tenant_access_token;
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

async function preflightRetirement(client, scan, state, projectRoot) {
  const plan = retirementPlan(scan, state);
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
  const { plan, expectedByPath } = await preflightRetirement(client, scan, state, options.projectRoot);
  if (options.confirmCount !== plan.approvedCount || options.confirmCount !== EXPECTED_COUNT) {
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const scan = scanProject(options.projectRoot, options.publicationManifestPath);
  let state = loadState(options.statePath);
  if (options.mode === 'plan') {
    console.log(JSON.stringify(planReport(scan, state)));
    return;
  }
  const config = configuration();
  const parentToken = wikiToken(config.node);
  const accessToken = await authenticate(config.secret);
  config.secret = undefined;
  const client = new FeishuClient(API_BASE, accessToken);
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
    const { plan } = await preflightRetirement(client, scan, state, options.projectRoot);
    client.token = undefined;
    console.log(JSON.stringify({
      result: 'ready', mode: 'preflight', checked_nodes: plan.targets.length,
      checked_files: plan.files, checked_directories: plan.directories,
      content_mismatches: 0, parent_mismatches: 0, unknown_children: 0,
      write_request_sent: false, delete_request_sent: false,
    }));
    return;
  }
  const initialPlan = retirementPlan(scan, state);
  const { recovered, deleted } = await applyRetirement(client, scan, state, options);
  state = loadState(options.statePath);
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.log(JSON.stringify({ result: 'failed', error: safe(error.message) }));
    process.exitCode = error.exitCode || 1;
  });
}

export {
  EXPECTED_COUNT, parseArguments, planReport, retirementPlan, scopeReport,
};
