import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Bridge, startInput, messageInput, interruptInput, listThreadsInput } from "../src/bridge.js";
import { fakeV2, timestamp } from "./fake-v2.js";
import { fakeT3 } from "./fake.js";
import { Http } from "../src/http.js";

const launch = () => startInput.parse({ operationId: "launch-v2", environmentId: "env-1", projectId: "project-1", title: "Implement change", instructions: "Update the example." });
const list = (extra = {}) => listThreadsInput.parse({ environmentId: "env-1", ...extra });
const read = (threadId: string, extra = {}) => ({ environmentId: "env-1", threadId, turnLimit: 5, ...extra });

test("v2 launch survives a lost Effect RPC response and bridge restart without duplicate work", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login();
  f.v2Flags.drop = "orchestration.launchThread";
  let threadId = "";
  await assert.rejects(f.bridge.startThread(launch()), (e: any) => {
    threadId = e.details.threadId;
    return e.code === "operation_incomplete" && e.details.confirmedCommands === 0;
  });
  assert.equal(f.threads.size, 1); assert.equal(f.projections.get(threadId).runs.length, 1);
  const state = JSON.parse(await readFile(join(f.config.stateDir, "state.json"), "utf8"));
  assert.equal(state.version, 2);
  assert.equal(Object.values<any>(state.operations)[0].protocolVersion, 2);
  const restarted = new Bridge(f.config);
  const result = await restarted.startThread(launch());
  assert.equal(result.threadId, threadId); assert.equal(result.protocolVersion, 2);
  assert.deepEqual(result.results, [{ runId: "run-1", resumed: true }]);
  assert.deepEqual(f.calls[0]!.payload, f.calls[1]!.payload);
  assert.equal(f.outcomes.size, 1); assert.equal(f.projections.get(threadId).runs.length, 1);
  const count = f.requests.length;
  assert.deepEqual(await restarted.startThread(launch()), result);
  assert.equal(f.requests.length, count);
  await assert.rejects(restarted.startThread({ ...launch(), instructions: "Changed" }), { code: "operation_conflict" });
  assert.ok(!f.requests.some(r => r.path === "/api/orchestration/dispatch"));
  const saved = await readFile(join(f.config.stateDir, "state.json"), "utf8");
  assert.ok(!saved.includes("test-ticket-") && !saved.includes("env-token-"));
});

test("v2 follow-up delivery modes preserve IDs on retry and interruption pins the original run", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login();
  const { threadId } = await f.bridge.startThread(launch());
  for (const mode of [undefined, "queue", "steer", "restart"] as const) {
    const input = messageInput.parse({ operationId: `message-${mode}`, environmentId: "env-1", threadId, instructions: "Continue", ...(mode ? { mode } : {}) });
    f.v2Flags.drop = "message.dispatch";
    await assert.rejects(f.bridge.sendMessage(input), { code: "operation_incomplete" });
    const count = f.projections.get(threadId).runs.length;
    await new Bridge(f.config).sendMessage(input);
    assert.equal(f.projections.get(threadId).runs.length, count);
    assert.deepEqual(f.calls.at(-2)!.payload, f.calls.at(-1)!.payload);
    const payload = f.calls.at(-1)!.payload;
    assert.equal(payload.modelSelection, undefined); assert.equal(payload.runtimeMode, undefined);
    if (!mode) assert.equal(payload.deliveryIntent, "auto");
    else assert.equal(payload.dispatchMode.type, { queue: "queue_after_active", steer: "steer_active", restart: "restart_active" }[mode]);
  }
  const p = f.projections.get(threadId);
  const original = p.runs.at(-1).id;
  const args = interruptInput.parse({ operationId: "interrupt-v2", environmentId: "env-1", threadId });
  f.v2Flags.drop = "run.interrupt";
  await assert.rejects(f.bridge.interruptThread(args), { code: "operation_incomplete" });
  const later = f.message(threadId, "later-message", "Later work");
  await new Bridge(f.config).interruptThread(args);
  assert.equal(f.calls.at(-1)!.payload.runId, original);
  assert.equal(later.status, "running");
  await assert.rejects(f.bridge.interruptThread({ ...args, operationId: "old-turn", turnId: "v1-turn" }), { code: "unsupported_feature" });
  await assert.rejects(f.bridge.interruptThread({ ...args, operationId: "missing-run", runId: "missing" }), { code: "run_not_found" });
  await assert.rejects(f.bridge.interruptThread({ ...args, operationId: "terminal-run", runId: original }), { code: "run_already_terminal" });
});

test("v2 status uses authoritative run, request and background state without synthetic v1 sessions", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login();
  const request = (kind: string) => ({ id: "request-1", kind, createdAt: timestamp });
  const cases: [string, Record<string, unknown>, string][] = [
    ["preparing", { status: "preparing" }, "preparing"], ["starting", { status: "starting" }, "connecting"],
    ["queued", { status: "queued" }, "queued"], ["running", { status: "running" }, "working"],
    ["waiting", { status: "waiting" }, "waiting"], ["completed", { status: "completed" }, "finished"],
    ["failed", { status: "failed", lastError: "Provider failed" }, "failed"],
    ["cancelled", { status: "cancelled" }, "cancelled"], ["rollback", { status: "rolled_back" }, "rolled_back"],
    ["approval", { status: "running", pendingRuntimeRequest: request("file-read") }, "awaiting_approval"],
    ["input", { pendingRuntimeRequest: request("user_input") }, "awaiting_input"],
    ["auth", { pendingRuntimeRequest: request("auth_refresh") }, "waiting"],
    ["future-request", { pendingRuntimeRequest: request("future") }, "waiting"],
    ["plan", { status: "completed", interactionMode: "plan", hasActionableProposedPlan: true }, "plan_ready"],
    ["background", { status: "completed", pendingBackgroundTasks: [{ taskId: "task-1" }] }, "waiting"],
    ["active-before-queue", { status: "queued", activityRunStatus: "running" }, "working"],
    ["future", { status: "future" }, "unknown"],
  ];
  for (const [id, changes] of cases) f.seed(id, changes);
  f.seed("archived", { archivedAt: timestamp }); f.seed("deleted", { deletedAt: timestamp });
  const result = await f.bridge.listThreads(list({ limit: 50 }));
  assert.equal(result.protocolVersion, 2); assert.equal(result.total, cases.length);
  for (const [id, , expected] of cases) {
    const row = result.threads.find(r => r.threadId === id)!;
    assert.equal(row.status, expected, id); assert.equal(row.session, null); assert.equal(row.latestTurn, null);
  }
  assert.equal(result.threads.find(r => r.threadId === "failed")!.runtime?.lastError, "Provider failed");
  assert.equal((await f.bridge.listThreads(list({ status: "waiting" }))).total, 4);
  assert.equal((await f.bridge.listThreads(list({ limit: 1 }))).nextOffset, 1);
  assert.equal(f.calls.length, 0);
});

test("v2 bounded timeline reads include inherited history and expose non-resumable requests", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login();
  f.seed("thread-1", { status: "waiting", historyOrigin: "v1_import", pendingRuntimeRequest: { id: "request-1", kind: "user_input", createdAt: timestamp } });
  f.message("thread-1", "message-1", "Current message");
  const p = f.projections.get("thread-1");
  const base = p.visibleTurnItems[0];
  p.visibleTurnItems.push({ ...base, position: 1, item: { ...base.item, id: "assistant-1", type: "assistant_message", messageId: "assistant-1", text: "x".repeat(5000), streaming: true } });
  p.visibleTurnItems.push({ ...base, position: 2, item: { ...base.item, id: "error-1", type: "error", failure: { message: "Provider disconnected" }, status: "failed" } });
  p.runtimeRequests.push({ id: "request-1", kind: "user_input", status: "pending", createdAt: timestamp,
    responseCapability: { type: "not_resumable", reason: "Provider session ended" } });
  const result = await f.bridge.getThread(read("thread-1"));
  assert.equal(result.waitingForInput, true); assert.equal(result.runtime?.historyOrigin, "v1_import");
  assert.equal(result.messages.length, 2); assert.ok(result.messages[1]!.text.endsWith("[truncated]"));
  assert.equal(result.activities[0]!.summary, "Provider disconnected"); assert.equal(result.outputTruncated, true);
  assert.equal(result.runtimeRequests?.[0]?.responseCapability.type, "not_resumable");
  assert.equal(result.page?.beforeCursor, "older-v2");
  f.histories.set("thread-1", [{ ...base, sourceThreadId: "parent-thread", visibility: "inherited", item: { ...base.item, text: "Inherited message" } }]);
  const older = await f.bridge.getThread(read("thread-1", { beforeCursor: result.page!.beforeCursor! }));
  assert.equal(older.messages[0]!.text, "Inherited message"); assert.equal(older.page?.hasMore, false);
  assert.ok(f.requests.some(r => r.path.endsWith("/bounded"))); assert.ok(f.requests.some(r => r.path.endsWith("/history")));
  f.v2Flags.badSnapshot = true;
  await assert.rejects(f.bridge.getThread(read("thread-1")), { code: "identity_mismatch" });
});

test("protocol detection supports mixed environments and rejects future versions before dispatch", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login(); f.flags.secondMachine = true;
  assert.equal((await f.bridge.listThreads(list())).protocolVersion, 2);
  assert.equal((await f.bridge.listThreads(list({ environmentId: "env-2" }))).protocolVersion, 1);
  f.protocols.set("env-2", 2);
  assert.equal((await f.bridge.listThreads(list({ environmentId: "env-2" }))).protocolVersion, 2);
  f.protocols.set("env-1", 3);
  await assert.rejects(f.bridge.startThread(launch()), { code: "unsupported_protocol" });
  assert.equal(f.calls.length, 0);
});

test("unfinished legacy journal entries stop at a protocol upgrade without translating commands", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login(); f.flags.dropCommand = "thread.turn.start";
  await assert.rejects(f.bridge.startThread(launch()), { code: "operation_incomplete" });
  await f.bridge.store.locked(async (state, save) => {
    for (const operation of Object.values(state.operations)) delete operation.protocolVersion;
    await save();
  });
  const before = JSON.parse(await readFile(join(f.config.stateDir, "state.json"), "utf8")).operations;
  const count = f.requests.filter(r => r.path.endsWith("/dispatch")).length;
  f.protocols.set("env-1", 2);
  await assert.rejects(new Bridge(f.config).startThread(launch()), { code: "operation_protocol_changed" });
  assert.equal(f.requests.filter(r => r.path.endsWith("/dispatch")).length, count);
  assert.deepEqual(JSON.parse(await readFile(join(f.config.stateDir, "state.json"), "utf8")).operations, before);
});

test("v2 unfinished operations also stop on downgrade, while completed receipts remain readable offline", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login(); f.v2Flags.drop = "orchestration.launchThread";
  await assert.rejects(f.bridge.startThread(launch()), { code: "operation_incomplete" });
  f.protocols.set("env-1", undefined);
  await assert.rejects(f.bridge.startThread(launch()), { code: "operation_protocol_changed" });
  assert.equal(f.calls.length, 1);
  f.protocols.set("env-1", 2);
  const result = await f.bridge.startThread(launch());
  f.flags.rejectEnvironment = true;
  assert.deepEqual(await new Bridge(f.config).startThread(launch()), result);
});

test("RPC failures and mismatched launch results stay ambiguous and never leak raw upstream errors", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login(); f.v2Flags.failRpc = true;
  await assert.rejects(f.bridge.startThread(launch()), (error: any) => {
    assert.equal(error.code, "operation_incomplete"); assert.equal(error.details.cause.code, "rpc_error");
    assert.ok(!JSON.stringify(error).includes("SECRET")); return true;
  });
  f.v2Flags.failRpc = false; f.v2Flags.wrongLaunchThread = true;
  await assert.rejects(f.bridge.startThread(launch()), (error: any) => error.details.cause.code === "identity_mismatch");
  assert.equal(f.threads.size, 1);
});

test("bad descriptors and unrelated WebSocket endpoints fail before any mutation or ticket issuance", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login();
  for (const scenario of ["wrong-descriptor", "malformed-descriptor", "unavailable-descriptor", "wrong-websocket"]) {
    const http = new Http(async (url, init) => {
      const response = await fetch(url, init);
      const path = new URL(String(url)).pathname;
      if (path === "/.well-known/t3/environment") {
        if (scenario === "wrong-descriptor") return Response.json({ environmentId: "other", orchestrationProtocolVersion: 2 });
        if (scenario === "malformed-descriptor") return Response.json({ environmentId: "env-1", orchestrationProtocolVersion: "2" });
        if (scenario === "unavailable-descriptor") return Response.json({ code: "unavailable" }, { status: 503 });
      }
      if (scenario === "wrong-websocket" && (path === "/v1/environments" || path.endsWith("/connect"))) {
        const body = await response.json();
        if (body.environments) body.environments[0].endpoint.wsBaseUrl = "wss://unrelated.example.test/ws";
        else body.endpoint.wsBaseUrl = "wss://unrelated.example.test/ws";
        return Response.json(body);
      }
      return response;
    });
    const bridge = new Bridge(f.config, undefined, http);
    await assert.rejects(bridge.startThread({ ...launch(), operationId: scenario }), (error: any) =>
      ["identity_mismatch", "incompatible_response", "http_error"].includes(error.code));
  }
  assert.equal(f.calls.length, 0);
  assert.ok(!f.requests.some(r => r.path === "/api/auth/websocket-ticket" || r.path.endsWith("/dispatch")));
});
