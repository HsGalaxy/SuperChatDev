# SuperChatDev

**Your ChatGPT subscription. Your server. Your code.**

**MIT open source · Bring your own Linux VPS · 17 Core MCP tools · No separate model API key**

> **Turn native ChatGPT Web into a coding workspace on your own Linux server.**
> Upload a ZIP → inspect and edit code → run commands → build and test → review Git → download the deliverable. All inside your existing ChatGPT conversation.

[**English**](README.en.md) · [简体中文](README.md) · [🚀 Install](#-one-line-installation) · [Tools](docs/TOOLS.md) · [Cloudflare Tunnel](docs/CLOUDFLARE.md) · [Changelog](CHANGELOG.md)

### 💸 Already paying for ChatGPT? Bring your own compute

Many DIY coding agents require a separate model API key and token-based billing. **SuperChatDev isn't another model API client.** It's an open-source MCP development server that connects an **eligible ChatGPT workspace** to your own Linux machine. The SuperChatDev bridge **doesn't require an OpenAI API key or generate a separate model API bill** for these MCP tool calls.

Use the **included usage and applicable limits of your existing ChatGPT subscription**, while your own VPS handles the repository, build tools, disk, network and running processes. A particularly good fit if you already discuss requirements in ChatGPT and don't want to set up a second API-backed agent just to run code.

**Important: this is an alternative to separately metered model API integrations, not a claim that Codex costs extra. Codex is already included in ChatGPT plans.** Subscription costs, optional credits, and your own server bill still apply.

### ⚡ Why choose SuperChatDev instead of *only* Codex?

Codex is a capable coding agent with web, CLI, IDE and cloud workflows. **SuperChatDev doesn't claim to outperform Codex or be universally cheaper.** It solves a different problem: **turn your existing ChatGPT conversation into a control panel for a persistent, self-hosted Linux environment.**

| Developer experience | SuperChatDev's strengths | How Codex approaches it |
| --- | --- | --- |
| **Entry point** | Work in your everyday ChatGPT conversation with attachments and MCP tools | Dedicated Codex Web, CLI, IDE and desktop workflows |
| **Compute** | Persistent Linux VPS you own; choose CPU / GPU, network, dependencies and services | Managed Codex Cloud environments; CLI / IDE can also run on your machine |
| **File handoff** | Chat attachment ZIP → edit/build/test → signed downloadable output in the same conversation | Strong repo-oriented coding, review and agent workflows |
| **Long-running work** | Inspectable durable job IDs, paginated logs, batch dependencies and idempotent `request_id` | Uses its own task model; this is a workflow preference, not a missing Codex capability |
| **Control** | Open-source MCP tools, Admin UI, OAuth, optional DC / Cloudflare / isolated Runner | OpenAI-maintained CLI / IDE / Cloud Agent ecosystem |

**Think ChatGPT-first + bring-your-own-server, not a Codex benchmark.** If you prefer Codex's native CLI / IDE / Cloud Agent experience, Codex remains a great choice.

<details>
<summary><strong>💳 Pricing, eligibility and usage limits</strong></summary>

- ChatGPT **Plus is US$20/month**, but as of October 2026, **custom MCP write/modify actions are rolling out in beta to Business, Enterprise and Edu workspaces**. A Plus subscription **alone should not be advertised as sufficient** for SuperChatDev's full edit/build workflow.
- ChatGPT **Business Standard** is advertised at **US$20/seat/month billed annually or US$25/seat/month billed monthly**, with a **two-paid-seat minimum**. Actual custom MCP availability depends on your workspace permissions and rollout.
- **Codex is included with ChatGPT plans** and subject to plan limits and applicable credits. SuperChatDev doesn't bypass ChatGPT usage quotas, confirmation requirements or platform policy.
- SuperChatDev doesn't call the separately billed OpenAI API, but a supported ChatGPT subscription, your VPS, bandwidth and storage may still cost money. **Neither unlimited use nor lower total cost than Codex is promised.**

Official sources: [ChatGPT Plus](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus) · [Business pricing](https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business) · [Full MCP availability](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) · [Codex availability](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

</details>

### 🎯 From one prompt to a downloadable project

> “Here's my project ZIP. Inspect the source, port it to Linux, implement the missing features, run tests, review the diff, and send back the complete working ZIP.”

SuperChatDev supplies the remote tools; the quality of planning, coding and results still depends on your ChatGPT model, permissions, instructions and verification.

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

## How the ChatGPT-first workflow works

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

After installing, register `https://YOUR_DOMAIN/mcp` in a **ChatGPT workspace enabled for custom MCP write actions**, and use `https://YOUR_DOMAIN/admin/` to administer the server. Your default local health check is `http://127.0.0.1:18787/health`. OAuth authorization is required. If published tool definitions are cached, refresh/review/publish actions in ChatGPT.

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

## Reliability and development log

v0.3.12 supports an opt-in isolated Runner, explicit systemd resource migrations, and execution outcome metrics. See [Reliability operations](docs/RELIABILITY.md). Release notes live in [CHANGELOG.md](CHANGELOG.md) and in the separate Admin Development Log page (/admin/#devlog), rather than filling this README with historical detail.

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

**License:** [MIT](LICENSE) · **Current runtime:** v0.3.12
