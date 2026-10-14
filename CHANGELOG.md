# Changelog

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
