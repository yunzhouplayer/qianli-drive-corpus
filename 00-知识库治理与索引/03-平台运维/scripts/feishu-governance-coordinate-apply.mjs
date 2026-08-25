#!/usr/bin/env node

// 用途：执行已经管理员确认的飞书正文协调计划，并逐页进行精确版本写入、读回和断点恢复。
// 边界：不创建、删除或移动节点，不修改 ACL；禁止 revision=-1；任何未知远端状态立即停止。

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FeishuClient, authenticateTenant, canonicalJson, fail, loadFeishuConfiguration,
  loadPublicationState, normalizeRelative, safe, saveStateAtomic, sha256, shortHash, sleep, wikiToken,
} from './lib/feishu-governance-core.mjs';
import { assertWholePlanFresh, validatePlanDigest } from './lib/feishu-body-reconciliation.mjs';
import {
  buildLivePlan, normalizedBlockSignature, parseArguments as parseCoordinateArguments,
  redirectProposal, signatureForBlocks,
} from './feishu-governance-coordinate.mjs';
import {
  blockContent, blocksForContent, canonicalWikiUrl, resolvedLinksDigest,
  scanProject, scopeDiagnostic,
} from './feishu-governance-publish.mjs';

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaffdf087c789bda';
const API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
const WIKI_BASE_URL = process.env.FEISHU_WIKI_BASE_URL || 'https://qianli-drive.feishu.cn';
const TEST_MODE = process.env.FEISHU_IMPORT_TEST_MODE === '1';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-publication-state.json';
const LEGACY_STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-import-state.json';
const PLAN_RELATIVE = '00-知识库治理与索引/.runtime/feishu-body-reconciliation-plan.json';
const JOURNAL_RELATIVE = '00-知识库治理与索引/.runtime/feishu-body-reconciliation-execution.json';
const CURRENT_RELATIVE = '00-知识库治理与索引/.runtime/feishu-body-reconciliation-current.json';
const MANIFEST_RELATIVE = '00-知识库治理与索引/03-平台运维/02-feishu-publication-manifest.json';
const RENAME_RELATIVE = '00-知识库治理与索引/03-平台运维/01-feishu-publication-path-renames.json';

function parseArguments(argv) {
  const mode = argv[0] || '';
  if (mode !== 'apply') fail('协调执行器只支持 apply 模式。', 2);
  const options = { mode, execute: false, projectRoot: PROJECT_ROOT, confirmedDigest: '' };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--project-root') options.projectRoot = resolve(argv[++index] || '');
    else if (argument === '--plan') options.planPath = resolve(argv[++index] || '');
    else if (argument === '--state') options.statePath = resolve(argv[++index] || '');
    else if (argument === '--journal') options.journalPath = resolve(argv[++index] || '');
    else if (argument === '--confirm-plan-digest') options.confirmedDigest = String(argv[++index] || '');
    else fail(`未知参数：${argument}`, 2);
  }
  if (!options.execute) fail('apply 模式必须显式提供 --execute。', 2);
  if (!/^[0-9a-f]{64}$/.test(options.confirmedDigest)) fail('必须显式确认完整计划 SHA-256。', 2);
  options.planPath ||= resolve(options.projectRoot, PLAN_RELATIVE);
  options.statePath ||= resolve(options.projectRoot, STATE_RELATIVE);
  options.legacyStatePath = resolve(options.projectRoot, LEGACY_STATE_RELATIVE);
  options.journalPath ||= resolve(options.projectRoot, JOURNAL_RELATIVE);
  options.currentPath = resolve(options.projectRoot, CURRENT_RELATIVE);
  options.manifestPath = resolve(options.projectRoot, MANIFEST_RELATIVE);
  options.renamePath = resolve(options.projectRoot, RENAME_RELATIVE);
  return options;
}

function loadPlan(path, confirmedDigest) {
  if (!existsSync(path)) fail('协调计划不存在。', 7);
  let plan;
  try { plan = JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('协调计划必须是合法 JSON。', 7); }
  if (plan.schema_version !== '1.1' || plan.mode !== 'governance_validation') {
    fail('协调计划版本或运行模式不受支持。', 7);
  }
  validatePlanDigest(plan, confirmedDigest);
  if (!Array.isArray(plan.actions) || plan.actions.length !== 17
      || !Array.isArray(plan.directory_actions) || plan.directory_actions.length !== 1) {
    fail('协调计划动作数量与已批准范围不一致。', 7);
  }
  return plan;
}

function loadJournal(path, plan, sourceStateSha256) {
  if (existsSync(path)) {
    let journal;
    try { journal = JSON.parse(readFileSync(path, 'utf8')); }
    catch { fail('协调执行日志必须是合法 JSON。', 7); }
    if (journal.schema_version !== '1.0' || journal.plan_digest !== plan.plan_digest
        || journal.source_state_sha256 !== sourceStateSha256) {
      fail('现有执行日志与当前计划或原发布状态不匹配。', 8);
    }
    return journal;
  }
  const now = new Date().toISOString();
  return {
    schema_version: '1.0', plan_digest: plan.plan_digest, source_state_sha256: sourceStateSha256,
    status: 'initialized', created_at: now, updated_at: now, write_requests: 0,
    actions: Object.fromEntries(plan.actions.map((action) => [action.action_id, { status: 'pending' }])),
    directory_actions: Object.fromEntries(plan.directory_actions.map((action) => [action.action_id, { status: 'pending' }])),
  };
}

function saveJournal(path, journal) {
  journal.updated_at = new Date().toISOString();
  saveStateAtomic(path, journal);
}

function arrayEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function blockHashes(blocks, identities) {
  return blocks.map((block) => sha256(normalizedBlockSignature(block, identities)));
}

function executionBlockHashes(blocks, identities) {
  return blocks.map((block) => sha256(block.block_type === 14
    ? `14:${blockContent(block)}`
    : normalizedBlockSignature(block, identities)));
}

function prefixEqual(values, prefix) {
  return values.length >= prefix.length && prefix.every((value, index) => values[index] === value);
}

function buildPayloads({ projectRoot, state, plan, manifestPath }) {
  const scan = scanProject(projectRoot, manifestPath);
  const items = new Map(scan.items.filter((item) => item.kind === 'file').map((item) => [item.path, item]));
  const identities = new Map();
  for (const [path, record] of Object.entries(state.nodes)) {
    if (record.node_token) identities.set(record.node_token, `managed:${path}`);
    if (record.obj_token) identities.set(record.obj_token, `managed:${path}`);
  }
  const activeActions = plan.actions.filter((action) => action.allowed_action !== 'write_legacy_redirect');
  const registry = new Map(activeActions.map((action) => {
    const record = state.nodes[action.source_path];
    if (!record?.node_token) fail(`执行载荷缺少来源节点：${action.source_path}`, 8);
    return [action.target_path, canonicalWikiUrl(new URL(`/wiki/${record.node_token}`, WIKI_BASE_URL).toString())];
  }));
  const payloads = new Map();
  for (const action of plan.actions) {
    const record = state.nodes[action.source_path];
    if (!record?.node_token || !record?.obj_token) fail(`执行载荷缺少来源页面：${action.source_path}`, 8);
    let blocks;
    let gitSha256;
    let resolvedLinksSha256;
    if (action.allowed_action === 'write_legacy_redirect') {
      const proposal = redirectProposal(
        action.source_path, action.target_path, registry.get(action.target_path), identities,
      );
      ({ blocks, git_sha256: gitSha256, resolved_links_sha256: resolvedLinksSha256 } = proposal);
    } else {
      const item = items.get(action.target_path);
      if (!item) fail(`当前发布清单缺少协调目标：${action.target_path}`, 8);
      blocks = blocksForContent(item, null, { linkScan: item.linkScan, registry });
      gitSha256 = item.hash;
      resolvedLinksSha256 = item.linkScan ? resolvedLinksDigest(item, registry) : sha256('');
    }
    const proposalSignature = signatureForBlocks(blocks, identities);
    if (gitSha256 !== action.proposal.git_sha256
        || proposalSignature !== action.proposal.block_signature_sha256
        || resolvedLinksSha256 !== action.proposal.resolved_links_sha256) {
      fail(`当前 Git 提案与已确认计划不一致：${action.action_id}`, 8);
    }
    payloads.set(action.action_id, {
      action, record, blocks, block_hashes: blockHashes(blocks, identities),
      execution_block_hashes: executionBlockHashes(blocks, identities), identities,
      parent_node_token: state.nodes[record.parent_path]?.node_token,
      git_sha256: gitSha256, resolved_links_sha256: resolvedLinksSha256,
      target_title: action.allowed_action === 'write_legacy_redirect'
        ? basename(action.source_path) : basename(action.target_path),
      target_parent_path: normalizeRelative(dirname(
        action.allowed_action === 'write_legacy_redirect' ? action.source_path : action.target_path,
      )),
    });
  }
  return { payloads, identities, scan };
}

class CoordinateWriter extends FeishuClient {
  constructor(baseUrl, token, options = {}) {
    super(baseUrl, token, options);
    this.writeRequests = 0;
  }

  async requestWrite(label, pathOrUrl, options = {}, attempt = 0) {
    await this.waitForRateLimit();
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, this.baseUrl);
    this.writeRequests += 1;
    const response = await fetch(url, {
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(options.body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { fail(`${label} 返回非 JSON 响应。`, 6); }
    const retryable = response.status === 429 || body?.code === 99991400 || body?.code === 1061045;
    if (retryable && attempt < 5) {
      this.writeRequests -= 1;
      await sleep((2 ** attempt) * 500 + Math.floor(Math.random() * 200));
      return this.requestWrite(label, url, options, attempt + 1);
    }
    if (!response.ok || body?.code !== 0) {
      fail(`${label} 失败：http=${response.status}, code=${body?.code ?? 'unknown'}, msg=${safe(body?.msg)}`, 6);
    }
    return body.data || {};
  }

  async appendExact(documentId, revisionId, blocks, clientToken) {
    const url = new URL(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, this.baseUrl);
    url.searchParams.set('document_revision_id', String(revisionId));
    url.searchParams.set('client_token', clientToken);
    return this.requestWrite('按精确版本追加正文块', url, {
      method: 'POST', body: JSON.stringify({ index: -1, children: blocks }),
    });
  }

  async deleteExact(documentId, revisionId, startIndex, endIndex, clientToken) {
    const url = new URL(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children/batch_delete`, this.baseUrl);
    url.searchParams.set('document_revision_id', String(revisionId));
    url.searchParams.set('client_token', clientToken);
    return this.requestWrite('按精确版本删除已验证旧块', url, {
      method: 'DELETE', body: JSON.stringify({ start_index: startIndex, end_index: endIndex }),
    });
  }

  async updateTitle(spaceId, nodeToken, title) {
    return this.requestWrite('原位更新知识库节点标题', `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes/${encodeURIComponent(nodeToken)}/update_title`, {
      method: 'POST', body: JSON.stringify({ title }),
    });
  }
}

async function readPageSnapshot(client, payload) {
  const metadata = await client.getDocumentMetadata(payload.record.obj_token);
  const revisionId = metadata.revision_id;
  if (revisionId === -1 || revisionId === '-1' || revisionId === undefined || revisionId === null) {
    fail(`飞书未返回精确 revision：${payload.action.action_id}`, 8);
  }
  const blocks = await client.listDocumentChildren(payload.record.obj_token, revisionId);
  const confirmed = await client.getDocumentMetadata(payload.record.obj_token);
  if (confirmed.revision_id !== revisionId) fail(`读取期间页面 revision 已变化：${payload.action.action_id}`, 8);
  const node = await client.resolveNode(payload.record.node_token);
  return {
    revision_id: revisionId, blocks, block_hashes: blockHashes(blocks, payload.identities),
    execution_block_hashes: executionBlockHashes(blocks, payload.identities),
    body_sha256: sha256(canonicalJson(blocks)), title: node.title || metadata.title,
    parent_node_ref: shortHash(node.parent_node_token || payload.parent_node_token || ''),
    node_ref: shortHash(node.node_token),
  };
}

function classifySnapshot(snapshot, action, payload, entry) {
  if (snapshot.node_ref !== action.source_node_ref) fail(`页面节点身份已变化：${action.action_id}`, 8);
  if (snapshot.parent_node_ref !== action.expected_remote.parent_node_ref) {
    fail(`页面父节点已变化：${action.action_id}`, 8);
  }
  const proposal = payload.execution_block_hashes || executionBlockHashes(payload.blocks, payload.identities);
  if (arrayEqual(snapshot.execution_block_hashes, proposal)) {
    return { state: 'final', appended: proposal.length };
  }
  if (!entry.old_block_hashes) {
    if (snapshot.body_sha256 !== action.expected_remote.body_sha256
        || snapshot.revision_id !== action.expected_remote.revision_id
        || sha256(snapshot.title || '') !== action.expected_remote.title_sha256) {
      fail(`页面不再处于计划基线：${action.action_id}`, 8);
    }
    entry.old_block_hashes = snapshot.block_hashes;
    entry.old_block_count = snapshot.blocks.length;
    entry.old_body_sha256 = snapshot.body_sha256;
  }
  const old = entry.old_block_hashes;
  if (!prefixEqual(snapshot.block_hashes, old)) fail(`页面旧正文前缀已变化：${action.action_id}`, 8);
  const suffix = snapshot.execution_block_hashes.slice(old.length);
  if (!prefixEqual(proposal, suffix)) {
    const mismatch = suffix.findIndex((value, index) => proposal[index] !== value);
    const actualBlock = snapshot.blocks[old.length + mismatch];
    const expectedBlock = payload.blocks[mismatch];
    const actualText = blockContent(actualBlock || {});
    const expectedText = blockContent(expectedBlock || {});
    let textMismatch = 0;
    while (textMismatch < actualText.length && textMismatch < expectedText.length
      && actualText[textMismatch] === expectedText[textMismatch]) textMismatch += 1;
    fail(
      `页面新正文追加前缀未知：${action.action_id}; `
      + `suffix_blocks=${suffix.length}, proposal_blocks=${proposal.length}, mismatch_index=${mismatch}, `
      + `actual_type=${actualBlock?.block_type ?? 'missing'}, expected_type=${expectedBlock?.block_type ?? 'missing'}, `
      + `actual_hash_ref=${shortHash(suffix[mismatch] || '')}, expected_hash_ref=${shortHash(proposal[mismatch] || '')}, `
      + `actual_text_length=${actualText.length}, expected_text_length=${expectedText.length}, `
      + `text_mismatch_index=${textMismatch}, actual_codepoint=${actualText.codePointAt(textMismatch) ?? 'end'}, `
      + `expected_codepoint=${expectedText.codePointAt(textMismatch) ?? 'end'}`,
      8,
    );
  }
  return { state: suffix.length === proposal.length ? 'combined' : 'partial', appended: suffix.length };
}

async function ensurePageTitle(client, state, payload, entry, persist) {
  const action = payload.action;
  const node = await client.resolveNode(payload.record.node_token);
  const currentTitle = node.title;
  if (currentTitle === payload.target_title) return;
  if (currentTitle !== payload.record.title) fail(`页面标题既不是来源也不是目标：${action.action_id}`, 8);
  entry.status = 'title_updating';
  persist();
  await client.updateTitle(state.space_id, payload.record.node_token, payload.target_title);
  const verified = await client.resolveNode(payload.record.node_token);
  if (verified.title !== payload.target_title) fail(`页面标题写后核验失败：${action.action_id}`, 8);
}

async function executePageAction({ client, state, payload, entry, persist }) {
  const action = payload.action;
  let snapshot = await readPageSnapshot(client, payload);
  let classification = classifySnapshot(snapshot, action, payload, entry);
  persist();
  if (classification.state === 'partial' || classification.state === 'combined') {
    entry.status = 'new_body_appending';
    persist();
    while (classification.appended < payload.blocks.length) {
      const start = classification.appended;
      const chunk = payload.blocks.slice(start, start + 50);
      entry.client_tokens ||= {};
      const tokenKey = `append_${start}`;
      entry.client_tokens[tokenKey] ||= randomUUID();
      persist();
      await client.appendExact(payload.record.obj_token, snapshot.revision_id, chunk, entry.client_tokens[tokenKey]);
      snapshot = await readPageSnapshot(client, payload);
      classification = classifySnapshot(snapshot, action, payload, entry);
      if (classification.appended < start + chunk.length) fail(`正文追加写后块数未前进：${action.action_id}`, 8);
      entry.last_revision = snapshot.revision_id;
      persist();
    }
    classification.state = 'combined';
  }
  if (classification.state === 'combined') {
    entry.status = 'old_body_deleting';
    entry.client_tokens ||= {};
    entry.client_tokens.delete_old ||= randomUUID();
    persist();
    await client.deleteExact(
      payload.record.obj_token, snapshot.revision_id, 0, entry.old_block_count,
      entry.client_tokens.delete_old,
    );
    snapshot = await readPageSnapshot(client, payload);
    classification = classifySnapshot(snapshot, action, payload, entry);
    if (classification.state !== 'final') fail(`旧正文删除后读回不一致：${action.action_id}`, 8);
  }
  if (classification.state !== 'final') fail(`页面状态不可执行：${action.action_id}`, 8);
  entry.status = 'body_verified';
  entry.final_revision = snapshot.revision_id;
  persist();
  await ensurePageTitle(client, state, payload, entry, persist);
  const final = await readPageSnapshot(client, payload);
  const finalExpected = payload.execution_block_hashes
    || executionBlockHashes(payload.blocks, payload.identities);
  if (!arrayEqual(final.execution_block_hashes, finalExpected) || final.title !== payload.target_title) {
    fail(`页面最终读回失败：${action.action_id}`, 8);
  }
  entry.status = 'complete';
  entry.final_revision = final.revision_id;
  entry.final_body_sha256 = final.body_sha256;
  persist();
  return true;
}

async function executeDirectoryAction({ client, state, action, entry, persist }) {
  const source = state.nodes[action.source_path];
  const parent = state.nodes[source?.parent_path];
  if (source?.kind !== 'directory' || !source.node_token || !parent?.node_token) {
    fail(`目录执行状态缺少来源记录：${action.action_id}`, 8);
  }
  const node = await client.resolveNode(source.node_token);
  if (shortHash(node.node_token) !== action.node_ref
      || shortHash(node.parent_node_token || parent.node_token) !== action.expected_remote.parent_node_ref) {
    fail(`目录节点身份或父节点已变化：${action.action_id}`, 8);
  }
  const targetTitle = basename(action.target_path);
  if (node.title === targetTitle) {
    entry.status = 'complete';
    persist();
    return true;
  }
  if (sha256(node.title || source.title) !== action.expected_remote.title_sha256) {
    fail(`目录标题已变化：${action.action_id}`, 8);
  }
  const siblings = await client.listNodes(state.space_id, parent.node_token);
  if (siblings.some((item) => item.node_token !== source.node_token && item.title === targetTitle)) {
    fail(`目录目标标题发生冲突：${action.action_id}`, 8);
  }
  entry.status = 'title_updating';
  persist();
  await client.updateTitle(state.space_id, source.node_token, targetTitle);
  const verified = await client.resolveNode(source.node_token);
  if (verified.title !== targetTitle) fail(`目录改名写后核验失败：${action.action_id}`, 8);
  entry.status = 'complete';
  persist();
  return true;
}

function finalizeState({ state, plan, payloads, scan, journal }) {
  const updated = structuredClone(state);
  for (const action of plan.actions) {
    const payload = payloads.get(action.action_id);
    const source = updated.nodes[action.source_path];
    if (!source) fail(`本地状态最终迁移缺少来源：${action.action_id}`, 8);
    const legacy = action.allowed_action === 'write_legacy_redirect';
    const destination = legacy ? action.source_path : action.target_path;
    if (destination !== action.source_path && updated.nodes[destination]) {
      fail(`本地状态最终迁移目标已存在：${action.action_id}`, 8);
    }
    const entry = journal.actions[action.action_id];
    const next = {
      ...source,
      title: payload.target_title,
      parent_path: payload.target_parent_path === '.' ? '.' : payload.target_parent_path,
      status: 'complete', source_hash: payload.git_sha256, block_count: payload.blocks.length,
      block_signature_sha256: action.proposal.block_signature_sha256,
      resolved_links_sha256: payload.resolved_links_sha256,
      content_authority: 'feishu', revision_id: entry.final_revision,
    };
    updated.nodes[destination] = next;
    if (destination !== action.source_path) delete updated.nodes[action.source_path];
  }
  for (const action of plan.directory_actions) {
    const source = updated.nodes[action.source_path];
    if (!source || updated.nodes[action.target_path]) fail(`目录状态最终迁移冲突：${action.action_id}`, 8);
    updated.nodes[action.target_path] = { ...source, title: basename(action.target_path) };
    delete updated.nodes[action.source_path];
  }
  updated.schema_version = '1.1';
  updated.updated_at = new Date().toISOString();
  updated.completed_at = updated.updated_at;
  updated.project_snapshot = sha256(scan.items.map((item) => `${item.path}:${item.hash}`).join('\n'));
  updated.last_reconciliation = {
    plan_digest: plan.plan_digest, completed_at: updated.updated_at,
    page_actions: plan.actions.length, directory_actions: plan.directory_actions.length,
  };
  return updated;
}

async function authenticateWriter() {
  const config = loadFeishuConfiguration({
    appId: APP_ID, apiBase: API_BASE, testMode: TEST_MODE,
    testSecretEnv: 'FEISHU_IMPORT_TEST_SECRET', testNodeEnv: 'FEISHU_IMPORT_TEST_PARENT_NODE',
  });
  const token = await authenticateTenant({ apiBase: API_BASE, appId: APP_ID, secret: config.secret });
  config.secret = undefined;
  return { config, client: new CoordinateWriter(API_BASE, token, {
    minimumDelay: Number(process.env.FEISHU_IMPORT_MIN_DELAY_MS ?? (TEST_MODE ? 0 : 650)),
  }) };
}

async function execute(options) {
  const plan = loadPlan(options.planPath, options.confirmedDigest);
  const stateRaw = readFileSync(options.statePath, 'utf8');
  const sourceStateSha256 = sha256(stateRaw);
  const journal = loadJournal(options.journalPath, plan, plan.source_state_sha256);
  if (sourceStateSha256 !== plan.source_state_sha256) {
    let currentState;
    try { currentState = JSON.parse(stateRaw); } catch { fail('本地发布状态必须是合法 JSON。', 7); }
    if (['remote_complete_state_pending', 'complete'].includes(journal.status)
        && currentState.last_reconciliation?.plan_digest === plan.plan_digest) {
      journal.status = 'complete';
      journal.completed_at ||= new Date().toISOString();
      saveJournal(options.journalPath, journal);
      return {
        result: 'passed', mode: 'apply', resumed: true,
        write_requests: journal.write_requests, plan_digest: plan.plan_digest,
        state_already_finalized: true,
      };
    }
    fail('本地发布状态与计划摘要不一致。', 8);
  }
  const state = loadPublicationState({
    statePath: options.statePath, legacyStatePath: options.legacyStatePath, required: true,
  });
  const rootRecord = state.nodes['.'];
  if (!rootRecord?.node_token
      || sha256(APP_ID) !== plan.scope.app_id_sha256
      || sha256(state.space_id) !== plan.scope.space_id_sha256
      || sha256(rootRecord.node_token) !== plan.scope.managed_root_node_sha256) {
    fail('应用身份、空间或受管根节点与计划范围不一致。', 8);
  }
  const { payloads, scan } = buildPayloads({
    projectRoot: options.projectRoot, state, plan, manifestPath: options.manifestPath,
  });
  const persist = () => saveJournal(options.journalPath, journal);
  if (journal.status === 'complete') {
    return { result: 'passed', mode: 'apply', resumed: true, write_requests: 0, plan_digest: plan.plan_digest };
  }
  if (journal.status === 'initialized') {
    const currentOptions = parseCoordinateArguments([
      'plan', '--project-root', options.projectRoot, '--state', options.statePath,
      '--publication-manifest', options.manifestPath, '--rename-map', options.renamePath,
      '--output', options.currentPath, '--accept-link-only-baseline',
    ]);
    const report = await buildLivePlan(currentOptions);
    if (report.result !== 'ready') fail('执行前整份计划新鲜度检查未通过。', 8);
    const current = JSON.parse(readFileSync(options.currentPath, 'utf8'));
    assertWholePlanFresh(plan, current);
    journal.status = 'preflight_complete';
    persist();
  }
  const { client, config } = await authenticateWriter();
  const scopeReport = scopeDiagnostic(await client.listGrantedScopes(), 'apply');
  if (!scopeReport.passed) fail('应用身份缺少协调执行所需的租户级读写权限。', 9);
  const authorizedParent = await client.resolveNode(wikiToken(config.node));
  config.node = undefined;
  if (authorizedParent.space_id !== state.space_id
      || shortHash(authorizedParent.node_token) !== state.parent_node_ref) {
    fail('当前授权父节点与本地发布状态不一致。', 8);
  }
  const priorWriteRequests = journal.write_requests;
  const persistWithClient = () => {
    journal.write_requests = priorWriteRequests + client.writeRequests;
    saveJournal(options.journalPath, journal);
  };
  for (const action of plan.actions) {
    const entry = journal.actions[action.action_id];
    await executePageAction({
      client, state, payload: payloads.get(action.action_id), entry, persist: persistWithClient,
    });
  }
  for (const action of plan.directory_actions) {
    const entry = journal.directory_actions[action.action_id];
    await executeDirectoryAction({ client, state, action, entry, persist: persistWithClient });
  }
  journal.status = 'remote_complete_state_pending';
  persistWithClient();
  const finalState = finalizeState({ state, plan, payloads, scan, journal });
  saveStateAtomic(options.statePath, finalState);
  journal.status = 'complete';
  journal.completed_at = new Date().toISOString();
  persistWithClient();
  client.token = undefined;
  return {
    result: 'passed', mode: 'apply', plan_digest: plan.plan_digest,
    page_actions: plan.actions.length, directory_actions: plan.directory_actions.length,
    write_requests: journal.write_requests, state_gitignored: true,
    create_requests: 0, delete_node_requests: 0, move_requests: 0, acl_requests: 0,
    production_index_changed: false,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  try { console.log(JSON.stringify(await execute(parseArguments(argv)))); }
  catch (error) {
    console.log(JSON.stringify({ result: 'failed', error: safe(error.message) }));
    process.exitCode = error.exitCode || 1;
  }
}

export {
  CoordinateWriter, arrayEqual, blockHashes, buildPayloads, classifySnapshot, executionBlockHashes,
  executeDirectoryAction, executePageAction, finalizeState, loadPlan, parseArguments, prefixEqual,
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runCli();
