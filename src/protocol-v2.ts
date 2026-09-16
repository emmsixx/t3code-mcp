import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as c from "./contracts.js";
import { BridgeError } from "./errors.js";
import type { Command, EnvironmentTransport, InterruptOptions, MessageOptions, Orchestration, RuntimeSummary, StartOptions, ThreadDetail, ThreadSummary } from "./orchestration.js";

// Narrow wire views of pingdotgg/t3code@729c6ff9ac32, contracts/orchestrationV2.ts.
// Effect's JSON codec encodes DateTimeUtc as ISO strings. Unknown fields stay remote.
const date = z.iso.datetime({ offset: true });
const thread = z.object({ id: c.id, projectId: c.id, title: z.string(), modelSelection: c.modelSelection,
  runtimeMode: c.runtimeMode, interactionMode: c.interactionMode,
  createdAt: date, updatedAt: date, archivedAt: date.nullable(), deletedAt: date.nullable(),
  historyOrigin: z.string().optional() });
const pendingRequest = z.object({ id: c.id, kind: z.string(), createdAt: date });
const shellThread = thread.extend({ status: z.string(), activeRunId: c.id.nullable(), latestRunId: c.id.nullable(),
  activityRunStatus: z.string().nullable().optional(), lastError: z.string().nullable().optional(),
  pendingRuntimeRequest: pendingRequest.nullable(), hasActionableProposedPlan: z.boolean(),
  latestUserMessageAt: date.nullable(),
  pendingBackgroundTasks: z.array(z.object({ taskId: c.id })).optional(),
});
const shellSchema = z.object({ schemaVersion: z.number().int().positive(), snapshotSequence: z.number().int().nonnegative(),
  projects: z.array(c.project), threads: z.array(shellThread) });
const run = z.object({ id: c.id, ordinal: z.number().int().positive(), status: z.string(), userMessageId: c.id });
const runtimeRequest = pendingRequest.extend({ status: z.string(),
  responseCapability: z.object({ type: z.string(), reason: z.string().optional() }) });
const item = z.object({ id: c.id, threadId: c.id, runId: c.id.nullable(), type: z.string(), status: z.string(),
  title: z.string().nullable(), startedAt: date.nullable(), updatedAt: date,
  messageId: c.id.optional(), text: z.string().optional(), markdown: z.string().optional(), streaming: z.boolean().optional(),
  input: z.unknown().optional(), prompt: z.string().optional(), summary: z.string().optional(),
  message: z.string().optional(), requestId: c.id.optional(), fileName: z.string().optional(),
  failure: z.object({ message: z.string() }).optional(),
});
const row = z.object({ position: z.number().int().nonnegative(), visibility: z.string(), sourceThreadId: c.id, sourceItemId: c.id, item });
const projection = z.object({ thread, runs: z.array(run), runtimeRequests: z.array(runtimeRequest), visibleTurnItems: z.array(row) });
const bounded = z.object({ snapshotSequence: z.number().int().nonnegative(), projection,
  historyCursor: z.string().nullable(), hasMoreHistory: z.boolean(), payloadBudgetExceeded: z.boolean().optional() });
const history = z.object({ snapshotSequence: z.number().int().nonnegative(), items: z.array(row),
  nextCursor: z.string().nullable(), hasMoreHistory: z.boolean() });
const launched = z.object({ threadId: c.id, projection: z.object({ thread: z.object({ id: c.id }), runs: z.array(run) }), resumed: z.boolean() });
const active = new Set(["preparing", "starting", "running", "waiting"]);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const approvals = new Set(["command", "file-read", "file-change", "mcp-elicitation"]);

function normalizeShell(t: z.infer<typeof shellThread>): ThreadSummary {
  return { ...t, session: null, latestTurn: null,
    hasPendingApprovals: t.pendingRuntimeRequest !== null && approvals.has(t.pendingRuntimeRequest.kind),
    hasPendingUserInput: t.pendingRuntimeRequest?.kind === "user_input",
    runtime: { status: t.status, activeRunId: t.activeRunId, latestRunId: t.latestRunId,
      activityRunStatus: t.activityRunStatus ?? null, lastError: t.lastError ?? null,
      pendingRequest: t.pendingRuntimeRequest, pendingBackgroundTaskCount: t.pendingBackgroundTasks?.length ?? 0,
      historyOrigin: t.historyOrigin ?? null } };
}

export class V2Orchestration implements Orchestration {
  readonly version = 2;
  constructor(private transport: EnvironmentTransport) {}
  async shell() {
    const result = await this.transport.request("/api/orchestration/shell", shellSchema);
    return { projects: result.projects, snapshotSequence: result.snapshotSequence,
      threads: result.threads.filter(t => !t.deletedAt).map(normalizeShell) };
  }
  private async snapshot(threadId: string) {
    const result = await this.transport.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, bounded);
    if (result.projection.thread.id !== threadId) throw new BridgeError("identity_mismatch", "The response names another thread.");
    return result;
  }
  async thread(threadId: string, _turnLimit = 5, beforeCursor?: string): Promise<ThreadDetail> {
    const snapshot = await this.snapshot(threadId);
    const p = snapshot.projection;
    const older = beforeCursor === undefined ? undefined : await this.transport.request(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}/history?${new URLSearchParams({ cursor: beforeCursor })}`, history);
    const rows = older?.items ?? p.visibleTurnItems;
    const messages = rows.filter(r => r.item.type === "user_message" || r.item.type === "assistant_message").map(r => ({
      id: r.item.messageId ?? r.item.id, role: r.item.type === "user_message" ? "user" as const : "assistant" as const,
      text: r.item.text ?? "", streaming: r.item.streaming ?? false, createdAt: r.item.startedAt ?? r.item.updatedAt,
    }));
    const activities = rows.filter(r => r.item.type !== "user_message" && r.item.type !== "assistant_message").map(r => ({
      id: r.item.id, kind: r.item.type, tone: r.item.status === "failed" ? "error" : "info",
      summary: r.item.failure?.message ?? r.item.title ?? r.item.summary ?? r.item.prompt ?? r.item.message ?? r.item.type,
      payload: r.item, createdAt: r.item.startedAt ?? r.item.updatedAt,
    }));
    const latest = [...p.runs].sort((a, b) => b.ordinal - a.ordinal)[0];
    const current = [...p.runs].filter(r => active.has(r.status)).sort((a, b) => b.ordinal - a.ordinal)[0];
    const requests = p.runtimeRequests.filter(r => r.status === "pending");
    const runtime: RuntimeSummary = { status: current?.status ?? latest?.status ?? "idle", activeRunId: current?.id ?? null,
      latestRunId: latest?.id ?? null, activityRunStatus: current?.status ?? null, lastError: null,
      pendingRequest: requests[0] ?? null, pendingBackgroundTaskCount: 0, historyOrigin: p.thread.historyOrigin ?? null };
    return { thread: { ...p.thread, session: null, latestTurn: null, runtime, messages, activities },
      snapshotSequence: older?.snapshotSequence ?? snapshot.snapshotSequence,
      page: { beforeCursor: older ? older.nextCursor : snapshot.historyCursor, hasMore: older ? older.hasMoreHistory : snapshot.hasMoreHistory },
      runtimeRequests: requests.slice(0, 12).map(({ id, kind, status, responseCapability }) => ({ id, kind, status, responseCapability })),
      runtimeRequestsSnapshotSequence: snapshot.snapshotSequence,
      runtimeRequestsTruncated: requests.length > 12, payloadBudgetExceeded: snapshot.payloadBudgetExceeded ?? false };
  }
  prepareStart(input: StartOptions) {
    const threadId = randomUUID();
    return { threadId, commands: [{ type: "orchestration.launchThread", commandId: randomUUID(), threadId,
      projectId: input.projectId, title: input.title, modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode, interactionMode: input.interactionMode, creationSource: "mcp",
      workspaceStrategy: { type: "root" }, initialMessage: { messageId: randomUUID(), text: input.instructions, attachments: [] } }] };
  }
  async prepareMessage(input: MessageOptions) {
    // The serialized server command selects the active run for auto delivery;
    // explicit steering/restart pins its target before journaling.
    let dispatchMode: Record<string, unknown> = { type: input.mode === "queue" ? "queue_after_active" : "start_immediately" };
    if (input.mode === "steer" || input.mode === "restart") {
      const snapshot = await this.snapshot(input.threadId);
      const current = snapshot.projection.runs.filter(r => r.status === "running").sort((a, b) => b.ordinal - a.ordinal)[0];
      if (!current) throw new BridgeError("no_active_run", "There is no running run to steer or restart.");
      dispatchMode = { type: input.mode === "steer" ? "steer_active" : "restart_active", targetRunId: current.id };
    }
    return { threadId: input.threadId, commands: [{ type: "message.dispatch", commandId: randomUUID(), threadId: input.threadId,
      messageId: randomUUID(), text: input.instructions, attachments: [], createdBy: "agent", creationSource: "mcp",
      ...(!input.mode || input.mode === "auto" ? { deliveryIntent: "auto" } : {}), dispatchMode }] };
  }
  async prepareInterrupt(input: InterruptOptions) {
    if (input.turnId !== undefined) throw new BridgeError("unsupported_feature", "Use runId on orchestration v2; v1 turn IDs cannot be translated.");
    const p = (await this.snapshot(input.threadId)).projection;
    const selected = input.runId ? p.runs.find(r => r.id === input.runId) :
      p.runs.filter(r => active.has(r.status)).sort((a, b) => b.ordinal - a.ordinal)[0];
    if (!selected) throw new BridgeError(input.runId ? "run_not_found" : "no_active_run", "No matching run is available to interrupt.");
    if (terminal.has(selected.status)) throw new BridgeError("run_already_terminal", "The selected run has already ended.");
    if (!active.has(selected.status)) throw new BridgeError("run_not_interruptible", "The selected run is not interruptible.");
    return { threadId: input.threadId, commands: [{ type: "run.interrupt", commandId: randomUUID(), threadId: input.threadId, runId: selected.id }] };
  }
  async execute(command: Command) {
    if (command.type === "orchestration.launchThread") {
      const { type: _type, ...payload } = command;
      const result = await this.transport.rpc("orchestration.launchThread", payload, launched);
      if (result.threadId !== command.threadId || result.projection.thread.id !== command.threadId) throw new BridgeError("identity_mismatch", "The launch response names another thread.");
      const messageId = (payload.initialMessage as { messageId: string }).messageId;
      const started = result.projection.runs.find(r => r.userMessageId === messageId);
      if (!started) throw new BridgeError("incompatible_response", "The launch response does not contain its initial run.");
      return { runId: started.id, resumed: result.resumed };
    }
    return this.transport.rpc("orchestration.dispatchCommand", command, c.dispatchResult);
  }
}
