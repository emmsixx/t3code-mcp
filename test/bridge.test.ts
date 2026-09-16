import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Bridge, startInput, messageInput, interruptInput } from "../src/bridge.js";
import { ClerkAuth } from "../src/auth.js";
import { fakeT3 } from "./fake.js";

const launch = () => startInput.parse({ operationId: "launch-1", environmentId: "env-1", projectId: "project-1", title: "Implement change", instructions: "Update the example." });

test("account login rotates native credentials, handles TOTP, persists securely, and discovers multiple machines", async t => {
  const f = await fakeT3(); t.after(f.close); f.flags.secondFactor = true; f.flags.secondMachine = true;
  await f.login();
  const result = await f.bridge.listEnvironments({ offset: 0, limit: 20, checkAvailability: true });
  assert.equal(result.environments.length, 2); assert.equal(result.environments[0]!.status, "online");
  assert.equal(result.environments[1]!.environmentId, "env-2");
  const statePath = join(f.config.stateDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.auth.accountId, "user_fake"); assert.equal(state.auth.sessionId, "sess_fake");
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(f.config.stateDir)).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(result).includes("native-client"));
});

test("lost create response resumes after restart using original commands and sends only one first message", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login(); f.flags.dropCommand = "thread.create";
  let threadId = "";
  await assert.rejects(f.bridge.startThread(launch()), (e: any) => { threadId = e.details.threadId; return e.code === "operation_incomplete" && e.details.confirmedCommands === 0; });
  assert.equal(f.threads.size, 1); assert.equal(f.threads.get(threadId).messages.length, 0);
  const restarted = new Bridge(f.config);
  const result = await restarted.startThread(launch());
  assert.equal(result.threadId, threadId); assert.equal(result.status, "accepted");
  assert.equal(f.receipts.size, 2); assert.equal(f.threads.size, 1); assert.equal(f.threads.get(threadId).messages.length, 1);
  const creates = f.requests.filter(r => r.body.type === "thread.create");
  assert.deepEqual(creates[0]!.body, creates[1]!.body);
  const count = f.requests.length;
  await restarted.startThread(launch()); assert.equal(f.requests.length, count);
  await assert.rejects(restarted.startThread({ ...launch(), instructions: "Changed" }), { code: "operation_conflict" });
});

test("lost turn response does not duplicate a turn; follow-ups preserve runtime and model; interrupts pin a turn", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login(); f.flags.dropCommand = "thread.turn.start";
  await assert.rejects(f.bridge.startThread(launch()), { code: "operation_incomplete" });
  const started = await f.bridge.startThread(launch());
  const thread = f.threads.get(started.threadId);
  assert.equal(thread.messages.length, 1);
  thread.runtimeMode = "auto-accept-edits"; thread.interactionMode = "plan";
  await f.bridge.sendMessage(messageInput.parse({ operationId: "follow-1", environmentId: "env-1", threadId: started.threadId, instructions: "Follow-up" }));
  const messages = f.requests.filter(r => r.body.type === "thread.turn.start");
  assert.equal(messages.at(-1)!.body.runtimeMode, "auto-accept-edits"); assert.equal(messages.at(-1)!.body.interactionMode, "plan");
  assert.equal(thread.messages.length, 2);
  f.flags.dropCommand = "thread.turn.interrupt";
  const args = interruptInput.parse({ operationId: "stop-1", environmentId: "env-1", threadId: started.threadId });
  const targetTurn = thread.session.activeTurnId;
  await assert.rejects(f.bridge.interruptThread(args), { code: "operation_incomplete" });
  thread.session.activeTurnId = "later-turn";
  await f.bridge.interruptThread(args);
  const interrupts = f.requests.filter(r => r.body.type === "thread.turn.interrupt");
  assert.equal(interrupts.at(-1)!.body.turnId, targetTurn);
});

test("bounded reads expose provider failures and unresolved approval/input states", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  const { threadId } = await f.bridge.startThread(launch());
  const thread = f.threads.get(threadId);
  thread.session = { status: "error", activeTurnId: null, lastError: "Provider unavailable" };
  thread.hasPendingApprovals = true; thread.hasPendingUserInput = true;
  thread.messages.push(...Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, role: "assistant", text: "x".repeat(5000), streaming: false, createdAt: "2026-09-15T00:00:00Z" })));
  thread.activities.push({ id: "a-1", kind: "user-input.requested", tone: "approval", summary: "Choose a branch", payload: { question: "Which branch?" }, createdAt: "2026-09-15T00:00:00Z" });
  const result = await f.bridge.getThread({ environmentId: "env-1", threadId, turnLimit: 3, beforeCursor: "older" });
  assert.equal(result.waitingForApproval, true); assert.equal(result.waitingForInput, true);
  assert.equal(result.session?.lastError, "Provider unavailable"); assert.equal(result.messages.length, 20);
  assert.equal(result.outputTruncated, true); assert.ok(result.messages[0]!.text.length < 3100);
  assert.ok(result.action?.includes("T3")); assert.equal(result.page?.beforeCursor, "older");
});

test("offline, expired/revoked sessions and scope boundaries do not expose credentials", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login(); f.flags.offline = true;
  assert.equal((await f.bridge.listEnvironments({ offset: 0, limit: 1, checkAvailability: true })).environments[0]!.status, "offline");
  await f.bridge.listProjects({ environmentId: "env-1", offset: 0, limit: 10 });
  f.flags.rejectEnvironment = true;
  await assert.rejects(f.bridge.listProjects({ environmentId: "env-1", offset: 0, limit: 10 }), (e: any) => e.code === "auth_required" && !JSON.stringify(e).includes("SECRET"));
  f.flags.rejectEnvironment = false;
  await f.bridge.listProjects({ environmentId: "env-1", offset: 0, limit: 10 });
  assert.equal(f.environmentTokens.size, 2);
  f.flags.sessionExpired = true;
  await assert.rejects(f.bridge.listEnvironments({ offset: 0, limit: 10, checkAvailability: false }), { code: "auth_required" });
});

test("token expiry reconnects without retaining a bootstrap credential", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login(); f.flags.tokenTtl = 1;
  await f.bridge.listProjects({ environmentId: "env-1", offset: 0, limit: 10 });
  await f.bridge.listProjects({ environmentId: "env-1", offset: 0, limit: 10 });
  assert.equal(f.environmentTokens.size, 2); assert.equal(f.relayTokens.size, 2);
  const persisted = await readFile(join(f.config.stateDir, "state.json"), "utf8");
  assert.ok(!persisted.includes("bootstrap-")); assert.ok(!persisted.includes("env-token-"));
});

test("invalid projects/models, worktree defaults, and mismatched environment IDs fail before dispatch", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  await assert.rejects(f.bridge.startThread({ ...launch(), projectId: "wrong" }), { code: "project_not_found" });
  f.project.defaultThreadEnvMode = "worktree";
  await assert.rejects(f.bridge.startThread(launch()), { code: "worktree_required" });
  f.project.defaultThreadEnvMode = "local"; f.project.defaultModelSelection = null as any;
  await assert.rejects(f.bridge.startThread(launch()), { code: "model_required" });
  f.flags.mismatch = true;
  await assert.rejects(new Bridge(f.config).listProjects({ environmentId: "env-1", offset: 0, limit: 10 }), { code: "identity_mismatch" });
  assert.equal(f.receipts.size, 0);
});

test("logout revokes only this bridge's session and disables subsequent tools", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  await f.bridge.store.locked((state, save) => new ClerkAuth(f.config, f.bridge.http, state, save).logout());
  await assert.rejects(f.bridge.listEnvironments({ offset: 0, limit: 10, checkAvailability: false }), { code: "login_required" });
  const state = JSON.parse(await readFile(join(f.config.stateDir, "state.json"), "utf8"));
  assert.equal(state.auth, undefined); assert.equal(state.privateJwk, undefined);
  assert.equal(f.requests.filter(r => r.path.endsWith("/end")).length, 1);
});
