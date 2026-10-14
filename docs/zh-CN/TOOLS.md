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

核心工具数量仍是 16 个；`workspace_execute` 新增向后兼容的 replace 步骤类型，需要 ChatGPT 端刷新、审核、发布工具定义。更激进的 inline 写入、锁替换、ZIP 压缩和正则搜索暂未启用，需要独立性能及安全评估。

## 精确替换（推荐小改动）

单行或小块代码修改可使用 `workspace_execute` 的 `replace` 步骤：

```json
{"cwd":"imports/project-xxx","steps":[{"type":"replace","path":"config.txt","old_text":"PORT=3000","new_text":"PORT=8080","expected_sha256":"<fs_read 返回的 SHA-256>"}]}
```

要求旧文本在文件中恰好出现一次，且当前文件哈希与阅读时一致，否则拒绝覆盖。它仍通过受限的 Job worker 执行，不绕过文件锁与 Linux 权限。
