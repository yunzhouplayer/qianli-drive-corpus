#!/usr/bin/env node

// 用途：只读比对飞书现有正文、历史 Git 发布基线和当前治理提案，生成可确认的正文协调计划。
// 边界：只允许 GET；计划仅写入 Git 忽略的 .runtime，发现远端人工改动时拒绝生成可执行计划。
// 凭证：仅从 macOS 钥匙串或回环测试注入读取，不写入计划、日志或仓库。

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  FeishuClient, authenticateTenant, canonicalJson, fail, loadFeishuConfiguration,
  loadPublicationState, normalizeRelative, safe, saveStateAtomic, sha256, shortHash, wikiToken,
} from './lib/feishu-governance-core.mjs';
import { buildReconciliationPlan, normalizedRevision } from './lib/feishu-body-reconciliation.mjs';
import {
  blockContent, blockSignature, blocksForContent, canonicalWikiUrl, loadRenameMap,
  managedMarker, resolvedLinksDigest, scanMarkdownLinks, scanProject, scopeDiagnostic,
} from './feishu-governance-publish.mjs';

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaffdf087c789bda';
const API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
const WIKI_BASE_URL = process.env.FEISHU_WIKI_BASE_URL || 'https://qianli-drive.feishu.cn';
const TEST_MODE = process.env.FEISHU_IMPORT_TEST_MODE === '1';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-publication-state.json';
const LEGACY_STATE_RELATIVE = '00-知识库治理与索引/.runtime/feishu-import-state.json';
const MANIFEST_RELATIVE = '00-知识库治理与索引/03-平台运维/02-feishu-publication-manifest.json';
const RENAME_RELATIVE = '00-知识库治理与索引/03-平台运维/01-feishu-publication-path-renames.json';
const OUTPUT_RELATIVE = '00-知识库治理与索引/.runtime/feishu-body-reconciliation-plan.json';

function parseArguments(argv) {
  const mode = argv[0] || 'plan';
  if (mode !== 'plan') fail('正文协调命令当前只支持只读 plan 模式。', 2);
  const options = { mode, projectRoot: PROJECT_ROOT, acceptLinkOnlyBaseline: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project-root') options.projectRoot = resolve(argv[++index] || '');
    else if (argument === '--state') options.statePath = resolve(argv[++index] || '');
    else if (argument === '--publication-manifest') options.manifestPath = resolve(argv[++index] || '');
    else if (argument === '--rename-map') options.renamePath = resolve(argv[++index] || '');
    else if (argument === '--output') options.outputPath = resolve(argv[++index] || '');
    else if (argument === '--accept-link-only-baseline') options.acceptLinkOnlyBaseline = true;
    else fail(`未知参数：${argument}`, 2);
  }
  options.statePath ||= resolve(options.projectRoot, STATE_RELATIVE);
  options.legacyStatePath = resolve(options.projectRoot, LEGACY_STATE_RELATIVE);
  options.manifestPath ||= resolve(options.projectRoot, MANIFEST_RELATIVE);
  options.renamePath ||= resolve(options.projectRoot, RENAME_RELATIVE);
  options.outputPath ||= resolve(options.projectRoot, OUTPUT_RELATIVE);
  return options;
}

function gitBaseline(projectRoot, path, expectedSha256, runner = spawnSync) {
  const history = runner('git', ['log', '--all', '--format=%H', '--', path], {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024,
  });
  if (history.status !== 0) return null;
  for (const commit of String(history.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const snapshot = runner('git', ['show', `${commit}:${path}`], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
    });
    if (snapshot.status === 0 && sha256(snapshot.stdout) === expectedSha256) {
      return { commit, content: snapshot.stdout };
    }
  }
  return null;
}

function normalizedBlockSignature(block, managedLinkIdentities = new Map()) {
  return blockSignature(block).split('\u0001').map((segment) => {
    const separator = segment.indexOf('\u0000');
    if (separator < 0) return segment;
    const text = segment.slice(0, separator);
    const rawUrl = segment.slice(separator + 1);
    if (!rawUrl) return segment;
    let candidate = rawUrl;
    for (let index = 0; index < 3 && !candidate.includes('://'); index += 1) {
      try {
        const decoded = decodeURIComponent(candidate);
        if (decoded === candidate) break;
        candidate = decoded;
      } catch { return segment; }
    }
    try {
      const url = new URL(candidate);
      const resource = url.pathname.match(/\/(?:wiki|docx)\/([^/?#]+)/)?.[1];
      if (resource && managedLinkIdentities.has(resource)) {
        return `${text}\u0000${managedLinkIdentities.get(resource)}`;
      }
      const normalized = /^\/wiki\/[^/]+/.test(url.pathname)
        ? canonicalWikiUrl(url.toString()) : url.toString();
      return `${text}\u0000${normalized}`;
    } catch {
      return segment;
    }
  }).join('\u0001');
}

function signatureForBlocks(blocks, managedLinkIdentities = new Map()) {
  return sha256(blocks.map((block) => normalizedBlockSignature(block, managedLinkIdentities)).join('\n'));
}

function textSignatureForBlocks(blocks) {
  return sha256(blocks.map(blockContent).join('\n'));
}

function structureSignatureForBlocks(blocks) {
  return sha256(blocks.map((block) => String(block.block_type)).join('\n'));
}

function relativeOutput(projectRoot, path) {
  const value = normalizeRelative(relative(projectRoot, path));
  return value.startsWith('../') ? basename(path) : value;
}

function actionSourceMapping(scan, state, migrations) {
  const files = scan.items.filter((item) => item.kind === 'file');
  const migrationByTarget = new Map(migrations.map((item) => [item.newPath, item.oldPath]));
  const sourceByTarget = new Map();
  for (const item of files) {
    const migrated = migrationByTarget.get(item.path);
    const source = migrated && state.nodes[migrated]?.kind === 'file' ? migrated : item.path;
    if (state.nodes[source]?.kind !== 'file') fail(`当前正文缺少可追溯的飞书来源节点：${item.path}`, 8);
    sourceByTarget.set(item.path, source);
  }
  const plannedSources = new Set(sourceByTarget.values());
  for (const redirect of scan.publication.legacy_redirects) {
    if (state.nodes[redirect.legacyPath]?.kind !== 'file') {
      fail(`旧页提示来源不在飞书发布状态中：${redirect.legacyPath}`, 8);
    }
    plannedSources.add(redirect.legacyPath);
  }
  const stateFiles = Object.entries(state.nodes)
    .filter(([, record]) => record.kind === 'file')
    .map(([path]) => path);
  const unplanned = stateFiles.filter((path) => !plannedSources.has(path));
  const unknown = [...plannedSources].filter((path) => state.nodes[path]?.kind !== 'file');
  if (unplanned.length || unknown.length || plannedSources.size !== stateFiles.length) {
    fail(`正文协调范围与旧发布状态不闭合：unplanned=${unplanned.length}, unknown=${unknown.length}`, 8);
  }
  return sourceByTarget;
}

function redirectProposal(legacyPath, replacementPath, targetUrl, managedLinkIdentities = new Map()) {
  const title = basename(replacementPath).replace(/\.md$/i, '');
  const body = [
    '# 本页已合并',
    '',
    `本页内容已合并至[${title}](${targetUrl})。`,
    '',
    '请通过上方链接访问并维护新页面；本页仅保留兼容提示。',
  ].join('\n');
  const item = { kind: 'file', path: legacyPath, hash: sha256(body) };
  const linkScan = scanMarkdownLinks(body, {
    sourcePath: legacyPath, availablePaths: new Set([legacyPath]), publicationPaths: new Set(),
  });
  const blocks = blocksForContent(item, body, { linkScan, registry: new Map() });
  return {
    git_sha256: item.hash,
    proposal_block_signature_sha256: signatureForBlocks(blocks, managedLinkIdentities),
    resolved_links_sha256: resolvedLinksDigest({ ...item, linkScan }, new Map()),
    blocks,
  };
}

async function readRemotePage({
  client, state, path, appId, spaceId, managedRootToken, projectRoot,
  baselineAvailablePaths, baselinePublicationPaths, baselineRegistry, managedLinkIdentities,
}) {
  const record = state.nodes[path];
  const parent = state.nodes[record.parent_path];
  if (!record?.node_token || !record?.obj_token || !parent?.node_token || !record.source_hash) {
    fail(`旧发布状态缺少页面基线字段：${path}`, 8);
  }
  const baseline = gitBaseline(projectRoot, path, record.source_hash);
  if (!baseline) fail(`Git 历史中找不到与旧发布哈希匹配的正文：${path}`, 8);
  const remoteNode = await client.resolveNode(record.node_token);
  if (remoteNode.node_token !== record.node_token || remoteNode.obj_token !== record.obj_token) {
    fail(`远端节点身份与发布状态不一致：${path}`, 8);
  }
  const metadata = await client.getDocumentMetadata(record.obj_token);
  const revisionId = normalizedRevision(metadata.revision_id, `${path}.revision_id`);
  const blocks = await client.listDocumentChildren(record.obj_token, revisionId);
  if (!blocks.length) fail(`飞书页面没有可核验正文块：${path}`, 8);
  const expectedMarker = managedMarker(blockContent(blocks[0]));
  const markerMatches = expectedMarker?.kind === 'file'
    && expectedMarker.path === path && expectedMarker.sha256 === record.source_hash;
  const baselineItem = { kind: 'file', path, hash: record.source_hash };
  const baselineBlocks = blocksForContent(baselineItem, baseline.content);
  const remoteSignature = signatureForBlocks(blocks, managedLinkIdentities);
  const baselineSignatures = [{
    mode: 'plain_markdown', digest: signatureForBlocks(baselineBlocks, managedLinkIdentities),
    text_digest: textSignatureForBlocks(baselineBlocks), block_count: baselineBlocks.length,
    structure_digest: structureSignatureForBlocks(baselineBlocks),
  }];
  if (/\.md$/i.test(path)) {
    try {
      const baselineLinkScan = scanMarkdownLinks(baseline.content, {
        sourcePath: path,
        availablePaths: baselineAvailablePaths,
        publicationPaths: baselinePublicationPaths,
      });
      const linkedBlocks = blocksForContent(baselineItem, baseline.content, {
        linkScan: baselineLinkScan, registry: baselineRegistry,
      });
      baselineSignatures.push({
        mode: 'resolved_links', digest: signatureForBlocks(linkedBlocks, managedLinkIdentities),
        text_digest: textSignatureForBlocks(linkedBlocks), block_count: linkedBlocks.length,
        structure_digest: structureSignatureForBlocks(linkedBlocks),
      });
    } catch {
      // 历史 Markdown 引用了现已不存在的 Git-only 路径时，仍保留原始纯文本基线候选。
    }
  }
  const matchedBaseline = baselineSignatures.find((candidate) => candidate.digest === remoteSignature);
  const remoteTextSignature = textSignatureForBlocks(blocks);
  const matchedTextBaseline = baselineSignatures.find((candidate) => candidate.text_digest === remoteTextSignature);
  const remoteStructureSignature = structureSignatureForBlocks(blocks);
  const structureMatches = baselineSignatures
    .some((candidate) => candidate.structure_digest === remoteStructureSignature);
  const title = remoteNode.title || metadata.title;
  if (typeof title !== 'string' || !title) fail(`飞书页面缺少可核验标题：${path}`, 8);
  const remoteParent = remoteNode.parent_node_token || parent.node_token;
  return {
    path,
    source_node_ref: shortHash(record.node_token),
    revision_id: revisionId,
    body_sha256: sha256(canonicalJson(blocks)),
    title_sha256: sha256(title),
    parent_node_ref: shortHash(remoteParent),
    marker_sha256: sha256(blockSignature(blocks[0])),
    scope_sha256: sha256([appId, spaceId, managedRootToken, record.node_token].join('\u0000')),
    remote_block_signature_sha256: remoteSignature,
    last_synced_block_signature_sha256: matchedBaseline?.digest || baselineSignatures[0].digest,
    baseline_commit_ref: shortHash(baseline.commit),
    baseline_render_mode: matchedBaseline?.mode || 'none',
    text_only_match: Boolean(matchedTextBaseline),
    structure_match: structureMatches,
    remote_block_count: blocks.length,
    baseline_block_counts: [...new Set(baselineSignatures.map((candidate) => candidate.block_count))],
    remote_unchanged: markerMatches && Boolean(matchedBaseline),
    link_only_difference: markerMatches && !matchedBaseline
      && Boolean(matchedTextBaseline) && structureMatches,
    marker_matches: markerMatches,
  };
}

async function readRemoteDirectory({ client, state, migration, appId, spaceId, managedRootToken }) {
  const record = state.nodes[migration.oldPath];
  const parent = state.nodes[record?.parent_path];
  if (record?.kind !== 'directory' || !record.node_token || !parent?.node_token) {
    fail(`旧发布状态缺少目录迁移基线：${migration.oldPath}`, 8);
  }
  if (state.nodes[migration.newPath]) fail(`目录迁移目标已存在受控状态：${migration.newPath}`, 8);
  const remote = await client.resolveNode(record.node_token);
  const title = remote.title || record.title;
  if (remote.node_token !== record.node_token || title !== record.title) {
    fail(`待改名目录身份或标题已漂移：${migration.oldPath}`, 8);
  }
  const remoteParent = remote.parent_node_token || parent.node_token;
  if (remoteParent !== parent.node_token) fail(`待改名目录父节点已漂移：${migration.oldPath}`, 8);
  const targetTitle = basename(migration.newPath);
  const siblings = await client.listNodes(spaceId, parent.node_token);
  const controlled = siblings.filter((node) => node.node_token === record.node_token && node.title === record.title);
  const conflicts = siblings.filter((node) => node.node_token !== record.node_token && node.title === targetTitle);
  if (controlled.length !== 1 || conflicts.length) fail(`待改名目录远端集合不唯一或目标标题冲突：${migration.oldPath}`, 8);
  return {
    source_path: migration.oldPath,
    target_path: migration.newPath,
    node_ref: shortHash(record.node_token),
    title_sha256: sha256(title),
    parent_node_ref: shortHash(remoteParent),
    scope_sha256: sha256([appId, spaceId, managedRootToken, record.node_token].join('\u0000')),
  };
}

async function buildLivePlan(options) {
  if (!existsSync(options.statePath)) fail('缺少正文协调所需的本地发布状态。', 7);
  const stateRaw = readFileSync(options.statePath, 'utf8');
  const state = loadPublicationState({
    statePath: options.statePath, legacyStatePath: options.legacyStatePath, required: true,
  });
  const scan = scanProject(options.projectRoot, options.manifestPath);
  const migrations = loadRenameMap(options.renamePath);
  const sourceByTarget = actionSourceMapping(scan, state, migrations);
  const plannedDirectoryPaths = new Set(scan.items
    .filter((item) => item.kind === 'directory').map((item) => item.path));
  const directoryMigrations = migrations.filter((migration) => state.nodes[migration.oldPath]?.kind === 'directory');
  for (const migration of directoryMigrations) {
    if (!plannedDirectoryPaths.has(migration.newPath)) {
      fail(`目录迁移目标不在当前发布结构中：${migration.newPath}`, 8);
    }
  }
  const config = loadFeishuConfiguration({
    appId: APP_ID, apiBase: API_BASE, testMode: TEST_MODE,
    testSecretEnv: 'FEISHU_IMPORT_TEST_SECRET', testNodeEnv: 'FEISHU_IMPORT_TEST_PARENT_NODE',
  });
  const accessToken = await authenticateTenant({ apiBase: API_BASE, appId: APP_ID, secret: config.secret });
  config.secret = undefined;
  const client = new FeishuClient(API_BASE, accessToken, {
    minimumDelay: Number(process.env.FEISHU_IMPORT_MIN_DELAY_MS ?? (TEST_MODE ? 0 : 650)),
  });
  const diagnostic = scopeDiagnostic(await client.listGrantedScopes(), 'verify');
  if (!diagnostic.passed) fail('飞书只读协调所需租户权限未通过。', 9);
  const parentNode = await client.resolveNode(wikiToken(config.node));
  if (state.space_id !== parentNode.space_id || state.parent_node_ref !== shortHash(parentNode.node_token)) {
    fail('本地发布状态与当前授权父节点不匹配。', 8);
  }
  const rootRecord = state.nodes['.'];
  if (!rootRecord?.node_token) fail('本地发布状态缺少受管根节点。', 8);
  const remoteRoot = await client.resolveNode(rootRecord.node_token);
  if (remoteRoot.node_token !== rootRecord.node_token
      || (remoteRoot.parent_node_token && remoteRoot.parent_node_token !== parentNode.node_token)) {
    fail('飞书受管根节点身份或父子关系已漂移。', 8);
  }
  const activeItems = new Map(scan.items.filter((item) => item.kind === 'file').map((item) => [item.path, item]));
  const registry = new Map([...sourceByTarget].map(([targetPath, sourcePath]) => [
    targetPath,
    canonicalWikiUrl(new URL(`/wiki/${state.nodes[sourcePath].node_token}`, WIKI_BASE_URL).toString()),
  ]));
  const historicalRegistry = new Map(Object.entries(state.nodes)
    .filter(([, record]) => record.kind === 'file' && record.node_token)
    .map(([path, record]) => [
      path, canonicalWikiUrl(new URL(`/wiki/${record.node_token}`, WIKI_BASE_URL).toString()),
    ]));
  const baselineRegistry = new Map([...historicalRegistry, ...registry]);
  const managedLinkIdentities = new Map();
  for (const [path, record] of Object.entries(state.nodes)) {
    if (record.node_token) managedLinkIdentities.set(record.node_token, `managed:${path}`);
    if (record.obj_token) managedLinkIdentities.set(record.obj_token, `managed:${path}`);
  }
  const baselineAvailablePaths = new Set([...scan.availablePaths, ...Object.keys(state.nodes)]);
  const baselinePublicationPaths = new Set(historicalRegistry.keys());
  const sourcePaths = [...new Set([
    ...sourceByTarget.values(), ...scan.publication.legacy_redirects.map((item) => item.legacyPath),
  ])].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const currentProposalSignatures = new Map([...activeItems].map(([path, item]) => {
    const blocks = blocksForContent(item, null, { linkScan: item.linkScan, registry });
    return [path, signatureForBlocks(blocks, managedLinkIdentities)];
  }));
  const remoteByPath = new Map();
  for (const path of sourcePaths) {
    const snapshot = await readRemotePage({
      client, state, path, appId: APP_ID, spaceId: state.space_id,
      managedRootToken: rootRecord.node_token, projectRoot: options.projectRoot,
      baselineAvailablePaths, baselinePublicationPaths, baselineRegistry, managedLinkIdentities,
    });
    remoteByPath.set(path, snapshot);
  }
  const directoryActions = [];
  for (const migration of directoryMigrations) {
    directoryActions.push(await readRemoteDirectory({
      client, state, migration, appId: APP_ID, spaceId: state.space_id,
      managedRootToken: rootRecord.node_token,
    }));
  }
  client.token = undefined;
  const drifted = [...remoteByPath.values()].filter((item) => !item.remote_unchanged);
  const acceptedLinkOnly = drifted.filter((item) => item.link_only_difference);
  const blockingDrift = drifted.filter((item) => (
    !options.acceptLinkOnlyBaseline || !item.link_only_difference
  ));
  if (blockingDrift.length) {
    return {
      result: 'blocked', mode: 'plan', reason: 'remote_body_changed_since_baseline',
      checked_pages: remoteByPath.size, drifted_pages: drifted.map((item) => ({
        path: item.path, marker_matches: item.marker_matches,
        baseline_commit_ref: item.baseline_commit_ref, baseline_render_mode: item.baseline_render_mode,
        text_only_match: item.text_only_match, remote_block_count: item.remote_block_count,
        structure_match: item.structure_match,
        link_only_difference: item.link_only_difference,
        baseline_block_counts: item.baseline_block_counts,
        matches_current_proposal: [...sourceByTarget]
          .some(([target, source]) => source === item.path
            && currentProposalSignatures.get(target) === item.remote_block_signature_sha256),
      })),
      plan_written: false, write_request_sent: false,
    };
  }
  const replacementCounts = new Map();
  for (const redirect of scan.publication.legacy_redirects) {
    replacementCounts.set(redirect.replacementPath, (replacementCounts.get(redirect.replacementPath) || 0) + 1);
  }
  const pages = [];
  for (const [targetPath, sourcePath] of [...sourceByTarget].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))) {
    const item = activeItems.get(targetPath);
    const remote = remoteByPath.get(sourcePath);
    const blocks = blocksForContent(item, null, { linkScan: item.linkScan, registry });
    pages.push({
      source_path: sourcePath, target_path: targetPath,
      source_node_ref: remote.source_node_ref, target_node_ref: remote.source_node_ref,
      ...remote,
      git_sha256: item.hash,
      proposal_block_signature_sha256: signatureForBlocks(blocks, managedLinkIdentities),
      resolved_links_sha256: item.linkScan ? resolvedLinksDigest(item, registry) : sha256(''),
      authority_decision: remote.remote_unchanged
        ? 'remote_unchanged' : 'link_only_remote_accepted',
      merge_into_target: replacementCounts.has(targetPath),
    });
  }
  for (const redirect of scan.publication.legacy_redirects) {
    const remote = remoteByPath.get(redirect.legacyPath);
    const targetSource = sourceByTarget.get(redirect.replacementPath);
    const proposal = redirectProposal(
      redirect.legacyPath, redirect.replacementPath, registry.get(redirect.replacementPath),
      managedLinkIdentities,
    );
    pages.push({
      source_path: redirect.legacyPath, target_path: redirect.replacementPath,
      source_node_ref: remote.source_node_ref,
      target_node_ref: shortHash(state.nodes[targetSource].node_token),
      ...remote, ...proposal,
      authority_decision: remote.remote_unchanged
        ? 'remote_unchanged' : 'link_only_remote_accepted',
      legacy_redirect: true,
    });
  }
  const plan = buildReconciliationPlan({
    generatedAt: new Date().toISOString(),
    publicationManifestSha256: sha256(readFileSync(options.manifestPath)),
    sourceStateSha256: sha256(stateRaw),
    scope: {
      app_id_sha256: sha256(APP_ID),
      space_id_sha256: sha256(state.space_id),
      managed_root_node_sha256: sha256(rootRecord.node_token),
    },
    pages, directories: directoryActions,
  });
  saveStateAtomic(options.outputPath, plan);
  const actions = {};
  for (const action of plan.actions) actions[action.allowed_action] = (actions[action.allowed_action] || 0) + 1;
  return {
    result: 'ready', mode: 'plan', checked_pages: remoteByPath.size,
    checked_directories: directoryActions.length,
    plan_actions: plan.actions.length, action_counts: actions,
    directory_actions: plan.directory_actions.length,
    plan_digest: plan.plan_digest, output: relativeOutput(options.projectRoot, options.outputPath),
    exact_revisions_frozen: true, remote_edits_detected: false,
    accepted_link_only_pages: acceptedLinkOnly.map((item) => item.path),
    plan_gitignored: true, write_request_sent: false,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  try {
    const report = await buildLivePlan(parseArguments(argv));
    console.log(JSON.stringify(report));
    if (report.result !== 'ready') process.exitCode = 8;
  } catch (error) {
    console.log(JSON.stringify({ result: 'failed', error: safe(error.message), write_request_sent: false }));
    process.exitCode = error.exitCode || 1;
  }
}

export {
  actionSourceMapping, buildLivePlan, gitBaseline, parseArguments, redirectProposal,
  normalizedBlockSignature, signatureForBlocks,
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runCli();
