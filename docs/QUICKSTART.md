# Quick start

Core MCP 0.3.1 is a single-owner remote development runtime intended for native ChatGPT web. On a Debian/Ubuntu VPS with a domain and reachable TCP 80/443, extract the release and run `./install.sh --dry-run --mode fresh --domain mcp.your-domain.org --proxy caddy` before `sudo ./install.sh`. The interactive wizard sets up an unprivileged gateway, a separate job identity, persistent workspace, root-only credentials, and optional Caddy TLS or an existing reverse proxy.

Use the resulting `https://YOUR_DOMAIN/mcp` as the ChatGPT MCP endpoint and `https://YOUR_DOMAIN/admin/` for administration. Refresh/review/publish tool actions when changing profiles or server schemas. Upload a native ZIP, call `file_import`/`file_unpack`, read with `fs_*`, change/test with `workspace_execute`, review with `workspace_review`, and deliver via `file_export`.

Existing deployments must use **Upgrade**. The installer refuses silently replacing credentials and keeps state and workspaces. Read [Installation](INSTALLATION.md), [Security](SECURITY.md), and [Troubleshooting](TROUBLESHOOTING.md).
