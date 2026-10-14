# Quick start

[English README](../README.en.md) · [简体中文](zh-CN/QUICKSTART.md)

SuperChatDev is a purpose-built development MCP runtime for ChatGPT's native web interface, not an all-in-one AI agent platform.

## Install in one line

On Debian/Ubuntu with systemd, run this in an SSH terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en
```

You do **not** need to clone the repo. By default, the first menu offers Simplified Chinese (default) and English. Select Fresh install or Upgrade. A fresh install requires a real domain pointed at the host and HTTPS via managed Caddy or your existing reverse proxy.

**Security:** The one-liner downloads source over HTTPS and runs it as root. Read and trust the script before installing; see the [Installation guide](INSTALLATION.md) for a review-first command.

The fresh-install wizard offers `IP.sslip.io` as the second/default choice after detecting a public IPv4. Final confirmation defaults to `[Y/n]`.

## Connect ChatGPT Web

- MCP endpoint: `https://YOUR_DOMAIN/mcp`
- Admin console: `https://YOUR_DOMAIN/admin/`
- Default local health check: `http://127.0.0.1:18787/health`

Register the HTTPS MCP URL inside ChatGPT, complete OAuth, and refresh/review/publish tool actions if ChatGPT still shows an old tool catalog.

Try the core workflow: upload project ZIP → `file_import` → `file_unpack` → `fs_*` code navigation → `workspace_execute` editing/testing → `workspace_review` → `file_export` back to the chat.

[Configuration](CONFIGURATION.md) · [Tool contracts](TOOLS.md) · [Troubleshooting](TROUBLESHOOTING.md)
