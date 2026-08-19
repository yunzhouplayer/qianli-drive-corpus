#!/usr/bin/env node

// 兼容入口：正式命令已改名并迁入 03-平台运维；本文件只转发参数，不包含实现。
// 安全边界：不会自行读取凭证或调用 API，所有门禁由正式发布命令执行。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../03-平台运维/scripts/feishu-governance-publish.mjs';

export * from '../../03-平台运维/scripts/feishu-governance-publish.mjs';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runCli(process.argv.slice(2), { deprecatedCommand: 'feishu-governance-import.mjs' });
