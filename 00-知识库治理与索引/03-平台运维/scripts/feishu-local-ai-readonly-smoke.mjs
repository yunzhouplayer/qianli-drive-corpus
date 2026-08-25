#!/usr/bin/env node

// 用途：使用现有飞书应用验证本地 AI 试点节点可读、对照节点不可读，并生成脱敏运行记录。
// 边界：除租户令牌认证协议外，资源客户端只允许 GET；不保存正文、节点 token、成员 ACL 或访问令牌。

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FeishuClient, GovernanceToolError, authenticateTenant, canonicalJson, fail,
  loadFeishuConfiguration, saveStateAtomic, sha256, shortHash, wikiToken,
} from './lib/feishu-governance-core.mjs';
import { scopeDiagnostic } from './feishu-governance-publish.mjs';

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaffdf087c789bda';
const API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';
const TEST_MODE = process.env.FEISHU_IMPORT_TEST_MODE === '1';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTPUT_RELATIVE = '00-知识库治理与索引/.runtime/feishu-local-ai-readonly-smoke.json';

function parseArguments(argv) {
  if ((argv[0] || '') !== 'smoke') fail('只读同步烟测只支持 smoke 模式。', 2);
  const options = { projectRoot: PROJECT_ROOT };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--authorized-node') options.authorizedNode = argv[++index];
    else if (argument === '--unauthorized-node') options.unauthorizedNode = argv[++index];
    else if (argument === '--output') options.outputPath = resolve(argv[++index] || '');
    else if (argument === '--project-root') options.projectRoot = resolve(argv[++index] || '');
    else fail(`未知参数：${argument}`, 2);
  }
  const authorizedToken = wikiToken(options.authorizedNode);
  const unauthorizedToken = wikiToken(options.unauthorizedNode);
  if (authorizedToken === unauthorizedToken) fail('授权节点与未授权对照节点必须不同。', 2);
  options.authorizedToken = authorizedToken;
  options.unauthorizedToken = unauthorizedToken;
  options.outputPath ||= resolve(options.projectRoot, OUTPUT_RELATIVE);
  return options;
}

function isAccessDenied(error) {
  return error instanceof GovernanceToolError
    && ([401, 403, 404].includes(error.httpStatus) || [131006, 99991663].includes(error.apiCode));
}

function localAiScopeDiagnostic(scopes) {
  const base = scopeDiagnostic(scopes, 'verify');
  const granted = scopes.filter((scope) => scope.grant_status === 1);
  const tenant = new Set(granted.filter((scope) => scope.scope_type === 'tenant').map((scope) => scope.scope_name));
  const user = new Set(granted.filter((scope) => scope.scope_type === 'user').map((scope) => scope.scope_name));
  const accepted = ['drive:drive:readonly', 'drive:drive'];
  const tenantMatches = accepted.filter((scope) => tenant.has(scope));
  const userMatches = accepted.filter((scope) => user.has(scope));
  const driveCheck = {
    capability: 'read_drive_content',
    status: tenantMatches.length ? 'pass' : (userMatches.length ? 'wrong_identity' : 'missing'),
    accepted_scopes: accepted, tenant_matches: tenantMatches, user_matches: userMatches,
  };
  return { ...base, checks: [...base.checks, driveCheck], passed: base.passed && driveCheck.status === 'pass' };
}

async function readAuthorizedNode(client, nodeToken) {
  const node = await client.resolveNode(nodeToken);
  if (node.obj_type !== 'docx' || !node.obj_token) {
    fail('授权试点节点不是可读取正文的新版文档节点。', 8);
  }
  const metadata = await client.getDocumentMetadata(node.obj_token);
  const revisionId = metadata.revision_id;
  if (revisionId === -1 || revisionId === '-1' || revisionId === undefined || revisionId === null) {
    fail('授权节点未返回精确 revision。', 8);
  }
  const blocks = await client.listDocumentChildren(node.obj_token, revisionId);
  const confirmed = await client.getDocumentMetadata(node.obj_token);
  if (confirmed.revision_id !== revisionId) fail('授权节点读取期间 revision 已变化。', 8);
  return {
    result: 'readable', node_ref: shortHash(node.node_token), space_ref: shortHash(node.space_id),
    object_type: node.obj_type, revision_id: revisionId, block_count: blocks.length,
    body_snapshot_sha256: sha256(canonicalJson(blocks)), body_stored: false,
  };
}

async function assertUnauthorizedNode(client, nodeToken) {
  try {
    await client.resolveNode(nodeToken);
  } catch (error) {
    if (isAccessDenied(error)) {
      return { result: 'access_denied', node_ref: shortHash(nodeToken), existence_exposed: false };
    }
    throw error;
  }
  fail('未授权对照节点可被应用读取，拒绝通过烟测。', 8);
}

async function probeNodes({ client, authorizedToken, unauthorizedToken }) {
  const authorized = await readAuthorizedNode(client, authorizedToken);
  const unauthorized = await assertUnauthorizedNode(client, unauthorizedToken);
  return { authorized, unauthorized };
}

async function runSmoke(options) {
  const config = loadFeishuConfiguration({
    appId: APP_ID, apiBase: API_BASE, testMode: TEST_MODE,
    testSecretEnv: 'FEISHU_IMPORT_TEST_SECRET', testNodeEnv: 'FEISHU_IMPORT_TEST_PARENT_NODE',
  });
  const token = await authenticateTenant({ apiBase: API_BASE, appId: APP_ID, secret: config.secret });
  config.secret = undefined;
  config.node = undefined;
  const client = new FeishuClient(API_BASE, token, {
    minimumDelay: Number(process.env.FEISHU_IMPORT_MIN_DELAY_MS ?? (TEST_MODE ? 0 : 650)),
  });
  const scopes = localAiScopeDiagnostic(await client.listGrantedScopes());
  if (!scopes.passed) fail('现有应用缺少节点、目录、Docx 或云空间正文的租户级只读能力。', 9);
  const probe = await probeNodes({
    client, authorizedToken: options.authorizedToken, unauthorizedToken: options.unauthorizedToken,
  });
  const report = {
    schema_version: '1.0', result: 'passed', mode: 'governance_validation',
    production_index_enabled: false, captured_at: new Date().toISOString(),
    app_id_ref: shortHash(APP_ID), credential_type: 'tenant_access_token',
    scope_checks: scopes.checks.map(({ capability, status }) => ({ capability, status })),
    ...probe,
    controls: {
      resource_methods: ['GET'], authentication_post_required: true, content_write_request_sent: false,
      body_persisted: false, node_tokens_persisted: false, acl_members_persisted: false,
    },
  };
  saveStateAtomic(options.outputPath, report);
  client.token = undefined;
  return report;
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const report = await runSmoke(options);
  console.log(JSON.stringify(report));
}

export {
  assertUnauthorizedNode, isAccessDenied, localAiScopeDiagnostic, parseArguments, probeNodes,
  readAuthorizedNode, runSmoke,
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    console.error(JSON.stringify({ result: 'failed', error: error.message }));
    process.exit(error.exitCode || 1);
  });
}
