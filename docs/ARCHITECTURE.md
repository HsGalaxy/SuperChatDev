# Architecture

ChatGPT web → public HTTPS proxy (Caddy or existing) → loopback HTTP MCP gateway → OAuth, policy, trace, file/Code, durable Job and Workspace runtimes → unprivileged Linux runner and persisted workspace. Optional DC bridge is a separate upstream process, not required by Core.

The Core profile exposes 16 tools; Interactive exposes five additional DC terminal operations when available, Legacy restores upstream compatibility tools. File paths in `file_import`, `file_export`, `file_unpack` are relative to `WORKSPACE_ROOT`; `fs_*` and batch paths are relative to `cwd`. Code reading reports SHA-256, enabling optimistic guarded edits. Jobs are durable across the HTTP gateway restart, **not** automatic host-reboot resumption. `job_start` defaults to 500ms response wait and long jobs return IDs for `job_read`. Multi-step dependency plans use `workspace_execute`.

OAuth is Authorization Code + PKCE S256 with opaque Access Tokens and optional refresh credentials; no JWT signer or OAuth client secret. Refresh needs client support. Admin settings are private state, distinct from runtime executable code. The system is single-owner; filesystem policy is not full tenant isolation.
