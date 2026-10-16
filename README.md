# SuperChatDev

**让 ChatGPT 直接操作你的 Linux 服务器。**

在 ChatGPT 原生聊天里读写代码、运行命令、构建项目、测试、查看 Git。你上传 ZIP，它在你的 VPS 上工作，再把修改好的项目发回同一段聊天。

**不需要单独购买模型 API，也不用切换到另一个开发客户端。** 将 ChatGPT 连接到自己已有的开发环境即可。

[English](README.en.md) · [快速开始](docs/zh-CN/QUICKSTART.md) · [安装指南](docs/zh-CN/INSTALLATION.md) · [GitHub Releases](https://github.com/HsGalaxy/SuperChatDev/releases)

## 🚀 一条命令安装

在 Debian / Ubuntu 的 SSH 终端执行：

~~~bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash
~~~

安装向导只需要你选择**接入方式**：

- **已有域名**：使用自己的 HTTPS 域名，安装器可以配置 Caddy。
- **没有域名 / 公网 IP**：选择 **Cloudflare Tunnel**，自动安装 cloudflared 并创建临时连接。
- **有公网 IP、没有域名**：选择自动生成的 sslip.io 域名。

Node.js 22+ 和所选方案必需的依赖会**自动安装，已安装则跳过**。Desktop Commander 是可选增强功能。

安装成功后，你会看到：

~~~text
✅ SuperChatDev 安装成功

MCP 接入地址： https://your-address.example/mcp
管理后台：   https://your-address.example/admin/

ChatGPT OAuth 登录密码：<安装器生成>
管理员后台密码：      <安装器生成>
~~~

上面只是输出格式示意，实际地址和密码由安装器生成。密码在交互式 root SSH 终端直接显示，也会保存在 /etc/chatgpt-dev-mcp/。非交互安装只打印读取密码的命令。Cloudflare 地址尚未生成时，安装器会告诉你如何查询，不会显示假的占位地址。

## 🔗 连接 ChatGPT

1. 打开 **ChatGPT → 设置 → 应用 → 创建自定义 MCP 应用**。
2. 粘贴安装器提供的 **MCP 接入地址**。
3. 使用 **OAuth 登录密码**授权，并扫描/启用工具。

现在直接告诉 ChatGPT：

> 帮我检查服务器上的项目，修复构建错误，运行测试，最后把完整项目打包给我。

*需要 ChatGPT 工作区支持自定义 MCP 应用及相应写入操作。*

## ✨ 功能

| 想完成的事 | SuperChatDev |
| --- | --- |
| **编辑项目** | 列目录、搜索、读写代码、应用补丁 |
| **使用开发工具** | 命令执行、npm / Go / Rust 构建与测试 |
| **处理长任务** | 持久任务 ID、增量日志、状态查询、取消 |
| **双向传文件** | 上传 ZIP、解压处理、回传可下载结果 |
| **审查变更** | Git 状态、差异与检查结果 |
| **运维服务器** | Web 管理后台、OAuth、性能监控、可选独立 Runner |

默认只有 **17 个核心 MCP 工具**。代码、依赖、网络、CPU/GPU 都在自己的 Linux 服务器上；systemd 服务支持长期运行。

## 💡 为什么做它？

**在熟悉的 ChatGPT 聊天窗口里，直接使用自己已经拥有的 Linux 开发环境。**

不用把仓库搬到新的云工作区，不用再配置一套按 Token 计费的模型 API。项目文件、构建缓存和长期运行的服务都在你的机器上。

## 📖 文档

[安装和升级](docs/zh-CN/INSTALLATION.md) · [MCP 工具](docs/zh-CN/TOOLS.md) · [Cloudflare Tunnel](docs/zh-CN/CLOUDFLARE.md) · [故障排查](docs/zh-CN/TROUBLESHOOTING.md) · [高级配置](docs/zh-CN/CONFIGURATION.md) · [更新日志](CHANGELOG.md)

**MIT License** · **v0.3.12**
