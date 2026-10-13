# Contributing to SuperChatDev

SuperChatDev is deliberately **ChatGPT Web-first**. Proposed features should improve the native browser MCP development workflow, not turn it into a general-purpose IDE or agent platform.

Before making changes:

1. Read [AGENTS.md](AGENTS.md), [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), and the [Core tool contracts](docs/TOOLS.md).
2. Develop in an isolated workspace copy, never by editing an active production `/opt/chatgpt-dev-mcp`.
3. Preserve `openai/fileParams`, resource/artifact behavior, stable tool inputs and client-facing error formats; changes to tool schemas need snapshot updates and coordination with published ChatGPT app actions.
4. Add tests for OAuth migration and security boundaries, job/cancel semantics, and full file-import-to-export development flows.
5. Run `npm run check`, `npm test`, and the installer tests. Review Git diffs and scrub credentials, logs, local state, signed download links, and server-specific config before committing.

The installer requires explicitly authorized root privileges from an SSH session. The normal MCP runner must never receive unrestricted sudo. Discussions and pull requests are welcome, with scope limited to the ChatGPT web development experience.

Licensed under [MIT](LICENSE).
