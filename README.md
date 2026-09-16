# T3 Code MCP

[![CI](https://github.com/emmsixx/t3code-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/emmsixx/t3code-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/emmsixx/t3code-mcp)](https://github.com/emmsixx/t3code-mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give an external agent access to your T3 Code machines through MCP. Sign in to T3 Connect once, browse existing threads and their status, or start a coding thread on a linked machine and project. Read its progress, send follow-ups, or interrupt its current turn.

Runs locally over stdio. Works with existing T3 installations—no fork or server changes required.

**Experimental, independent integration.** Account login, discovery, project reads, and a reply-only agent launch have been verified live. Upstream changes can affect compatibility. [Verification details](docs/verification.md) · [Authentication design](docs/authentication.md)

## Install

You need **Node.js 22+ and [pnpm](https://pnpm.io/installation) on Linux or macOS**, a T3 Connect account, and at least one linked, reachable T3 environment. Providers and projects must already be configured in T3. Windows is not supported in this release because credential storage uses POSIX file permissions; use Linux/WSL instead.

Install the latest stable release:

```sh
pnpm add --global https://github.com/emmsixx/t3code-mcp/releases/latest/download/t3code-mcp.tgz
t3code-mcp --version
t3code-mcp login
t3code-mcp environments
```

Releases include compiled JavaScript; pnpm installs the runtime dependencies. For a specific version or its checksum, see [GitHub Releases](https://github.com/emmsixx/t3code-mcp/releases). The package is distributed through GitHub, not the npm registry.

Run `login` for interactive terminal prompts, or [let your agent handle setup](#let-an-agent-set-it-up): it asks for your email, sends a verification code, and asks you to reply with it in chat. If your account uses an authenticator, it asks for that code next. The resulting account session stays local; the commands return login status without tokens. SSO-only, passkey-only, and interactive CAPTCHA flows are not implemented.

If pnpm reports that its global bin directory is missing, run `pnpm setup` and reopen your terminal. You can also use [pnpm dlx](docs/agent-setup.md#without-a-global-install) without a global install.

For source installation and development, see [Contributing](CONTRIBUTING.md#development).

## Connect your agent

After global installation, add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "t3code": {
      "command": "t3code-mcp",
      "args": ["serve"]
    }
  }
}
```

For **Hermes**, add an entry to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  t3code:
    command: t3code-mcp
    args: [serve]
```

Merge the entry into your existing configuration, then restart or reconnect the client. Use the absolute path printed by `command -v t3code-mcp` if your client does not inherit your shell's PATH. The client must use the same OS user and `T3_MCP_STATE_DIR` as the login commands. [Hermes MCP reference](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)

Try: **“List my T3 environments, then show the projects on the machine I choose.”**

Or: **“Show me the threads on this machine that are working or need my input.”**

### Let an agent set it up

Paste this into your agent:

> Install the latest stable release of https://github.com/emmsixx/t3code-mcp using docs/agent-setup.md. Guide me through login by asking for my email and verification code in chat, configure MCP while preserving existing settings, and verify the connection without launching a task.

The [agent setup guide](docs/agent-setup.md) covers installation, the resumable `login-start` / `login-verify` / `login-status` commands, client configuration, and verification.

## Available tools

| Tool | What it does |
| --- | --- |
| `list_environments` | Discover account-linked machines; optionally check availability. |
| `list_projects` | List projects and their configured model defaults on a machine. |
| `list_threads` | Discover existing thread IDs, titles, and status; filter by project or status. |
| `start_thread` | Create a thread and give its coding agent instructions. |
| `get_thread` | Read current status, bounded messages/activity, provider errors, and requests for input. |
| `send_message` | Send follow-up instructions to an existing thread. |
| `interrupt_thread` | Request interruption of a selected turn. |

Launches use the project's existing workspace and can change files or incur provider usage. New threads default to `approval-required`; answer approvals and input requests in T3's own clients. Worktree creation and setup scripts are not supported yet.

Thread statuses include `working`, `awaiting_input`, `awaiting_approval`, `finished`, and `failed`. Listing covers unarchived threads, including completed turns, with 20 results per page by default. `finished` means the latest turn completed; read its messages to assess the result. [All statuses and filters](docs/tools.md#thread-discovery-and-status).

Use the environment/project IDs returned by the tools. Mutation tools require an `operationId`: preserve it **and the original arguments** when retrying an ambiguous result. An accepted command is not a completed task—check `get_thread`. [Tool inputs and retries](docs/tools.md)

## Credentials and configuration

The bridge stores its own account credential, proof key, and operation journal in `~/.t3code-mcp`. These are **unencrypted files**, restricted to their owner (`0700` directory, `0600` state file). The journal includes submitted instructions. Keep this directory private.

`T3_MCP_STATE_DIR` selects a different directory. The bridge does not read existing browser cookies or T3 credentials. `t3code-mcp logout` ends this bridge's Clerk session and removes its local credential/key. [Configuration, expiry, and lock recovery](docs/configuration.md)

## Upgrade or uninstall

To upgrade, rerun the install command above and restart your MCP client. Installed releases do not auto-update. Review the [changelog](CHANGELOG.md) before upgrading. Use `t3code-mcp --version` to check the installed version.

To uninstall:

```sh
t3code-mcp logout
pnpm remove --global t3code-mcp
```

Remove the MCP configuration entry too. The operation journal remains in the state directory; delete it yourself only when outstanding operations are resolved. Previously issued environment sessions follow T3's own expiry/revocation rules.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, tests, and the release process. Report bugs through [GitHub Issues](https://github.com/emmsixx/t3code-mcp/issues); see [SECURITY.md](SECURITY.md) for vulnerability reports.

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for upstream attribution. T3 Code MCP is not affiliated with or endorsed by T3 Tools Inc. or Clerk.
