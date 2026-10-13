# Troubleshooting

**Cannot reach ChatGPT app:** Verify DNS and Caddy/external TLS, 80/443 firewall, HTTPS origin, `/mcp` endpoint and OAuth redirect origin. The backend `/health` should respond locally. Reverse proxy cannot silently rewrite OAuth paths.

**Some tools missing:** Compare `/admin/` catalog with `dev_get_guide`. ChatGPT may be using a frozen action snapshot; refresh, review and publish the app actions. Core intentionally does not expose all DC tools.

**Login expires:** Check Access Token TTL, Refresh Token enablement, persistence, client refresh support, and recent service restarts. Refresh Token support on the server does not imply automatic renewal by every client.

**Job appears stuck:** Call `job_read` with the ID and `next_offset`, check `status`, `exit_code`, and `has_more`; a returned task ID means it has not necessarily finished. On interrupted command start, use `job_list` and `request_id`, do not blindly submit a new mutating command.

**Permission errors:** Check `EXECUTION_UID/GID/HOME`, filesystem mode and systemd sandbox. Do not grant unrestricted sudo.

**Rust or build issues:** Run the `doctor.sh` diagnostic; check `CARGO_HOME`, `RUSTUP_HOME`, PATH and binary versions. Ripgrep is optional for native `fs_search`.

**Upgrade fails:** Read the install log and the private backup path; check hash-conflict errors. The installer should not overwrite modified production files without review. Restore matching runtime/settings snapshots as required.


## One-line installation: prompts not appearing

For streamed Bash installation, use an SSH session with a controlling terminal, e.g. `curl -fsSL https://raw.githubusercontent.com/HsGalaxy/SuperChatDev/main/install.sh | sudo bash`. The downloaded launcher reconnects the Python wizard to `/dev/tty` so it does not read the piped script as interactive input. Headless automation requires explicit `--mode`, `--domain` for new installations, and `--yes` for privileged changes.

Choose **2. English** at the first screen or append `--lang en` using `| sudo bash -s -- --lang en`. Chinese is the default.

If download fails, confirm TLS/DNS access to `raw.githubusercontent.com` and `codeload.github.com`. Do not disable TLS verification to work around the issue. The bootstrap refuses archives with unsafe paths, symlinks or special files.
