# T3 Connect MCP

[![CI](https://github.com/emmsixx/t3code-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/emmsixx/t3code-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

One stdio MCP connection for discovering your T3 Connect machines and using each machine’s **official T3 MCP tools**. Sign in to discover your machines, approve MCP access on the machines you choose, then let your external agent select and call their native tools.

Formerly **T3 Code MCP** (`t3code-mcp`). The package and command are now **`t3connect-mcp`**. The GitHub repository stays at `emmsixx/t3code-mcp` so existing links remain usable. This independent project is not an official T3 product.

**Gateway release in preparation.** The latest published v0.3.0 still uses the old name and seven-tool interface. Use the source installation below until a gateway release is published. The gateway is tested with local fake services; live compatibility with current T3 remains unverified. [Verification](docs/verification.md) · [Migration](docs/migration.md)

## Why use this?

T3 already supports [outside agents over MCP](https://github.com/pingdotgg/t3code/blob/v0.1.2/docs/user/outside-agents.md). Connect directly to its MCP URL when you only need one machine or your client already manages several remote connections.

This gateway adds **account-wide discovery and routing through one local MCP entry**, including for clients that only support stdio. It discovers native tool schemas instead of maintaining its own thread/agent API. T3 owns execution, available features, and permissions. The gateway does not implement another orchestration engine.

One account login discovers machines. **Each machine still requires its own OAuth approval**: T3 Connect account credentials cannot substitute for that consent. You can approve different permission levels on different machines.

## Install from source

Requires Node 22.12+, pnpm, Linux or macOS, a T3 Connect account, and reachable linked machines with official outside-agent MCP support. The upstream reference is **T3 v0.1.2**. Providers and projects are configured in T3.

```sh
git clone https://github.com/emmsixx/t3code-mcp.git t3connect-mcp
cd t3connect-mcp
pnpm install --frozen-lockfile
pnpm run build
pnpm pack --out ./t3connect-mcp.tgz
pnpm add --global ./t3connect-mcp.tgz
t3connect-mcp login
t3connect-mcp environments
```

To approve a selected machine, use its ID from `environments`:

```sh
t3connect-mcp connect <environmentId>
```

Open the printed URL **in a browser on the computer running the CLI**, choose a permission level on T3’s page, and approve. The CLI listens on an ephemeral loopback port for up to five minutes. Read-only is T3’s default. A browser on another computer needs an SSH forward for that callback port; an ordinary remote browser cannot reach it automatically. No coding task runs during setup.

The CLI stores the approved credential locally. Re-run `connect` when it expires, is revoked, or the machine’s address changes. [Authentication](docs/authentication.md)

## Connect your agent

```json
{
  "mcpServers": {
    "t3connect": {
      "command": "t3connect-mcp",
      "args": ["serve"]
    }
  }
}
```

For Hermes, use its `mcp_servers` section with `command: t3connect-mcp` and `args: [serve]`. Preserve existing client settings. Use the full executable path if needed. Run login, approval, and MCP under the same OS user and state directory.

Try: **“List my T3 machines, discover the tools on the machine I choose, and list its projects.”**

## Gateway tools

- **`list_environments`** discovers account-linked machines, official MCP URLs, and saved approval status. Availability checks are optional.
- **`list_tools`** lists a selected machine’s native tools, descriptions, schemas, and annotations. Follow `nextCursor` for more tools.
- **`call_tool`** forwards a native tool’s name and unchanged arguments to the selected machine and returns its MCP result.

For example, discover the schema for `t3_project_list`, then call:

```json
{
  "environmentId": "<selected environment ID>",
  "name": "t3_project_list",
  "arguments": {}
}
```

Native tools can start agents, change files, incur provider charges, or schedule recurring work. T3 enforces the approved permission ceiling. Tools requiring a T3 provider session, such as `delegate_task`, may reject an outside client. This gateway forwards those errors; it cannot create that identity or approve permissions. It forwards tools only, not arbitrary HTTP/RPC, MCP prompts/resources, or interactive MCP elicitation. [Tools and limits](docs/tools.md)

Calls are not automatically replayed. After a timeout or lost response, inspect T3 state before retrying a mutation, and follow that native tool’s own retry contract.

## Credentials and configuration

New installations use `~/.t3connect-mcp`. If that directory is absent and `~/.t3code-mcp` already exists, the gateway continues using the old directory. `T3_MCP_STATE_DIR` overrides both. Account credentials and per-machine approvals are unencrypted, with directory mode `0700` and file mode `0600`. Existing operation journals are retained for manual reconciliation and never replayed by this gateway.

`disconnect <environmentId>` forgets one local approval. `logout` ends the gateway’s account session and forgets all local approvals. **Neither revokes the machines’ OAuth sessions:** revoke those in each machine’s **Settings → Connections**. [Storage and recovery](docs/configuration.md)

## Upgrade or uninstall

After a gateway release is published, install or upgrade with:

```sh
pnpm add --global https://github.com/emmsixx/t3code-mcp/releases/latest/download/t3connect-mcp.tgz
```

Until then, repeat the source installation. The new archive name is not present on the old v0.3.0 release. Upgrades do not happen automatically. Replace the old client command with `t3connect-mcp`, reconnect your client, and approve each machine. Once the new command works, remove the old package with `pnpm remove --global t3code-mcp`. See [migration](docs/migration.md) for unfinished operations and downgrade limits.

To uninstall the gateway, revoke its clients in T3, run `t3connect-mcp logout`, remove its MCP configuration, then run `pnpm remove --global t3connect-mcp`. Keep legacy journals until outstanding operations are reconciled.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report bugs through [GitHub Issues](https://github.com/emmsixx/t3code-mcp/issues) and vulnerabilities through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). [NOTICE](NOTICE) includes upstream attribution. Not affiliated with or endorsed by T3 Tools Inc. or Clerk.
