#!/usr/bin/env ruby
# 用途：验证 v1→v2 等价迁移、配置档引用和父子路径展开。
# 边界：全部使用内存样例，不修改真实治理文件。

require "json"
require_relative "lib/knowledge-structure"

def assert(condition, message)
  raise message unless condition
end

profile = {
  "kind" => "content", "access_policy" => "restricted",
  "index_policy" => "require_explicit_approval",
  "active_knowledge_allowed" => true, "status" => "active"
}
v1 = {
  "schema_version" => "1.0", "updated_at" => "2026-08-19",
  "source_human_blueprint" => "00-知识库治理与索引/00-面向人员/02-公司知识库空间与目录蓝图.md",
  "spaces" => [{
    "space_id" => "SPACE-TEST", "name" => "00-测试", "path" => "00-测试", "purpose" => "测试",
    "owners" => { "primary" => "甲", "backup" => nil }, "default_access" => "center_read_comment",
    "security_default" => nil, "acl_inheritance" => true,
    "default_index_policy" => "evaluate_document_rules", "status" => "active",
    "directories" => [{
      "directory_id" => "DIR-00-001", "name" => "00-受限（按目录授权）",
      "path" => "00-测试/00-受限（按目录授权）", "parent_directory_id" => nil
    }.merge(profile)]
  }]
}
v2 = KnowledgeStructure.to_v2(v1)
assert(v2["spaces"][0]["directories"][0]["display_name"] == "00-受限", "展示名称应移除权限后缀")
assert(KnowledgeStructure.canonical(KnowledgeStructure.normalize(v1)) == KnowledgeStructure.canonical(KnowledgeStructure.normalize(v2)), "展开结果必须等价")

unknown = Marshal.load(Marshal.dump(v2))
unknown["spaces"][0]["directories"][0]["profile_ref"] = "missing"
begin
  KnowledgeStructure.normalize(unknown)
  raise "未知配置档应被拒绝"
rescue RuntimeError => error
  raise unless error.message.include?("未知目录配置档")
end

cycle = Marshal.load(Marshal.dump(v2))
cycle["spaces"][0]["directories"][0]["parent_directory_id"] = "DIR-00-001"
begin
  KnowledgeStructure.normalize(cycle)
  raise "循环父子关系应被拒绝"
rescue RuntimeError => error
  raise unless error.message.include?("循环")
end

puts JSON.pretty_generate(
  "result" => "passed",
  "cases" => ["v1_v2_equivalence", "display_name_without_acl_suffix", "unknown_profile", "parent_cycle"],
  "network" => "none"
)
