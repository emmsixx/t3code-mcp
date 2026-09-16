# Changelog

## [Unreleased]

## [0.1.0] - 2026-09-15

Initial experimental release.

### Added

- Account-wide T3 Connect sign-in through an owned native Clerk session, email-code authentication, and optional TOTP.
- Account discovery and DPoP-authenticated connections to linked T3 machines.
- Six stdio MCP tools for environments, projects, thread launch/status, follow-ups, and interruption.
- Persisted operation IDs and payloads for retrying incomplete launches, bounded output, and visible approval/input states.
- Compiled GitHub release packages, checksums, install verification, Hermes configuration, and an agent setup guide.

### Limitations

- Experimental compatibility using T3's existing `t3-web` client profile; no official third-party integration status.
- Linux/macOS, Node 22+. Windows credential storage is not implemented.
- Existing project workspaces only; no worktree preparation or setup scripts.
- Email-code/TOTP sign-in only; unsupported account challenges require other sign-in support.
- Permission-restricted plaintext credential storage. Real editing and the full live lifecycle still need validation.
