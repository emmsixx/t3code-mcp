import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fakeT3 } from "./fake.js";

type Fake = Awaited<ReturnType<typeof fakeT3>>;
async function cli(f: Fake, command: string, input?: unknown, expectedExit = 0, env = {}) {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), command], {
    env: { ...process.env, T3_MCP_STATE_DIR: f.config.stateDir, T3_MCP_CLERK_ORIGIN: f.config.clerkOrigin,
      T3_MCP_RELAY_ORIGIN: f.config.relayOrigin, T3_MCP_JWT_TEMPLATE: "t3-relay", ...env },
    stdio: "pipe", timeout: 10_000,
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input));
  const [code] = await once(child, "close");
  assert.equal(code, expectedExit, stderr);
  for (const secret of ["person@example.test", "123456", "native-client-", "sess_fake", "sia_fake", ".signature", "SECRET"]) {
    assert.ok(!(stdout + stderr).includes(secret), `CLI output included ${secret}`);
  }
  if (expectedExit === 0) assert.equal(stderr, command === "logout" ? "This bridge's account session has been cleared.\n" : "");
  else assert.equal(stdout, "");
  return JSON.parse((expectedExit === 0 ? stdout : stderr) || "null");
}

const start = (f: Fake) => cli(f, "login-start", { email: "person@example.test" });
const verifyInput = (status: any, code = "123456") => ({ loginId: status.loginId, factor: status.factor, code });
const attempts = (f: Fake) => f.requests.filter(r => /\/attempt_(first|second)_factor$/.test(r.path));

test("agent login survives separate CLI processes and stores neither email nor codes", async t => {
  const f = await fakeT3(); t.after(f.close);
  assert.deepEqual(await cli(f, "login-status"), { status: "signed_out" });
  assert.equal(f.requests.length, 0);
  const pending = await start(f);
  assert.equal(pending.status, "code_required"); assert.equal(pending.factor, "email_code");
  assert.ok(Date.parse(pending.expiresAt) > Date.now());
  await assert.rejects(stat(join(f.config.stateDir, "lock")), { code: "ENOENT" });
  assert.deepEqual(await cli(f, "login-status"), pending);
  assert.deepEqual(await cli(f, "login-verify", verifyInput(pending)), { status: "signed_in" });
  assert.deepEqual(await cli(f, "login-verify", verifyInput(pending)), { status: "signed_in" });
  assert.equal(attempts(f).length, 1);
  assert.equal((await cli(f, "environments")).total, 1);
  const stored = await readFile(join(f.config.stateDir, "state.json"), "utf8");
  assert.ok(!stored.includes("person@example.test") && !stored.includes("123456"));
  assert.equal(JSON.parse(stored).auth.pendingLogin, undefined);
  assert.equal((await stat(join(f.config.stateDir, "state.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await cli(f, "login-status"), { status: "signed_in" });
});

test("wrong codes retain the login and rotated credentials for a corrected code", async t => {
  const f = await fakeT3(); t.after(f.close);
  const pending = await start(f);
  const error = await cli(f, "login-verify", verifyInput(pending, "654321"), 1);
  assert.equal(error.reason, "form_code_incorrect");
  assert.ok(!JSON.stringify(error).includes("654321"));
  assert.deepEqual(await cli(f, "login-status"), pending);
  assert.deepEqual(await cli(f, "login-verify", verifyInput(pending)), { status: "signed_in" });
});

test("lost first-factor response resumes as TOTP without submitting the email code twice", async t => {
  const f = await fakeT3(); t.after(f.close); f.flags.secondFactor = true;
  const pending = await start(f);
  f.flags.corruptAuthResponse = "/attempt_first_factor";
  assert.equal((await cli(f, "login-verify", verifyInput(pending), 1)).code, "incompatible_auth_response");
  const next = await cli(f, "login-verify", verifyInput(pending));
  assert.equal(next.status, "code_required"); assert.equal(next.factor, "totp");
  assert.equal(next.loginId, pending.loginId); assert.equal(attempts(f).length, 1);
  assert.deepEqual(await cli(f, "login-status"), next);
  assert.deepEqual(await cli(f, "login-verify", verifyInput(next)), { status: "signed_in" });
  assert.equal(attempts(f).length, 2);
});

test("status recovers a completed login after an unreadable verification response", async t => {
  const f = await fakeT3(); t.after(f.close);
  const pending = await start(f); f.flags.corruptAuthResponse = "/attempt_first_factor";
  await cli(f, "login-verify", verifyInput(pending), 1);
  assert.deepEqual(await cli(f, "login-status"), { status: "signed_in" });
  assert.equal(attempts(f).length, 1);
});

test("a completed session survives a failed T3 token request without verifying the code again", async t => {
  const f = await fakeT3(); t.after(f.close);
  const pending = await start(f); f.flags.rejectAccountToken = true;
  assert.equal((await cli(f, "login-verify", verifyInput(pending), 1)).status, 503);
  f.flags.rejectAccountToken = false;
  assert.deepEqual(await cli(f, "login-status"), { status: "signed_in" });
  assert.equal(attempts(f).length, 1);
});

test("unfinished preparation requires a restart without automatically sending another email", async t => {
  const f = await fakeT3(); t.after(f.close); f.flags.corruptAuthResponse = "/prepare_first_factor";
  await cli(f, "login-start", { email: "person@example.test" }, 1);
  const status = await cli(f, "login-status");
  assert.equal(status.status, "restart_required");
  assert.equal((await cli(f, "login-start", { email: "person@example.test" }, 1)).code, "login_in_progress");
  assert.equal(f.requests.filter(r => r.path.endsWith("/prepare_first_factor")).length, 1);
  await cli(f, "logout");
  assert.equal((await start(f)).status, "code_required");
});

test("logout revokes a remotely completed login even if verification never returned locally", async t => {
  const f = await fakeT3(); t.after(f.close);
  const pending = await start(f); f.flags.corruptAuthResponse = "/attempt_first_factor";
  await cli(f, "login-verify", verifyInput(pending), 1);
  await cli(f, "logout");
  assert.equal(f.requests.filter(r => r.path.endsWith("/end")).length, 1);
  assert.deepEqual(await cli(f, "login-status"), { status: "signed_out" });
});

test("stale handles, local expiry, and remote expiry cannot submit an unintended code", async t => {
  const f = await fakeT3(); t.after(f.close);
  const pending = await start(f);
  const count = f.requests.length;
  assert.equal((await cli(f, "login-verify", { ...verifyInput(pending), loginId: randomUUID() }, 1)).code, "login_mismatch");
  assert.equal(f.requests.length, count);
  f.flags.signInExpired = true;
  assert.equal((await cli(f, "login-verify", verifyInput(pending), 1)).reason, "verification_expired");
  await f.bridge.store.locked(async (state, save) => { state.auth!.pendingLogin!.expiresAt = Date.now() - 1; await save(); });
  const before = attempts(f).length;
  assert.equal((await cli(f, "login-verify", verifyInput(pending))).status, "expired");
  assert.equal(attempts(f).length, before);
  f.flags.signInMissing = true;
  assert.equal((await cli(f, "login-status")).status, "expired");
  await cli(f, "logout");
  assert.deepEqual(await cli(f, "login-status"), { status: "signed_out" });
});

test("login input is bounded and validated without echoing it or contacting the server", async t => {
  const f = await fakeT3(); t.after(f.close);
  for (const input of ["{SECRET", {}, { email: "not-an-email" }, { email: "person@example.test", secret: "SECRET" }, "x".repeat(8193)]) {
    assert.equal((await cli(f, "login-start", input, 1)).code, "invalid_input");
  }
  for (const input of [{ loginId: randomUUID(), factor: "email_code", code: "SECRET" }, { loginId: randomUUID(), factor: "other", code: "123456" }]) {
    assert.equal((await cli(f, "login-verify", input, 1)).code, "invalid_input");
  }
  assert.equal((await cli(f, "login", undefined, 1)).code, "terminal_required");
  assert.equal(f.requests.length, 0);
});

test("unsupported second factors and changed deployment settings fail without bypassing login", async t => {
  const f = await fakeT3(); t.after(f.close); f.flags.secondFactor = true; f.flags.unsupportedSecondFactor = true;
  const pending = await start(f);
  assert.equal((await cli(f, "login-verify", verifyInput(pending), 1)).code, "unsupported_second_factor");
  const count = f.requests.length;
  assert.equal((await cli(f, "login-status", undefined, 1, { T3_MCP_JWT_TEMPLATE: "different" })).code, "config_mismatch");
  assert.equal(f.requests.length, count);
  assert.equal(attempts(f).length, 1);
});

test("existing sessions are reused and a new login cannot replace their account", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  const count = f.requests.length;
  assert.equal((await cli(f, "login-start", { email: "person@example.test" }, 1)).code, "already_signed_in");
  assert.equal(f.requests.length, count);
  assert.deepEqual(await cli(f, "login-status"), { status: "signed_in" });
  f.flags.sessionExpired = true;
  assert.equal((await cli(f, "login-status", undefined, 1)).code, "auth_required");
});
