# Quick start

[Project home](../README.en.md) · [简体中文](zh-CN/QUICKSTART.md)

## 1. Install

From a Debian / Ubuntu SSH terminal:

~~~bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en
~~~

Choose **Fresh install**, then pick a connection:

- Own domain → managed Caddy HTTPS
- No domain / public IP → Cloudflare Tunnel (cloudflared installed automatically)
- Public IP → sslip.io (managed Caddy)

Missing Node.js 22+ is installed automatically. Once the server is ready, the interactive root SSH terminal shows the MCP URL, Admin URL and two generated passwords.

## 2. Add to ChatGPT

Go to **ChatGPT Settings → Apps → Create custom MCP app**. Paste the MCP URL, complete OAuth using the owner password, then scan and enable tools.

For example:

> Inspect my project, fix the build errors, run tests and send back the project ZIP.

*Your ChatGPT workspace must support custom MCP tools and write operations.*

## 3. Learn more

[Installation](INSTALLATION.md) · [Cloudflare Tunnel](CLOUDFLARE.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Tools](TOOLS.md)
