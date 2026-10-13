# 架构概览

[中文首页](../../README.md) · [English](../ARCHITECTURE.md)

SuperChatDev 不是 All-in-One 产品，而是 ChatGPT 网页端的自托管 MCP 开发运行时。设计目标是：以少量稳定的工具，完成原生附件上传、项目阅读、受控修改、构建/测试和成果回传。

```text
ChatGPT 原生网页版
    │ MCP over HTTPS / OAuth
反向代理：Caddy 或现有代理
    │ 127.0.0.1 内部 HTTP
SuperChatDev 网关
    ├─ OAuth PKCE / Refresh Token / Admin
    ├─ File Runtime (原生附件传输)
    ├─ Code Runtime (有界搜索与读取)
    ├─ Job Runtime (单命令、500ms 快速完成或持久 Job)
    ├─ Workspace Runtime (带依赖的多步修改/测试)
    ├─ Git Review (只读)
    └─ 可选 Desktop Commander 桥接
    │
受限 Linux 执行账户
    └─ /var/lib/chatgpt-dev-mcp/workspace
```

默认 **16 个 Core 工具**。Interactive/Legacy 仅作为按需增强，DC 并非必选依赖。单条命令用 `job_start`；多步骤操作用 `workspace_execute`，不增加另一个相同作用的 `exec`。

源码工具返回行号和文件原始字节 SHA-256，可配合受保护的写入防止修改旧版本。读取分页、任务 ID、`request_id` 重试控制可以避免 ChatGPT 网页端一次返回过大、重复执行或断线后丢进度。

OAuth 使用公开客户端 PKCE S256 与不透明 Access Token；支持绑定客户端的轮换 Refresh Token（客户端也必须支持刷新）。此服务不是多租户隔离沙箱；任意命令的权限最终取决于 Linux 运行身份。
