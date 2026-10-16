# Cloudflare Tunnel：可选公网接入

[项目首页](../../README.md) · [开发日志](../../CHANGELOG.md) · [English](../CLOUDFLARE.md)

v0.3.11 推荐顺序：**自定义 HTTPS 域名（首选） > Cloudflare Tunnel（第二） > sslip.io（第三）**。Tunnel 适合无公网 IP、NAT 后面的机器，无需开放入站 80/443。网络仍需允许向 Cloudflare 的 7844 TCP/UDP 出站。

## 按需安装
选择 Cloudflare Tunnel 首次安装时，会自动安装 cloudflared；选择其他接入方式时不安装。普通升级不会额外安装它。后台没有执行 sudo/apt 的权限。Debian/Ubuntu SSH 可运行：

    curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --install-cloudflared --yes

此命令使用 Cloudflare 官方签名 APT 源。先使用 --install-cloudflared --dry-run 可验证不修改系统。你也可以自行安装 cloudflared。

### 首次固定域名配置：SSH 本地入口

如果新安装的是固定域名模式，而 Cloudflare Tunnel 尚未创建，请先通过 SSH 从自己的电脑访问后台：

    ssh -L 18787:127.0.0.1:18787 user@your-server

浏览器打开 http://localhost:18787/admin/ 并登录，然后配置 Cloudflare 固定域名 Tunnel。安装器只在明确选择 Cloudflare 的新安装中允许该回环 Origin；它不把管理端口暴露到公网。浏览器对 localhost Secure Cookie 的例外兼容性可能不同，建议使用 Chromium/Firefox，Safari 可先临时启用 Quick Tunnel 完成配置。请勿使用网页下载的脚本或公共 HTTP URL 传输凭据。

## Quick Tunnel（仅供测试）
打开管理后台 /admin/#tunnel，输入管理员密码后点击“启动 Quick Tunnel”。会自动识别临时 trycloudflare.com 公网地址、显示 /mcp 接入点，并同步更新 OAuth issuer 和 HTTP 允许来源。重新连接 ChatGPT 应用时必须使用新地址并完成 OAuth。

新的服务器安装向导中，可以选择第二推荐的 Cloudflare 模式；选择 Cloudflare 后自动安装 cloudflared 并尝试第一次 Quick 启动（公网地址会出现在后台和日志）。命令行也可明确选择 --access-method cloudflare --cloudflare-mode quick。

**临时地址会变化，没有 SLA，有 200 个在途请求上限，不支持 SSE。长期使用请改固定域名。**

## 固定域名 Tunnel（推荐）
前提：域名的 DNS 由 Cloudflare 管理。提供两种接入方式。

**自动配置：** 在后台输入 Tunnel 名称、公网 hostname、Account ID、Zone ID、一次性 Cloudflare API Token（账户 Cloudflare Tunnel Edit、Zone DNS Edit 权限）。服务端顺序创建远程管理 Tunnel、为本机 http://127.0.0.1:18787 配置 ingress 与末尾 404 兜底，再创建指向 Tunnel UUID 的 proxied CNAME。已有 DNS 记录绝不覆盖。管理员 API Token **不落盘**，仅保存权限更小的 tunnel run token 于权限 0600 文件，通过 --token-file 参数启动，不出现在进程命令行。

**使用已有 Tunnel：** 在 Cloudflare 控制台建立 remotely-managed Tunnel，配置 Public Hostname 与本机 Service URL http://127.0.0.1:18787、DNS 记录，然后在后台输入 Add a replica 中的运行 Token 和固定 hostname。无需管理 API Token。

固定 Tunnel 会在 MCP 网关重启后自动尝试恢复。停止保留本地令牌但关闭自动恢复；恢复会重新启动；移除只删除本地配置，不删除 Cloudflare 账户上的 Tunnel 或 DNS。每个修改操作需要管理员登录、CSRF 及重复输入管理员密码。普通 MCP 工具不能操控 Tunnel。

## 诊断与安全
“诊断”同时检查本机和公网 /health。若本机健康而公网不通，请检查域名/DNS、Cloudflare ingress、7844 TCP/UDP 出站及 cloudflared 日志。公开公网入口后，仍须保护 OAuth 及 Admin 密码。需要时可结合 Cloudflare Access，但须先测试 ChatGPT OAuth 回调兼容性。

文档：
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
https://pkg.cloudflare.com/
