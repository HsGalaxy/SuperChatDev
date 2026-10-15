# SuperChatDev

**Your ChatGPT subscription. Your server. Your code.**

**开源 MIT · 自有 Linux VPS · 17 个 Core MCP 工具 · 不必另配模型 API Key**

> **让 ChatGPT 原生网页聊天，直接变成你自己的 Linux 开发工作台。**
> 上传项目 → 阅读和修改代码 → 执行命令 → 构建与测试 → 检查 Git → 下载成品。全过程就在同一段 ChatGPT 对话里。

[**简体中文**](README.md) · [English](README.en.md) · [🚀 快速安装](#-一条命令安装) · [完整功能](docs/zh-CN/TOOLS.md) · [Cloudflare Tunnel](docs/zh-CN/CLOUDFLARE.md) · [更新日志](CHANGELOG.md)

### 💸 已经在订阅 ChatGPT？让这份订阅连接你自己的服务器

不少 AI 编程工具需要单独配置模型 API Key，并按 Token 付费。**SuperChatDev 不是另一个按 Token 收费的模型客户端**：它是开源的 MCP 开发服务，让**有相应自定义 MCP 权限的 ChatGPT 工作区**直接调用你自己的 Linux 机器；SuperChatDev 本身不要求 OpenAI API Key，也不会为这些 MCP 工具调用另开一份模型 API 账单。

你继续使用已有 ChatGPT 套餐的**包含用量及适用限制**，计算、磁盘、项目和运行环境则由你自己的 VPS / Linux 服务器提供。适合已经在 ChatGPT 里交流需求、不想为了执行代码再搭一套 API Agent 的开发者。

**关键区别：省的是“额外接入一套按量计费的模型 API”这件事，而不是声称 Codex 需要额外订阅——Codex 也已经包含在 ChatGPT 套餐中。** ChatGPT 套餐费用、可能的额外 Credits，以及自有服务器费用仍需分别考虑。

### ⚡ 相比直接使用 Codex，有什么不一样？

Codex 是成熟的编程智能体，也有网页、CLI、IDE 和云端等工作方式。**SuperChatDev 不声称模型比 Codex 更强或一律更便宜**；它专注于另一个场景：**不离开日常 ChatGPT 对话，把自己的长期 Linux 开发环境接进来。**

| 开发体验 | SuperChatDev 的特点 | Codex 的工作方式 |
| --- | --- | --- |
| **入口** | 直接在日常 ChatGPT 聊天中讨论、调用工具、处理附件 | 专门的 Codex Web、CLI、IDE 和桌面工作流 |
| **运行环境** | 固定使用你自己的 Linux VPS；依赖、网络、GPU / CPU、服务完全自定 | Codex Cloud 提供托管环境；CLI / IDE 也可以在自己的机器上工作 |
| **文件交付** | 对话附件导入 ZIP → 修改、构建、测试 → 文件链接返回同一聊天 | 擅长代码仓库、代码审查与专门的编程智能体工作流 |
| **长任务** | 可查询的持久 Job ID、增量日志、批处理和幂等 `request_id` | 使用 Codex 自身的任务机制；两者侧重点不同 |
| **可控性** | 开源 MCP 工具、独立 Admin、OAuth、可选 DC / Cloudflare / Runner | 官方维护的 CLI / IDE / Cloud Agent 生态 |

**它不是 Codex 的性能跑分替代品，而是 ChatGPT-first、BYO-server（自带服务器）的另一种开发工作流。** 如果你更喜欢 Codex 原生的 IDE / CLI / Cloud Agent，继续用 Codex 完全合理。

<details>
<summary><strong>💳 订阅费用、Plan 权限和限制（发布前请看）</strong></summary>

- ChatGPT **Plus 官方价格为 US$20/月**，但截至 2026 年 10 月，**完整的自定义 MCP 写入/修改能力主要在 Business、Enterprise、Edu 工作区的 Beta 中提供**；**不能把 Plus 20 美元宣传为这套工具可完整使用的门票**。
- ChatGPT **Business Standard** 官方标价为 **US$20/席位/月（年付）或 US$25/席位/月（月付）**，新建 Business 工作区至少需要 **2 个付费席位**。实际是否可创建和使用写入型 MCP 应以工作区的权限与灰度开放情况为准。
- **Codex 已包含在 ChatGPT 套餐中**，并有自己的适用用量限制、可能的额外 Credits；SuperChatDev 不绕过 ChatGPT 的任何额度、确认弹窗或平台政策。
- 本项目不调用另行购买的 OpenAI API；但仍需要符合条件的 ChatGPT 订阅、你自己的服务器及其带宽/存储费用。**并非无限免费，更不保证一定比 Codex 更省钱。**

官方说明：[ChatGPT Plus](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus) · [Business 价格](https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business) · [完整 MCP 可用性](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) · [Codex 与订阅](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)。

</details>

### 🎯 用一句话交付完整项目

> “这是我的项目 ZIP。分析代码结构，把它迁移到 Linux，完成缺失功能，运行测试，审查 Diff，最后把可运行的完整项目 ZIP 发还给我。”

SuperChatDev 负责提供连接服务器的执行能力；实际修改、规划和代码质量由你在 ChatGPT 中使用的模型、权限、提示词以及测试结果决定。

## 🚀 一条命令安装

在 **Debian / Ubuntu** 的 SSH 终端里运行：

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash
```

**不用克隆仓库。默认中文。** 第一步可以选择 `1. 简体中文`（默认）或 `2. English`，接下来按提示选择新装/升级、输入域名、配置 HTTPS、可选安装 Desktop Commander。安装器生成凭据、设置 systemd 和持久化工作区，并进行健康检查。

<details><summary>English installer / 英文安装</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en
```

</details>

### 公网接入方式（推荐顺序）

1. **自定义 HTTPS 域名（首选）**：Caddy 自动签证书，或使用自己的现有 HTTPS 反向代理；固定地址，适合长期运行。
2. **Cloudflare Tunnel（第二推荐）**：无需公网 IP、无须开放入站端口；Quick 用于临时测试，固定域名模式可通过管理后台配置 Cloudflare API 自动创建 Tunnel、路由和 DNS。只在主动启用时按需安装 cloudflared。
3. **自动 sslip.io 域名**：无需注册域名，但需要入站公网 IP、开放 80/443 并配置 HTTPS。

**详细操作说明：** [Cloudflare Tunnel 连接指南](docs/zh-CN/CLOUDFLARE.md)。首次启用 Cloudflare 的完整流程、临时地址变化后 OAuth 重连、可选安装、故障排查均在该页面，不在 README 维护大段开发日志。

> **安全提示：** 一键安装脚本以 root 运行，请先核对来源。Cloudflare Quick Tunnel 没有生产可用性保证，固定域名模式更适合长期接入；管理员权限和 OAuth 仍必须妥善保护。

### 想先检查脚本？

```bash
curl -fsSLo superchatdev-install.sh https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh
less superchatdev-install.sh
sudo bash superchatdev-install.sh
```

### 已经安装过？

执行同一条命令，向导会检测到现有安装并默认选择**升级**，保留 OAuth 凭据、配置、工作区和现有代理设置。建议操作前备份重要项目和数据。可先用以下方式只查看安装计划：

```bash
git clone https://github.com/HsGalaxy/SuperChatDev.git
cd SuperChatDev
./install.sh --dry-run --mode upgrade
```

## ChatGPT Web 原生开发流程：如何实现？

| 特点 | 说明 |
| --- | --- |
| 原生聊天附件 | `file_import` 导入用户上传的文件；`file_export` 将服务器生成的结果返回聊天 |
| **500ms 快速执行** | `job_start` 对短命令一次返回结果；长命令返回可继续查询的任务 ID |
| 持久化工作区 | 默认 `/var/lib/chatgpt-dev-mcp/workspace`，适合长期代码项目 |
| 完整开发闭环 | 文件导航、SHA-256 防并发覆盖、补丁、测试、Git 只读审查 |
| OAuth 与管理后台 | PKCE、轮换刷新令牌、细粒度策略和独立 Web 设置页 |
| 精简工具数量 | 17 个默认核心工具；可选内置 PTY 输入或 DC 桥接，默认不暴露冗余工具 |

```text
ChatGPT 网页端
    │ 原生附件上传
    ▼
file_import → file_unpack
    ▼
fs_list / fs_search / fs_read
    ▼
workspace_execute ── job_start
(修改 / 测试)         (单命令；短任务直接返回)
    ▼
workspace_review
    ▼
file_export
    │
    ▼
聊天中直接下载完整项目
```

## 连接 ChatGPT

安装完成后，在**已获自定义 MCP 写入权限的 ChatGPT 工作区**，把 `https://你的域名/mcp` 添加到 MCP 应用配置中。后台位于 `https://你的域名/admin/`，本机默认健康检查为 `http://127.0.0.1:18787/health`。按客户端要求完成 OAuth 登录。服务器升级了工具 Schema 后，可能还需要在 ChatGPT 工作区刷新、审核并发布工具定义。

## 核心工具（17 个）

| 任务 | 工具 |
| --- | --- |
| 环境信息 | `dev_get_guide` |
| 上传 / 解压 / 下载 | `file_import`、`file_unpack`、`file_export` |
| 源码查找与阅读 | `fs_list`、`fs_read`、`fs_search` |
| 快速单次执行 | `exec`（短命令，直接返回，无持久记录） |
| 可恢复任务与进程管理 | `job_start`、`job_read`、`job_list`、`job_cancel` |
| 多步骤开发与测试 | `workspace_execute`、`workspace_read`、`workspace_list`、`workspace_cancel` |
| Git 只读审查 | `workspace_review` |

`exec` 用于**短而可重复的查询命令**；`job_start` 用于**长命令、交互、带副作用且需要幂等重试的操作**，默认最多等待 500ms；`workspace_execute` 用于有依赖关系的多步骤修改、构建和测试。

## 可靠性与开发日志

v0.3.12 提供可选独立 Runner、systemd 配额迁移和任务执行状态指标。见 [资源隔离与可靠性](docs/zh-CN/RELIABILITY.md)。版本记录在 [CHANGELOG.md](CHANGELOG.md)，管理后台也有独立的开发日志页面（/admin/#devlog），README 不堆叠开发日志。

## 文档

| 中文（默认） | English |
| --- | --- |
| [快速开始](docs/zh-CN/QUICKSTART.md) | [Quick start](docs/QUICKSTART.md) |
| [安装与升级](docs/zh-CN/INSTALLATION.md) | [Installation](docs/INSTALLATION.md) |
| [架构](docs/zh-CN/ARCHITECTURE.md) | [Architecture](docs/ARCHITECTURE.md) |
| [配置](docs/zh-CN/CONFIGURATION.md) | [Configuration](docs/CONFIGURATION.md) |
| [工具接口](docs/zh-CN/TOOLS.md) | [Tool contracts](docs/TOOLS.md) |
| [日常维护](docs/zh-CN/OPERATIONS.md) | [Operations](docs/OPERATIONS.md) |
| [安全说明](docs/zh-CN/SECURITY.md) | [Security](docs/SECURITY.md) |
| [故障排查](docs/zh-CN/TROUBLESHOOTING.md) | [Troubleshooting](docs/TROUBLESHOOTING.md) |
| [参与开发](docs/zh-CN/DEVELOPMENT.md) | [Development](docs/DEVELOPMENT.md) |

## 本地开发与测试

```bash
git clone https://github.com/HsGalaxy/SuperChatDev.git
cd SuperChatDev
npm run check
npm test
python3 -m unittest discover -s test -p 'test_installer*.py'
```

**适用范围：** 单一受信任所有者；不是多租户执行沙箱。MCP 不能绕过 ChatGPT 网页端的平台级授权弹窗，也不能保证客户端一定支持 OAuth 自动刷新。Job 可在网关进程重启后恢复查询，但机器重启不会自动继续执行命令。

**许可证：** [MIT](LICENSE) · **当前版本：** v0.3.12
