#!/usr/bin/env ruby
# 用途：验证统一治理校验入口能编排三项基础检查，且空评测集不产生生产就绪声明。

require "json"
require "open3"
require "rbconfig"

script = File.expand_path("validate_governance.rb", __dir__)
stdout, stderr, status = Open3.capture3(RbConfig.ruby, script)
raise "统一校验器输出不是 JSON：#{stderr}" unless JSON.parse(stdout)

report = JSON.parse(stdout)
raise "统一校验器执行失败：#{report}" unless status.success? && report["result"] == "passed"
ids = report.fetch("checks").map { |item| item["check_id"] }
expected = %w[knowledge_structure ai_controls retrieval_evaluation]
raise "统一校验器缺少基础检查：#{ids}" unless ids == expected
raise "空评测集不得允许生产就绪声明" unless report["production_readiness_claim_allowed"] == false
raise "统一校验器不得访问网络或写入" unless report["network"] == "none" && report["write_request_sent"] == false

puts JSON.pretty_generate(
  "result" => "passed",
  "cases" => ["orchestration", "empty_evaluation_fail_closed", "read_only_boundary"]
)
