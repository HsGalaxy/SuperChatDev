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

**许可证：** [MIT](LICENSE) · **当前版本：** v0.3.9（中文/英文安装文档增强）

### Admin 原生 Git 配置（v0.3.4）

登录 `/admin/` → **Git / GitHub**，可以为实际运行 MCP 命令的执行用户设置 Git 提交身份、生成或导入 GitHub 仓库专属 SSH Deploy Key、复制公钥、检查仓库读取，以及绑定项目的 `origin` 推送地址。已有 `~/.ssh/superchatdev_deploy_ed25519` 可直接安全沿用，不必再次生成密钥。

私钥仅保留在执行用户的私有 SSH 目录，页面和接口只展示公钥；导入、沿用和删除操作需要管理员密码重新确认。GitHub 仍需人工将公钥加入对应仓库的 Settings → Deploy keys，并开启 **Allow write access**。仓库读取成功不代表推送权限已验证。


### v0.3.5：可选性能调试与交互终端增强

在 Admin 左侧新增 **性能调试** 页面。详细调试默认关闭，管理员可以随时打开，查看 MCP 请求的 P50/P95/P99、逐条耗时、HTTP 读取/解析/派发阶段、内部工具调用时间线、请求/响应大小，或导出可离线分析的 JSONL 数据。日志严格排除工具入参、Shell 命令、输出、环境变量、令牌、原始 URL、客户端 IP 和错误消息；使用 1–32 MiB 的滚动文件上限，最多保留当前与上一份。普通 Trace 仍会继续保留既有的基础审计字段。

Interactive/Legacy 模式中的 `job_input` 增加可选的 `wait_for_prompt`，识别常见 Shell/Python/IPython 提示符，直到提示符、退出或超时才返回。`job_read` 可用 `tail_lines` 查看最近 N 行而不改变原来的 `next_offset`。状态提示仅为启发式，不能替代检查退出码。这一版本改变了 `job_read` / `job_input` 的工具 Schema，生产升级后需在 ChatGPT App 中重新刷新、审核并发布工具定义。

### v0.3.9：大型项目原生能力

- fs_search 使用 engine=ripgrep 时支持大仓库高性能内容和文件名搜索、.gitignore、分页及未完成提示。需单独安装系统 /usr/bin/rg；默认原生搜索仍然可用。
- fs_read 可流式读取超过 4 MiB 的 UTF-8 日志指定行号，局部读取不返回全文件 SHA-256。
- native-interactive 模式包含 18 个纯原生工具，提供 job_input 和 PTY，无 DC 依赖；Core 仍为 17 个。
- workspace_execute 新增 rename_directory：配合 fs_list(details:true) 返回的 inode，在 Linux 上做不覆盖目标的原子目录重命名；递归预检拒绝链接、特殊文件和敏感目录。
- 本版仅在开发分支，生产升级后要重新发布客户端工具 Schema。

### v0.3.8：轻量同步 Exec

新 `exec` 在原 16 个核心工具之外增加一个明确不同用途的快速入口：适合 `pwd`、`git status`、`rg` 等短、可重复、通常只读的查询。支持 `argv` 或显式 `command`（干净 Bash）、工作区内 `cwd`、100–30000ms 超时和有限输出。默认 10 秒、输出 16 KiB，最长 30 秒；最多同时执行 2 个，超过 8 MiB 总输出会终止进程。

它直接启动无 PTY 子进程，沿用持久任务的执行身份、环境隔离、权限要求及工作区检查，不保存 Job ID 或日志。输出保留首尾及明确的退出码。

**重要限制：** 没有 `request_id` 去重或重启恢复，不能把网络中断当作“没执行”。文件修改、部署或需要可靠重试的命令应使用 `job_start` / `workspace_execute`。部署后需要在 ChatGPT 应用中刷新、审核并发布 MCP 工具定义。

### v0.3.7：面向代码开发的原生工具增强（无需 DC）

- **正则查找**：`fs_search(regex:true)` 可用 JavaScript 正则，独立 Worker 执行并逐文件设置 350ms 超时；默认仍为精确字面量查找，继续保护私有文件和工作区边界。
- **大日志尾部**：`fs_read.files[].tail_lines` 可从尾部读取，文件超过 4 MiB 时最多扫描最后 256 KiB；此时不提供全文件 SHA-256，防止把局部校验误当编辑保护。
- **文件详情**：`fs_list(details:true)` 返回大小、修改时间和权限，不跟随软链接。
- **安全复制与移动**：`workspace_execute` 支持 `copy`、`move` 步骤；仅普通文件、128 MiB 上限、源文件 SHA-256 必填、目标存在时拒绝覆盖、禁止符号链接和硬链接源。
- **编辑失败诊断**：`replace` / `patch` 精确匹配失败会返回有限的相似代码行、相似度和字符级差异，但绝不自动按模糊匹配修改。
- 仍保持 **16 个 Core 工具**，但是三个工具的参数 Schema 已扩展。部署后**必须在 ChatGPT 中刷新、审核并重新发布工具定义**。完整测试和发布哈希按 v0.3.7 更新。

### v0.3.6：可选 MCP 完整请求与响应抓包

在 **Admin → 性能调试** 中可启用两个互相独立的级别：

- **性能指标（默认关闭）**：仅记录方法、工具、耗时、状态、大小和 Trace 时间线，不记录正文。
- **完整抓包（默认关闭）**：在开启性能指标后，再勾选“同时记录完整 MCP 请求与返回”。网关保存收到的原始 JSON-RPC 请求正文及**实际发给客户端**的 JSON-RPC 响应字符串，包括工具参数和返回结果。完整正文若超过配置的单侧字节上限，会标明截断并保存开头和结尾。

请求与返回存于独立的私有文件 `mcp-content.jsonl`（还有一份轮转文件）；普通性能数据存于 `mcp-performance.jsonl`，查看性能概览不会加载原文。管理员登录并重新输入密码后可按条查看或导出敏感 JSONL。抓包数据**可能含 API Key、口令、Shell 命令、文件内容或签名 URL**；应短暂开启并及时清除。HTTP Authorization / Cookie 头与 Admin API 请求不会进入该抓包文件。日志默认每侧正文 512 KiB，单份敏感日志 16 MiB，最高可分别设为 4 MiB 和 32 MiB。待写入的敏感正文缓冲合计限制为 32 MiB，超限主动丢弃抓包并增加 Admin 中的计数。

**关闭调试的性能路径**不额外获取性能时间戳、不注册完成监听、不复制/序列化报文、不创建抓包文件；仅保留一个关闭状态的轻量判断。本版本不修改现有 MCP Tool Schema，升级后无需为此功能刷新工具列表。
