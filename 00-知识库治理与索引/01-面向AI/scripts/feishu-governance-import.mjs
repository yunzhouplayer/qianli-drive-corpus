#!/usr/bin/env node

// 用途：按显式发布清单首次创建公司知识正文种子和业务目录，并核验受控飞书测试子树。
// 边界：未登记文件默认拒绝；正文移交飞书后不由 Git 覆盖；不删除或移动节点，不开启生产索引。
// 凭证：默认从 macOS 钥匙串读取，不从命令行或仓库文件读取 App Secret。

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaffdf087c789bda';
const API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
const TEST_MODE = process.env.FEISHU_IMPORT_TEST_MODE === '1';
const MANAGED_ROOT_TITLE = 'qianli-drive-Corpus';
const MARKER_PREFIX = 'QIANLI-CORPUS-MANAGED/v1 ';
const DEFAULT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-import-state.json';
const DEFAULT_RENAME_MAP_RELATIVE = '00-知识库治理与索引/01-面向AI/09-feishu-import-path-renames.json';
const DEFAULT_PUBLICATION_MANIFEST_RELATIVE = '00-知识库治理与索引/01-面向AI/10-feishu-publication-manifest.json';
const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.yaml', '.yml', '.json', '.rb', '.mjs', '.js', '.txt']);
const EXCLUDED_DIRECTORIES = new Set(['.git', '.obsidian', '.runtime', 'node_modules']);
const EXCLUDED_FILES = new Set(['.DS_Store', '.gitkeep']);
const SECRET_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);
const SECRET_PATTERNS = [
  { id: 'PRIVATE_KEY', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'FEISHU_ACCESS_TOKEN', regex: /\b[tu]-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'ASSIGNED_SECRET', regex: /(?:app_secret|client_secret|api_key|access_token|tenant_access_token)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i },
];

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

function normalizeRelative(path) {
  return path.split(sep).join('/');
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
  if (document.schema_version !== '1.0' || !Array.isArray(document.migrations)) {
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
  if (document.schema_version !== '1.0' || document.default_action !== 'deny') {
    fail('飞书正文发布清单必须使用 schema_version=1.0 和 default_action=deny。', 3);
  }
  if (typeof document.description_cn !== 'string' || !document.description_cn.trim()) {
    fail('飞书正文发布清单缺少中文说明 description_cn。', 3);
  }
  return {
    path: resolve(manifestPath),
    defaultAction: document.default_action,
    files: uniquePublicationPaths(document.files, 'files'),
    directoryRoots: uniquePublicationPaths(document.directory_roots, 'directory_roots'),
  };
}

function shouldExcludeName(name, isDirectory) {
  if (isDirectory) return EXCLUDED_DIRECTORIES.has(name);
  if (EXCLUDED_FILES.has(name)) return true;
  if (name === '.env' || name.startsWith('.env.')) return name !== '.env.example';
  return SECRET_FILE_EXTENSIONS.has(extname(name).toLowerCase());
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

function blocksForContent(item, suppliedBody = null) {
  const blocks = [richTextBlock(2, 'text', markerFor(item))];
  if (item.kind === 'directory') {
    blocks.push(richTextBlock(2, 'text', '此页是由受控导入程序创建的目录节点；目录为空不代表已存在业务知识。'));
    return blocks;
  }
  const body = suppliedBody === null ? readTextFile(item.absolutePath) : String(suppliedBody);
  const extension = extname(item.path).toLowerCase();
  if (extension === '.md' || extension === '.markdown') blocks.push(...markdownBlocks(body, item.path));
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
  for (const item of [root, ...collected]) {
    item.parentPath = item.path === '.' ? null : (normalizeRelative(dirname(item.path)) === '.' ? '.' : normalizeRelative(dirname(item.path)));
    item.hash = item.kind === 'file' ? sha256(item.content) : sha256(`directory:${item.path}`);
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
    },
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
    const secret = process.env.FEISHU_IMPORT_TEST_SECRET;
    const node = process.env.FEISHU_IMPORT_TEST_PARENT_NODE;
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
    this.minimumDelay = Number(process.env.FEISHU_IMPORT_MIN_DELAY_MS ?? (TEST_MODE ? 0 : 650));
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

  async createNode(spaceId, parentNodeToken, title) {
    const data = await this.request('创建知识库节点', `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      method: 'POST',
      body: JSON.stringify({ obj_type: 'docx', node_type: 'origin', parent_node_token: parentNodeToken, title }),
    });
    if (!data.node?.node_token || !data.node?.obj_token || data.node?.obj_type !== 'docx') {
      fail('创建节点响应不是完整的 docx 节点。', 6);
    }
    return data.node;
  }

  async updateNodeTitle(spaceId, nodeToken, title) {
    await this.request('更新知识库节点标题', `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes/${encodeURIComponent(nodeToken)}/update_title`, {
      method: 'POST', body: JSON.stringify({ title }),
    });
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

  async appendBlocks(documentId, blocks) {
    for (let index = 0; index < blocks.length; index += 50) {
      const chunk = blocks.slice(index, index + 50);
      const url = new URL(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, this.baseUrl);
      url.searchParams.set('document_revision_id', '-1');
      url.searchParams.set('client_token', randomUUID());
      await this.request('创建文档块', url, {
        method: 'POST', body: JSON.stringify({ index: -1, children: chunk }),
      });
    }
  }

  async deleteBlockRange(documentId, startIndex, endIndex) {
    const url = new URL(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children/batch_delete`, this.baseUrl);
    url.searchParams.set('document_revision_id', '-1');
    url.searchParams.set('client_token', randomUUID());
    await this.request('删除已验证的旧内容块', url, {
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

function loadState(path) {
  if (!existsSync(path)) return null;
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

function retiredStatePaths(scan, state, migrations = []) {
  if (!state) return [];
  const expected = new Set(scan.items.map((item) => item.path));
  const migratable = new Set(migrations
    .filter((migration) => expected.has(migration.newPath))
    .map((migration) => migration.oldPath));
  return Object.keys(state.nodes).filter((path) => !expected.has(path) && !migratable.has(path));
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
  return `${block.block_type}:${blockContent(block)}`;
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

async function createOrResumeItem(client, item, state, statePath, parentNodeToken) {
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
  if (item.kind === 'file' && record.status === 'complete') {
    const contentResult = await verifyFeishuAuthoritativeContent(client, item, record);
    if (!record.content_authority) {
      record.content_authority = 'feishu';
      state.updated_at = new Date().toISOString();
      saveState(statePath, state);
    }
    return { node_created: nodeCreated, ...contentResult };
  }
  let contentResult;
  if (record.source_hash && record.source_hash !== item.hash) {
    contentResult = await updateContent(client, item, record, state, statePath);
  } else if (record.status === 'update_appending' || record.status === 'update_appended') {
    contentResult = await updateContent(client, item, record, state, statePath);
  } else {
    contentResult = await ensureContent(client, item, { obj_token: record.obj_token }, state, statePath);
  }
  return { node_created: nodeCreated, ...contentResult };
}

async function preflight(scan, options, client, parentNode, migrations) {
  const children = await client.listNodes(parentNode.space_id, parentNode.node_token);
  const existingManaged = children.filter((node) => node.title === MANAGED_ROOT_TITLE);
  const state = loadState(options.statePath);
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
  let state = loadState(options.statePath);
  if (!state) {
    state = {
      schema_version: '1.0', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
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
  let completed = 0;
  for (const item of scan.items) {
    const parentNodeToken = item.path === '.'
      ? parentNode.node_token
      : state.nodes[item.parentPath]?.node_token;
    if (!parentNodeToken) fail(`父节点未就绪：${item.path}`, 8);
    const action = await createOrResumeItem(client, item, state, options.statePath, parentNodeToken);
    if (action.node_created) actions.created_nodes += 1;
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
  const state = loadState(options.statePath);
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
  blockSignature, blocksFor, blocksForContent, loadPublicationManifest, managedMarker, markerFor,
  parseArguments, planSummary, scanProject, scopeDiagnostic,
};

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const scan = scanProject(options.projectRoot, options.publicationManifestPath);
  const migrations = loadRenameMap(options.renameMapPath);
  if (options.mode === 'plan') {
    console.log(JSON.stringify(planSummary(scan)));
    return;
  }
  const config = configuration();
  const parentToken = wikiToken(config.node);
  const accessToken = await authenticate(config.secret);
  config.secret = undefined;
  const client = new FeishuClient(API_BASE, accessToken);
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const report = {
      result: 'failed', error: safe(error.message),
      findings: (error.findings || []).map((finding) => ({ path: finding.path, rule: finding.rule })),
      ...(Number.isInteger(error.retiredManagedNodes)
        ? { retired_managed_nodes: error.retiredManagedNodes } : {}),
    };
    console.log(JSON.stringify(report));
    process.exitCode = error.exitCode || 1;
  });
}
