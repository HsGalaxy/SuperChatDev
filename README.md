# SuperChatDev

**专为 ChatGPT 原生网页版打造的 MCP 开发环境。**
不是 All-in-One Agent 框架，不是 IDE，也不是万能工具箱。

[**简体中文**](README.md) · [English](README.en.md) · [安装指南](docs/zh-CN/INSTALLATION.md) · [使用与工具](docs/zh-CN/TOOLS.md) · [常见问题](docs/zh-CN/TROUBLESHOOTING.md) · [开发日志](CHANGELOG.md)

让 ChatGPT 在原生聊天窗口里完成一整个开发任务：上传 ZIP → 读取和搜索代码 → 修改文件 → 构建与测试 → 检查 Git Diff → 直接回传可下载的成品。

## 可靠性与资源隔离

v0.3.12 新增可选独立 Runner、分级 systemd 资源配额、按需 DC、正确的文件导出 ResourceLink、轻量诊断与真实任务成功率统计。**不自动迁移旧服务配额，也不会修改敏感内容捕获策略。**部署前请阅读 [可靠性与资源隔离指南](docs/zh-CN/RELIABILITY.md)。

## 开发日志

管理后台左侧新增独立「开发日志」页面，登录后可从 /admin/#devlog 直接进入。它按版本展示功能、修复与计划，支持关键词搜索、筛选；内容来自随服务发布的 [CHANGELOG.md](CHANGELOG.md)，与 GitHub 使用同一份资料，和 MCP 运行日志、调用记录分开。

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

## 为什么专为 ChatGPT Web 设计？

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

安装完成后，把 `https://你的域名/mcp` 添加到 ChatGPT 的 MCP 应用配置中。后台位于 `https://你的域名/admin/`，本机默认健康检查为 `http://127.0.0.1:18787/health`。按客户端要求完成 OAuth 登录。服务器升级了工具 Schema 后，可能还需要在 ChatGPT 工作区刷新、审核并发布工具定义。

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

## 更新日志

新功能、修复、安全改进和升级兼容性说明统一维护在 **[CHANGELOG.md（完整开发日志）](CHANGELOG.md)**。README 只保留项目介绍、安装与使用指南。
