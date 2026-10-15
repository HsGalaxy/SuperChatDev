# Changelog

## 0.3.11 — Optional Cloudflare Tunnel public connectivity

- Add an independently managed Cloudflare Tunnel Admin page, separate from the existing 17 MCP development tools, with Quick Tunnel and long-lived named-tunnel workflows, start/stop/resume/remove, health diagnostics and links to Cloudflare documentation.
- Quick Tunnel discovers a temporary trycloudflare.com address and automatically updates the effective OAuth issuer and allowed HTTP origin. For an explicitly selected fresh Cloudflare install, automatic Quick bootstrap can obtain the first public address and show it in the installer. Testing only: no SLA, 200 concurrent in-flight request limit, no SSE.
- For named tunnels, support both a preconfigured dashboard token and API-token-assisted automatic provisioning: create remotely-managed tunnel, set catch-all-protected ingress for local MCP HTTP, create a proxied DNS CNAME without overwriting existing records. Provisioning API credentials stay in-memory; only the per-tunnel run token is persisted in a 0600 file and passed via token-file option.
- Persist named-tunnel configuration for supervised restart with the gateway; dynamically update the public OAuth issuer. Sensitive lifecycle operations require authenticated Admin session, CSRF token and repeat password entry; no root access from Admin.
- Install wizard recommends custom domain first, Cloudflare Tunnel second, automatic sslip.io third. Cloudflared is NOT a runtime dependency and is installed only by explicit Cloudflare opt-in or a separate install-cloudflared command using Cloudflare's signed APT repository. No automatic installation during ordinary upgrades.
- Add offline mocked Cloudflare API, fake cloudflared-process, secret isolation, end-to-end issuer, installer and restart regression coverage. No changes to MCP Core tool schemas; a normal runtime upgrade is sufficient.

## 0.3.10 — Standalone Development Log page

- Add a dedicated **Admin → 开发日志 / Development Log** page, separate from runtime logs, MCP invocation audits and performance traces.
- Display a responsive version timeline, current-version badge, keyword search, release/upcoming filters and a direct link to the GitHub CHANGELOG. Deep link: /admin/#devlog.
- Render the same installed CHANGELOG.md tracked in GitHub through a bounded, read-only, authenticated API. Escape release notes as HTML before formatting.
- Include CHANGELOG.md in the verified release manifest and allow only this named extra root document in installer/deployer paths.
- No new MCP tool or action changes. Existing ChatGPT tool schemas stay compatible; a runtime upgrade is required to display the page.

## 0.3.9 - Large project tooling

- Optional /usr/bin/rg backend in fs_search: filename search, .gitignore, bounded pagination and partial-result reporting, while preserving the native default.
- Stream line ranges from large UTF-8 logs without full-file loading; partial reads never provide a full-file SHA-256 edit guard.
- Native-interactive profile exposes native PTY input with no Desktop Commander bridge. Core stays 17 tools, native-interactive has 18.
- Add guarded `rename_directory`: source inode from `fs_list(details:true)`, subtree symlink/special-file rejection, a 10,000-item / 512 MiB scan cap, and atomic Linux no-clobber.
- No additional Node runtime dependencies. OS ripgrep is optional; client actions require republishing.

## 0.3.8 — Low-latency one-shot developer exec

- Add a distinct non-durable `exec` tool for short, preferably read-only commands. Direct child spawn bypasses worker startup, admission-lock overhead and disk-backed job records.
- Preserve execution identity, limited environment, workspace checks and admin permissions. Default `exec` limits: 10-second timeout, 16 KiB output, two concurrent calls; maximum 30 seconds and 8 MiB generated output. Timeout kills the process group.
- No request_id deduplication, saved logs, PTY or restart recovery in exec; retain `job_start` and `workspace_execute` for side effects, long tasks and reliable retries.
- Add E2E and performance tests, bump the Core catalog to 17 tools and freeze a new v0.3.8 schema; client actions need republishing.

## 0.3.7 — DC-inspired native code workflow improvements

- Opt-in bounded regex search in `fs_search` via an isolated worker (350 ms per-file timeout); paged results and existing literal matching remain available.
- Large-file tail reads in `fs_read` (256 KiB maximum window, no full-file SHA-256 claim) and safe file metadata in `fs_list`.
- Guarded `copy` and `move` steps in durable workspace batches, with source SHA-256, no overwrite or symlink following.
- Read-only near-match diagnostics for failed exact replaces and patch contexts. No fuzzy edits are performed.
- Reject legacy IPv4 relay and TEST-NET ranges before HTTPS file imports; normalize IPv6 documentation addresses.
- Maintain 16 Core tools, update frozen v0.3.7 input schema contracts; ChatGPT actions must be republished.

## 0.3.6 — Sensitive full MCP payload capture (explicit opt-in)

- Dedicated, authenticated **MCP JSON-RPC request + response capture**, separate from metadata-only performance logging. Stores the received request body and the exact serialized response on authenticated MCP calls only; no raw HTTP headers or Admin API requests.
- Full capture is OFF by default, requires a second toggle and fresh Admin password confirmation. Viewing and downloading a capture also require authenticated Admin session, CSRF protection and password re-entry; the generic settings API cannot bypass this gate.
- Independent `mcp-content.jsonl` rotation with configurable per-side body clipping (default 512 KiB, max 4 MiB) and separate journal limit (default 16 MiB/file, max 32 MiB); oversized records explicitly show truncation or omission. Queued capture bodies are bounded to 32 MiB with dropped-payload counters.
- The default/disabled hot path no longer obtains a performance timestamp, installs debug listeners, copies JSON-RPC bodies or performs extra serialization. The existing metrics-only mode and Trace ID correlation are preserved.
- Added security, large-message, rotation, disable/migration, live request/response and API-permission regression tests, and expanded the local benchmark to compare OFF, metrics-only and full capture.
- No MCP tool schema changes; existing ChatGPT actions remain compatible.

## 0.3.5 — Opt-in MCP performance tracing and interactive terminal ergonomics

- New **Admin → 性能调试 / Performance Diagnostics** toggle, bounded rotated JSONL downloads, P50/P95/P99 summary and per-call Trace timeline. Default OFF and never records request arguments, auth headers, commands, outputs or exception text.
- Captures server HTTP body read, JSON parsing, dispatch timing, request/response sizes, RPC and tool error flags, plus safe internal tool/admission/PTY stage timestamps; log size and slow-call threshold are configurable and settings persist across service restart.
- PTY enhancements inspired by Desktop Commander UX: optional prompt-aware `job_input.wait_for_prompt`, heuristic process input state, and `job_read.tail_lines` for recent output without advancing the durable byte cursor. PTY request-id cache is bounded without unsafe eviction.
- Faster exact Trace ID lookups by listing filenames and reading one matching JSON instead of parsing the entire trace history.
- Maintains the privilege separation, OAuth/CSRF gates, existing job log caps and safe log redaction.
- `job_read` and `job_input` schemas changed: refresh, review and publish the ChatGPT app's MCP action definitions after upgrading.

## 0.3.4 — Admin Git / GitHub configuration

- Adds a dedicated **Git / GitHub** Admin page for commit author name/email, per-repository ED25519 SSH Deploy Keys, key import, existing-key adoption, GitHub repository read checks, and scoped `origin` push URL configuration.
- Runs Git credential management under the **actual unprivileged command-execution UID/HOME**, not the differently privileged Admin web service account. Changes do not require root or a server restart.
- Stores private keys with owner-only permissions, never returns them from the Admin API, preserves pre-existing SSH configuration, and verifies GitHub host keys using the official HTTPS API.
- Admin-session, CSRF, and password confirmation protect sensitive mutations. Audit logs record only action names, never private keys, tokens, repo names or credentials.
- GitHub deploy keys remain repository-scoped; configuring a public key does not itself enable GitHub write access. Defaults to SSH only; no HTTPS PAT persisted.
- No new MCP Core tools or input-schema changes; the v0.3.3 tool contract remains valid.

## 0.3.3 — Web MCP latency and development ergonomics

- Added capped-memory rolling output tail and bounded head/tail `output_preview` on terminal jobs without changing legacy log cursors. Workspace `exec` also reports previews.
- Added `*** Begin Patch` / `*** Update File` without line numbers while preserving Unified Diff; exact unique old-context and anchors reject ambiguous changes, local CRLF/LF survives edits.
- Added a persistent active-job index with restart migration, stale cleanup and durable inter-process admission lock.
- PTY input also supports an optional idempotent request_id (hash-only in live worker memory); repeated identical requests cannot type twice.\n- Added optional interactive PTY via util-linux `script` and the `job_input` tool, visible **only under interactive/legacy profiles**. Core remains 16 tools.
- Fixed `workspace_execute.replace` authorization to require filesystem read and write permission.
- Added regression tests for logs, patches, PTY input/cancellation and active-index concurrency. Schema refresh required for `job_start.tty`.

## 0.3.2 hotfix — Verified v0.3.0 migration

- Supports safe upgrades from the pre-manifest v0.3.0 production release using the published 31-file certified SHA-256 baseline, **only if all installed files match exactly**.
- Existing installations with custom/modified runtime files remain protected and fail before writes; no fabricated baseline.
- Preserves systemd unit, reverse proxy, credentials, OAuth state and project workspaces; supports runtime rollback and future manifest-based upgrades.
- Adds isolated migration/rollback tests and replay against a byte-for-byte copy of an existing 0.3.0 installation.

## 0.3.2 — ChatGPT Web editing/search reliability

- Bounded unique-context Unified Diff relocation and small header-count tolerance.
- Full-path search globs, nearby context previews and redundant-cwd path diagnostics.
- More reliable cancellation acknowledgement for jobs and workspace child processes.
- Regression tests for ambiguous hunks, context search and mistaken cwd-prefix paths.
- Added a `workspace_execute.replace` step for unique literal substitutions, SHA-256 guarded; tool count remains 16. Refresh ChatGPT published tool actions.

## Unreleased — smart installer defaults

- Offer manual domain entry first and a detected public IPv4 `IP.sslip.io` domain as the **second, default-recommended** choice.
- Detect over HTTPS with bounded timeouts, a direct connection (no proxy exit-IP confusion), validation that rejects private/multicast/reserved IPv4, and graceful fallback to manual entry.
- Preserve explicit `--domain` and offline Dry Run behavior, plus full Chinese/English prompts.
- Default the final interactive installation confirmation to **Yes** (`[Y/n]`), while preserving explicit `n` and headless `--yes` safeguards.
- Add offline unit and guided-interaction regression coverage.

## Unreleased — 2026-10-14 installer hotfix

- Fixed fresh installs on new servers incorrectly requiring private `BASELINE.json`.
- Separated fresh and upgrade deployment modes. Fresh installs refuse existing code, and upgrades verify persisted local checksums.
- Added a persisted installed-release manifest, safer rollback of both files and manifest, and cleanup of credentials/unit/environment after failed new installation.
- Added isolated full fresh-install, upgrade, conflict and rollback regression tests; no changes to ChatGPT Core tools.

## Unreleased — One-line installer and bilingual documentation

- Added streaming GitHub bootstrap: `curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash`. Local checkouts still run without downloading source.
- Default installer language is **Simplified Chinese**, with English selection in the menu or `--lang en`.
- Documented installation, configuration, tool APIs, operations, security and troubleshooting in both languages, with Chinese as the GitHub landing-page default.
- Added offline streamed installer tests, pseudo-terminal interaction testing, malicious archive rejection and non-root diagnostic fixes.

## 0.3.1 — Fast jobs, OAuth continuity and initial public distribution

- `job_start` waits up to 500ms by default, returning fast command output in the first call; long tasks remain durable.
- Rotating, client-bound OAuth refresh tokens with hash-only persistence, configurable lifetime, revocation and restart recovery.
- Admin console exposes refresh policy and session counts.
- Public repository with interactive installer, regression tests and GitHub CI.

## 0.3.0 — Core Flow

- Reduced default tool exposure to 16 native tools, with optional DC profiles.
- Added bounded `fs_list`, `fs_read`, `fs_search` and read-only Git `workspace_review`.
- Preserved native ChatGPT attachment upload/download and strengthened permission checks, job retry handling and recovery.
