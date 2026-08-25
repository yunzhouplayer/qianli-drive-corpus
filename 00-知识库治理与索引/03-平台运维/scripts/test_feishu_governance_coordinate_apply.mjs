#!/usr/bin/env node

// 用途：离线验证正文协调执行器的精确 revision、分批写入、恢复、漂移阻断和状态迁移。
// 边界：不监听端口、不访问飞书、不读取 Keychain；所有远端对象均为进程内模拟。

import {
  CoordinateWriter, blockHashes, executeDirectoryAction, executePageAction, finalizeState, parseArguments,
} from './feishu-governance-coordinate-apply.mjs';
import { canonicalJson, sha256, shortHash } from './lib/feishu-governance-core.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectFailure(callback, pattern) {
  let message = '';
  try { await callback(); } catch (error) { message = error.message; }
  assert(pattern.test(message), `预期失败未发生：${pattern}`);
}

function textBlock(content) {
  return { block_type: 2, text: { elements: [{ text_run: { content, text_element_style: {} } }], style: {} } };
}

function codeBlock(elements) {
  return { block_type: 14, code: { elements: elements.map((content) => ({
    text_run: { content, text_element_style: {} },
  })), style: { language: 39, wrap: true } } };
}

class FakeClient {
  constructor({ blocks, title = 'old.md', revision = 7 } = {}) {
    this.blocks = structuredClone(blocks || []);
    this.title = title;
    this.revision = revision;
    this.parent = 'parent-node-test';
    this.node = 'page-node-test';
    this.writeRequests = 0;
    this.writeRevisions = [];
  }

  async getDocumentMetadata() { return { revision_id: this.revision, title: this.title }; }
  async listDocumentChildren(_documentId, revisionId) {
    assert(revisionId === this.revision, '读取必须使用当前精确 revision');
    return structuredClone(this.blocks);
  }
  async resolveNode(nodeToken) {
    if (nodeToken === 'directory-node-test') {
      return { node_token: nodeToken, parent_node_token: this.parent, title: this.title };
    }
    return { node_token: this.node, parent_node_token: this.parent, title: this.title };
  }
  async appendExact(_documentId, revisionId, blocks) {
    assert(revisionId === this.revision, '追加必须使用精确 revision');
    this.writeRevisions.push(revisionId);
    this.blocks.push(...structuredClone(blocks));
    this.revision += 1;
    this.writeRequests += 1;
    return { document_revision_id: this.revision };
  }
  async deleteExact(_documentId, revisionId, start, end) {
    assert(revisionId === this.revision, '删除必须使用精确 revision');
    this.writeRevisions.push(revisionId);
    this.blocks.splice(start, end - start);
    this.revision += 1;
    this.writeRequests += 1;
    return { document_revision_id: this.revision };
  }
  async updateTitle(_spaceId, _nodeToken, title) {
    this.title = title;
    this.writeRequests += 1;
  }
  async listNodes() {
    return [{ node_token: 'directory-node-test', title: this.title }];
  }
}

const identities = new Map();
const oldBlocks = [textBlock('managed marker'), textBlock('old body')];
const proposalBlocks = Array.from({ length: 55 }, (_, index) => textBlock(`new-${index + 1}`));
const action = {
  action_id: 'REC-001', source_path: 'old.md', target_path: 'new.md',
  source_node_ref: shortHash('page-node-test'),
  expected_remote: {
    revision_id: 7, body_sha256: sha256(canonicalJson(oldBlocks)), title_sha256: sha256('old.md'),
    parent_node_ref: shortHash('parent-node-test'), marker_sha256: sha256('marker'), scope_sha256: sha256('scope'),
  },
  proposal: {
    git_sha256: sha256('git'), block_signature_sha256: sha256('proposal'),
    resolved_links_sha256: sha256('links'),
  },
  allowed_action: 'rename_and_update', authority_decision: 'remote_unchanged',
};
const payload = {
  action, record: { obj_token: 'document-test', node_token: 'page-node-test', title: 'old.md' },
  blocks: proposalBlocks, block_hashes: blockHashes(proposalBlocks, identities), identities,
  parent_node_token: 'parent-node-test', target_title: 'new.md', target_parent_path: '.',
  git_sha256: action.proposal.git_sha256, resolved_links_sha256: action.proposal.resolved_links_sha256,
};
const state = { space_id: 'space-test' };

const client = new FakeClient({ blocks: oldBlocks });
const entry = { status: 'pending' };
let persists = 0;
await executePageAction({ client, state, payload, entry, persist: () => { persists += 1; } });
assert(entry.status === 'complete', '正常页面动作必须完成');
assert(client.blocks.length === proposalBlocks.length, '最终只允许保留新正文');
assert(client.title === 'new.md', '页面必须原位改名');
assert(arrayEquals(client.writeRevisions, [7, 8, 9]), '多批追加与删除必须使用递增精确 revision');
assert(client.writeRequests === 4 && persists > 4, '必须记录三次正文写入和一次标题写入');

const resumedClient = new FakeClient({ blocks: [...oldBlocks, ...proposalBlocks], revision: 8 });
const resumedEntry = {
  status: 'new_body_appended', old_block_hashes: blockHashes(oldBlocks, identities),
  old_block_count: oldBlocks.length, old_body_sha256: sha256(canonicalJson(oldBlocks)),
};
await executePageAction({
  client: resumedClient, state, payload, entry: resumedEntry, persist: () => {},
});
assert(resumedClient.blocks.length === proposalBlocks.length && resumedClient.writeRequests === 2,
  '追加后恢复只能删除旧正文并改名，不得重复追加');

const codeProposal = [textBlock('marker'), codeBlock(['same code text'])];
const splitCodeProposal = [textBlock('marker'), codeBlock(['same ', 'code ', 'text'])];
const codePayload = {
  ...payload, blocks: codeProposal, block_hashes: blockHashes(codeProposal, identities),
};
const splitCodeClient = new FakeClient({ blocks: [...oldBlocks, ...splitCodeProposal], revision: 8 });
const splitCodeEntry = {
  status: 'new_body_appending', old_block_hashes: blockHashes(oldBlocks, identities),
  old_block_count: oldBlocks.length, old_body_sha256: sha256(canonicalJson(oldBlocks)),
};
await executePageAction({
  client: splitCodeClient, state, payload: codePayload, entry: splitCodeEntry, persist: () => {},
});
assert(splitCodeClient.blocks.length === codeProposal.length && splitCodeClient.writeRequests === 2,
  '飞书拆分同一代码块 text_run 时必须按连续文本恢复，不得重复追加');

const driftClient = new FakeClient({ blocks: [textBlock('changed')] });
await expectFailure(() => executePageAction({
  client: driftClient, state, payload, entry: { status: 'pending' }, persist: () => {},
}), /计划基线|旧正文前缀/);
assert(driftClient.writeRequests === 0, '远端漂移时必须零写入');

const directoryClient = new FakeClient({ title: '模板' });
const directoryState = {
  space_id: 'space-test',
  nodes: {
    'parent': { kind: 'directory', node_token: 'parent-node-test' },
    'parent/模板': {
      kind: 'directory', node_token: 'directory-node-test', title: '模板', parent_path: 'parent',
    },
  },
};
const directoryAction = {
  action_id: 'DIR-001', source_path: 'parent/模板', target_path: 'parent/11-模板',
  node_ref: shortHash('directory-node-test'), allowed_action: 'rename_in_place',
  expected_remote: {
    title_sha256: sha256('模板'), parent_node_ref: shortHash('parent-node-test'), scope_sha256: sha256('scope'),
  },
};
const directoryEntry = { status: 'pending' };
await executeDirectoryAction({
  client: directoryClient, state: directoryState, action: directoryAction,
  entry: directoryEntry, persist: () => {},
});
assert(directoryEntry.status === 'complete' && directoryClient.title === '11-模板', '目录必须原位改名并核验');

const finalized = finalizeState({
  state: {
    schema_version: '1.1', nodes: {
      '.': { kind: 'directory' },
      'old.md': { kind: 'file', title: 'old.md', parent_path: '.', node_token: 'n', obj_token: 'o' },
      'parent': { kind: 'directory' },
      'parent/模板': { kind: 'directory', title: '模板', parent_path: 'parent' },
    },
  },
  plan: { plan_digest: sha256('plan'), actions: [action], directory_actions: [directoryAction] },
  payloads: new Map([['REC-001', payload]]),
  scan: { items: [{ path: '.', hash: sha256('root') }] },
  journal: { actions: { 'REC-001': { final_revision: 10 } } },
});
assert(finalized.nodes['new.md'] && !finalized.nodes['old.md'], '页面状态必须迁移到目标路径');
assert(finalized.nodes['parent/11-模板'] && !finalized.nodes['parent/模板'], '目录状态必须迁移到目标路径');

let argumentGate = false;
try { parseArguments(['apply', '--execute', '--confirm-plan-digest', 'bad']); }
catch (error) { argumentGate = /完整计划/.test(error.message); }
assert(argumentGate, '无完整摘要必须在认证前阻塞');

const originalFetch = globalThis.fetch;
let exactWriteRequest = null;
globalThis.fetch = async (url, options) => {
  exactWriteRequest = { url: new URL(url), method: options.method, body: options.body };
  return new Response(JSON.stringify({ code: 0, data: { document_revision_id: 18 } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
const writer = new CoordinateWriter('https://example.invalid', 'test-token', { minimumDelay: 0 });
await writer.appendExact('document-test', 17, [textBlock('new')], 'client-token-test');
globalThis.fetch = originalFetch;
assert(exactWriteRequest.url.searchParams.get('document_revision_id') === '17'
  && exactWriteRequest.url.searchParams.get('client_token') === 'client-token-test'
  && exactWriteRequest.method === 'POST', '写客户端必须发送精确 revision 并复用持久化 client token');

function arrayEquals(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

console.log(JSON.stringify({
  result: 'passed',
  cases: [
    'exact_revision_batches', 'append_interruption_resume', 'remote_drift_zero_write',
    'directory_rename_readback', 'atomic_state_projection', 'full_digest_gate',
    'exact_revision_write_request', 'code_block_text_run_normalization',
  ],
  network: 'none', keychain_access: 'none',
}, null, 2));
