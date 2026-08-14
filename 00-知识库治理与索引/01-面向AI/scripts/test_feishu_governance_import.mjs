#!/usr/bin/env node

// 用途：使用本地回环模拟飞书 API，回归验证显式发布、正文权威移交、首次导入、幂等、核验和冲突拒绝。
// 边界：只监听随机回环端口，不访问真实飞书，不读取钥匙串。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { scanProject } from './feishu-governance-import.mjs';

const SCRIPT = resolve(fileURLToPath(new URL('./feishu-governance-import.mjs', import.meta.url)));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try { resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function makeMockServer() {
  const state = {
    sequence: 0,
    nodes: new Map(),
    blocks: new Map(),
    createNodeCalls: 0,
    createBlockCalls: 0,
    deleteBlockCalls: 0,
    updateTitleCalls: 0,
    throttledOnce: false,
    scopeMode: 'ready',
  };
  state.nodes.set('wik-parent', {
    space_id: 'space-test', node_token: 'wik-parent', obj_token: 'doc-parent',
    obj_type: 'docx', parent_node_token: '', title: '授权测试父节点',
  });
  state.blocks.set('doc-parent', []);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal' && request.method === 'POST') {
        const body = await readJson(request);
        assert(body.app_secret === 'test-only', '模拟认证 secret 不匹配');
        respond(response, 200, { code: 0, msg: 'success', tenant_access_token: 'test-token' });
        return;
      }
      if (request.headers.authorization !== 'Bearer test-token') {
        respond(response, 401, { code: 99991663, msg: 'unauthorized' });
        return;
      }
      if (url.pathname === '/open-apis/application/v6/scopes' && request.method === 'GET') {
        const baseScopes = [
          'wiki:node:read', 'wiki:node:update', 'docx:document:readonly', 'docx:document:write_only',
        ].map((scope_name) => ({ grant_status: 1, scope_name, scope_type: 'tenant' }));
        const identity = state.scopeMode === 'wrong_identity' ? 'user' : 'tenant';
        const conditional = ['wiki:node:retrieve', 'wiki:node:create']
          .map((scope_name) => ({ grant_status: 1, scope_name, scope_type: identity }));
        respond(response, 200, { code: 0, msg: 'success', data: { scopes: [...baseScopes, ...conditional] } });
        return;
      }
      if (url.pathname === '/open-apis/wiki/v2/spaces/get_node' && request.method === 'GET') {
        const node = state.nodes.get(url.searchParams.get('token'));
        respond(response, node ? 200 : 400, node ? { code: 0, msg: 'success', data: { node } } : { code: 131005, msg: 'not found' });
        return;
      }
      const wikiTitle = url.pathname.match(/^\/open-apis\/wiki\/v2\/spaces\/([^/]+)\/nodes\/([^/]+)\/update_title$/);
      if (wikiTitle && request.method === 'POST') {
        state.updateTitleCalls += 1;
        const body = await readJson(request);
        const node = state.nodes.get(wikiTitle[2]);
        if (!node) {
          respond(response, 400, { code: 131005, msg: 'not found' });
          return;
        }
        node.title = body.title;
        respond(response, 200, { code: 0, msg: 'success', data: {} });
        return;
      }
      const wikiNodes = url.pathname.match(/^\/open-apis\/wiki\/v2\/spaces\/([^/]+)\/nodes$/);
      if (wikiNodes && request.method === 'GET') {
        const parent = url.searchParams.get('parent_node_token');
        const items = [...state.nodes.values()].filter((node) => node.parent_node_token === parent);
        respond(response, 200, { code: 0, msg: 'success', data: { items, has_more: false } });
        return;
      }
      if (wikiNodes && request.method === 'POST') {
        state.createNodeCalls += 1;
        if (!state.throttledOnce) {
          state.throttledOnce = true;
          respond(response, 400, { code: 99991400, msg: 'rate limited once for retry test' });
          return;
        }
        const body = await readJson(request);
        const number = ++state.sequence;
        const node = {
          space_id: 'space-test', node_token: `wik-${number}`, obj_token: `doc-${number}`,
          obj_type: 'docx', node_type: 'origin', parent_node_token: body.parent_node_token,
          title: body.title, has_child: false,
        };
        state.nodes.set(node.node_token, node);
        state.blocks.set(node.obj_token, []);
        respond(response, 200, { code: 0, msg: 'success', data: { node } });
        return;
      }
      const documentChildren = url.pathname.match(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/children$/);
      if (documentChildren && request.method === 'GET') {
        const items = state.blocks.get(documentChildren[1]) || [];
        respond(response, 200, { code: 0, msg: 'success', data: { items, has_more: false } });
        return;
      }
      if (documentChildren && request.method === 'POST') {
        state.createBlockCalls += 1;
        const body = await readJson(request);
        const documentId = documentChildren[1];
        const existing = state.blocks.get(documentId);
        const created = body.children.map((block, index) => ({
          ...block, block_id: `blk-${documentId}-${existing.length + index + 1}`, parent_id: documentId,
        }));
        existing.push(...created);
        respond(response, 200, { code: 0, msg: 'success', data: { children: created, document_revision_id: existing.length + 1 } });
        return;
      }
      const documentDelete = url.pathname.match(/^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/children\/batch_delete$/);
      if (documentDelete && request.method === 'DELETE') {
        state.deleteBlockCalls += 1;
        const body = await readJson(request);
        const existing = state.blocks.get(documentDelete[1]);
        existing.splice(body.start_index, body.end_index - body.start_index);
        respond(response, 200, { code: 0, msg: 'success', data: { document_revision_id: existing.length + 10 } });
        return;
      }
      respond(response, 404, { code: 404, msg: `unhandled ${request.method} ${url.pathname}` });
    } catch (error) {
      respond(response, 500, { code: 500, msg: error.message });
    }
  });
  return { server, state };
}

function runImporter(argumentsList, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...argumentsList], {
      env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      let report;
      try { report = JSON.parse(lines.at(-1) || '{}'); }
      catch (error) { reject(new Error(`输出不是 JSON：${stdout}\n${stderr}`)); return; }
      resolvePromise({ code, report, stderr });
    });
  });
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'qianli-feishu-import-test-'));
const projectRoot = join(temporaryRoot, 'project');
const statePath = join(temporaryRoot, 'runtime', 'state.json');
const renameMapPath = join(temporaryRoot, 'rename-map.json');
const publicationManifestPath = join(temporaryRoot, 'publication-manifest.json');
mkdirSync(join(projectRoot, '00-empty'), { recursive: true });
mkdirSync(join(projectRoot, '01-content'), { recursive: true });
mkdirSync(join(projectRoot, '01-controls'), { recursive: true });
mkdirSync(join(projectRoot, 'docs'), { recursive: true });
writeFileSync(join(projectRoot, 'README.md'), '# 测试知识树\n\n- 项目一\n- 项目二\n', 'utf8');
writeFileSync(join(projectRoot, '00-empty', '.gitkeep'), '', 'utf8');
writeFileSync(join(projectRoot, '01-content', 'guide.md'), '# 正文指南\n', 'utf8');
writeFileSync(join(projectRoot, '01-content', 'unpublished.md'), '# 未登记正文\n', 'utf8');
writeFileSync(join(projectRoot, '01-controls', 'config.yaml'), '# 中文注释\nenabled: false\n', 'utf8');
writeFileSync(join(projectRoot, '.gitignore'), '.runtime/\n', 'utf8');
writeFileSync(join(projectRoot, 'docs', 'process.md'), 'api_key=abcdefghijklmnop\n', 'utf8');
symlinkSync(join(projectRoot, 'README.md'), join(projectRoot, 'linked.md'));

function writePublicationManifest(path, { files, directoryRoots }) {
  writeFileSync(path, `${JSON.stringify({
    schema_version: '1.0',
    description_cn: '本地回环测试用飞书正文发布清单。',
    default_action: 'deny',
    files,
    directory_roots: directoryRoots,
  }, null, 2)}\n`, 'utf8');
}

writePublicationManifest(publicationManifestPath, {
  files: ['README.md', '01-content/guide.md'],
  directoryRoots: ['00-empty', '01-content'],
});
writeFileSync(renameMapPath, JSON.stringify({
  schema_version: '1.0',
  description_cn: '模拟同一父目录下的受控路径改名。',
  migrations: [{ old_path: '00-empty', new_path: '99-empty', reason_cn: '验证目录改名。' }],
}), 'utf8');

const { server, state } = makeMockServer();
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const address = server.address();
const environment = {
  FEISHU_API_BASE: `http://127.0.0.1:${address.port}`,
  FEISHU_IMPORT_TEST_MODE: '1',
  FEISHU_IMPORT_TEST_SECRET: 'test-only',
  FEISHU_IMPORT_TEST_PARENT_NODE: 'wik-parent',
  FEISHU_IMPORT_MIN_DELAY_MS: '0',
};

try {
  const common = [
    '--project-root', projectRoot,
    '--state', statePath,
    '--rename-map', renameMapPath,
    '--publication-manifest', publicationManifestPath,
  ];
  const plan = await runImporter(['plan', ...common], environment);
  assert(plan.code === 0 && plan.report.directories === 3 && plan.report.files === 2, '计划统计不符合预期');
  assert(plan.report.default_action === 'deny' && plan.report.declared_files === 2, '发布清单默认拒绝策略未生效');
  const localPaths = new Set(scanProject(projectRoot, publicationManifestPath).items.map((item) => item.path));
  assert(localPaths.has('README.md') && localPaths.has('01-content/guide.md'), '已登记正文必须进入计划');
  assert(!localPaths.has('.gitignore') && !localPaths.has('01-controls')
    && !localPaths.has('01-content/unpublished.md') && !localPaths.has('docs/process.md'), '未登记文件或技术目录不得进入计划');

  const duplicateManifestPath = join(temporaryRoot, 'duplicate-manifest.json');
  writePublicationManifest(duplicateManifestPath, {
    files: ['README.md', 'README.md'], directoryRoots: ['00-empty'],
  });
  const duplicateManifest = await runImporter([
    'plan', '--project-root', projectRoot, '--publication-manifest', duplicateManifestPath,
  ], environment);
  assert(duplicateManifest.code === 3 && /重复路径/.test(duplicateManifest.report.error), '重复发布路径必须被拒绝');

  const invalidTypeManifestPath = join(temporaryRoot, 'invalid-type-manifest.json');
  writePublicationManifest(invalidTypeManifestPath, {
    files: [123], directoryRoots: [],
  });
  const invalidTypeManifest = await runImporter([
    'plan', '--project-root', projectRoot, '--publication-manifest', invalidTypeManifestPath,
  ], environment);
  assert(invalidTypeManifest.code === 3 && /字符串路径/.test(invalidTypeManifest.report.error), '非字符串发布路径必须被拒绝');

  const missingManifestPath = join(temporaryRoot, 'missing-file-manifest.json');
  writePublicationManifest(missingManifestPath, {
    files: ['missing.md'], directoryRoots: [],
  });
  const missingManifest = await runImporter([
    'plan', '--project-root', projectRoot, '--publication-manifest', missingManifestPath,
  ], environment);
  assert(missingManifest.code === 3 && /文件不存在/.test(missingManifest.report.error), '缺失发布文件必须被拒绝');

  const traversalManifestPath = join(temporaryRoot, 'traversal-manifest.json');
  writePublicationManifest(traversalManifestPath, {
    files: ['../outside.md'], directoryRoots: [],
  });
  const traversalManifest = await runImporter([
    'plan', '--project-root', projectRoot, '--publication-manifest', traversalManifestPath,
  ], environment);
  assert(traversalManifest.code === 3 && /规范相对路径/.test(traversalManifest.report.error), '越界发布路径必须被拒绝');

  const symlinkManifestPath = join(temporaryRoot, 'symlink-manifest.json');
  writePublicationManifest(symlinkManifestPath, {
    files: ['linked.md'], directoryRoots: [],
  });
  const symlinkManifest = await runImporter([
    'plan', '--project-root', projectRoot, '--publication-manifest', symlinkManifestPath,
  ], environment);
  assert(symlinkManifest.code === 3 && /符号链接/.test(symlinkManifest.report.error), '发布文件符号链接必须被拒绝');

  const secretManifestPath = join(temporaryRoot, 'secret-manifest.json');
  writePublicationManifest(secretManifestPath, {
    files: ['docs/process.md'], directoryRoots: [],
  });
  const secretManifest = await runImporter([
    'plan', '--project-root', projectRoot, '--publication-manifest', secretManifestPath,
  ], environment);
  assert(secretManifest.code === 4 && secretManifest.report.findings.length === 1, '已登记正文中的敏感信息必须触发门禁');

  state.scopeMode = 'wrong_identity';
  const wrongIdentity = await runImporter(['diagnose', ...common], environment);
  assert(wrongIdentity.code === 9 && wrongIdentity.report.result === 'blocked', '用户身份权限不得通过应用身份门禁');
  assert(wrongIdentity.report.checks.filter((check) => check.status === 'wrong_identity').length === 2, '应精确识别两个身份错配权限');
  state.scopeMode = 'ready';
  const diagnosis = await runImporter(['diagnose', ...common], environment);
  assert(diagnosis.code === 0 && diagnosis.report.result === 'ready', '应用身份权限完整时应通过诊断');

  const preflight = await runImporter(['preflight', ...common], environment);
  assert(preflight.code === 0 && preflight.report.write_request_sent === false, '预检应为只读');

  const firstApply = await runImporter(['apply', '--execute', ...common], environment);
  assert(firstApply.code === 0 && firstApply.report.result === 'passed', '首次导入应通过');
  assert(firstApply.report.created_nodes === 5 && firstApply.report.content_initialized === 5, '首次导入动作计数应精确');
  assert(firstApply.report.content_unchanged === 0 && firstApply.report.deleted_block_ranges === 0, '首次导入不应报告幂等或更新动作');
  const firstState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert(firstState.nodes['README.md'].content_authority === 'feishu'
    && firstState.nodes['01-content/guide.md'].content_authority === 'feishu', '正文首次创建后必须移交飞书权威');
  assert(state.throttledOnce && state.createNodeCalls === 6, '应触发一次限流并成功重试');
  assert(state.nodes.size === 6, '父节点加 5 个受控节点数量应正确');

  const retiredStatePath = join(temporaryRoot, 'runtime', 'retired-state.json');
  const retiredState = JSON.parse(JSON.stringify(firstState));
  retiredState.nodes['legacy-process.md'] = {
    kind: 'file', title: 'legacy-process.md', parent_path: '.',
    node_token: 'wik-legacy', obj_token: 'doc-legacy', status: 'complete',
    source_hash: 'legacy', block_count: 1, content_authority: 'feishu',
  };
  writeFileSync(retiredStatePath, `${JSON.stringify(retiredState, null, 2)}\n`, 'utf8');
  const retiredPreflight = await runImporter([
    'preflight', '--project-root', projectRoot, '--state', retiredStatePath,
    '--rename-map', renameMapPath, '--publication-manifest', publicationManifestPath,
  ], environment);
  assert(retiredPreflight.code === 8 && retiredPreflight.report.retired_managed_nodes === 1,
    '旧状态中的超范围节点必须阻塞远端写入');

  const readmeNode = [...state.nodes.values()].find((node) => node.title === 'README.md');
  const manualBlock = {
    block_type: 2,
    text: { elements: [{ text_run: { content: '飞书人工维护内容', text_element_style: {} } }], style: {} },
    block_id: 'blk-manual', parent_id: readmeNode.obj_token,
  };
  state.blocks.get(readmeNode.obj_token).push(manualBlock);
  const readmeBlocksAfterManualEdit = state.blocks.get(readmeNode.obj_token).length;

  const createCallsAfterFirst = state.createNodeCalls;
  renameSync(join(projectRoot, '00-empty'), join(projectRoot, '99-empty'));
  writePublicationManifest(publicationManifestPath, {
    files: ['README.md', '01-content/guide.md'],
    directoryRoots: ['99-empty', '01-content'],
  });
  writeFileSync(join(projectRoot, 'README.md'), '# 测试知识树\n\n- 项目一\n- 项目二\n- 更新项\n', 'utf8');
  const secondApply = await runImporter(['apply', '--execute', ...common], environment);
  assert(secondApply.code === 0 && secondApply.report.result === 'passed', `受控内容更新应通过：${JSON.stringify(secondApply)}`);
  assert(secondApply.report.created_nodes === 0 && secondApply.report.renamed_nodes === 1, '路径迁移应复用并改名原节点');
  assert(secondApply.report.content_updated === 1, '只有改名目录标记允许受控更新');
  assert(secondApply.report.content_feishu_authoritative === 2,
    'Git 种子变化不得覆盖已经移交飞书的正文');
  assert(secondApply.report.content_unchanged === 2 && secondApply.report.deleted_block_ranges === 1, '内容更新动作计数应精确');
  assert(state.blocks.get(readmeNode.obj_token).length === readmeBlocksAfterManualEdit
    && state.blocks.get(readmeNode.obj_token).at(-1).text.elements[0].text_run.content === '飞书人工维护内容',
    '飞书人工维护正文不得被 Git 更新覆盖');
  assert(state.updateTitleCalls === 1, '路径迁移只应更新一次远端标题');
  assert(state.createNodeCalls === createCallsAfterFirst, '内容更新不得创建新节点');
  assert(state.deleteBlockCalls === 1, '目录更新应在新版本读回后只删除一个旧块范围');

  const createCallsAfterUpdate = state.createNodeCalls;
  const idempotentApply = await runImporter(['apply', '--execute', ...common], environment);
  assert(idempotentApply.code === 0 && idempotentApply.report.result === 'passed', '重复执行应幂等通过');
  assert(idempotentApply.report.created_nodes === 0 && idempotentApply.report.renamed_nodes === 0 && idempotentApply.report.content_updated === 0, '幂等执行动作计数必须为零');
  assert(idempotentApply.report.content_unchanged === 3
    && idempotentApply.report.content_feishu_authoritative === 2
    && idempotentApply.report.deleted_block_ranges === 0, '幂等执行只能读取并确认未变化');
  assert(state.createNodeCalls === createCallsAfterUpdate && state.deleteBlockCalls === 1 && state.updateTitleCalls === 1, '幂等执行不得产生新写入');

  const verification = await runImporter(['verify', ...common], environment);
  assert(verification.code === 0 && verification.report.verified_nodes === 5, '应核验全部 5 个受控节点');
  assert(verification.report.feishu_authoritative_nodes === 2, '核验应识别两份飞书权威正文');

  const conflictState = join(temporaryRoot, 'runtime', 'missing-state.json');
  const conflict = await runImporter([
    'preflight', '--project-root', projectRoot, '--state', conflictState,
    '--rename-map', renameMapPath, '--publication-manifest', publicationManifestPath,
  ], environment);
  assert(conflict.code !== 0 && /\u62d2\u7edd\u63a5\u7ba1/.test(conflict.report.error), '无本地状态时应拒绝接管同名根节点');

  console.log(JSON.stringify({
    result: 'passed',
    cases: [
      'publication_manifest_default_deny', 'manifest_path_validation', 'plan_and_secret_gate',
      'read_only_preflight', 'rate_limit_retry', 'first_import', 'retired_state_blocks_writes',
      'scope_identity_mismatch_detected', 'tenant_scope_gate_passed',
      'controlled_path_rename', 'feishu_content_authority_preserved', 'idempotent_resume', 'full_verify',
      'unmanaged_name_conflict_rejected',
    ],
    write_scope: 'loopback_mock_only',
  }, null, 2));
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
