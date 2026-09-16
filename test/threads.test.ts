import test from "node:test";
import assert from "node:assert/strict";
import { listThreadsInput } from "../src/bridge.js";
import { fakeT3 } from "./fake.js";

type Fake = Awaited<ReturnType<typeof fakeT3>>;
const date = "2026-09-16T12:00:00.000Z";
const session = (status: string, lastError: string | null = null) => ({ status, activeTurnId: status === "running" ? "turn-1" : null, lastError });
const turn = (state: string) => ({ turnId: "turn-1", state, requestedAt: date, startedAt: date, completedAt: state === "completed" ? date : null });
function seed(f: Fake, id: string, changes: Record<string, unknown> = {}) {
  const thread = { id, projectId: "project-1", title: `Task ${id}`, modelSelection: f.model, runtimeMode: "approval-required", interactionMode: "default",
    session: null, latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false,
    messages: [], activities: [], ...changes };
  f.threads.set(id, thread);
  return thread;
}
const input = (changes = {}) => listThreadsInput.parse({ environmentId: "env-1", ...changes });

test("thread discovery reads existing tasks and provides IDs that open their messages", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  seed(f, "existing-thread", { title: "Investigate the parser", session: session("running"), latestTurn: turn("running"),
    messages: [{ id: "message-1", role: "assistant", text: "Checking the parser now.", streaming: true, createdAt: date }] });
  const result = await f.bridge.listThreads(input());
  assert.equal(result.total, 1); assert.equal(result.nextOffset, null); assert.equal(result.scope, "unarchived");
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  const found = result.threads[0]!;
  assert.equal(found.threadId, "existing-thread"); assert.equal(found.title, "Investigate the parser");
  assert.equal(found.status, "working"); assert.equal(found.waitingForApproval, false);
  assert.equal("messages" in found, false);
  assert.equal(f.requests.filter(r => r.path.startsWith("/api/orchestration/")).length, 1);
  const detail = await f.bridge.getThread({ environmentId: result.environmentId, threadId: found.threadId, turnLimit: 5 });
  assert.equal(detail.status, "working"); assert.equal(detail.messages[0]!.text, "Checking the parser now.");
  assert.equal(f.receipts.size, 0);
  assert.ok(!f.requests.some(r => r.path.endsWith("/dispatch")));
});

test("status summaries distinguish human attention, completion, errors and background work", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  const cases: [string, Record<string, unknown>, string][] = [
    ["both-blockers", { session: session("running"), hasPendingApprovals: true, hasPendingUserInput: true }, "awaiting_approval"],
    ["input", { session: session("running"), hasPendingUserInput: true }, "awaiting_input"],
    ["connecting", { session: session("starting"), latestTurn: turn("error") }, "connecting"],
    ["new-turn", { session: session("running"), latestTurn: turn("completed") }, "working"],
    ["turn-starting", { latestTurn: turn("running") }, "working"],
    ["finished", { session: session("ready"), latestTurn: turn("completed") }, "finished"],
    ["old-error", { session: session("ready", "An earlier error"), latestTurn: turn("completed") }, "finished"],
    ["no-turn", { session: session("ready") }, "idle"],
    ["no-session", {}, "idle"],
    ["failed", { session: session("error", "Provider failed"), latestTurn: turn("completed"), backgroundLiveness: "working" }, "failed"],
    ["failed-turn", { session: session("ready"), latestTurn: turn("error") }, "failed"],
    ["interrupted", { session: session("interrupted"), latestTurn: turn("running") }, "interrupted"],
    ["interrupted-turn", { latestTurn: turn("interrupted") }, "interrupted"],
    ["stopped", { session: session("stopped"), latestTurn: turn("running") }, "stopped"],
    ["stopped-after-completion", { session: session("stopped"), latestTurn: turn("completed") }, "finished"],
    ["plan", { interactionMode: "plan", hasActionableProposedPlan: true, latestTurn: turn("completed") }, "plan_ready"],
    ["background", { latestTurn: turn("completed"), backgroundLiveness: "working" }, "working"],
    ["background-after-interrupt", { session: session("interrupted"), latestTurn: turn("interrupted"), backgroundLiveness: "working" }, "working"],
    ["monitoring", { latestTurn: turn("completed"), backgroundLiveness: "monitoring" }, "monitoring"],
    ["future-session", { session: session("future-status"), latestTurn: turn("completed") }, "unknown"],
    ["empty-session-state", { session: session(""), latestTurn: turn("completed") }, "unknown"],
    ["future-turn", { latestTurn: turn("future-state") }, "unknown"],
    ["future-background", { latestTurn: turn("completed"), backgroundLiveness: "future-state" }, "unknown"],
  ];
  for (const [id, changes] of cases) seed(f, id, changes);
  const rows = (await f.bridge.listThreads(input({ limit: 50 }))).threads;
  for (const [id, , expected] of cases) assert.equal(rows.find(t => t.threadId === id)!.status, expected, id);
  assert.equal(rows.find(t => t.threadId === "both-blockers")!.waitingForInput, true);
  assert.match(rows.find(t => t.threadId === "plan")!.action!, /T3/);
  assert.equal(rows.find(t => t.threadId === "no-session")!.createdAt, null);
});

test("project and status filters apply before stable pagination and exclude archived threads", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  f.projects.push({ ...f.project, id: "project-2" });
  seed(f, "b", { session: session("running"), updatedAt: date });
  seed(f, "a", { session: session("running"), updatedAt: date });
  seed(f, "older", { session: session("running"), updatedAt: "invalid date", createdAt: "2026-09-15T12:00:00Z" });
  seed(f, "no-date", { session: session("running") });
  seed(f, "new-message", { session: session("running"), createdAt: date, latestUserMessageAt: "2026-09-16T13:00:00Z" });
  seed(f, "other-project", { projectId: "project-2", session: session("running") });
  seed(f, "finished", { latestTurn: turn("completed") });
  seed(f, "archived", { archivedAt: date, latestTurn: turn("completed") });
  const filter = { projectId: "project-1", status: "working", limit: 2 };
  const first = await f.bridge.listThreads(input(filter));
  assert.equal(first.total, 5); assert.equal(first.nextOffset, 2);
  assert.deepEqual(first.threads.map(t => t.threadId), ["new-message", "a"]);
  const second = await f.bridge.listThreads(input({ ...filter, offset: first.nextOffset }));
  assert.deepEqual(second.threads.map(t => t.threadId), ["b", "older"]); assert.equal(second.nextOffset, 4);
  const third = await f.bridge.listThreads(input({ ...filter, offset: second.nextOffset }));
  assert.deepEqual(third.threads.map(t => t.threadId), ["no-date"]); assert.equal(third.nextOffset, null);
  assert.equal((await f.bridge.listThreads(input())).total, 7);
  assert.equal((await f.bridge.listThreads(input({ offset: 50 }))).nextOffset, null);
  assert.equal((await f.bridge.listThreads(input({ status: "awaiting_input" }))).total, 0);
  await assert.rejects(f.bridge.listThreads(input({ projectId: "missing" })), { code: "project_not_found" });
});

test("get_thread uses a single current status snapshot even when message history is older", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  const current = seed(f, "changing", { title: "Current title", session: session("ready"), latestTurn: turn("completed"), hasPendingUserInput: true });
  f.threadDetails.set("changing", { ...current, title: "Old title", session: session("running"), latestTurn: turn("running") });
  f.flags.shellSnapshotSequence = 10;
  const detail = await f.bridge.getThread({ environmentId: "env-1", threadId: "changing", turnLimit: 5 });
  assert.equal(detail.status, "awaiting_input"); assert.equal(detail.title, "Current title");
  assert.equal(detail.session?.status, "ready"); assert.equal(detail.latestTurn?.state, "completed");
  assert.equal(detail.snapshotSequence, 0); assert.equal(detail.statusSnapshotSequence, 10);
  f.threads.get("changing").archivedAt = date;
  const archived = await f.bridge.getThread({ environmentId: "env-1", threadId: "changing", turnLimit: 5 });
  assert.equal(archived.status, "unknown"); assert.equal(archived.statusSnapshotSequence, null);
  assert.equal(archived.waitingForInput, null); assert.equal(archived.waitingForApproval, null);
});

test("listing bounds text and fails on unavailable environments instead of reporting an empty list", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  seed(f, "long", { title: "x".repeat(5000), session: session("error", "y".repeat(5000)) });
  const [row] = (await f.bridge.listThreads(input())).threads;
  assert.ok(row!.title.length < 250); assert.ok(row!.session!.lastError!.length < 2050);
  await assert.rejects(f.bridge.listThreads(input({ environmentId: "not-linked" })), { code: "environment_not_found" });
  f.flags.rejectEnvironment = true;
  await assert.rejects(f.bridge.listThreads(input()), { code: "auth_required" });
  assert.equal(f.receipts.size, 0);
});
