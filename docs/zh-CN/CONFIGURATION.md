# 配置说明

[中文首页](../../README.md) · [English](../CONFIGURATION.md)

安装器将敏感环境配置保存在 root-only 文件 `/etc/chatgpt-dev-mcp/service.env`。切勿提交、截图或粘贴其中的密码、令牌和私有访问链接。

| 配置 | 含义 |
| --- | --- |
| `HOST`, `PORT` | 后端 HTTP 监听地址及端口（推荐 `127.0.0.1:18787`） |
| `PUBLIC_BASE_URL` | 公网 HTTPS 地址，例如 `https://mcp.yourdomain.org` |
| `WORKSPACE_ROOT` | 持久化项目目录 |
| `MCP_DATA_ROOT` | 私有状态、OAuth 与任务记录 |
| `MCP_OWNER_PASSWORD`, `MCP_ADMIN_PASSWORD` | OAuth 所有者及管理后台的独立凭据 |
| `OAUTH_REDIRECT_ORIGINS` | 允许的 OAuth 回调来源 |
| `FILE_DOWNLOAD_ORIGINS` | 允许从原生附件获取文件的来源 |
| `EXECUTION_UID`, `EXECUTION_GID`, `EXECUTION_HOME` | 低权限执行身份 |
| `EXECUTION_ENV` | 运行命令的 PATH、Cargo/Rustup 等环境 |
| `MCP_TOOL_PROFILE` | `core` / `native-interactive` / `interactive` / `legacy` |
| `DESKTOP_COMMANDER_COMMAND` | 可选 DC 桥接命令 |
| `MAX_JOBS`, `MAX_FILE_BYTES`, `MAX_RESOURCE_BYTES` | 并发与文件上限 |

后台可配置 OAuth Access Token 和 Refresh Token 有效期、会话持久化、客户端注册和凭据撤销。修改新的有效期通常**仅影响新签发的凭据**，不自动延长已存在的令牌。ChatGPT 是否自动刷新由客户端决定。

更改 systemd 环境文件后需要重启服务；不建议通过任意脚本直接编辑已有生产配置。示例见项目根目录 `.env.example`。
