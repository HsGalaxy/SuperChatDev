# SuperChatDev

**A purpose-built MCP development runtime for ChatGPT's native web interface.**
Not an all-in-one agent platform, not an IDE, and not another generic MCP toolbox.

[简体中文（默认）](README.md) · [**English**](README.en.md) · [Installation](docs/INSTALLATION.md) · [Tool contracts](docs/TOOLS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

SuperChatDev enables a full software development workflow directly in ChatGPT Web: upload ZIP → inspect and search code → edit → build and test → inspect Git diff → export deliverables back to the conversation.

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

### Smart domain suggestions

During a fresh interactive install, SuperChatDev attempts to detect the server's **public IPv4** over HTTPS and offers:

```text
Choose your MCP domain:
  1. Enter my own domain
  2. Use suggested sslip.io domain: 1.2.3.4.sslip.io
Choose [2]:
```

If a public IPv4 is detected, **option 2 is the suggested default**; just press Enter. Otherwise, the wizard falls back to manual domain input. `1.2.3.4` above is an example, not a hardcoded address. The final install confirmation is now **`[Y/n]`**: Enter proceeds, `n` cancels.

> `sslip.io` is an external wildcard DNS service, not a guarantee of public reachability. The detected address may be an outbound NAT gateway. Your VPS must still receive inbound connections on ports 80/443 for managed Caddy HTTPS certificates. Auto-detection runs only during interactive fresh installs without a supplied `--domain`; scripted installs and Dry Run skip it.

> **Security:** This executes publicly downloaded source as root. Review the script and trust the repository before running it. A real HTTPS hostname, usable DNS and access to GitHub are needed. Installation alone does not register the MCP app inside ChatGPT.

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

**License:** [MIT](LICENSE) · **Current runtime:** v0.3.9

### Git / GitHub from Admin (v0.3.4)

Open `/admin/` → **Git / GitHub** to configure the real command runner's Git commit identity, provision per-repository GitHub SSH Deploy Keys (generate, import, or adopt an existing server key), copy public keys, test repository read access, and bind workspace Git push remotes. The Admin never returns private-key bytes; importing, adopting and deleting keys require a fresh Admin password confirmation. Add the public key to GitHub's repository Settings → Deploy keys and enable **Allow write access**. A successful read test does not prove write permission.


### v0.3.5: opt-in performance diagnostics and interactive PTY improvements

The new Admin **Performance Diagnostics** page records MCP request timing only when explicitly enabled. Explore P50/P95/P99, read/parse/dispatch phases, tool milestones, request/response byte counts and bounded JSONL exports. Commands, arguments, terminal output, OAuth tokens, headers, URLs, addresses, and error messages are never logged. Two rotated files are kept with a configurable 1–32 MiB per-file cap.

In Interactive/Legacy profiles, `job_input(wait_for_prompt=true)` can wait for common shell/Python/IPython prompts without resending input; `job_read(tail_lines=N)` returns the most recent log lines independently of the durable byte cursor. Prompt detection is heuristic. These optional arguments modify the ChatGPT tool schema; refresh/review/publish app actions after updating production.

### v0.3.9: Large project navigation

- Optional /usr/bin/rg powers filename and content search in large repositories via fs_search(engine=ripgrep), including gitignore and bounded result pages. Native default remains available.
- fs_read streams selected UTF-8 line windows from files larger than 4 MiB, without a full-file SHA-256.
- Native-interactive enables job_input/PTY with 18 native tools and no DC dependency; Core remains 17.
- workspace_execute supports guarded rename_directory with source inode from fs_list(details:true); atomic Linux no-replace, subtree link/special-file rejection.
- Development branch only; republish tool definitions after deployment.

### v0.3.8: Low-latency one-shot Exec

The 17-tool Core adds `exec` for brief, repeatable, preferably read-only commands (pwd, git status, rg). Supports argv or explicit clean Bash, workspace-relative cwd, a 100–30000ms timeout and bounded output. Defaults: 10s and 16 KiB. Maximum 2 concurrent calls; 8 MiB produced-output cap.

Unlike durable `job_start`, exec directly spawns a non-PTY subprocess using the same execution identity, restricted environment, workspace path checks and administrator permissions. It retains no Job ID or persistent logs.

**Do not replay side-effecting commands through exec:** there is no request_id, deduplication or restart recovery. Use job_start and a stable request_id for writes, long tasks or reliable retries. Client action definitions must be refreshed/reviewed/published after deployment.

### v0.3.7: native developer ergonomics (no DC required)

- `fs_search(regex:true)` evaluates opt-in JavaScript regex in a separate worker with a 350ms per-file time limit; literal matching remains the default.
- `fs_read.files[].tail_lines` supports large-file tails by scanning up to the last 256 KiB; a large-file tail deliberately returns no full-file SHA-256.
- `fs_list(details:true)` offers file size, modification time and permissions without following symlinks.
- `workspace_execute` adds guarded regular-file `copy` and `move` (128 MiB maximum, no overwrites, required source SHA-256).
- Exact `replace` / `patch` failures return bounded read-only similarity hints; fuzzy matches are never applied.
- The **16 Core tool names are unchanged**, but input schemas changed. Refresh/review/publish the ChatGPT app actions after deployment.

### v0.3.6: sensitive full MCP request/response capture (explicit opt-in)

**Admin → Performance Diagnostics** now has two separate toggles, both OFF by default: metadata-only performance timings and, optionally, **full JSON-RPC request/response capture**. When full capture is enabled, incoming JSON-RPC request bodies and the exact serialized JSON-RPC responses (including tool arguments and outputs) are saved to separate private `mcp-content.jsonl` journals. The metadata timeline remains isolated in `mcp-performance.jsonl`; normal metrics queries never load sensitive message content.

The Admin password must be re-entered to enable sensitive capture, inspect an individual capture, or download sensitive JSONL. Logs are bounded by a configurable per-message cap (default 512 KiB per side; max 4 MiB) and per-file rotation (default 16 MiB; max 32 MiB, current plus one older file). Oversized messages include explicit truncation markers. Queued sensitive body previews are bounded to 32 MiB; over-limit captures are dropped and reported in diagnostics. HTTP Authorization/Cookie headers and Admin requests are never captured, but **JSON-RPC arguments and tool results may contain passwords, tokens, code, signed URLs or personal information**. Enable briefly and clear afterward.

With debugging OFF, the handler does not allocate capture state, invoke a performance clock, attach listeners, copy message bodies, perform extra serialization or write debug files. This release does **not** change the MCP tool schema.
