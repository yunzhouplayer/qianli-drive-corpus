# 受控字典

## 字典清单

|文件|用途|当前状态|
|---|---|---|
|[01-document-types.yaml](./01-document-types.yaml)|文档类型|已填写通用值|
|[02-security-levels.yaml](./02-security-levels.yaml)|安全等级及默认 AI 权限|已填写通用值|
|[03-business-domains.yaml](./03-business-domains.yaml)|业务或专业领域|已登记首批试点值“测试与质量”|
|[04-systems-platforms.yaml](./04-systems-platforms.yaml)|业务系统与技术平台|治理验证阶段保持为空|
|[05-source-systems.yaml](./05-source-systems.yaml)|权威知识来源平台|已登记“飞书知识库”|
|[06-retention-policies.yaml](./06-retention-policies.yaml)|保留期限与清理规则|治理验证阶段保持为空|

## 维护边界

- 业务域由字典责任人维护，对应空间管理员确认定义和适用范围。
- 系统与平台由产品、研发、运营或平台责任人确认，不得从文档标题自动生成标准值。
- 来源系统由知识库和系统管理员确认，飞书知识库与业务系统不得混为同一字段。
- 保留期限由责任人组织法务、财务、人力、安全等专业人员确认；空字典期间不得准入生产索引。
- 首批试点只登记实际使用的值，后续通过变更流程逐步扩展。

新增值按以下字段维护：

```yaml
schema_version: "1.0"
owner: null
updated_at: null
values: []
```

每个值至少包含稳定编码、显示名称、定义、别名、状态、维护人和生效时间。废弃值保留编码并指向替代值，不直接删除。
