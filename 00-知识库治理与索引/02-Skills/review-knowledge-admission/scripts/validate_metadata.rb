#!/usr/bin/env ruby
# 用途：对候选知识文档元数据执行确定性机器校验，并输出 JSON 报告。
# 边界：脚本不修改文件、不替代内容审查、不判断业务事实，也不代表管理员已经批准入库。
# 依赖：仅使用 Ruby 标准库；治理规则始终从用户指定或自动定位的当前项目读取。

require "date"
require "json"
require "optparse"
require "pathname"
require "uri"
require "yaml"

def load_yaml(path)
  content = File.read(path, encoding: "UTF-8")
  YAML.safe_load(content, [Date, Time], [], false) || {}
rescue ArgumentError
  YAML.safe_load(
    content,
    permitted_classes: [Date, Time],
    permitted_symbols: [],
    aliases: false
  ) || {}
end

def blank?(value)
  value.nil? || (value.respond_to?(:empty?) && value.empty?)
end

def add_check(checks, id, status, message, field = nil)
  item = { "id" => id, "status" => status, "message" => message }
  item["field"] = field if field
  checks << item
end

def normalize_governance_root(path)
  return nil if path.nil? || path.empty?

  expanded = File.expand_path(path)
  return expanded if File.basename(expanded) == "00-知识库治理与索引" && File.directory?(expanded)

  candidate = File.join(expanded, "00-知识库治理与索引")
  File.directory?(candidate) ? candidate : nil
end

def search_upward(start_path)
  current = File.directory?(start_path) ? start_path : File.dirname(start_path)
  Pathname.new(File.expand_path(current)).ascend do |dir|
    found = normalize_governance_root(dir.to_s)
    return found if found
  end
  nil
end

def locate_governance_root(explicit_path, metadata_path)
  candidates = [
    normalize_governance_root(explicit_path),
    normalize_governance_root(ENV["QIANLI_KB_ROOT"]),
    search_upward(metadata_path),
    search_upward(Dir.pwd)
  ]
  candidates.compact.first
end

def valid_date?(value)
  Date.iso8601(value.to_s)
  true
rescue ArgumentError
  false
end

def valid_datetime?(value)
  DateTime.iso8601(value.to_s)
  true
rescue ArgumentError
  false
end

def valid_uri?(value)
  uri = URI.parse(value.to_s)
  !uri.scheme.to_s.empty?
rescue URI::InvalidURIError
  false
end

def validate_scalar(field, value, spec, checks)
  expected = spec["type"]
  type_ok = case expected
            when "string" then value.is_a?(String)
            when "boolean" then value == true || value == false
            when "array" then value.is_a?(Array)
            when "object" then value.is_a?(Hash)
            else true
            end

  unless type_ok
    add_check(checks, "META_TYPE", "fail", "字段类型不符合 Schema，期望 #{expected}。", field)
    return
  end

  if value.is_a?(String)
    if spec["minLength"] && value.length < spec["minLength"]
      add_check(checks, "META_MIN_LENGTH", "fail", "字段长度小于最小要求 #{spec["minLength"]}。", field)
    end
    if spec["maxLength"] && value.length > spec["maxLength"]
      add_check(checks, "META_MAX_LENGTH", "fail", "字段长度超过最大要求 #{spec["maxLength"]}。", field)
    end
  end

  if value.is_a?(Array)
    if spec["minItems"] && value.length < spec["minItems"]
      add_check(checks, "META_MIN_ITEMS", "fail", "字段取值数量少于 #{spec["minItems"]}。", field)
    end
    if spec["maxItems"] && value.length > spec["maxItems"]
      add_check(checks, "META_MAX_ITEMS", "fail", "字段取值数量超过 #{spec["maxItems"]}。", field)
    end
    if spec["uniqueItems"] && value.uniq.length != value.length
      add_check(checks, "META_UNIQUE_ITEMS", "fail", "字段包含重复取值。", field)
    end
  end

  if spec["enum"] && !spec["enum"].include?(value)
    add_check(checks, "META_ENUM", "fail", "字段值不在允许枚举中：#{spec["enum"].join(", ")}。", field)
  end

  case spec["format"]
  when "date"
    add_check(checks, "META_DATE", "fail", "字段不是有效的 YYYY-MM-DD 日期。", field) unless valid_date?(value)
  when "date-time"
    add_check(checks, "META_DATETIME", "fail", "字段不是有效的 ISO 8601 日期时间。", field) unless valid_datetime?(value)
  when "uri"
    add_check(checks, "META_URI", "fail", "字段不是带协议的有效链接。", field) unless valid_uri?(value)
  end
end

def active_codes(vocabulary)
  Array(vocabulary["values"])
    .select { |item| item["status"] == "active" }
    .map { |item| item["code"] }
end

def validate_vocabulary(checks, field, raw_value, vocabulary, multiple: false)
  values = multiple ? Array(raw_value) : [raw_value]
  values = values.reject { |value| blank?(value) }
  return if values.empty?

  codes = active_codes(vocabulary)
  if codes.empty?
    add_check(checks, "VOCAB_EMPTY", "blocked", "受控字典尚无有效值，不能确认该字段。", field)
    return
  end

  invalid = values.reject { |value| codes.include?(value) }
  if invalid.empty?
    add_check(checks, "VOCAB_VALUE", "pass", "字段值存在于有效受控字典中。", field)
  else
    add_check(checks, "VOCAB_VALUE", "fail", "存在未登记或已废弃编码：#{invalid.join(", ")}。", field)
  end
end

options = {}
parser = OptionParser.new do |opts|
  opts.banner = "用法：validate_metadata.rb --metadata FILE [--governance-root DIR]"
  opts.on("--metadata FILE", "候选元数据 YAML 文件") { |value| options[:metadata] = value }
  opts.on("--governance-root DIR", "项目根目录或 00-知识库治理与索引目录") { |value| options[:governance_root] = value }
end

begin
  parser.parse!
  raise OptionParser::MissingArgument, "--metadata" unless options[:metadata]

  metadata_path = File.expand_path(options[:metadata])
  raise "候选元数据文件不存在：#{metadata_path}" unless File.file?(metadata_path)

  governance_root = locate_governance_root(options[:governance_root], metadata_path)
  raise "无法定位 00-知识库治理与索引，请提供 --governance-root" unless governance_root

  ai_root = File.join(governance_root, "01-面向AI")
  metadata_schema = load_yaml(File.join(ai_root, "schemas", "02-metadata-schema.yaml"))
  structure = load_yaml(File.join(ai_root, "01-knowledge-structure.yaml"))
  control_manifest = load_yaml(File.join(ai_root, "00-ai-control-manifest.yaml"))
  index_rules = load_yaml(File.join(ai_root, "03-index-admission-rules.yaml"))
  expected_state_ref = "00-ai-control-manifest.yaml"
  unless index_rules["state_ref"] == expected_state_ref
    raise "索引准入规则 state_ref 必须指向 #{expected_state_ref}"
  end

  operating_mode = control_manifest["operating_mode"]
  production_index_enabled = control_manifest["production_index_enabled"]
  unless %w[governance_validation production].include?(operating_mode)
    raise "AI 启动清单 operating_mode 无效或缺失"
  end
  unless production_index_enabled == true || production_index_enabled == false
    raise "AI 启动清单 production_index_enabled 必须是布尔值"
  end
  if operating_mode == "governance_validation" && production_index_enabled
    raise "治理验证模式不得开启生产索引"
  end

  vocabulary_paths = {
    "document_type" => "01-document-types.yaml",
    "security_level" => "02-security-levels.yaml",
    "business_domains" => "03-business-domains.yaml",
    "systems_platforms" => "04-systems-platforms.yaml",
    "source_system" => "05-source-systems.yaml",
    "retention_policy" => "06-retention-policies.yaml"
  }
  vocabularies = vocabulary_paths.transform_values do |filename|
    load_yaml(File.join(ai_root, "vocabularies", filename))
  end

  loaded_metadata = load_yaml(metadata_path)
  admission_context = loaded_metadata["admission_context"].is_a?(Hash) ? loaded_metadata["admission_context"] : {}
  metadata = loaded_metadata["metadata"].is_a?(Hash) ? loaded_metadata["metadata"] : loaded_metadata
  raise "候选元数据顶层必须是对象" unless metadata.is_a?(Hash)

  checks = []
  admission_stage = admission_context["stage"] || "existing_source"
  declared_platform_fields = Array(admission_context["platform_generated_fields"])
  allowed_platform_fields = %w[document_id source_url created_at updated_at]

  unless %w[pre_create existing_source].include?(admission_stage)
    add_check(checks, "ADMISSION_STAGE", "fail", "admission_context.stage 只能是 pre_create 或 existing_source。", "admission_context.stage")
  end

  invalid_platform_fields = declared_platform_fields - allowed_platform_fields
  unless invalid_platform_fields.empty?
    add_check(
      checks,
      "PLATFORM_PENDING_INVALID",
      "fail",
      "存在不允许作为平台待生成字段的必填项：#{invalid_platform_fields.join(', ')}。",
      "admission_context.platform_generated_fields"
    )
  end

  if admission_stage == "existing_source" && !declared_platform_fields.empty?
    add_check(
      checks,
      "PLATFORM_PENDING_INVALID",
      "fail",
      "已有权威源阶段不得声明平台待生成字段。",
      "admission_context.platform_generated_fields"
    )
  end

  required = Array(metadata_schema["required"])
  missing = required.select { |field| !metadata.key?(field) || blank?(metadata[field]) }
  platform_pending_missing = if admission_stage == "pre_create"
                               missing & declared_platform_fields & allowed_platform_fields
                             else
                               []
                             end
  governance_blocked_missing = missing.select do |field|
    vocabularies.key?(field) && active_codes(vocabularies[field]).empty?
  end
  document_missing = missing - governance_blocked_missing - platform_pending_missing

  if document_missing.empty?
    message = if governance_blocked_missing.empty?
                "基础必填字段完整。"
              else
                "除受控字典治理阻塞字段外，文档侧基础必填字段完整。"
              end
    add_check(checks, "META_REQUIRED", "pass", message)
  else
    add_check(checks, "META_REQUIRED", "fail", "缺少基础必填字段：#{document_missing.join(", ")}。")
  end

  governance_blocked_missing.each do |field|
    add_check(
      checks,
      "VOCAB_EMPTY",
      "blocked",
      "受控字典尚无有效值，当前无法填写该必填字段；需先完成字典治理。",
      field
    )
  end

  platform_pending_missing.each do |field|
    add_check(
      checks,
      "PLATFORM_PENDING",
      "info",
      "预创建阶段允许暂缺该平台生成字段；受控创建后必须回填并执行最终审查。",
      field
    )
  end

  allowed_fields = metadata_schema.fetch("properties", {}).keys
  unknown_fields = metadata.keys - allowed_fields
  if unknown_fields.empty?
    add_check(checks, "META_UNKNOWN", "pass", "没有 Schema 之外的字段。")
  else
    add_check(checks, "META_UNKNOWN", "fail", "存在未定义字段：#{unknown_fields.join(", ")}。")
  end

  metadata_schema.fetch("properties", {}).each do |field, spec|
    next unless metadata.key?(field) && !metadata[field].nil?

    validate_scalar(field, metadata[field], spec, checks)
  end

  ai_permissions = metadata["ai_permissions"]
  if ai_permissions.is_a?(Hash)
    required_permissions = %w[allow_index allow_answer_citation allow_model_training]
    missing_permissions = required_permissions.reject { |field| ai_permissions.key?(field) }
    if missing_permissions.empty?
      add_check(checks, "META_AI_PERMISSIONS", "pass", "三个 AI 权限字段完整。", "ai_permissions")
    else
      add_check(checks, "META_AI_PERMISSIONS", "fail", "缺少 AI 权限字段：#{missing_permissions.join(", ")}。", "ai_permissions")
    end
    ai_permissions.each do |field, value|
      unless required_permissions.include?(field)
        add_check(checks, "META_AI_PERMISSION_UNKNOWN", "fail", "存在未定义 AI 权限字段。", "ai_permissions.#{field}")
      end
      unless value == true || value == false
        add_check(checks, "META_AI_PERMISSION_TYPE", "fail", "AI 权限必须为布尔值。", "ai_permissions.#{field}")
      end
    end
  end

  if metadata["authority_status"] == "formal"
    formal_required = %w[topic_id approver effective_at review_due]
    missing_formal = formal_required.select { |field| blank?(metadata[field]) }
    if missing_formal.empty?
      add_check(checks, "META_FORMAL", "pass", "正式文档条件字段完整。")
    else
      add_check(checks, "META_FORMAL", "fail", "正式文档缺少：#{missing_formal.join(", ")}。")
    end
  end

  if metadata["authority_status"] == "deprecated"
    if blank?(metadata["replacement_document_id"]) && blank?(metadata["deprecation_reason"])
      add_check(checks, "META_DEPRECATED", "fail", "废弃文档必须填写替代文档或废弃原因。")
    else
      add_check(checks, "META_DEPRECATED", "pass", "废弃文档后续去向已说明。")
    end
  end

  if ai_permissions.is_a?(Hash) && ai_permissions["allow_index"] == true && blank?(metadata["acl_ref"])
    add_check(checks, "META_INDEX_ACL", "fail", "允许建立索引时必须提供 acl_ref。", "acl_ref")
  end

  space = Array(structure["spaces"]).find { |item| item["space_id"] == metadata["space_id"] }
  if space
    add_check(checks, "STRUCTURE_SPACE", "pass", "空间ID已登记。", "space_id")
    directory = Array(space["directories"]).find { |item| item["directory_id"] == metadata["directory_id"] }
    if directory
      add_check(checks, "STRUCTURE_DIRECTORY", "pass", "目录ID属于所选空间。", "directory_id")
      if directory["active_knowledge_allowed"] == false
        add_check(checks, "STRUCTURE_ACTIVE", "fail", "所选目录不允许承载当前有效知识。", "directory_id")
      end
      if directory["index_policy"] == "deny" && ai_permissions.is_a?(Hash) && ai_permissions["allow_index"] == true
        add_check(checks, "STRUCTURE_INDEX_POLICY", "fail", "目录禁止索引，但元数据允许建立索引。", "directory_id")
      end
    else
      add_check(checks, "STRUCTURE_DIRECTORY", "fail", "目录ID不存在或不属于所选空间。", "directory_id")
    end
  else
    add_check(checks, "STRUCTURE_SPACE", "fail", "空间ID未在机器蓝图中登记。", "space_id")
  end

  validate_vocabulary(checks, "document_type", metadata["document_type"], vocabularies["document_type"])
  validate_vocabulary(checks, "security_level", metadata["security_level"], vocabularies["security_level"])
  validate_vocabulary(checks, "business_domains", metadata["business_domains"], vocabularies["business_domains"], multiple: true)
  validate_vocabulary(checks, "systems_platforms", metadata["systems_platforms"], vocabularies["systems_platforms"], multiple: true)
  validate_vocabulary(checks, "source_system", metadata["source_system"], vocabularies["source_system"])
  validate_vocabulary(checks, "retention_policy", metadata["retention_policy"], vocabularies["retention_policy"])

  add_check(
    checks,
    "MODE",
    "info",
    production_index_enabled ? "生产索引开关已开启，仍需人工审查和管理员批准。" : "当前仅做治理验证，生产索引关闭。"
  )

  if !production_index_enabled && ai_permissions.is_a?(Hash) && ai_permissions.values.any?(true)
    add_check(checks, "MODE_AI_PERMISSIONS", "fail", "治理验证模式下三个 AI 权限必须全部为 false。", "ai_permissions")
  end

  failed = checks.count { |item| item["status"] == "fail" }
  blocked = checks.count { |item| item["status"] == "blocked" }
  machine_checks_passed = failed.zero? && blocked.zero?
  production_index_candidate = machine_checks_passed &&
                               admission_stage == "existing_source" &&
                               production_index_enabled &&
                               metadata["authority_status"] == "formal" &&
                               metadata["effective_status"] == "effective" &&
                               ai_permissions.is_a?(Hash) &&
                               ai_permissions["allow_index"] == true &&
                               ai_permissions["allow_answer_citation"] == true

  report = {
    "schema_version" => "1.0",
    "metadata_path" => metadata_path,
    "governance_root" => governance_root,
    "operating_mode" => operating_mode,
    "production_index_enabled" => production_index_enabled,
    "admission_stage" => admission_stage,
    "checks" => checks,
    "summary" => {
      "passed" => checks.count { |item| item["status"] == "pass" },
      "failed" => failed,
      "blocked" => blocked,
      "information" => checks.count { |item| item["status"] == "info" },
      "machine_checks_passed" => machine_checks_passed,
      "platform_fields_pending" => platform_pending_missing,
      "pre_create_candidate" => machine_checks_passed && admission_stage == "pre_create",
      "production_index_candidate" => production_index_candidate,
      "human_review_required" => true
    }
  }

  puts JSON.pretty_generate(report)
  exit(machine_checks_passed ? 0 : 1)
rescue StandardError => e
  warn JSON.pretty_generate(
    "schema_version" => "1.0",
    "error" => e.message,
    "human_review_required" => true
  )
  exit 2
end
