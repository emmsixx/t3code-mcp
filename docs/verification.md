# Compatibility and verification

## Tested T3 versions

The initial implementation follows T3 source commit `37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2` (September 15, 2026). Public production defaults and native sign-in support were checked on that date.

Live validation used three linked environments across Linux x64 and macOS arm64, reporting:

- `0.0.41-nightly.20260915.1752`
- `0.0.41-nightly.20260915.1780`

This is a record of tested versions, not a promise of compatibility with every T3 release. The integration depends on existing APIs and the `t3-web` public-client profile. See [authentication details](authentication.md).

## Live behavior verified

A single email-code login discovered all three machines. Subsequent checks reused the owned account session and verified:

- Relay-template JWT issuance, DPoP relay token exchange, and online status checks.
- Environment bootstrap and authenticated project reads through a real stdio MCP client/server connection.
- An explicitly authorized reply-only launch using `codex / gpt-6-astra`, approval-required mode, and an existing project workspace.
- Provider startup, turn completion, and retrieval of the exact reply `T3 MCP smoke test passed.` through `get_thread`.

No provider error, pending approval/input, or tool activity was reported during the reply-only test. Machine names, account information, filesystem paths, and live environment/project/thread identifiers are omitted from the public record.

## Automated checks

Run `pnpm test` for local fake-service tests of credential rotation, TOTP, DPoP signatures, form/JSON wire formats, expiry/reconnection, lost launch responses, retries across restarts, operation conflicts, provider errors, input/approval flags, and output bounds. Subprocess tests exercise agent-guided email/TOTP login across separate CLI invocations, wrong/expired codes, interrupted responses, cancellation, and the built CLI with the official MCP client over stdio.

Run `pnpm run test:package` to create a tarball, check its contents, install it in a temporary pnpm home, and verify the installed binary's version, help, tool discovery, and unauthenticated error behavior. It also verifies MCP startup through `pnpm dlx`. No T3 account or provider usage is required. This check downloads runtime dependencies from the registry.

On September 15, 2026, type checks, all 17 tests, and the isolated global-install and dlx MCP checks passed on Linux x64 using pnpm `11.20.0` with Node `22.23.2` and `24.19.0`. Frozen installation was also verified to reject a stale dependency lock. The public-content check passed, and both GitHub Actions workflows passed actionlint `1.7.12`.

GitHub Actions runs these checks on Node 22 and 24 on Linux and macOS. The [initial hosted CI run](https://github.com/emmsixx/t3code-mcp/actions/runs/35042881792) passed all four jobs, including global-install and dlx verification. Tagged releases run the same matrix and validate the release archive before publication.

## Remaining live validation

The split agent-guided login commands and sign-in reconciliation are covered by fake-service tests; the live login above used the original interactive flow. Real editing tasks, follow-up/interruption operations, retries under real network failures, logout/re-login, TOTP, and eventual expiry/revocation have not been exercised against production. A single authorized smoke test does not authorize later jobs on a user's machines.

Worktree/setup-script orchestration, additional sign-in methods, hosted HTTP MCP, and native Windows credential storage are not implemented.
