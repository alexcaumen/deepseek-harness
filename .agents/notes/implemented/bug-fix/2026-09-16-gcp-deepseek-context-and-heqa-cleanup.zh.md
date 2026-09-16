# Agent Note: 为每个 DeepSeek 槽位提供已准入上下文

Status: implemented

[English](2026-09-16-gcp-deepseek-context-and-heqa-cleanup.md) | 中文

## Problem

两个 DeepSeek Vision 启动器配置了 `--ctx-size 4096 --parallel 2`。llama.cpp 会在并行槽位之间分配总上下文，因此每个请求只能获得 2048 个 token。一个包含 2419 个提示 token 的原生 GCP 请求会在生成前以 `CONTEXT_WINDOW_EXCEEDED` 失败，尽管紧凑路由契约准入了 4096-token 请求窗口。隔离的便携 HEQA overlay 还继承了 `preserveResidentOnShutdown: true`，但其验收检查要求恢复运行前 GPU 基线。

上下文修正后，RC41 完成了原生文本与工具调用往返，但无法完成清理。loopback endpoint controller 在回收残留的自有 tunnel 之前等待 `server.close()`；Node 的 close callback 会等待开放连接，因此 controller 永远到不了 channel 清理。桌面 wrapper 与 HEQA driver 的 deadline 也短于 lifecycle controller 已准入的清理预算。

## Decision

两个已准入 DeepSeek 启动器都采用 8192 总上下文和两个并行槽位，在保留双请求并发的同时让每个槽位获得 4096 token。启动器哈希、路由修订、目标当前性证据、准入回执、registry 和 runtime binding 一起推进。产品 profile 在正常关闭时仍保留已验证的 resident 模型。只有隔离 HEQA overlay 设置 `preserveResidentOnShutdown: false`，因此精确测试候选在比较远端基线前，会在优雅清理期间停止并验证其拥有的模型。

Loopback quiescence 现在先关闭新请求入口，为既有自有 transport 提供有界 grace interval，之后只回收仍属于该 controller 的 transport。停止模型进程前仍必须通过远端 drain 验证。延长的 shutdown deadline 只用于隔离 HEQA；普通产品继续使用既有的有界关闭行为。外层 HEQA deadline 必须长于 lifecycle 清理预算，避免验证器杀死仍在正常进行的清理。

## Alternatives considered

**把 GCP 提示缩减到 2048 token 以下。** 这会掩盖启动器的上下文核算缺陷，给回复留下的空间过小，并丢弃有用的系统或工具上下文。

**维持 4096 总上下文但只使用一个并行槽位。** 这会满足单一请求，却使此前已验证的双请求并发契约退化。

**在产品中关闭 resident 保留。** 这会增加冷启动，并仅为满足隔离测试不变量而改变有意设计的用户生命周期策略。

**立即强制关闭 loopback。** 这可能截断已经接受的流式响应。两阶段关闭保留正常响应路径，只在 grace interval 结束后使用强制清理。

**增加所有产品 timeout。** 长路径用于自清理 HEQA 的证据采集，而不是普通用户关闭。全局应用会让真实关闭故障的恢复不必要地变慢。

## Consequences

双槽 DeepSeek runtime 会分配更大的 KV 空间，必须在精确 R5300 启动器上重新验证加载、文本、工具调用、视觉、并发、停止和基线恢复。普通应用关闭后的产品行为仍是 warm-resident；HEQA 行为则有意自清理，并且必须保持 DOTS 不变。

Endpoint regression suite 现在包含一个残留 keep-alive tunnel，并要求在 quiescence 通过前完成有界回收。便携 HEQA 仍必须在同一个不可变候选上证明最终响应完整、自有进程与端口已清理、精确恢复基线，并且 DOTS 身份未变化。
