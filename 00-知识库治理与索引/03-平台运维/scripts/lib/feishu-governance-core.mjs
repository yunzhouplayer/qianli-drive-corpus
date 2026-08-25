// 用途：集中提供飞书治理发布与退役共同使用的只读、安全和本地状态能力。
// 边界：本模块不创建、修改、移动或删除飞书内容；写操作必须留在独立命令中。
// 凭证：只从测试注入或 macOS 钥匙串成对读取，任何错误与返回值都不得包含凭证原文。

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const NEW_KEYCHAIN_PROFILE = Object.freeze({
  name: 'governance',
  secret_service: 'qianli-feishu-governance',
  node_service: 'qianli-feishu-governance-node',
  node_account: 'authorized-parent-node',
});

const LEGACY_KEYCHAIN_PROFILE = Object.freeze({
  name: 'legacy_smoke',
  secret_service: 'qianli-feishu-smoke',
  node_service: 'qianli-feishu-smoke-node',
  node_account: 'authorized-node',
});

class GovernanceToolError extends Error {
  constructor(message, exitCode = 1, details = {}) {
    super(message);
    this.name = 'GovernanceToolError';
    this.exitCode = exitCode;
    Object.assign(this, details);
  }
}

function fail(message, exitCode = 1, details = {}) {
  throw new GovernanceToolError(message, exitCode, details);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function planDigest(document, field = 'plan_digest') {
  const unsigned = { ...document };
  delete unsigned[field];
  return sha256(canonicalJson(unsigned));
}

function shortHash(value) {
  return sha256(String(value)).slice(0, 10);
}

function normalizeRelative(path) {
  return String(path).split(sep).join('/');
}

function safe(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b[tu]-[A-Za-z0-9_-]{10,}\b/g, '[TOKEN_REDACTED]')
    .replace(/(?:wik|doc|docx|dox|blk)[A-Za-z0-9_-]{6,}/gi, '[RESOURCE_REDACTED]')
    .slice(0, 500);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function readKeychainEntry(account, service, runner = spawnSync) {
  const result = runner('security', ['find-generic-password', '-a', account, '-s', service, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return null;
  return String(result.stdout).trim();
}

function selectKeychainPair(appId, { reader = readKeychainEntry } = {}) {
  const readProfile = (profile) => ({
    profile: profile.name,
    secret: reader(appId, profile.secret_service),
    node: reader(profile.node_account, profile.node_service),
  });
  const governance = readProfile(NEW_KEYCHAIN_PROFILE);
  const governancePresent = Number(Boolean(governance.secret)) + Number(Boolean(governance.node));
  if (governancePresent === 2) return governance;
  if (governancePresent === 1) {
    fail('新治理钥匙串配置不完整；必须同时保存 App Secret 和授权父节点，拒绝回退旧配置。', 5);
  }

  const legacy = readProfile(LEGACY_KEYCHAIN_PROFILE);
  const legacyPresent = Number(Boolean(legacy.secret)) + Number(Boolean(legacy.node));
  if (legacyPresent === 2) return legacy;
  if (legacyPresent === 1) fail('旧钥匙串兼容配置不完整；必须同时存在 Secret 和授权节点。', 5);
  fail('缺少成对的飞书治理钥匙串配置。', 5);
}

function loadFeishuConfiguration({
  appId, apiBase, testMode = false, testSecretEnv, testNodeEnv, environment = process.env,
  keychainReader,
}) {
  if (testMode) {
    const host = new URL(apiBase).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) fail('测试模式只允许回环地址。', 5);
    const secret = environment[testSecretEnv];
    const node = environment[testNodeEnv];
    if (!secret || !node) fail('测试模式缺少模拟配置。', 5);
    return { secret, node, keychain_profile: 'loopback_test' };
  }
  return selectKeychainPair(appId, { reader: keychainReader || readKeychainEntry });
}

function wikiToken(value) {
  const input = String(value || '').trim();
  if (/^https?:\/\//i.test(input)) {
    const match = new URL(input).pathname.match(/\/wiki\/([^/?#]+)/);
    if (!match) fail('授权节点链接中缺少 Wiki token。', 5);
    return decodeURIComponent(match[1]);
  }
  if (!/^[A-Za-z0-9_-]{6,999}$/.test(input)) fail('授权节点 token 格式不合法。', 5);
  return input;
}

async function authenticateTenant({ apiBase, appId, secret, fetchImpl = fetch }) {
  const response = await fetchImpl(new URL('/open-apis/auth/v3/tenant_access_token/internal', apiBase), {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: secret }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.code !== 0 || !body?.tenant_access_token) {
    fail(`认证失败：http=${response.status}, code=${body?.code ?? 'unknown'}, msg=${safe(body?.msg)}`, 5);
  }
  return body.tenant_access_token;
}

class FeishuClient {
  constructor(baseUrl, token, { minimumDelay = 650 } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.lastRequestAt = 0;
    this.minimumDelay = Number(minimumDelay);
  }

  async waitForRateLimit() {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minimumDelay) await sleep(this.minimumDelay - elapsed);
    this.lastRequestAt = Date.now();
  }

  async request(label, pathOrUrl, options = {}, attempt = 0) {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET' || options.body) fail('共享 FeishuClient 只允许只读 GET 请求。', 6);
    await this.waitForRateLimit();
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, this.baseUrl);
    const response = await fetch(url, {
      ...options,
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}`, ...(options.headers || {}) },
    });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : { code: response.ok ? 0 : undefined }; }
    catch { fail(`${label} 返回非 JSON 响应。`, 6); }
    const retryable = response.status === 429 || body?.code === 99991400 || body?.code === 1061045;
    if (retryable && attempt < 5) {
      await sleep((2 ** attempt) * 500 + Math.floor(Math.random() * 200));
      return this.request(label, url, options, attempt + 1);
    }
    if (!response.ok || body?.code !== 0) {
      fail(`${label} 失败：http=${response.status}, code=${body?.code ?? 'unknown'}, msg=${safe(body?.msg)}`, 6);
    }
    return body.data || {};
  }

  async resolveNode(nodeToken) {
    const url = new URL('/open-apis/wiki/v2/spaces/get_node', this.baseUrl);
    url.searchParams.set('token', nodeToken);
    const data = await this.request('解析授权节点', url);
    if (!data.node?.space_id || !data.node?.node_token) fail('授权节点响应缺少必要字段。', 6);
    return data.node;
  }

  async listGrantedScopes() {
    const data = await this.request('查询租户授权状态', '/open-apis/application/v6/scopes');
    return Array.isArray(data.scopes) ? data.scopes : [];
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

  async listDocumentChildren(documentId, revisionId = -1) {
    if (revisionId === null || revisionId === undefined || revisionId === '') {
      fail('读取文档子块时必须提供有效 revision。', 6);
    }
    const items = [];
    let pageToken;
    do {
      const url = new URL(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, this.baseUrl);
      url.searchParams.set('page_size', '50');
      url.searchParams.set('document_revision_id', String(revisionId));
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const data = await this.request('读取文档子块', url);
      items.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return items;
  }

  async getDocumentMetadata(documentId) {
    const data = await this.request('读取文档元数据', `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`);
    return data.document || data;
  }
}

function parseState(path, { required = false } = {}) {
  if (!existsSync(path)) {
    if (required) fail('缺少本地发布状态，拒绝推断远端节点。', 7);
    return null;
  }
  let raw;
  let state;
  try {
    raw = readFileSync(path, 'utf8');
    state = JSON.parse(raw);
  } catch {
    fail('本地发布状态必须是合法 JSON。', 7);
  }
  if (!['1.0', '1.1'].includes(state.schema_version) || !state.nodes || typeof state.nodes !== 'object') {
    fail('本地发布状态格式不受支持。', 7);
  }
  return { state, raw };
}

function saveStateAtomic(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function migrateState(state, { sourcePath, sourceRaw }) {
  if (state.schema_version === '1.1') return state;
  return {
    ...state,
    schema_version: '1.1',
    migration: {
      source_schema_version: '1.0',
      source_file: basename(sourcePath),
      source_sha256: sha256(sourceRaw),
      migrated_at: new Date().toISOString(),
    },
  };
}

function loadPublicationState({ statePath, legacyStatePath = null, required = false }) {
  const current = parseState(statePath);
  const legacy = legacyStatePath && legacyStatePath !== statePath ? parseState(legacyStatePath) : null;
  if (current) {
    if (legacy && current.state.schema_version === '1.1') {
      if (current.state.migration?.source_sha256 !== sha256(legacy.raw)) {
        fail('新旧发布状态同时存在但迁移摘要不一致，拒绝选择状态。', 7);
      }
    }
    if (current.state.schema_version === '1.0') {
      const migrated = migrateState(current.state, { sourcePath: statePath, sourceRaw: current.raw });
      saveStateAtomic(statePath, migrated);
      return migrated;
    }
    return current.state;
  }
  if (legacy) {
    const migrated = migrateState(legacy.state, { sourcePath: legacyStatePath, sourceRaw: legacy.raw });
    saveStateAtomic(statePath, migrated);
    return migrated;
  }
  if (required) fail('缺少本地发布状态，拒绝推断远端节点。', 7);
  return null;
}

export {
  FeishuClient, GovernanceToolError, LEGACY_KEYCHAIN_PROFILE, NEW_KEYCHAIN_PROFILE,
  authenticateTenant, canonicalJson, fail, loadFeishuConfiguration, loadPublicationState,
  normalizeRelative, planDigest, readKeychainEntry, safe, saveStateAtomic, selectKeychainPair,
  sha256, shortHash, sleep, wikiToken,
};
