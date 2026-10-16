# SuperChatDev

**Let ChatGPT work directly on your Linux server.**

Read and edit code, run commands, build and test projects, and inspect Git — in your usual ChatGPT conversation. Upload a ZIP, let ChatGPT work on your VPS, and download the finished project in the same chat.

**No separate model API key. No extra coding client.** Connect ChatGPT to the development environment you already own.

[简体中文](README.md) · [Quick start](docs/QUICKSTART.md) · [Installation](docs/INSTALLATION.md) · [GitHub Releases](https://github.com/HsGalaxy/SuperChatDev/releases)

## 🚀 One-line install

Run this from a Debian or Ubuntu SSH terminal:

~~~bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en
~~~

Choose how to reach the server:

- **Your own domain:** HTTPS with managed Caddy or your existing reverse proxy.
- **No public IP / domain:** **Cloudflare Tunnel**, including automatic cloudflared installation and a temporary address.
- **Public IP, no domain:** Generate an sslip.io hostname.

Missing **Node.js 22+** and required connection dependencies are installed automatically. Already installed? They're skipped. Desktop Commander is optional.

A successful installation prints:

~~~text
✅ SuperChatDev installed

MCP URL:         https://your-address.example/mcp
Admin dashboard: https://your-address.example/admin/

ChatGPT OAuth password: <generated at install>
Admin password:         <generated at install>
~~~

These are examples, not real credentials. In an interactive root SSH session, both passwords are shown and saved under /etc/chatgpt-dev-mcp/. Unattended installations show how to read the protected files. If the Cloudflare Quick URL is still starting, the installer prints a command for retrieving it, not a fake placeholder.

## 🔗 Connect ChatGPT

1. Open **ChatGPT → Settings → Apps → Create custom MCP app**.
2. Paste the **MCP URL** printed by the installer.
3. Authorize with the **OAuth password**, then scan and enable the tools.

Try asking:

> Inspect my project on the server, fix the failing build, run the tests, and send back the complete project ZIP.

*Your ChatGPT workspace must support custom MCP apps and the relevant write actions.*

## ✨ Features

| Your task | SuperChatDev |
| --- | --- |
| **Edit code** | List and search files, read/edit source, apply patches |
| **Run real build tools** | Shell commands, npm / Go / Rust builds and tests |
| **Handle long jobs** | Durable job IDs, incremental logs, status and cancellation |
| **Move files both ways** | Import ZIP uploads, process files, return downloadable results |
| **Review changes** | Git status, diffs and validation summaries |
| **Operate your server** | Web Admin, OAuth, performance metrics, optional isolated Runner |

Just **17 Core MCP tools** by default. Your files, dependencies, network and CPU/GPU stay on your Linux server, with a persistent systemd service.

## 💡 Why SuperChatDev?

**Use your own Linux development environment without leaving ChatGPT.**

No need to move your repository into a new hosted workspace or configure separately metered model API credentials just to use your tools. Keep build caches, project files and long-running services on your machine.

## 📖 Docs

[Install and upgrade](docs/INSTALLATION.md) · [MCP tools](docs/TOOLS.md) · [Cloudflare Tunnel](docs/CLOUDFLARE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Configuration](docs/CONFIGURATION.md) · [Changelog](CHANGELOG.md)

**MIT License** · **v0.3.12**
