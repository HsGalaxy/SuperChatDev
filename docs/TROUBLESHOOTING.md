# Troubleshooting

**Cannot reach ChatGPT app:** Verify DNS and Caddy/external TLS, 80/443 firewall, HTTPS origin, `/mcp` endpoint and OAuth redirect origin. The backend `/health` should respond locally. Reverse proxy cannot silently rewrite OAuth paths.

**Some tools missing:** Compare `/admin/` catalog with `dev_get_guide`. ChatGPT may be using a frozen action snapshot; refresh, review and publish the app actions. Core intentionally does not expose all DC tools.

**Login expires:** Check Access Token TTL, Refresh Token enablement, persistence, client refresh support, and recent service restarts. Refresh Token support on the server does not imply automatic renewal by every client.

**Job appears stuck:** Call `job_read` with the ID and `next_offset`, check `status`, `exit_code`, and `has_more`; a returned task ID means it has not necessarily finished. On interrupted command start, use `job_list` and `request_id`, do not blindly submit a new mutating command.

**Permission errors:** Check `EXECUTION_UID/GID/HOME`, filesystem mode and systemd sandbox. Do not grant unrestricted sudo.

**Rust or build issues:** Run the `doctor.sh` diagnostic; check `CARGO_HOME`, `RUSTUP_HOME`, PATH and binary versions. Ripgrep is optional for native `fs_search`.

**Upgrade fails:** Read the install log and the private backup path; check hash-conflict errors. The installer should not overwrite modified production files without review. Restore matching runtime/settings snapshots as required.
