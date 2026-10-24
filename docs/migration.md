# Migrating from T3 Code MCP

The account-wide gateway is named **T3 Connect MCP**. Its package/CLI is `t3connect-mcp`; the GitHub repository URL remains unchanged. This is a breaking interface change from v0.3.0, not an orchestration-v2 adapter upgrade.

## Upgrade steps

1. Resolve any unfinished legacy operations in T3 before submitting related work again. Keep the operation journal; an `operation_incomplete` may mean a launch was accepted. The gateway never translates or replays those commands.
2. Install the gateway from source, or its release archive once published. The old v0.3.0 archive contains the old binary. See [installation](../README.md#install-from-source).
3. Run `t3connect-mcp login-status`. Existing `~/.t3code-mcp` state is reused if `~/.t3connect-mcp` is absent. Keep an existing `T3_MCP_STATE_DIR` override on both CLI and MCP processes.
4. Run `t3connect-mcp environments`, then `t3connect-mcp connect <environmentId>` for each machine you want. Existing account login and old environment sessions do not substitute for official MCP approval.
5. Update the MCP client command to `t3connect-mcp`, args `["serve"]`, and reconnect it. A client entry named `t3connect` is recommended; its label is yours to choose.
6. Verify `list_environments`, `list_tools`, and a native read such as `t3_project_list`. Remove the old global package with `pnpm remove --global t3code-mcp` once the new command works.

Native schemas replace the six old project/thread tools. For example, use `call_tool` with `name: "t3_thread_read"` and the official tool’s arguments instead of the old `get_thread`. Discover the schema rather than renaming fields blindly. There is no generic gateway `operationId`; retry guarantees belong to each native tool.

## State and rollback

Login state, DPoP proof keys, and legacy operation records survive installation and account discovery. The first native MCP approval writes state format 3, which old releases cannot read. Preserve a private backup before upgrading if you need a rollback, and never restore it to replay an ambiguous mutation. The prior unmerged v2 draft’s format-2 journal is retained without dropping its extra fields.

## Earlier v2 draft

PR #3’s direct HTTP/WebSocket orchestration adapter is superseded by this gateway direction. Its original gate correctly required release/live validation; shipping V2 did not establish that compatibility. This implementation starts from current main and removes the old orchestration path instead of merging that draft.

## Direct native MCP alternative

For a single machine, connect your client directly using **Settings → Connections → Copy MCP URL** and OAuth. You do not need this gateway for T3’s native features. [Official guide](https://github.com/pingdotgg/t3code/blob/v0.1.2/docs/user/outside-agents.md)
