# Agent Note: PowerShell 终端视图注册

Status: implemented

[English](2026-09-04-pwsh-terminal-view.md) | 中文

## Problem

工具模型将 `pwsh` 归类为 shell，但带键视图只注册了 `bash`。因此真实 PowerShell 命令可以成功执行，聊天行却使用通用回退视图，缺少浏览器测试要求的终端展开功能。

带键 shell 视图还会隐藏缺少终端展示器的成功结果，包括在 Windows 上重新打开的 Bash 历史记录和持久 shell 结果。注册 PowerShell 不得使这些现有结果无法访问。

## Decision

Windows 的 `pwsh` 工具与 `bash` 共用可展开的终端视图。每个工具保留自己的标题、命令、输出和执行状态。现有插槽生命周期管理两个注册项。

缺少终端展示器的已完成结果通过通用展开区显示原始输入和输出。成功输出不采用错误样式，也不会凭空补造终端退出状态。

## Alternatives considered

**仅修改测试选择器。** 这不能补上缺失的终端展开功能，也不能保证聊天虚拟化时保留展开状态。

**另建 PowerShell 渲染器。** 现有终端展示模型已支持 PowerShell 的结果和标题，新增渲染器会重复同一行为。

## Consequences

两个 shell 名称分别占用自己的视图键，因此两者的重复注册都会被拒绝。不修改工具执行、模型路由、会话存储或规范 Putri 运行时。

## Verification

真实插槽运行时测试覆盖 Bash 和 PowerShell 的分派及重复注册。审批输入区场景从完整应用捕获已完成的 Windows shell 行。长聊天滚动浏览器场景执行 PowerShell 命令，并检查运行、完成和滚动前后的展开状态。

Windows 回放伴随文件保留原有 POSIX fixture。最小预设继续验证 shell 工作目录和环境变量的持久状态。

长历史交互场景在 Windows 上刻意保留历史 Bash 调用，并固定其展开后的回退输出。复制、精确分支边界和子会话继续发送仍受验证。
