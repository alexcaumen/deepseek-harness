# Agent Note: Keep subagent settlement notices text-only

Status: implemented

English | [中文](2026-09-16-subagent-settlement-text-only.zh.md)

## Problem

A continuable subagent's terminal output could include reasoning, tool calls, or
other non-text blocks. The parent settlement notice forwarded every terminal
block, exposing internal reasoning and protocol content instead of only the
child's closing answer.

## Decision

Settlement notices preserve nonempty text blocks in their original order and
omit every non-text block. When no nonempty closing text exists, the parent is
told that the child left no closing message. The child's own durable session
and terminal event remain unchanged.

This is a narrow backport of the behavior in upstream commit `29debb8b24`; the
upstream file layout is not imported into the diverged GCP branch.

## Consequences

Parents receive a concise public result without hidden reasoning, tool calls,
or media payloads. Focused coverage exercises mixed reasoning and text while
the existing settlement-delivery suite continues to verify exactly-once and
failure behavior.
