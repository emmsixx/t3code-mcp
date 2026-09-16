import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "../src/bridge.js";
import { ClerkAuth } from "../src/auth.js";
import { hash } from "../src/dpop.js";

export async function fakeT3() {
  const stateDir = await mkdtemp(join(tmpdir(), "t3-mcp-test-"));
  const model = { instanceId: "configured-provider", model: "configured-model", options: [{ id: "effort", value: "high" }] };
  const project = { id: "project-1", title: "Example", workspaceRoot: "/example", defaultModelSelection: model, defaultThreadEnvMode: "local" };
  const threads = new Map<string, any>();
  const receipts = new Map<string, number>();
  const requests: { method: string; path: string; body: any }[] = [];
  const proofIds = new Set<string>();
  const flags = { dropCommand: "", rejectEnvironment: false, offline: false, tokenTtl: 3600, secondFactor: false, sessionExpired: false, mismatch: false, secondMachine: false,
    corruptAuthResponse: "", unsupportedSecondFactor: false, signInExpired: false, signInMissing: false, rejectAccountToken: false };
  const validations: Error[] = [];
  let clientJwt = "", tokenCount = 0, origin = "", signInId = "sia_fake", sessionId = "sess_fake";
  const environmentTokens = new Map<string, string>();
  const relayTokens = new Map<string, string>();
  const bootstraps = new Map<string, string>();
  let sequence = 0;
  let signInStatus = "needs_first_factor";
  const accountJwt = `header.${Buffer.from(JSON.stringify({ sub: "user_fake" })).toString("base64url")}.signature`;

  function proof(req: IncomingMessage, expectedToken?: string, expectedThumbprint?: string) {
    const parts = String(req.headers.dpop).split(".");
    assert.equal(parts.length, 3);
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    assert.equal(header.alg, "ES256"); assert.equal(header.typ, "dpop+jwt");
    assert.equal(header.jwk.d, undefined);
    assert.equal(payload.htm, req.method);
    const target = new URL(req.url!, origin); target.search = "";
    assert.equal(payload.htu, target.href);
    assert.equal(payload.ath, expectedToken ? hash(expectedToken) : undefined);
    assert.ok(Math.abs(Date.now() / 1000 - payload.iat) < 10);
    assert.ok(!proofIds.has(payload.jti)); proofIds.add(payload.jti);
    assert.ok(verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url")));
    const s = BigInt(`0x${Buffer.from(parts[2]!, "base64url").subarray(32).toString("hex")}`);
    assert.ok(s <= BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551") / 2n);
    const { crv, kty, x, y } = header.jwk;
    const thumbprint = hash(JSON.stringify({ crv, kty, x, y }));
    if (expectedThumbprint) assert.equal(thumbprint, expectedThumbprint);
    return thumbprint;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const body = req.headers["content-type"]?.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : {};
      const path = url.pathname;
      requests.push({ method: req.method!, path, body });
      const respond = (data: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      const ep = { httpBaseUrl: origin, wsBaseUrl: origin.replace("http:", "ws:") + "/ws", providerKind: "t3_relay" };
      if (path.startsWith("/v1/client/sign_ins") || path.startsWith("/v1/client/sessions")) {
        assert.equal(url.searchParams.get("_is_native"), "1");
        if (path === "/v1/client/sign_ins" && req.headers.authorization === "") clientJwt = "";
        assert.equal(req.headers.authorization, clientJwt);
        if (req.method === "POST") assert.match(req.headers["content-type"] ?? "", /application\/x-www-form-urlencoded/);
        if (flags.sessionExpired) { respond({ errors: [{ code: "session_expired", long_message: "SECRET" }] }, 401); return; }
        clientJwt = `native-client-${++tokenCount}`;
        res.setHeader("authorization", clientJwt);
        const base = { id: signInId, supported_first_factors: [{ strategy: "email_code", email_address_id: "email_1" }], created_session_id: null };
        const attempt = () => ({ ...base, status: signInStatus,
          supported_second_factors: [{ strategy: flags.unsupportedSecondFactor ? "phone_code" : "totp" }],
          created_session_id: signInStatus === "complete" ? sessionId : null });
        const respondAttempt = () => {
          if (flags.corruptAuthResponse && path.endsWith(flags.corruptAuthResponse)) {
            flags.corruptAuthResponse = ""; res.writeHead(200, { "content-type": "application/json" }); res.end("truncated response"); return;
          }
          respond({ response: attempt() });
        };
        if (path === "/v1/client/sign_ins") {
          assert.equal(body.identifier, "person@example.test");
          signInStatus = "needs_first_factor"; respondAttempt(); return;
        }
        if (req.method === "GET" && path === `/v1/client/sign_ins/${signInId}`) {
          if (flags.signInMissing) respond({ errors: [{ code: "resource_not_found" }] }, 404);
          else respondAttempt();
          return;
        }
        if (path.endsWith("/prepare_first_factor")) { assert.equal(body.email_address_id, "email_1"); respondAttempt(); return; }
        if (path.endsWith("/attempt_first_factor") || path.endsWith("/attempt_second_factor")) {
          if (flags.signInExpired) { respond({ errors: [{ code: "verification_expired", long_message: "SECRET" }] }, 422); return; }
          if (body.code !== "123456") { respond({ errors: [{ code: "form_code_incorrect", long_message: `SECRET ${body.code}` }] }, 422); return; }
          if (flags.secondFactor && path.endsWith("/attempt_first_factor")) {
            assert.equal(body.strategy, "email_code"); signInStatus = "needs_second_factor"; respondAttempt(); return;
          }
          assert.equal(body.strategy, path.endsWith("/attempt_first_factor") ? "email_code" : "totp");
          signInStatus = "complete"; respondAttempt(); return;
        }
        if (path.endsWith("/tokens/t3-relay")) {
          if (flags.rejectAccountToken) respond({ errors: [{ code: "unavailable", long_message: "SECRET" }] }, 503);
          else respond({ jwt: accountJwt });
          return;
        }
        if (path.endsWith("/end")) { respond({ response: { id: sessionId, status: "ended" } }); return; }
      }
      if (path === "/v1/environments") {
        assert.equal(req.headers.authorization, `Bearer ${accountJwt}`);
        const environments = [{ environmentId: "env-1", label: "Test machine", endpoint: ep, linkedAt: "2026-09-15T00:00:00Z" }];
        if (flags.secondMachine) environments.push({ ...environments[0]!, environmentId: "env-2", label: "Second machine" });
        respond({ environments }); return;
      }
      if (path === "/v1/client/dpop-token") {
        assert.equal(body.subject_token, accountJwt);
        assert.equal(body.client_id, "t3-web"); assert.equal(body.resource, origin);
        assert.equal(body.subject_token_type, "urn:ietf:params:oauth:token-type:jwt");
        const thumbprint = proof(req);
        const token = `relay-${relayTokens.size}`; relayTokens.set(token, thumbprint);
        respond({ access_token: token, token_type: "DPoP", expires_in: flags.tokenTtl, scope: body.scope }); return;
      }
      if (/^\/v1\/environments\/env-[12]\/(status|connect)$/.test(path)) {
        const token = req.headers.authorization?.replace("DPoP ", "")!;
        assert.ok(relayTokens.has(token)); const thumbprint = proof(req, token, relayTokens.get(token));
        const environmentId = flags.mismatch ? "wrong-env" : path.split("/")[3];
        if (path.endsWith("/status")) { respond({ environmentId, status: flags.offline ? "offline" : "online", checkedAt: "2026-09-15T00:00:00Z" }); return; }
        assert.equal(body.clientProofKeyThumbprint, thumbprint);
        const credential = `bootstrap-${bootstraps.size}`; bootstraps.set(credential, thumbprint);
        respond({ environmentId, endpoint: ep, credential, expiresAt: "2026-09-15T00:00:00Z" }); return;
      }
      if (path === "/oauth/token") {
        assert.ok(bootstraps.has(body.subject_token)); proof(req, undefined, bootstraps.get(body.subject_token));
        assert.equal(body.subject_token_type, "urn:t3:params:oauth:token-type:environment-bootstrap");
        assert.equal(body.grant_type, "urn:ietf:params:oauth:grant-type:token-exchange");
        assert.equal(body.client_label, "T3 Code MCP");
        const token = `env-token-${environmentTokens.size}`; environmentTokens.set(token, bootstraps.get(body.subject_token)!);
        respond({ access_token: token, token_type: "DPoP", expires_in: flags.tokenTtl, scope: body.scope }); return;
      }
      if (path.startsWith("/api/orchestration/")) {
        const token = req.headers.authorization?.replace("DPoP ", "")!;
        assert.ok(environmentTokens.has(token)); proof(req, token, environmentTokens.get(token));
        if (flags.rejectEnvironment) { respond({ code: "auth_invalid", message: "SECRET" }, 401); return; }
        if (path.endsWith("/shell")) { respond({ projects: [project], threads: [...threads.values()], snapshotSequence: sequence }); return; }
        if (path.includes("/threads/")) {
          assert.ok(Number(url.searchParams.get("turnLimit")) >= 1);
          const thread = threads.get(decodeURIComponent(path.split("/").at(-1)!));
          if (!thread) { respond({ code: "not_found" }, 404); return; }
          respond({ thread, snapshotSequence: sequence, page: { beforeCursor: "older", hasMore: true } }); return;
        }
        if (path.endsWith("/dispatch")) {
          assert.equal(body.bootstrap, undefined);
          assert.ok(body.commandId); assert.ok(body.threadId); assert.ok(body.createdAt);
          if (!receipts.has(body.commandId)) {
            if (body.type === "thread.create") {
              assert.equal(body.projectId, project.id); assert.equal(body.worktreePath, null); assert.equal(body.branch, null);
              assert.deepEqual(body.modelSelection, model);
              threads.set(body.threadId, { ...body, id: body.threadId, messages: [], activities: [], session: null, latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false });
            } else {
              const thread = threads.get(body.threadId); assert.ok(thread);
              if (body.type === "thread.turn.start") {
                assert.equal(body.message.role, "user"); assert.deepEqual(body.message.attachments, []);
                assert.ok(body.runtimeMode); assert.ok(body.interactionMode);
                thread.messages.push({ id: body.message.messageId, role: "user", text: body.message.text, streaming: false, createdAt: body.createdAt });
                thread.session = { status: "running", activeTurnId: `turn-${sequence}`, lastError: null };
                thread.latestTurn = { turnId: thread.session.activeTurnId, state: "running", requestedAt: body.createdAt, startedAt: body.createdAt, completedAt: null };
              } else if (body.type === "thread.turn.interrupt") { assert.ok(body.turnId); thread.session.status = "interrupted"; }
              else assert.fail(`Unexpected command ${body.type}`);
            }
            receipts.set(body.commandId, ++sequence);
          }
          if (flags.dropCommand === body.type) { flags.dropCommand = ""; res.destroy(); return; }
          respond({ sequence: receipts.get(body.commandId) }); return;
        }
      }
      respond({ code: "not_found" }, 404);
    } catch (error) {
      validations.push(error as Error);
      res.writeHead(500); res.end("fake service assertion failed");
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = { stateDir, clerkOrigin: origin, relayOrigin: origin, jwtTemplate: "t3-relay" };
  const bridge = new Bridge(config);
  const login = async () => {
    const auth = <T>(run: (client: ClerkAuth) => Promise<T>) => bridge.store.locked((state, save) => run(new ClerkAuth(config, bridge.http, state, save)));
    let status = await auth(client => client.loginStart({ email: "person@example.test" }));
    while (status.status === "code_required") {
      const { loginId, factor } = status;
      status = await auth(client => client.loginVerify({ loginId, factor, code: "123456" }));
    }
    assert.equal(status.status, "signed_in");
  };
  const close = async () => { server.closeAllConnections(); server.close(); await once(server, "close"); await rm(stateDir, { recursive: true, force: true }); assert.deepEqual(validations, []); };
  return { bridge, config, login, close, flags, project, model, threads, requests, receipts, environmentTokens, relayTokens };
}
