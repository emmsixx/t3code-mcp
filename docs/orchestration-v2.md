# Orchestration v2 preparation

This change targets [T3 orchestration v2 PR #2829](https://github.com/pingdotgg/t3code/pull/2829), pinned to `729c6ff9ac32a9e0a3d1e571705e72a94772ece3` (September 16, 2026). The PR was open when inspected. V2 support has automated coverage only, with no live validation against a released server or real provider.

## Merge gate

Keep the integration PR in draft with auto-merge disabled. Passing CI or an upstream merge does not satisfy the release gate.

- [ ] V2 is available in an actual T3 **nightly or stable release**. Record the release version and upstream commit here.
- [ ] Compare that release's descriptor, HTTP routes, RPC envelopes, command/launch schemas, and status/history semantics against the pinned source below.
- [ ] Run all required CI checks on the updated branch, including package installation and upgrade verification.
- [ ] Verify discovery and reads against that release, including migrated v1 history and mixed v1/v2 machines where available.
- [ ] With an explicitly authorized machine, project, and task, verify launch, follow-up, interruption, and retry/reconnect behavior. Record limits in `verification.md` without credentials or personal IDs.
- [ ] Resolve differences, update compatibility documentation, and remove the README preparation notice before marking the PR ready.

## Architecture

The bridge remains an account-wide stdio MCP server. `t3.ts` owns authentication, validates descriptors and socket endpoints, and selects an adapter per machine and bridge call. Upgrades are detected without restarting MCP. `protocol-v1.ts` retains the existing HTTP behavior. `protocol-v2.ts` owns v2 schemas, command construction, and bounded read views. `orchestration.ts` defines the shared interface; MCP handlers and the journal do not construct upstream commands.

V2 reads use DPoP HTTP with `x-t3-orchestration-protocol: 2`. Mutations request a WebSocket ticket with the environment credential, then connect to the validated `/ws` endpoint with `orchestrationProtocol=2`. `rpc.ts` implements unary Effect JSON RPC with one connection per request and no automatic mutation replay. Tickets and socket URLs are not persisted or returned to MCP callers.

An absent descriptor protocol version means v1; explicit versions 1 and 2 are supported. Unknown versions, identity mismatches, malformed descriptors, and discovery failures stop the operation. Failed v2 requests never fall back to v1 mutations.

The package remains independent of a T3 checkout and private workspace packages. Effect `4.0.0-rc.112`, matching upstream, is a development-only dependency for testing the real RPC server/codec. Installed packages use Node's built-in WebSocket client.

## Tool behavior

All seven existing tools remain. Login and relay discovery retain the existing flow.

| Tool | V2 behavior |
| --- | --- |
| `list_projects` / `list_threads` | Read the shell. Thread listing covers unarchived, non-deleted threads with existing filters and pagination. |
| `start_thread` | Call `orchestration.launchThread` with stable command, thread, and message IDs. Use the project root; T3 owns preparation, including configured setup scripts. Explicit worktree defaults remain rejected. |
| `send_message` | Preserve the existing model/modes. Omitted mode means `auto`: T3 selects starting, steering, or queuing against serialized state. Explicit `queue`, `steer`, and `restart` are supported; steering/restart targets are journaled. Explicit modes are rejected on v1. |
| `interrupt_thread` | Pin an application-owned `runId`, explicit or selected from active runs. V1 `turnId` values cannot be translated. Missing, queued, terminal, or otherwise non-interruptible targets fail before dispatch. |
| `get_thread` | Read `/bounded`, then `/history` with opaque cursors. V2 determines page size; `turnLimit` applies only to v1. Visible rows include inherited history. Existing output limits apply. |

Thread results include `protocolVersion`. V2 returns `session: null` and `latestTurn: null`; inspect `runtime.status`, `runtime.activeRunId`, `runtime.latestRunId`, `runtime.lastError`, and `runtime.historyOrigin`. No v1 session or turn IDs are synthesized.

Statuses add `preparing`, `queued`, `waiting`, `cancelled`, and `rolled_back`. `waiting` may describe an active waiting run, a runtime request, or provider background work after a turn ended. Unknown states remain `unknown`. `finished` means run completion, not task success or proof that all related child work is done.

The shell exposes one primary pending request: list attention flags describe that request, not every blocker. `get_thread.runtimeRequests` returns up to twelve pending requests from the bounded projection, including `live`, `message`, or `not_resumable` response capabilities. `runtimeRequestsSnapshotSequence` identifies that observation. Status uses a separate shell snapshot and may be newer. Human approvals and input remain in T3. T3's WebSocket ingress currently attributes creations to `createdBy: "user"`, while retaining this adapter's `creationSource: "mcp"`.

Timeline message timestamps use the item's start time, or update time when no start is available. `page.hasMore` describes server history; `outputTruncated` separately describes output clipping or a server payload-budget overrun.

## Journal and upgrades

Operations preserve their IDs and payloads. New entries record `protocolVersion`; historical untagged entries mean v1. Dispatch receipts retain event sequences. Launch receipts retain the initial run ID and whether T3 resumed a previous launch.

If an environment changes protocol during an unfinished operation, retry returns `operation_protocol_changed` with the original thread ID and versions. Inspect that thread in T3 and reconcile what was accepted before requesting new work. Commands are not translated and replacement work is not created. Completed local receipts remain available without reconnecting.

The first v2 mutation writes **state format 2**, preserving credentials, proof key, and earlier operations. Older bridge releases reject this format: do not downgrade against that state directory. V1-only use retains format 1. This prevents older executables from replaying v2 payloads as v1 commands.

T3's legacy import preserves thread identity and user/assistant transcripts, but does not migrate provider sessions, native runs, approvals, checkpoints, or activities. Missing execution state is not proof of completion. Continuing an imported thread starts a fresh provider session with a transcript handoff.

## Deferred work

Worktree creation, long waits/subscriptions, approval responses, provider switching, forks, and delegation tools are outside this PR. Future waits must avoid holding the state lock. Native T3 `/mcp` currently requires a provider-session-scoped bearer credential and does not accept this bridge's environment DPoP credentials as an external MCP client.

## Pinned sources

- [Protocol and descriptor](https://github.com/pingdotgg/t3code/blob/729c6ff9ac32a9e0a3d1e571705e72a94772ece3/packages/contracts/src/environment.ts)
- [HTTP routes and headers](https://github.com/pingdotgg/t3code/blob/729c6ff9ac32a9e0a3d1e571705e72a94772ece3/packages/contracts/src/environmentHttp.ts)
- [Commands, projections, launch, and history](https://github.com/pingdotgg/t3code/blob/729c6ff9ac32a9e0a3d1e571705e72a94772ece3/packages/contracts/src/orchestrationV2.ts)
- [WebSocket handlers and JSON transport](https://github.com/pingdotgg/t3code/blob/729c6ff9ac32a9e0a3d1e571705e72a94772ece3/apps/server/src/ws.ts)
- [Launch preparation and receipts](https://github.com/pingdotgg/t3code/blob/729c6ff9ac32a9e0a3d1e571705e72a94772ece3/apps/server/src/orchestration-v2/ThreadLaunchService.ts)
- [Native MCP authentication](https://github.com/pingdotgg/t3code/blob/729c6ff9ac32a9e0a3d1e571705e72a94772ece3/apps/server/src/mcp/McpHttpServer.ts)
- [Legacy migration](https://github.com/pingdotgg/t3code/blob/729c6ff9ac32a9e0a3d1e571705e72a94772ece3/docs/internals/legacy-orchestration-migration.md)
