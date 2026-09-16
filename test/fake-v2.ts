import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcServer, RpcSerialization } from "effect/unstable/rpc";
import type { FromClientEncoded } from "effect/unstable/rpc/RpcMessage";
import { fakeT3, type FakeHooks } from "./fake.js";

// Input subset pinned to T3 729c6ff9ac32; use the actual Effect JSON RPC server
// so request/exit encoding is not a second implementation of the client.
const model = Schema.Struct({ instanceId: Schema.String, model: Schema.String, options: Schema.optional(Schema.Unknown) });
const provenance = { createdBy: Schema.Literals(["user", "agent", "system"]), creationSource: Schema.Literals(["web", "mobile", "mcp", "provider", "server"]) };
const commands = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message.dispatch"), ...provenance, commandId: Schema.String, threadId: Schema.String,
    messageId: Schema.String, text: Schema.String, attachments: Schema.Array(Schema.Unknown),
    deliveryIntent: Schema.optional(Schema.Literals(["auto", "steer", "restart"])),
    dispatchMode: Schema.Union([
      Schema.Struct({ type: Schema.Literals(["start_immediately", "queue_after_active"]) }),
      Schema.Struct({ type: Schema.Literals(["steer_active", "restart_active"]), targetRunId: Schema.String }),
    ]) }),
  Schema.Struct({ type: Schema.Literal("run.interrupt"), commandId: Schema.String, threadId: Schema.String, runId: Schema.String }),
]);
const group = RpcGroup.make(
  Rpc.make("orchestration.launchThread", { payload: Schema.Struct({ commandId: Schema.String, threadId: Schema.String,
    projectId: Schema.String, title: Schema.String, modelSelection: model,
    runtimeMode: Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
    interactionMode: Schema.Literals(["default", "plan"]), creationSource: provenance.creationSource,
    workspaceStrategy: Schema.Struct({ type: Schema.Literal("root") }),
    initialMessage: Schema.Struct({ messageId: Schema.String, text: Schema.String, attachments: Schema.Array(Schema.Unknown) }) }),
    success: Schema.Unknown, error: Schema.Unknown }),
  Rpc.make("orchestration.dispatchCommand", { payload: commands, success: Schema.Struct({ sequence: Schema.Number }), error: Schema.Unknown }),
);
export const timestamp = "2026-09-16T12:00:00.000Z";

export async function fakeV2() {
  const hooks: FakeHooks = {};
  const f = await fakeT3(hooks);
  f.protocols.set("env-1", 2);
  const tickets = new Set<string>();
  const calls: { method: string; payload: any }[] = [];
  const outcomes = new Map<string, any>();
  const projections = new Map<string, any>();
  const histories = new Map<string, any>();
  const errors: unknown[] = [];
  const flags = { drop: "", failRpc: false, wrongLaunchThread: false, badSnapshot: false };
  let sequence = 0;

  function seed(id: string, changes: Record<string, unknown> = {}) {
    const shell = { id, projectId: "project-1", title: "V2 task", modelSelection: f.model,
      runtimeMode: "approval-required", interactionMode: "default", createdAt: timestamp, updatedAt: timestamp,
      archivedAt: null, deletedAt: null, status: "idle", activeRunId: null, latestRunId: null, pendingRuntimeRequest: null,
      latestUserMessageAt: null, hasActionableProposedPlan: false, pendingBackgroundTasks: [], ...changes };
    f.threads.set(id, shell);
    projections.set(id, { thread: { ...shell }, runs: [], runtimeRequests: [], visibleTurnItems: [] });
    return shell;
  }
  function message(threadId: string, messageId: string, text: string, status = "running") {
    const p = projections.get(threadId); assert.ok(p);
    const run = { id: `run-${++sequence}`, ordinal: p.runs.length + 1, status, userMessageId: messageId };
    p.runs.push(run);
    p.visibleTurnItems.push({ position: p.visibleTurnItems.length, visibility: "local", sourceThreadId: threadId, sourceItemId: messageId,
      item: { id: messageId, threadId, runId: run.id, type: "user_message", status: "completed", title: null,
        startedAt: timestamp, updatedAt: timestamp, messageId, text } });
    Object.assign(f.threads.get(threadId), { latestRunId: run.id, activeRunId: status === "queued" ? null : run.id, status });
    return run;
  }
  hooks.environment = ({ req, url, environmentId, respond }) => {
    if (f.protocols.get(environmentId) !== 2) return false;
    if (url.pathname === "/api/auth/websocket-ticket") {
      const ticket = `test-ticket-${sequence}-${tickets.size}`; tickets.add(ticket); respond({ ticket, expiresAt: timestamp }); return true;
    }
    assert.equal(req.headers["x-t3-orchestration-protocol"], "2");
    if (url.pathname === "/api/orchestration/shell") {
      respond({ schemaVersion: 2, snapshotSequence: sequence, projects: f.projects,
        threads: [...f.threads.values()].filter(t => !t.archivedAt), archivedThreads: [] }); return true;
    }
    const parts = url.pathname.split("/");
    const id = decodeURIComponent(parts[4]!);
    const p = projections.get(id);
    if (!p) { respond({ code: "thread_not_found" }, 404); return true; }
    if (url.pathname.endsWith("/bounded")) {
      respond({ snapshotSequence: sequence, projection: flags.badSnapshot ? { ...p, thread: { ...p.thread, id: "wrong" } } : p,
        historyCursor: "older-v2", hasMoreHistory: true, latestLocalTurnOrdinal: p.runs.length }); return true;
    }
    if (url.pathname.endsWith("/history")) {
      assert.equal(url.searchParams.get("cursor"), "older-v2");
      respond({ snapshotSequence: sequence, items: histories.get(id) ?? [], nextCursor: null, hasMoreHistory: false }); return true;
    }
    assert.fail(`Unexpected v2 HTTP endpoint ${url.pathname}`);
  };
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<number, WebSocket>();
  const input = await Effect.runPromise(Queue.unbounded<[number, FromClientEncoded]>());
  const disconnects = await Effect.runPromise(Queue.unbounded<number>());
  let clientId = 0;
  f.server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url!, f.config.relayOrigin);
      assert.equal(url.pathname, "/ws"); assert.equal(url.searchParams.get("orchestrationProtocol"), "2");
      assert.ok(tickets.delete(url.searchParams.get("wsTicket")!));
      wss.handleUpgrade(req, socket, head, ws => {
        const id = ++clientId; sockets.set(id, ws);
        ws.on("message", data => {
          try {
            const frames = RpcSerialization.json.makeUnsafe().decode(data.toString());
            for (const frame of frames) void Effect.runPromise(Queue.offer(input, [id, frame as FromClientEncoded]));
          } catch (error) { errors.push(error); ws.terminate(); }
        });
        ws.on("close", () => { sockets.delete(id); void Effect.runPromise(Queue.offer(disconnects, id)); });
      });
    } catch (error) { errors.push(error); socket.destroy(); }
  });
  const handle = (method: string, payload: any) => Effect.try({ try: () => {
    calls.push({ method, payload });
    if (flags.failRpc) throw new Error("SECRET upstream RPC error");
    const prior = outcomes.get(payload.commandId);
    if (prior) return method === "orchestration.launchThread" ? { ...prior, resumed: true } : prior;
    let result;
    if (method === "orchestration.launchThread") {
      assert.equal(payload.projectId, "project-1"); assert.equal(payload.workspaceStrategy.type, "root");
      seed(payload.threadId, { title: payload.title, modelSelection: payload.modelSelection, runtimeMode: payload.runtimeMode, interactionMode: payload.interactionMode });
      message(payload.threadId, payload.initialMessage.messageId, payload.initialMessage.text);
      result = { threadId: flags.wrongLaunchThread ? "wrong" : payload.threadId, projection: structuredClone(projections.get(payload.threadId)), resumed: false };
    } else if (payload.type === "message.dispatch") {
      const shell = f.threads.get(payload.threadId); assert.ok(shell);
      if (payload.dispatchMode.type === "steer_active" || payload.dispatchMode.type === "restart_active") {
        assert.ok(projections.get(payload.threadId).runs.some((r: any) => r.id === payload.dispatchMode.targetRunId));
      }
      message(payload.threadId, payload.messageId, payload.text, payload.dispatchMode.type === "queue_after_active" ? "queued" : "running");
      result = { sequence: ++sequence };
    } else {
      const run = projections.get(payload.threadId).runs.find((r: any) => r.id === payload.runId); assert.ok(run);
      run.status = "interrupted";
      Object.assign(f.threads.get(payload.threadId), { status: "interrupted", activeRunId: null });
      result = { sequence: ++sequence };
    }
    outcomes.set(payload.commandId, result);
    return result;
  }, catch: error => {
    if (!flags.failRpc) errors.push(error);
    return { _tag: "OrchestrationV2DispatchCommandError", message: "SECRET" };
  } });
  const protocol = RpcServer.Protocol.of({
    run: receive => Effect.forever(Effect.flatMap(Queue.take(input), ([id, frame]) => receive(id, frame))),
    disconnects,
    send: (id, response) => Effect.sync(() => {
      const socket = sockets.get(id);
      if (!socket) return;
      const last = calls.at(-1);
      if (flags.drop && (last?.method === flags.drop || last?.payload.type === flags.drop)) { flags.drop = ""; socket.terminate(); return; }
      socket.send(RpcSerialization.json.makeUnsafe().encode(response) as string);
    }),
    end: id => Effect.sync(() => sockets.get(id)?.close()),
    clientIds: Effect.sync(() => new Set(sockets.keys())), initialMessage: Effect.succeedNone,
    supportsAck: false, supportsTransferables: false, supportsSpanPropagation: false, supportsNotifications: false,
    codecFor: RpcSerialization.json.codecFor,
  });
  const fiber = Effect.runFork(RpcServer.make(group).pipe(
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.provide(group.toLayer({
      "orchestration.launchThread": p => handle("orchestration.launchThread", p),
      "orchestration.dispatchCommand": p => handle("orchestration.dispatchCommand", p),
    })),
  ));
  const close = async () => {
    for (const socket of sockets.values()) socket.terminate();
    wss.close(); await Effect.runPromise(Fiber.interrupt(fiber)); await f.close(); assert.deepEqual(errors, []);
  };
  return { ...f, close, calls, outcomes, projections, histories, v2Flags: flags, seed, message };
}
