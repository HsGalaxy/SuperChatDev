# SuperChatDev

**A purpose-built MCP development runtime for ChatGPT's native web interface.**
Not an all-in-one agent platform, not an IDE, and not another generic MCP toolbox.

[简体中文（默认）](README.md) · [**English**](README.en.md) · [Installation](docs/INSTALLATION.md) · [Tool contracts](docs/TOOLS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Changelog](CHANGELOG.md)

SuperChatDev enables a full software development workflow directly in ChatGPT Web: upload ZIP → inspect and search code → edit → build and test → inspect Git diff → export deliverables back to the conversation.

## Development log

The Admin sidebar has a separate read-only Development Log page at /admin/#devlog (login required). It shows a searchable release history from the installed [CHANGELOG.md](CHANGELOG.md), the same record used on GitHub, not MCP runtime logs or audit traces. No MCP action refresh is needed for this UI-only feature.

## 🚀 One-line installation

Run this in an SSH terminal on **Debian/Ubuntu**:

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash
```

The wizard defaults to **Simplified Chinese**. At the first prompt choose **2. English**, or launch directly in English:

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en
```

You don't need to clone the repository. The installer downloads the public source, verifies the release manifest, and guides you through installation/upgrade, DNS domain, HTTPS via managed Caddy or an existing reverse proxy, optional Desktop Commander, low-privilege service accounts, credentials, and health checks.

### Public connectivity (recommended order)

1. **Custom HTTPS domain (preferred)** — Stable address using managed Caddy or an existing HTTPS proxy.
2. **Cloudflare Tunnel (second choice)** — No public IP or inbound ports required. Quick Tunnels are for temporary testing; named tunnels support Cloudflare API-powered creation, ingress and DNS configuration. cloudflared is installed **only on explicit opt-in**.
3. **Auto-generated sslip.io hostname** — Requires a reachable public IP, inbound 80/443 and working HTTPS.

See the [Cloudflare Tunnel guide](docs/CLOUDFLARE.md) for setup, optional installation, named tokens, endpoint/OAuth synchronization, access control and diagnostics. The Admin console has a dedicated Cloudflare Tunnel page; it does not add MCP tools.

### Review before running

```bash
curl -fsSLo superchatdev-install.sh https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh
less superchatdev-install.sh
sudo bash superchatdev-install.sh --lang en
```

For an existing installation, run the same command and select **Upgrade** (the wizard defaults to upgrade if the service is detected). State, credentials, workspace and existing reverse proxy configuration are preserved. Back up your data before upgrading.

## Why ChatGPT Web-first?

- Native chat-file import and export with `file_import`, `file_unpack`, `file_export`.
- Low-latency single commands: `job_start` waits up to **500ms**, returns immediate results when complete; longer work gets durable job IDs.
- Source listing, reading and searching, SHA-256-guarded edits, dependent builds/tests, read-only Git diff review.
- Workspace retained under `/var/lib/chatgpt-dev-mcp/workspace`.
- PKCE OAuth, rotating refresh credentials, admin console and strict core tool contracts.
- Just **17 Core tools**, optional Desktop Commander interactive shell.

### Development flow

```text
ChatGPT native upload
    ↓
file_import → file_unpack
    ↓
fs_list / fs_search / fs_read
    ↓
workspace_execute (edits/build/tests)    job_start (single commands)
    ↓
workspace_review
    ↓
file_export → downloadable project in ChatGPT
```

## Connecting ChatGPT

After installing, register `https://YOUR_DOMAIN/mcp` in ChatGPT's MCP app configuration, and use `https://YOUR_DOMAIN/admin/` to administer the server. Your default local health check is `http://127.0.0.1:18787/health`. OAuth authorization is required. If published tool definitions are cached, refresh/review/publish actions in ChatGPT.

## The 17 Core tools

| Category | Tools |
| --- | --- |
| Environment | `dev_get_guide` |
| ChatGPT attachment handoff | `file_import`, `file_unpack`, `file_export` |
| Code reading/navigation | `fs_list`, `fs_read`, `fs_search` |
| Quick one-shot execution | `exec` (short command, no durable Job ID) |
| Durable command jobs | `job_start`, `job_read`, `job_list`, `job_cancel` |
| Multi-step edit/test | `workspace_execute`, `workspace_read`, `workspace_list`, `workspace_cancel` |
| Read-only Git review | `workspace_review` |

`job_start` executes **one command**; `workspace_execute` coordinates **dependent multi-step operations**. They are intentionally not interchangeable.

## Documentation

| English | 简体中文 |
| --- | --- |
| [Quick start](docs/QUICKSTART.md) | [快速开始](docs/zh-CN/QUICKSTART.md) |
| [Installation](docs/INSTALLATION.md) | [安装与升级](docs/zh-CN/INSTALLATION.md) |
| [Architecture](docs/ARCHITECTURE.md) | [架构](docs/zh-CN/ARCHITECTURE.md) |
| [Configuration](docs/CONFIGURATION.md) | [配置](docs/zh-CN/CONFIGURATION.md) |
| [Tool contracts](docs/TOOLS.md) | [工具接口](docs/zh-CN/TOOLS.md) |
| [Operations](docs/OPERATIONS.md) | [日常维护](docs/zh-CN/OPERATIONS.md) |
| [Security](docs/SECURITY.md) | [安全](docs/zh-CN/SECURITY.md) |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | [故障排查](docs/zh-CN/TROUBLESHOOTING.md) |
| [Development](docs/DEVELOPMENT.md) | [参与开发](docs/zh-CN/DEVELOPMENT.md) |

## Developer checks

```bash
git clone https://github.com/HsGalaxy/SuperChatDev.git
cd SuperChatDev
npm run check
npm test
python3 -m unittest discover -s test -p 'test_installer*.py'
```

**Limitations:** Single trusted owner only, not a multi-tenant sandbox. MCP cannot disable ChatGPT's own approval dialogs or force OAuth refresh support in every client. Jobs may survive HTTP gateway restarts, but a host reboot does not automatically resume running commands.

**License:** [MIT](LICENSE) · **Current runtime:** v0.3.11

## Changelog

All features, fixes, security updates and migration notes are maintained in **[CHANGELOG.md](CHANGELOG.md)**. The README focuses on setup and usage.
