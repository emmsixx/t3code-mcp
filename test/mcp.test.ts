import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeT3 } from "./fake.js";
import { fakeV2 } from "./fake-v2.js";

test("built CLI speaks MCP over stdio and exposes all seven tools with validated inputs", async t => {
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
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["get_thread", "interrupt_thread", "list_environments", "list_projects", "list_threads", "send_message", "start_thread"]);
  assert.equal(tools.find(tool => tool.name === "list_threads")!.annotations?.readOnlyHint, true);
  const environments = await client.callTool({ name: "list_environments", arguments: {} });
  assert.equal(environments.isError, undefined);
  assert.equal((environments.structuredContent as any).environments[0].environmentId, "env-1");
  const invalid = await client.callTool({ name: "list_environments", arguments: { limit: 200 } });
  assert.equal(invalid.isError, true);
  for (const args of [{}, { environmentId: "env-1", limit: 51 }, { environmentId: "env-1", offset: -1 }, { environmentId: "env-1", status: "made-up" }]) {
    assert.equal((await client.callTool({ name: "list_threads", arguments: args })).isError, true);
  }
  const launch = await client.callTool({ name: "start_thread", arguments: { operationId: "mcp-launch", environmentId: "env-1", projectId: "project-1", title: "MCP test", instructions: "Test instructions" } });
  assert.equal(launch.isError, undefined);
  const threadId = (launch.structuredContent as any).threadId;
  const listed = await client.callTool({ name: "list_threads", arguments: { environmentId: "env-1", projectId: "project-1", status: "working" } });
  assert.equal(listed.isError, undefined);
  assert.equal((listed.structuredContent as any).threads[0].threadId, threadId);
  const detail = await client.callTool({ name: "get_thread", arguments: { environmentId: "env-1", threadId } });
  assert.equal((detail.structuredContent as any).threadId, threadId);
  assert.equal((detail.structuredContent as any).status, "working");
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

test("built MCP tools launch, read, queue and interrupt through the v2 RPC transport", async t => {
  const f = await fakeV2(); t.after(f.close); await f.login();
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js"), "serve"], stderr: "pipe",
    env: { T3_MCP_STATE_DIR: f.config.stateDir, T3_MCP_CLERK_ORIGIN: f.config.clerkOrigin, T3_MCP_RELAY_ORIGIN: f.config.relayOrigin } });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += chunk; });
  const client = new Client({ name: "v2-test", version: "1.0.0" });
  t.after(() => client.close()); await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { environmentId: "env-1", ...args } });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent as any;
  };
  assert.equal((await client.listTools()).tools.length, 7);
  await call("list_projects", {});
  const launched = await call("start_thread", { operationId: "mcp-v2", projectId: "project-1", title: "V2 task", instructions: "Test instructions" });
  assert.equal(launched.protocolVersion, 2);
  const { threadId } = launched;
  const listed = await call("list_threads", {});
  assert.equal(listed.threads[0].threadId, threadId);
  const detail = await call("get_thread", { threadId });
  assert.equal(detail.runtime.activeRunId, launched.results[0].runId);
  assert.equal(detail.messages[0].text, "Test instructions");
  await call("send_message", { operationId: "mcp-queue", threadId, mode: "queue", instructions: "Next task" });
  await call("interrupt_thread", { operationId: "mcp-interrupt", threadId, runId: detail.runtime.activeRunId });
  assert.equal(stderr, "");
});
