# 日常维护手册

[中文首页](../../README.md) · [English](../OPERATIONS.md)

## 服务与日志

```bash
systemctl status chatgpt-dev-mcp --no-pager
curl -fsS http://127.0.0.1:18787/health
journalctl -u chatgpt-dev-mcp -n 100 --no-pager
```

实际端口以 `service.env` 为准。公网管理入口为 `https://域名/admin/`；管理员可检查调用审计、Job、Workspace 批处理与 OAuth 会话。

## 备份与升级

主要数据在 `/var/lib/chatgpt-dev-mcp/workspace` 和 `/var/lib/chatgpt-dev-mcp/state`；配置在 `/etc/chatgpt-dev-mcp`。请定期将这些目录离线加密备份，切勿提交到 GitHub。升级安装器会保存运行时文件与私有状态快照（`/var/backups/chatgpt-dev-mcp-installer`），但**不能替代完整的异地备份**。

升级前执行只读检查或 `--dry-run`。更新期间可能需要重新授权 ChatGPT；OAuth 自动续期还需要客户端支持 Refresh Token。网关重启后可以继续查询保留的任务，但整机重启不会重新执行已中断命令。

## 安全操作

不要为图方便给 MCP 运行账号配置无限制 sudo。不要在日志、Issue 或聊天中公开密码、刷新令牌、签名下载 URL。遇到不同步或超时，先按 `request_id` / `job_list` 查证，避免重复执行有副作用的命令。
