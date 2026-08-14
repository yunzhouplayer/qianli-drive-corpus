#!/usr/bin/env ruby
# 用途：统一校验 AI 控制文件、项目内 JSON Schema、加载顺序和跨文件引用。
# 边界：只读，不连接飞书、索引服务或外部网络；仅使用 Ruby 标准库。

require "date"
require "json"
require "optparse"
require "pathname"
require "set"
require "time"
require "uri"
require "yaml"

def load_yaml(path)
  content = File.read(path, encoding: "UTF-8")
  YAML.safe_load(content, permitted_classes: [Date, Time], permitted_symbols: [], aliases: false) || {}
end

def add_finding(findings, id, message, locator = nil)
  item = { "id" => id, "message" => message }
  item["locator"] = locator if locator
  findings << item
end

def normalized_relative_path(value)
  return nil unless value.is_a?(String) && !value.empty?

  path = Pathname.new(value)
  return nil if path.absolute?

  cleaned = path.cleanpath.to_s
  return nil if cleaned == "." || cleaned == ".." || cleaned.start_with?("../")

  cleaned
end

def duplicate_values(items)
  items.group_by(&:itself).select { |value, entries| !value.nil? && entries.length > 1 }.keys
end

def schema_type_match?(value, type)
  case type
  when "object" then value.is_a?(Hash)
  when "array" then value.is_a?(Array)
  when "string" then value.is_a?(String)
  when "integer" then value.is_a?(Integer)
  when "number" then value.is_a?(Numeric)
  when "boolean" then value == true || value == false
  when "null" then value.nil?
  else true
  end
end

def resolve_pointer(root_schema, reference)
  return nil unless reference.start_with?("#/")

  reference.delete_prefix("#/").split("/").reduce(root_schema) do |current, token|
    break nil unless current.is_a?(Hash)

    current[token.gsub("~1", "/").gsub("~0", "~")]
  end
end

def valid_format?(value, format)
  case format
  when "date"
    Date.iso8601(value)
  when "date-time"
    Time.iso8601(value)
  when "uri"
    uri = URI.parse(value)
    raise URI::InvalidURIError unless uri.absolute?
  end
  true
rescue ArgumentError, URI::InvalidURIError
  false
end

def validate_schema(value, schema, root_schema, locator, findings)
  return unless schema.is_a?(Hash)

  if schema["$ref"]
    target = resolve_pointer(root_schema, schema["$ref"])
    if target
      validate_schema(value, target, root_schema, locator, findings)
    else
      add_finding(findings, "SCHEMA_REF_INVALID", "无法解析内部 Schema 引用：#{schema["$ref"]}", locator)
    end
    return
  end

  Array(schema["allOf"]).each { |part| validate_schema(value, part, root_schema, locator, findings) }

  if schema["if"].is_a?(Hash)
    condition_findings = []
    validate_schema(value, schema["if"], root_schema, locator, condition_findings)
    branch = condition_findings.empty? ? schema["then"] : schema["else"]
    validate_schema(value, branch, root_schema, locator, findings) if branch.is_a?(Hash)
  end

  if schema["oneOf"].is_a?(Array)
    matches = schema["oneOf"].count do |option|
      local = []
      validate_schema(value, option, root_schema, locator, local)
      local.empty?
    end
    add_finding(findings, "SCHEMA_ONE_OF", "字段必须且只能匹配一个候选结构。", locator) unless matches == 1
    return unless matches == 1
  end

  types = Array(schema["type"])
  unless types.empty? || types.any? { |type| schema_type_match?(value, type) }
    add_finding(findings, "SCHEMA_TYPE", "字段类型不符合 Schema，期望 #{types.join(" 或 ")}。", locator)
    return
  end

  if schema.key?("const") && value != schema["const"]
    add_finding(findings, "SCHEMA_CONST", "字段必须等于 #{schema["const"].inspect}。", locator)
  end
  if schema["enum"].is_a?(Array) && !schema["enum"].include?(value)
    add_finding(findings, "SCHEMA_ENUM", "字段值不在允许枚举中。", locator)
  end

  if value.is_a?(String)
    add_finding(findings, "SCHEMA_MIN_LENGTH", "字符串长度小于最小要求。", locator) if schema["minLength"] && value.length < schema["minLength"]
    add_finding(findings, "SCHEMA_MAX_LENGTH", "字符串长度超过最大要求。", locator) if schema["maxLength"] && value.length > schema["maxLength"]
    if schema["pattern"] && !Regexp.new(schema["pattern"]).match?(value)
      add_finding(findings, "SCHEMA_PATTERN", "字符串不符合格式模式。", locator)
    end
    if schema["format"] && !valid_format?(value, schema["format"])
      add_finding(findings, "SCHEMA_FORMAT", "字符串不符合 #{schema["format"]} 格式。", locator)
    end
  end

  if value.is_a?(Numeric)
    add_finding(findings, "SCHEMA_MINIMUM", "数值小于最小值。", locator) if schema["minimum"] && value < schema["minimum"]
    add_finding(findings, "SCHEMA_MAXIMUM", "数值超过最大值。", locator) if schema["maximum"] && value > schema["maximum"]
  end

  if value.is_a?(Array)
    add_finding(findings, "SCHEMA_MIN_ITEMS", "数组元素数量不足。", locator) if schema["minItems"] && value.length < schema["minItems"]
    add_finding(findings, "SCHEMA_MAX_ITEMS", "数组元素数量过多。", locator) if schema["maxItems"] && value.length > schema["maxItems"]
    if schema["uniqueItems"] && value.map { |item| JSON.generate(item) }.uniq.length != value.length
      add_finding(findings, "SCHEMA_UNIQUE_ITEMS", "数组包含重复元素。", locator)
    end
    value.each_with_index do |item, index|
      validate_schema(item, schema["items"], root_schema, "#{locator}[#{index}]", findings) if schema["items"]
    end
  end

  return unless value.is_a?(Hash)

  Array(schema["required"]).each do |field|
    add_finding(findings, "SCHEMA_REQUIRED", "缺少必填字段：#{field}", "#{locator}.#{field}") unless value.key?(field)
  end
  properties = schema["properties"].is_a?(Hash) ? schema["properties"] : {}
  value.each do |field, child|
    if properties.key?(field)
      validate_schema(child, properties[field], root_schema, "#{locator}.#{field}", findings)
    elsif schema["additionalProperties"] == false
      add_finding(findings, "SCHEMA_UNKNOWN_FIELD", "存在 Schema 未定义字段：#{field}", "#{locator}.#{field}")
    elsif schema["additionalProperties"].is_a?(Hash)
      validate_schema(child, schema["additionalProperties"], root_schema, "#{locator}.#{field}", findings)
    end
  end
end

def validate_file_against_schema(instance_path, schema_path, findings, locator)
  instance = load_yaml(instance_path)
  schema = load_yaml(schema_path)
  validate_schema(instance, schema, schema, locator, findings)
  instance
rescue Psych::Exception => error
  add_finding(findings, "YAML_PARSE_ERROR", error.message, locator)
  nil
rescue StandardError => error
  add_finding(findings, "CONTROL_READ_ERROR", error.message, locator)
  nil
end

script_root = File.expand_path("..", __dir__)
default_project_root = File.expand_path("../../..", __dir__)
options = { ai_root: script_root, project_root: default_project_root, check_readme: true }

OptionParser.new do |parser|
  parser.banner = "用法：validate_ai_controls.rb [--ai-root DIR] [--project-root DIR] [--skip-readme]"
  parser.on("--ai-root DIR", "01-面向AI 目录") { |value| options[:ai_root] = File.expand_path(value) }
  parser.on("--project-root DIR", "项目根目录") { |value| options[:project_root] = File.expand_path(value) }
  parser.on("--skip-readme", "跳过 README 清单漂移检查") { options[:check_readme] = false }
end.parse!

begin
  raise "AI 控制目录不存在：#{options[:ai_root]}" unless File.directory?(options[:ai_root])
  raise "项目根目录不存在：#{options[:project_root]}" unless File.directory?(options[:project_root])

  findings = []
  manifest_path = File.join(options[:ai_root], "00-ai-control-manifest.yaml")
  manifest_schema_path = File.join(options[:ai_root], "schemas/07-ai-control-manifest-schema.yaml")
  unless File.file?(manifest_path)
    add_finding(findings, "CONTROL_MANIFEST_MISSING", "AI 启动清单不存在。", manifest_path)
    raise "无法继续：AI 启动清单不存在"
  end
  unless File.file?(manifest_schema_path)
    add_finding(findings, "CONTROL_MANIFEST_SCHEMA_MISSING", "AI 启动清单 Schema 不存在。", manifest_schema_path)
    raise "无法继续：AI 启动清单 Schema 不存在"
  end

  manifest = validate_file_against_schema(manifest_path, manifest_schema_path, findings, "00-ai-control-manifest.yaml") || {}
  controls = Array(manifest["load_sequence"])

  duplicate_values(controls.map { |item| item["control_id"] }).each do |value|
    add_finding(findings, "CONTROL_ID_DUPLICATE", "控制文件 ID 重复：#{value}", value)
  end
  duplicate_values(controls.map { |item| item["path"] }).each do |value|
    add_finding(findings, "CONTROL_PATH_DUPLICATE", "控制文件路径重复：#{value}", value)
  end
  loaded = {}
  controls.each do |control|
    control_id = control["control_id"] || "unknown-control"
    relative_path = normalized_relative_path(control["path"])
    if relative_path.nil?
      add_finding(findings, "CONTROL_PATH_INVALID", "控制文件必须使用规范化的目录内相对路径。", control_id)
      next
    end

    path_scope = control["path_scope"] || manifest.dig("path_policy", "default_scope") || "ai_root"
    path_base = case path_scope
                when "ai_root" then options[:ai_root]
                when "governance_root" then File.dirname(options[:ai_root])
                else
                  add_finding(findings, "CONTROL_PATH_SCOPE_INVALID", "控制文件使用了未允许的路径作用域。", control_id)
                  next
                end
    instance_path = File.join(path_base, relative_path)
    unless File.file?(instance_path)
      add_finding(findings, "CONTROL_FILE_MISSING", "启动清单登记的必需控制文件不存在。", relative_path)
      next
    end

    schema_relative = control["validation_schema"]
    if schema_relative
      normalized_schema = normalized_relative_path(schema_relative)
      if normalized_schema.nil?
        add_finding(findings, "SCHEMA_PATH_INVALID", "Schema 必须使用规范化的目录内相对路径。", control_id)
        next
      end
      schema_path = File.join(options[:ai_root], normalized_schema)
      unless File.file?(schema_path)
        add_finding(findings, "SCHEMA_FILE_MISSING", "控制文件引用的 Schema 不存在。", schema_relative)
        next
      end
      loaded[control_id] = validate_file_against_schema(instance_path, schema_path, findings, relative_path)
    elsif control["format"] == "json_schema"
      schema = load_yaml(instance_path)
      unless schema["$schema"] == "https://json-schema.org/draft/2020-12/schema" && schema["$id"].is_a?(String)
        add_finding(findings, "JSON_SCHEMA_HEADER_INVALID", "Schema 必须声明 Draft 2020-12 和稳定 $id。", relative_path)
      end
      loaded[control_id] = schema
    else
      loaded[control_id] = load_yaml(instance_path) if control["format"] == "yaml"
    end
  rescue Psych::Exception => error
    add_finding(findings, "YAML_PARSE_ERROR", error.message, relative_path || control_id)
  rescue StandardError => error
    add_finding(findings, "CONTROL_READ_ERROR", error.message, relative_path || control_id)
  end

  admission = loaded["index_admission"] || load_yaml(File.join(options[:ai_root], "03-index-admission-rules.yaml"))
  expected_state_ref = File.basename(manifest_path)
  state_refs = {
    "index_admission" => admission["state_ref"],
    "retrieval_contract" => loaded.dig("retrieval_runtime_contract", "state_ref"),
    "indexing_policy" => loaded.dig("indexing_policy", "state_ref")
  }
  state_refs.each do |control_id, value|
    unless value == expected_state_ref
      add_finding(findings, "CONTROL_STATE_REF_INVALID", "下游控制文件必须引用唯一启动清单 #{expected_state_ref}。", control_id)
    end
  end

  if manifest["operating_mode"] == "governance_validation"
    add_finding(findings, "PRODUCTION_MODE_CONFLICT", "治理验证模式必须关闭生产索引全局开关。") unless manifest["production_index_enabled"] == false
    unless Array(loaded.dig("corpus_manifest", "documents")).empty?
      add_finding(findings, "GOVERNANCE_CORPUS_NOT_EMPTY", "治理验证模式下生产语料清单必须为空。")
    end
  elsif manifest["operating_mode"] == "production" && manifest["production_index_enabled"] != true
    add_finding(findings, "PRODUCTION_MODE_CONFLICT", "生产模式必须显式开启生产索引全局开关。")
  end

  indexing_policy = loaded["indexing_policy"] || {}
  indexing_profile = loaded["indexing_profile"] || {}
  unless indexing_policy["implementation_profile_ref"] == controls.find { |item| item["control_id"] == "indexing_profile" }&.dig("path")
    add_finding(findings, "INDEXING_PROFILE_REF_INVALID", "索引策略没有引用启动清单登记的实现配置。")
  end
  unless indexing_policy["implementation_profile_schema_ref"] == "01-面向AI/schemas/17-indexing-profile-schema.yaml"
    add_finding(findings, "INDEXING_PROFILE_SCHEMA_REF_INVALID", "索引策略没有引用受控实现配置 Schema。")
  end
  unless indexing_profile["intended_mode"] == manifest["operating_mode"]
    add_finding(findings, "INDEXING_PROFILE_MODE_MISMATCH", "索引实现配置的 intended_mode 与启动清单不一致。")
  end
  if manifest["operating_mode"] == "governance_validation" && indexing_profile["validation_only"] != true
    add_finding(findings, "INDEXING_PROFILE_VALIDATION_FLAG", "治理验证配置必须标记 validation_only=true。")
  end

  max_tokens = indexing_profile.dig("chunking", "max_tokens")
  overlap_tokens = indexing_profile.dig("chunking", "overlap_tokens")
  if max_tokens.is_a?(Numeric) && overlap_tokens.is_a?(Numeric) && overlap_tokens >= max_tokens
    add_finding(findings, "CHUNK_OVERLAP_INVALID", "分块重叠 Token 必须小于单块最大 Token。")
  end
  candidate_top_k = indexing_profile.dig("retrieval", "candidate_top_k")
  final_top_k = indexing_profile.dig("retrieval", "final_top_k")
  if candidate_top_k.is_a?(Numeric) && final_top_k.is_a?(Numeric) && final_top_k > candidate_top_k
    add_finding(findings, "RETRIEVAL_TOP_K_INVALID", "最终结果数不能大于候选结果数。")
  end
  keyword_weight = indexing_profile.dig("retrieval", "keyword_weight")
  vector_weight = indexing_profile.dig("retrieval", "vector_weight")
  if keyword_weight.is_a?(Numeric) && vector_weight.is_a?(Numeric) && (keyword_weight + vector_weight - 1.0).abs > 0.000_001
    add_finding(findings, "RETRIEVAL_WEIGHT_INVALID", "关键词与向量融合权重之和必须为 1。")
  end
  if manifest["production_index_enabled"] == true
    production_requirements = {
      "validation_only=false" => indexing_profile["validation_only"] == false,
      "tokenizer_ref" => indexing_profile.dig("chunking", "tokenizer_ref"),
      "embedding_model_ref" => indexing_profile.dig("retrieval", "embedding_model_ref"),
      "minimum_score" => indexing_profile.dig("retrieval", "minimum_score")
    }
    production_requirements.each do |field, value|
      add_finding(findings, "PRODUCTION_CONFIG_MISSING", "生产启用缺少已验证配置：#{field}", field) if value.nil? || value == "" || value == false
    end
  end

  structure = loaded["knowledge_structure"] || {}
  spaces = Array(structure["spaces"])
  space_ids = spaces.map { |item| item["space_id"] }.to_set
  directory_ids = spaces.flat_map { |item| Array(item["directories"]).map { |directory| directory["directory_id"] } }.to_set
  directory_space = spaces.each_with_object({}) do |space, memo|
    Array(space["directories"]).each { |directory| memo[directory["directory_id"]] = space["space_id"] }
  end
  corpus_documents = Array(loaded.dig("corpus_manifest", "documents"))
  duplicate_values(corpus_documents.map { |item| item["document_id"] }).each do |value|
    add_finding(findings, "CORPUS_DOCUMENT_DUPLICATE", "语料清单文档 ID 重复：#{value}", value)
  end
  corpus_documents.each do |document|
    add_finding(findings, "CORPUS_SPACE_UNKNOWN", "语料文档引用未登记空间。", document["document_id"]) unless space_ids.include?(document["space_id"])
    add_finding(findings, "CORPUS_DIRECTORY_UNKNOWN", "语料文档引用未登记目录。", document["document_id"]) unless directory_ids.include?(document["directory_id"])
    if directory_space.key?(document["directory_id"]) && directory_space[document["directory_id"]] != document["space_id"]
      add_finding(findings, "CORPUS_DIRECTORY_SPACE_MISMATCH", "语料文档的目录不属于所填空间。", document["document_id"])
    end
  end

  authority_entries = Array(loaded.dig("authority_sources", "entries"))
  authority_scopes = authority_entries.map { |item| [item["topic_id"], item["applies_to"]] }
  duplicate_values(authority_scopes).each do |value|
    add_finding(findings, "AUTHORITY_SCOPE_DUPLICATE", "同一主题和适用范围存在多个权威来源：#{value.join(" / ")}", value.join(" / "))
  end
  authority_document_ids = authority_entries.map { |item| item["authoritative_document_id"] }.to_set
  corpus_document_ids = corpus_documents.map { |item| item["document_id"] }.to_set

  evaluation_cases = Array(loaded.dig("evaluation_cases", "cases"))
  duplicate_values(evaluation_cases.map { |item| item["case_id"] }).each do |value|
    add_finding(findings, "EVALUATION_CASE_DUPLICATE", "评测用例 ID 重复：#{value}", value)
  end
  evaluation_cases.each do |item|
    expected = Array(item["expected_source_ids"]).to_set
    forbidden = Array(item["forbidden_source_ids"]).to_set
    unless (expected & forbidden).empty?
      add_finding(findings, "EVALUATION_SOURCE_CONFLICT", "同一来源不能同时是期望来源和禁止来源。", item["case_id"])
    end
    known = authority_document_ids | corpus_document_ids
    (expected | forbidden).each do |document_id|
      add_finding(findings, "EVALUATION_SOURCE_UNKNOWN", "评测用例引用未登记文档：#{document_id}", item["case_id"]) unless known.include?(document_id)
    end
  end

  controls.select { |item| item["phase"] == "vocabulary" && item["format"] == "yaml" }.each do |control|
    values = Array(loaded.dig(control["control_id"], "values"))
    duplicate_values(values.map { |item| item["code"] }).each do |value|
      add_finding(findings, "VOCABULARY_CODE_DUPLICATE", "受控字典编码重复：#{value}", control["path"])
    end
  end

  runtime_root = manifest.dig("runtime_state", "root")
  gitignore_path = File.join(options[:project_root], ".gitignore")
  if runtime_root && (!File.file?(gitignore_path) || !File.read(gitignore_path, encoding: "UTF-8").include?("#{runtime_root}/"))
    add_finding(findings, "RUNTIME_NOT_IGNORED", "运行态目录未在 .gitignore 中显式忽略。", runtime_root)
  end

  if options[:check_readme]
    readme_path = File.join(options[:ai_root], "README.md")
    if File.file?(readme_path)
      readme = File.read(readme_path, encoding: "UTF-8")
      controls.each do |control|
        add_finding(findings, "README_CONTROL_MISSING", "README 未登记启动清单中的控制文件。", control["path"]) unless readme.include?(control["path"].to_s)
      end
      publication_path = File.join(options[:ai_root], "10-feishu-publication-manifest.json")
      if File.file?(publication_path)
        publication = JSON.parse(File.read(publication_path, encoding: "UTF-8"))
        files_count = Array(publication["files"]).length
        roots_count = Array(publication["directory_roots"]).length
        unless readme.include?("当前登记#{files_count}个正文种子和#{roots_count}个业务目录根")
          add_finding(findings, "README_PUBLICATION_COUNT", "README 中飞书发布数量与发布清单不一致。")
        end
      end
    else
      add_finding(findings, "README_MISSING", "面向 AI 的 README 不存在。", readme_path)
    end
  end

  result = {
    "result" => findings.empty? ? "passed" : "failed",
    "operating_mode" => manifest["operating_mode"],
    "production_index_enabled" => manifest["production_index_enabled"],
    "controls" => controls.length,
    "schemas" => controls.count { |item| item["format"] == "json_schema" } + controls.map { |item| item["validation_schema"] }.compact.uniq.length,
    "authority_entries" => authority_entries.length,
    "corpus_documents" => corpus_documents.length,
    "evaluation_cases" => evaluation_cases.length,
    "findings" => findings
  }
  puts JSON.pretty_generate(result)
  exit(findings.empty? ? 0 : 1)
rescue StandardError => error
  result = { "result" => "error", "error" => error.message }
  result["findings"] = findings if defined?(findings) && findings.any?
  warn JSON.pretty_generate(result)
  exit 2
end
