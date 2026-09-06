# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

The user-facing product is **Giana CoWork Preview (GCP)**, distinct from official GCW owned by another CCW. The `official` build-profile identifier and upstream package names are technical provenance, not GCW ownership or production acceptance. Both the slotted and fallback wordmarks keep Preview visible and use the existing user-provided logo.

Source-only layout QA runs with `GCP_BRAND_VISUAL_QA=1 pnpm exec vitest run apps/web/tests/branding-layout.spec.ts`; it requires an installed Playwright Chromium and does not boot a backend or use a private home. `GCP_BRAND_SCREENSHOT_DIR` optionally writes screenshots outside the checkout. Built application and desktop release verification remain separate.

This package fills `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` only when `DSH_CLIENT_BUILD_PROFILE` is `official`. Other builds load the plugin but register no occupants, leaving the shell fallbacks visible.

The three occupants install as one declaration-aware registration set through nested `slots.inject()` calls. The package therefore works whether its row activates before or after the sidebar and conversation declarers, withdraws all occupants when either declaration collapses, and leaves no partial brand mix during HMR. It retains no runtime state. The node half is an empty Loader seat, and the browser title remains a build-environment concern outside this package.

## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The package supplies one occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.
