# Security Policy

SuperChatDev is intended for one trusted owner administering a dedicated Linux development host. **It is not multi-user isolation or a secure sandbox for untrusted tenants.**

The MCP server can execute code with the unprivileged runner's filesystem and network permissions. Keep its HTTP listener on loopback behind authenticated HTTPS, use strong separate OAuth/admin credentials, and treat uploaded repositories and tool output as untrusted input.

The installer is meant to run in an explicitly authorized root SSH terminal; **do not** give the MCP process unrestricted sudo to make installation easier.

Please report suspected OAuth, file transfer, path traversal, credential leak, or privilege issues privately to the repository owner. Do not post live bearer tokens, signed artifact URLs, server login data or sensitive exploit payloads in public issues.

See [Security architecture](docs/SECURITY.md). The project is distributed under the [MIT License](LICENSE).
