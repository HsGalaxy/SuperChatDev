# 快速开始

[返回中文首页](../../README.md) · [English](../QUICKSTART.md)

SuperChatDev 只为 ChatGPT 原生网页版 MCP 开发而设计，单服务器、单受信任所有者。

## 一键安装

在 Debian/Ubuntu 的 SSH 终端执行：

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash
```

按回车选择**简体中文**，再选择首次安装或升级。如果是首次安装，准备一个指向本 VPS 的域名并按向导配置 HTTPS（Caddy 自动或已有反向代理）。后台密码及 OAuth 密码会自动生成并安全保存。

需要英文？在首个语言菜单输入 `2`，或者使用：

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en
```

首次安装会先检测公网 IPv4，并推荐使用 `IP.sslip.io` 作为**第二项（回车默认选择）**；也能手动输入域名。最终确认 `[Y/n]` 默认继续安装。

## 接入 ChatGPT

1. 安装器输出 `https://你的域名/mcp` 和 `https://你的域名/admin/`。
2. 在 ChatGPT 工作区中添加 MCP 应用，使用前者作为服务地址。
3. 完成 OAuth 授权；根据平台要求审核和发布工具清单。
4. 上传项目 ZIP：导入、解压、读取、修改、测试、审查、回传。

**提醒：** 网页端 MCP 工具可能有已发布的缓存定义。服务器升级不会自动刷新 ChatGPT 的工具列表。

[完整安装指南](INSTALLATION.md) · [工具介绍](TOOLS.md) · [问题排查](TROUBLESHOOTING.md)
