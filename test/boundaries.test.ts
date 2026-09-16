import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Http } from "../src/http.js";
import { secureOrigin } from "../src/config.js";
import { Store } from "../src/store.js";
import { Bridge } from "../src/bridge.js";
import { fakeT3 } from "./fake.js";

test("HTTP credentials are never sent through redirects and error bodies are redacted", async () => {
  const http = new Http(async (url, init) => {
    assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify({ code: "invalid_request", secret: "CREDENTIAL" }), { status: 400 });
  });
  await assert.rejects(http.request("https://example.test", z.unknown()), (error: any) => {
    assert.equal(error.details.reason, "invalid_request");
    assert.ok(!JSON.stringify(error).includes("CREDENTIAL")); return true;
  });
});

test("HTTP response limits and timeout errors preserve ambiguous outcome information", async () => {
  const large = new Http(async () => new Response("x".repeat(4_000_001)));
  await assert.rejects(large.request("https://example.test", z.unknown()), { code: "response_too_large" });
  const timeout = new Http(async () => { throw new DOMException("Private endpoint", "TimeoutError"); });
  await assert.rejects(timeout.request("https://example.test", z.unknown()), (error: any) => error.code === "transport_error" && error.message.includes("same operationId") && !error.message.includes("Private endpoint"));
});

test("credential rotation is saved before processing an unsuccessful response", async () => {
  let rotated = "";
  const http = new Http(async () => new Response(JSON.stringify({ code: "invalid_code" }), { status: 422, headers: { authorization: "rotated-native-token" } }));
  await assert.rejects(http.request("https://example.test", z.unknown(), {}, async headers => { rotated = headers.get("authorization")!; }), { code: "http_error" });
  assert.equal(rotated, "rotated-native-token");
});

test("endpoint configuration rejects cleartext remote URLs, credentials and URL path injection", () => {
  for (const url of ["http://remote.test", "https://user:secret@remote.test", "https://remote.test/path", "https://remote.test?token=x", "https://remote.test#token", "file:///tmp/x"]) {
    assert.throws(() => secureOrigin(url), { code: "invalid_origin" });
  }
  assert.equal(secureOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
});

test("another process's state lock fails without overwriting state", async t => {
  const f = await fakeT3(); t.after(f.close);
  await mkdir(join(f.config.stateDir, "lock"));
  await assert.rejects(new Store(f.config.stateDir).locked(async () => undefined), { code: "state_busy" });
});

test("insecure credential permissions and changed endpoints fail closed", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  const path = join(f.config.stateDir, "state.json");
  await chmod(path, 0o644);
  await assert.rejects(f.bridge.listEnvironments({ offset: 0, limit: 10, checkAvailability: false }), { code: "unsafe_state" });
  await chmod(path, 0o600);
  const bridge = new Bridge({ ...f.config, clerkOrigin: "https://another.example.test" });
  const count = f.requests.length;
  await assert.rejects(bridge.listEnvironments({ offset: 0, limit: 10, checkAvailability: false }), { code: "config_mismatch" });
  assert.equal(f.requests.length, count);
});
