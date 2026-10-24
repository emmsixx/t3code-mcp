import { z } from "zod";
import type { Config } from "./config.js";
import type { ClerkAuth } from "./auth.js";
import { Dpop } from "./dpop.js";
import { BridgeError } from "./errors.js";
import { form, Http } from "./http.js";
import * as c from "./contracts.js";

type Token = { value: string; expiresAt: number };
export interface TokenCache { identity?: string; relay?: Token }
const grant = "urn:ietf:params:oauth:grant-type:token-exchange";
const accessType = "urn:ietf:params:oauth:token-type:access_token";
const relayScopes = "environment:status";

export class T3Api {
  private relayPending?: Promise<string>;
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
      if (!relayScopes.split(" ").every(s => data.scope.split(" ").includes(s))) throw new BridgeError("insufficient_scope", "The relay did not grant environment status access.");
      this.cache.relay = { value: data.access_token, expiresAt: started + data.expires_in * 1000 };
      return data.access_token;
    })().finally(() => { this.relayPending = undefined; });
    return this.relayPending;
  }

  private async relayRequest<T>(path: string, schema: z.ZodType<T>) {
    const token = await this.relayToken();
    const url = `${this.config.relayOrigin}${path}`;
    const init = { method: "POST" };
    try {
      return (await this.http.request(url, schema, {
        ...init, headers: { authorization: `DPoP ${token}`, dpop: this.signer.proof("POST", url, token) },
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
}
