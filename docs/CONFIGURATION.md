# Configuration reference

Environment file is root-only `/etc/chatgpt-dev-mcp/service.env`. **Never put real passwords into the project source or a chat.** Main values:

| Setting | Meaning |
|---|---|
| `HOST`, `PORT` | HTTP bind (`127.0.0.1`, loopback port) |
| `PUBLIC_BASE_URL` | Public HTTPS origin, no path |
| `WORKSPACE_ROOT` | Persistent user project directory |
| `MCP_DATA_ROOT` | Private OAuth/settings/jobs data |
| `MCP_OWNER_PASSWORD`, `MCP_ADMIN_PASSWORD` | Separate login secrets |
| `OAUTH_REDIRECT_ORIGINS` | Allowed OAuth client callback origins |
| `FILE_DOWNLOAD_ORIGINS` | Allowed HTTPS attachment fetch origins |
| `EXECUTION_UID`, `EXECUTION_GID`, `EXECUTION_HOME` | Low-privilege job identity |
| `EXECUTION_ENV` | JSON map for clean job PATH, CARGO_HOME and RUSTUP_HOME |
| `MCP_TOOL_PROFILE` | `core`, `interactive` or `legacy` |
| `DESKTOP_COMMANDER_COMMAND` | Optional JSON argv for upstream DC |
| `MAX_JOBS`, `MAX_FILE_BYTES`, `MAX_RESOURCE_BYTES` | Execution and file limits |

OAuth Access Token TTL, Refresh Token lifetime, session persistence and client revocation may also be managed via `/admin/` settings. Adjusting TTL does not retroactively extend issued tokens. For details inspect `.env.example` and `src/server.mjs`.
