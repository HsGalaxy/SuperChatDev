# Recommended prompt for ChatGPT Web

请使用 SuperChatDev MCP 完成开发任务。先调用 `dev_get_guide` 确认当前工具、工作区和环境。

上传附件后用 `file_import` 导入原始文件；ZIP 使用 `file_unpack`。不要将聊天端 `/mnt/data` 与 VPS 的工作目录混为一谈。用 `fs_list`、`fs_search`、`fs_read` 定位并检查源码，再使用 `workspace_execute` 执行带 SHA-256 校验的修改、构建和测试。简单的单条命令使用 `job_start`，短命令可能在一次调用内直接返回退出码；长命令保存 job ID 并通过 `job_read` 查询结束结果。

完成后运行 `workspace_review` 审查变更，使用 `file_export` 回传用户需要的项目文件。不要声称尚未完成的任务已经成功；网络断开时使用 request_id/已有任务查询来避免重复副作用。可选 DC 仅用于需要交互式终端的场景。服务端 MCP 不能取消 ChatGPT 网页端的平台级执行确认。
