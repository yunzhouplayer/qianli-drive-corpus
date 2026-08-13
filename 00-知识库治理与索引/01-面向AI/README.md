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
|[01-knowledge-structure.yaml](./01-knowledge-structure.yaml)|完整知识库机器蓝图|主管理员已登记；部分备用管理员待任命|
|[02-AI-Agent使用契约.md](./02-AI-Agent使用契约.md)|来源、权限、引用和不确定性规则|已填写通用规则|
|[03-index-admission-rules.yaml](./03-index-admission-rules.yaml)|生产索引准入与默认拒绝条件|治理验证模式；生产索引关闭|
|[04-索引准入与同步规范.md](./04-索引准入与同步规范.md)|分块、同步、失效和审计规则|已填写通用规则|
|[05-authority-sources.yaml](./05-authority-sources.yaml)|主题与权威文档映射|空清单，待业务负责人登记|
|[06-corpus-manifest.yaml](./06-corpus-manifest.yaml)|实际进入索引的文档清单|治理验证期间保持为空|
|[07-evaluation-cases.yaml](./07-evaluation-cases.yaml)|检索与回答评测问题|空清单，待业务和安全负责人确认|
|[08-检索与回答评测规范.md](./08-检索与回答评测规范.md)|指标、评测集和纠错闭环|已填写通用规则|
|[09-feishu-import-path-renames.json](./09-feishu-import-path-renames.json)|飞书受控知识树同父级路径改名清单|已登记归档目录编号修正|
|[schemas/01-knowledge-structure-schema.yaml](./schemas/01-knowledge-structure-schema.yaml)|空间、目录和索引策略的结构约束|已填写通用规则|
|[schemas/02-metadata-schema.yaml](./schemas/02-metadata-schema.yaml)|正式文档元数据字段与校验条件|已填写通用规则|
|[schemas/03-controlled-vocabulary-schema.yaml](./schemas/03-controlled-vocabulary-schema.yaml)|受控字典及字典值结构约束|已填写通用规则|
|[vocabularies/README.md](./vocabularies/README.md)|字典维护边界|部分试点值已登记；系统与保留期限待确认|
|[vocabularies/01-document-types.yaml](./vocabularies/01-document-types.yaml)|通用文档类型编码|已填写通用值|
|[vocabularies/02-security-levels.yaml](./vocabularies/02-security-levels.yaml)|安全等级及默认 AI 权限|已填写通用值|
|[vocabularies/03-business-domains.yaml](./vocabularies/03-business-domains.yaml)|业务或专业领域编码|已登记首批测试试点值|
|[vocabularies/04-systems-platforms.yaml](./vocabularies/04-systems-platforms.yaml)|业务系统与技术平台编码|具体值待确认|
|[vocabularies/05-source-systems.yaml](./vocabularies/05-source-systems.yaml)|权威知识来源平台编码|已登记飞书知识库|
|[vocabularies/06-retention-policies.yaml](./vocabularies/06-retention-policies.yaml)|保留期限与清理规则编码|具体值待确认|
|[scripts/feishu-governance-import.mjs](./scripts/feishu-governance-import.mjs)|将本地治理树受控映射到已授权的飞书知识库测试子树|支持诊断、导入/续传、受控更新/改名和核验；不自动删除或移动节点|

## 单一来源

- 字段定义以`schemas/02-metadata-schema.yaml`为准。
- 空间、目录、父子关系和目录级索引策略以`01-knowledge-structure.yaml`为准。
- 通用枚举以`vocabularies/`中的文件为准。
- 权威主题映射以`05-authority-sources.yaml`为准。
- 实际索引范围以`06-corpus-manifest.yaml`为准，不能用索引内容反向修改源知识。
- 本目录中的空清单不得由 AI 自动生成业务事实后直接提交。

## 飞书治理树导入

`scripts/feishu-governance-import.mjs` 只将当前项目映射到已授权测试节点下的独立 `qianli-drive-Corpus` 子树。应用最小 API 权限为节点读取、子节点列表、节点创建、节点标题更新和新版文档读写；脚本不需要节点删除或移动权限。

```bash
# 1. 本地扫描、密钥门禁和节点/块数估算，不访问飞书。
node scripts/feishu-governance-import.mjs plan

# 2. 只读解析授权父节点并枚举直接子节点。
node scripts/feishu-governance-import.mjs diagnose
node scripts/feishu-governance-import.mjs preflight

# 3. 显式开启首次导入或中断续传。
node scripts/feishu-governance-import.mjs apply --execute

# 4. 读回核对父子关系、标题、块数和文件哈希标记。
node scripts/feishu-governance-import.mjs verify
```

默认从 macOS 钥匙串服务 `qianli-feishu-smoke` 和 `qianli-feishu-smoke-node` 读取已有凭证与授权节点。`diagnose` 使用飞书租户授权状态接口检查实际生效的 `scope_type`；用户身份权限不能代替 `tenant_access_token` 所需的应用身份权限。导入状态保存在 `.runtime/feishu-import-state.json`，文件权限为仅当前用户可读，并已被 Git 忽略。若已受控的本地文件发生变更，脚本先追加并读回新版本，确认完整后才删除旧内容块；不删除飞书节点，不接管无本地受控状态的同名页面。

`apply` 汇总会分别报告创建节点数、受控改名节点数、恢复中的节点数、首次写入页数、内容更新页数、未变化页数和旧内容块范围删除次数。幂等重跑应满足 `created_nodes=0`、`renamed_nodes=0`、`content_updated=0`、`deleted_block_ranges=0`，并且 `content_unchanged` 等于计划节点总数。

本地目录需要改名时，先修改物理目录、人员蓝图和机器蓝图，再将旧/新项目相对路径登记到 `09-feishu-import-path-renames.json`。导入器仅允许同一父目录下改名：先核对受控节点和同名冲突，调用飞书节点标题更新接口，读回确认后迁移本地状态；节点本身不重新创建，历史迁移记录不删除。

本地回归命令：

```bash
ruby scripts/validate_knowledge_structure.rb
ruby scripts/test_validate_knowledge_structure.rb
node scripts/test_feishu_governance_import.mjs
```

`validate_knowledge_structure.rb` 补充 JSON Schema 无法表达的跨记录检查：空间和目录 ID/路径唯一、两位序号、目录 ID 与空间序号一致、父目录 ID 与物理路径一致、登记目录真实存在、人员蓝图文件可定位。默认使用当前项目，可通过 `--structure` 和 `--project-root` 检查其他副本；只检查导出文件时可显式使用 `--skip-filesystem`。

## 当前运行模式

- `operating_mode=governance_validation`。
- `production_index_enabled=false`。
- 当前只验证目录、Schema、字典、模板和准入逻辑，不连接生产索引，不向 Agent 提供公司事实回答，也不用于模型训练。
