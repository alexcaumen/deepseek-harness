# Agent Note: PowerShell terminal view registration

Status: implemented

English | [中文](2026-09-04-pwsh-terminal-view.zh.md)

## Problem

The tool model classified `pwsh` as a shell, but the keyed view was registered only for `bash`. A real PowerShell command therefore ran successfully while its conversation row used the generic fallback and lacked the terminal disclosure expected by the browser test.

The keyed shell view also hid successful results without a terminal presenter, including persisted Bash history reopened on Windows and persistent-shell results. Registering PowerShell must not make those existing results inaccessible.

## Decision

The Windows `pwsh` tool uses the same expandable terminal view as `bash`. Each tool retains its own title, command, output and execution state. The existing slot lifecycle owns both registrations.

Settled results without a terminal presenter expose their recorded input and output through the generic disclosure. Successful output is not styled as an error; no terminal exit status is invented.

## Alternatives considered

**Change only the test selector.** This does not supply the missing terminal disclosure or preserve its expanded state across transcript virtualization.

**Add a separate PowerShell renderer.** The existing terminal presenter already understands the PowerShell result and title. A second renderer would duplicate the same behavior.

## Consequences

Both shell names now reserve their own view key, so duplicate registration is rejected for either name. No tool execution, model route, session storage or canonical Putri runtime changes.

## Verification

The real slot-runtime tests cover Bash and PowerShell dispatch and duplicate registration. The approval composer scenario captures the completed Windows shell row from the assembled application. The long-scroll browser scenario executes a PowerShell command and checks running, completion and disclosure across scrolling.

Windows replay companions preserve the original POSIX fixtures. The minimal preset continues to verify persistent shell working directory and environment state.

The long-history interaction scenario deliberately preserves its historical Bash calls on Windows and pins their expanded fallback output. Copy, exact branch boundaries and continued child-session messages remain verified.
