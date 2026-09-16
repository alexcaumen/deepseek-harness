# Agent Note: 为每个 DeepSeek 槽位提供已准入上下文

Status: implemented

[English](2026-09-16-gcp-deepseek-context-and-heqa-cleanup.md) | 中文

## Problem

两个 DeepSeek Vision 启动器配置了 `--ctx-size 4096 --parallel 2`。llama.cpp 会在并行槽位之间分配总上下文，因此每个请求只能获得 2048 个 token。一个包含 2419 个提示 token 的原生 GCP 请求会在生成前以 `CONTEXT_WINDOW_EXCEEDED` 失败，尽管紧凑路由契约准入了 4096-token 请求窗口。隔离的便携 HEQA overlay 还继承了 `preserveResidentOnShutdown: true`，但其验收检查要求恢复运行前 GPU 基线。

## Decision

两个已准入 DeepSeek 启动器都采用 8192 总上下文和两个并行槽位，在保留双请求并发的同时让每个槽位获得 4096 token。启动器哈希、路由修订、目标当前性证据、准入回执、registry 和 runtime binding 一起推进。产品 profile 在正常关闭时仍保留已验证的 resident 模型。只有隔离 HEQA overlay 设置 `preserveResidentOnShutdown: false`，因此精确测试候选在比较远端基线前，会在优雅清理期间停止并验证其拥有的模型。

## Alternatives considered

**把 GCP 提示缩减到 2048 token 以下。** 这会掩盖启动器的上下文核算缺陷，给回复留下的空间过小，并丢弃有用的系统或工具上下文。

**维持 4096 总上下文但只使用一个并行槽位。** 这会满足单一请求，却使此前已验证的双请求并发契约退化。

**在产品中关闭 resident 保留。** 这会增加冷启动，并仅为满足隔离测试不变量而改变有意设计的用户生命周期策略。

## Consequences

双槽 DeepSeek runtime 会分配更大的 KV 空间，必须在精确 R5300 启动器上重新验证加载、文本、工具调用、视觉、并发、停止和基线恢复。普通应用关闭后的产品行为仍是 warm-resident；HEQA 行为则有意自清理，并且必须保持 DOTS 不变。
