# MCP 工具接口与开发闭环

[中文首页](../../README.md) · [English](../TOOLS.md)

SuperChatDev **Core 模式共 16 个工具**，尽量让模型一眼知道什么时候用哪个工具。

| 阶段 | 工具 |
| --- | --- |
| 查询环境 | `dev_get_guide` |
| 原生附件传入/解压/返回 | `file_import`, `file_unpack`, `file_export` |
| 查代码 | `fs_list`, `fs_read`, `fs_search` |
| 单命令、长任务控制 | `job_start`, `job_read`, `job_list`, `job_cancel` |
| 多步骤开发编排 | `workspace_execute`, `workspace_read`, `workspace_list`, `workspace_cancel` |
| Git 差异审查 | `workspace_review` |

## 文件传输与路径

`file_import.file` 接收的是 **ChatGPT 原生附件参数**，而非 Linux 路径或 ChatGPT 的 `/mnt/data`。导入后会返回工作区相对路径、字节数与哈希；ZIP 可用 `file_unpack.path` 解压。

`fs_read` 显示的行号是展示层标记，不能连同标记写入文件。读取时获得的原始字节 SHA-256 可以用于 `workspace_execute` 的受保护修改。完成后使用 `file_export.path` 导出，并使用工具实际返回的下载链接。

## 命令与 Job

单条命令调用 `job_start`。默认最多等待 **500ms**：如果命令已完成，直接返回状态、退出码与输出；如果没完成，就得到持久任务 ID，再用 `job_read` 读取。需要立即交还任务 ID 时可指定 `wait_ms=0`。

涉及文件写入、多个依赖步骤和测试的流程优先使用 `workspace_execute`。使用稳定 `request_id` 安全重试；检查所有步骤终态再交付成果。Job 重启恢复指**网关进程**场景，机器断电后不会自动继续执行任意程序。

`workspace_review` 只读展示 Git 状态和差异，不会自动生成提交。

## ChatGPT 网页版

服务器声明工具不代表当前网页会话已拿到最新版 Schema。需要时前往 ChatGPT 应用管理刷新/审核/发布工具定义。MCP 也无法绕过网页版自身的平台授权确认。

## 2026-10：减少多轮代码修改摩擦

- `fs_search` 继续保留原本的**字面量查询**，但现在路径级 glob 支持 `src/**/*.mjs`，每个命中项附带前后各 2 行的 `context`；结果仍有长度与分页限制。
- `fs_read` 的路径如误写成 `cwd + path` 两层前缀，会在文件不存在时给出正确路径提示。为避免误读另一份同名文件，不会自动重写路径。
- Unified Diff 的 Hunk 声明行数允许最多 3 行小偏差。原始上下文必须严格匹配；声明的起始行位置不准时仅在 ±20 行内、且**唯一命中**才允许定位。上下文不唯一会拒绝修改。
- `job_cancel` 会短暂等待 Job 进入终态；在 worker 退出、但取消标记存在时优先收敛到 `cancelled`。`workspace_cancel` 会追踪仍未收敛的子任务并在结果标注 `cleanup_pending_jobs`。

核心工具数量仍是 16 个；`workspace_execute` 新增向后兼容的 replace 步骤类型，需要 ChatGPT 端刷新、审核、发布工具定义。高风险的 inline 写入与锁替换仍不启用；正则搜索已经通过隔离 Worker 提供，详细见下文。

## 精确替换（推荐小改动）

单行或小块代码修改可使用 `workspace_execute` 的 `replace` 步骤：

```json
{"cwd":"imports/project-xxx","steps":[{"type":"replace","path":"config.txt","old_text":"PORT=3000","new_text":"PORT=8080","expected_sha256":"<fs_read 返回的 SHA-256>"}]}
```

要求旧文本在文件中恰好出现一次，且当前文件哈希与阅读时一致，否则拒绝覆盖。它仍通过受限的 Job worker 执行，不绕过文件锁与 Linux 权限。

## v0.3.3：首尾日志、无行号补丁与可选 PTY

**长日志不再丢失最终错误。** `job_start` / `job_read` 在已完成任务输出超过预算时，新增 `output_preview`，保留开头、末尾及省略字节数。原来的 `output`、`offset`、`next_offset`、`has_more` 保持兼容。原始日志达到保存上限时，系统另存最多 64 KiB 的尾部；`workspace_execute` 的 `exec` 步骤也能返回摘要。

**无行号 Patch。** 仍可使用 Unified Diff，也可以使用更容易由 LLM 生成的格式：

```text
*** Begin Patch
*** Update File: src/config.js
@@
-const PORT = 3000;
+const PORT = 8080;
*** End Patch
```

旧文本必须唯一精确匹配；重复时可以用 `@@ 函数签名` 限定范围。不会自动模糊忽略缩进或改写引号。补丁会保留未修改行的 CRLF/LF，新行沿用局部换行格式。继续建议提供 `expected_sha256`。

**PTY 是可选模式。** 默认 Core 仍然是 **16 个工具**。在管理后台改为 `interactive` 或 `legacy` 后，`job_start` 可指定 `tty:true`，使用 `job_input` 发送文字，再用 `job_read` 获取输出。系统需要 util-linux 的 `script`；每次输入最多 4 KiB，Socket 限制为仅服务账户可访问。 对有副作用的输入，可为 `job_input` 提供稳定的 `request_id`；同一任务内重复发送相同请求不会再次输入，修改相同 ID 的内容会被拒绝。PTY 可能回显密码，因此输入敏感信息前必须了解终端的回显策略。客户端需要刷新、审核并发布动作。 注意：`job_input` 返回 `input_accepted:true` 只表示输入已写入终端，不代表程序立即输出了答复。请继续以返回的 `next_offset` 调用 `job_read`，不要因为暂时未看到答复而重复发送输入。

**性能：** Job 准入由扫描所有历史任务改为只核对私有状态目录下的活跃标记。旧安装首次启动时迁移索引，`job_list` 仍保留完整历史查询。保留跨进程 `flock` 以防止竞态；**不引入 Bubblewrap、不改安全文件写入机制**。

## v0.3.4：Admin Git / GitHub 面板

在管理中心选择 **Git / GitHub**，分别配置：

- **Git 提交身份**：设置真实 MCP 执行用户的 `git config --global user.name / user.email`。
- **SSH Deploy Key**：按仓库 `owner/repo` 独立生成 ED25519 公私钥，可导入未加密私钥，或沿用旧版手动生成的 `~/.ssh/superchatdev_deploy_ed25519`。
- **GitHub 认证测试**：通过 GitHub 官方 HTTPS 元数据校验 SSH 主机密钥，然后测试仓库读取。绑定仓库推送地址时也会自动准备该主机密钥。**读取成功不等于写权限确认**。
- **项目绑定**：填写工作区内项目的相对路径，将该仓库的 `origin pushurl` 配置成 SSH 专属别名。原来的 fetch URL 不变；不会自动 push、commit 或执行任意仓库脚本。

敏感动作需要重新输入管理员密码并通过 CSRF；私钥在命令执行用户的 SSH 目录下保存，网页端不可读取。GitHub 上仍需手动添加公钥并勾选 Allow write access。普通 MCP 工具数量保持不变，无需刷新客户端 Tool Schema。

## v0.3.5：性能调试与交互增强

- Admin 左侧 **性能调试** 可开启/关闭详细日志，查看 P50/P95/P99 与最近请求的耗时、错误、输入/输出字节数、JSON 解析与工具派发耗时，按 Trace ID 查看阶段时间线。
- 下载的 JSONL 只包含方法、工具名称、状态、用时、字节数和内部安全阶段标签；不包含请求参数、命令、输出、凭据或 URL。默认关闭，按 1–32 MiB 轮转，保留最近两份日志，删除日志需要管理员密码。
- `job_read` 支持 `tail_lines`（1–200），输出 `output_tail` 但保留原 `output` / `next_offset`。TTY 作业另有 `interaction.state`，提示符识别可能误判。
- `job_input` 可选 `wait_for_prompt: true`，结合 `wait_ms` 在实际 PTY 中等待下一次 REPL 提示符、进程结束或超时，不会重新发送已确认的输入。仍推荐为交互动作设置稳定的 `request_id`。
- 运行时改变了可选的 MCP 工具字段，因此更新生产环境后，在 ChatGPT App 中刷新、审核并发布工具定义。原有 Core 工具数量不变。

## v0.3.6：完整 MCP 原文抓包（可选）

在 Admin → **性能调试** 中有两个级别：性能元数据记录与独立的完整请求/响应抓包，两者均默认关闭。完整抓包仅针对 **通过认证的 MCP POST** 请求，原样存储收到的 JSON-RPC 请求和真正发送的 JSON-RPC 返回（包括 Shell 命令、工具参数与执行输出）；不会保存 HTTP Authorization/Cookie 头或 Admin API 内容。响应为 HTTP 202、没有 JSON 正文时会标为缺失。

完整抓包默认每侧 512 KiB 上限（16–4096 KiB 可配置），单份 JSONL 日志 16 MiB（1–32 MiB 可配置），仅保留当前及前一份滚动日志。超限保留前后片段，并标明原始大小/省略情况。文件位于私有 Admin 状态目录（默认 0600 权限），与轻量性能指标的日志文件分离。管理员必须重新输入密码才能启用、查看单条或导出这些高度敏感的记录，并且所有操作仍需登录与 CSRF。清除日志会同时删除指标与完整报文；关闭调试只停止新记录，不会自动删除旧文件。

**注意：** 抓包的 MCP 请求/响应可能含 API Key、密码、个人数据、文件全文和签名下载链接。仅在可信服务器上短时启用，不要公开分享或提交抓包日志。

调试关闭时，网关不再每请求调用性能计时器或安装监听器，不增加正文复制、额外 JSON 序列化或磁盘写入。无需刷新 MCP 工具 Schema。


## v0.3.7：受 Desktop Commander 启发的高效开发流程

保持 16 个核心工具不变，增强现有 fs_list / fs_read / fs_search / workspace_execute：

- **fs_list(details:true)**：按需提供文件大小、修改时间、权限；不跟随软链接。
- **fs_read.files[].tail_lines**：从末尾读取；文件超过 4 MiB 时，最多扫描最后 256 KiB，行号采用 tail[-N]，不提供整个文件的 SHA-256。尾部窗口**不能**充当写入哈希保护。
- **fs_search(regex:true)**：可选 JavaScript 正则模式，默认仍是字面量搜索；隔离 Worker 每文件限时 350ms，超时会报告 skipped 和 regex_timed_out，不能当作未发现匹配。
- **workspace_execute.copy**：从 source 复制到 destination，必须指定来自完整读取的 expected_sha256。
- **workspace_execute.move**：从 source 移动到 destination，同样要求完整哈希。仅支持单个普通文件（不超过 128 MiB）、不覆盖目标、拒绝源软链接和硬链接；目录操作请使用明确授权的 Job。
- **编辑失败诊断**：replace / patch 精确匹配失败时，在 steps[].result.diagnostic.suggestions 中返回有限的相似行、相似度和差异，但不执行任何模糊替换。

使用示例：

    {"cwd":"project","steps":[{"type":"copy","source":"src/main.mjs","destination":"backup/main.mjs","expected_sha256":"<完整文件 SHA-256>"}]}

    {"cwd":"project","query":"function\s+handle[A-Za-z]+","glob":"src/**/*.mjs","regex":true}

服务端 Schema 已扩展，部署后必须在 ChatGPT 的 MCP 应用设置中**刷新、审核并发布工具定义**；不会自动改变生产服务或旧会话的工具缓存。
