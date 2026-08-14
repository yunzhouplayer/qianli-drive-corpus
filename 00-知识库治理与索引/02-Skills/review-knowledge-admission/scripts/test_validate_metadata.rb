#!/usr/bin/env ruby
# 用途：回归验证预创建审查与已有权威源终审的边界。
# 边界：只操作临时治理副本和临时候选元数据，不修改仓库中的正式字典。

require "fileutils"
require "json"
require "open3"
require "tmpdir"
require "yaml"

SCRIPT_DIR = File.expand_path(__dir__)
VALIDATOR = File.join(SCRIPT_DIR, "validate_metadata.rb")
PLATFORM_FIELDS = %w[document_id source_url created_at updated_at].freeze

def governance_root
  explicit = ENV["QIANLI_KB_ROOT"]
  candidates = [explicit, File.expand_path("../../..", __dir__)].compact.map do |path|
    expanded = File.expand_path(path)
    File.basename(expanded) == "00-知识库治理与索引" ? expanded : File.join(expanded, "00-知识库治理与索引")
  end
  found = candidates.find do |path|
    File.file?(File.join(path, "01-面向AI", "schemas", "02-metadata-schema.yaml"))
  end
  raise "无法定位治理根目录，请设置 QIANLI_KB_ROOT" unless found

  found
end

def assert(condition, message)
  raise message unless condition
end

def base_metadata
  {
    "document_id" => "doc-test-001",
    "title" => "元数据校验器回归测试候选文档",
    "document_type" => "test_report",
    "space_id" => "SPACE-KNOWLEDGE-GOVERNANCE",
    "directory_id" => "DIR-00-014",
    "business_domains" => ["testing_quality"],
    "summary" => "用于回归验证预创建例外与已有权威源终审边界的临时候选元数据。",
    "applies_to" => "元数据校验器本地回归测试",
    "not_applies_to" => "真实业务文档入库审批",
    "owner" => "TEST-OWNER",
    "maintaining_team" => "TEST-KNOWLEDGE-GOVERNANCE",
    "authority_status" => "draft",
    "effective_status" => "not_effective",
    "document_version" => "0.1-test",
    "source_url" => "https://example.invalid/wiki/doc-test-001",
    "source_system" => "feishu_knowledge_base",
    "created_at" => "2026-08-13T10:00:00+08:00",
    "updated_at" => "2026-08-13T10:00:00+08:00",
    "retention_policy" => "test_only",
    "security_level" => "internal",
    "ai_permissions" => {
      "allow_index" => false,
      "allow_answer_citation" => false,
      "allow_model_training" => false
    }
  }
end

def write_yaml(path, value)
  File.write(path, YAML.dump(value), mode: "w", encoding: "UTF-8")
end

def run_validator(metadata_path, governance_root)
  stdout, stderr, status = Open3.capture3(
    "ruby",
    VALIDATOR,
    "--metadata",
    metadata_path,
    "--governance-root",
    governance_root
  )
  payload = JSON.parse(stdout.empty? ? stderr : stdout)
  [payload, status.exitstatus]
end

Dir.mktmpdir("qianli-metadata-validator-") do |tmpdir|
  governance_copy = File.join(tmpdir, "00-知识库治理与索引")
  FileUtils.cp_r(governance_root, governance_copy)

  retention_path = File.join(
    governance_copy,
    "01-面向AI",
    "vocabularies",
    "06-retention-policies.yaml"
  )
  retention = YAML.safe_load(File.read(retention_path, encoding: "UTF-8"))
  retention["values"] = [
    {
      "code" => "test_only",
      "name" => "仅回归测试",
      "definition" => "仅用于临时副本中的校验器回归测试。",
      "aliases" => [],
      "status" => "active",
      "owner" => "TEST-OWNER",
      "effective_at" => "2026-08-13"
    }
  ]
  write_yaml(retention_path, retention)

  cases = []

  pre_create = base_metadata
  PLATFORM_FIELDS.each { |field| pre_create.delete(field) }
  pre_create_path = File.join(tmpdir, "pre-create.yaml")
  write_yaml(
    pre_create_path,
    {
      "admission_context" => {
        "stage" => "pre_create",
        "platform_generated_fields" => PLATFORM_FIELDS
      },
      "metadata" => pre_create
    }
  )
  report, exit_code = run_validator(pre_create_path, governance_copy)
  assert(exit_code.zero?, "预创建合法案例应通过，实际退出码 #{exit_code}")
  assert(report.dig("summary", "pre_create_candidate") == true, "预创建合法案例应成为候选")
  assert(report.dig("summary", "platform_fields_pending") == PLATFORM_FIELDS, "应仅缺少 4 个平台字段")
  cases << "pre_create_allows_only_platform_fields"

  invalid_pending = base_metadata
  invalid_pending.delete("maintaining_team")
  invalid_pending_path = File.join(tmpdir, "invalid-pending.yaml")
  write_yaml(
    invalid_pending_path,
    {
      "admission_context" => {
        "stage" => "pre_create",
        "platform_generated_fields" => ["maintaining_team"]
      },
      "metadata" => invalid_pending
    }
  )
  report, exit_code = run_validator(invalid_pending_path, governance_copy)
  ids = report.fetch("checks").select { |item| item["status"] == "fail" }.map { |item| item["id"] }
  assert(exit_code == 1, "责任字段伪装为平台字段应失败")
  assert(ids.include?("PLATFORM_PENDING_INVALID"), "应报告非法平台待生成字段")
  assert(ids.include?("META_REQUIRED"), "应同时报告缺少责任字段")
  cases << "pre_create_rejects_governance_field_exception"

  existing_with_pending_path = File.join(tmpdir, "existing-with-pending.yaml")
  write_yaml(
    existing_with_pending_path,
    {
      "admission_context" => {
        "stage" => "existing_source",
        "platform_generated_fields" => PLATFORM_FIELDS
      },
      "metadata" => base_metadata
    }
  )
  report, exit_code = run_validator(existing_with_pending_path, governance_copy)
  ids = report.fetch("checks").select { |item| item["status"] == "fail" }.map { |item| item["id"] }
  assert(exit_code == 1, "已有权威源不得声明待生成字段")
  assert(ids.include?("PLATFORM_PENDING_INVALID"), "终审应拒绝平台字段例外")
  cases << "existing_source_rejects_pending_fields"

  final_path = File.join(tmpdir, "final.yaml")
  write_yaml(
    final_path,
    {
      "admission_context" => {
        "stage" => "existing_source",
        "platform_generated_fields" => []
      },
      "metadata" => base_metadata
    }
  )
  report, exit_code = run_validator(final_path, governance_copy)
  assert(exit_code.zero?, "字段完整的已有权威源案例应通过")
  assert(report.dig("summary", "machine_checks_passed") == true, "终审机器检查应通过")
  assert(report.dig("summary", "pre_create_candidate") == false, "终审不得标记为预创建候选")
  cases << "existing_source_requires_complete_metadata"

  index_rules_path = File.join(governance_copy, "01-面向AI", "03-index-admission-rules.yaml")
  index_rules = YAML.safe_load(File.read(index_rules_path, encoding: "UTF-8"))
  index_rules["state_ref"] = "missing-control-manifest.yaml"
  write_yaml(index_rules_path, index_rules)
  report, exit_code = run_validator(final_path, governance_copy)
  assert(exit_code == 2, "失效的运行状态引用应阻断校验")
  assert(report["error"].to_s.include?("state_ref"), "应报告失效的 state_ref")
  cases << "state_ref_must_resolve_to_control_manifest"

  puts JSON.pretty_generate(
    "result" => "passed",
    "cases" => cases,
    "temporary_governance_only" => true
  )
end
