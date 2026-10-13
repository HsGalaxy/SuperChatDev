# SuperChatDev v0.3.1 — Initial GitHub release

This repository contains the **Core-first MCP server** purpose-built for the native ChatGPT web experience. The public GitHub tree excludes legacy site-specific deploy scripts, production logs, workspace projects, state files, private credentials, and generated bundles.

The frozen 16-tool schema is covered by tests. Changes to the tool schema or OAuth callback conventions may require manual refresh/review/publishing of your ChatGPT connector's actions.

The interactive installer supports Debian/Ubuntu/systemd. New-host installation and public HTTPS certificate issuance must be verified on your own machine before relying on it in production. Use `./install.sh --dry-run` first.

**Licensing:** MIT, as specified by this repository's LICENSE.
