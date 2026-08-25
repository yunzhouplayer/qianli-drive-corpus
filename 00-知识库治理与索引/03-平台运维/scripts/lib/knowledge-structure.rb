# frozen_string_literal: true

# 用途：在 v1 完整目录记录与 v2 配置档结构之间转换，并展开为可比较的规范树。
# 边界：只处理 Git 中的结构蓝图；不读取或修改飞书目录、成员和 ACL。

require "date"
require "pathname"
require "yaml"

module KnowledgeStructure
  PROFILE_FIELDS = %w[kind access_policy index_policy active_knowledge_allowed status].freeze
  SPACE_FIELDS = %w[
    space_id name path purpose owners default_access security_default
    acl_inheritance default_index_policy status
  ].freeze
  DIRECTORY_FIELDS = %w[
    directory_id name path parent_directory_id kind access_policy index_policy
    active_knowledge_allowed status notes
  ].freeze

  PROFILE_IDS = {
    ["governance", "inherit", "evaluate_document_rules", true, "active"] => "governance_indexed",
    ["governance", "inherit", "deny", true, "active"] => "governance_git_only",
    ["content", "inherit", "evaluate_document_rules", true, "active"] => "content_standard",
    ["content", "restricted", "require_explicit_approval", true, "active"] => "content_restricted",
    ["archive", "inherit", "deny", false, "active"] => "archive_no_index",
    ["content", "strictly_restricted", "require_explicit_approval", true, "active"] => "content_strict",
    ["project_template", "inherit", "deny", false, "active"] => "project_template_no_index"
  }.freeze

  module_function

  def load_yaml(path)
    content = File.read(path, encoding: "UTF-8")
    YAML.safe_load(content, [Date, Time], [], false) || {}
  rescue ArgumentError
    YAML.safe_load(content, permitted_classes: [Date, Time], permitted_symbols: [], aliases: false) || {}
  end

  def profile_key(directory)
    PROFILE_FIELDS.map { |field| directory[field] }
  end

  def profiles
    PROFILE_IDS.each_with_object({}) do |(values, profile_id), result|
      result[profile_id] = PROFILE_FIELDS.zip(values).to_h
    end
  end

  def display_name(name)
    name.to_s.gsub(/（(?:按目录授权|严格授权)）\z/, "")
  end

  def to_v2(structure)
    raise "只支持将 schema_version=1.0 迁移到 v2" unless structure["schema_version"] == "1.0"

    converted = {
      "schema_version" => "2.0",
      "updated_at" => structure["updated_at"],
      "source_human_blueprint" => structure["source_human_blueprint"],
      "directory_profiles" => profiles,
      "spaces" => Array(structure["spaces"]).map { |space| convert_space(space) }
    }
    normalized_v1 = normalize(structure)
    normalized_v2 = normalize(converted)
    raise "v1 与 v2 展开结果不等价" unless canonical(normalized_v1) == canonical(normalized_v2)

    converted
  end

  def convert_space(space)
    result = {
      "space_id" => space["space_id"],
      "path_segment" => File.basename(space.fetch("path")),
      "purpose" => space["purpose"],
      "owners" => space["owners"],
      "default_access" => space["default_access"],
      "security_default" => space["security_default"],
      "acl_inheritance" => space["acl_inheritance"],
      "default_index_policy" => space["default_index_policy"],
      "status" => space["status"],
      "directories" => Array(space["directories"]).map { |directory| convert_directory(directory) }
    }
    result["display_name"] = space["name"] if space["name"] != result["path_segment"]
    result
  end

  def convert_directory(directory)
    profile_ref = PROFILE_IDS[profile_key(directory)]
    raise "目录 #{directory['directory_id']} 没有显式配置档" unless profile_ref

    segment = File.basename(directory.fetch("path"))
    result = {
      "directory_id" => directory["directory_id"],
      "path_segment" => segment,
      "parent_directory_id" => directory["parent_directory_id"],
      "profile_ref" => profile_ref
    }
    readable_name = display_name(segment)
    result["display_name"] = readable_name if readable_name != segment
    result["notes"] = directory["notes"] if directory["notes"]
    result
  end

  def normalize(structure)
    case structure["schema_version"]
    when "1.0"
      normalize_v1(structure)
    when "2.0"
      normalize_v2(structure)
    else
      raise "不支持的知识结构版本：#{structure['schema_version'].inspect}"
    end
  end

  def normalize_v1(structure)
    {
      "schema_version" => "normalized",
      "source_human_blueprint" => structure["source_human_blueprint"],
      "spaces" => Array(structure["spaces"]).map do |space|
        normalized = SPACE_FIELDS.each_with_object({}) { |field, result| result[field] = space[field] }
        normalized["directories"] = Array(space["directories"]).map do |directory|
          DIRECTORY_FIELDS.each_with_object({}) do |field, result|
            result[field] = directory[field] if directory.key?(field)
          end
        end
        normalized
      end
    }
  end

  def normalize_v2(structure)
    profile_map = structure.fetch("directory_profiles")
    {
      "schema_version" => "normalized",
      "source_human_blueprint" => structure["source_human_blueprint"],
      "spaces" => Array(structure["spaces"]).map do |space|
        space_path = normalized_segment(space.fetch("path_segment"), "空间 #{space['space_id']}")
        directories = Array(space["directories"])
        by_id = directories.to_h { |directory| [directory["directory_id"], directory] }
        path_cache = {}
        path_for = lambda do |directory_id, stack = []|
          return path_cache[directory_id] if path_cache.key?(directory_id)
          raise "目录父子关系存在循环：#{(stack + [directory_id]).join(' -> ')}" if stack.include?(directory_id)

          directory = by_id.fetch(directory_id) { raise "目录不存在：#{directory_id}" }
          segment = normalized_segment(directory.fetch("path_segment"), "目录 #{directory_id}")
          parent_id = directory["parent_directory_id"]
          parent_path = parent_id.nil? ? space_path : path_for.call(parent_id, stack + [directory_id])
          path_cache[directory_id] = File.join(parent_path, segment)
        end

        normalized_space = {
          "space_id" => space["space_id"],
          "name" => space_path,
          "path" => space_path,
          "purpose" => space["purpose"],
          "owners" => space["owners"],
          "default_access" => space["default_access"],
          "security_default" => space["security_default"],
          "acl_inheritance" => space["acl_inheritance"],
          "default_index_policy" => space["default_index_policy"],
          "status" => space["status"]
        }
        normalized_space["directories"] = directories.map do |directory|
          profile_ref = directory.fetch("profile_ref")
          profile = profile_map.fetch(profile_ref) { raise "未知目录配置档：#{profile_ref}" }
          normalized = {
            "directory_id" => directory["directory_id"],
            "name" => directory["path_segment"],
            "path" => path_for.call(directory["directory_id"]),
            "parent_directory_id" => directory["parent_directory_id"]
          }
          PROFILE_FIELDS.each { |field| normalized[field] = profile[field] }
          normalized["notes"] = directory["notes"] if directory.key?("notes")
          normalized
        end
        normalized_space
      end
    }
  end

  def normalized_segment(value, locator)
    text = value.to_s
    path = Pathname.new(text)
    raise "#{locator} 的 path_segment 非法" if text.empty? || path.absolute? || text.include?("/") || [".", ".."].include?(text)

    text
  end

  def canonical(value)
    case value
    when Hash
      value.keys.sort.each_with_object({}) { |key, result| result[key] = canonical(value[key]) }
    when Array
      value.map { |item| canonical(item) }
    when Date, Time
      value.iso8601
    else
      value
    end
  end
end
