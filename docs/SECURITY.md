# Threat model and hardening

Single trusted owner; not a hosted multi-tenant code execution service. A permitted shell job can run arbitrary programs with the unprivileged runner's Linux access. Keep the gateway on loopback and expose only an HTTPS proxy; keep bearer tokens, OAuth client refresh credentials, admin passwords, artifacts and backups private.

The root installer runs only after interactive confirmation and may create service accounts, manage an optional proxy and restart services; never invoke privileged install from an MCP job. The gateway's systemd unit uses a low-privilege owner, an execution identity, `NoNewPrivileges`, restricted writable paths, and an isolated state directory. This reduces risk but does not eliminate code execution risks.

Do not claim to bypass ChatGPT web user approvals. Treat downloaded source code and web material as untrusted. File path traversal/symlink checks and guarded writes are defense-in-depth. OAuth code and refresh tokens are short-lived/rotating, with hash-only storage for refresh credentials. Choose refresh expiry based on the threat model, and revoke sessions on suspected exposure.

Review reverse proxy request logs for OAuth code or signed URL leaks. Do not grant shared developers access to a single-owner runtime without redesigned authorization and per-user isolation.
