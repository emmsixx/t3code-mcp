# Configuration and storage

- `T3_MCP_STATE_DIR`: explicit directory, overriding automatic selection.
- `T3_MCP_CLERK_ORIGIN`: account auth origin; default `https://clerk.t3.codes`.
- `T3_MCP_RELAY_ORIGIN`: discovery/status origin; default `https://relay.t3.codes`.
- `T3_MCP_JWT_TEMPLATE`: default `t3-relay`.

New installations use `~/.t3connect-mcp`. If it does not exist and `~/.t3code-mcp` does, that legacy directory is reused without copying credentials. If both exist, the new directory wins; select the old one explicitly with `T3_MCP_STATE_DIR` when needed. Deployment changes require a separate directory.

State is unencrypted JSON: directory `0700`, file `0600`. It holds the gateway’s Clerk credential/session, DPoP proof key for relay status, approved MCP bearer credentials, and any legacy operation journal. Pending account login stores only attempt IDs, factor, and expiry, not the submitted email/code. OAuth approval codes, PKCE verifiers, and callback URLs remain in memory during `connect`.

MCP approvals are keyed by deployment, account ID, and environment ID, and pinned to the discovered HTTPS origin (HTTP only on loopback). Endpoint changes require new approval; a saved token is never forwarded to a changed address. OAuth discovery and token endpoints must use that same origin. Native MCP and OAuth requests omit cookies and reject redirects.

State writes are atomic and serialized. Browser approvals and native MCP calls do not hold the account-state lock. Another process holding the lock returns `state_busy`. After a crash, stop the process using the directory before removing its `lock` subdirectory; keep `state.json` and legacy journals.

The first successful MCP approval upgrades state to **format 3**, preserving account state and old operation records. Older bridge releases reject this format. Do not downgrade using that directory. Before approval, old format 1/2 state remains readable and its version is preserved. Legacy operation IDs are not replayed.

Native T3 currently issues a 30-day grant without refresh tokens. Expiry or rejection requires `connect` again. Approval status in discovery is a local observation, not proof of remote validity. Account session expiry independently requires `login` again.

`disconnect <environmentId>` forgets one local approval; `logout` ends the Clerk session and forgets all local approvals. Revoke the corresponding clients in each machine’s T3 **Settings → Connections** to revoke remote grants. Forgetting local state does not stop running tasks or revoke tokens already copied elsewhere. In-flight calls may finish after local logout.
