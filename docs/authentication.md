# Authentication design

The gateway has two separate authentication paths.

## Account-wide discovery

An owned native Clerk session signs in through T3’s existing `t3-web` public-client profile. The resulting account JWT lists linked machines through the T3 Connect relay. DPoP-bound relay tokens check optional machine availability. The gateway does not read browser cookies, T3’s own credential files, or provider keys.

This account integration remains experimental and independent. It follows T3’s existing public-client behavior, rather than a dedicated registered third-party account integration. Replacing orchestration transport with official MCP does not remove that dependency.

Interactive `login` and resumable `login-start`, `login-verify`, and `login-status` share email-code/TOTP authentication. Account credentials rotate durably before response processing. Sign-in attempts and ambiguous verification responses are reconciled without automatically repeating verification. SSO-only, passkey-only, and interactive CAPTCHA flows remain unsupported. Account credentials are used only for discovery/status, not native MCP authorization.

## Per-machine official MCP approval

`connect <environmentId>` resolves the machine from account discovery, then uses the MCP SDK’s OAuth authorization-code flow with PKCE S256, a random state, and an ephemeral `127.0.0.1` callback. The CLI prints the official authorization URL. The user approves on T3’s page and chooses read-only or a runtime-mode ceiling. A pairing code or already-authorized browser session is handled by T3, never by this gateway.

Discovery, registration, token exchange, authorization URL, and resource are pinned to the selected machine’s origin. The callback checks method, Host, path, state, and T3’s `iss` origin before accepting a code. Invalid callbacks do not spend the waiting flow. Valid denial ends it. PKCE verification is handled by the SDK. Approval waits at most five minutes and does not hold the state lock; the account/session is checked again before saving credentials.

Only the approved bearer token, scope, origin, and expiry are saved, under an account/deployment/machine key. Codes, verifiers, and temporary registration metadata are not persisted or returned. Native calls use only that bearer credential. Ordinary tool calls cannot start OAuth, request an expanded grant, or silently replay after an auth challenge.

## Upstream reference

The gateway targets the official outside-agent MCP surface documented in **T3 v0.1.2**. These are protocol references, not evidence of live compatibility:

- [Outside-agent guide](https://github.com/pingdotgg/t3code/blob/v0.1.2/docs/user/outside-agents.md)
- [MCP OAuth server](https://github.com/pingdotgg/t3code/blob/v0.1.2/apps/server/src/auth/McpOAuth.ts)
- [MCP transport and access enforcement](https://github.com/pingdotgg/t3code/blob/v0.1.2/apps/server/src/mcp/McpHttpServer.ts)
- [Relay contract](https://github.com/pingdotgg/t3code/blob/v0.1.2/packages/contracts/src/relay.ts)

The gateway remains independent of a T3 checkout, fork, or private workspace package. [Verification and limits](verification.md)
