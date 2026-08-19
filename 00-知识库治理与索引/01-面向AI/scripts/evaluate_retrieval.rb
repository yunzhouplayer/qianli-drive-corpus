#!/usr/bin/env ruby
# 兼容入口：实现已迁入 03-平台运维/scripts；参数和退出码保持不变。

warn "deprecated: 请改用 03-平台运维/scripts/evaluate_retrieval.rb"
load File.expand_path("../../03-平台运维/scripts/evaluate_retrieval.rb", __dir__)
