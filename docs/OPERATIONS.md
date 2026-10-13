# Operations runbook

Check service with `systemctl status chatgpt-dev-mcp --no-pager` and `curl -fsS http://127.0.0.1:18787/health` (substitute configured PORT). See recent logs via `journalctl -u chatgpt-dev-mcp -n 100 --no-pager`, and `/admin/` for tool status, OAuth state, jobs and call traces. Do not paste bearer tokens or signed artifact URLs into tickets or chats.

Keep backups of the root-only environment file, private OAuth/settings state, and the workspace. The release installer saves previous runtime files and a private state snapshot during upgrade, but backups must be moved off-host separately by the owner. To restore, stop the service and use the matching backup carefully; do not overwrite active state without inspecting the restore impact.

After upgrading, compare `/health` version and catalog in `/admin/`; refresh ChatGPT app actions if needed. Existing access tokens may need renewal; clients must support Refresh Token grant for automatic renewal. Jobs are detached from the gateway service process but do not survive a host reboot by automatically restarting their commands. `job_list` and `workspace_list` show recoverable task history. DC is optional and can fail independently.

Check filesystem ownership before changing limits. Never solve permission errors by enabling passwordless unrestricted sudo for the MCP process. For diagnosing slow commands compare `wait_ms=0` and default 500ms locally, noting that ChatGPT frontend latency is additional.
