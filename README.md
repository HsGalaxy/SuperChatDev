# SuperChatDev

**专为 ChatGPT 原生网页版打造的 MCP 开发环境。**
不是 All-in-One Agent 框架，不是 IDE，也不是万能工具箱。

[**简体中文**](README.md) · [English](README.en.md) · [安装指南](docs/zh-CN/INSTALLATION.md) · [使用与工具](docs/zh-CN/TOOLS.md) · [常见问题](docs/zh-CN/TROUBLESHOOTING.md)

让 ChatGPT 在原生聊天窗口里完成一整个开发任务：上传 ZIP → 读取和搜索代码 → 修改文件 → 构建与测试 → 检查 Git Diff → 直接回传可下载的成品。

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

### 智能域名推荐

首次安装时，向导会先通过 HTTPS 尝试检测服务器的公网 IPv4，然后给出两个选项：

```text
请选择 MCP 域名：
  1. 手动输入域名（已有域名）
  2. 自动推荐：1.2.3.4.sslip.io（无需注册域名）
请选择 [2]：
```

能成功检测到公网 IPv4 时，**第二项是推荐默认值，回车即可选择**；检测失败时会自动退回手动输入。这里的 `1.2.3.4` 只是演示，安装时使用你服务器检测到的地址。最后确认改为 **`[Y/n]`**，回车即开始执行，输入 `n` 可取消。已有域名依旧可选择第一项。

> `sslip.io` 是第三方公共 DNS 服务，省去注册域名与手动设置 A 记录的步骤，但不代表自动配置防火墙。检测到的 IP 可能是 NAT 出口，而不是可被公网访问的入站 IP。使用 Caddy 时仍需确认域名能解析到本机、端口 80/443 可达，才能正常签发 HTTPS 证书。自动 IP 检测只在首次安装且需要选择域名时触发；指定 `--domain` 或运行 Dry Run 不会触发。

> **安全提示：** 一键命令会从公开 GitHub 仓库下载脚本并以 root 运行。请先确认仓库与脚本可信。希望先审查再执行，可以使用下方手动方式。正式部署需要真实 HTTPS 域名、DNS 和正常的 GitHub 网络连接；不能仅靠本机安装完成 ChatGPT 端的连接授权。

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
| 精简工具数量 | 16 个核心工具；可选 DC 交互终端，默认不暴露冗余工具 |

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

## 核心工具（16 个）

| 任务 | 工具 |
| --- | --- |
| 环境信息 | `dev_get_guide` |
| 上传 / 解压 / 下载 | `file_import`、`file_unpack`、`file_export` |
| 源码查找与阅读 | `fs_list`、`fs_read`、`fs_search` |
| 命令执行与任务恢复 | `job_start`、`job_read`、`job_list`、`job_cancel` |
| 多步骤开发与测试 | `workspace_execute`、`workspace_read`、`workspace_list`、`workspace_cancel` |
| Git 只读审查 | `workspace_review` |

`job_start` 用于**单条命令**，默认最多等 500ms；`workspace_execute` 用于**有依赖关系的多步骤修改/构建/测试**，并不是重复的 exec 工具。

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

**许可证：** [MIT](LICENSE) · **当前版本：** v0.3.2（中文/英文安装文档增强）
