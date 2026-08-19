#!/usr/bin/env ruby
# 用途：对知识库机器蓝图执行 Schema 之外的确定性语义校验。
# 边界：只读检查稳定 ID、路径、父子关系、两位序号和本地目录存在性，不修改治理文件。
# 依赖：仅使用 Ruby 标准库。

require "date"
require "json"
require "optparse"
require "pathname"
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

def normalized_relative_path(value)
  path = Pathname.new(value.to_s)
  return nil if value.to_s.empty? || path.absolute?

  cleaned = path.cleanpath.to_s
  return nil if cleaned == "." || cleaned == ".." || cleaned.start_with?("../") || cleaned != value.to_s

  cleaned
end

def duplicate_values(items, key)
  items.group_by { |item| item[key] }
       .select { |value, entries| !value.nil? && entries.length > 1 }
       .keys
end

def add_finding(findings, id, message, locator = nil)
  item = { "id" => id, "message" => message }
  item["locator"] = locator if locator
  findings << item
end

default_project_root = File.expand_path("../../..", __dir__)
script_root = File.join(default_project_root, "00-知识库治理与索引", "01-面向AI")
default_structure = File.join(script_root, "01-knowledge-structure.yaml")
options = { structure: default_structure, project_root: default_project_root, check_filesystem: true }

OptionParser.new do |parser|
  parser.banner = "用法：validate_knowledge_structure.rb [--structure FILE] [--project-root DIR] [--skip-filesystem]"
  parser.on("--structure FILE", "知识结构 YAML") { |value| options[:structure] = File.expand_path(value) }
  parser.on("--project-root DIR", "项目根目录") { |value| options[:project_root] = File.expand_path(value) }
  parser.on("--skip-filesystem", "只校验蓝图内部语义") { options[:check_filesystem] = false }
end.parse!

begin
  raise "知识结构文件不存在：#{options[:structure]}" unless File.file?(options[:structure])
  raise "项目根目录不存在：#{options[:project_root]}" unless File.directory?(options[:project_root])

  structure = load_yaml(options[:structure])
  spaces = Array(structure["spaces"])
  findings = []

  duplicate_values(spaces, "space_id").each do |value|
    add_finding(findings, "SPACE_ID_DUPLICATE", "空间 ID 重复：#{value}", value)
  end
  duplicate_values(spaces, "path").each do |value|
    add_finding(findings, "SPACE_PATH_DUPLICATE", "空间路径重复：#{value}", value)
  end

  sequence_numbers = []
  all_directories = spaces.flat_map { |space| Array(space["directories"]) }
  duplicate_values(all_directories, "directory_id").each do |value|
    add_finding(findings, "DIRECTORY_ID_DUPLICATE", "目录 ID 重复：#{value}", value)
  end
  duplicate_values(all_directories, "path").each do |value|
    add_finding(findings, "DIRECTORY_PATH_DUPLICATE", "目录路径重复：#{value}", value)
  end

  spaces.each do |space|
    space_id = space["space_id"]
    space_path = normalized_relative_path(space["path"])
    locator = space_id || space["path"] || "unknown-space"
    unless space_path
      add_finding(findings, "SPACE_PATH_INVALID", "空间路径必须是规范化的项目内相对路径。", locator)
      next
    end

    basename = File.basename(space_path)
    sequence = basename.match(/\A(\d{2})-/)
    if sequence
      sequence_numbers << sequence[1].to_i
    else
      add_finding(findings, "SPACE_SEQUENCE", "空间名称必须以两位序号和连字符开头。", locator)
    end
    if space["name"] != basename
      add_finding(findings, "SPACE_NAME_PATH", "空间名称必须与路径末段一致。", locator)
    end
    if options[:check_filesystem] && !File.directory?(File.join(options[:project_root], space_path))
      add_finding(findings, "SPACE_DIRECTORY_MISSING", "机器蓝图登记的空间目录在项目中不存在。", space_path)
    end

    directories = Array(space["directories"])
    by_id = directories.each_with_object({}) { |directory, memo| memo[directory["directory_id"]] = directory }
    expected_prefix = sequence && "DIR-#{sequence[1]}-"

    directories.each do |directory|
      directory_id = directory["directory_id"]
      directory_path = normalized_relative_path(directory["path"])
      directory_locator = directory_id || directory["path"] || locator
      unless directory_path
        add_finding(findings, "DIRECTORY_PATH_INVALID", "目录路径必须是规范化的项目内相对路径。", directory_locator)
        next
      end
      unless directory_path.start_with?("#{space_path}/")
        add_finding(findings, "DIRECTORY_OUTSIDE_SPACE", "目录路径不在所属空间路径下。", directory_locator)
      end
      if directory["name"] != File.basename(directory_path)
        add_finding(findings, "DIRECTORY_NAME_PATH", "目录名称必须与路径末段一致。", directory_locator)
      end
      if expected_prefix && !directory_id.to_s.start_with?(expected_prefix)
        add_finding(findings, "DIRECTORY_ID_SPACE", "目录 ID 的两位空间序号与所属空间不一致。", directory_locator)
      end
      if options[:check_filesystem] && !File.directory?(File.join(options[:project_root], directory_path))
        add_finding(findings, "DIRECTORY_MISSING", "机器蓝图登记的目录在项目中不存在。", directory_path)
      end

      parent_id = directory["parent_directory_id"]
      actual_parent_path = File.dirname(directory_path)
      if parent_id.nil?
        if actual_parent_path != space_path
          add_finding(findings, "ROOT_DIRECTORY_PARENT", "空间根目录项的路径必须直属于空间路径。", directory_locator)
        end
        unless File.basename(directory_path).match?(/\A\d{2}-/)
          add_finding(findings, "ROOT_DIRECTORY_SEQUENCE", "空间最外层目录必须以两位序号和连字符开头。", directory_locator)
        end
      else
        parent = by_id[parent_id]
        if parent.nil?
          add_finding(findings, "PARENT_NOT_FOUND", "父目录 ID 不存在于同一空间：#{parent_id}", directory_locator)
        elsif actual_parent_path != parent["path"]
          add_finding(findings, "PARENT_PATH_MISMATCH", "父目录 ID 与路径直属关系不一致。", directory_locator)
        end
      end
    end
  end

  unless sequence_numbers.empty?
    expected = (sequence_numbers.min..sequence_numbers.max).to_a
    if sequence_numbers.sort != expected
      add_finding(findings, "SPACE_SEQUENCE_CONTINUITY", "空间两位序号必须唯一且连续。")
    end
  end

  blueprint_path = normalized_relative_path(structure["source_human_blueprint"])
  if blueprint_path.nil?
    add_finding(findings, "HUMAN_BLUEPRINT_PATH", "人员蓝图路径必须是规范化的项目内相对路径。")
  elsif options[:check_filesystem] && !File.file?(File.join(options[:project_root], blueprint_path))
    add_finding(findings, "HUMAN_BLUEPRINT_MISSING", "人员蓝图文件不存在。", blueprint_path)
  end

  result = {
    "result" => findings.empty? ? "passed" : "failed",
    "structure" => options[:structure],
    "project_root" => options[:project_root],
    "filesystem_checked" => options[:check_filesystem],
    "spaces" => spaces.length,
    "directories" => all_directories.length,
    "findings" => findings
  }
  puts JSON.pretty_generate(result)
  exit(findings.empty? ? 0 : 1)
rescue StandardError => error
  warn JSON.pretty_generate("result" => "error", "error" => error.message)
  exit 2
end
