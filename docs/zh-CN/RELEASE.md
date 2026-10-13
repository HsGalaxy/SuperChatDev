# 发行说明

[中文首页](../../README.md) · [English](../RELEASE.md)

**v0.3.1：** ChatGPT 原生网页端专用 MCP 工具组合，16 个 Core 工具、500ms 命令快速返回、持久 Job、多步骤改测验闭环、PKCE OAuth 与可轮换 Refresh Token。

**本次发行增强：** GitHub 首页默认中文，增加完整中英文文档；`install.sh` 支持从源码目录直接安装，也支持 `curl | sudo bash` 无克隆远程引导。语言默认中文，`--lang en` 或初始菜单可切换英文。

正式部署仍需用户拥有 Linux 服务器及 HTTPS 域名；安装器的单元测试与 Dry Run 不能替代真实公网证书签发和 ChatGPT 网页端授权验收。
