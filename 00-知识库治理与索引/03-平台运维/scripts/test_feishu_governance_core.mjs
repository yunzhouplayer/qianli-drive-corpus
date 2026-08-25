#!/usr/bin/env node

// 用途：离线验证共享 core 的 Keychain 成对选择、状态 1.1 迁移、原子写入和只读客户端边界。
// 边界：不监听端口、不访问飞书、不调用真实钥匙串；所有凭证值均为进程内测试占位符。

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FeishuClient, loadPublicationState, safe, selectKeychainPair, sha256,
} from './lib/feishu-governance-core.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pairReader(entries) {
  return (account, service) => entries[`${service}/${account}`] || null;
}

const appId = 'cli_test_only';
const complete = {
  'qianli-feishu-governance/cli_test_only': 'new-secret-placeholder',
  'qianli-feishu-governance-node/authorized-parent-node': 'new-node-placeholder',
  'qianli-feishu-smoke/cli_test_only': 'old-secret-placeholder',
  'qianli-feishu-smoke-node/authorized-node': 'old-node-placeholder',
};
const selected = selectKeychainPair(appId, { reader: pairReader(complete) });
assert(selected.profile === 'governance' && selected.secret === 'new-secret-placeholder', '完整新配置必须优先');

const legacy = selectKeychainPair(appId, { reader: pairReader({
  'qianli-feishu-smoke/cli_test_only': 'old-secret-placeholder',
  'qianli-feishu-smoke-node/authorized-node': 'old-node-placeholder',
}) });
assert(legacy.profile === 'legacy_smoke' && legacy.node === 'old-node-placeholder', '新配置全缺失时应成对回退旧配置');

let partialBlocked = false;
try {
  selectKeychainPair(appId, { reader: pairReader({
    ...complete,
    'qianli-feishu-governance-node/authorized-parent-node': null,
  }) });
} catch (error) {
  partialBlocked = /不完整/.test(error.message)
    && !error.message.includes('new-secret-placeholder')
    && !error.message.includes('old-secret-placeholder');
}
assert(partialBlocked, '新配置只存在一项时必须阻塞且不得泄露或回退');

const temporaryRoot = mkdtempSync(join(tmpdir(), 'qianli-feishu-core-test-'));
const runtimeRoot = join(temporaryRoot, 'runtime');
mkdirSync(runtimeRoot, { recursive: true });
const legacyPath = join(runtimeRoot, 'feishu-import-state.json');
const statePath = join(runtimeRoot, 'feishu-publication-state.json');
const legacyState = {
  schema_version: '1.0',
  parent_node_ref: 'parent-ref',
  space_id: 'space-ref',
  nodes: { '.': { kind: 'directory', status: 'complete' } },
  retirement_history: [{ path: 'old.md', result: 'deleted_and_absence_verified' }],
};
const legacyRaw = `${JSON.stringify(legacyState, null, 2)}\n`;
writeFileSync(legacyPath, legacyRaw, { encoding: 'utf8', mode: 0o600 });
const migrated = loadPublicationState({ statePath, legacyStatePath: legacyPath, required: true });
assert(migrated.schema_version === '1.1', '旧状态必须迁移到 schema 1.1');
assert(migrated.nodes['.'] && migrated.retirement_history.length === 1, '迁移必须保留节点和退役历史');
assert(migrated.migration.source_sha256 === sha256(legacyRaw), '迁移必须记录旧状态完整摘要');
assert((statSync(statePath).mode & 0o777) === 0o600, '新状态文件权限必须为 0600');
assert(JSON.parse(readFileSync(statePath, 'utf8')).schema_version === '1.1', '迁移结果必须原子写入新路径');

writeFileSync(legacyPath, `${legacyRaw}\n`, { encoding: 'utf8', mode: 0o600 });
let mismatchBlocked = false;
try {
  loadPublicationState({ statePath, legacyStatePath: legacyPath, required: true });
} catch (error) {
  mismatchBlocked = /摘要不一致/.test(error.message);
}
assert(mismatchBlocked, '新旧状态同时存在但摘要漂移时必须阻塞');

const client = new FeishuClient('https://example.invalid', 'test-token', { minimumDelay: 0 });
let writeBlocked = false;
try {
  await client.request('禁止写入测试', '/resource', { method: 'DELETE' });
} catch (error) {
  writeBlocked = /只允许只读 GET/.test(error.message);
}
assert(writeBlocked, '共享 FeishuClient 必须拒绝写方法');
const originalFetch = globalThis.fetch;
let requestedRevision = null;
globalThis.fetch = async (url) => {
  requestedRevision = new URL(url).searchParams.get('document_revision_id');
  return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
await client.listDocumentChildren('document-test-only', 17);
globalThis.fetch = originalFetch;
assert(requestedRevision === '17', '正文协调读取必须透传精确 revision');
assert(!safe('Bearer t-exampletoken123456 wikExampleToken').includes('exampletoken'), '脱敏函数必须隐藏访问令牌');

console.log(JSON.stringify({
  result: 'passed',
  cases: [
    'new_keychain_pair_preferred', 'legacy_pair_fallback', 'partial_new_pair_blocks_fallback',
    'publication_state_1_1_migration', 'state_digest_drift_blocked', 'readonly_client_write_rejected',
    'exact_revision_read', 'sensitive_values_redacted',
  ],
  network: 'none',
  keychain_access: 'injected_reader_only',
}, null, 2));
