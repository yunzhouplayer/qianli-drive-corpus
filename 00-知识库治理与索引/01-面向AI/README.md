# 面向 AI 的控制文件

本目录保存供检索系统、AI Agent 和校验程序使用的机器控制文件，不保存业务正文、向量索引、查询缓存或自动摘要。

## 注释约定

- YAML 文件使用中文注释说明用途、维护责任、字段含义和安全默认值。
- 注释用于帮助开发人员理解，不参与程序判断；实际行为以字段值和 Schema 约束为准。
- 空清单中的注释只定义数据结构，不代表已经存在对应业务数据。
- 修改机器字段时，应同步检查读取该字段的校验、索引和评测程序。
- 英文文件名、字段名、稳定编码和枚举值必须在同一文件中提供中文注释、中文 `description` 或中文名称。
- Schema 的业务字段应提供中文 `description`；无法逐项描述的重复结构，应在文件开头提供中文字段表和枚举说明。
- 新增机器文件时，不得只提供英文示例或英文注释。

|文件|用途|当前状态|
|---|---|---|
|[00-ai-control-manifest.yaml](./00-ai-control-manifest.yaml)|本地 AI 加载知识控制面的唯一机器入口和全局运行状态源|治理验证模式；必需文件失效时默认拒绝启动|
|[01-knowledge-structure.yaml](./01-knowledge-structure.yaml)|完整知识库机器蓝图|主管理员已登记；部分备用管理员待任命|
|[02-AI-Agent使用契约.md](./02-AI-Agent使用契约.md)|来源、权限、引用和不确定性规则|已填写通用规则|
|[03-index-admission-rules.yaml](./03-index-admission-rules.yaml)|生产索引准入与默认拒绝条件|治理验证模式；生产索引关闭|
|[04-索引准入与同步规范.md](./04-索引准入与同步规范.md)|分块、同步、失效和审计规则|已填写通用规则|
|[05-authority-sources.yaml](./05-authority-sources.yaml)|主题与权威文档映射|空清单，待业务负责人登记|
|[06-corpus-manifest.yaml](./06-corpus-manifest.yaml)|实际进入索引的文档清单|治理验证期间保持为空|
|[07-evaluation-cases.yaml](./07-evaluation-cases.yaml)|检索与回答评测问题|空清单，待业务和安全负责人确认|
|[08-检索与回答评测规范.md](./08-检索与回答评测规范.md)|指标、评测集和纠错闭环|已填写通用规则|
|[飞书发布路径迁移清单](../03-平台运维/01-feishu-publication-path-renames.json)|飞书受控知识树原位路径改名清单|由平台运维目录维护；历史记录不删除|
|[飞书正文发布清单](../03-平台运维/02-feishu-publication-manifest.json)|飞书公司知识正文、旧页提示和业务目录显式白名单|默认拒绝；实际数量以清单为准|
|[09-retrieval-runtime-contract.yaml](./09-retrieval-runtime-contract.yaml)|身份、ACL、证据和回答安全不变量|仅冻结契约；请求、响应和错误字段以独立 Schema 为准|
|[10-indexing-policy.yaml](./10-indexing-policy.yaml)|稳定分块、写入、生命周期、证据和回滚原则|仅冻结契约；可调参数迁入独立实现配置|
|[治理验证索引配置](../03-平台运维/configs/governance-validation-indexing-profile.yaml)|治理验证使用的块大小、融合权重、数量和保留期限参数|`validation_only=true`；不得作为生产就绪证据|
|[schemas/01-knowledge-structure-schema.yaml](./schemas/01-knowledge-structure-schema.yaml)|空间、目录和索引策略的结构约束|已填写通用规则|
|[schemas/02-metadata-schema.yaml](./schemas/02-metadata-schema.yaml)|正式文档元数据字段与校验条件|已填写通用规则|
|[schemas/03-controlled-vocabulary-schema.yaml](./schemas/03-controlled-vocabulary-schema.yaml)|受控字典及字典值结构约束|已填写通用规则|
|[schemas/04-authority-sources-schema.yaml](./schemas/04-authority-sources-schema.yaml)|权威主题与源文档映射结构|已启用；业务条目仍为空|
|[schemas/05-corpus-manifest-schema.yaml](./schemas/05-corpus-manifest-schema.yaml)|索引语料清单结构|已启用；生产索引关闭时清单为空|
|[schemas/06-evaluation-case-schema.yaml](./schemas/06-evaluation-case-schema.yaml)|检索与回答评测用例结构|已启用；评测用例仍为空|
|[schemas/07-ai-control-manifest-schema.yaml](./schemas/07-ai-control-manifest-schema.yaml)|AI 启动清单及失败策略结构|已填写通用规则|
|[schemas/08-retrieval-runtime-contract-schema.yaml](./schemas/08-retrieval-runtime-contract-schema.yaml)|检索运行契约结构|已填写通用规则|
|[schemas/09-indexing-policy-schema.yaml](./schemas/09-indexing-policy-schema.yaml)|索引策略结构|已填写通用规则|
|[schemas/10-runtime-audit-event-schema.yaml](./schemas/10-runtime-audit-event-schema.yaml)|运行审计事件结构|只定义格式；真实日志不进入 Git|
|[schemas/11-evaluation-result-schema.yaml](./schemas/11-evaluation-result-schema.yaml)|离线评测结果结构|已填写通用规则|
|[schemas/12-index-admission-rules-schema.yaml](./schemas/12-index-admission-rules-schema.yaml)|索引准入政策结构|已约束默认拒绝、SLA 和决定输出|
|[schemas/13-admission-decision-schema.yaml](./schemas/13-admission-decision-schema.yaml)|单次索引准入决定载荷|只定义格式；真实决定写入运行审计|
|[schemas/14-acl-decision-schema.yaml](./schemas/14-acl-decision-schema.yaml)|检索三阶段 ACL 判定载荷|未知或失效权限不得生成允许决定|
|[schemas/15-retrieval-request-schema.yaml](./schemas/15-retrieval-request-schema.yaml)|本地 AI 的统一检索请求载荷|包含本人身份、群组和 ACL 快照|
|[schemas/16-retrieval-response-schema.yaml](./schemas/16-retrieval-response-schema.yaml)|统一检索结果、引用和安全错误载荷|未授权结果不得暴露资源存在性|
|[schemas/17-indexing-profile-schema.yaml](./schemas/17-indexing-profile-schema.yaml)|索引实现的可调参数配置结构|已用于校验治理验证索引配置|
|[vocabularies/README.md](./vocabularies/README.md)|字典维护边界|部分试点值已登记；系统与保留期限待确认|
|[vocabularies/01-document-types.yaml](./vocabularies/01-document-types.yaml)|通用文档类型编码|已填写通用值|
|[vocabularies/02-security-levels.yaml](./vocabularies/02-security-levels.yaml)|安全等级及默认 AI 权限|已填写通用值|
|[vocabularies/03-business-domains.yaml](./vocabularies/03-business-domains.yaml)|业务或专业领域编码|已登记首批测试试点值|
|[vocabularies/04-systems-platforms.yaml](./vocabularies/04-systems-platforms.yaml)|业务系统与技术平台编码|具体值待确认|
|[vocabularies/05-source-systems.yaml](./vocabularies/05-source-systems.yaml)|权威知识来源平台编码|已登记飞书知识库|
|[vocabularies/06-retention-policies.yaml](./vocabularies/06-retention-policies.yaml)|保留期限与清理规则编码|具体值待确认|
|[飞书治理发布工具](../03-平台运维/scripts/feishu-governance-publish.mjs)|将显式登记内容受控发布到已授权的飞书知识库测试子树|支持诊断、发布/续传、受控更新/改名和核验；不自动删除或移动节点|
|[飞书治理退役工具](../03-平台运维/scripts/feishu-governance-retire.mjs)|独立退役旧发布范围中的飞书节点|仅处理批准差集；执行前必须预检和确认数量|
|[AI 控制面校验器](../03-平台运维/scripts/validate_ai_controls.rb)|统一检查 AI 控制文件、Schema 引用和跨文件关系|只读；失败时返回稳定错误码|
|[离线检索评测器](../03-平台运维/scripts/evaluate_retrieval.rb)|核对离线检索结果、权限负例、引用和拒答行为|空用例集只返回未执行，不声明质量通过|

## AI 启动入口与读取顺序

本地 AI、检索服务或适配器必须从[00-ai-control-manifest.yaml](./00-ai-control-manifest.yaml)启动，不得自行扫描目录猜测配置。确定性加载顺序如下：

1. 读取启动清单并核对运行模式、生产开关和失败策略。
2. 加载目录结构、元数据 Schema 和全部受控字典。
3. 加载索引准入、权威来源和实际语料范围。
4. 加载索引策略和检索运行契约。
5. 加载评测用例、运行审计和评测结果 Schema。

任一必需文件缺失、Schema 主版本不兼容、未知控制字段或交叉引用失效时必须 fail closed：启动、索引或回答按对应策略停止，不能忽略错误继续运行。机器读取以启动清单的 `load_sequence` 为准；本 README 只提供人员导航。

## 本地 AI 接入边界

- 当前只提供与传输协议无关的检索契约，尚未部署 MCP、HTTP、Embedding、向量库或重排服务。
- 后续 Codex、Claude Code 或其他本地 AI 适配器必须把用户身份、群组、租户和 ACL 快照传入统一契约，不得共用超管身份代替员工本人权限。
- 检索前、读取前和回答前三次权限判断均不得跳过；ACL 缺失或过期时按无权限处理。
- 生产索引、缓存、连接器状态、评测结果和查询审计只能写入 Git 忽略的 `00-知识库治理与索引/.runtime/` 或批准的外部运行平台。
- 真实运行证据完成前，本仓库只能声明“治理验证可执行”，不能声明本地 AI 已经能够检索公司知识。

## 单一来源

- 字段定义以`schemas/02-metadata-schema.yaml`为准。
- 空间、目录、父子关系和目录级索引策略以`01-knowledge-structure.yaml`为准。
- 通用枚举以`vocabularies/`中的文件为准。
- 权威主题映射以`05-authority-sources.yaml`为准。
- 实际索引范围以`06-corpus-manifest.yaml`为准，不能用索引内容反向修改源知识。
- 本目录中的空清单不得由 AI 自动生成业务事实后直接提交。

## 飞书治理发布与退役

正式实现和测试已迁入[03-平台运维](../03-平台运维/README.md)。发布工具只处理显式清单登记的正文种子和业务目录；未登记文件默认拒绝，不会把 Git 仓库整体镜像为飞书正文。退役仍由独立命令承担，发布命令不删除节点。

新 Keychain 服务 `qianli-feishu-governance` 与 `qianli-feishu-governance-node` 必须成对存在；只有两项都缺失时才兼容旧 smoke 配置，部分迁移会 fail closed。默认状态已改为 `.runtime/feishu-publication-state.json`（Schema 1.1）；旧 `.runtime/feishu-import-state.json` 首次使用时保留内容和摘要迁移，不自动删除。

文件页面首次创建完成后标记为 `content_authority=feishu`，后续 `apply` 只核验受控标记，不因 Git 种子哈希变化覆盖飞书正文。目录结构仍按 Git 蓝图校验；受控目录改名必须显式登记。旧状态中存在超出新发布范围的节点时，`preflight`、`apply` 和 `verify` 会报告 `retired_managed_nodes` 并阻塞，脚本不会自动删除、移动或隐藏飞书节点。

`feishu-governance-retire.mjs` 是独立的受控退役工具。它只处理 Git 中显式、摘要校验通过且 `executable=true` 的退役计划；历史完成计划必须为 `executable=false`，不能再次执行。工具强制保护受控根和三份保留治理文档，逐页比较飞书正文与原受控发布版本，并按叶子优先顺序删除；执行时必须同时确认数量和计划摘要。每次删除后确认节点已从父目录消失，才更新 Git 忽略的本地状态。

当前仓库没有实现飞书正文反向覆盖 Git 源文件的双向同步。正文、权限和飞书版本记录以飞书为权威；Git 中的 Schema、字典、发布清单、脚本和治理控制仍以 Git 为权威。如需留存飞书正文，应新增独立的只读快照流水线，把块结构、纯文本或 DOCX/PDF 导出物写入专用快照目录并经 PR 审查，不得覆盖本目录中的首次创建种子。

`apply` 汇总会分别报告创建节点数、受控改名节点数、恢复中的节点数、首次写入页数、目录内容更新页数、飞书权威正文核验页数、未变化目录页数和旧内容块范围删除次数。幂等重跑应满足 `created_nodes=0`、`renamed_nodes=0`、`content_updated=0`、`deleted_block_ranges=0`；文件页计入 `content_feishu_authoritative`，目录页计入 `content_unchanged`。

本地目录需要改名时，先修改物理目录、人员蓝图、机器蓝图和正文发布清单，再将旧/新项目相对路径登记到[飞书发布路径迁移清单](../03-平台运维/01-feishu-publication-path-renames.json)。常规发布仅允许目录在同一父节点下原位改名；正文页面改名、合并和旧页提示必须走正文协调计划。节点本身不重新创建，历史迁移记录不删除。

旧 `01-面向AI/scripts/` 命令仅作为一个治理周期的兼容包装器，保持参数和退出码并输出弃用提示。正式命令和完整本地回归清单见[平台运维导航](../03-平台运维/README.md)。

`validate_knowledge_structure.rb` 补充 JSON Schema 无法表达的跨记录检查：空间和目录 ID/路径唯一、两位序号、目录 ID 与空间序号一致、父目录 ID 与物理路径一致、登记目录真实存在、人员蓝图文件可定位。默认使用当前项目，可通过 `--structure` 和 `--project-root` 检查其他副本；只检查导出文件时可显式使用 `--skip-filesystem`。

## 当前运行模式

当前值只从[启动清单](./00-ai-control-manifest.yaml)的 `operating_mode` 和 `production_index_enabled` 读取。本 README 不复制状态值；启动清单未通过校验时，不得连接索引、回答公司事实或用于模型训练。
