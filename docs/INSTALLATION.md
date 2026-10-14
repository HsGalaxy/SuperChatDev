# Installation and upgrades (English)

[English README](../README.en.md) · [中文](zh-CN/INSTALLATION.md)

## Prerequisites

- Debian or Ubuntu with systemd and root/sudo access in an SSH terminal.
- A real domain name pointed to your server and reachable public HTTPS.
- Internet access to `raw.githubusercontent.com` and `codeload.github.com`.
- Python 3, tar, curl, and Node.js >=22. The downloaded bootstrap can set up Python/tar with APT if root is available; the guided installer can offer signed NodeSource setup with your approval.

## One-liner — no Git clone required

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en
```

Without `--lang en`, the language menu defaults to Simplified Chinese. You can still select English by entering `2` at the first prompt.

The bootstrap downloads the project archive via HTTPS, verifies safe archive paths, then runs the local Python wizard against the downloaded release. The installer checks the 31-file release manifest before making runtime changes. Remote code is run with root privileges: **review and trust the source before executing**.

For script review:

```bash
curl -fsSLo superchatdev-install.sh https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh
less superchatdev-install.sh
sudo bash superchatdev-install.sh --lang en
```

## Smart domain selection (fresh install)

Before asking for a domain, the installer checks the server's public IPv4 using HTTPS IP-echo endpoints, rejecting non-public, reserved and multicast addresses. The menu offers manual entry as **option 1** and `IP.sslip.io` as **option 2**. When detection succeeds, **option 2 is the suggested default**; pressing Enter selects it. If detection fails, installation can continue using a manually entered domain.

`sslip.io` is a third-party wildcard DNS service; the detected IP may represent outbound NAT rather than publicly accessible inbound traffic. Managed Caddy certificates still require DNS and inbound TCP ports 80/443. IP detection is skipped when `--domain` is specified, in unattended installations, and during Dry Run. The final confirmation defaults to **`[Y/n]`** (Enter installs, `n` cancels).

## Fresh install

Choose **Fresh install** and provide a DNS name. Choose **Managed Caddy** to configure automatic HTTPS certificates (requires working DNS and ports 80/443), or **Existing reverse proxy** if you already have Nginx/Caddy/another proxy terminating HTTPS.

The backend binds to `127.0.0.1:18787` by default; don't expose it publicly. The wizard creates two low-privilege Linux service identities and separate owner/admin passwords protected under `/etc/chatgpt-dev-mcp/`. Projects live under `/var/lib/chatgpt-dev-mcp/workspace`, private state under `/var/lib/chatgpt-dev-mcp/state`. Optional Desktop Commander is disabled by default.

## Upgrade without wiping data

Run the same bootstrap command and choose **Upgrade**. Existing installations default to upgrade mode. The installer retains existing credentials, OAuth state, projects, systemd settings and reverse proxy configuration; it checks release digests and production baselines before applying runtime file updates. It backs up versioned files and private state and attempts rollback on health-check failure. Back up valuable data independently too.

The MCP gateway restarts during an upgrade, potentially interrupting ChatGPT sessions. Older credentials may require reauthorization until the connected client supports refresh tokens.

## Command-line options

```bash
# Preview planned actions without modifying system state
./install.sh --mode fresh --domain mcp.yourdomain.org --proxy caddy --dry-run --lang en

# Preview upgrade
./install.sh --mode upgrade --dry-run --lang en

# Read-only diagnostics
./install.sh --mode check --lang en
```

For an actual unattended root installation, supply `--mode`, `--domain` for fresh install, your proxy selection, and `--yes`. A regular interactive install must have a real terminal.

## Connect ChatGPT Web

The installer prints `https://YOUR_DOMAIN/mcp` and `https://YOUR_DOMAIN/admin/`. Register the HTTPS MCP address in ChatGPT, complete OAuth, and refresh/review/publish tool actions as needed.

Verify locally:

```bash
systemctl status chatgpt-dev-mcp --no-pager
curl -fsS http://127.0.0.1:18787/health
```

[Configuration](CONFIGURATION.md) · [Operations](OPERATIONS.md) · [Troubleshooting](TROUBLESHOOTING.md)
