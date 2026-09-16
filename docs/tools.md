# Tools and retry behavior

| Tool | Behavior |
| --- | --- |
| `list_environments` | Account-linked machine IDs and labels; optionally check availability. Default page: 10, maximum: 20. |
| `list_projects` | Projects and configured model defaults for one environment. Default page: 20, maximum: 50. |
| `start_thread` | Create a thread, then submit the first instructions. Requires environment, project, title, instructions, and a unique `operationId`. |
| `get_thread` | Bounded recent messages/activity, provider errors, and current approval/input flags. Supports turn pagination. |
| `send_message` | Send follow-up instructions, preserving the thread's model and runtime modes. Requires `operationId`. |
| `interrupt_thread` | Request interruption; records the target turn so retries cannot interrupt a later one. Requires `operationId`. |

Start by listing environments, then projects on the selected machine. Use IDs returned by those tools; project names are not unique across machines.

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

`get_thread` requests five recent turns by default (maximum 20), returns at most 20 messages and 12 activities, and clips long text with a visible marker. `page` describes older turn history; `outputTruncated` describes additional output clipping. Waiting flags are `null` when a thread is absent from the active shell snapshot, rather than implying no pending requests.
