# 安装与升级（中文）

[返回项目首页](../../README.md) · [English](../INSTALLATION.md)

## 1. 安装条件

- Debian/Ubuntu（使用 systemd），具备 root 或 sudo 权限。
- 可通过 HTTPS 下载 GitHub 源码；推荐 SSH 登录操作。
- 用于 ChatGPT 接入的**真实域名**；DNS 记录应指向此服务器。
- 自动 HTTPS（Caddy）通常需要开放 80 和 443；如果已经部署 Nginx、Caddy 或其他代理，请选择**使用现有代理**。
- Python 3、tar、curl 和 Node.js 22+。下载引导器可补齐 tar/Python 3；安装向导经确认可安装 Node.js。Core 本身不强制安装 npm 插件。

## 2. 最简单的一行

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash
```

安装向导默认简体中文，也可选择 English。选择新装后，提供域名，选择 HTTPS 方式；根据提示决定是否附加 Desktop Commander。安装器会创建受限系统身份、工作区、私有状态和 systemd 服务，并验证 `/health`。

**安全提示：** 这是从 GitHub 经 HTTPS 获取并以 root 执行代码。请确认仓库可信。要审查脚本，先运行：

```bash
curl -fsSLo superchatdev-install.sh https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh
less superchatdev-install.sh
sudo bash superchatdev-install.sh
```

直接运行从 GitHub 下载的单文件脚本同样可以安装，它会先获取完整源码。安装向导不会把真实凭据打印到终端。

## 3. 智能域名选择（首次安装）

向导会先尝试通过 HTTPS 检测当前机器的公网 IPv4，例如 `1.2.3.4`，再询问：

```text
请选择 MCP 域名：
  1. 手动输入域名（已有域名）
  2. 自动推荐：1.2.3.4.sslip.io（无需注册域名）
请选择 [2]：
```

**第二项是默认推荐，回车即可选用。** 你也可以选择 `1`，手动输入已有域名；若自动 IP 检测失败，安装器不会退出，而是进入手动输入。检测服务无法识别内网/组播/保留 IP 为可用的公网地址。自动检测不在升级、Dry Run 或已经指定 `--domain` 的自动化安装里执行。

`sslip.io` 的 DNS 服务由第三方提供，自动查询公网地址时第三方查询服务也会看到服务器的出口 IP。检测 IP 可能是 NAT/代理出口，因此选用推荐域名前，需要确认 80/443 公网入站流量真的能够抵达该 VPS。最终确认 **`[Y/n]`**：回车继续，输入 `n` 取消，不会静默安装。

## 4. 英文与自动化

```bash
# 英文向导
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en

# 无交互预览：不执行软件包、账户、文件或服务更改
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | bash -s -- --mode fresh --dry-run --domain mcp.yourdomain.org --proxy caddy

# 已下载完整源码时
./install.sh --mode upgrade --dry-run
```

非交互的真实安装必须明确指定 `--mode`、`--domain`（首次安装）、`--proxy`（首次安装建议）与 `--yes`，并以 root 运行。无需交互时请先执行 Dry Run；不要把 `--yes` 用作绕过安全审查的手段。

## 5. 新装模式

- 仅在尚未存在 SuperChatDev 服务和环境文件的机器上使用。
- 默认监听 `127.0.0.1:18787`，不应将后端 HTTP 端口直接开放到公网。
- **Caddy 模式**：修改由安装器管理的站点配置，验证后启动或热加载；遇到已有冲突域名会拒绝覆盖。
- **现有代理模式**：保留你的反向代理，由你自己将 HTTPS 流量转发至 `127.0.0.1:18787`。代理不能错误重写 OAuth 路径，最好不要记录带查询参数的授权码或签名下载 URL。
- 创建 OAuth 与后台两份独立随机密码，文件位于 `/etc/chatgpt-dev-mcp/`，仅 root 能访问。
- 工作区在 `/var/lib/chatgpt-dev-mcp/workspace`，状态在 `/var/lib/chatgpt-dev-mcp/state`。

## 6. 升级模式

执行相同的一键命令，存在旧服务时默认选择升级。升级会检查发行 SHA-256 和现有安装基线，保留**账户、密码、OAuth 状态、项目、服务 unit 及反向代理**。如果版本文件被用户自己改过，可能会拒绝升级并要求人工合并，避免意外覆盖。

升级会重启 MCP 网关，期间 ChatGPT 连接可能短暂中断；尚未启用 Access Token 持久化的旧连接可能需要重新授权。备份默认保存在 `/var/backups/chatgpt-dev-mcp-installer`。请额外备份真正重要的工作区及私有状态。

## 7. 安装后

```bash
systemctl status chatgpt-dev-mcp --no-pager
curl -fsS http://127.0.0.1:18787/health
```

访问 `https://你的域名/admin/` 登录管理后台，MCP 地址为 `https://你的域名/mcp`。在 ChatGPT 添加连接后，根据平台要求**刷新、审核并发布工具定义**，再试一次小项目导入、测试及导出。

可用 `./install.sh --check` 只读检查，不修改运行服务。

[配置说明](CONFIGURATION.md) · [运维手册](OPERATIONS.md) · [常见问题](TROUBLESHOOTING.md)
