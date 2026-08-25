#!/usr/bin/env ruby
# 用途：回归验证 AI 控制面校验器能够通过基线并阻断缺文件、重复 ID、失效 Schema、未知字段和模式冲突。
# 边界：所有变体只写入临时目录，不修改真实治理文件。

require "fileutils"
require "json"
require "open3"
require "tmpdir"
require "yaml"

PROJECT_ROOT = File.expand_path("../../..", __dir__)
GOVERNANCE_ROOT = File.join(PROJECT_ROOT, "00-知识库治理与索引")
AI_ROOT = File.join(GOVERNANCE_ROOT, "01-面向AI")
VALIDATOR = File.join(__dir__, "validate_ai_controls.rb")
AI_RELATIVE = "00-知识库治理与索引/01-面向AI"
PROFILE_RELATIVE = "00-知识库治理与索引/03-平台运维/configs/governance-validation-indexing-profile.yaml"
PUBLICATION_RELATIVE = "00-知识库治理与索引/03-平台运维/02-feishu-publication-manifest.json"
BINDING_RELATIVE = "00-知识库治理与索引/03-平台运维/03-feishu-space-bindings.yaml"
BINDING_SCHEMA_RELATIVE = "00-知识库治理与索引/03-平台运维/schemas/03-feishu-space-bindings-schema.yaml"

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
  publication_target = File.join(root, PUBLICATION_RELATIVE)
  FileUtils.mkdir_p(File.dirname(publication_target))
  FileUtils.cp(File.join(GOVERNANCE_ROOT, "03-平台运维", "02-feishu-publication-manifest.json"), publication_target)
  [BINDING_RELATIVE, BINDING_SCHEMA_RELATIVE].each do |relative|
    target = File.join(root, relative)
    FileUtils.mkdir_p(File.dirname(target))
    FileUtils.cp(File.join(PROJECT_ROOT, relative), target)
  end
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

  root, ai_root = prepare_case(base, "binding-write-enabled")
  binding_path = File.join(root, BINDING_RELATIVE)
  binding = YAML.safe_load(File.read(binding_path, encoding: "UTF-8"), aliases: false)
  binding["bindings"][0]["controls"]["write_allowed"] = true
  write_yaml(binding_path, binding)
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "SCHEMA_CONST" }, "外部知识树绑定不得开启写入")
  cases << "external_binding_write_denied"

  root, ai_root = prepare_case(base, "stale-binding-with-locator")
  binding_path = File.join(root, BINDING_RELATIVE)
  binding = YAML.safe_load(File.read(binding_path, encoding: "UTF-8"), aliases: false)
  binding["bindings"][0]["remote_locator"] = { "space_id" => "space-test", "root_node_token" => "node-test" }
  write_yaml(binding_path, binding)
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "FEISHU_BINDING_STALE_LOCATOR" }, "过期绑定不得保留远端定位符")
  cases << "stale_external_binding_locator_denied"

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

  root, ai_root = prepare_case(base, "readme-publication-link-drift")
  readme_path = File.join(ai_root, "README.md")
  readme = File.read(readme_path, encoding: "UTF-8").sub(
    "../03-平台运维/02-feishu-publication-manifest.json",
    "../03-平台运维/不存在的发布清单.json"
  )
  File.write(readme_path, readme, encoding: "UTF-8")
  code, report = run_validator(root, ai_root)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "README_PUBLICATION_LINK" }, "README 发布清单链接漂移应被阻断")
  cases << "readme_publication_link_drift"

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
