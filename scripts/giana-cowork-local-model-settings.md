# Local GLM Candidate Settings

Reference for the [candidate installer](giana-cowork-local-model-settings.ts). This script does not probe a server, approve a route, activate settings, or access session files. Deployment and activation remain the integrating operator's responsibility.

```powershell
node --import tsx/esm scripts/giana-cowork-local-model-settings.ts `
  --source-settings C:/Users/grinv/.dsh-giana-code-putri-candidate-20260902/settings.yaml `
  --output-dir N:/private/staging/fresh-candidate `
  --base-url $VerifiedLoopbackBaseURL `
  --readiness N:/private/verification/glm-readiness.json
```

The endpoint is mandatory; no live URL or port is inferred. The explicit source settings path may be absolute on C: or N: and is read-only; no preliminary settings or secret copy to N: is required. Readiness input and output remain strictly on N:. The output parent must already exist, be private under Windows ACLs, and be outside every repository and the source settings directory. The output directory must be new. Linked/redirected paths, traversal, device names, alternate streams, and existing output are refused. There is no force/overwrite option and no F: writes. Do not concurrently rename or replace input/output ancestors while preparing files.

## Readiness Input

Supply YAML or JSON from the deployment verifier. `{"routeReady": false}` produces only `status.json`, prints `PENDING`, and exits 2. It creates no settings file, default, or selectable GLM route, including when the source already selects GLM.

A ready record must have `routeReady: true`, `verified: true`, `provider: glm-local-r5300`, `model: GLM-5.3-Flash-official-fp8-canary`, the same `baseURL` supplied on the command line, and ISO timestamps `verifiedAt` and `expiresAt` containing the current time. It must carry the exact admission receipt digest and the complete route IDs `glm53-official-fp8`, `qwen38-local`, `glm53-uncensored-fp8`, `deepseek-v4-flash-vision-regular`, and `deepseek-v4-flash-vision-uncensored`; omissions, additions, and duplicates are rejected. Its `lazyDriver` mapping must contain boolean `true` for `verified` and `loadAtFirstRequest`, asserting externally verified executable driver capability to load the exact model on the actual first request. The enclosing provider/model/endpoint and validity interval bind this driver evidence too. Its `checks` mapping must contain boolean `true` for `text`, `image`, `totalContext65536`, `maxTokens1024`, and `reasoningHigh`, asserting successful external checks of that lazy route's canary behavior with the configured OpenAI-completions transport. Do not construct a ready record from this example or historical observations. This is caller-supplied verification coupled to the source-controlled admission receipt, not a resident-model health check or canonical/Putri route admission.

## Candidate Files

A ready run exits 0 and writes `settings.candidate.yaml`, `held-providers.yaml`, and a secret-free `status.json`. Invalid inputs exit 1. Each file is written to an exclusively created temporary file, flushed, then published with an exclusive atomic hard link; `status.json` is published last. NTFS hard-link support is required. After a failure, treat any partial directory as incomplete and use a fresh output directory. No source or existing output is overwritten.

The candidate replaces the `glm-local-r5300` catalog with exactly one admitted model, displays **GLM 5.3 Flash Official FP8 (Local)**, and serves only `GLM-5.3-Flash-official-fp8-canary`. It declares text/image input, total context 65,536, explicit model/request-default `maxTokens: 1024`, and only `high` reasoning. No wire-compatibility flags are invented or added; existing compatibility settings are preserved, and actual wire behavior requires external verification before readiness. Credential references, other profile fields, and unrelated preferences are retained; the admitted canary fields and future-chat default are updated. Existing session-specific selections are not rewritten. The 65,536 budget includes prompts, tools, history, images, reasoning, and output; these settings are not a tokenizer, compaction guarantee, or hard override of explicit per-session token caps.

The admitted GCP catalog also publishes exactly three R5300-only variants: GLM 5.3 Flash Uncensored FP8 on stable loopback port 18085, DeepSeek V4 Flash Vision Experimental on 18083, and DeepSeek V4 Flash Vision Uncensored on 18084. Each is limited to its measured 4,096-token context, 1,024-token output cap, text/image input, and lifecycle-dispatch availability probe. A cold listener remains selectable because the lifecycle manager executes before adapter dispatch. A downloaded artifact outside the exact admitted route set is never added.

Explicit OrcaSAQ identity tokens in provider IDs/display names or model IDs/names still trigger exclusion. Generic GLM/local names, descriptions, URLs, and OrcaRouter do not. Mixed OrcaSAQ catalogs retain their other models. An entirely excluded catalog or an OrcaSAQ catalog override holds the whole provider, avoiding empty-list fallback to installed models. Every affected original profile is retained in `held-providers.yaml`; never load that archive as active settings. All other provider profiles remain in the candidate. Reapplying the pure merge to candidate settings is idempotent; file preparation always requires a fresh directory. Retain the first archive when preparing from an existing candidate.

All admitted local catalogs use `availabilityProbe.phase: dispatch`. The application can therefore render them without requiring listeners at startup. The Qwen route is normalized to the exact admitted model with a truthful 32,768-token deployment window and a 4,096-token output cap; the smaller common contract keeps pressure compaction aligned across R5300 and PRDG instead of advertising the model artifact's larger theoretical capacity. The lifecycle manager runs first when a user dispatches to a cold route; only after a successful load/health/probe sequence does the adapter send the chat request. A failed lifecycle dispatch remains a model-unavailable result and must not fall through to a mismatched provider.

The integrating composition must mount [llm-pi-ai](../packages/llm/llm-pi-ai/README.md) without excluded base routes: removing user-layer dictionary keys cannot remove composition-layer providers. Verify the actual composition before any separate activation. YAML formatting/comments are not preserved; values and alias-referenced preferences are preserved. Candidate and archive files may contain the source's inline secrets, so keep them outside repositories with private ACLs. No credentials or source excerpts are printed or included in the status file.

A stopped listener and no resident GLM are expected at empty startup and do not invalidate an executable lazy route. Externally verified `loadAtFirstRequest` capability permits a prepared new-chat default without loading a model during preparation. Residency/listener observations never substitute for driver evidence. Without a verified executable driver, keep `routeReady: false`; claiming readiness without the required lazy-driver evidence is rejected. Lazy loading belongs to the separately admitted deployment driver, not this settings preparer; the script never starts a listener, implements the driver, or changes live readiness.

## Scoped Tests

```powershell
pnpm exec vitest run scripts/giana-cowork-local-model-settings.spec.ts
```

Pure tests cover merge, readiness, idempotency, alias/session preservation, exact exclusion, and path validation. Filesystem/CLI tests run on Windows when `N:/codex-test-temp` exists, use only synthetic credentials in isolated N: fixtures, and clean those fixtures. No application server or live model is required.
