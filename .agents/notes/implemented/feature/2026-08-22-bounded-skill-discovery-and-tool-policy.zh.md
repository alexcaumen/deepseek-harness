# Agent Note: 有界 skill 发现与部署工具策略

Status: implemented

[English](2026-08-22-bounded-skill-discovery-and-tool-policy.md) | 中文

## 问题

部署可以挂载数百个本地及插件提供的 skill，并接入宽广的 MCP 工具面。每次模型请求都渲染全部 skill 摘要会浪费上下文，而隐藏超出部分又会让模型无法发现仍可执行的能力。外部浏览器服务也可能发布部署必须拒绝的操作，即使同一服务的其余能力有用。仅在 UI 中过滤或依靠提示词规则，无法保护工具注册表的其他调用方。

## 决策

`dsh-tool-skill` 保留完整的作用域 skill 提供方作为权威，并新增有界的持久目录投影。`catalogMaxEntries` 限制渲染条目数，`catalogPinnedNames` 优先选择部署关键条目；当投影小于当前总体时，持久 `skill-catalog` 来源记录 `totalAvailable`。digest 同时覆盖已渲染条目和总体数量，因此数量变化会沿用既有会话日志生命周期，替换模型可见目录。

同一插件注册 `skill_search`。它查询完整的、受 cwd 和 agent 作用域约束的模型可调用总体，按确定性词法规则排序匹配项，以 `searchResultLimit` 限制返回记录，并且只返回名称和有界描述。它不会加载正文或披露提供方路径。既有 `skill` 工具仍是按精确名称加载所选 skill 的唯一模型接口。

宽广的外部工具面由部署自有的 `tool-access-policy` 插件独立治理。它挂载在 `tools/pre-execute`，先评估 deny pattern，再评估 approval pattern，并在工具实现运行前返回规范的 deny 或 ask 决策。策略来自配置，因此部署可以绑定精确的、带服务命名空间的 MCP 名称，而不必修改共享工具运行时。

Princess OS 将已评审的本地 skill 投影到一个只含 junction 的目录，该目录由可审计 manifest 生成。重复名称按固定来源优先级解析。可移植且已治理的来源处于 active；依赖连接器或平台的候选项会继续记录为 held，直至其运行时依赖和权限得到证明。投影不会复制 skill 正文，并拒绝删除非 junction 成员。

## 验证

单元测试证明有界及固定目录输出、完整搜索、确定性排序、无效配置拒绝，以及 executor 层拒绝。源码启动的 parity 同步具备幂等性。隔离组装的 Web profile 证明插件组合和浏览器渲染。协议 canary 对隔离 Harness 执行 Playwright MCP 导航、快照和截图；Office canary 则通过 `ctx.tools.execute` 创建并读取 XLSX、PDF、PPTX 和 DOCX。

## 曾考虑的替代方案

**在持久目录中渲染所有已发现 skill。** 否决，因为提示词和缓存成本会随整个生态增长，而多数轮次只使用很小的子集。

**把选中的 skill 目录复制进 Harness profile。** 否决，因为副本会偏离来源，并使 provenance 与更新行为含糊不清。junction 保留一份内容来源，manifest 则记录所选投影。

**只在提示词中隐藏危险 MCP 操作。** 否决，因为 Code Mode、程序化调用方和后续消费方仍可直接寻址已注册工具。该决策必须位于规范的执行前操作中。

**立即安装所有社区插件。** 否决，因为公开发现并不能证明兼容性、权限、凭据或安全生命周期行为。候选项会保留为可搜索证据，直至每个完整 capability seam 都经过源码审计和目标测试。

## 后果

大型 skill 总体仍可发现，而无需把每条摘要放入每次请求。目录当前性仍可从会话日志重建，精确 skill 正文仍只会按需加载。搜索特意采用词法匹配，因此部署必须提供清晰名称和描述，而不能依赖语义检索。工具策略可以从有用的 MCP 服务中安全移除少量操作，但 pattern 配置会成为需要评审的部署制品。社区扩展需要有限的准入工作，不能静默变为可执行状态。
