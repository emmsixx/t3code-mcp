import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Bridge } from "../src/bridge.js";
import { ClerkAuth } from "../src/auth.js";
import { NativeMcp, endpointFetch } from "../src/native-mcp.js";
import { fakeT3 } from "./fake.js";
import { fakeNative } from "./fake-native.js";

async function fixture(t: test.TestContext) {
  const account = await fakeT3(), native = await fakeNative();
  t.after(account.close); t.after(native.close);
  account.flags.mcpOrigins["env-1"] = native.origin;
  await account.login();
  return { ...account, native };
}
const page = { offset: 0, limit: 20, checkAvailability: false };

test("account discovery is independent of native approvals and never returns credentials", async t => {
  const f = await fixture(t); f.flags.secondMachine = true; f.flags.secondFactor = true;
  const result = await f.bridge.listEnvironments({ ...page, checkAvailability: true });
  assert.equal(result.environments.length, 2);
  assert.equal(result.environments[0]!.mcpAuthorization, "not_connected");
  assert.equal(result.environments[0]!.mcpUrl, `${f.native.origin}/mcp`);
  assert.equal(result.environments[0]!.status, "online");
  assert.equal(f.native.requests.length, 0);
  assert.equal((await stat(join(f.config.stateDir, "state.json"))).mode & 0o777, 0o600);
  await assert.rejects(f.bridge.listTools({ environmentId: "env-1" }), { code: "mcp_login_required" });
  await assert.rejects(f.bridge.listTools({ environmentId: "unknown" }), { code: "environment_not_found" });
});

test("OAuth checks state and PKCE, releases the store while waiting, and survives a gateway restart", async t => {
  const f = await fixture(t);
  const approved = await f.bridge.connect("env-1", async url => {
    assert.equal((await f.native.approve(url, { invalidState: true })).status, 400);
    // A browser approval must not hold the account state lock.
    assert.equal((await f.bridge.listEnvironments(page)).environments[0]!.mcpAuthorization, "not_connected");
    assert.equal((await f.native.approve(url)).status, 200);
  });
  assert.equal(approved.scope, "orchestration:read");
  const restarted = new Bridge(f.config);
  assert.equal((await restarted.listEnvironments(page)).environments[0]!.mcpAuthorization, "connected");
  const first = await restarted.listTools({ environmentId: "env-1" });
  assert.equal(first.tools[0]!.name, "t3_project_list"); assert.equal(first.nextCursor, "next-page");
  assert.equal(first.tools[0]!.annotations?.readOnlyHint, true);
  assert.equal((await restarted.listTools({ environmentId: "env-1", cursor: first.nextCursor })).tools[0]!.name, "t3_thread_launch");
  assert.equal(f.native.requests.filter(r => r.method === "DELETE").length, 2);
  const saved = JSON.parse(await readFile(join(f.config.stateDir, "state.json"), "utf8"));
  assert.equal(saved.version, 3);
  assert.ok(!JSON.stringify(saved).includes("code_verifier"));
  assert.ok(!JSON.stringify(first).includes("approved-"));
  assert.ok(f.requests.every(r => !r.path.startsWith("/api/orchestration/") && r.path !== "/oauth/token"));
});

test("native permissions and provider-session errors pass through, with unchanged arguments and metadata", async t => {
  const f = await fixture(t); await f.bridge.connect("env-1", url => f.native.approve(url).then(() => {}));
  const call = (name: string, args = {}) => f.bridge.callTool({ environmentId: "env-1", name, arguments: args, timeoutMs: 2000 });
  const args = { arbitrary: { nested: [1, true, "literal"] }, clientRequestId: "native-retry-key" };
  const result = await call("t3_project_list", args);
  assert.deepEqual(result.structuredContent, { arguments: args, native: true });
  assert.deepEqual(result._meta, { fixture: "preserved" });
  assert.equal((await call("t3_thread_launch")).isError, true); assert.equal(f.native.launches, 0);
  assert.match(JSON.stringify(await call("delegate_task")), /thread_credential_required/);
  f.native.flags.writeAccess = true;
  await f.bridge.connect("env-1", url => f.native.approve(url).then(() => {}));
  await call("t3_thread_launch", args); assert.equal(f.native.launches, 1);
});

test("lost mutation replies are never replayed, and oversized replies retain ambiguity", async t => {
  const f = await fixture(t); f.native.flags.writeAccess = true;
  await f.bridge.connect("env-1", url => f.native.approve(url).then(() => {}));
  f.native.flags.dropReply = true;
  await assert.rejects(f.bridge.callTool({ environmentId: "env-1", name: "t3_thread_launch", arguments: {}, timeoutMs: 1000 }), { code: "native_mcp_error" });
  assert.equal(f.native.launches, 1);
  assert.equal(f.native.requests.filter(r => r.body.method === "tools/call").length, 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.bridge.callTool({ environmentId: "env-1", name: "t3_thread_launch", arguments: {}, timeoutMs: 1000 }, cancelled.signal), { code: "native_mcp_error" });
  assert.equal(f.native.launches, 1);
  f.native.flags.largeReply = true;
  await assert.rejects(f.bridge.callTool({ environmentId: "env-1", name: "t3_project_list", arguments: {}, timeoutMs: 2000 }), { code: "response_too_large" });
});

test("approvals stay bound to the selected machine, endpoint and account", async t => {
  const f = await fixture(t), other = await fakeNative(); t.after(other.close);
  f.flags.secondMachine = true; f.flags.mcpOrigins["env-2"] = other.origin;
  await f.bridge.connect("env-1", url => f.native.approve(url).then(() => {}));
  await assert.rejects(f.bridge.listTools({ environmentId: "env-2" }), { code: "mcp_login_required" });
  assert.equal(other.requests.length, 0);
  await f.bridge.connect("env-2", url => other.approve(url).then(() => {}));
  assert.equal((await f.bridge.listTools({ environmentId: "env-2" })).tools[0]!.name, "t3_project_list");
  const otherRequests = other.requests.length;
  f.flags.mcpOrigins["env-1"] = other.origin;
  assert.equal((await f.bridge.listEnvironments(page)).environments[0]!.mcpAuthorization, "endpoint_changed");
  await assert.rejects(f.bridge.listTools({ environmentId: "env-1" }), { code: "endpoint_changed" });
  assert.equal(other.requests.length, otherRequests);
  f.flags.mcpOrigins["env-1"] = f.native.origin;
  await f.bridge.disconnect("env-1");
  await assert.rejects(f.bridge.listTools({ environmentId: "env-1" }), { code: "mcp_login_required" });
  await assert.rejects(f.bridge.connect("env-1", async url => {
    await f.bridge.store.locked(async (state, save) => { state.auth!.sessionId = "another-session"; await save(); });
    await f.native.approve(url);
  }), { code: "account_changed" });
});

test("denied, expired and revoked access need user approval; native error bodies remain private", async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.connect("env-1", url => f.native.approve(url, { deny: true }).then(() => {})), { code: "mcp_authorization_denied" });
  await f.bridge.connect("env-1", url => f.native.approve(url).then(() => {}));
  f.native.flags.rejectToken = true;
  await assert.rejects(f.bridge.listTools({ environmentId: "env-1" }), (e: any) => e.code === "mcp_login_required" && !JSON.stringify(e).includes("PRIVATE ERROR"));
  f.native.flags.rejectToken = false;
  await f.bridge.store.locked(async (state, save) => { Object.values(state.connections!)[0]!.expiresAt = 0; await save(); });
  assert.equal((await f.bridge.listEnvironments(page)).environments[0]!.mcpAuthorization, "expired");
  await assert.rejects(f.bridge.listTools({ environmentId: "env-1" }), { code: "mcp_login_required" });
  await f.bridge.store.locked((state, save) => new ClerkAuth(f.config, f.bridge.http, state, save).logout());
  await assert.rejects(f.bridge.listTools({ environmentId: "env-1" }), { code: "login_required" });
});

test("OAuth metadata cannot redirect gateway credentials to a different origin", async t => {
  const f = await fixture(t), other = await fakeNative(); t.after(other.close);
  f.native.flags.metadataOrigin = other.origin;
  await assert.rejects(f.bridge.connect("env-1", () => assert.fail("must not offer approval")), { code: "endpoint_mismatch" });
  assert.equal(other.requests.length, 0);
  let fetched = false;
  const restricted = endpointFetch(f.native.origin, async () => { fetched = true; throw new Error(); });
  await assert.rejects(restricted(`${other.origin}/token`, { headers: { authorization: "Bearer SECRET" } }), { code: "endpoint_mismatch" });
  assert.equal(fetched, false);
});

test("unanswered OAuth approval times out and closes the loopback callback", async t => {
  const f = await fixture(t);
  const auth = await f.bridge.store.locked(async state => state.auth!);
  const flow = new NativeMcp(f.bridge.store, { environmentId: "env-1", origin: f.native.origin, key: "timeout-fixture", accountId: auth.accountId!, binding: auth.binding, sessionId: auth.sessionId! });
  let callback: URL | undefined;
  await assert.rejects(flow.authorize(url => { callback = new URL(url.searchParams.get("redirect_uri")!); }, 1000), { code: "mcp_authorization_timeout" });
  assert.ok(callback);
  await assert.rejects(fetch(callback, { signal: AbortSignal.timeout(1000) }));
  assert.equal((await f.bridge.listEnvironments(page)).environments[0]!.mcpAuthorization, "not_connected");
});
