# 快速开始

[项目首页](../../README.md) · [English](../QUICKSTART.md)

## 1. 安装

Debian / Ubuntu SSH 终端：

~~~bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash
~~~

选 **首次安装**，再选一种接入方式：

- 有域名 → 自动配置 Caddy HTTPS
- 没有域名 / 公网 IP → Cloudflare Tunnel（自动安装 cloudflared）
- 有公网 IP → sslip.io（自动配置 Caddy）

Node.js 22+ 不存在时会自动安装。安装完成后显示 MCP URL、后台 URL 和两组密码（交互式 root SSH）。

## 2. 添加到 ChatGPT

打开 ChatGPT **设置 → 应用 → 创建自定义 MCP 应用**，粘贴输出的 MCP URL，用 OAuth 登录密码完成授权，扫描并启用工具。

例如：

> 帮我检查服务器上的项目、修复报错、运行测试，再把项目打包发给我。

*ChatGPT 工作区需要支持自定义 MCP 和写入操作。*

## 3. 需要帮助？

[详细安装说明](INSTALLATION.md) · [Cloudflare Tunnel](CLOUDFLARE.md) · [问题排查](TROUBLESHOOTING.md) · [工具列表](TOOLS.md)
