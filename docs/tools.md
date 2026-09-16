# Tools and retry behavior

This branch supports v1 and the unreleased v2 protocol. The descriptions below retain v1 behavior; see [v2 tool behavior and rollout requirements](orchestration-v2.md#tool-behavior) for run IDs, delivery modes, bounded history, request capabilities, and journal cutover rules.

| Tool | Behavior |
| --- | --- |
| `list_environments` | Account-linked machine IDs and labels; optionally check availability. Default page: 10, maximum: 20. |
| `list_projects` | Projects and configured model defaults for one environment. Default page: 20, maximum: 50. |
| `list_threads` | Unarchived thread IDs, titles, status, attention flags, and turn timing. Optional `projectId` and `status` filters. Default page: 20, maximum: 50. |
| `start_thread` | Create a thread, then submit the first instructions. Requires environment, project, title, instructions, and a unique `operationId`. |
| `get_thread` | Current status, bounded recent messages/activity, provider errors, and approval/input flags. Supports turn pagination. |
| `send_message` | Send follow-up instructions, preserving the thread's model and runtime modes. Requires `operationId`. |
| `interrupt_thread` | Request interruption; records the target turn so retries cannot interrupt a later one. Requires `operationId`. |

Start by listing environments, then projects on the selected machine. Use IDs returned by those tools; project names are not unique across machines.

## Thread discovery and status

Use `list_threads` to find existing tasks before calling `get_thread`. A project filter is optional: omit it to list threads across the selected machine's projects. For example, to find tasks waiting for a reply:

```json
{
  "environmentId": "ID_FROM_LIST_ENVIRONMENTS",
  "status": "awaiting_input",
  "limit": 20
}
```

Each row includes `threadId`, `projectId`, `title`, `status`, the underlying `session` and `latestTurn`, approval/input flags, and available timestamps. Call `get_thread` with the same `environmentId` and a returned `threadId` to read the conversation. Listing does not fetch messages or launch work.

| Status | Meaning |
| --- | --- |
| `working` | The session/turn is running, or T3 reports live background work. |
| `connecting` | The provider session is starting. |
| `awaiting_approval` | T3 has a pending approval request. |
| `awaiting_input` | T3 has a pending user-input request. |
| `plan_ready` | A completed plan-mode turn has an actionable proposed plan. |
| `monitoring` | T3 reports background watch loops as the remaining live work. |
| `finished` | The latest turn completed with no higher-priority active or attention state. |
| `failed` | The current session or latest turn reports an error. |
| `interrupted` | The session/turn was interrupted and no live background work is reported. |
| `stopped` | The session stopped without a completed latest turn or live background work. |
| `idle` | No active work or completed latest turn is reported. |
| `unknown` | An upstream state is unrecognized, or `get_thread` cannot find a current thread summary. |

These are bridge-derived states based on T3's [thread/session contract](https://github.com/pingdotgg/t3code/blob/37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2/packages/contracts/src/orchestration.ts) and [sidebar status logic](https://github.com/pingdotgg/t3code/blob/37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2/apps/web/src/components/Sidebar.logic.ts). Approval takes priority over user input, and both take priority over running state. Both flags remain visible when both are pending. A newly running/starting session takes priority over an older turn's outcome. An old `lastError` on a ready session alone does not imply failure.

`finished` describes the latest turn's lifecycle, not whether the user's whole task succeeded. T3's UI can also account for client-specific read markers; this bridge does not track those. Optional plan/background fields may be unavailable on older servers. Answer approvals, input requests, and proposed plans in T3's existing client.

Results are sorted by the newest known activity timestamp, then thread ID. Filters apply before pagination; `total` counts matching threads and `nextOffset` identifies the next page. `scope: "unarchived"` makes the coverage explicit: archived threads are not discovered by this endpoint. An unknown project or unavailable environment produces an error, not an empty inventory.

Every call reads a fresh snapshot. `observedAt` records when the list was obtained; `snapshotSequence` identifies its T3 projection. Threads can change state or move between pages while you paginate. `get_thread` uses one shell snapshot for status, session, turn, and attention flags; `statusSnapshotSequence` identifies that snapshot. Its message history can come from a separate, earlier `snapshotSequence`.

## Starting a thread

Example `start_thread` arguments:

```json
{
  "operationId": "example-task-001",
  "environmentId": "ID_FROM_LIST_ENVIRONMENTS",
  "projectId": "ID_FROM_LIST_PROJECTS",
  "title": "Fix the failing parser test",
  "instructions": "Investigate the parser failure, make the smallest fix, and run its tests."
}
```

The tool uses the project's default model. If the project has none, supply `modelSelection`, for example `{ "instanceId": "your-configured-provider", "model": "your-model" }`. Optional provider options use T3's canonical array shape, such as `[{ "id": "effort", "value": "high" }]`; older object-shaped options are also accepted.

New threads default to `runtimeMode: "approval-required"` and `interactionMode: "default"`. Explicit runtime overrides are available. Follow-up messages preserve the existing thread modes. Approvals and human input are answered in T3's own clients.

**Launches run in the project's existing workspace** and can change files or consume provider usage. Worktree creation and setup scripts need the WebSocket bootstrap protocol and are not implemented. A project explicitly configured to default to worktrees is rejected. Global/client/t3.json worktree preferences are not resolved by this HTTP bridge.

### Acceptance and retries

An `accepted` result means T3 acknowledged the commands. It does not establish provider startup or completion. Follow it with `get_thread` and inspect `session`, `latestTurn`, and the waiting flags.

Keep the same `operationId` **and identical arguments** for retries. The bridge saves full command payloads and IDs before dispatch, then saves each acknowledged step. On a timeout, `operation_incomplete` includes the thread ID, command IDs, and stage. Inspect the thread and retry the original call. Changing arguments under an existing operation ID is rejected.

Tests cover responses lost after either launch command is accepted and recovery after restarting the bridge. This relies on T3 retaining its command receipts and the bridge retaining its journal. It is not a guarantee of exactly-once execution across database resets, lost journals, or future upstream changes. A new operation ID requests a new action.

`get_thread` requests five recent turns by default (maximum 20), returns at most 20 messages and 12 activities, and clips long text with a visible marker. `page` describes older turn history; `outputTruncated` describes additional output clipping. Waiting flags and `statusSnapshotSequence` are `null`, and `status` is `unknown`, when a thread is absent from the unarchived shell snapshot.
