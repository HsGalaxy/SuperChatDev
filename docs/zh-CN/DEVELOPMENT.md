# 参与开发

[中文首页](../../README.md) · [English](../DEVELOPMENT.md)

我们欢迎围绕 **ChatGPT 原生网页版 MCP 开发流程** 的改进，例如原生附件传输可靠性、工具间数据契约、低延迟命令执行、断线重试和浏览器端真实回归。请不要为了增加数量而新增重复工具或构建通用 All-in-One 平台。

1. 阅读根目录 `AGENTS.md`、[架构](ARCHITECTURE.md) 与 [安全](SECURITY.md)。
2. 使用独立的 Git 工作区；不要直接修改生产路径 `/opt/chatgpt-dev-mcp`。
3. 尽量保持既有 16 个工具的 Schema 与 `openai/fileParams` 兼容；如果确需改动，要更新快照测试并提醒用户刷新 ChatGPT 已发布工具。
4. 新增功能必须附失败路径、权限边界与前后工具配合测试。
5. 运行以下检查，然后再提交 Pull Request。

```bash
npm run check
npm test
python3 -m unittest discover -s test -p 'test_installer*.py'
./install.sh --dry-run --mode fresh --domain mcp.yourdomain.org --proxy caddy
```

安装器测试不应修改生产系统、安装软件包或执行 systemctl restart。发行 `RELEASE.json` 只记录实际运行时文件清单；修改 `README.md`、`package.json` 或运行时代码后，应审查并更新相关 SHA-256。
