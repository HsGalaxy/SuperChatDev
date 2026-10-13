# Developing Core MCP

Read root `AGENTS.md` and `ARCHITECTURE.md`. Use an isolated workspace copy, run `npm run check && npm test`, add regression tests and review changed files. `test/contracts/core-tools-v0.3.0.json` pins published API schemas. Deliberate updates must include client snapshot refresh and compatibility notes.

Validate the installer non-destructively with `./install.sh --dry-run --mode fresh --domain mcp.your-domain.org --proxy caddy`, `./install.sh --dry-run --mode upgrade`, and `python3 -m unittest discover -s test -p 'test_installer*.py'`. Tests should not run apt, systemctl restart or alter production. The `RELEASE.json` manifest pins runtime code/assets only; generated artifacts, secrets, release diagnostics and the human installer are not installed into `/opt`.

File-transfer regression tests must preserve native ChatGPT attachment metadata and signed artifact results. A passing server-side test is not a guarantee of a connected browser user's attachment upload; verify the native workflow after publishing tool actions.
