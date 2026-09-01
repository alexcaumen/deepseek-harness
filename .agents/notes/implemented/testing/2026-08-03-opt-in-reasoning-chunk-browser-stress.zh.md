# Agent Note: 推理（reasoning）分片的逐帧累计发布与浏览器压力验证

Status: implemented

[English](2026-08-03-opt-in-reasoning-chunk-browser-stress.md) | 中文

## 问题

长推理流会连续产生大量 `assistant/chunk`。这些原始事件必须逐个完成排序、日志记录和 `PartialAccumulator` 折叠，以保持重放保真度和最终内容完整；但 React 只需要看到当前累计结果，不需要观察同一浏览器帧内的每个中间态。

异步流的每次 `yield` 都可能形成新的微任务边界，因此仅靠微任务合批的 `Notifier.markDirty()` 会退化为每个分片重建一次 `ConversationSnapshot`、通知一次 `useSyncExternalStore` 并运行一次 React render。即使实时 Think 行保持折叠，100,000 个推理分片仍会让协调、提交和布局工作压住主线程。性能边界必须位于会话接收与 React 发布之间，不能通过减慢生产方或丢弃原始事件来掩盖问题。

## 决策

`Session.acceptLiveEvent()` 立即追加每个原始事件，并同步更新 transcript（文本记录）、`PartialAccumulator` 及其他会话派生状态。可见的 `block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta` 和 `block-end` 分片通过 `Notifier.markFrameDirty()` 发布：第一项变化调度一次 `requestAnimationFrame`，后续分片只继续更新累积器；帧回调从最新状态重建一个累计快照并通知订阅者一次。`usage`、`finish` 及未知的不可见分片保留在事件窗口中，但不触发无效的 React 通知。会话与历史检查共用同一可见分片分类。

`Notifier` 用调度种类和代际标记管理待发布工作。普通结构事件继续通过 `markDirty()` 在微任务中发布；如果定稿消息、工具事件或错误到达时仍有待执行的帧发布，微任务会取代它，旧帧回调因代际不匹配而失效。`notifyNow()` 同样使旧调度失效，以保留受控输入的同步回响。没有 `requestAnimationFrame` 的环境退回微任务合批。定稿事件可以跳过一次尚未显示的中间 partial，但发布的定稿内容和原始事件序列保持完整。

折叠 Think 行不再横向跟随推理文本。在用户展开主体前，它只显示运行中或已完成状态，该呈现由 [Giana Code Putri 交互控件](../feature/2026-09-02-giana-code-putri-interaction-controls.zh.md) 管理。逐帧会话发布与该呈现决策相互独立，并继续限制 React 快照工作量。

`pnpm run test:web:stress` 保留为无密钥、需显式启用的浏览器性能证据。确定性的 `?fixture` 会话以独立于绘制的节奏发出 100,000 个 `reasoning-delta`，结尾标记证明事件经过生产会话归并并到达实时 Think 行；50 毫秒心跳和预先调度的 DOM 事件分别测量主线程停顿与交互延迟，250 毫秒预算用于识别明显回归。`DSH_WEB_STRESS_HEADFUL=1` 允许开发者在可见浏览器中使用 Performance 面板分析同一场景。该压力车道是手动性能诊断与修复验收的证据，不是默认 CI 门禁，也不替代确定性的调度单元测试。

聚焦测试固定 `Notifier` 的逐帧合并、结构事件抢占、失效回调和无 rAF 回退，并在 `Session` 层证明一帧只发布一次最新累计文本且定稿不会被旧帧回调重复通知。fixture（测试前置数据）的小型单元测试继续固定输入校验、外部到达节奏、并发拒绝、精确事件数和结尾标记交付，无需把 100,000 分片工作负载带入默认测试套件。

## 曾考虑的替代方案

**在 React 内对快照使用 transition、deferred value 或组件节流。** 不予采纳：会话源仍会逐分片通知 `useSyncExternalStore`，React render 在组件决定延后展示之前已经发生，且多个消费同一快照的组件需要重复实现策略。折叠 Think 呈现与快照发布相互独立，不承担数据发布策略。

**在接收或日志层丢弃、抽样或拼接原始分片。** 不予采纳：原始 `assistant/chunk` 是可重放的会话事实，改变它会损失诊断与 UI 保真度，并把展示频率策略混入数据权威层。

**只使用微任务合批。** 不予采纳：连续异步 `yield` 会在相邻分片间排空微任务队列，使微任务合批近似退化为每个分片通知一次。

**按动画帧控制测试生产方节奏。** 不予采纳：生产方会在渲染变慢时同步减速，使页面获得真实网络流不存在的隐式背压，并掩盖主线程饥饿。

**真实模型或录制的 HTTP 字节流。** 不予采纳：实时模型不具确定性，HTTP/SSE（Server-Sent Events）录制也不会改进目标断言。内存 fixture 保留逐个异步会话事件、生产客户端归并和 React 渲染路径，同时控制工作负载与到达节奏。

## 后果

流式 `ConversationSnapshot` 的发布频率受浏览器绘制频率约束，React 每帧至多处理一个包含全部已接收文本的累计 partial；结构事件仍可更快发布。接收、排序、日志记录、字符串拼接和累积器更新仍按原始分片执行，因此该决策降低的是快照重建与 React 工作，不把原始流解析成本伪装成已解决。

本决策仅在原有 Think 摘要横向调度器方面被部分取代。逐帧累计发布机制、原始事件保真度、确定性调度覆盖和显式浏览器压力测试车道继续有效。折叠摘要现在完全避免横向布局读写，并在展开前只报告状态。

浏览器压力车道继续提供真实组装应用上的响应性信号和可见 profiling 入口，但硬件与调度差异使其只适合作为显式性能证据。确定性的 focused tests 负责守住发布次数、累计内容与抢占顺序，默认测试车道保持快速。
