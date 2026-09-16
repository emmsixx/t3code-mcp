import { z } from "zod";
import type { Config } from "./config.js";
import { secureOrigin } from "./config.js";
import type { ClerkAuth } from "./auth.js";
import { Dpop } from "./dpop.js";
import { BridgeError } from "./errors.js";
import { form, Http, jsonBody } from "./http.js";
import * as c from "./contracts.js";
import type { Orchestration } from "./orchestration.js";
import { V1Orchestration } from "./protocol-v1.js";
import { V2Orchestration } from "./protocol-v2.js";
import { unaryRpc } from "./rpc.js";

type Token = { value: string; expiresAt: number };
type EnvironmentSession = Token & { origin: string; wsUrl: string };
export interface TokenCache { identity?: string; relay?: Token; environments: Map<string, EnvironmentSession> }
const grant = "urn:ietf:params:oauth:grant-type:token-exchange";
const accessType = "urn:ietf:params:oauth:token-type:access_token";
const relayScopes = "environment:connect environment:status";

export class T3Api {
  private relayPending?: Promise<string>;
  private environmentPending = new Map<string, Promise<EnvironmentSession>>();
  // T3Api is created per bridge call: detect upgrades again on the next call.
  private adapters = new Map<string, Promise<Orchestration>>();
  constructor(private config: Config, private http: Http, private auth: ClerkAuth, private signer: Dpop, private cache: TokenCache) {}

  async environments() {
    const token = await this.auth.token();
    return (await this.http.request(`${this.config.relayOrigin}/v1/environments`, c.environmentList, {
      headers: { authorization: `Bearer ${token}` },
    })).data.environments;
  }

  private relayToken(): Promise<string> {
    if (this.cache.relay && this.cache.relay.expiresAt > Date.now() + 30_000) return Promise.resolve(this.cache.relay.value);
    if (this.relayPending) return this.relayPending;
    this.relayPending = (async () => {
      const url = `${this.config.relayOrigin}/v1/client/dpop-token`;
      const request = form({
        grant_type: grant, subject_token: await this.auth.token(),
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt", requested_token_type: accessType,
        resource: this.config.relayOrigin, scope: relayScopes, client_id: "t3-web",
      });
      const started = Date.now();
      const { data } = await this.http.request(url, c.tokenResponse, {
        ...request, headers: { ...request.headers, dpop: this.signer.proof("POST", url) },
      });
      if (!relayScopes.split(" ").every(s => data.scope.split(" ").includes(s))) throw new BridgeError("insufficient_scope", "The relay did not grant environment connection and status access.");
      this.cache.relay = { value: data.access_token, expiresAt: started + data.expires_in * 1000 };
      return data.access_token;
    })().finally(() => { this.relayPending = undefined; });
    return this.relayPending;
  }

  private async relayRequest<T>(path: string, schema: z.ZodType<T>, body?: unknown) {
    const token = await this.relayToken();
    const url = `${this.config.relayOrigin}${path}`;
    const init = body === undefined ? { method: "POST" } : jsonBody(body);
    try {
      return (await this.http.request(url, schema, {
        ...init, headers: { ...init.headers, authorization: `DPoP ${token}`, dpop: this.signer.proof("POST", url, token) },
      })).data;
    } catch (error) {
      if (error instanceof BridgeError && error.code === "auth_required") delete this.cache.relay;
      throw error;
    }
  }

  async status(environmentId: string) {
    const status = await this.relayRequest(`/v1/environments/${encodeURIComponent(environmentId)}/status`, z.object({
      environmentId: c.id, status: z.enum(["online", "offline"]), checkedAt: z.string(),
    }));
    if (status.environmentId !== environmentId) throw new BridgeError("identity_mismatch", "Relay returned a different environment ID.");
    return status;
  }

  private environmentSession(environmentId: string): Promise<EnvironmentSession> {
    const cached = this.cache.environments.get(environmentId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return Promise.resolve(cached);
    const pending = this.environmentPending.get(environmentId);
    if (pending) return pending;
    const request = (async () => {
      const environments = await this.environments();
      const selected = environments.find(e => e.environmentId === environmentId);
      if (!selected) throw new BridgeError("environment_not_found", "This environment is not linked to the signed-in account.");
      const connection = await this.relayRequest(`/v1/environments/${encodeURIComponent(environmentId)}/connect`, c.connection, {
        clientProofKeyThumbprint: this.signer.thumbprint,
      });
      const origin = secureOrigin(connection.endpoint.httpBaseUrl);
      if (connection.environmentId !== environmentId || origin !== secureOrigin(selected.endpoint.httpBaseUrl)) {
        throw new BridgeError("identity_mismatch", "The relay connection does not match the selected environment.");
      }
      const url = `${origin}/oauth/token`;
      const init = form({ grant_type: grant, subject_token: connection.credential,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap", requested_token_type: accessType,
        scope: "orchestration:read orchestration:operate", client_label: "T3 Code MCP", client_device_type: "desktop" });
      const started = Date.now();
      const { data } = await this.http.request(url, c.tokenResponse, {
        ...init, headers: { ...init.headers, dpop: this.signer.proof("POST", url) },
      });
      if (!["orchestration:read", "orchestration:operate"].every(s => data.scope.split(" ").includes(s))) throw new BridgeError("insufficient_scope", "The environment did not grant orchestration access.");
      const ws = new URL(connection.endpoint.wsBaseUrl);
      const wsOrigin = secureOrigin(ws.origin.replace(/^ws:/, "http:").replace(/^wss:/, "https:"));
      if (wsOrigin !== origin || !["ws:", "wss:"].includes(ws.protocol) || ws.username || ws.password || ws.search || ws.hash || ws.pathname !== "/ws" || connection.endpoint.wsBaseUrl !== selected.endpoint.wsBaseUrl) {
        throw new BridgeError("identity_mismatch", "The WebSocket endpoint does not match the selected environment.");
      }
      const session = { origin, wsUrl: ws.href, value: data.access_token, expiresAt: started + data.expires_in * 1000 };
      this.cache.environments.set(environmentId, session);
      return session;
    })().finally(() => { this.environmentPending.delete(environmentId); });
    this.environmentPending.set(environmentId, request);
    return request;
  }

  private async request<T>(environmentId: string, path: string, schema: z.ZodType<T>, body?: unknown, protocol?: number): Promise<T> {
    const session = await this.environmentSession(environmentId);
    const url = `${session.origin}${path}`;
    const method = body === undefined ? "GET" : "POST";
    const init = body === undefined ? {} : jsonBody(body);
    try {
      return (await this.http.request(url, schema, {
        ...init, headers: { ...init.headers, ...(protocol ? { "x-t3-orchestration-protocol": String(protocol) } : {}),
          authorization: `DPoP ${session.value}`, dpop: this.signer.proof(method, url, session.value) },
      })).data;
    } catch (error) {
      if (error instanceof BridgeError && error.code === "auth_required") this.cache.environments.delete(environmentId);
      throw error;
    }
  }

  orchestration(environmentId: string): Promise<Orchestration> {
    const existing = this.adapters.get(environmentId);
    if (existing) return existing;
    const pending = (async () => {
      const descriptor = await this.request(environmentId, "/.well-known/t3/environment", z.object({
        environmentId: c.id, orchestrationProtocolVersion: z.number().int().optional(),
      }));
      if (descriptor.environmentId !== environmentId) throw new BridgeError("identity_mismatch", "The descriptor names another environment.");
      const version = descriptor.orchestrationProtocolVersion ?? 1;
      if (version !== 1 && version !== 2) throw new BridgeError("unsupported_protocol", "This environment uses an unsupported orchestration protocol.", { environmentId, protocolVersion: version });
      const transport = {
        request: <T>(path: string, schema: z.ZodType<T>, body?: unknown) => this.request(environmentId, path, schema, body, version === 2 ? 2 : undefined),
        rpc: async <T>(method: string, payload: Record<string, unknown>, schema: z.ZodType<T>) => {
          const ticket = await this.request(environmentId, "/api/auth/websocket-ticket", z.object({ ticket: z.string().min(1) }), {});
          const session = this.cache.environments.get(environmentId)!;
          const url = new URL(session.wsUrl);
          url.searchParams.set("wsTicket", ticket.ticket);
          url.searchParams.set("orchestrationProtocol", "2");
          return unaryRpc(url.href, method, payload, schema);
        },
      };
      return version === 2 ? new V2Orchestration(transport) : new V1Orchestration(transport);
    })();
    this.adapters.set(environmentId, pending);
    return pending;
  }
}
