# SuperChatDev v0.3.12 可靠性、资源配额与独立 Runner

本文件记录可靠性优化的部署、验证和回滚；[README](../../README.md) 保持简洁，版本历史集中在 [CHANGELOG](../../CHANGELOG.md)。

## 1. 变更范围与优先级

**P0**：使用受控 TasksMax / MemoryMax；可选将 HTTP/OAuth 管理进程和开发任务拆到两个独立 systemd 服务/cgroup。**P1**：HTTPS 下载仍可使用，只有小于资源上限的 artifact:// 才提供 ResourceLink；Core/Native 模式不常驻 DC。**P2**：日志差量预览、轻量追踪分页、任务/批处理最近索引、真正执行状态统计、cgroup 指标。

没有修改敏感内容捕获开关、数据字段或保留期限，没有全局删除 JSON 文本兼容输出，没有重写 Jobs/Workspace 引擎。

## 2. 不改变线上服务的预演

在服务器下载并切入已经验证的 v0.3.12 源代码后：

    sudo bash install.sh --mode upgrade --dry-run
    sudo bash install.sh --mode upgrade --dry-run --apply-resource-limits
    sudo bash install.sh --mode upgrade --dry-run --enable-isolated-runner

普通 --mode upgrade --yes **只替换运行时文件**，保留现有 systemd 配额、私密凭据、日志和文件工作区。升级进程会做版本健康检查与原子发行回滚。不要把对源码默认值的修改误认为已迁移旧 unit。

## 3. 第一阶段：明确迁移资源配额

新安装（未启用隔离 Runner）默认控制服务：

    TasksMax=1024
    MemoryMax=4G

对现有环境需**明确选择**，安装器会备份 systemd / 环境文件并新增受管理 drop-in（不直接覆盖用户原来的主服务 unit）：

    sudo bash install.sh --mode upgrade --yes --apply-resource-limits

已有非 SuperChatDev 管理的同名 drop-in 会被拒绝覆盖。生产服务器初始 256 tasks / 2 GiB 是一个实际容量风险；具体采用多少应根据宿主机可用容量、稳定压测和共同部署服务来调整。此命令会重启 MCP 服务，所以建议在维护窗口执行。

## 4. 第二阶段：独立 Runner（显式可选）

更彻底的隔离方案，需要预发布根权限环境先运行 IPC / 重启 / OOM / 线程配额测试：

    sudo bash install.sh --mode upgrade --dry-run --enable-isolated-runner
    sudo bash install.sh --mode upgrade --yes --enable-isolated-runner

只在显式启用时创建：
- chatgpt-dev-mcp.service：控制面，TasksMax=512，MemoryMax=2G。
- chatgpt-dev-mcp-runner.service：任务面，TasksMax=768，MemoryMax=4G。
- /var/lib/chatgpt-dev-mcp/state/job-runner.sock：仅拥有者可访问的 0600 Unix Socket。
- /etc/chatgpt-dev-mcp/runner.env：权限 0600，只包含执行运行环境，不复制 OAuth / 管理密码。

HTTP 服务只向 Runner 发固定的 job、batch 或 exec 请求；命令参数和原有幂等数据仍保存在私有任务状态内。Runner 离线时不回退为 HTTP 控制进程直接运行重任务，以防止意外击穿隔离。任务启动确认不明时保留请求预留状态；需查询原有 ID 和 request_id，不能自动重放可能带副作用的操作。

不改变原有 Jobs IDs、job_read 增量日志、workspace_read、job_cancel 或 workspace_cancel 接口。进程 detached 不是 cgroup 隔离，隔离来自不同的 systemd service。独立 Runner 无法保证机器重启后自动恢复正在执行的命令，这一点与原来的任务语义相同。

## 5. 指标与诊断

管理后台总览展示当前 cgroup PID 与内存的用量、上限、峰值及累计触限事件（这些事件不是 OOM kill 次数）。Performance 统计 MCP 调用层面的 HTTP / 工具错误，同时提供按任务 ID 去重的 Execution Succeeded/Failed/Interrupted/Cancelled，批处理子 Job 不额外算一个顶层失败。

dev_get_guide(include_diagnostics=true) 默认返回有界最新样本；完整追踪可请求 diagnostics_mode=full。job_list 和 workspace_list 支持游标、最近任务索引。旧历史索引迁移在首次服务启动/初始化时进行一次，不是每次请求都扫描旧状态。部分视图只展示最近样本，标记了分页和截断。

长日志可以选择 preview_mode=delta 或 none，默认 full 的 output_preview 字段保留旧兼容语义。next_offset 与 has_more 仍按原始输出字节计算。

## 6. 发版前验收

在隔离环境逐项核验：
1. 超过 256 线程的构建压测下，控制 HTTP /health 与 OAuth 请求依然可达，无 spawn EAGAIN。
2. 控制面、Runner 分别读取 systemd cgroup.procs 并确认属于不同 cgroup；资源限制触顶只影响任务面。
3. 同一 request_id 多次调用只能有一个真实任务；Runner Socket 断开不能偷偷转成本地启动。
4. 网关重启后任务和日志继续可查询；Runner 自身重启不会重复执行已受理工作。
5. Cloudflare Tunnel 与 Caddy 公网地址、OAuth、文件传输正常；下载小文件具 artifact://，大文件仅保留签名 HTTPS。
6. 切换 Core / Native / DC 模式后仅在 DC 模式连接上游，并保留已执行 DC 请求结果。
7. 超长 UTF-8 日志分页、增量尾部预览、状态失败去重均正确；旧 MCP 工具发布快照需要刷新后才会显示新增可选字段。
8. 安装升级错误会从 /var/backups/chatgpt-dev-mcp-installer/... 的备份恢复运行时和被改动的服务设置。

**测试边界**：不对生产环境执行并发 cgroup 限额压测。隔离 Runner 的本地 Unix IPC 可在不提权的单元/集成测试中验证，但独立 systemd cgroup 与真实限制触顶必须在预发布宿主环境通过后才启用生产开关。

## 7. 常用只读诊断

    systemctl show chatgpt-dev-mcp.service -p TasksMax -p MemoryMax -p ActiveState
    systemctl show chatgpt-dev-mcp-runner.service -p TasksMax -p MemoryMax -p ActiveState
    systemctl status chatgpt-dev-mcp --no-pager
    systemctl status chatgpt-dev-mcp-runner --no-pager

查 PID 配额累计事件前须确认 cgroup 路径，避免错误地读取 system.slice 其他服务的数据。修改本机配额须以操作系统安全边界和机器总体负载为前提，不应无限制解除配额。
