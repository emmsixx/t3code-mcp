import { ClerkAuth } from "./auth.js";
import { authBinding, secureOrigin, type Config } from "./config.js";
import { Dpop, generateDpopKey, hash } from "./dpop.js";
import { BridgeError, errorResult } from "./errors.js";
import { Http } from "./http.js";
import { Store, type State } from "./store.js";
import { T3Api, type TokenCache } from "./t3.js";
import { NativeMcp, type Target } from "./native-mcp.js";

export class Bridge {
  private cache: TokenCache = {};
  constructor(public config: Config, public store = new Store(config.stateDir), public http = new Http()) {}

  private run<T>(fn: (api: T3Api, state: State) => Promise<T>) {
    return this.store.locked(async (state, save) => {
      if (!state.auth?.sessionId) throw new BridgeError("login_required", "Sign in with t3connect-mcp login, or use login-start and login-verify.");
      if (state.auth.binding !== authBinding(this.config)) throw new BridgeError("config_mismatch", "Credentials belong to a different deployment. Use a separate state directory.");
      if (!state.privateJwk) { state.privateJwk = generateDpopKey(); await save(); }
      const signer = new Dpop(state.privateJwk);
      const identity = `${state.auth.sessionId}:${signer.thumbprint}`;
      if (this.cache.identity !== identity) this.cache = { identity };
      return fn(new T3Api(this.config, this.http, new ClerkAuth(this.config, this.http, state, save), signer, this.cache), state);
    });
  }

  listEnvironments(input: { offset: number; limit: number; checkAvailability: boolean }) {
    return this.run(async (api, state) => {
      const all = await api.environments();
      const page = all.slice(input.offset, input.offset + input.limit);
      const environments = [];
      for (const item of page) {
        const origin = secureOrigin(item.endpoint.httpBaseUrl);
        const saved = state.connections?.[this.connectionKey(state, item.environmentId)];
        let availability: Record<string, unknown> = { status: "unchecked" };
        if (input.checkAvailability) {
          try { availability = await api.status(item.environmentId); }
          catch (error) { availability = { status: "unavailable", error: errorResult(error) }; }
        }
        environments.push({ environmentId: item.environmentId, label: item.label.slice(0, 200), endpoint: origin,
          mcpUrl: `${origin}/mcp`, mcpAuthorization: !saved ? "not_connected" : saved.origin !== origin ? "endpoint_changed" : saved.expiresAt <= Date.now() ? "expired" : "connected", ...availability });
      }
      return { environments, total: all.length, nextOffset: input.offset + page.length < all.length ? input.offset + page.length : null };
    });
  }

  private connectionKey(state: State, environmentId: string) {
    return hash(JSON.stringify([authBinding(this.config), state.auth!.accountId, environmentId]));
  }

  private target(environmentId: string): Promise<Target> {
    return this.run(async (api, state) => {
      const item = (await api.environments()).find(e => e.environmentId === environmentId);
      if (!item) throw new BridgeError("environment_not_found", "This environment is not linked to the signed-in account.");
      return { environmentId, origin: secureOrigin(item.endpoint.httpBaseUrl), key: this.connectionKey(state, environmentId),
        accountId: state.auth!.accountId!, binding: state.auth!.binding, sessionId: state.auth!.sessionId! };
    });
  }

  async connect(environmentId: string, showAuthorization: (url: URL) => void | Promise<void>) {
    return new NativeMcp(this.store, await this.target(environmentId)).authorize(showAuthorization);
  }

  async disconnect(environmentId: string) {
    const target = await this.target(environmentId);
    await this.store.locked(async (state, save) => { delete state.connections?.[target.key]; await save(); });
    return { environmentId, status: "disconnected", next: "Revoke the gateway client in this machine's T3 Settings → Connections to revoke remote access too." };
  }

  async listTools(input: { environmentId: string; cursor?: string }) {
    const native = new NativeMcp(this.store, await this.target(input.environmentId));
    return { environmentId: input.environmentId, ...await native.listTools(input.cursor) };
  }

  async callTool(input: { environmentId: string; name: string; arguments: Record<string, unknown>; timeoutMs: number }, signal?: AbortSignal) {
    return new NativeMcp(this.store, await this.target(input.environmentId)).callTool(input.name, input.arguments, input.timeoutMs, signal);
  }
}
