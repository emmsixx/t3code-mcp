import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeT3 } from "./fake.js";

test("built CLI speaks MCP over stdio and exposes all six tools with validated inputs", async t => {
  const f = await fakeT3(); t.after(f.close); await f.login();
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("dist/cli.js"), "serve"], stderr: "pipe",
    env: { T3_MCP_STATE_DIR: f.config.stateDir, T3_MCP_CLERK_ORIGIN: f.config.clerkOrigin, T3_MCP_RELAY_ORIGIN: f.config.relayOrigin },
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk; });
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["get_thread", "interrupt_thread", "list_environments", "list_projects", "send_message", "start_thread"]);
  const environments = await client.callTool({ name: "list_environments", arguments: {} });
  assert.equal(environments.isError, undefined);
  assert.equal((environments.structuredContent as any).environments[0].environmentId, "env-1");
  const invalid = await client.callTool({ name: "list_environments", arguments: { limit: 200 } });
  assert.equal(invalid.isError, true);
  const launch = await client.callTool({ name: "start_thread", arguments: { operationId: "mcp-launch", environmentId: "env-1", projectId: "project-1", title: "MCP test", instructions: "Test instructions" } });
  assert.equal(launch.isError, undefined);
  const threadId = (launch.structuredContent as any).threadId;
  const detail = await client.callTool({ name: "get_thread", arguments: { environmentId: "env-1", threadId } });
  assert.equal((detail.structuredContent as any).threadId, threadId);
  assert.equal(f.threads.get(threadId).runtimeMode, "approval-required");
  assert.equal(stderr, "");
});

test("MCP starts without credentials and returns an actionable login error", async t => {
  const f = await fakeT3(); t.after(f.close);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js")], env: { T3_MCP_STATE_DIR: f.config.stateDir }, stderr: "pipe" });
  const client = new Client({ name: "unsigned-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const result = await client.callTool({ name: "list_environments", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /login_required/);
});
