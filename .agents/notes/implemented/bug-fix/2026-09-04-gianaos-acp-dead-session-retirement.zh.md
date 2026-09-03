# Agent Note: 在复用前退役失败的 GianaOS ACP 会话

Status: implemented

[English](2026-09-04-gianaos-acp-dead-session-retirement.md) | 中文

## Problem

Putri 适配器为每个完全匹配的本地 agent 和 session 缓存一条 ACP 连接。异步 prompt 拒绝会先处置连接、后删除缓存，同步 prompt 抛错则既不删除也不处置。并发轮次可能在等待 turn barrier 时保留该会话，然后在传输已经关闭后再次发送 prompt，并再次收到 `ACP connection closed`。

## Decision

`llm-gianaos-acp` 仅在缓存仍持有同一实例时同步移除失败会话，随后开始幂等的异步处置。比较后移除不会删除并发轮次已经安装的替代会话。轮次进入每会话 turn barrier 后会重新检查缓存所有权；如果它等待期间保留的会话已经退役，就释放该 barrier 槽位，并重新选择或启动替代连接。

同步 prompt 抛错和异步 prompt 拒绝共用相同的退役逻辑与 `LlmError` 分类。异步拒绝会在释放 turn barrier 前开始退役，但失败流会等待处置完成后才报告错误。因此，替代轮次可以在进程清理结束前恢复持久远端会话。

适配器还会在模型解析或流式调用前拒绝并非其配置值的 provider，并在会话操作前拒绝并非其配置 Putri participant 的 model。这些检查阻止直接调用或错误绑定的适配器请求抵达规范 ACP 路由。

## Alternatives considered

**处置完成后再删除缓存项。** 不采用，因为 capability 撤销和进程退出可能耗时，清理期间失败会话仍会被其他轮次看见。延迟的无条件删除还可能删除替代会话。

**在同一连接上重试失败的 prompt。** 不采用，因为 ACP 传输关闭对该连接是终态。恢复会创建新连接并加载持久远端会话，而不是在已关闭管道上重放 prompt。

**修改共享 LLM 或 GG1 runtime。** 不采用，因为缓存、Putri 路由身份和 ACP 进程所有权属于 `llm-gianaos-acp`；修改共享或远端 runtime 会把行为扩大到本适配器之外。

## Verification

Hermetic 适配器测试会在 prompt 期间关闭真实 ACP SDK 传输，保持旧会话处置未完成，并证明等待中的轮次会创建替代连接并加载同一个远端会话。另一个测试注入同步 prompt 抛错，并证明下一轮使用新连接。绑定测试证明错误 provider 和错误 model 会在子进程启动前失败。

## Consequences

传输失败不会再把可复用的失效 Putri 会话留在适配器缓存中。清理可以与替代会话启动重叠，因此旧子进程与替代子进程可能短暂共存，但旧 capability 已开始撤销，任何新轮次都无法选择其会话。恢复会保留持久远端会话 id，且不改变 GG1 runtime 行为。
