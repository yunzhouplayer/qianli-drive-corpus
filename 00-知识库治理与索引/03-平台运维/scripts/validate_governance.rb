#!/usr/bin/env ruby
# 用途：统一编排知识结构、AI 控制面、候选元数据（可选）和检索评测的只读校验。
# 边界：不修改文件、不访问飞书；空评测集保持 not_executed，不能据此声明生产就绪。

require "json"
require "open3"
require "optparse"
require "rbconfig"

options = { metadata: nil }
OptionParser.new do |parser|
  parser.banner = "用法：validate_governance.rb [--metadata CANDIDATE.yaml]"
  parser.on("--metadata FILE", "额外校验一份候选元数据") { |value| options[:metadata] = File.expand_path(value) }
end.parse!

scripts_root = File.expand_path(__dir__)
governance_root = File.expand_path("../..", scripts_root)
checks = [
  ["knowledge_structure", File.join(scripts_root, "validate_knowledge_structure.rb"), []],
  ["ai_controls", File.join(scripts_root, "validate_ai_controls.rb"), []],
  ["retrieval_evaluation", File.join(scripts_root, "evaluate_retrieval.rb"), []]
]
if options[:metadata]
  metadata_validator = File.expand_path(
    "../../02-Skills/review-knowledge-admission/scripts/validate_metadata.rb", scripts_root
  )
  checks << [
    "candidate_metadata", metadata_validator,
    ["--metadata", options[:metadata], "--governance-root", governance_root]
  ]
end

results = checks.map do |check_id, script, arguments|
  stdout, stderr, status = Open3.capture3(RbConfig.ruby, script, *arguments)
  parsed = begin
    JSON.parse(stdout)
  rescue JSON::ParserError
    { "result" => "failed", "reason" => "non_json_output" }
  end
  {
    "check_id" => check_id,
    "exit_code" => status.exitstatus,
    "result" => parsed["result"],
    "quality_claim_allowed" => parsed["quality_claim_allowed"],
    "reason" => parsed["reason"],
    "stderr_present" => !stderr.strip.empty?
  }.compact
end

failed = results.select { |item| item["exit_code"] != 0 || item["result"] == "failed" }
evaluation = results.find { |item| item["check_id"] == "retrieval_evaluation" }
report = {
  "result" => failed.empty? ? "passed" : "failed",
  "checks" => results,
  "operating_mode" => "governance_validation",
  "production_readiness_claim_allowed" => evaluation&.dig("result") == "passed" &&
    evaluation&.dig("quality_claim_allowed") == true,
  "network" => "none",
  "write_request_sent" => false
}
puts JSON.pretty_generate(report)
exit(failed.empty? ? 0 : 1)
