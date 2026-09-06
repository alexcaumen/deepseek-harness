# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

面向用户的产品是 **Giana CoWork Preview (GCP)**，与另一 CCW 拥有的官方 GCW 不同。`official` 构建配置标识和上游包名属于技术来源信息，不代表 GCW 所有权或生产验收。slot 和 fallback 字标都保留可见的 Preview，并使用现有的用户提供的标志。

纯源码布局 QA 使用 `GCP_BRAND_VISUAL_QA=1 pnpm exec vitest run apps/web/tests/branding-layout.spec.ts`，需要已安装的 Playwright Chromium，不启动后端或使用私有 home。可选的 `GCP_BRAND_SCREENSHOT_DIR` 将截图写入 checkout 之外。构建后的应用和桌面发布验证仍然独立进行。

仅当 `DSH_CLIENT_BUILD_PROFILE` 为 `official` 时，本包才填充 `sidebar.brand.mark`、`sidebar.brand.name` 和 `conversation.hero.brand.mark`。其他构建仍会加载插件，但不注册 occupant，因此显示 shell fallback。

三个占位者通过嵌套的 `slots.inject()` 作为一组声明感知注册安装。因此无论该包的条目先于还是后于侧边栏和会话声明方激活，它都能工作；任一声明折叠时会撤回全部占位者，HMR 期间不会留下混合品牌。它不保留运行时状态。node 半边是空的 Loader seat；浏览器标题仍属于本包之外的构建环境事项。

## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **本包只提供一组 occupant** —— 其他呈现应由占用相同 slot 的另一个 Cordis 包提供。
- **浏览器标题相互独立** —— `DSH_CLIENT_TITLE` 在构建期选择标题文字，而不经过 UI slot。
