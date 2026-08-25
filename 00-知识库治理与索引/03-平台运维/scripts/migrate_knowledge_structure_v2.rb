#!/usr/bin/env ruby
# 用途：把知识结构 v1 机械迁移为 v2，并生成逐节点等价性摘要。
# 边界：只读 v1 文件；仅在显式给出 --output 时写入目标文件，不访问飞书。

require "digest"
require "json"
require "optparse"
require "yaml"
require_relative "lib/knowledge-structure"

options = {}
OptionParser.new do |parser|
  parser.banner = "用法：migrate_knowledge_structure_v2.rb --from V1 [--output V2] [--report JSON]"
  parser.on("--from FILE", "v1 蓝图") { |value| options[:from] = File.expand_path(value) }
  parser.on("--output FILE", "写入 v2 蓝图；省略时只输出 YAML") { |value| options[:output] = File.expand_path(value) }
  parser.on("--report FILE", "写入迁移等价性摘要") { |value| options[:report] = File.expand_path(value) }
  parser.on("--updated-at DATE", "设置 v2 蓝图更新日期") { |value| options[:updated_at] = Date.iso8601(value).iso8601 }
end.parse!

abort "必须提供 --from" unless options[:from]
source = KnowledgeStructure.load_yaml(options[:from])
target = KnowledgeStructure.to_v2(source)
target["updated_at"] = options[:updated_at] if options[:updated_at]
source_normalized = KnowledgeStructure.canonical(KnowledgeStructure.normalize(source))
target_normalized = KnowledgeStructure.canonical(KnowledgeStructure.normalize(target))
source_json = JSON.generate(source_normalized)
target_json = JSON.generate(target_normalized)
spaces = target_normalized.fetch("spaces")
report = {
  "result" => source_json == target_json ? "passed" : "failed",
  "source_schema_version" => source["schema_version"],
  "target_schema_version" => target["schema_version"],
  "target_updated_at" => target["updated_at"],
  "spaces" => spaces.length,
  "directories" => spaces.sum { |space| space.fetch("directories").length },
  "directory_profiles" => target.fetch("directory_profiles").length,
  "source_normalized_sha256" => Digest::SHA256.hexdigest(source_json),
  "target_normalized_sha256" => Digest::SHA256.hexdigest(target_json),
  "equivalent" => source_json == target_json
}

header = <<~COMMENTS
  # 用途：为检索系统、AI Agent 和校验程序提供完整的知识空间与目录蓝图。
  # 权威边界：本文件是稳定ID、物理路径和目录控制配置的 Git 权威来源；真实成员与ACL以飞书为准。
  # v2规则：完整路径由父节点与path_segment生成；每个目录必须显式引用profile_ref，不使用隐含默认值。
  # 展示名称：display_name只供人员阅读，不改变path_segment、稳定ID或飞书物理名称。
  # 安全：未知配置档、父子循环、路径漂移或本地目录缺失时必须阻断。
COMMENTS
yaml = header + YAML.dump(target).sub(/\A---\s*\n/, "").gsub(/: \n/, ": null\n")
if options[:output]
  File.write(options[:output], yaml, encoding: "UTF-8")
else
  puts yaml
end
File.write(options[:report], JSON.pretty_generate(report) + "\n", encoding: "UTF-8") if options[:report]
warn JSON.generate(report)
exit(report["equivalent"] ? 0 : 1)
