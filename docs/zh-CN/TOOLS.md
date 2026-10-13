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
