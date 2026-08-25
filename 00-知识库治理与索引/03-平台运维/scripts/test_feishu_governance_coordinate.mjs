#!/usr/bin/env node

// 用途：离线验证正文协调入口的范围闭合、历史基线恢复和旧页跳转提案。
// 边界：不访问网络、不读取 Keychain、不写飞书。

import {
  actionSourceMapping, gitBaseline, parseArguments, redirectProposal, signatureForBlocks,
} from './feishu-governance-coordinate.mjs';
import { sha256 } from './lib/feishu-governance-core.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baselineBody = '# 历史正文\n';
const baselineHash = sha256(baselineBody);
const fakeRunner = (_command, args) => {
  if (args[0] === 'log') return { status: 0, stdout: 'commit-a\ncommit-b\n' };
  if (args[0] === 'show' && args[1].startsWith('commit-a:')) return { status: 0, stdout: 'wrong' };
  if (args[0] === 'show' && args[1].startsWith('commit-b:')) return { status: 0, stdout: baselineBody };
  return { status: 1, stdout: '' };
};
const baseline = gitBaseline('/tmp/not-used', 'old.md', baselineHash, fakeRunner);
assert(baseline?.commit === 'commit-b' && baseline.content === baselineBody, '必须按状态哈希恢复准确历史正文');

const scan = {
  items: [
    { kind: 'file', path: 'new.md' },
    { kind: 'file', path: 'same.md' },
  ],
  publication: { legacy_redirects: [{ legacyPath: 'legacy.md', replacementPath: 'same.md' }] },
};
const state = { nodes: {
  'old.md': { kind: 'file' }, 'same.md': { kind: 'file' }, 'legacy.md': { kind: 'file' },
} };
const mapping = actionSourceMapping(scan, state, [{ oldPath: 'old.md', newPath: 'new.md' }]);
assert(mapping.get('new.md') === 'old.md' && mapping.get('same.md') === 'same.md', '迁移和原路径应映射到唯一飞书来源');
let closureBlocked = false;
try {
  actionSourceMapping(scan, { nodes: { ...state.nodes, 'extra.md': { kind: 'file' } } }, [
    { oldPath: 'old.md', newPath: 'new.md' },
  ]);
} catch (error) {
  closureBlocked = /不闭合/.test(error.message);
}
assert(closureBlocked, '未规划的旧飞书页面必须阻塞');

const redirect = redirectProposal('legacy.md', 'same.md', 'https://example.feishu.cn/wiki/test-only');
assert(/^[0-9a-f]{64}$/.test(redirect.git_sha256), '旧页提示必须生成正文摘要');
assert(/^[0-9a-f]{64}$/.test(redirect.resolved_links_sha256), '旧页提示必须冻结链接摘要');
assert(signatureForBlocks([]) === sha256(''), '空块签名必须确定');
assert(parseArguments(['plan', '--accept-link-only-baseline']).acceptLinkOnlyBaseline,
  '链接属性基线接受必须通过显式参数启用');

console.log(JSON.stringify({
  result: 'passed',
  cases: [
    'git_baseline_recovery', 'closed_page_scope', 'unplanned_page_blocked',
    'legacy_redirect_proposal', 'explicit_link_only_acceptance',
  ],
  network: 'none',
}, null, 2));
