# 安装与升级（中文）

[返回项目首页](../../README.md) · [English](../INSTALLATION.md)

## 1. 安装条件

- Debian/Ubuntu（使用 systemd），具备 root 或 sudo 权限。
- 可通过 HTTPS 下载 GitHub 源码；推荐 SSH 登录操作。
- 已有域名、公网 IPv4 或 Cloudflare Tunnel 均可接入；没有公网 IP 可选 Cloudflare。
- 自动 HTTPS（Caddy）通常需要开放 80 和 443；如果已经部署 Nginx、Caddy 或其他代理，请选择**使用现有代理**。
- Python 3、tar、curl 和 Node.js 22+。下载引导器可补齐 tar/Python 3；缺少 Node.js 时自动配置签名 NodeSource 软件源并安装。Core 本身不强制安装 npm 插件。

## 2. 最简单的一行

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash
```

安装向导默认简体中文，也可选择 English。选择新装后，只需选择接入方式：已有域名、Cloudflare Tunnel 或 sslip.io。Cloudflare 自动安装 cloudflared；域名/sslip.io 默认配置 Caddy。可选择是否附加 Desktop Commander。安装器会创建受限系统身份、工作区、私有状态和 systemd 服务，并验证 `/health`。

**安全提示：** 这是从 GitHub 经 HTTPS 获取并以 root 执行代码。请确认仓库可信。要审查脚本，先运行：

```bash
curl -fsSLo superchatdev-install.sh https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh
less superchatdev-install.sh
sudo bash superchatdev-install.sh
```

直接运行从 GitHub 下载的单文件脚本同样可以安装，它会先获取完整源码。首次安装成功后，在交互式 root SSH 终端会直接显示 OAuth 与 Admin 密码；非交互安装仅提供凭据文件路径。

## 3. 选择接入方式

向导只问你需要哪种访问方式：

1. **已有域名**：填写域名，默认使用 Caddy 自动配置 HTTPS。
2. **Cloudflare Tunnel**：无需公网 IP，自动安装 cloudflared 并尝试启动临时 Quick Tunnel；成功后输出真实 MCP URL。
3. **sslip.io**：自动检测公网 IPv4 并生成域名，默认使用 Caddy。需要公网入站 80/443 能到达本机。

缺少 Node.js 22+ 会自动安装。已安装的依赖直接跳过。安装器也会问是否需要额外的 Desktop Commander；不需要可直接回车。最后确认 **[Y/n]**：回车开始安装，输入 n 取消。

已有 HTTPS 反向代理的用户可通过高级参数 --proxy external 使用原来的代理，无需修改 Caddy。

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
- 创建 OAuth 与后台两份独立随机密码，交互式 root SSH 安装成功后直接显示；文件位于 `/etc/chatgpt-dev-mcp/`，仅 root 能访问。
- 工作区在 `/var/lib/chatgpt-dev-mcp/workspace`，状态在 `/var/lib/chatgpt-dev-mcp/state`。

## 6. 升级模式

执行相同的一键命令，存在旧服务时默认选择升级。升级会检查发行 SHA-256 和现有安装基线，保留**账户、密码、OAuth 状态、项目、服务 unit 及反向代理**。如果版本文件被用户自己改过，可能会拒绝升级并要求人工合并，避免意外覆盖。

升级会重启 MCP 网关，期间 ChatGPT 连接可能短暂中断；尚未启用 Access Token 持久化的旧连接可能需要重新授权。备份默认保存在 `/var/backups/chatgpt-dev-mcp-installer`。请额外备份真正重要的工作区及私有状态。


### 从无安装清单的 v0.3.0 升级

部分早期 v0.3.0 部署没有 `.superchatdev-release.json`。安装器现在附有公开发布的 **v0.3.0 共 31 个程序文件的 SHA-256 认证基线**；只有旧版运行时文件全部匹配时才会执行就地升级。检测到任何自行修改、丢失或非官方版本的文件，则在写入前拒绝升级，不会假造清单或覆盖自定义代码。

在目标 VPS 的 root SSH 终端执行：

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | bash -s -- --mode upgrade --yes
```

升级会重启 `chatgpt-dev-mcp.service`，但不会重装系统用户、Caddy、工作区或重置凭据。它会备份旧运行时及部分私有状态，并在探活失败时回滚运行时代码。升级前仍建议自行完整备份。若 MCP 会话短暂断开，连接恢复后再次检查 `/health`。

## 7. 安装后

```bash
systemctl status chatgpt-dev-mcp --no-pager
curl -fsS http://127.0.0.1:18787/health
```

访问 `https://你的域名/admin/` 登录管理后台，MCP 地址为 `https://你的域名/mcp`。在 ChatGPT 添加连接后，根据平台要求**刷新、审核并发布工具定义**，再试一次小项目导入、测试及导出。

可用 `./install.sh --check` 只读检查，不修改运行服务。

[配置说明](CONFIGURATION.md) · [运维手册](OPERATIONS.md) · [常见问题](TROUBLESHOOTING.md)
