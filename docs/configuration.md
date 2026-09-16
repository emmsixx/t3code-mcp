# Configuration and storage

| Variable | Default |
| --- | --- |
| `T3_MCP_STATE_DIR` | `~/.t3code-mcp` |
| `T3_MCP_CLERK_ORIGIN` | `https://clerk.t3.codes` |
| `T3_MCP_RELAY_ORIGIN` | `https://relay.t3.codes` |
| `T3_MCP_JWT_TEMPLATE` | `t3-relay` |

The public defaults come from T3's hosted web bundle. Custom origins require HTTPS, except loopback HTTP for local tests. Credentials are bound to the configured deployment; use separate state directories for different deployments/accounts.

State is stored as **unencrypted JSON**, with directory mode `0700` and file mode `0600`. It contains the bridge's native Clerk client credential, session ID, DPoP private key, and operation journal (including submitted instructions). It does not read browser cookies, existing T3 credentials, or `~/.t3/userdata`. Relay/environment access tokens remain in memory; short-lived bootstrap credentials are exchanged immediately.

State writes are atomic and operations are serialized. Another process using the same state directory receives `state_busy`. If a process crashes, stop any bridge process using that directory before removing its `lock` subdirectory. Keep `state.json` so outstanding operations can still be reconciled. The journal retains up to 10,000 operations and is not automatically pruned.

Expired environment tokens reconnect through the account session. A rejected token is evicted, and the next invocation can reconnect. Revoked/expired Clerk sessions require a fresh login. `logout` ends the bridge's Clerk session and deletes its local credential/key; already issued environment sessions are subject to their server-side expiry/revocation rules. If remote logout fails, the CLI retains state so you can retry.
