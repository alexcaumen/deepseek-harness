# Owned desktop graceful shutdown

## Status

Implemented for the isolated Giana CoWork Preview desktop candidate.

## Problem

The Windows wrapper stopped its `cmd.exe /c pnpm dsh web` tree with `taskkill /t /f` whenever Electron closed. The operating-system process tree disappeared, but Cordis disposal did not run. A resident local-model manager therefore retained its R5300 host lease until the 30-minute TTL, and an immediate restart could fail with `RESOURCE_LEASE_UNAVAILABLE` despite no competing client.

## Decision

`@deepseek-ai/dsh-web-app` has an opt-in `desktopShutdown` configuration. The option is off in the shipped bundle. When enabled, activation requires all of the following:

- the web server binds only `127.0.0.1`;
- `GIANA_COWORK_DESKTOP_SHUTDOWN_TOKEN` is a 64-character hexadecimal value inherited from the launching process;
- the launcher supplied `ctx.appExit`.

The plugin registers one exact POST route at `/__giana/desktop/shutdown`. It accepts only loopback peers, an empty request body, and a timing-safe match of the per-launch token. A successful request answers `202` once and then asks the launcher to dispose the whole Cordis tree. The registration is an effect and disappears on disposal.

The CLI keeps its ordinary five-second shutdown bound. An owning supervisor may extend that bound with the process-origin `DSH_PROCESS_SHUTDOWN_TIMEOUT_MS`, validated as a positive integer no greater than 30 minutes. Project and user environment layers cannot set it.

The GCP wrapper creates a new token for every owned backend, enables the route through its overlay, requests graceful shutdown, and waits up to 330 seconds. Startup losers, incomplete boots, rejected requests, and expired graceful waits retain the existing validated `taskkill /t /f` fallback. A wrapper attached to another backend has no child process or token and never sends the shutdown request.

## Verification

Unit tests cover route absence by default, process-only provenance, loopback and method restrictions, token and body rejection, one-shot exit, route disposal, supervisor request fields, accepted and rejected responses, process exit, and timeout. Final acceptance additionally requires two immediate exact-package GLM cycles and proof that the first close removes the remote host lease before the second launch.

## Rollback

Remove the GCP overlay option and wrapper token/request flow to restore hard-stop behavior. The generic web bundle remains unchanged at runtime when `desktopShutdown` is false, and the CLI uses its original five-second timeout when the override is absent.
