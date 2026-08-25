#!/usr/bin/env node

// 用途：按显式发布清单发布公司知识正文种子和业务目录，并核验受控飞书测试子树。
// 边界：未登记文件默认拒绝；正文移交飞书后不由 Git 覆盖；不删除或移动节点，不开启生产索引。
// 凭证：默认从 macOS 钥匙串读取，不从命令行或仓库文件读取 App Secret。

import { randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FeishuClient, authenticateTenant, fail, loadFeishuConfiguration, loadPublicationState,
  normalizeRelative, safe, saveStateAtomic, sha256, shortHash, sleep, wikiToken,
} from './lib/feishu-governance-core.mjs';

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaffdf087c789bda';
const API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
const TEST_MODE = process.env.FEISHU_IMPORT_TEST_MODE === '1';
const MANAGED_ROOT_TITLE = 'qianli-drive-Corpus';
const MARKER_PREFIX = 'QIANLI-CORPUS-MANAGED/v1 ';
const DEFAULT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-publication-state.json';
const LEGACY_STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-import-state.json';
const DEFAULT_RENAME_MAP_RELATIVE = '00-知识库治理与索引/03-平台运维/01-feishu-publication-path-renames.json';
const DEFAULT_PUBLICATION_MANIFEST_RELATIVE = '00-知识库治理与索引/03-平台运维/02-feishu-publication-manifest.json';
const DEFAULT_WIKI_BASE_URL = process.env.FEISHU_WIKI_BASE_URL || 'https://qianli-drive.feishu.cn';
const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.yaml', '.yml', '.json', '.rb', '.mjs', '.js', '.txt']);
const EXCLUDED_DIRECTORIES = new Set(['.git', '.obsidian', '.runtime', 'node_modules']);
const EXCLUDED_FILES = new Set(['.DS_Store', '.gitkeep']);
const SECRET_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);
const SECRET_PATTERNS = [
  { id: 'PRIVATE_KEY', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'FEISHU_ACCESS_TOKEN', regex: /\b[tu]-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'ASSIGNED_SECRET', regex: /(?:app_secret|client_secret|api_key|access_token|tenant_access_token)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i },
];

function parseArguments(argv) {
  const mode = argv[0] || 'plan';
  if (!['plan', 'diagnose', 'preflight', 'apply', 'verify'].includes(mode)) {
    fail('模式只能是 plan、diagnose、preflight、apply 或 verify。', 2);
  }
  const options = {
    mode, execute: false, projectRoot: DEFAULT_PROJECT_ROOT, statePath: null,
    renameMapPath: null, publicationManifestPath: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--project-root') options.projectRoot = resolve(argv[++index] || '');
    else if (argument === '--state') options.statePath = resolve(argv[++index] || '');
    else if (argument === '--rename-map') options.renameMapPath = resolve(argv[++index] || '');
    else if (argument === '--publication-manifest') options.publicationManifestPath = resolve(argv[++index] || '');
    else fail(`未知参数：${argument}`, 2);
  }
  if (mode === 'apply' && !options.execute) fail('apply 模式必须显式传入 --execute。', 2);
  if (mode !== 'apply' && options.execute) fail('--execute 只能用于 apply 模式。', 2);
  options.statePath ||= join(options.projectRoot, DEFAULT_STATE_RELATIVE);
  const defaultRenameMap = join(options.projectRoot, DEFAULT_RENAME_MAP_RELATIVE);
  options.renameMapPath ||= existsSync(defaultRenameMap) ? defaultRenameMap : null;
  options.publicationManifestPath ||= join(options.projectRoot, DEFAULT_PUBLICATION_MANIFEST_RELATIVE);
  return options;
}

function loadRenameMap(renameMapPath) {
  if (!renameMapPath) return [];
  if (!existsSync(renameMapPath)) fail(`路径迁移清单不存在：${renameMapPath}`, 3);
  let document;
  try { document = JSON.parse(readFileSync(renameMapPath, 'utf8')); }
  catch { fail('路径迁移清单必须是合法 JSON。', 3); }
  if (!['1.0', '2.0'].includes(document.schema_version) || !Array.isArray(document.migrations)) {
    fail('路径迁移清单格式不受支持。', 3);
  }
  const seenOld = new Set();
  const seenNew = new Set();
  return document.migrations.map((migration, index) => {
    const oldPath = normalizeRelative(String(migration.old_path || ''));
    const newPath = normalizeRelative(String(migration.new_path || ''));
    if (!oldPath || !newPath || oldPath === '.' || newPath === '.' || oldPath === newPath) {
      fail(`路径迁移清单第 ${index + 1} 项路径不合法。`, 3);
    }
    if (seenOld.has(oldPath) || seenNew.has(newPath)) fail('路径迁移清单存在重复来源或目标路径。', 3);
    seenOld.add(oldPath);
    seenNew.add(newPath);
    return { oldPath, newPath, reason: String(migration.reason_cn || '') };
  });
}

function publicationPath(value, label) {
  if (typeof value !== 'string') fail(`${label} 必须是字符串路径。`, 3);
  const input = value;
  if (!input || isAbsolute(input) || input.includes('\\')) fail(`${label} 必须是项目内的规范相对路径。`, 3);
  const normalized = normalizeRelative(input);
  const segments = normalized.split('/');
  if (normalized === '.' || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`${label} 必须是项目内的规范相对路径。`, 3);
  }
  return normalized;
}

function uniquePublicationPaths(values, label) {
  if (!Array.isArray(values)) fail(`发布清单 ${label} 必须是数组。`, 3);
  const normalized = values.map((value, index) => publicationPath(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail(`发布清单 ${label} 存在重复路径。`, 3);
  return normalized;
}

function loadPublicationManifest(manifestPath) {
  if (!existsSync(manifestPath)) fail(`飞书正文发布清单不存在：${manifestPath}`, 3);
  let document;
  try { document = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { fail('飞书正文发布清单必须是合法 JSON。', 3); }
  if (!['1.0', '2.0'].includes(document.schema_version) || document.default_action !== 'deny') {
    fail('飞书正文发布清单必须使用受支持的 schema_version 和 default_action=deny。', 3);
  }
  if (typeof document.description_cn !== 'string' || !document.description_cn.trim()) {
    fail('飞书正文发布清单缺少中文说明 description_cn。', 3);
  }
  const rawFiles = document.schema_version === '2.0' ? document.active_files : document.files;
  const legacyRedirects = document.schema_version === '2.0' ? document.legacy_redirects : [];
  if (!Array.isArray(legacyRedirects)) fail('发布清单 legacy_redirects 必须是数组。', 3);
  const normalizedRedirects = legacyRedirects.map((item, index) => {
    if (!item || typeof item !== 'object') fail(`legacy_redirects[${index}] 必须是对象。`, 3);
    const legacyPath = publicationPath(item.legacy_path, `legacy_redirects[${index}].legacy_path`);
    const replacementPath = publicationPath(item.replacement_path, `legacy_redirects[${index}].replacement_path`);
    if (legacyPath === replacementPath) fail('旧页提示来源与替代页面不能相同。', 3);
    return { legacyPath, replacementPath };
  });
  const files = uniquePublicationPaths(rawFiles, document.schema_version === '2.0' ? 'active_files' : 'files');
  const activeSet = new Set(files);
  const legacySet = new Set();
  for (const item of normalizedRedirects) {
    if (legacySet.has(item.legacyPath) || activeSet.has(item.legacyPath)) fail('旧页提示来源重复或仍在活跃发布文件中。', 3);
    if (!activeSet.has(item.replacementPath)) fail(`旧页替代目标不在 active_files：${item.replacementPath}`, 3);
    legacySet.add(item.legacyPath);
  }
  return {
    path: resolve(manifestPath),
    schemaVersion: document.schema_version,
    defaultAction: document.default_action,
    files,
    legacyRedirects: normalizedRedirects,
    directoryRoots: uniquePublicationPaths(document.directory_roots, 'directory_roots'),
  };
}

function shouldExcludeName(name, isDirectory) {
  if (isDirectory) return EXCLUDED_DIRECTORIES.has(name);
  if (EXCLUDED_FILES.has(name)) return true;
  if (name === '.env' || name.startsWith('.env.')) return name !== '.env.example';
  return SECRET_FILE_EXTENSIONS.has(extname(name).toLowerCase());
}

function collectAvailablePaths(projectRoot) {
  const paths = new Set();
  function visit(absoluteDirectory) {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (shouldExcludeName(entry.name, entry.isDirectory())) continue;
      const absolutePath = join(absoluteDirectory, entry.name);
      const relativePath = normalizeRelative(relative(projectRoot, absolutePath));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        paths.add(relativePath);
        visit(absolutePath);
      } else if (entry.isFile()) {
        paths.add(relativePath);
      }
    }
  }
  visit(projectRoot);
  return paths;
}

function readTextFile(path) {
  const buffer = readFileSync(path);
  if (buffer.includes(0)) fail(`不允许导入二进制文件：${path}`, 3);
  return buffer.toString('utf8');
}

function markerFor(item) {
  return `${MARKER_PREFIX}${JSON.stringify({ kind: item.kind, path: item.path, sha256: item.hash })}`;
}

function managedMarker(value) {
  if (!String(value || '').startsWith(MARKER_PREFIX)) return null;
  try {
    const marker = JSON.parse(String(value).slice(MARKER_PREFIX.length));
    if (!['directory', 'file'].includes(marker.kind) || typeof marker.path !== 'string' || typeof marker.sha256 !== 'string') return null;
    return marker;
  } catch {
    return null;
  }
}

function richTextBlock(blockType, property, content, style = {}) {
  return {
    block_type: blockType,
    [property]: {
      elements: [{ text_run: { content, text_element_style: {} } }],
      style,
    },
  };
}

function canonicalProjectPath(value, label = '项目路径') {
  if (typeof value !== 'string' || !value || value.includes('\\') || posix.isAbsolute(value)) {
    fail(`${label} 必须是项目内的规范相对路径。`, 3);
  }
  const normalized = posix.normalize(value).replace(/\/$/, '');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`${label} 越出项目根目录。`, 3);
  }
  return normalized;
}

function canonicalHttpsUrl(value, { wikiOnly = false } = {}) {
  let candidate = String(value || '').trim();
  if (!candidate.includes('://')) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded.includes('://')) candidate = decoded;
    } catch {
      // 后续 URL 校验负责给出统一错误。
    }
  }
  let url;
  try { url = new URL(candidate); }
  catch { fail('链接目标必须是合法 URL。', 3); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail('外部链接只允许不含凭证的 https URL。', 3);
  }
  if (wikiOnly && !/^\/wiki\/[^/]+/.test(url.pathname)) {
    fail('发布目标注册表必须提供飞书 Wiki 页面 URL。', 3);
  }
  if (wikiOnly) {
    url.search = '';
    url.hash = '';
  }
  return url.toString();
}

function canonicalWikiUrl(value) {
  return canonicalHttpsUrl(value, { wikiOnly: true });
}

function normalizedPathSet(values, label) {
  const result = new Set();
  for (const value of values || []) result.add(canonicalProjectPath(String(value), label));
  return result;
}

function registryValue(registry, path) {
  if (registry instanceof Map) return registry.get(path);
  if (registry && typeof registry === 'object') return registry[path];
  return undefined;
}

function resolveMarkdownTarget(rawTarget, context) {
  let target = String(rawTarget || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  if (!target || /\s/.test(target)) fail(`Markdown 链接目标不合法：${rawTarget}`, 3);
  if (target.startsWith('//')) fail('外部链接必须显式使用 https。', 3);
  const scheme = target.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'https') fail('外部链接只允许 https。', 3);
    return { kind: 'external_https', url: canonicalHttpsUrl(target), raw_target: rawTarget };
  }
  if (target.includes('?')) fail('本地 Markdown 链接不允许查询参数。', 3);

  const hashIndex = target.indexOf('#');
  const rawPath = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const anchor = hashIndex >= 0 ? target.slice(hashIndex + 1) : '';
  if (rawPath.startsWith('/') || rawPath.includes('\\')) fail('本地链接必须使用项目内相对路径。', 3);
  let decodedPath;
  try { decodedPath = decodeURIComponent(rawPath); }
  catch { fail('本地链接路径编码不合法。', 3); }
  const sourcePath = canonicalProjectPath(context.sourcePath, 'Markdown 来源路径');
  const targetPath = rawPath
    ? canonicalProjectPath(posix.join(posix.dirname(sourcePath), decodedPath), 'Markdown 链接目标')
    : sourcePath;
  if (!context.availablePaths.has(targetPath)) fail(`本地链接目标不存在：${targetPath}`, 3);
  return {
    kind: context.publicationPaths.has(targetPath) ? 'published' : 'git_only',
    target_path: targetPath,
    anchor: anchor || null,
    raw_target: rawTarget,
  };
}

function parseInlineMarkdown(text, context) {
  const tokens = [];
  const pattern = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const escaped = match.index > 0 && text[match.index - 1] === '\\';
    const image = match.index > 0 && text[match.index - 1] === '!';
    if (escaped || image) continue;
    if (match.index > cursor) {
      tokens.push({ kind: 'text', content: text.slice(cursor, match.index), start: cursor, end: match.index });
    }
    const resolved = resolveMarkdownTarget(match[2], context);
    tokens.push({
      kind: 'link', label: match[1], start: match.index, end: pattern.lastIndex,
      ...resolved,
    });
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) tokens.push({ kind: 'text', content: text.slice(cursor), start: cursor, end: text.length });
  if (!tokens.length && text) tokens.push({ kind: 'text', content: text, start: 0, end: text.length });
  return tokens;
}

function scanMarkdownLinks(content, {
  sourcePath, availablePaths, publicationPaths,
}) {
  const context = {
    sourcePath: canonicalProjectPath(sourcePath, 'Markdown 来源路径'),
    availablePaths: normalizedPathSet(availablePaths, '可用项目路径'),
    publicationPaths: normalizedPathSet(publicationPaths, '发布目标路径'),
  };
  if (!context.availablePaths.has(context.sourcePath)) {
    fail(`Markdown 来源文件不在可用路径集合中：${context.sourcePath}`, 3);
  }
  const lines = [];
  const links = [];
  let inFence = false;
  const normalized = String(content).replace(/\r\n/g, '\n');
  for (const [lineIndex, raw] of normalized.split('\n').entries()) {
    if (/^\s*```/.test(raw)) {
      lines.push({ kind: 'fence', raw, line_index: lineIndex });
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push({ kind: 'code', raw, line_index: lineIndex });
      continue;
    }
    const tokens = parseInlineMarkdown(raw, context);
    for (const token of tokens) {
      if (token.kind !== 'text') links.push({ ...token, line_index: lineIndex });
    }
    lines.push({ kind: 'markdown', raw, tokens, line_index: lineIndex });
  }
  return { source_path: context.sourcePath, lines, links };
}

function tokensAfterOffset(tokens, offset) {
  const result = [];
  for (const token of tokens) {
    if (token.end <= offset) continue;
    if (token.kind === 'text') {
      const content = token.content.slice(Math.max(0, offset - token.start));
      if (content) result.push({ ...token, content, start: Math.max(token.start, offset) });
    } else if (token.start >= offset) {
      result.push(token);
    } else {
      fail('Markdown 块前缀与内联链接边界重叠。', 3);
    }
  }
  return result;
}

function textRun(content, url = null) {
  const text_element_style = {};
  if (url) text_element_style.link = { url };
  return { text_run: { content, text_element_style } };
}

function elementsForTokens(tokens, registry) {
  return tokens.map((token) => {
    if (token.kind === 'text') return textRun(token.content);
    if (token.kind === 'external_https') return textRun(token.label, token.url);
    if (token.kind === 'git_only') {
      const anchor = token.anchor ? `#${token.anchor}` : '';
      return textRun(`${token.label}（仅在 Git 中可用：${token.target_path}${anchor}）`);
    }
    const registered = registryValue(registry, token.target_path);
    if (!registered) fail(`发布目标尚未绑定 Wiki URL：${token.target_path}`, 3);
    return textRun(token.label, canonicalWikiUrl(registered));
  });
}

function splitElements(elements, maximum = 1800) {
  const groups = [];
  let current = [];
  let length = 0;
  for (const element of elements) {
    let remaining = element.text_run.content;
    while (remaining.length) {
      const capacity = maximum - length;
      if (capacity === 0) {
        groups.push(current);
        current = [];
        length = 0;
        continue;
      }
      const content = remaining.slice(0, capacity);
      current.push({ text_run: { ...element.text_run, content } });
      remaining = remaining.slice(content.length);
      length += content.length;
    }
  }
  if (current.length) groups.push(current);
  return groups.length ? groups : [[]];
}

function richTextBlocksForElements(blockType, property, elements, style = {}) {
  return splitElements(elements).map((group) => ({
    block_type: blockType,
    [property]: { elements: group, style },
  }));
}

function splitText(content, maximum = 1800) {
  if (content.length <= maximum) return [content];
  const chunks = [];
  let remaining = content;
  while (remaining.length > maximum) {
    let boundary = remaining.lastIndexOf('\n', maximum);
    if (boundary < maximum / 2) boundary = remaining.lastIndexOf(' ', maximum);
    if (boundary < maximum / 2) boundary = maximum;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function codeLanguage(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.yaml' || extension === '.yml') return 67;
  if (extension === '.json') return 28;
  if (extension === '.rb') return 52;
  if (extension === '.mjs' || extension === '.js') return 30;
  if (extension === '.md' || extension === '.markdown') return 39;
  return 1;
}

function codeBlocks(content, path) {
  return splitText(content).map((chunk) => richTextBlock(14, 'code', chunk, {
    language: codeLanguage(path), wrap: true,
  }));
}

function markdownBlocksWithLinks(scanned, path, registry) {
  const blocks = [];
  let inFence = false;
  let fenceLines = [];
  for (const line of scanned.lines) {
    if (line.kind === 'fence') {
      if (inFence) {
        blocks.push(...codeBlocks(fenceLines.join('\n'), path));
        fenceLines = [];
      }
      inFence = !inFence;
      continue;
    }
    if (line.kind === 'code') {
      fenceLines.push(line.raw);
      continue;
    }
    if (!line.raw.trim()) continue;
    const heading = line.raw.match(/^(#{1,9})\s+(.+)$/);
    const bullet = line.raw.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.raw.match(/^\s*\d+[.)]\s+(.+)$/);
    const quote = line.raw.match(/^\s*>\s?(.*)$/);
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line.raw)) {
      blocks.push({ block_type: 22, divider: {} });
      continue;
    }
    let blockType = 2;
    let property = 'text';
    let offset = 0;
    if (heading) {
      const level = Math.min(heading[1].length, 9);
      blockType = 2 + level;
      property = `heading${level}`;
      offset = line.raw.indexOf(heading[2]);
    } else if (bullet) {
      blockType = 12;
      property = 'bullet';
      offset = line.raw.indexOf(bullet[1]);
    } else if (ordered) {
      blockType = 13;
      property = 'ordered';
      offset = line.raw.indexOf(ordered[1]);
    } else if (quote) {
      blockType = 15;
      property = 'quote';
      offset = line.raw.indexOf(quote[1]);
    }
    const elements = elementsForTokens(tokensAfterOffset(line.tokens, offset), registry);
    blocks.push(...richTextBlocksForElements(blockType, property, elements));
  }
  if (inFence || fenceLines.length) blocks.push(...codeBlocks(fenceLines.join('\n'), path));
  return blocks;
}

function markdownBlocks(content, path) {
  const blocks = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  let fenceLines = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        blocks.push(...codeBlocks(fenceLines.join('\n'), path));
        fenceLines = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,9})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ block_type: 22, divider: {} });
    } else if (heading) {
      const level = Math.min(heading[1].length, 9);
      for (const chunk of splitText(heading[2])) blocks.push(richTextBlock(2 + level, `heading${level}`, chunk));
    } else if (bullet) {
      for (const chunk of splitText(bullet[1])) blocks.push(richTextBlock(12, 'bullet', chunk));
    } else if (ordered) {
      for (const chunk of splitText(ordered[1])) blocks.push(richTextBlock(13, 'ordered', chunk));
    } else if (quote) {
      for (const chunk of splitText(quote[1])) blocks.push(richTextBlock(15, 'quote', chunk));
    } else {
      for (const chunk of splitText(line)) blocks.push(richTextBlock(2, 'text', chunk));
    }
  }
  if (inFence || fenceLines.length) blocks.push(...codeBlocks(fenceLines.join('\n'), path));
  return blocks;
}

function blocksForContent(item, suppliedBody = null, renderOptions = null) {
  const blocks = [richTextBlock(2, 'text', markerFor(item))];
  if (item.kind === 'directory') {
    blocks.push(richTextBlock(2, 'text', '此页是由受控导入程序创建的目录节点；目录为空不代表已存在业务知识。'));
    return blocks;
  }
  const body = suppliedBody === null ? readTextFile(item.absolutePath) : String(suppliedBody);
  const extension = extname(item.path).toLowerCase();
  if ((extension === '.md' || extension === '.markdown') && renderOptions?.linkScan) {
    blocks.push(...markdownBlocksWithLinks(renderOptions.linkScan, item.path, renderOptions.registry));
  } else if (extension === '.md' || extension === '.markdown') {
    blocks.push(...markdownBlocks(body, item.path));
  }
  else blocks.push(...codeBlocks(body, item.path));
  return blocks;
}

function blocksFor(item) {
  return blocksForContent(item);
}

function scanProject(projectRoot, publicationManifestPath = join(projectRoot, DEFAULT_PUBLICATION_MANIFEST_RELATIVE)) {
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) fail('项目根目录不存在。', 3);
  const manifest = loadPublicationManifest(publicationManifestPath);
  const directories = new Map();
  const files = new Map();
  const findings = [];

  function absoluteProjectPath(relativePath) {
    const absolutePath = resolve(projectRoot, relativePath);
    const fromRoot = relative(projectRoot, absolutePath);
    if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      fail(`发布清单路径越出项目根目录：${relativePath}`, 3);
    }
    return absolutePath;
  }

  function registerDirectory(relativePath) {
    if (relativePath === '.') return;
    const absolutePath = absoluteProjectPath(relativePath);
    if (!existsSync(absolutePath)) fail(`发布清单目录不存在：${relativePath}`, 3);
    const entry = lstatSync(absolutePath);
    if (entry.isSymbolicLink()) fail(`不允许导入符号链接：${relativePath}`, 3);
    if (!entry.isDirectory()) fail(`发布清单目录不是普通目录：${relativePath}`, 3);
    directories.set(relativePath, {
      kind: 'directory', path: relativePath, absolutePath, title: basename(relativePath),
    });
    const parent = normalizeRelative(dirname(relativePath));
    if (parent !== '.') registerDirectory(parent);
  }

  function walkDirectories(absoluteDirectory) {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    for (const entry of entries) {
      const absolutePath = join(absoluteDirectory, entry.name);
      const relativePath = normalizeRelative(relative(projectRoot, absolutePath));
      if (entry.isSymbolicLink()) fail(`不允许导入符号链接：${relativePath}`, 3);
      if (!entry.isDirectory() || shouldExcludeName(entry.name, true)) continue;
      registerDirectory(relativePath);
      walkDirectories(absolutePath);
    }
  }

  for (const directoryRoot of manifest.directoryRoots) {
    registerDirectory(directoryRoot);
    walkDirectories(absoluteProjectPath(directoryRoot));
  }

  for (const filePath of manifest.files) {
    const absolutePath = absoluteProjectPath(filePath);
    if (!existsSync(absolutePath)) fail(`发布清单文件不存在：${filePath}`, 3);
    const entry = lstatSync(absolutePath);
    if (entry.isSymbolicLink()) fail(`不允许导入符号链接：${filePath}`, 3);
    if (!entry.isFile()) fail(`发布清单路径不是普通文件：${filePath}`, 3);
    const extension = extname(filePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) fail(`发布清单包含不支持的文件类型：${filePath}`, 3);
    const content = readTextFile(absolutePath);
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(content)) findings.push({ path: filePath, rule: pattern.id });
    }
    registerDirectory(normalizeRelative(dirname(filePath)));
    files.set(filePath, {
      kind: 'file', path: filePath, absolutePath, title: basename(filePath), content,
    });
  }

  if (findings.length) {
    const error = new Error('敏感信息门禁未通过。');
    error.exitCode = 4;
    error.findings = findings;
    throw error;
  }

  const root = {
    kind: 'directory', path: '.', absolutePath: projectRoot, title: MANAGED_ROOT_TITLE,
  };
  const collected = [...directories.values(), ...files.values()];
  const availablePaths = collectAvailablePaths(projectRoot);
  const publicationPaths = new Set(manifest.files);
  for (const item of [root, ...collected]) {
    item.parentPath = item.path === '.' ? null : (normalizeRelative(dirname(item.path)) === '.' ? '.' : normalizeRelative(dirname(item.path)));
    item.hash = item.kind === 'file' ? sha256(item.content) : sha256(`directory:${item.path}`);
    if (item.kind === 'file' && ['.md', '.markdown'].includes(extname(item.path).toLowerCase())) {
      item.linkScan = scanMarkdownLinks(item.content, {
        sourcePath: item.path, availablePaths, publicationPaths,
      });
    }
    item.blocks = blocksFor(item);
    delete item.content;
  }
  const ordered = [root, ...collected].sort((left, right) => {
    const depth = left.path === '.' ? -1 : left.path.split('/').length;
    const otherDepth = right.path === '.' ? -1 : right.path.split('/').length;
    if (depth !== otherDepth) return depth - otherDepth;
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.path.localeCompare(right.path, 'zh-CN');
  });
  const manifestRelative = normalizeRelative(relative(projectRoot, manifest.path));
  return {
    items: ordered,
    findings: [],
    publication: {
      manifest_path: isAbsolute(manifestRelative) || manifestRelative.startsWith('../')
        ? basename(manifest.path) : manifestRelative,
      default_action: manifest.defaultAction,
      declared_files: manifest.files.length,
      directory_roots: manifest.directoryRoots.length,
      legacy_redirects: manifest.legacyRedirects,
    },
    availablePaths,
  };
}

function planSummary(scan) {
  return {
    result: 'passed', mode: 'plan', managed_root_title: MANAGED_ROOT_TITLE,
    directories: scan.items.filter((item) => item.kind === 'directory').length,
    files: scan.items.filter((item) => item.kind === 'file').length,
    blocks: scan.items.reduce((sum, item) => sum + item.blocks.length, 0),
    bytes: scan.items.filter((item) => item.kind === 'file').reduce((sum, item) => sum + statSync(item.absolutePath).size, 0),
    publication_manifest: scan.publication.manifest_path,
    default_action: scan.publication.default_action,
    declared_files: scan.publication.declared_files,
    directory_roots: scan.publication.directory_roots,
    excluded_placeholders: '.gitkeep', secret_gate_passed: true,
  };
}

function configuration() {
  return loadFeishuConfiguration({
    appId: APP_ID,
    apiBase: API_BASE,
    testMode: TEST_MODE,
    testSecretEnv: 'FEISHU_IMPORT_TEST_SECRET',
    testNodeEnv: 'FEISHU_IMPORT_TEST_PARENT_NODE',
  });
}

class PublisherClient extends FeishuClient {
  async requestWrite(label, pathOrUrl, options = {}, attempt = 0) {
    await this.waitForRateLimit();
    const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, this.baseUrl);
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
    try { body = JSON.parse(raw); } catch { fail(`${label} 返回非 JSON 响应。`, 6); }
    const limited = response.status === 429 || body?.code === 99991400;
    if (limited && attempt < 5) {
      await sleep((2 ** attempt) * 500 + Math.floor(Math.random() * 200));
      return this.requestWrite(label, url, options, attempt + 1);
    }
    if (!response.ok || body?.code !== 0) {
      fail(`${label} 失败：http=${response.status}, code=${body?.code ?? 'unknown'}, msg=${safe(body?.msg)}`, 6);
    }
    return body.data || {};
  }

  async createNode(spaceId, parentNodeToken, title) {
    const data = await this.requestWrite('创建知识库节点', `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      method: 'POST',
      body: JSON.stringify({ obj_type: 'docx', node_type: 'origin', parent_node_token: parentNodeToken, title }),
    });
    if (!data.node?.node_token || !data.node?.obj_token || data.node?.obj_type !== 'docx') {
      fail('创建节点响应不是完整的 docx 节点。', 6);
    }
    return data.node;
  }

  async updateNodeTitle(spaceId, nodeToken, title) {
    await this.requestWrite('更新知识库节点标题', `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes/${encodeURIComponent(nodeToken)}/update_title`, {
      method: 'POST', body: JSON.stringify({ title }),
    });
  }

  async appendBlocks(documentId, blocks) {
    for (let index = 0; index < blocks.length; index += 50) {
      const chunk = blocks.slice(index, index + 50);
      const url = new URL(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, this.baseUrl);
      url.searchParams.set('document_revision_id', '-1');
      url.searchParams.set('client_token', randomUUID());
      await this.requestWrite('创建文档块', url, {
        method: 'POST', body: JSON.stringify({ index: -1, children: chunk }),
      });
    }
  }

  async deleteBlockRange(documentId, startIndex, endIndex) {
    const url = new URL(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children/batch_delete`, this.baseUrl);
    url.searchParams.set('document_revision_id', '-1');
    url.searchParams.set('client_token', randomUUID());
    await this.requestWrite('删除已验证的旧内容块', url, {
      method: 'DELETE', body: JSON.stringify({ start_index: startIndex, end_index: endIndex }),
    });
  }
}

const MODE_SCOPE_REQUIREMENTS = {
  diagnose: [],
  preflight: [
    { capability: 'read_node', any_of: ['wiki:node:read', 'wiki:wiki:readonly', 'wiki:wiki'] },
    { capability: 'list_children', any_of: ['wiki:node:retrieve', 'wiki:wiki:readonly', 'wiki:wiki'] },
  ],
  apply: [
    { capability: 'read_node', any_of: ['wiki:node:read', 'wiki:wiki:readonly', 'wiki:wiki'] },
    { capability: 'list_children', any_of: ['wiki:node:retrieve', 'wiki:wiki:readonly', 'wiki:wiki'] },
    { capability: 'create_node', any_of: ['wiki:node:create', 'wiki:wiki'] },
    { capability: 'rename_node', any_of: ['wiki:node:update', 'wiki:wiki'] },
    { capability: 'read_docx', any_of: ['docx:document:readonly', 'docx:document'] },
    { capability: 'edit_docx', any_of: ['docx:document:write_only', 'docx:document'] },
  ],
  verify: [
    { capability: 'read_node', any_of: ['wiki:node:read', 'wiki:wiki:readonly', 'wiki:wiki'] },
    { capability: 'list_children', any_of: ['wiki:node:retrieve', 'wiki:wiki:readonly', 'wiki:wiki'] },
    { capability: 'read_docx', any_of: ['docx:document:readonly', 'docx:document'] },
  ],
};

function scopeDiagnostic(scopes, mode) {
  const granted = scopes.filter((scope) => scope.grant_status === 1);
  const tenant = new Set(granted.filter((scope) => scope.scope_type === 'tenant').map((scope) => scope.scope_name));
  const user = new Set(granted.filter((scope) => scope.scope_type === 'user').map((scope) => scope.scope_name));
  const requirements = MODE_SCOPE_REQUIREMENTS[mode] || [];
  const checks = requirements.map((requirement) => {
    const tenantMatches = requirement.any_of.filter((scope) => tenant.has(scope));
    const userMatches = requirement.any_of.filter((scope) => user.has(scope));
    return {
      capability: requirement.capability,
      status: tenantMatches.length ? 'pass' : (userMatches.length ? 'wrong_identity' : 'missing'),
      accepted_scopes: requirement.any_of,
      tenant_matches: tenantMatches,
      user_matches: userMatches,
    };
  });
  return {
    credential_type: 'tenant_access_token',
    required_identity: 'tenant',
    mode,
    checks,
    passed: checks.every((check) => check.status === 'pass'),
  };
}

async function diagnoseScopes(client, mode = 'apply') {
  const diagnostic = scopeDiagnostic(await client.listGrantedScopes(), mode);
  return {
    result: diagnostic.passed ? 'ready' : 'blocked',
    mode: 'diagnose',
    target_mode: mode,
    ...diagnostic,
    write_request_sent: false,
  };
}

function loadState(path, projectRoot, required = false) {
  const defaultState = resolve(path) === resolve(projectRoot, DEFAULT_STATE_RELATIVE);
  return loadPublicationState({
    statePath: path,
    legacyStatePath: defaultState ? join(projectRoot, LEGACY_STATE_RELATIVE) : null,
    required,
  });
}

function saveState(path, state) {
  saveStateAtomic(path, state);
}

function retiredStatePaths(scan, state, migrations = []) {
  if (!state) return [];
  const expected = new Set(scan.items.map((item) => item.path));
  const migratable = new Set(migrations
    .filter((migration) => expected.has(migration.newPath))
    .map((migration) => migration.oldPath));
  const legacyRedirects = new Set((scan.publication.legacy_redirects || [])
    .filter((redirect) => expected.has(redirect.replacementPath))
    .map((redirect) => redirect.legacyPath));
  return Object.keys(state.nodes).filter((path) => (
    !expected.has(path) && !migratable.has(path) && !legacyRedirects.has(path)
  ));
}

function blockRetiredState(scan, state, migrations = []) {
  const retired = retiredStatePaths(scan, state, migrations);
  if (!retired.length) return;
  const error = new Error(`旧导入状态包含 ${retired.length} 个超出正文发布范围的受控节点；在单独清理飞书测试树前禁止继续写入或核验。`);
  error.exitCode = 8;
  error.retiredManagedNodes = retired.length;
  throw error;
}

function blockContent(block) {
  const property = {
    2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
    8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9', 12: 'bullet', 13: 'ordered',
    14: 'code', 15: 'quote',
  }[block.block_type];
  if (block.block_type === 22) return '';
  return (block[property]?.elements || []).map((element) => element.text_run?.content || '').join('');
}

function blockSignature(block) {
  const property = {
    2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
    8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9', 12: 'bullet', 13: 'ordered',
    14: 'code', 15: 'quote',
  }[block.block_type];
  const elements = property ? (block[property]?.elements || []) : [];
  const content = elements.map((element) => {
    const text = element.text_run?.content || '';
    const url = element.text_run?.text_element_style?.link?.url || '';
    return `${text}\u0000${url}`;
  }).join('\u0001');
  return `${block.block_type}:${content}`;
}

function resolvedLinksDigest(item, registry) {
  const resolved = (item.linkScan?.links || []).map((link) => {
    if (link.kind === 'external_https') return `${link.kind}:${link.url}`;
    if (link.kind === 'git_only') return `${link.kind}:${link.target_path}#${link.anchor || ''}`;
    const url = registryValue(registry, link.target_path);
    if (!url) fail(`发布目标尚未绑定 Wiki URL：${link.target_path}`, 3);
    return `${link.kind}:${canonicalWikiUrl(url)}`;
  });
  return sha256(resolved.join('\n'));
}

async function ensureContent(client, item, node, state, statePath) {
  const remoteBlocks = await client.listDocumentChildren(node.obj_token);
  const expected = item.blocks.map(blockSignature);
  const actual = remoteBlocks.map(blockSignature);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) fail(`已创建页面内容与预期前缀不一致：${item.path}`, 8);
  }
  const contentInitialized = actual.length < expected.length;
  if (contentInitialized) {
    await client.appendBlocks(node.obj_token, item.blocks.slice(actual.length));
  }
  const verified = (await client.listDocumentChildren(node.obj_token)).map(blockSignature);
  if (JSON.stringify(verified) !== JSON.stringify(expected)) fail(`页面写入后读回校验失败：${item.path}`, 8);
  state.nodes[item.path].status = 'complete';
  state.nodes[item.path].source_hash = item.hash;
  state.nodes[item.path].block_count = item.blocks.length;
  state.nodes[item.path].block_signature_sha256 = sha256(expected.join('\n'));
  state.nodes[item.path].resolved_links_sha256 = item.resolvedLinksHash || sha256('');
  state.nodes[item.path].content_authority = item.kind === 'file' ? 'feishu' : 'git_structure';
  state.updated_at = new Date().toISOString();
  saveState(statePath, state);
  return { content_action: contentInitialized ? 'initialized' : 'unchanged', deleted_block_range: false };
}

async function verifyFeishuAuthoritativeContent(client, item, record) {
  if (record.status !== 'complete') fail(`飞书权威页面状态未完成：${item.path}`, 8);
  const remoteBlocks = await client.listDocumentChildren(record.obj_token);
  const marker = managedMarker(blockContent(remoteBlocks[0]));
  if (!marker || marker.kind !== item.kind || marker.path !== item.path) {
    fail(`飞书权威页面缺少匹配的受控来源标记：${item.path}`, 8);
  }
  return { content_action: 'feishu_authoritative', deleted_block_range: false };
}

async function updateContent(client, item, record, state, statePath) {
  const expected = item.blocks.map(blockSignature);
  const oldMarker = markerFor({
    kind: item.kind, path: record.pending_previous_path || item.path, hash: record.source_hash,
  });
  const oldCount = record.block_count;
  if (!Number.isInteger(oldCount) || oldCount < 1) fail(`本地状态缺少旧块数，不允许更新：${item.path}`, 8);

  record.pending_source_hash = item.hash;
  record.pending_block_count = item.blocks.length;
  record.status = 'update_appending';
  state.updated_at = new Date().toISOString();
  saveState(statePath, state);

  let remoteBlocks = await client.listDocumentChildren(record.obj_token);
  let remote = remoteBlocks.map(blockSignature);

  // 如果上次在删除旧块后中断，直接接管已完成的新版本。
  if (JSON.stringify(remote) === JSON.stringify(expected)) {
    record.status = 'complete';
    record.source_hash = item.hash;
    record.block_count = item.blocks.length;
    record.block_signature_sha256 = sha256(expected.join('\n'));
    record.resolved_links_sha256 = item.resolvedLinksHash || sha256('');
    record.content_authority = item.kind === 'file' ? 'feishu' : 'git_structure';
    delete record.pending_source_hash;
    delete record.pending_block_count;
    delete record.pending_previous_path;
    state.updated_at = new Date().toISOString();
    saveState(statePath, state);
    return { content_action: 'recovered_update', deleted_block_range: false };
  }

  if (remote.length < oldCount || blockContent(remoteBlocks[0]) !== oldMarker) {
    fail(`旧版本受控标记或块数不一致，拒绝更新：${item.path}`, 8);
  }
  const appended = remote.slice(oldCount);
  for (let index = 0; index < appended.length; index += 1) {
    if (appended[index] !== expected[index]) fail(`新版本追加前缀不一致：${item.path}`, 8);
  }
  if (appended.length > expected.length) fail(`新版本追加块数超出计划：${item.path}`, 8);
  if (appended.length < expected.length) {
    await client.appendBlocks(record.obj_token, item.blocks.slice(appended.length));
  }

  remoteBlocks = await client.listDocumentChildren(record.obj_token);
  remote = remoteBlocks.map(blockSignature);
  if (remote.length !== oldCount + expected.length
      || JSON.stringify(remote.slice(oldCount)) !== JSON.stringify(expected)
      || blockContent(remoteBlocks[0]) !== oldMarker) {
    fail(`新版本追加后读回校验失败：${item.path}`, 8);
  }

  record.status = 'update_appended';
  state.updated_at = new Date().toISOString();
  saveState(statePath, state);
  await client.deleteBlockRange(record.obj_token, 0, oldCount);

  const final = (await client.listDocumentChildren(record.obj_token)).map(blockSignature);
  if (JSON.stringify(final) !== JSON.stringify(expected)) fail(`旧块删除后新版本校验失败：${item.path}`, 8);
  record.status = 'complete';
  record.source_hash = item.hash;
  record.block_count = item.blocks.length;
  record.block_signature_sha256 = sha256(expected.join('\n'));
  record.resolved_links_sha256 = item.resolvedLinksHash || sha256('');
  record.content_authority = item.kind === 'file' ? 'feishu' : 'git_structure';
  delete record.pending_source_hash;
  delete record.pending_block_count;
  delete record.pending_previous_path;
  state.updated_at = new Date().toISOString();
  saveState(statePath, state);
  return { content_action: 'updated', deleted_block_range: true };
}

async function recoverPending(client, state, statePath) {
  const pending = state.pending;
  if (!pending) return { recovered_pending_nodes: 0, created_nodes: 0 };
  const matches = (await client.listNodes(state.space_id, pending.parent_node_token))
    .filter((node) => node.title === pending.title && node.obj_type === 'docx');
  if (matches.length > 1) fail(`待恢复节点出现多个同名项：${pending.path}`, 8);
  let node = matches[0];
  const created = !node;
  if (created) node = await client.createNode(state.space_id, pending.parent_node_token, pending.title);
  state.nodes[pending.path] = {
    kind: pending.kind, title: pending.title, parent_path: pending.parent_path,
    node_token: node.node_token, obj_token: node.obj_token, status: 'node_created',
  };
  delete state.pending;
  state.updated_at = new Date().toISOString();
  saveState(statePath, state);
  return { recovered_pending_nodes: 1, created_nodes: created ? 1 : 0 };
}

async function migrateRenamedPaths(client, scan, state, statePath, migrations) {
  const scanByPath = new Map(scan.items.map((item) => [item.path, item]));
  let renamedNodes = 0;
  for (const migration of migrations) {
    const oldRecord = state.nodes[migration.oldPath];
    const newRecord = state.nodes[migration.newPath];
    if (!oldRecord) continue;
    if (newRecord) fail(`路径迁移目标已存在受控状态：${migration.newPath}`, 8);
    if (scanByPath.has(migration.oldPath)) fail(`路径迁移来源仍存在于本地计划：${migration.oldPath}`, 8);
    const newItem = scanByPath.get(migration.newPath);
    if (!newItem) fail(`路径迁移目标不在本地计划：${migration.newPath}`, 8);
    if (oldRecord.kind !== newItem.kind) fail(`路径迁移前后节点类型不一致：${migration.newPath}`, 8);
    if (oldRecord.kind === 'file') {
      fail(`飞书权威正文改名必须通过文档治理流程执行，导入器只允许目录结构改名：${migration.oldPath}`, 8);
    }
    if (normalizeRelative(dirname(migration.oldPath)) !== newItem.parentPath) {
      fail(`当前仅支持同一父目录下改名：${migration.oldPath}`, 8);
    }
    const parentRecord = state.nodes[newItem.parentPath];
    if (!parentRecord) fail(`路径迁移父节点未就绪：${migration.newPath}`, 8);
    const siblings = await client.listNodes(state.space_id, parentRecord.node_token);
    const controlled = siblings.filter((node) => node.node_token === oldRecord.node_token && node.title === oldRecord.title);
    if (controlled.length !== 1) fail(`待改名节点与远端状态不一致：${migration.oldPath}`, 8);
    const conflicts = siblings.filter((node) => node.node_token !== oldRecord.node_token && node.title === newItem.title);
    if (conflicts.length) fail(`改名目标存在同名远端节点：${migration.newPath}`, 8);
    await client.updateNodeTitle(state.space_id, oldRecord.node_token, newItem.title);
    const verified = (await client.listNodes(state.space_id, parentRecord.node_token))
      .filter((node) => node.node_token === oldRecord.node_token && node.title === newItem.title);
    if (verified.length !== 1) fail(`知识库节点改名后读回校验失败：${migration.newPath}`, 8);
    state.nodes[migration.newPath] = {
      ...oldRecord, title: newItem.title, parent_path: newItem.parentPath,
      pending_previous_path: migration.oldPath,
    };
    delete state.nodes[migration.oldPath];
    state.updated_at = new Date().toISOString();
    saveState(statePath, state);
    renamedNodes += 1;
  }
  return renamedNodes;
}

async function ensureItemNode(client, item, state, statePath, parentNodeToken) {
  let record = state.nodes[item.path];
  let nodeCreated = false;
  if (!record) {
    const conflicts = (await client.listNodes(state.space_id, parentNodeToken))
      .filter((node) => node.title === item.title);
    if (conflicts.length) fail(`发现未受控的同名节点，拒绝接管：${item.path}`, 8);
    state.pending = {
      path: item.path, kind: item.kind, title: item.title, parent_path: item.parentPath,
      parent_node_token: parentNodeToken, started_at: new Date().toISOString(),
    };
    saveState(statePath, state);
    const node = await client.createNode(state.space_id, parentNodeToken, item.title);
    nodeCreated = true;
    record = {
      kind: item.kind, title: item.title, parent_path: item.parentPath,
      node_token: node.node_token, obj_token: node.obj_token, status: 'node_created',
    };
    state.nodes[item.path] = record;
    delete state.pending;
    state.updated_at = new Date().toISOString();
    saveState(statePath, state);
  }
  if (record.kind !== item.kind || record.title !== item.title || record.parent_path !== item.parentPath) {
    fail(`本地状态与当前计划冲突：${item.path}`, 8);
  }
  return { record, node_created: nodeCreated };
}

async function reconcileItemContent(client, item, record, state, statePath) {
  if (item.kind === 'file' && record.status === 'complete') {
    const contentResult = await verifyFeishuAuthoritativeContent(client, item, record);
    if (!record.content_authority) {
      record.content_authority = 'feishu';
      state.updated_at = new Date().toISOString();
      saveState(statePath, state);
    }
    return contentResult;
  }
  let contentResult;
  if (record.source_hash && record.source_hash !== item.hash) {
    contentResult = await updateContent(client, item, record, state, statePath);
  } else if (record.status === 'update_appending' || record.status === 'update_appended') {
    contentResult = await updateContent(client, item, record, state, statePath);
  } else {
    contentResult = await ensureContent(client, item, { obj_token: record.obj_token }, state, statePath);
  }
  return contentResult;
}

async function preflight(scan, options, client, parentNode, migrations) {
  const children = await client.listNodes(parentNode.space_id, parentNode.node_token);
  const existingManaged = children.filter((node) => node.title === MANAGED_ROOT_TITLE);
  const state = loadState(options.statePath, options.projectRoot);
  if (!state && existingManaged.length) fail('授权父节点下已有同名节点，但本地无受控状态，拒绝接管。', 8);
  if (existingManaged.length > 1) fail('授权父节点下存在多个同名受控根节点。', 8);
  blockRetiredState(scan, state, migrations);
  return {
    result: 'ready', mode: 'preflight', parent_node_ref: shortHash(parentNode.node_token),
    space_ref: shortHash(parentNode.space_id), sibling_count: children.length,
    managed_root_exists: existingManaged.length === 1, local_plan: planSummary(scan),
    state_present: Boolean(state), retired_managed_nodes: 0, write_request_sent: false,
  };
}

async function applyImport(scan, options, client, parentNode, migrations) {
  let state = loadState(options.statePath, options.projectRoot);
  if (!state) {
    state = {
      schema_version: '1.1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      project_root: options.projectRoot, project_snapshot: sha256(scan.items.map((item) => `${item.path}:${item.hash}`).join('\n')),
      parent_node_ref: shortHash(parentNode.node_token), space_id: parentNode.space_id, nodes: {},
    };
    saveState(options.statePath, state);
  }
  if (state.parent_node_ref !== shortHash(parentNode.node_token) || state.space_id !== parentNode.space_id) {
    fail('本地状态与当前授权节点不匹配。', 8);
  }
  blockRetiredState(scan, state, migrations);
  const renamedNodes = await migrateRenamedPaths(client, scan, state, options.statePath, migrations);
  const recovery = await recoverPending(client, state, options.statePath);
  const actions = {
    created_nodes: recovery.created_nodes,
    renamed_nodes: renamedNodes,
    recovered_pending_nodes: recovery.recovered_pending_nodes,
    content_initialized: 0,
    content_updated: 0,
    content_recovered_updates: 0,
    content_unchanged: 0,
    content_feishu_authoritative: 0,
    deleted_block_ranges: 0,
  };
  for (const item of scan.items) {
    const parentNodeToken = item.path === '.'
      ? parentNode.node_token
      : state.nodes[item.parentPath]?.node_token;
    if (!parentNodeToken) fail(`父节点未就绪：${item.path}`, 8);
    const node = await ensureItemNode(client, item, state, options.statePath, parentNodeToken);
    if (node.node_created) actions.created_nodes += 1;
  }
  const wikiBase = canonicalHttpsUrl(DEFAULT_WIKI_BASE_URL);
  const registry = new Map(scan.items
    .filter((item) => item.kind === 'file')
    .map((item) => [
      item.path,
      canonicalWikiUrl(new URL(`/wiki/${state.nodes[item.path].node_token}`, wikiBase).toString()),
    ]));
  for (const item of scan.items) {
    if (item.linkScan) {
      item.blocks = blocksForContent(item, null, { linkScan: item.linkScan, registry });
      item.resolvedLinksHash = resolvedLinksDigest(item, registry);
    } else {
      item.resolvedLinksHash = sha256('');
    }
  }
  let completed = 0;
  for (const item of scan.items) {
    const record = state.nodes[item.path];
    if (!record) fail(`节点注册阶段未完成：${item.path}`, 8);
    const action = await reconcileItemContent(client, item, record, state, options.statePath);
    if (action.content_action === 'initialized') actions.content_initialized += 1;
    if (action.content_action === 'updated') actions.content_updated += 1;
    if (action.content_action === 'recovered_update') actions.content_recovered_updates += 1;
    if (action.content_action === 'unchanged') actions.content_unchanged += 1;
    if (action.content_action === 'feishu_authoritative') actions.content_feishu_authoritative += 1;
    if (action.deleted_block_range) actions.deleted_block_ranges += 1;
    completed += 1;
    if (completed % 20 === 0) console.error(`progress ${completed}/${scan.items.length}`);
  }
  state.completed_at = new Date().toISOString();
  state.project_snapshot = sha256(scan.items.map((item) => `${item.path}:${item.hash}`).join('\n'));
  saveState(options.statePath, state);
  return {
    result: 'passed', mode: 'apply', processed_nodes: completed, ...actions,
    directories: scan.items.filter((item) => item.kind === 'directory').length,
    files: scan.items.filter((item) => item.kind === 'file').length,
    managed_root_ref: shortHash(state.nodes['.'].node_token), state_gitignored: true,
    delete_node_request_sent: false, production_index_changed: false,
  };
}

async function verifyImport(scan, options, client, parentNode) {
  const state = loadState(options.statePath, options.projectRoot);
  if (!state) fail('缺少本地导入状态，无法执行受控核验。', 8);
  blockRetiredState(scan, state);
  const expectedPaths = new Set(scan.items.map((item) => item.path));
  const statePaths = new Set(Object.keys(state.nodes));
  const missing = [...expectedPaths].filter((path) => !statePaths.has(path));
  if (missing.length) fail(`状态清单与本地计划不一致：missing=${missing.length}, extra=0`, 8);
  let verifiedNodes = 0;
  let feishuAuthoritativeNodes = 0;
  for (const item of scan.items) {
    const record = state.nodes[item.path];
    const feishuAuthoritative = item.kind === 'file' && record.content_authority === 'feishu';
    if (record.status !== 'complete' || (!feishuAuthoritative && record.source_hash !== item.hash)) {
      fail(`状态未完成或受控哈希不匹配：${item.path}`, 8);
    }
    const parentToken = item.path === '.' ? parentNode.node_token : state.nodes[item.parentPath].node_token;
    const remote = (await client.listNodes(state.space_id, parentToken))
      .filter((node) => node.node_token === record.node_token && node.title === item.title && node.obj_type === 'docx');
    if (remote.length !== 1) fail(`飞书父子关系或标题校验失败：${item.path}`, 8);
    const blocks = await client.listDocumentChildren(record.obj_token);
    const marker = managedMarker(blockContent(blocks[0]));
    if (feishuAuthoritative) {
      if (!marker || marker.kind !== item.kind || marker.path !== item.path) {
        fail(`飞书权威页面受控标记不一致：${item.path}`, 8);
      }
      feishuAuthoritativeNodes += 1;
    } else if (blocks.length !== item.blocks.length || blockContent(blocks[0]) !== markerFor(item)) {
      fail(`飞书页面块数或受控标记不一致：${item.path}`, 8);
    }
    verifiedNodes += 1;
    if (verifiedNodes % 20 === 0) console.error(`verify-progress ${verifiedNodes}/${scan.items.length}`);
  }
  return {
    result: 'passed', mode: 'verify', verified_nodes: verifiedNodes,
    feishu_authoritative_nodes: feishuAuthoritativeNodes,
    directories: scan.items.filter((item) => item.kind === 'directory').length,
    files: scan.items.filter((item) => item.kind === 'file').length,
    managed_root_ref: shortHash(state.nodes['.'].node_token), parent_content_modified: false,
    write_request_sent: false, delete_node_request_sent: false, production_index_changed: false,
  };
}

export {
  blockContent, blockSignature, blocksFor, blocksForContent, canonicalWikiUrl, elementsForTokens,
  loadPublicationManifest, loadRenameMap, managedMarker, markerFor, parseArguments, parseInlineMarkdown,
  planSummary, resolveMarkdownTarget, resolvedLinksDigest, runCli, scanMarkdownLinks,
  scanProject, scopeDiagnostic,
};

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const scan = scanProject(options.projectRoot, options.publicationManifestPath);
  const migrations = loadRenameMap(options.renameMapPath);
  if (options.mode === 'plan') {
    console.log(JSON.stringify(planSummary(scan)));
    return;
  }
  const config = configuration();
  const parentToken = wikiToken(config.node);
  const accessToken = await authenticateTenant({ apiBase: API_BASE, appId: APP_ID, secret: config.secret });
  config.secret = undefined;
  const client = new PublisherClient(API_BASE, accessToken, {
    minimumDelay: Number(process.env.FEISHU_IMPORT_MIN_DELAY_MS ?? (TEST_MODE ? 0 : 650)),
  });
  if (options.mode === 'diagnose') {
    const report = await diagnoseScopes(client, 'apply');
    client.token = undefined;
    console.log(JSON.stringify(report));
    if (report.result !== 'ready') process.exitCode = 9;
    return;
  }
  const scopeReport = await diagnoseScopes(client, options.mode);
  if (scopeReport.result !== 'ready') {
    client.token = undefined;
    console.log(JSON.stringify(scopeReport));
    process.exitCode = 9;
    return;
  }
  const parentNode = await client.resolveNode(parentToken);
  let report;
  if (options.mode === 'preflight') report = await preflight(scan, options, client, parentNode, migrations);
  else if (options.mode === 'apply') report = await applyImport(scan, options, client, parentNode, migrations);
  else report = await verifyImport(scan, options, client, parentNode);
  client.token = undefined;
  console.log(JSON.stringify(report));
}

async function runCli(argv = process.argv.slice(2), { deprecatedCommand = null } = {}) {
  if (deprecatedCommand) console.error(`deprecated: ${deprecatedCommand} 已迁移为 feishu-governance-publish.mjs`);
  try {
    await main(argv);
  } catch (error) {
    const report = {
      result: 'failed', error: safe(error.message),
      findings: (error.findings || []).map((finding) => ({ path: finding.path, rule: finding.rule })),
      ...(Number.isInteger(error.retiredManagedNodes)
        ? { retired_managed_nodes: error.retiredManagedNodes } : {}),
    };
    console.log(JSON.stringify(report));
    process.exitCode = error.exitCode || 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runCli();
