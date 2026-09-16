# Changelog

## [Unreleased]

### Added

- Prepare orchestration v2 support with per-environment protocol detection, bounded projection/history reads, and authenticated WebSocket RPC launch, follow-up, and interruption. V1 environments remain supported. Pending release validation; do not merge until T3 ships v2 in nightly or stable.
- Expose v2 runtime/run IDs, pending request response capabilities, and preparing, queued, waiting, cancelled, and rolled-back states. V2 follow-ups accept explicit auto, queue, steer, and restart delivery.
- Preserve unfinished operations across bridge upgrades and reject replay when an environment changes orchestration protocol. The first v2 mutation upgrades the local journal to state format 2, which older bridge releases cannot read.

### Maintenance

- Require Conventional Commits and passing CI for pull requests into `main`, with squash merging and conventional Dependabot messages.
- Verify upgrades from the previous stable release on Linux and macOS, including saved account access, unfinished operations, and MCP tool discovery.
- Document an explicit upgrade command and contribution checks.

## [0.3.0] - 2026-09-16

### Added

- `list_threads` discovers existing unarchived thread IDs, titles, current status, attention flags, and turn timing. Supports project/status filters and bounded pages ordered by recent activity.
- Shared thread statuses for working, connecting, awaiting approval/input, ready plans, monitoring, finished, failed, interrupted, stopped, idle, and unknown states.

### Changed

- `get_thread` now returns the same derived status as thread listing and uses one current snapshot for session, turn, and attention flags, with its snapshot sequence exposed separately from message history.
- Setup instructions and package verification now cover seven MCP tools. Upgrade and restart/reconnect the MCP client to discover `list_threads`.

## [0.2.0] - 2026-09-16

### Added

- Agent-guided account login through `login-start`, `login-verify`, and `login-status`. Agents can ask for an email, verification code, and optional authenticator code directly in chat.
- Resumable login across CLI processes, with structured JSON input/output, wrong-code recovery, expiry handling, and reconciliation after an unreadable verification response. Session tokens stay local.

### Changed

- The README setup prompt and agent guide now use chat-guided login by default.
- Interactive `login` shares the resumable flow and releases its state lock while waiting for user input.
- `logout` cancels pending login attempts and revokes a session if verification completed before its response was lost.

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
