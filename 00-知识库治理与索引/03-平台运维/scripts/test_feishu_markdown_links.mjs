#!/usr/bin/env node

// 用途：离线验证 Markdown 链接扫描、飞书富文本链接、Git-only 降级和危险目标拒绝。
// 边界：不访问网络、不读取 Keychain、不写飞书。

import {
  blockSignature, blocksForContent, scanMarkdownLinks,
} from './feishu-governance-publish.mjs';
import { sha256 } from './lib/feishu-governance-core.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectFailure(callback, pattern) {
  let message = '';
  try { callback(); } catch (error) { message = error.message; }
  assert(pattern.test(message), `预期失败未发生：${pattern}`);
}

const sourcePath = 'guide/a.md';
const availablePaths = new Set(['guide', sourcePath, 'guide/b.md', 'docs', 'docs/internal.md']);
const publicationPaths = new Set([sourcePath, 'guide/b.md']);
const body = [
  '# 导航',
  '- [发布页章节](./b.md#section)',
  '- [外部资料](https://example.com/reference)',
  '- [工程记录](../docs/internal.md)',
  '```md',
  '[代码中的危险示例](javascript:alert(1))',
  '```',
].join('\n');
const scan = scanMarkdownLinks(body, { sourcePath, availablePaths, publicationPaths });
assert(scan.links.map((item) => item.kind).join(',') === 'published,external_https,git_only', '链接分类不正确');
const registry = new Map([
  [sourcePath, 'https://qianli-drive.feishu.cn/wiki/source-node'],
  ['guide/b.md', 'https://qianli-drive.feishu.cn/wiki/target-node?ignored=1#ignored'],
]);
const item = { kind: 'file', path: sourcePath, hash: sha256(body) };
const blocks = blocksForContent(item, body, { linkScan: scan, registry });
const elements = blocks.flatMap((block) => {
  const property = {
    2: 'text', 3: 'heading1', 12: 'bullet', 14: 'code',
  }[block.block_type];
  return property ? (block[property]?.elements || []) : [];
});
const published = elements.find((element) => element.text_run?.content === '发布页章节');
assert(published?.text_run.text_element_style.link.url === 'https://qianli-drive.feishu.cn/wiki/target-node',
  '发布页链接必须写为无查询参数和锚点的飞书 Wiki URL');
const external = elements.find((element) => element.text_run?.content === '外部资料');
assert(external?.text_run.text_element_style.link.url === 'https://example.com/reference', 'https 外链应保留');
assert(elements.some((element) => /仅在 Git 中可用/.test(element.text_run?.content || '')),
  'Git-only 链接必须降级为明确纯文本');
assert(blocks.some((block) => block.block_type === 14
  && block.code.elements[0].text_run.content.includes('javascript:')), '代码围栏内链接不得解析');

const alternateRegistry = new Map(registry);
alternateRegistry.set('guide/b.md', 'https://qianli-drive.feishu.cn/wiki/other-node');
const alternate = blocksForContent(item, body, { linkScan: scan, registry: alternateRegistry });
assert(blockSignature(blocks[2]) !== blockSignature(alternate[2]), '块签名必须包含链接 URL');

expectFailure(() => scanMarkdownLinks('[危险](javascript:alert(1))', {
  sourcePath, availablePaths, publicationPaths,
}), /只允许 https/);
expectFailure(() => scanMarkdownLinks('[越界](../../outside.md)', {
  sourcePath, availablePaths, publicationPaths,
}), /越出项目根目录/);
expectFailure(() => scanMarkdownLinks('[缺失](./missing.md)', {
  sourcePath, availablePaths, publicationPaths,
}), /目标不存在/);
expectFailure(() => blocksForContent(item, '[未绑定](./b.md)', {
  linkScan: scanMarkdownLinks('[未绑定](./b.md)', { sourcePath, availablePaths, publicationPaths }),
  registry: new Map(),
}), /尚未绑定/);

console.log(JSON.stringify({
  result: 'passed',
  cases: [
    'published_wiki_link', 'anchor_degrades_to_page', 'https_external_link',
    'git_only_plain_text', 'code_fence_ignored', 'url_in_block_signature',
    'dangerous_protocol_denied', 'traversal_denied', 'missing_target_denied',
    'unbound_published_target_denied',
  ],
  network: 'none',
}, null, 2));
