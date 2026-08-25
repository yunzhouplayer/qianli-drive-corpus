# 平台运维

本目录保存知识治理控制面的校验、评测和飞书受控发布/退役工具。公司知识正文与真实权限仍以飞书为权威；本目录中的脚本、清单和运行规则以 Git 为权威。运行状态只写入 Git 忽略的 `.runtime/`，不得提交凭证、访问令牌或原始节点 token。

## 脚本入口

|入口|职责|写入边界|
|---|---|---|
|[feishu-governance-publish.mjs](./scripts/feishu-governance-publish.mjs)|发布清单扫描、权限诊断、预检、受控发布和回读核验|只有 `apply --execute` 可写飞书；不删除节点|
|[feishu-governance-retire.mjs](./scripts/feishu-governance-retire.mjs)|独立核验并退役已批准的受控节点|只有 `apply --execute --confirm-count N` 可删除；不承担发布|
|[feishu-governance-core.mjs](./scripts/lib/feishu-governance-core.mjs)|哈希、脱敏、配置、tenant 认证、只读 API 客户端和状态原子读写|共享客户端只允许 GET，不包含内容写入方法|
|[正文协调计划库](./scripts/lib/feishu-body-reconciliation.mjs)|生成计划摘要并校验 revision、正文、父节点和身份范围漂移|不访问网络；任一页面漂移使整份计划失效|
|[正文协调只读入口](./scripts/feishu-governance-coordinate.mjs)|读取飞书精确版本并生成 17→12 正文协调计划|只发送 GET；计划仅保存到 `.runtime`|
|[正文协调执行器](./scripts/feishu-governance-coordinate-apply.mjs)|按已确认摘要执行精确 revision 正文协调和断点恢复|必须同时提供完整摘要与 `--execute`；不创建、删除、移动或改 ACL|
|[validate_governance.rb](./scripts/validate_governance.rb)|统一编排结构、AI 控制面、可选候选元数据和评测校验|只读；空评测不允许生产就绪声明|
|[validate_knowledge_structure.rb](./scripts/validate_knowledge_structure.rb)|检查知识空间、目录编号、父子关系和物理目录|只读|
|[migrate_knowledge_structure_v2.rb](./scripts/migrate_knowledge_structure_v2.rb)|将 v1 蓝图迁移为显式配置档 v2，并比较规范化树摘要|只有显式 `--output` 才写本地目标；不访问飞书|
|[validate_ai_controls.rb](./scripts/validate_ai_controls.rb)|检查 AI 控制文件、Schema 和跨文件引用|只读|
|[evaluate_retrieval.rb](./scripts/evaluate_retrieval.rb)|检查离线检索结果、安全负例和引用|只读；空用例集不声明质量通过|

## 凭证与状态兼容

正式命令优先读取以下新 Keychain 条目，且必须成对存在：

- App Secret：service=`qianli-feishu-governance`，account=应用 AppID；
- 授权父节点：service=`qianli-feishu-governance-node`，account=`authorized-parent-node`。

只有新条目两项都不存在时，才兼容读取旧的 `qianli-feishu-smoke` / `qianli-feishu-smoke-node` 成对配置。新配置只存在一项时立即阻塞，不回退旧配置；选中新配置后的认证失败也不触发回退。命令输出不得包含任何 Keychain 值。

默认运行状态为 `00-知识库治理与索引/.runtime/feishu-publication-state.json`，Schema 版本为 `1.1`。首次发现旧 `feishu-import-state.json` 时，工具保留全部节点、断点和退役历史，记录旧文件摘要并以 `0600` 权限原子写入新路径；新旧文件同时存在但摘要不一致时 fail closed。旧状态不会被自动删除。

## 正式命令

从仓库根目录执行：

```bash
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-publish.mjs' plan
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-publish.mjs' diagnose
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-publish.mjs' preflight
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-publish.mjs' apply --execute
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-publish.mjs' verify

node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-retire.mjs' plan
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-retire.mjs' diagnose
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-retire.mjs' preflight
```

退役 `apply` 必须提供显式计划路径，并同时确认计划摘要与数量：`--retirement-plan PLAN --confirm-plan-digest SHA256 --confirm-count N --execute`。不得从本文复制固定数量直接执行。已完成的 59 节点历史计划保存在 `retirements/`，其 `executable=false`，工具会拒绝重放。

发布白名单位于[02-feishu-publication-manifest.json](./02-feishu-publication-manifest.json)，默认拒绝未登记文件；路径改名位于[01-feishu-publication-path-renames.json](./01-feishu-publication-path-renames.json)。Markdown 发布前会校验全部本地链接：活跃发布页转换为真实飞书 Wiki 链接，Git-only 目标显示为明确纯文本，外链仅允许 `https`，缺失或越界目标会阻断。

[飞书外部知识树绑定](./03-feishu-space-bindings.yaml)只登记稳定外部 ID、中文显示名、物理名称和脱敏结构快照，不保存远端定位符、成员 ACL 或正文。Validation&Verification 的 2026-08-14 快照为 301 个节点、8 个一级分支，当前标记为过期；任何协调前必须重新只读采集，发现业务漂移时停止并请求管理员确认新基线。

知识结构 v2 使用 7 个显式目录配置档替代 134 份重复控制字段。迁移等价性证据保存在 `migrations/`；展开后仍为 9 个空间和 134 个目录，稳定 ID、物理路径、父子关系和控制属性必须逐项相同。权限说明后缀只从可选 `display_name` 中移除，`path_segment` 和飞书物理名称不变。

正文协调计划只写入 Git 忽略的 `.runtime/feishu-body-reconciliation-plan.json`，并受[协调计划 Schema](./schemas/01-feishu-body-reconciliation-schema.yaml)约束。真实执行必须再次确认整份计划摘要；不得使用 `revision_id=-1` 绕过 dry-run 时冻结的远端版本。

生成真实飞书只读协调计划：

```bash
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-coordinate.mjs' plan
```

命令会从 Git 历史按旧发布状态中的正文哈希恢复原始基线；任一页面的受控标记或块签名与基线不同，整份计划阻塞，不会把飞书人工修改自动覆盖为 Git 提案。
若管理员已明确确认接受“文字、块数和块类型均一致，仅链接目标属性不同”的当前飞书状态，必须在重新读取全部页面时显式追加 `--accept-link-only-baseline`；该决定会逐页写入协调计划，不能用于接受正文文字或结构差异。

真实执行必须遵循[执行器设计](./04-飞书正文协调执行器设计.md)，并显式提供计划与完整摘要：

```bash
node '00-知识库治理与索引/03-平台运维/scripts/feishu-governance-coordinate-apply.mjs' apply \
  --plan '00-知识库治理与索引/.runtime/feishu-body-reconciliation-plan.json' \
  --confirm-plan-digest '<完整 SHA-256>' \
  --execute
```

`01-面向AI/scripts/` 中的旧 `feishu-governance-import.mjs`、`feishu-governance-retire.mjs` 和 Ruby 入口仅保留一个治理周期，负责参数转发并输出弃用提示；实现与测试只在本目录维护。

## 本地回归

```bash
ruby '00-知识库治理与索引/03-平台运维/scripts/validate_knowledge_structure.rb'
ruby '00-知识库治理与索引/03-平台运维/scripts/test_validate_knowledge_structure.rb'
ruby '00-知识库治理与索引/03-平台运维/scripts/test_knowledge_structure_v2.rb'
ruby '00-知识库治理与索引/03-平台运维/scripts/validate_ai_controls.rb'
ruby '00-知识库治理与索引/03-平台运维/scripts/test_validate_ai_controls.rb'
ruby '00-知识库治理与索引/03-平台运维/scripts/evaluate_retrieval.rb'
ruby '00-知识库治理与索引/03-平台运维/scripts/test_evaluate_retrieval.rb'
ruby '00-知识库治理与索引/03-平台运维/scripts/validate_governance.rb'
ruby '00-知识库治理与索引/03-平台运维/scripts/test_validate_governance.rb'
node '00-知识库治理与索引/03-平台运维/scripts/test_feishu_governance_core.mjs'
node '00-知识库治理与索引/03-平台运维/scripts/test_feishu_markdown_links.mjs'
node '00-知识库治理与索引/03-平台运维/scripts/test_feishu_body_reconciliation.mjs'
node '00-知识库治理与索引/03-平台运维/scripts/test_feishu_governance_coordinate.mjs'
node '00-知识库治理与索引/03-平台运维/scripts/test_feishu_governance_coordinate_apply.mjs'
node '00-知识库治理与索引/03-平台运维/scripts/test_feishu_governance_publish.mjs'
node '00-知识库治理与索引/03-平台运维/scripts/test_feishu_governance_retire.mjs'
node '00-知识库治理与索引/03-平台运维/scripts/test_legacy_script_wrappers.mjs'
```

两项飞书回归只向本机回环模拟服务发送请求，不访问真实飞书，不读取 Keychain。测试中的写入与删除都只作用于进程内模拟状态。
