# Installation and upgrades (English)

[English README](../README.en.md) · [中文](zh-CN/INSTALLATION.md)

## Prerequisites

- Debian or Ubuntu with systemd and root/sudo access in an SSH terminal.
- Choose a real domain, Cloudflare Tunnel (no public IP required), or an sslip.io hostname.
- Internet access to `raw.githubusercontent.com` and `codeload.github.com`.
- Python 3, tar, curl, and Node.js >=22. The downloaded bootstrap can set up Python/tar with APT if root is available; the guided installer automatically installs missing Node.js 22+ from the signed NodeSource repository.

## One-liner — no Git clone required

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash -s -- --lang en
```

Without `--lang en`, the language menu defaults to Simplified Chinese. You can still select English by entering `2` at the first prompt.

The bootstrap downloads the project archive via HTTPS, verifies safe archive paths, then runs the local Python wizard against the downloaded release. The installer checks the release SHA-256 manifest before making runtime changes. Remote code is run with root privileges: **review and trust the source before executing**.

For script review:

```bash
curl -fsSLo superchatdev-install.sh https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh
less superchatdev-install.sh
sudo bash superchatdev-install.sh --lang en
```

## Choose a connection

The installer asks for one connection method:

1. **Your own domain** — enter the hostname. Managed Caddy sets up HTTPS by default.
2. **Cloudflare Tunnel** — works without a public IP, installs cloudflared automatically, and tries to launch a temporary Quick Tunnel. Prints the real URL when available.
3. **sslip.io** — detects a public IPv4 and generates a hostname; managed Caddy needs inbound ports 80/443.

Missing Node.js 22+ is installed automatically, with no extra dependency questions. The only optional add-on question is Desktop Commander. Press Enter at the final **[Y/n]** prompt to install, or n to cancel.

If you already operate an HTTPS reverse proxy, use the advanced --proxy external option.

## Fresh install

Choose **Fresh install** and select a connection method. Custom domains and sslip.io use managed Caddy by default (DNS and ports 80/443 required). Cloudflare mode installs cloudflared automatically, with no inbound ports needed. Use --proxy external if you already manage HTTPS.

The backend binds to `127.0.0.1:18787` by default; don't expose it publicly. The wizard creates two low-privilege Linux service identities and separate owner/admin passwords shown in interactive root SSH terminals and saved under `/etc/chatgpt-dev-mcp/`. Projects live under `/var/lib/chatgpt-dev-mcp/workspace`, private state under `/var/lib/chatgpt-dev-mcp/state`. Optional Desktop Commander is disabled by default.

## Upgrade without wiping data

Run the same bootstrap command and choose **Upgrade**. Existing installations default to upgrade mode. The installer retains existing credentials, OAuth state, projects, systemd settings and reverse proxy configuration; it checks release digests and production baselines before applying runtime file updates. It backs up versioned files and private state and attempts rollback on health-check failure. Back up valuable data independently too.

The MCP gateway restarts during an upgrade, potentially interrupting ChatGPT sessions. Older credentials may require reauthorization until the connected client supports refresh tokens.


### Certified migration of pre-manifest v0.3.0 installations

Historical v0.3.0 deployments may lack `.superchatdev-release.json`. The public installer now includes a **certified 31-file SHA-256 snapshot** of the original v0.3.0 runtime. Migration only proceeds if **every** installed runtime file exactly matches this baseline; customized, missing or unknown versions are rejected without modifying files.

From a **root SSH shell** on the target host:

```bash
curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | bash -s -- --mode upgrade --yes
```

The installer preserves the unit, reverse proxy, workspaces, credentials and OAuth state, backs up the current runtime, restarts the gateway and rolls back runtime files if the health check fails. Back up important data independently, and re-check `/health` after any temporary MCP disconnection.

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
