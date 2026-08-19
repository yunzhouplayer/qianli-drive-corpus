#!/usr/bin/env ruby
# 兼容入口：实现已迁入 03-平台运维/scripts；参数和退出码保持不变。

warn "deprecated: 请改用 03-平台运维/scripts/validate_ai_controls.rb"
load File.expand_path("../../03-平台运维/scripts/validate_ai_controls.rb", __dir__)
