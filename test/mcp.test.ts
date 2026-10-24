import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeT3 } from "./fake.js";
import { fakeNative } from "./fake-native.js";

test("renamed CLI approves native MCP, then the stdio gateway discovers and forwards native tools", async t => {
  const f = await fakeT3(), native = await fakeNative(); t.after(f.close); t.after(native.close);
  f.flags.mcpOrigins["env-1"] = native.origin; await f.login();
  const env = { ...process.env, T3_MCP_STATE_DIR: f.config.stateDir, T3_MCP_CLERK_ORIGIN: f.config.clerkOrigin, T3_MCP_RELAY_ORIGIN: f.config.relayOrigin };
  const cli = spawn(process.execPath, [resolve("dist/cli.js"), "connect", "env-1"], { env, stdio: "pipe", timeout: 10_000 });
  let output = "", log = "";
  cli.stdout.on("data", chunk => { output += chunk; });
  const shown = new Promise<URL>(resolveUrl => cli.stderr.on("data", chunk => {
    log += chunk;
    const url = /http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+/.exec(log)?.[0];
    if (url) resolveUrl(new URL(url));
  }));
  const exit = once(cli, "close");
  cli.stdin.end();
  await native.approve(await shown);
  assert.equal((await exit)[0], 0, log);
  assert.equal(JSON.parse(output).status, "connected");
  assert.ok(!output.includes("approved-") && !log.includes("approved-"));

  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js"), "serve"], stderr: "pipe", env });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += chunk; });
  const client = new Client({ name: "gateway-smoke-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "t3connect-mcp");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["call_tool", "list_environments", "list_tools"]);
  assert.equal(tools.find(tool => tool.name === "call_tool")!.annotations?.destructiveHint, true);
  const environments = await client.callTool({ name: "list_environments", arguments: {} });
  assert.equal((environments.structuredContent as any).environments[0].mcpAuthorization, "connected");
  const discovered = await client.callTool({ name: "list_tools", arguments: { environmentId: "env-1" } });
  assert.equal((discovered.structuredContent as any).tools[0].name, "t3_project_list");
  const args = { environmentId: "env-1", name: "t3_project_list", arguments: { limit: 2 } };
  const result = await client.callTool({ name: "call_tool", arguments: args });
  assert.deepEqual(result.structuredContent, { arguments: { limit: 2 }, native: true });
  assert.deepEqual(result._meta, { fixture: "preserved" });
  assert.equal((await client.callTool({ name: "call_tool", arguments: { ...args, name: "t3_thread_launch" } })).isError, true);
  for (const invalid of [{}, { ...args, timeoutMs: 0 }, { ...args, arguments: "bad" }, { ...args, arguments: { huge: "x".repeat(100_001) } }]) {
    assert.equal((await client.callTool({ name: "call_tool", arguments: invalid })).isError, true);
  }
  assert.equal((await client.callTool({ name: "list_environments", arguments: { limit: 200 } })).isError, true);
  assert.equal(stderr, ""); assert.equal(native.launches, 0);
});

test("gateway starts unsigned with three tools and returns actionable login guidance", async t => {
  const f = await fakeT3(); t.after(f.close);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js")], env: { T3_MCP_STATE_DIR: f.config.stateDir }, stderr: "pipe" });
  const client = new Client({ name: "unsigned-test", version: "1.0.0" }); t.after(async () => { await client.close(); });
  await client.connect(transport);
  const result = await client.callTool({ name: "list_environments", arguments: {} });
  assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /login_required/);
  assert.match(JSON.stringify(result.content), /t3connect-mcp login/);
});
