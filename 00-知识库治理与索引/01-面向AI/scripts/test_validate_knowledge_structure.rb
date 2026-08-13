#!/usr/bin/env ruby
# 用途：回归验证知识结构语义校验器能够通过正确蓝图并阻断重复 ID、错误父子关系和缺失目录。
# 边界：只操作临时目录，不修改真实治理文件。

require "fileutils"
require "json"
require "open3"
require "tmpdir"
require "yaml"

validator = File.expand_path("validate_knowledge_structure.rb", __dir__)

def run_validator(validator, root, structure)
  stdout, stderr, status = Open3.capture3(
    "ruby", validator, "--structure", structure, "--project-root", root
  )
  body = JSON.parse(stdout.empty? ? stderr : stdout)
  [status.exitstatus, body]
end

def assert(condition, message)
  raise message unless condition
end

Dir.mktmpdir("qianli-structure-validator-") do |root|
  space_path = "00-知识库治理与索引"
  human_path = "#{space_path}/00-面向人员/02-公司知识库空间与目录蓝图.md"
  directory_paths = [
    "#{space_path}/00-面向人员",
    "#{space_path}/00-面向人员/模板"
  ]
  directory_paths.each { |path| FileUtils.mkdir_p(File.join(root, path)) }
  File.write(File.join(root, human_path), "# 测试蓝图\n", encoding: "UTF-8")

  base = {
    "schema_version" => "1.0",
    "updated_at" => "2026-08-13",
    "source_human_blueprint" => human_path,
    "spaces" => [{
      "space_id" => "SPACE-GOVERNANCE",
      "name" => space_path,
      "path" => space_path,
      "directories" => [
        {
          "directory_id" => "DIR-00-001", "name" => "00-面向人员",
          "path" => directory_paths[0], "parent_directory_id" => nil
        },
        {
          "directory_id" => "DIR-00-002", "name" => "模板",
          "path" => directory_paths[1], "parent_directory_id" => "DIR-00-001"
        }
      ]
    }]
  }
  structure_path = File.join(root, "structure.yaml")
  write = lambda do |value|
    File.write(structure_path, YAML.dump(value), encoding: "UTF-8")
  end

  write.call(base)
  code, report = run_validator(validator, root, structure_path)
  assert(code.zero? && report["result"] == "passed", "正确结构应通过")

  duplicate = Marshal.load(Marshal.dump(base))
  duplicate["spaces"][0]["directories"][1]["directory_id"] = "DIR-00-001"
  write.call(duplicate)
  code, report = run_validator(validator, root, structure_path)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "DIRECTORY_ID_DUPLICATE" }, "重复目录 ID 应被阻断")

  wrong_parent = Marshal.load(Marshal.dump(base))
  wrong_parent["spaces"][0]["directories"][1]["parent_directory_id"] = nil
  write.call(wrong_parent)
  code, report = run_validator(validator, root, structure_path)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "ROOT_DIRECTORY_PARENT" }, "错误父子关系应被阻断")

  missing = Marshal.load(Marshal.dump(base))
  missing["spaces"][0]["directories"][1]["path"] = "#{space_path}/00-面向人员/不存在"
  missing["spaces"][0]["directories"][1]["name"] = "不存在"
  write.call(missing)
  code, report = run_validator(validator, root, structure_path)
  assert(code == 1 && report["findings"].any? { |item| item["id"] == "DIRECTORY_MISSING" }, "缺失物理目录应被阻断")

  puts JSON.pretty_generate(
    "result" => "passed",
    "cases" => ["valid_structure", "duplicate_directory_id", "parent_path_mismatch", "missing_directory"],
    "temporary_files_only" => true
  )
end
