#!/usr/bin/env node

// 用途：离线验证本地 AI 飞书只读烟测的授权成功、未授权拒绝、越权阻断和 GET-only 边界。
// 边界：不访问网络、不读取钥匙串、不保存真实正文或节点定位符。

import {
  FeishuClient, GovernanceToolError,
} from './lib/feishu-governance-core.mjs';
import {
  parseArguments, probeNodes,
} from './feishu-local-ai-readonly-smoke.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectFailure(callback, pattern) {
  let message = '';
  try { await callback(); } catch (error) { message = error.message; }
  assert(pattern.test(message), `预期失败未发生：${pattern}`);
}

class FakeClient {
  constructor({
    unauthorizedReadable = false, unauthorizedBodyDenied = false,
    deniedError = null, revisionChanges = false,
  } = {}) {
    this.unauthorizedReadable = unauthorizedReadable;
    this.deniedError = deniedError;
    this.unauthorizedBodyDenied = unauthorizedBodyDenied;
    this.revisionChanges = revisionChanges;
    this.metadataReads = 0;
  }

  async resolveNode(token) {
    if (token === 'authorized-node-test') {
      return {
        node_token: token, space_id: 'space-test', obj_type: 'docx', obj_token: 'document-test',
      };
    }
    if (this.unauthorizedReadable) {
      return {
        node_token: token, space_id: 'space-other', obj_type: 'docx', obj_token: 'document-other',
      };
    }
    if (this.deniedError) throw this.deniedError;
    throw new GovernanceToolError('拒绝访问', 6, { httpStatus: 403, apiCode: 99991663 });
  }

  async getDocumentMetadata(documentId) {
    this.metadataReads += 1;
    if (documentId === 'document-other' && this.unauthorizedBodyDenied) return { revision_id: 3 };
    return { revision_id: this.revisionChanges && this.metadataReads > 1 ? 18 : 17 };
  }

  async listDocumentChildren(documentId, revisionId) {
    if (documentId === 'document-other' && this.unauthorizedBodyDenied) {
      throw new GovernanceToolError('正文拒绝访问', 6, { httpStatus: 403, apiCode: 1770032 });
    }
    assert(revisionId === -1, '只读身份必须使用 -1 读取最新正文');
    return [{ block_type: 2, text: { elements: [{ text_run: { content: 'private-test-body' } }] } }];
  }
}

const options = parseArguments([
  'smoke', '--authorized-node', 'https://example.test/wiki/authorized-node-test',
  '--unauthorized-node', 'https://example.test/wiki/unauthorized-node-test',
]);
assert(options.authorizedToken === 'authorized-node-test'
  && options.unauthorizedToken === 'unauthorized-node-test', '必须从 Wiki URL 解析两个不同节点');

const passed = await probeNodes({
  client: new FakeClient(), authorizedToken: options.authorizedToken,
  unauthorizedToken: options.unauthorizedToken,
});
assert(passed.authorized.result === 'readable' && passed.authorized.revision_id === 17,
  '授权节点必须读取精确版本正文');
assert(passed.unauthorized.result === 'access_denied'
  && passed.unauthorized.existence_exposed_to_ai === false,
  '未授权节点必须拒绝并隐藏存在性');
const serialized = JSON.stringify(passed);
assert(!serialized.includes('authorized-node-test') && !serialized.includes('private-test-body'),
  '烟测结果不得包含节点 token 或正文');

const hiddenAsNotFound = await probeNodes({
  client: new FakeClient({
    deniedError: new GovernanceToolError('节点不可见', 6, { httpStatus: 400, apiCode: 131006 }),
  }),
  authorizedToken: options.authorizedToken, unauthorizedToken: options.unauthorizedToken,
});
assert(hiddenAsNotFound.unauthorized.result === 'access_denied',
  '飞书以 131006 隐藏未授权 Wiki 节点时必须判定为不可访问');

const metadataOnly = await probeNodes({
  client: new FakeClient({ unauthorizedReadable: true, unauthorizedBodyDenied: true }),
  authorizedToken: options.authorizedToken, unauthorizedToken: options.unauthorizedToken,
});
assert(metadataOnly.unauthorized.result === 'access_denied'
  && metadataOnly.unauthorized.node_metadata_visible === true
  && metadataOnly.unauthorized.body_readable === false,
  '节点元数据可见但正文被拒绝时必须按正文不可访问处理');

await expectFailure(() => probeNodes({
  client: new FakeClient({ revisionChanges: true }),
  authorizedToken: options.authorizedToken, unauthorizedToken: options.unauthorizedToken,
}), /revision 已变化/);

await expectFailure(() => probeNodes({
  client: new FakeClient({ unauthorizedReadable: true }),
  authorizedToken: options.authorizedToken, unauthorizedToken: options.unauthorizedToken,
}), /正文可被应用读取/);

await expectFailure(() => probeNodes({
  client: new FakeClient({
    deniedError: new GovernanceToolError('服务异常', 6, { httpStatus: 500, apiCode: 500001 }),
  }),
  authorizedToken: options.authorizedToken, unauthorizedToken: options.unauthorizedToken,
}), /服务异常/);

let fetchCalled = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  fetchCalled = true;
  throw new Error('不应访问网络');
};
const readonlyClient = new FeishuClient('https://example.invalid', 'token-test', { minimumDelay: 0 });
await expectFailure(() => readonlyClient.request('禁止写入', '/resource', {
  method: 'POST', body: '{}',
}), /只允许只读 GET/);
globalThis.fetch = originalFetch;
assert(fetchCalled === false, '写方法必须在发送网络请求前阻断');

await expectFailure(async () => parseArguments([
  'smoke', '--authorized-node', 'same-node', '--unauthorized-node', 'same-node',
]), /必须不同/);

console.log(JSON.stringify({
  result: 'passed',
  cases: [
    'authorized_stable_latest_read', 'unauthorized_access_denied', 'result_redaction',
    'unexpected_access_blocked', 'non_permission_error_propagated', 'write_blocked_before_network',
    'distinct_node_gate', 'wiki_node_not_visible_denied', 'latest_revision_consistency_gate',
    'metadata_visible_body_denied',
  ],
  network: 'none', keychain_access: 'none',
}, null, 2));
