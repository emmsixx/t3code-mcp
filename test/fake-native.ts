import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

export async function fakeNative() {
  let origin = "";
  const requests: { path: string; method: string; body: any; authorization?: string }[] = [];
  const codes = new Map<string, URL>();
  const tokens = new Map<string, boolean>();
  const flags = { writeAccess: false, rejectToken: false, dropReply: false, metadataOrigin: "", largeReply: false };
  let launches = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const body = req.headers["content-type"]?.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : {};
      requests.push({ path: url.pathname, method: req.method!, body, authorization: req.headers.authorization });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json({ resource: `${origin}/mcp`, authorization_servers: [flags.metadataOrigin || origin], scopes_supported: ["orchestration:read", "orchestration:operate"] }); return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        json({ issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }); return;
      }
      if (url.pathname === "/oauth/mcp/register") { json({ ...body, client_id: "signed-client", token_endpoint_auth_method: "none" }, 201); return; }
      if (url.pathname === "/oauth/mcp/token") {
        const authorization = codes.get(body.code);
        assert.ok(authorization);
        codes.delete(body.code);
        assert.equal(body.grant_type, "authorization_code");
        assert.equal(body.resource, `${origin}/mcp`);
        assert.equal(body.redirect_uri, authorization.searchParams.get("redirect_uri"));
        assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), authorization.searchParams.get("code_challenge"));
        const token = `approved-${randomUUID()}`;
        tokens.set(token, flags.writeAccess);
        json({ access_token: token, token_type: "Bearer", expires_in: 2_592_000, scope: flags.writeAccess ? "orchestration:read orchestration:operate" : "orchestration:read" }); return;
      }
      if (url.pathname !== "/mcp") { json({}, 404); return; }
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (!token || !tokens.has(token) || flags.rejectToken) { res.setHeader("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`); json({ error: "invalid_token", secret: "PRIVATE ERROR" }, 401); return; }
      if (req.method === "DELETE") { res.writeHead(200); res.end(); return; }
      if (req.method === "GET") { json({}, 405); return; }
      if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") { res.writeHead(202); res.end(); return; }
      const reply = (result: unknown) => json({ jsonrpc: "2.0", id: body.id, result });
      if (body.method === "initialize") { res.setHeader("mcp-session-id", randomUUID()); reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "native-t3-fixture", version: "0.1.2" } }); return; }
      if (body.method === "tools/list") {
        const read = { name: "t3_project_list", description: "List native projects", inputSchema: { type: "object", properties: { limit: { type: "number" } } }, annotations: { readOnlyHint: true } };
        const write = { name: "t3_thread_launch", description: "Launch through T3", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } };
        reply(body.params?.cursor === "next-page" ? { tools: [write] } : { tools: [read], nextCursor: "next-page" }); return;
      }
      if (body.method === "tools/call") {
        if (body.params.name === "t3_thread_launch") {
          if (!tokens.get(token)) { reply({ isError: true, content: [{ type: "text", text: "capability_denied" }] }); return; }
          launches++;
          if (flags.dropReply) { flags.dropReply = false; res.destroy(); return; }
        }
        if (body.params.name === "delegate_task") { reply({ isError: true, content: [{ type: "text", text: "thread_credential_required" }] }); return; }
        reply({ content: [{ type: "text", text: flags.largeReply ? "x".repeat(4_000_001) : "native response" }], structuredContent: { arguments: body.params.arguments, native: true }, _meta: { fixture: "preserved" } }); return;
      }
      json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown method" } });
    } catch { res.writeHead(500); res.end("fixture error"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const approve = async (authorization: URL, options: { invalidState?: boolean; deny?: boolean } = {}) => {
    assert.equal(authorization.origin, origin);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const code = randomUUID();
    codes.set(code, authorization);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", options.invalidState ? "wrong-state" : authorization.searchParams.get("state")!);
    callback.searchParams.set("iss", origin);
    callback.searchParams.set(options.deny ? "error" : "code", options.deny ? "access_denied" : code);
    return fetch(callback);
  };
  return { origin, requests, flags, tokens, approve, get launches() { return launches; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
