#!/usr/bin/env ruby
# 用途：回归验证 AI 控制面校验器能够通过基线并阻断缺文件、重复 ID、失效 Schema、未知字段和模式冲突。
# 边界：所有变体只写入临时目录，不修改真实治理文件。

require "fileutils"
require "json"
require "open3"
require "tmpdir"
require "yaml"

AI_ROOT = File.expand_path("..", __dir__)
PROJECT_ROOT = File.expand_path("../../..", __dir__)
GOVERNANCE_ROOT = File.dirname(AI_ROOT)
VALIDATOR = File.join(__dir__, "validate_ai_controls.rb")
AI_RELATIVE = "00-知识库治理与索引/01-面向AI"
PROFILE_RELATIVE = "00-知识库治理与索引/03-平台运维/configs/governance-validation-indexing-profile.yaml"

def assert(condition, message)
  raise message unless condition
end

def prepare_case(base, name)
  root = File.join(base, name)
  ai_root = File.join(root, AI_RELATIVE)
  FileUtils.mkdir_p(File.dirname(ai_root))
  FileUtils.cp_r(AI_ROOT, ai_root)
  profile_target = File.join(root, PROFILE_RELATIVE)
  FileUtils.mkdir_p(File.dirname(profile_target))
  FileUtils.cp(File.join(GOVERNANCE_ROOT, "03-平台运维", "configs", "governance-validation-indexing-profile.yaml"), profile_target)
  FileUtils.cp(File.join(PROJECT_ROOT, ".gitignore"), File.join(root, ".gitignore"))
  [root, ai_root]
end

def run_validator(root, ai_root, skip_readme: false)
  command = ["ruby", VALIDATOR, "--ai-root", ai_root, "--project-root", root]
  command << "--skip-readme" if skip_readme
  stdout, stderr, status = Open3.capture3(*command)
  body = JSON.parse(stdout.empty? ? stderr : stdout)
  [status.exitstatus, body]
end

def write_yaml(path, value)
  File.write(path, YAML.dump(value), encoding: "UTF-8")
end

def add_fixture_control(ai_root, control_id, path, schema)
  manifest_path = File.join(ai_root, "00-ai-control-manifest.yaml")
  manifest = YAML.safe_load(File.read(manifest_path, encoding: "UTF-8"), aliases: false)
  manifest["load_sequence"] << {
    "control_id" => control_id,
    "path" => path,
    "format" => "yaml",
    "validation_schema" => schema,
    "phase" => "retrieval"
  }
  write_yaml(manifest_path, manifest)
end

Dir.mktmpdir("qianli-ai-controls-") do |base|
  cases = []

  root, ai_root = prepare_case(base, "valid")
  code, report = run_validator(root, ai_root)
  assert(code.zero? && report["result"] == "passed", "正确控制面应通过")
  cases << "valid_controls"

  root, ai_root = prepare_case(base, "missing-file")
  FileUtils.rm(File.join(ai_root, "10-indexing-policy.yaml"))
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "CONTROL_FILE_MISSING" }, "缺失必需文件应被阻断")
  cases << "missing_required_file"

  root, ai_root = prepare_case(base, "missing-external-profile")
  FileUtils.rm(File.join(root, PROFILE_RELATIVE))
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "CONTROL_FILE_MISSING" }, "治理根目录中的实现配置缺失应被阻断")
  cases << "missing_governance_scoped_profile"

  root, ai_root = prepare_case(base, "duplicate-id")
  manifest_path = File.join(ai_root, "00-ai-control-manifest.yaml")
  manifest = YAML.safe_load(File.read(manifest_path, encoding: "UTF-8"), aliases: false)
  manifest["load_sequence"][1]["control_id"] = manifest["load_sequence"][0]["control_id"]
  write_yaml(manifest_path, manifest)
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "CONTROL_ID_DUPLICATE" }, "重复控制 ID 应被阻断")
  cases << "duplicate_control_id"

  root, ai_root = prepare_case(base, "missing-schema")
  manifest_path = File.join(ai_root, "00-ai-control-manifest.yaml")
  manifest = YAML.safe_load(File.read(manifest_path, encoding: "UTF-8"), aliases: false)
  manifest["load_sequence"].find { |item| item["control_id"] == "authority_sources" }["validation_schema"] = "schemas/missing.yaml"
  write_yaml(manifest_path, manifest)
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "SCHEMA_FILE_MISSING" }, "失效 Schema 引用应被阻断")
  cases << "missing_validation_schema"

  root, ai_root = prepare_case(base, "unknown-field")
  contract_path = File.join(ai_root, "09-retrieval-runtime-contract.yaml")
  contract = YAML.safe_load(File.read(contract_path, encoding: "UTF-8"), aliases: false)
  contract["unsafe_bypass"] = true
  write_yaml(contract_path, contract)
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "SCHEMA_UNKNOWN_FIELD" }, "未知控制字段应被阻断")
  cases << "unknown_control_field"

  root, ai_root = prepare_case(base, "invalid-state-ref")
  contract_path = File.join(ai_root, "09-retrieval-runtime-contract.yaml")
  contract = YAML.safe_load(File.read(contract_path, encoding: "UTF-8"), aliases: false)
  contract["state_ref"] = "missing-control-manifest.yaml"
  write_yaml(contract_path, contract)
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "SCHEMA_CONST" || item["id"] == "CONTROL_STATE_REF_INVALID" }, "失效的运行状态引用应被阻断")
  cases << "invalid_control_state_ref"

  root, ai_root = prepare_case(base, "mode-conflict")
  manifest_path = File.join(ai_root, "00-ai-control-manifest.yaml")
  manifest = YAML.safe_load(File.read(manifest_path, encoding: "UTF-8"), aliases: false)
  manifest["production_index_enabled"] = true
  write_yaml(manifest_path, manifest)
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "PRODUCTION_MODE_CONFLICT" }, "治理验证模式开启生产索引应被阻断")
  cases << "governance_production_conflict"

  root, ai_root = prepare_case(base, "invalid-index-semantics")
  profile_path = File.join(root, PROFILE_RELATIVE)
  profile = YAML.safe_load(File.read(profile_path, encoding: "UTF-8"), aliases: false)
  profile["chunking"]["overlap_tokens"] = profile["chunking"]["max_tokens"]
  write_yaml(profile_path, profile)
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "CHUNK_OVERLAP_INVALID" }, "分块重叠不小于最大块长应被阻断")
  cases << "invalid_chunk_overlap"

  root, ai_root = prepare_case(base, "readme-drift")
  readme_path = File.join(ai_root, "README.md")
  readme = File.read(readme_path, encoding: "UTF-8").sub("当前登记17个正文种子", "当前登记16个正文种子")
  File.write(readme_path, readme, encoding: "UTF-8")
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "README_PUBLICATION_COUNT" }, "README 发布数量漂移应被阻断")
  cases << "readme_publication_count_drift"

  root, ai_root = prepare_case(base, "valid-request-payload")
  request_path = File.join(ai_root, "test-request.yaml")
  request_payload = {
    "schema_version" => "1.0",
    "trace_id" => "TRACE-001",
    "query" => "测试查询",
    "identity_context" => {
      "subject_ref" => "subject-hash",
      "tenant_ref" => "tenant-qianli",
      "group_refs" => ["group-employee"],
      "authenticated_at" => "2026-08-14T10:00:00+08:00",
      "acl_snapshot_version" => "ACL-001"
    },
    "max_results" => 5
  }
  write_yaml(request_path, request_payload)
  add_fixture_control(ai_root, "test_request", "test-request.yaml", "schemas/15-retrieval-request-schema.yaml")
  code, report = run_validator(root, ai_root, skip_readme: true)
  assert(code.zero? && report["result"] == "passed", "符合契约的检索请求应通过")
  cases << "valid_retrieval_request_payload"

  request_payload["identity_context"].delete("acl_snapshot_version")
  write_yaml(request_path, request_payload)
  code, report = run_validator(root, ai_root, skip_readme: true)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "SCHEMA_REQUIRED" }, "缺少 ACL 快照的检索请求应被阻断")
  cases << "request_requires_acl_snapshot"

  root, ai_root = prepare_case(base, "denied-response-leak")
  response_path = File.join(ai_root, "test-response.yaml")
  response_payload = {
    "schema_version" => "1.0",
    "trace_id" => "TRACE-002",
    "status" => "denied",
    "results" => [{
      "document_id" => "DOC-SECRET", "chunk_id" => "CHUNK-1",
      "source_version" => "V1", "score" => 0.9, "citation_ref" => "CIT-1"
    }],
    "citations" => [],
    "control_plane_version" => "1.0",
    "index_generation" => nil,
    "error" => {"code" => "permission_denied", "message" => "无法访问请求范围内的知识。", "retryable" => false}
  }
  write_yaml(response_path, response_payload)
  add_fixture_control(ai_root, "test_response", "test-response.yaml", "schemas/16-retrieval-response-schema.yaml")
  code, report = run_validator(root, ai_root, skip_readme: true)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "SCHEMA_MAX_ITEMS" }, "拒绝响应携带结果应被阻断")
  cases << "denied_response_cannot_expose_results"

  puts JSON.pretty_generate(
    "result" => "passed",
    "cases" => cases,
    "temporary_files_only" => true
  )
end
