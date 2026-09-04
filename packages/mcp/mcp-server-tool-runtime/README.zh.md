# `@deepseek-ai/dsh-mcp-server-tool-runtime`

[English](README.md) | 中文

通过经过认证、仅限回环的 Streamable HTTP MCP 访问当前进程的 `ToolRuntime`。

在 `tools`、`agents` 和 `sessions` 之后加载 Cordis 插件 `ToolRuntimeMcpServer`。可信的进程内消费者调用 `ctx.mcpToolRuntime.issue(agent)`，把返回的 `endpoint` 和 bearer `token` 交给外部 MCP 客户端。该能力绑定到确切的活动 agent 与 session 对象。任一对象离开其注册表、调用 `revoke()` 或插件卸载时，该能力即被撤销。

服务器只绑定 `127.0.0.1` 或 `::1`，不提供未认证模式，也不接受通过 MCP 传入的 agent 或 session 标识。每次列举和调用都读取确切绑定 agent 的 `ctx.tools.wireSchemas(agent).schemas`。Code 模式只通告 `run_code`；native 模式通告原生工具；both 模式通告两者。调用经由 `ctx.tools.execute`，因此作用域可见性、guard、审批与取消仍保持权威。

`run_code` 描述包含由 `ctx.tools.codeSdk(agent)` 生成的当前作用域规范 SDK，包括参数和输出类型。外部客户端无需本地系统提示词即可发现程序绑定。程序内部只能使用该 SDK 声明的确切属性，不得加上 MCP 客户端的服务器前缀。列举失败不会提供回退目录或后端错误详情。列举和调用都会重新读取当前可见性，而不保留发现时的允许列表。

类型化图片结果块只通过确切 agent 作用域的活动 `attachments` 服务解析。桥接使用 MCP 调用的取消信号读取已验证的附件字节，并输出包含规范 base64 数据与已验证 MIME 类型的 MCP 图片内容；不发送附件存储路径或含路径的 URI。图片投影为全有或全无，采用部署附件限制与固定传输上限中较严格者：最多 20 张图片、总计 20 MiB 原始图片字节。存储缺失、元数据被拒、存储对象不匹配、读取失败或取消都会返回通用桥接失败，不泄露部分字节或后端详情。
