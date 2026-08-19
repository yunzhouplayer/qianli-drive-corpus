#!/usr/bin/env ruby
# 用途：回归验证离线评测器对空用例、有效结果、权限泄露、缺少引用和缺少结果文件的处理。
# 边界：只操作临时文件，不调用真实检索服务。

require "json"
require "open3"
require "tmpdir"
require "yaml"

EVALUATOR = File.expand_path("evaluate_retrieval.rb", __dir__)

def assert(condition, message)
  raise message unless condition
end

def run_evaluator(cases_path, results_path = nil)
  command = ["ruby", EVALUATOR, "--cases", cases_path]
  command.concat(["--results", results_path]) if results_path
  stdout, stderr, status = Open3.capture3(*command)
  body = JSON.parse(stdout.empty? ? stderr : stdout)
  [status.exitstatus, body]
end

def write_yaml(path, value)
  File.write(path, YAML.dump(value), encoding: "UTF-8")
end

def write_json(path, value)
  File.write(path, JSON.pretty_generate(value), encoding: "UTF-8")
end

Dir.mktmpdir("qianli-retrieval-eval-") do |root|
  cases_path = File.join(root, "cases.yaml")
  results_path = File.join(root, "results.json")
  executed_at = "2026-08-14T10:00:00+08:00"
  tested = []

  empty_cases = {
    "$schema" => "./schemas/06-evaluation-case-schema.yaml",
    "schema_version" => "1.0", "owner" => nil, "updated_at" => nil, "cases" => []
  }
  write_yaml(cases_path, empty_cases)
  code, report = run_evaluator(cases_path)
  assert(code.zero? && report["result"] == "not_executed" && report["quality_claim_allowed"] == false, "空评测集应返回未执行")
  tested << "empty_cases_not_executed"

  cases = Marshal.load(Marshal.dump(empty_cases))
  cases["owner"] = "测试责任人"
  cases["updated_at"] = "2026-08-14"
  cases["cases"] = [
    {
      "case_id" => "EVAL-ANSWER-001", "question" => "测试问题", "user_role" => "employee",
      "expected_source_ids" => ["DOC-A"], "forbidden_source_ids" => ["DOC-X"],
      "expected_behavior" => "answer", "risk_level" => "medium"
    },
    {
      "case_id" => "EVAL-REFUSE-001", "question" => "无权问题", "user_role" => "employee",
      "expected_source_ids" => [], "forbidden_source_ids" => ["DOC-SECRET"],
      "expected_behavior" => "refuse", "risk_level" => "critical"
    }
  ]
  write_yaml(cases_path, cases)

  valid_results = {
    "schema_version" => "1.0", "run_id" => "RUN-001", "executed_at" => executed_at,
    "control_plane_version" => "1.0", "index_generation" => "GEN-001",
    "results" => [
      {
        "case_id" => "EVAL-ANSWER-001", "status" => "completed",
        "returned_source_ids" => ["DOC-A"], "cited_source_ids" => ["DOC-A"],
        "leaked_source_ids" => [], "answer_behavior" => "answer"
      },
      {
        "case_id" => "EVAL-REFUSE-001", "status" => "completed",
        "returned_source_ids" => [], "cited_source_ids" => [],
        "leaked_source_ids" => [], "answer_behavior" => "refuse"
      }
    ]
  }
  write_json(results_path, valid_results)
  code, report = run_evaluator(cases_path, results_path)
  assert(code.zero? && report["result"] == "passed" && report["quality_claim_allowed"] == true, "有效离线评测结果应通过")
  tested << "valid_offline_results"

  leaked = Marshal.load(Marshal.dump(valid_results))
  leaked["results"][1]["returned_source_ids"] = ["DOC-SECRET"]
  write_json(results_path, leaked)
  code, report = run_evaluator(cases_path, results_path)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "PERMISSION_LEAKAGE" }, "禁止来源被召回应判定权限泄露")
  tested << "permission_leakage"

  missing_citation = Marshal.load(Marshal.dump(valid_results))
  missing_citation["results"][0]["cited_source_ids"] = []
  write_json(results_path, missing_citation)
  code, report = run_evaluator(cases_path, results_path)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "ANSWER_WITHOUT_EXPECTED_CITATION" }, "回答缺少权威引用应失败")
  tested << "answer_without_expected_citation"

  missing_generation = Marshal.load(Marshal.dump(valid_results))
  missing_generation["index_generation"] = nil
  write_json(results_path, missing_generation)
  code, report = run_evaluator(cases_path, results_path)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "INDEX_GENERATION_REQUIRED" }, "真实评测缺少索引 generation 应失败")
  tested << "index_generation_required"

  code, report = run_evaluator(cases_path)
  assert(code == 2 && report["result"] == "error", "有用例但没有结果文件应返回错误")
  tested << "results_file_required"

  puts JSON.pretty_generate(
    "result" => "passed",
    "cases" => tested,
    "temporary_files_only" => true
  )
end
