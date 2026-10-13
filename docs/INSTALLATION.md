# 安装与升级指南

## 要求
Debian/Ubuntu + systemd，Node.js >=22、Python 3；对外需要 HTTPS 域名。首次安装需要 root SSH，不要从 MCP 工具里运行安装器。

## 新装
将完整发行版 ZIP 解压到服务器；先执行 `./install.sh --dry-run --mode fresh --domain mcp.your-domain.org --proxy caddy` 预览，随后执行 `sudo ./install.sh`，选 Fresh install，输入实际域名，选择 Caddy 自动 HTTPS 或现有反向代理，选择是否安装 DC。已安装实例请选 Upgrade，不要覆盖。

Caddy 自动证书需要域名 DNS 指向服务器且 80/443 可达。若选 External，需要自行反向代理 `127.0.0.1:18787`，启用 HTTPS，注意 OAuth 及签名链接不要记录到访问日志。不要将 HTTP 原始端口暴露到公网。

## 完成后
检查 `systemctl status chatgpt-dev-mcp`、`curl http://127.0.0.1:18787/health`。后台为 `https://域名/admin/`，MCP 为 `https://域名/mcp`。OAuth 与 Admin 密码由安装器生成，分别在 `/etc/chatgpt-dev-mcp/owner-password` 和 `/etc/chatgpt-dev-mcp/admin-password`，仅在 root SSH 中读取。

ChatGPT 端添加 HTTPS MCP 服务后需要刷新、审核与发布工具清单；服务器可见的 16 个工具不意味着旧聊天的工具快照自动更新。

## 升级
先运行 `./install.sh --dry-run --mode upgrade`，然后由 root 运行 `sudo ./install.sh` 选择 Upgrade。只替换受清单管理的运行时文件，保留私有状态、项目、服务 unit、HTTP 代理和已有凭据；文件更新前检查生产文件哈希，升级失败会尝试回滚。升级重启网关，可能暂时中断 ChatGPT 连接。安装过程的备份位于 `/var/backups/chatgpt-dev-mcp-installer`。

## 诊断
`./install.sh --check` 不改动文件。不要提交服务 `.env`、OAuth 密钥、备份与签名下载 URL。
