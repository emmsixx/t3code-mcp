import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { BridgeError } from "./errors.js";
import { Store, type State } from "./store.js";
import { VERSION } from "./version.js";

export interface Target { environmentId: string; origin: string; key: string; accountId: string; binding: string; sessionId: string }

// T3 v0.1.2 serves discovery, registration and tokens on the MCP origin.
// Pin every request, including OAuth metadata URLs, before sending credentials.
export function endpointFetch(origin: string, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin || url.username || url.password || url.hash) throw new BridgeError("endpoint_mismatch", "The MCP server attempted to use a different origin.");
    const response = await fetcher(input, { ...init, redirect: "error", credentials: "omit",
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(init?.method === "DELETE" ? 2000 : 300_000)]) });
    const reader = response.body?.getReader();
    if (!reader) return response;
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) { controller.close(); reader.releaseLock(); return; }
          bytes += item.value.byteLength;
          if (bytes > 8_000_000) { await reader.cancel(); throw new BridgeError("response_too_large", "The MCP response exceeded 8 MB. Inspect T3 before retrying a mutation."); }
          controller.enqueue(item.value);
        } catch (error) { controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function bounded<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result)) > 4_000_000) throw new BridgeError("response_too_large", "The native tool result exceeded 4 MB. The call may have completed; inspect T3 before retrying.");
  return result;
}

export class NativeMcp {
  constructor(private store: Store, private target: Target) {}

  private checkAccount(state: State) {
    if (state.auth?.sessionId !== this.target.sessionId || state.auth?.accountId !== this.target.accountId || state.auth?.binding !== this.target.binding) {
      throw new BridgeError("account_changed", "The account changed during this operation. Start again with the current account.");
    }
  }

  async authorize(showAuthorization: (url: URL) => void | Promise<void>, timeoutMs = 300_000) {
    const { origin, environmentId, key } = this.target;
    const expectedState = randomUUID();
    const approval = new AbortController();
    let complete!: (code: string) => void, reject!: (error: unknown) => void;
    const callback = new Promise<string>((resolve, fail) => { complete = resolve; reject = fail; });
    void callback.catch(() => {});
    let redirectUrl = "";
    const listener = createServer((req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      let url: URL;
      try { url = new URL(req.url ?? "/", redirectUrl); }
      catch { res.writeHead(400); res.end("Invalid OAuth callback URL."); return; }
      if (req.method !== "GET" || req.headers.host !== new URL(redirectUrl).host || url.origin !== new URL(redirectUrl).origin || url.pathname !== "/callback" || url.searchParams.get("state") !== expectedState || url.searchParams.get("iss") !== origin) {
        res.writeHead(400); res.end("Invalid OAuth callback. Return to the sign-in page."); return;
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code || code.length > 8192) {
        res.writeHead(400); res.end("Authorization was denied or failed.");
        reject(new BridgeError("mcp_authorization_denied", "The machine did not approve MCP access.")); return;
      }
      res.end("Approval received. Return to your terminal to check the connection.");
      complete(code);
    });
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    redirectUrl = `http://127.0.0.1:${(listener.address() as { port: number }).port}/callback`;
    const timer = setTimeout(() => { approval.abort(); reject(new BridgeError("mcp_authorization_timeout", "MCP approval timed out. Run connect again.")); }, timeoutMs);
    let clientInfo: OAuthClientInformationMixed | undefined, tokens: OAuthTokens | undefined, verifier = "";
    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadata: { client_name: "T3 Connect MCP Gateway", redirect_uris: [redirectUrl], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" },
      state: () => expectedState,
      clientInformation: () => clientInfo,
      saveClientInformation: value => { clientInfo = value; },
      tokens: () => tokens,
      saveTokens: value => { tokens = value; },
      redirectToAuthorization: async url => {
        if (url.origin !== origin) throw new BridgeError("endpoint_mismatch", "The authorization page belongs to another origin.");
        await showAuthorization(url);
      },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => verifier,
    };
    const fetchNative = endpointFetch(origin);
    const options = { serverUrl: `${origin}/mcp`, fetchFn: ((input, init) => fetchNative(input, { ...init, signal: approval.signal })) as typeof fetch };
    try {
      if (await auth(provider, options) !== "REDIRECT") throw new BridgeError("mcp_authorization_failed", "The machine did not offer browser approval.");
      const code = await callback;
      if (await auth(provider, { ...options, authorizationCode: code }) !== "AUTHORIZED" || !tokens || tokens.token_type.toLowerCase() !== "bearer" || !tokens.expires_in || tokens.expires_in <= 0) {
        throw new BridgeError("mcp_authorization_failed", "The machine did not issue a supported expiring bearer credential.");
      }
      const approved = tokens;
      await this.store.locked(async (state, save) => {
        this.checkAccount(state);
        state.version = 3; // Older bridges must refuse to overwrite OAuth approvals.
        state.connections ??= {};
        state.connections[key] = { origin, accessToken: approved.access_token, expiresAt: Date.now() + approved.expires_in! * 1000, ...(approved.scope ? { scope: approved.scope } : {}) };
        await save();
      });
      return { environmentId, status: "connected", scope: approved.scope ?? null };
    } catch (error) {
      if (approval.signal.aborted) throw new BridgeError("mcp_authorization_timeout", "MCP approval timed out. Run connect again.");
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("mcp_authorization_failed", "MCP sign-in failed. Use a T3 release supporting outside agents, then run connect again. No remote error body is included.");
    } finally {
      clearTimeout(timer);
      approval.abort();
      listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  }

  private async connected<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const { origin, environmentId, key } = this.target;
    const saved = await this.store.locked(async state => { this.checkAccount(state); return state.connections?.[key]; });
    if (!saved || saved.expiresAt <= Date.now()) throw new BridgeError("mcp_login_required", "Approve this machine with t3connect-mcp connect <environmentId>.", { environmentId });
    if (saved.origin !== origin) throw new BridgeError("endpoint_changed", "This machine's address changed. Approve the new address with connect before sending credentials.", { environmentId });
    const client = new Client({ name: "t3connect-mcp", version: VERSION });
    // No auth provider or reconnection: an ordinary call cannot open approval,
    // upscope, or replay a mutation. A new call starts a new MCP connection.
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${saved.accessToken}` } },
      fetch: endpointFetch(origin), reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    try {
      await client.connect(transport);
      return bounded(await run(client));
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error instanceof StreamableHTTPError && error.code === 401) throw new BridgeError("mcp_login_required", "The machine rejected its saved approval. Run t3connect-mcp connect <environmentId> again.", { environmentId });
      throw new BridgeError("native_mcp_error", "The native MCP request failed or timed out. A tool call may have completed. Inspect T3 state before retrying; no automatic replay was attempted.", { environmentId });
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  }

  listTools(cursor?: string) { return this.connected(client => client.listTools(cursor ? { cursor } : {})); }
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
    return this.connected(async client => CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: timeoutMs, signal })));
  }
}
