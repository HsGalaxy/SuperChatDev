# SuperChatDev

**A purpose-built MCP development runtime for ChatGPT's native web interface.**

[Installation guide (中文)](docs/INSTALLATION.md) · [Quickstart](docs/QUICKSTART.md) · [Architecture](docs/ARCHITECTURE.md) · [Tool contracts](docs/TOOLS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

SuperChatDev turns **ChatGPT Web + your own Linux VPS** into a practical development workflow. It is **not** an all-in-one AI platform, a general IDE, or a generic collection of MCP tools. Its goal is specific: make reading code, editing projects, running tests, and exchanging files feel reliable **inside the native ChatGPT web chat**.

```text
ChatGPT native upload
        |
  file_import -> file_unpack
        |
  fs_list / fs_search / fs_read
        |
  workspace_execute (edit -> build -> test)    job_start (single command)
        |                                        |
  workspace_review                           job_read (if still running)
        |
   file_export
        |
ChatGPT downloadable artifact
```

## Why SuperChatDev?

- **Native ChatGPT attachment handoff:** import original uploaded files into the VPS, unpack projects, and export results back to the conversation.
- **Fast commands and durable jobs:** `job_start` waits up to **500ms by default**. Fast commands return output and exit status in one call; longer commands return a durable job ID.
- **Integrated edit/test/review:** bounded source navigation, SHA-256-guarded file changes, dependency-aware batch execution, and read-only Git review.
- **Built for the web client:** compact tool responses, pagination, retry IDs, OAuth with PKCE and rotating refresh tokens, and a small stable schema.
- **Core-first tool surface:** 16 default tools, with **optional** Desktop Commander interactive/legacy profiles. No forced dependence on DC.

## Quick start (Linux)

Requirements: Debian or Ubuntu with systemd, Python 3, a domain pointing to your VPS, and Node.js 22+. The wizard can offer to install Node 22 through a signed APT repository if you explicitly allow it.

```bash
git clone https://github.com/HsGalaxy/SuperChatDev.git
cd SuperChatDev

# Preview the install before making privileged changes
./install.sh --dry-run --mode fresh --domain mcp.yourdomain.org --proxy caddy

# Open the interactive installer in your own root/sudo SSH session
sudo ./install.sh
```

Choose **Fresh install** for a new host or **Upgrade** for an existing SuperChatDev installation. The installer offers managed Caddy HTTPS or your own reverse proxy, creates an unprivileged service and persistent workspace, and keeps OAuth and admin credentials in root-protected files. Optional Desktop Commander is an opt-in extra.

After installation:

| Endpoint | URL |
|---|---|
| MCP for ChatGPT | `https://YOUR_DOMAIN/mcp` |
| Admin dashboard | `https://YOUR_DOMAIN/admin/` |
| Local health | `http://127.0.0.1:18787/health` (default port) |

Add the HTTPS MCP endpoint to ChatGPT. When changing the tool catalog or schema, you may need to **refresh, review, and publish** the app actions in ChatGPT; the web client can cache older definitions.

Full instructions: **[Installation](docs/INSTALLATION.md)** · **[Web-client specifics](docs/TOOLS.md)** · **[Configuration](docs/CONFIGURATION.md)**.

## The 16 Core tools

| Workflow | Tools |
|---|---|
| Environment guide | `dev_get_guide` |
| Native attachment transfer | `file_import`, `file_unpack`, `file_export` |
| File navigation | `fs_list`, `fs_read`, `fs_search` |
| Single commands & durable processes | `job_start`, `job_read`, `job_list`, `job_cancel` |
| Multi-step development | `workspace_execute`, `workspace_read`, `workspace_list`, `workspace_cancel` |
| Git review | `workspace_review` |

**Do not confuse a Job with a Workspace execution:** `job_start` is for one command. It returns immediately after the command completes (up to 500ms default wait) or yields a durable ID. `workspace_execute` is for coordinated multi-step edits, builds and tests. `file_import` and `file_export` intentionally have **different** parameters because they transfer files in opposite directions.

## Operating and developing

```bash
npm run check
npm test
python3 -m unittest discover -s test -p 'test_installer.py'
./install.sh --check                    # read-only installation diagnostics
```

- Runtime: Linux + Node.js 22; no third-party npm dependencies for Core.
- Release: **v0.3.1**. Historic service and storage directory names such as `chatgpt-dev-mcp` are preserved for compatibility.
- Upgrade: checks release hashes and preserves existing server credentials, state, unit configuration, proxy and workspace. A failed health check triggers best-effort rollback; review backups before attempting manual recovery.
- Security: single owner; **not a multi-tenant sandbox**. Arbitrary shell execution has the runner's Linux permissions. Keep the HTTP backend bound to loopback and expose only HTTPS.
- Browser constraints: an MCP server cannot suppress ChatGPT approval prompts, guarantee attachment delivery across all clients, or force the client to refresh OAuth or published tool schemas.
- Persistence: jobs may outlive a gateway process restart; a machine reboot does **not** automatically resume processes.

For implementation details see [Architecture](docs/ARCHITECTURE.md), [Operations](docs/OPERATIONS.md), [Security](docs/SECURITY.md), and [Contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE). See the existing license file for copyright and terms.
