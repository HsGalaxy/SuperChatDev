# 常见问题与故障排查

[中文首页](../../README.md) · [English](../TROUBLESHOOTING.md)

**Q：一键脚本提示无法下载？**
检查服务器到 `raw.githubusercontent.com` 和 `codeload.github.com` 的 HTTPS 连通性，DNS、CA 证书与代理环境。不建议用 HTTP 或关闭证书校验绕过。

**Q：安装命令执行后没有交互菜单？**
请在真正的 SSH 终端运行，使用 `curl ... | sudo bash`；脚本会将 Python 安装器标准输入重新绑定到 `/dev/tty`。无终端自动化必须提供 `--mode`、`--yes` 等完整参数。默认中文，可传 `--lang en`。

**Q：安装完但 ChatGPT 连不上？**
检查 DNS、80/443、代理 TLS、`https://域名/mcp` 和本地 `/health`。反向代理不能改写 OAuth 路径；服务端正常不代表 ChatGPT 工具快照已同步。

**Q：部分工具没有显示？**
Core 默认只暴露 16 个工具。核查后台工具清单；在 ChatGPT 刷新、审核并发布连接器工具。DC 工具需要明确选择对应 Profile。

**Q：OAuth 总是重新登录？**
核查 Access Token 有效期、Refresh Token 开关、重启事件、客户端刷新能力。服务端支持刷新不意味着 ChatGPT 每次都能自动使用。

**Q：Job 看起来一直没返回？**
`job_start` 最多先等 500ms，超时返回 Job ID 是正常行为。继续调用 `job_read` 并检查 `status`、`exit_code`、`next_offset`，不要重复执行原命令。

**Q：权限不足或 Rust 构建失败？**
检查执行账号、工作区目录权限、`EXECUTION_ENV` 的 `CARGO_HOME`/`RUSTUP_HOME`/`PATH`，不要直接为 MCP 开放 sudo。

**Q：升级失败？**
检查发行 SHA-256 是否匹配、是否存在人工修改过的生产源码；检查安装器打印的备份目录，必要时核对后手动恢复。不要直接删除 `state` 或工作区。


**Q：安装 Node.js 时提示 `NO_PUBKEY`？**

早期安装脚本在 `umask 077` 下生成的公开 GPG 密钥环可能只有 root 可读，APT 沙箱用户无法读取。先检查 `stat -c '%a %n' /usr/share/keyrings/nodesource.gpg`；若是 `600`，执行 `sudo chmod 644 /usr/share/keyrings/nodesource.gpg && sudo apt-get update`，再重新运行一键安装。新版安装器已修复公开密钥环权限。不要关闭 APT 签名验证。
