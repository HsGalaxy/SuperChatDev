"""Localized user-facing messages for the human-run SuperChatDev installer."""
LANG = "zh"
ZH = {'Please enter y or n.': '请输入 y 或 n。', 'Choose [{default}]: ': '请选择 [{default}]：', 'Unknown option.': '选项无效，请重试。', 'Command failed: ': '命令执行失败：', 'Invalid hostname': '域名无效。', 'Use a fully qualified DNS name, not a URL or IP address.': '请填写完整域名，不要输入 URL 或 IP 地址。', 'Invalid domain label': '域名格式错误。', 'An HTTPS domain name, not an IP address, is required': '必须使用 HTTPS 域名，不接受 IP 地址。', 'Replace the documentation example with your actual domain': '请将示例域名替换为你自己的真实域名。', 'The loopback port must be between 1025 and 65535': '本地监听端口必须在 1025～65535 之间。', 'Invalid EnvironmentFile value': '环境配置值无效。', 'Unsafe release manifest path: ': '发行清单中存在不安全的文件路径：', 'Release checksum mismatch: ': '发行文件 SHA-256 校验失败：', 'Node.js >=22 is required. Retry after installing it, or choose signed NodeSource setup.': '需要 Node.js 22 或以上版本。请先安装，或在向导中同意配置带签名校验的 NodeSource 软件源。', 'Automatic Node installation supports only Debian/Ubuntu.': '自动安装 Node.js 仅支持 Debian/Ubuntu。', 'Cannot retrieve the NodeSource signing key': '无法获取 NodeSource 软件源签名密钥。', 'NodeSource setup finished, but Node.js >=22 is not on the service PATH.': 'NodeSource 安装完成，但系统 PATH 仍找不到 Node.js 22+。', 'Fresh automatic installation is supported only on Debian and Ubuntu with systemd.': '自动新装仅支持使用 systemd 的 Debian/Ubuntu。', 'APT and systemd are required.': '需要 APT 和 systemd。', 'Node must be in a system-accessible location, not a root-only nvm directory.': 'Node.js 必须位于系统账户可访问的位置，不能仅安装在 root 专属的 nvm 目录。', 'Refusing root as the execution identity: ': '拒绝以 root 作为运行身份：', 'Directory symlink refused: ': '拒绝使用符号链接目录：', 'A credentials file already exists: ': '已有凭据文件：', '. Use upgrade or manually reconcile it.': '。请使用升级模式或手动核对后处理。', 'Node executable must have an absolute, system-accessible path.': 'Node.js 可执行文件必须使用系统可访问的绝对路径。', 'Backend health check failed: expected ': '服务健康检查失败，期望版本：', 'Local port ': '本机端口 ', ' is already occupied; choose another port.': ' 已被占用，请换一个端口。', 'npm is required when Desktop Commander is enabled': '启用 Desktop Commander 时需要 npm。', 'Desktop Commander entry point not found after npm installation': 'npm 安装后未找到 Desktop Commander 的入口文件。', 'Caddy auto-install supports Debian/Ubuntu only': 'Caddy 自动安装只支持 Debian/Ubuntu。', 'Domain already appears in the main Caddyfile; configure manually.': '该域名已存在于 Caddy 主配置中，请手动处理以免覆盖站点。', 'Existing Caddy site is not managed by this installer.': '已有同名 Caddy 站点，但并非本安装器管理；为避免覆盖，安装已终止。', 'Cannot upgrade without existing unit and environment. Use fresh install.': '找不到现有 systemd 服务及环境配置，无法升级。请使用新装模式。', 'An existing installation was detected. Use upgrade mode; no overwrites.': '检测到已有安装；请使用升级模式，避免覆盖既有环境。', 'Interactive installer requires a TTY; use --mode, --domain and --yes for automation.': '交互安装需要真实终端。自动化部署请使用 --mode、--domain 和 --yes。', '--domain is required for non-interactive installation': '非交互安装必须提供 --domain。', 'Run the actual installation as root in your SSH terminal.': '实际安装请在 SSH 终端中以 root 权限运行。', 'A non-interactive privileged install requires explicit --yes.': '非交互式有权限安装必须显式加入 --yes。', 'Install Node.js 22 from the signed NodeSource APT repository': '从带签名校验的 NodeSource APT 软件源安装 Node.js 22', 'Install missing system packages: ': '安装缺少的系统依赖：', 'Install optional Desktop Commander (pinned, no lifecycle scripts)': '安装可选的 Desktop Commander（固定版本，不执行 npm 生命周期脚本）', 'Configure HTTPS with Caddy': '配置 Caddy HTTPS', 'Upgrade runtime only; preserve users, proxy, credentials and workspace': '仅升级运行时代码，保留账户、反向代理、凭据与工作区', 'Verify and install release': '校验并安装发行文件', 'Start protected systemd service and verify local /health': '启动受限权限的 systemd 服务，并检查本机 /health', 'Installation incomplete; restoring runtime and stopping newly created unit': '安装未完成：停止新建服务并恢复运行时文件', 'Health failure: roll back runtime files': '健康检查失败：回滚运行时文件', 'Release: {version}, verified {count} file hashes': '发行版本：{version}，已校验 {count} 个文件哈希', 'OS: {os}, installed Node major: {node}': '系统：{os}，已安装的 Node 主版本：{node}', 'missing': '未安装', 'unknown (restricted)': '无法查看（权限受限）', 'systemctl:': 'systemctl 可用：', 'service exists:': '服务文件存在：', 'env file exists:': '环境配置存在：', 'credential files exist:': '凭据文件存在：', 'workspace exists:': '工作区存在：', 'service active:': '服务状态：', 'local /health:': '本机 /health：', 'unreachable (no credentials were used)': '连接失败（未使用任何凭据）', '(contents not displayed)': '（内容未显示）', 'Upgrade successful: v{version}  |  http://127.0.0.1:{port}/health': '升级成功：v{version}  |  http://127.0.0.1:{port}/health', 'Protected backup:': '受保护的备份目录：', 'Credentials and private state have NOT been printed or deleted.': '未打印或删除任何凭据及私有状态。', 'For troubleshooting, inspect': '排查故障请检查：', 'SUCCESS: Core MCP {version}': '安装成功：SuperChatDev {version}', 'MCP endpoint:': 'MCP 接入地址：', 'Admin console:': '管理后台：', 'HTTPS mode:': 'HTTPS 方式：', 'Domain DNS must resolve here and ports 80/443 must be reachable for Caddy TLS.': '域名需解析到此服务器，使用 Caddy 证书时请确保 80/443 端口可达。', 'Owner and admin passwords are stored separately in root-only files under': 'OAuth 与管理后台密码分别保存在 root 专属目录：', 'To reveal a password locally, use a root SSH terminal; never paste secrets in chat.': '请仅在 root SSH 终端读取密码，切勿粘贴到聊天中。', 'Private release backup:': '发行文件私有备份：', 'Next: register the HTTPS MCP app in ChatGPT; refresh/review/publish its actions.': '下一步：在 ChatGPT 中添加 HTTPS MCP 服务；必要时刷新、审核并发布工具定义。', 'Choose operation:': '请选择操作：', 'Fresh install on Debian/Ubuntu': '首次安装（Debian/Ubuntu）', 'Upgrade an existing installation': '升级已有安装', 'Read-only diagnostics': '只读环境检测', 'Quit': '退出', 'Public MCP domain (e.g. mcp.yourdomain.org): ': 'MCP 公网域名（如 mcp.yourdomain.org）：', 'HTTPS proxy:': 'HTTPS 代理：', 'Managed Caddy (automated ACME TLS, ports 80/443)': '自动配置 Caddy（自动申请 HTTPS 证书，需开放 80/443）', 'Existing proxy (you will configure HTTPS separately)': '使用现有反向代理（稍后自行配置 HTTPS）', 'Install optional Desktop Commander bridge?': '是否安装可选的 Desktop Commander 桥接？', 'Node >=22 missing. Configure signed NodeSource APT repo?': '缺少 Node.js 22+，是否配置带签名校验的 NodeSource APT 软件源？', 'Core MCP v{version}; release checksum verified: {count} files': 'SuperChatDev v{version}；已校验 {count} 个发行文件', 'Action:': '操作：', 'target:': '目标目录：', 'Domain:': '域名：', 'backend port:': '本机端口：', 'optional DC:': '可选 DC：', 'permit NodeSource:': '允许安装 NodeSource：', 'Will create two unprivileged service accounts, protected credentials and persistent workspace.': '将创建两个低权限服务账户、受保护的凭据及持久化工作区。', 'Upgrade runtime only; keep existing systemd unit, credentials, state and proxy.': '仅更新运行时；保留现有 systemd 服务、凭据、状态与代理配置。', 'DRY RUN: No packages, users, configs, files or services were changed.': '试运行完成：没有修改软件包、用户、配置、文件或服务。', 'Proceed with privileged changes?': '确定执行需要管理员权限的更改吗？', 'Cancelled.': '用户取消。', 'ERROR:': '错误：', 'Language:': '语言 / Language：', 'Chinese (default)': '简体中文（默认）', 'English': 'English', 'Installer wizard': '交互式安装向导', 'Please choose an option [1]: ': '请选择选项 [1]：'}

# Smart domain onboarding (Chinese remains the default).
ZH.update({"Detecting your server's public IPv4 address...": '正在检测服务器公网 IPv4 地址……', 'Enter my own domain': '手动输入域名（已有域名）', 'Use suggested sslip.io domain: {domain}': '自动推荐：{domain}（无需注册域名）', 'Detected public IPv4: {ip}': '检测到的公网 IPv4：{ip}', 'The detected address may be an outbound gateway; verify that inbound traffic reaches this VPS.': '检测结果可能是 NAT 的出口 IP；请确认外部流量能到达此服务器的 80/443 端口。', 'Public IPv4 detection was unavailable; you can still enter a domain manually.': '无法自动获取公网 IPv4，仍可手动输入域名。', 'Choose your MCP domain:': '请选择 MCP 域名：', 'Selected MCP domain: {domain}': '已选择 MCP 域名：{domain}', 'Invalid domain, please try again: {reason}': '域名无效，请重新输入：{reason}'})


def set_language(lang):
    global LANG
    if lang in ("zh", "zh-CN", "cn"):
        LANG = "zh"
    elif lang in ("en", "en-US"):
        LANG = "en"
    else:
        raise ValueError("Language must be zh or en")

def tr(english, **args):
    value = ZH.get(english, english) if LANG == "zh" else english
    return value.format(**args) if args else value

def error_message(message):
    if LANG == "en": return message
    if message in ZH: return ZH[message]
    for en, zh in sorted(ZH.items(), key=lambda pair: len(pair[0]), reverse=True):
        if (en.endswith(": ") or en.endswith(":") or en.endswith(" ")) and message.startswith(en):
            return zh + message[len(en):]
    return message


# v0.3.11: optional public access choices, with custom HTTPS first.
ZH.update({
  "Choose public access method:": "请选择公网接入方式：",
  "Custom HTTPS domain (recommended; Caddy or existing proxy)": "自定义 HTTPS 域名（首选，可用 Caddy 或现有反向代理）",
  "Cloudflare Tunnel (no public IP or inbound ports; optional cloudflared)": "Cloudflare Tunnel（第二推荐，无需公网 IP 或开放入站端口）",
  "Automatic sslip.io hostname (requires reachable public IP)": "自动 sslip.io 域名（需要可访问的公网 IP）",
  "Install optional cloudflared now?": "是否现在单独安装可选的 cloudflared？",
  "Cloudflare mode selected: see Admin → Cloudflare Tunnel for live address and OAuth status": "已选择 Cloudflare：请在管理后台 Cloudflare Tunnel 页面查看当前地址及 OAuth 状态。",
  "cloudflared is already installed; skipping optional installation": "cloudflared 已安装，跳过可选安装",
  "Installing optional cloudflared from signed official Cloudflare apt repository": "从 Cloudflare 官方签名 APT 仓库按需安装 cloudflared",
  "DRY RUN: optional cloudflared package would be installed from signed Cloudflare apt repo": "模拟执行：按需安装 cloudflared（签名 Cloudflare APT 源），不修改系统",
  "optional cloudflared:": "可选 cloudflared："
})

ZH.update({
  "Cloudflare Tunnel needs outbound connectivity, not inbound 80/443. Use Admin to configure Quick or named Tunnel and verify the public OAuth issuer.": "Cloudflare Tunnel 只需出站连接，不必开放入站 80/443；请在管理后台配置 Quick 或固定域名 Tunnel，并验证公网 OAuth Issuer。"
})

ZH.update({
  "Public Tunnel is not ready. Do not use the placeholder hostname. Check journalctl -u chatgpt-dev-mcp or SSH-forward 18787 to configure a named Tunnel.": "公网 Tunnel 尚未就绪，请勿使用占位域名。检查 journalctl -u chatgpt-dev-mcp，或通过 SSH 转发本机 18787 端口配置固定域名 Tunnel。"
})

# Friendly fresh-install summary (keep the user journey separate from diagnostics).
ZH.update({
  "Cloudflare Tunnel (no public IP or inbound ports; cloudflared installed automatically)": "Cloudflare Tunnel（无需公网 IP，自动安装 cloudflared）",
  "ChatGPT OAuth password:": "ChatGPT OAuth 登录密码：",
  "Admin password:": "管理员后台密码：",
  "Passwords are also saved under:": "密码同时保存在：",
  "Passwords are saved in root-only files:": "密码已保存，请在 SSH 终端读取：",
  "Cloudflare is still starting. To get the URL later:": "Cloudflare 地址正在生成，可稍后运行：",
  "For connection errors:": "连接失败时查看日志：",
  "Open Admin via SSH port forwarding to configure the named tunnel:": "通过 SSH 端口转发打开管理后台，配置固定域名 Tunnel：",
  "Next: ChatGPT Settings → Apps → Create, paste the MCP URL, and authorize with the OAuth password above.": "下一步：ChatGPT 设置 → 应用 → 创建，粘贴 MCP 地址，使用上面的 OAuth 密码授权。",
  "Next: get your tunnel URL above, then add it in ChatGPT Settings → Apps.": "下一步：获取 Cloudflare 地址后，在 ChatGPT 设置 → 应用中添加。",
  "Saved private backup:": "备份目录：",
  "cloudflared:": "cloudflared：",
  "Installing cloudflared for Cloudflare Tunnel": "正在为 Cloudflare Tunnel 安装 cloudflared",
  "Desktop Commander:": "Desktop Commander：",
  "Node.js 22+:": "Node.js 22+：",
  "Next: ChatGPT Settings → Apps → Create, paste the MCP URL, and authorize with the saved OAuth password.": "下一步：ChatGPT 设置 → 应用 → 创建，粘贴 MCP 地址，再用保存的 OAuth 密码授权。",
})
