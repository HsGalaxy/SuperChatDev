# Core tool contract

Core (16): `dev_get_guide`; `file_import`, `file_unpack`, `file_export`; `fs_list`, `fs_read`, `fs_search`; `job_start`, `job_read`, `job_list`, `job_cancel`; `workspace_execute`, `workspace_read`, `workspace_list`, `workspace_cancel`; `workspace_review`.

Native upload uses the ChatGPT file parameter (`_meta.openai/fileParams`); it is **not** a sandbox path or arbitrary model-generated Base64. Export creates a signed HTTPS artifact and MCP resource. The two transfer interfaces are intentionally asymmetric.

`job_start` runs one command. A command that finishes within its default 500ms wait returns output and exit code in a single invocation; otherwise use the durable ID with `job_read`. Set `wait_ms=0` if immediate detachment is desired. `workspace_execute` is a dependency-aware batch for write/patch/exec/check; it is not a second generic shell interface. Pass stable `request_id` on retries to avoid duplicate effects. Check all steps and terminal statuses before delivery.

`fs_read` returns line-numbered text and byte hash. Displayed line prefixes are **not** part of file content. Use `expected_sha256` on edits. File search and read are bounded and can return cursors or incomplete scan indicators. `workspace_review` is read-only; it does not create Git commits.

Schema snapshot tests guard all 16 existing tools. Changing a schema requires intentional review and refreshing the published client actions. ChatGPT controls its own tool approval prompts and can cache older tool definitions.

## Maintenance improvements (October 2026)

- `fs_search` remains a **literal** search. Full-path globs such as `src/**/*.mjs` are supported and hits now include bounded +/-2 `context` lines.
- `fs_read` reports an actionable error if a nonexistent path redundantly includes its `cwd` prefix. It does not silently reinterpret paths.
- Unified Diff accepts a small (<=3 line) header count discrepancy, and relocates a hunk within +/-20 lines only if the exact old context has **one unambiguous match**. No fuzzy or approximate content editing.
- Cancellation waits briefly for terminal job state, with coordinator cleanup reporting unresolved child jobs in `cleanup_pending_jobs`.

Still 16 Core tools; an additive `replace` step was added to workspace_execute (client action refresh required). In-process privileged file writes, lock replacement, ZIP compression and regex search remain deferred pending isolated audits.

## Exact snippet replacement

Use a `workspace_execute` step `{"type":"replace","path":"config.txt","old_text":"PORT=3000","new_text":"PORT=8080","expected_sha256":"<sha256 from fs_read>"}`. The original snippet must occur exactly once, and the current file hash must match. Changes use the unprivileged file worker and a bounded atomic rename. Refresh the published ChatGPT app actions to expose the new step type.

## v0.3.3: Head/tail output, line-number-free patches, optional PTY

Completed jobs expose a bounded `output_preview` (head, omission marker, tail) when output exceeds the response budget. The existing `output`, `offset` and `next_offset` contracts remain unchanged. A separate 64 KiB rolling tail retains terminal errors beyond the original log cap, and workspace `exec` steps propagate the preview.

`workspace_execute` patches support traditional Unified Diff as well as a no-line-number form:

```text
*** Begin Patch
*** Update File: src/config.js
@@
-const PORT = 3000;
+const PORT = 8080;
*** End Patch
```

The original snippet must match **exactly and uniquely**; an `@@ function name` anchor can narrow the region. There is no permissive whitespace or punctuation matching. Unmodified CRLF/LF text is preserved and new lines adopt the local line-ending style. Use `expected_sha256` for optimistic concurrency control.

The default Core still has **16 tools**. Interactive/legacy profiles expose `job_input`; use `job_start` with `tty:true` followed by bounded `job_input` (up to 4 KiB) and `job_read`. Requires util-linux `script`. Pass a stable `request_id` to `job_input` for safe identical retries within the same live session; conflicting reuse is refused. The terminal may echo typed input; never type secrets before understanding echo behavior. Refresh/review/publish the ChatGPT app action definitions for the new `tty` property and interactive tool. `job_input` returning `input_accepted:true` acknowledges that text was sent, **not** that the program has produced its response. Continue with `job_read` and the returned `next_offset` rather than sending the same text again.

Admission uses a durable active-job index rather than scanning all historical tasks. The original cross-process `flock` remains; there is **no Bubblewrap or handle-relative writer change**.

## v0.3.4: Git credentials in Admin

The Admin **Git / GitHub** page configures the command runner's global Git name/email, manages repository-scoped ED25519 SSH Deploy Keys (generate/import/adopt), provides GitHub HTTPS-verified SSH host keys (automatically provisioned on binding) and repository-read diagnostics, and updates only `origin` push URLs for projects inside the workspace. Import/adoption/deletion require Admin password confirmation. Private keys never appear in Admin responses or audit logs.

Repository access is not equivalent to write permission: install the public key in the corresponding GitHub repository and enable **Allow write access**. No GitHub PATs are persisted, no new Core MCP tool is exposed, and the v0.3.3 published tool schema remains valid.

## v0.3.5: performance tracing and interactive mode

The Admin **Performance Diagnostics** panel enables an opt-in metadata-only performance log (off by default), including P50/P95/P99, HTTP body/parse/dispatch timings, tool-stage milestones, safe request/response sizes, bounded JSONL export and password-confirmed deletion. No arguments, commands, outputs, tokens, headers, URLs, addresses or exception messages enter those logs.

`job_read(tail_lines=1..200)` includes an independent recent-lines view (`output_tail`) while preserving the byte cursor. `job_input(wait_for_prompt=true)` waits until a heuristic REPL prompt, completion or the requested `wait_ms` deadline. Heuristics may be wrong; always verify actual job status. Prompt input deduplication is retained. Optional MCP input fields changed, so refresh/review/publish ChatGPT actions after production upgrade.

## v0.3.6: sensitive JSON-RPC payload capture

Admin → **Performance Diagnostics** offers independent opt-in switches for metadata timing and **full MCP request/response capture** (both OFF by default). Authenticated MCP POST JSON-RPC request text and the actual serialized JSON-RPC response are retained in separate `mcp-content.jsonl` files, not in the normal timing journal. HTTP Authorization/Cookie headers and Admin requests are excluded; JSON-RPC bodies themselves may contain credentials or private content.

Sensitive capture requires a fresh Admin password to enable, view or export and remains gated by Admin sessions and CSRF. Size-controlled head/tail truncation (default 512 KiB per request/response, configurable 16–4096 KiB) and two rotated journal files (default 16 MiB each, max 32 MiB) prevent unbounded retention. Clearing the debug logs removes both timing and sensitive payload journals. Disabling debug stops future capture but does not automatically erase old captures.

OFF incurs only a lightweight settings check: no extra timers, listeners, body copying, JSON serialization or debug writes. No MCP tool schema change.
