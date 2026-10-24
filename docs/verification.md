# Compatibility and verification

## Gateway status

The gateway uses T3’s official outside-agent MCP/OAuth contracts from **v0.1.2**. **No live gateway OAuth approval or native tool round trip has been performed against a current T3 machine.** Automated tests use fake account/relay and MCP services; they do not prove production compatibility.

The September v0.3.0 bridge was live-checked against T3 `0.0.41` nightlies for account login, three-machine discovery, project reads, and one authorized reply-only task. That record predates this gateway and does not validate its OAuth flow. The unmerged direct v2 adapter was never live-validated.

## Automated verification

`pnpm run check`, `pnpm test`, and `pnpm run check:public` cover the account sign-in flow, bounded discovery, MCP stdio integration, official HTTP MCP routing, OAuth PKCE/state validation, explicit denial, approval persistence, endpoint/account binding, native permission errors, lost mutation responses, and result limits. Native schemas, arguments, result content, and metadata pass through without orchestration translation.

`pnpm run test:package` builds and installs the exact archive globally in an isolated pnpm home and through `pnpm dlx`. It checks the renamed command/package and all three gateway tools without using real credentials.

`pnpm run test:upgrade` installs the previous stable release, creates a fake saved login and ambiguous legacy operation, then installs the gateway through the documented moving release URL. It verifies the renamed command, preserved account/proof/journal state, three-tool discovery, and absence of automatic legacy mutation replay. It uses temporary state, real package archives, and public GitHub release downloads, not a real T3 account.

CI requires Conventional Commits plus Node 22 and 24 on Linux and macOS. See [Contributing](../CONTRIBUTING.md).

## Remaining live checks

On a user-selected machine, verify account discovery, browser approval at read-only access, tool listing, and one native read. Then, only for an explicitly authorized project/task, verify native launch, follow-up, interruption, permission ceilings, expiry/revocation, and behavior after a lost response. Do not infer these from fake-service tests or the old smoke test.

Other limits: Linux/macOS only; email-code/TOTP account sign-in; no hosted gateway endpoint; no interactive MCP elicitation, resource/prompt proxy, or provider-session identity. The account discovery integration still depends on T3’s existing public-client profile. [Authentication](authentication.md)
