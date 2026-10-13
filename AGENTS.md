# Coding assistant guidance — SuperChatDev

This project is a **ChatGPT Web MCP development runtime**, NOT an all-in-one agent platform or general-purpose IDE.

- Start with `README.md`, `docs/ARCHITECTURE.md`, and `docs/TOOLS.md`.
- Prefer existing **16 Core tools**. Do not add overlapping file editors or an alternative generic `exec` tool without clear reasons.
- A single command uses `job_start` (default 500ms fast wait). A dependency-aware edit/test/build workflow uses `workspace_execute`. Never treat `running` as `succeeded`.
- For native ChatGPT uploads, `file_import` receives the native file parameter; `file_export` returns MCP artifact resources. Do not confuse ChatGPT `/mnt/data` with the VPS workspace.
- Use bounded reading and file SHA-256 guards for modifications; check all batch results and Git review diffs.
- Preserve OAuth refresh migrations, the ability to revoke issued credentials, and hash-only persisted token storage.
- Never grant sudo to MCP, restart production services, use root installer privileges or expose private state from the ordinary job runner.
- Test with `npm run check`, `npm test`, and installer smoke tests. Preserve the frozen Core input-schema snapshot until a deliberate client app update.
- Before publishing, scan for credentials, signed links, private infrastructure configuration and other secrets; do not commit local logs or state.
