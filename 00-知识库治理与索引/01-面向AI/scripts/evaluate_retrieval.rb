#!/usr/bin/env ruby
# 用途：将离线检索结果与审批评测用例逐项核对，计算权限、引用、行为和权威来源指标。
# 边界：不发起真实查询；只读取本地用例和结果，空用例集不产生质量通过声明。

require "date"
require "json"
require "optparse"
require "set"
require "time"
require "yaml"

def load_data(path)
  content = File.read(path, encoding: "UTF-8")
  if File.extname(path).downcase == ".json"
    JSON.parse(content)
  else
    YAML.safe_load(content, permitted_classes: [Date, Time], permitted_symbols: [], aliases: false) || {}
  end
end

def add_finding(findings, id, message, locator = nil)
  item = { "id" => id, "message" => message }
  item["locator"] = locator if locator
  findings << item
end

def duplicate_values(values)
  values.group_by(&:itself).select { |value, entries| !value.nil? && entries.length > 1 }.keys
end

def percentage(numerator, denominator)
  return nil if denominator.zero?

  ((numerator.to_f / denominator) * 100).round(2)
end

ai_root = File.expand_path("..", __dir__)
options = {
  cases: File.join(ai_root, "07-evaluation-cases.yaml"),
  results: nil
}

OptionParser.new do |parser|
  parser.banner = "用法：evaluate_retrieval.rb [--cases FILE] [--results FILE]"
  parser.on("--cases FILE", "评测用例 YAML") { |value| options[:cases] = File.expand_path(value) }
  parser.on("--results FILE", "离线结果 JSON 或 YAML") { |value| options[:results] = File.expand_path(value) }
end.parse!

begin
  raise "评测用例文件不存在：#{options[:cases]}" unless File.file?(options[:cases])

  case_file = load_data(options[:cases])
  findings = []
  unless case_file["cases"].is_a?(Array)
    add_finding(findings, "CASES_ARRAY_INVALID", "评测用例文件的 cases 必须是数组。", "cases")
  end
  cases = case_file["cases"].is_a?(Array) ? case_file["cases"] : []

  duplicate_values(cases.map { |item| item["case_id"] }).each do |value|
    add_finding(findings, "CASE_ID_DUPLICATE", "评测用例 ID 重复：#{value}", value)
  end
  cases.each do |item|
    unless item.is_a?(Hash)
      add_finding(findings, "CASE_OBJECT_INVALID", "每个评测用例必须是对象。")
      next
    end
    case_id = item["case_id"] || "unknown-case"
    required = %w[case_id question user_role expected_source_ids forbidden_source_ids expected_behavior risk_level]
    required.each do |field|
      add_finding(findings, "CASE_FIELD_MISSING", "评测用例缺少字段：#{field}", case_id) unless item.key?(field)
    end
    expected = Array(item["expected_source_ids"]).to_set
    forbidden = Array(item["forbidden_source_ids"]).to_set
    add_finding(findings, "CASE_SOURCE_CONFLICT", "期望来源和禁止来源存在交集。", case_id) unless (expected & forbidden).empty?
    if item["expected_behavior"] == "answer" && expected.empty?
      add_finding(findings, "ANSWER_CASE_WITHOUT_EXPECTED_SOURCE", "期望回答的用例必须登记至少一个权威来源。", case_id)
    end
  end

  if cases.empty? && options[:results].nil?
    puts JSON.pretty_generate(
      "result" => findings.empty? ? "not_executed" : "failed",
      "reason" => "evaluation_cases_empty",
      "quality_claim_allowed" => false,
      "cases" => 0,
      "findings" => findings
    )
    exit(findings.empty? ? 0 : 1)
  end

  raise "存在评测用例时必须通过 --results 提供离线结果" if options[:results].nil?
  raise "离线结果文件不存在：#{options[:results]}" unless File.file?(options[:results])

  result_file = load_data(options[:results])
  %w[schema_version run_id executed_at control_plane_version index_generation results].each do |field|
    add_finding(findings, "RESULT_FIELD_MISSING", "评测结果缺少字段：#{field}", field) unless result_file.key?(field)
  end
  unless result_file["results"].is_a?(Array)
    add_finding(findings, "RESULTS_ARRAY_INVALID", "评测结果的 results 必须是数组。", "results")
  end
  results = result_file["results"].is_a?(Array) ? result_file["results"] : []
  add_finding(findings, "RESULT_SCHEMA_VERSION", "评测结果 schema_version 必须为 1.0。", "schema_version") unless result_file["schema_version"] == "1.0"
  %w[run_id executed_at control_plane_version].each do |field|
    add_finding(findings, "RESULT_VALUE_INVALID", "评测结果字段不能为空：#{field}", field) unless result_file[field].is_a?(String) && !result_file[field].empty?
  end
  begin
    executed_at = result_file["executed_at"]
    if executed_at.is_a?(String)
      Time.iso8601(executed_at)
      raise ArgumentError unless executed_at.match?(/(?:Z|[+-]\d{2}:\d{2})\z/)
    end
  rescue ArgumentError
    add_finding(findings, "RESULT_TIME_INVALID", "executed_at 必须是带时区的 ISO 8601 日期时间。", "executed_at")
  end

  if cases.empty?
    add_finding(findings, "RESULT_WITHOUT_CASE", "空评测集不得包含评测结果。") unless results.empty?
    puts JSON.pretty_generate(
      "result" => findings.empty? ? "not_executed" : "failed",
      "reason" => "evaluation_cases_empty",
      "quality_claim_allowed" => false,
      "cases" => 0,
      "findings" => findings
    )
    exit(findings.empty? ? 0 : 1)
  end

  unless result_file["index_generation"].is_a?(String) && !result_file["index_generation"].empty?
    add_finding(findings, "INDEX_GENERATION_REQUIRED", "执行真实评测时必须记录非空索引 generation。", "index_generation")
  end

  malformed_results = results.reject { |item| item.is_a?(Hash) }
  malformed_results.each { add_finding(findings, "RESULT_OBJECT_INVALID", "每个评测结果必须是对象。") }
  results = results.select { |item| item.is_a?(Hash) }
  duplicate_values(results.map { |item| item["case_id"] }).each do |value|
    add_finding(findings, "RESULT_CASE_DUPLICATE", "评测结果包含重复用例 ID：#{value}", value)
  end
  result_by_id = results.each_with_object({}) { |item, memo| memo[item["case_id"]] = item }
  case_ids = cases.map { |item| item["case_id"] }.to_set
  result_ids = results.map { |item| item["case_id"] }.to_set
  (case_ids - result_ids).each { |id| add_finding(findings, "CASE_RESULT_MISSING", "评测用例缺少结果。", id) }
  (result_ids - case_ids).each { |id| add_finding(findings, "RESULT_CASE_UNKNOWN", "评测结果引用未知用例。", id) }

  completed = 0
  behavior_matches = 0
  answer_cases = 0
  traceable_answers = 0
  recall_at_5_hits = 0
  top1_hits = 0
  leakage_count = 0

  cases.each do |item|
    case_id = item["case_id"]
    actual = result_by_id[case_id]
    next unless actual

    required = %w[case_id status returned_source_ids cited_source_ids leaked_source_ids answer_behavior]
    required.each do |field|
      add_finding(findings, "RESULT_ITEM_FIELD_MISSING", "单用例结果缺少字段：#{field}", case_id) unless actual.key?(field)
    end
    %w[returned_source_ids cited_source_ids leaked_source_ids].each do |field|
      add_finding(findings, "RESULT_ARRAY_INVALID", "单用例结果字段必须是数组：#{field}", case_id) unless actual[field].is_a?(Array)
    end
    unless %w[answer clarify refuse].include?(actual["answer_behavior"])
      add_finding(findings, "RESULT_BEHAVIOR_INVALID", "answer_behavior 不在允许枚举中。", case_id)
    end
    unless actual["status"] == "completed"
      add_finding(findings, "CASE_NOT_COMPLETED", "评测用例未完成，不能进入质量结论。", case_id)
      next
    end
    completed += 1

    returned = Array(actual["returned_source_ids"])
    cited = Array(actual["cited_source_ids"])
    reported_leaks = Array(actual["leaked_source_ids"])
    expected = Array(item["expected_source_ids"])
    forbidden = Array(item["forbidden_source_ids"])

    leaked = (reported_leaks + (returned & forbidden) + (cited & forbidden)).uniq
    unless leaked.empty?
      leakage_count += leaked.length
      add_finding(findings, "PERMISSION_LEAKAGE", "召回、引用或检测结果包含禁止来源。", case_id)
    end
    unless (cited - returned).empty?
      add_finding(findings, "CITATION_NOT_RETRIEVED", "回答引用了未出现在召回结果中的来源。", case_id)
    end

    if actual["answer_behavior"] == item["expected_behavior"]
      behavior_matches += 1
    else
      add_finding(findings, "ANSWER_BEHAVIOR_MISMATCH", "实际回答行为与期望不一致。", case_id)
    end

    if item["expected_behavior"] == "answer"
      answer_cases += 1
      expected_citations = cited & expected
      if cited.empty? || expected_citations.empty?
        add_finding(findings, "ANSWER_WITHOUT_EXPECTED_CITATION", "回答未引用期望权威来源。", case_id)
      elsif (cited - returned).empty?
        traceable_answers += 1
      end
      recall_at_5_hits += 1 unless (returned.first(5) & expected).empty?
      top1_hits += 1 if !returned.empty? && expected.include?(returned.first)
    elsif item["expected_behavior"] == "refuse" && !cited.empty?
      add_finding(findings, "REFUSAL_WITH_CITATION", "拒答结果不应携带业务来源引用。", case_id)
    end
  end

  metrics = {
    "total_cases" => cases.length,
    "completed_cases" => completed,
    "permission_leakage_count" => leakage_count,
    "behavior_accuracy_percent" => percentage(behavior_matches, cases.length),
    "authoritative_recall_at_5_percent" => percentage(recall_at_5_hits, answer_cases),
    "authoritative_top1_percent" => percentage(top1_hits, answer_cases),
    "citation_traceability_percent" => percentage(traceable_answers, answer_cases)
  }
  passed = findings.empty? && completed == cases.length && cases.length.positive?
  puts JSON.pretty_generate(
    "result" => passed ? "passed" : "failed",
    "quality_claim_allowed" => passed,
    "run_id" => result_file["run_id"],
    "control_plane_version" => result_file["control_plane_version"],
    "index_generation" => result_file["index_generation"],
    "metrics" => metrics,
    "findings" => findings
  )
  exit(passed ? 0 : 1)
rescue StandardError => error
  warn JSON.pretty_generate("result" => "error", "error" => error.message, "quality_claim_allowed" => false)
  exit 2
end
