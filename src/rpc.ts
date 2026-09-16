import { z } from "zod";
import { BridgeError } from "./errors.js";

// Effect 4.0.0-rc.112 RpcSerialization.layerJson, used by T3's /ws route.
// One unary request per connection: no implicit reconnect/replay of mutations.
const frame = z.object({ _tag: z.string(), requestId: z.union([z.string(), z.number()]).optional(),
  exit: z.object({ _tag: z.string(), value: z.unknown().optional() }).optional() });

export function unaryRpc<T>(url: string, method: string, payload: Record<string, unknown>, schema: z.ZodType<T>, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    let settled = false, received = 0;
    const fail = (code: string, message: string) => finish(new BridgeError(code, message));
    const finish = (error?: BridgeError, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep the error listener until close, including a failed opening handshake.
      socket?.close();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => fail("transport_error", "The RPC timed out. Its command may have been accepted; retry with the same operationId."), timeoutMs);
    try { socket = new WebSocket(url); }
    catch { fail("transport_error", "The RPC connection could not be opened."); return; }
    socket.addEventListener("error", () => fail("transport_error", "The RPC connection failed. Retry with the same operationId."));
    socket.addEventListener("close", () => fail("transport_error", "The RPC connection closed before acceptance was confirmed. Retry with the same operationId."));
    socket.addEventListener("open", () => {
      if (!settled) socket.send(JSON.stringify({ _tag: "Request", id: "1", tag: method, payload, headers: [] }));
    });
    socket.addEventListener("message", event => {
      if (settled) return;
      if (typeof event.data !== "string") { fail("incompatible_response", "Expected a JSON RPC frame."); return; }
      received += Buffer.byteLength(event.data);
      if (received > 4_000_000) { fail("response_too_large", "The RPC response exceeded 4 MB."); return; }
      try {
        const decoded: unknown = JSON.parse(event.data);
        for (const value of Array.isArray(decoded) ? decoded : [decoded]) {
          const message = frame.parse(value);
          if (message._tag === "Pong") continue;
          if (message._tag !== "Exit" || String(message.requestId) !== "1" || !message.exit) {
            fail("incompatible_response", "Unexpected RPC response envelope."); return;
          }
          if (message.exit._tag === "Failure") {
            // Raw Effect causes can contain credentials and arbitrary provider output.
            fail("rpc_error", "T3 rejected the RPC or failed while processing it. Inspect the thread before retrying with the same operationId."); return;
          }
          if (message.exit._tag !== "Success") { fail("incompatible_response", "Unexpected RPC exit."); return; }
          const result = schema.safeParse(message.exit.value);
          if (!result.success) { fail("incompatible_response", "The RPC result does not match the supported contract."); return; }
          finish(undefined, result.data);
          return;
        }
      } catch { fail("incompatible_response", "The server returned an invalid RPC response."); }
    });
  });
}
