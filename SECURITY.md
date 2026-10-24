# Security

T3 Connect MCP routes calls to machines under each machine’s approved OAuth permissions. A native tool can start agents, change files, incur charges, or schedule persistent work. Read-only is enforced by T3, not by tool annotations or descriptions. The gateway cannot approve its own permission requests.

## Reporting

Use [GitHub’s private vulnerability reporting](https://github.com/emmsixx/t3code-mcp/security/advisories/new) when available, or open an issue asking for a private contact channel without exploit details or secrets. Include the version, platform, and a reproduction with fake credentials. Never attach codes, tokens, proof keys, state, or live transcripts. This remains an experimental independent integration.

## Credential storage and boundaries

The unencrypted state holds the gateway’s Clerk credential, proof key, per-machine MCP bearer tokens, and legacy operation journal. POSIX permissions restrict access; this is not an OS keychain. Anyone who can read it may gain account or machine access.

Account credentials are used for discovery/status. Machine tokens are keyed to account/deployment/environment and pinned to the current discovered origin. OAuth metadata cannot redirect credentials to another origin. Remote requests reject redirects and omit browser cookies. Loopback HTTP is allowed for local use; remote origins require HTTPS.

`serve` exposes no network listener. `connect` temporarily binds an ephemeral IPv4 loopback callback, checks state/issuer, and uses PKCE. It closes the listener on completion, failure or timeout. The user selects the OAuth grant in T3’s page. The gateway’s client does not advertise interactive elicitation support.

`logout` ends the account session and forgets local machine tokens; `disconnect` forgets one. Remote OAuth grants are independent: revoke each gateway client in the machine’s **Settings → Connections**. Local removal does not stop running work or revoke credentials copied elsewhere. Native calls are never automatically replayed after an ambiguous failure.
