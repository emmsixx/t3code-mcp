import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { unaryRpc } from "../src/rpc.js";

async function server(handler: (socket: WebSocket, message: any) => void) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const messages: unknown[] = [];
  wss.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(raw.toString()); messages.push(request); handler(socket, request);
  }));
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, messages,
    close: async () => { for (const socket of wss.clients) socket.terminate(); wss.close(); await once(wss, "close"); } };
}
const success = (requestId: string, value: unknown) => ({ _tag: "Exit", requestId, exit: { _tag: "Success", value } });
const result = z.object({ sequence: z.number() });

test("RPC handles batched Effect envelopes and the pinned DateTime JSON encoding", async t => {
  const f = await server((socket, request) => socket.send(JSON.stringify([{ _tag: "Pong" }, success(request.id, { sequence: 10 })])));
  t.after(f.close);
  assert.deepEqual(await unaryRpc(f.url, "orchestration.dispatchCommand", { commandId: "stable-id" }, result), { sequence: 10 });
  const date = Schema.encodeSync(Schema.toCodecJson(Schema.DateTimeUtc))(DateTime.makeUnsafe("2026-09-16T12:00:00Z"));
  assert.equal(date, "2026-09-16T12:00:00.000Z");
});

test("RPC rejects malformed, oversized, mismatched and unsuccessful responses without echoing secrets", async t => {
  for (const response of [
    "not-json SECRET", JSON.stringify(success("other", { sequence: 10 })),
    JSON.stringify(success("1", { wrong: "SECRET" })), "x".repeat(4_000_001),
    JSON.stringify({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: "SECRET" }] } }),
  ]) {
    const f = await server(socket => socket.send(response));
    try {
      await assert.rejects(unaryRpc(f.url, "method", {}, result), (error: any) => {
        assert.ok(["incompatible_response", "response_too_large", "rpc_error"].includes(error.code));
        assert.ok(!JSON.stringify(error).includes("SECRET")); return true;
      });
      assert.equal(f.messages.length, 1);
    } finally { await f.close(); }
  }
});

test("RPC timeout and disconnect never automatically resubmit a mutation", async t => {
  for (const disconnect of [false, true]) {
    const f = await server(socket => { if (disconnect) socket.terminate(); });
    try {
      await assert.rejects(unaryRpc(f.url, "method", { commandId: "stable-id" }, result, 1000), (error: any) => {
        assert.equal(error.code, "transport_error"); assert.match(error.message, /same operationId/); return true;
      });
      assert.equal(f.messages.length, 1);
    } finally { await f.close(); }
  }
});
