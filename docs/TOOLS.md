# Core tool contract

Core (16): `dev_get_guide`; `file_import`, `file_unpack`, `file_export`; `fs_list`, `fs_read`, `fs_search`; `job_start`, `job_read`, `job_list`, `job_cancel`; `workspace_execute`, `workspace_read`, `workspace_list`, `workspace_cancel`; `workspace_review`.

Native upload uses the ChatGPT file parameter (`_meta.openai/fileParams`); it is **not** a sandbox path or arbitrary model-generated Base64. Export creates a signed HTTPS artifact and MCP resource. The two transfer interfaces are intentionally asymmetric.

`job_start` runs one command. A command that finishes within its default 500ms wait returns output and exit code in a single invocation; otherwise use the durable ID with `job_read`. Set `wait_ms=0` if immediate detachment is desired. `workspace_execute` is a dependency-aware batch for write/patch/exec/check; it is not a second generic shell interface. Pass stable `request_id` on retries to avoid duplicate effects. Check all steps and terminal statuses before delivery.

`fs_read` returns line-numbered text and byte hash. Displayed line prefixes are **not** part of file content. Use `expected_sha256` on edits. File search and read are bounded and can return cursors or incomplete scan indicators. `workspace_review` is read-only; it does not create Git commits.

Schema snapshot tests guard all 16 existing tools. Changing a schema requires intentional review and refreshing the published client actions. ChatGPT controls its own tool approval prompts and can cache older tool definitions.
