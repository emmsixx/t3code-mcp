# Security

T3 Code MCP can start coding agents with the permissions of the selected T3 environment. Review the machine, project, model, and runtime mode before launching a task. Do not automatically approve pending actions on behalf of a user.

## Reporting

Report suspected vulnerabilities privately using [GitHub's private vulnerability reporting](https://github.com/emmsixx/t3code-mcp/security/advisories/new) when enabled. If that option is unavailable, open an issue asking for a private contact channel without including exploit details or secrets. There is no guaranteed response time; this is an experimental project.

Include the package version, OS/Node versions, and a minimal reproduction with fake credentials. Never include login codes, account tokens, proof keys, or `state.json` in an issue or diagnostic attachment.

## Credential storage

The state directory contains an unencrypted native Clerk credential, session metadata, a DPoP private key, and an operation journal with submitted instructions. Access is restricted with POSIX permissions; it is not an OS keychain. Anyone who can read those files may gain account access. Use an OS account and host you trust.

The MCP server exposes no network listener. Remote calls use HTTPS (HTTP is allowed only for loopback testing) and reject redirects. This does not protect a user from an already-compromised local account or a malicious configured relay/authentication endpoint.

Use `t3code-mcp logout` to end the owned account session. Already issued environment sessions follow T3's expiry/revocation rules. If state has leaked, revoke the relevant sessions through T3/Clerk as well; deleting a local file alone does not revoke a remote session.
