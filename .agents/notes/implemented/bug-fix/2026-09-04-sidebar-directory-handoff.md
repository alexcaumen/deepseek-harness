# Agent Note: Sidebar explicit-directory handoff

Status: implemented

English | [中文](2026-09-04-sidebar-directory-handoff.zh.md)

## Problem

The sidebar intercepted the produced-files `Show in folder` target as an editor file. Its read endpoint rejected the directory while the host open request never ran.

## Decision

A version-pinned dependency patch forwards paths with explicit directory syntax to the original host method. Other file opens retain editor interception. The patch updates both published source and its browser bundle; the lockfile binds the patch digest.

## Alternatives considered

**Disable the editor interceptor.** This would remove the useful file-opening workflow.

**Change the test to accept an editor tab.** The tab cannot read a directory and does not perform the requested folder action.

**Infer all directory paths or add a metadata service.** The affected caller already supplies an unambiguous dot-segment directory target. Wider classification and additional filesystem operations are outside this correction.

## Consequences

Plain paths without explicit directory syntax are not newly classified. Original host failures propagate, and disposal restores the original method. No operating-system folder or user desktop is opened by the automated test.

## Verification

The pinned-source tests cover Windows, POSIX, UNC and relative directory syntax, file interception, exactly-once host calls, errors and disposal. The unchanged assembled produced-files scenario clicks the button, observes the real RPC carrier with a mocked native opener, and checks the one-line layout.
