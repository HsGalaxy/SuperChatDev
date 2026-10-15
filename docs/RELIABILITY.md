# SuperChatDev v0.3.12 Reliability and Resource Isolation

[README](../README.en.md) · [Changelog](../CHANGELOG.md) · [中文](zh-CN/RELIABILITY.md)

Changes: controlled systemd TasksMax/MemoryMax, an **opt-in sibling systemd Runner**, correctly classified MCP ResourceLinks with signed HTTPS downloads preserved, lazy Desktop Commander, optional delta log previews, bounded diagnostic pages, recent job/batch indexes and execution-level outcome metrics. Existing sensitive content capture and retention are **unchanged**.

## Upgrade planning: no implicit systemd edits

Ordinary upgrade still changes runtime only. For preview:

    sudo bash install.sh --mode upgrade --dry-run
    sudo bash install.sh --mode upgrade --dry-run --apply-resource-limits
    sudo bash install.sh --mode upgrade --dry-run --enable-isolated-runner

New installations default to TasksMax=1024 / MemoryMax=4G. An existing installation needs explicit `--apply-resource-limits` to add a managed drop-in with backed-up, rollback-capable service configuration:

    sudo bash install.sh --mode upgrade --yes --apply-resource-limits

The installer refuses to clobber a manually maintained drop-in. Expect a runtime restart; plan a maintenance window.

## Optional sibling Runner

The more robust execution split requires explicit opt-in (only after testing in staging):

    sudo bash install.sh --mode upgrade --yes --enable-isolated-runner

In isolated mode: HTTP/OAuth control service 512 tasks / 2 GiB; separate Job Runner service 768 tasks / 4 GiB. The private Unix socket is in state/job-runner.sock (0600) and the runner env file is 0600 and contains **no gateway OAuth/Admin passwords**. Durable Jobs, batch coordinators and quick commands run in the separate service's cgroup; job IDs, byte cursors, cancellation, request_id semantics and logs remain unchanged.

If the runner is unavailable the control service **does not** silently run jobs in its own cgroup. Inspect the durable job ID after ambiguous launch errors, and never retry side effects without the same request_id. Detached processes survive HTTP restarts but not host reboots.

## Diagnostics, output and backward compatibility

Admin overview and Performance expose cgroup PID/memory limits and cumulative hit counters, and separate HTTP/MCP errors from execution outcomes. Batch child jobs are excluded from top-level execution-success calculations.

dev_get_guide(include_diagnostics=true) defaults to a bounded recent summary; diagnostics_mode=full retains detailed trace availability. job_list/workspace_list support paged recent indexes. job_start/job_read may specify preview_mode=delta or none; the existing default full preview and output cursor semantics are unchanged.

Small exported artifacts return an artifact:// ResourceLink and a signed HTTPS direct link; oversized objects retain HTTPS download only. Existing HTTP endpoint and authentication are unchanged.

## Staging and rollback checklist

Verify actual separate systemd cgroup membership, >=256 thread build stress, low latency /health/OAuth during job saturation, independent cgroup resource max events, task restart and idempotency, Quick/Named Tunnel, small/large downloads, Core/Native/DC switches, and long UTF-8 log pages. Failed installs restore the runtime and backed-up systemd settings in /var/backups/chatgpt-dev-mcp-installer/.

Offline unit tests validate the IPC and installer plans. Real systemd cgroup exhaustion and external ChatGPT download rendering **must** be separately verified in staging before production deployment. This release does not upgrade production by itself.
