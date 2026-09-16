import { z } from "zod";
import { authBinding, type Config } from "./config.js";
import { BridgeError } from "./errors.js";
import { form, Http } from "./http.js";
import type { State } from "./store.js";

const factor = z.object({ strategy: z.string(), email_address_id: z.string().optional(), phone_number_id: z.string().optional() });
const signIn = z.object({
  id: z.string(), status: z.string(), created_session_id: z.string().nullable().optional(),
  supported_first_factors: z.array(factor).nullable().optional(),
  supported_second_factors: z.array(factor).nullable().optional(),
});
export type Prompt = (label: string) => Promise<string>;

export class ClerkAuth {
  constructor(private config: Config, private http: Http, private state: State, private save: () => Promise<void>) {}

  private async request<T>(path: string, schema: z.ZodType<T>, fields?: Record<string, string>) {
    if (this.state.auth && this.state.auth.binding !== authBinding(this.config)) {
      throw new BridgeError("config_mismatch", "Stored credentials belong to different endpoints. Use a separate T3_MCP_STATE_DIR.");
    }
    const url = new URL(path, this.config.clerkOrigin);
    url.searchParams.set("_is_native", "1");
    url.searchParams.set("__clerk_api_version", "2025-11-10");
    const init = fields ? form(fields) : {};
    const { data } = await this.http.request(url.toString(), z.unknown(), {
      ...init, headers: { ...init.headers, authorization: this.state.auth?.clientJwt ?? "" },
    }, async headers => {
      const clientJwt = headers.get("authorization");
      if (clientJwt) {
        this.state.auth = { ...this.state.auth, binding: authBinding(this.config), clientJwt };
        await this.save();
      }
    });
    const envelope = z.object({ response: z.unknown() }).safeParse(data);
    const decoded = schema.safeParse(envelope.success ? envelope.data.response : data);
    if (!decoded.success) throw new BridgeError("incompatible_auth_response", "Clerk returned an unsupported authentication response.");
    return decoded.data;
  }

  async login(prompt: Prompt) {
    if (this.state.auth?.sessionId) throw new BridgeError("already_signed_in", "Already signed in. Run logout before signing in to another account.");
    let attempt = await this.request("/v1/client/sign_ins", signIn, { identifier: (await prompt("T3 account email: ")).trim() });
    const emailFactor = attempt.supported_first_factors?.find(f => f.strategy === "email_code" && f.email_address_id);
    if (!emailFactor?.email_address_id) throw new BridgeError("unsupported_sign_in", "This account does not offer email-code sign-in. SSO-only and passkey-only sign-in are not implemented.");
    attempt = await this.request(`/v1/client/sign_ins/${encodeURIComponent(attempt.id)}/prepare_first_factor`, signIn, {
      strategy: "email_code", email_address_id: emailFactor.email_address_id,
    });
    attempt = await this.request(`/v1/client/sign_ins/${encodeURIComponent(attempt.id)}/attempt_first_factor`, signIn, {
      strategy: "email_code", code: (await prompt("Email verification code: ")).trim(),
    });
    if (attempt.status === "needs_second_factor") {
      const totp = attempt.supported_second_factors?.some(f => f.strategy === "totp");
      if (!totp) throw new BridgeError("unsupported_second_factor", "This account requires a second factor other than TOTP; this CLI does not support it yet.");
      attempt = await this.request(`/v1/client/sign_ins/${encodeURIComponent(attempt.id)}/attempt_second_factor`, signIn, {
        strategy: "totp", code: (await prompt("Authenticator code: ")).trim(),
      });
    }
    if (attempt.status !== "complete" || !attempt.created_session_id || !this.state.auth) {
      throw new BridgeError("incomplete_sign_in", "Sign-in needs an additional step that this CLI does not support.");
    }
    this.state.auth.sessionId = attempt.created_session_id;
    await this.save();
    await this.token();
  }

  async token(): Promise<string> {
    const sessionId = this.state.auth?.sessionId;
    if (!sessionId) throw new BridgeError("login_required", "Run t3code-mcp login in your terminal first.");
    const { jwt } = await this.request(`/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens/${encodeURIComponent(this.config.jwtTemplate)}`,
      z.object({ jwt: z.string().min(1) }), {});
    // Identity is used to namespace local operations, never to authorize a request.
    let subject: unknown;
    try { subject = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).sub; } catch { /* handled below */ }
    if (typeof subject !== "string" || !subject) throw new BridgeError("invalid_account_token", "The account token has no subject.");
    if (this.state.auth!.accountId && this.state.auth!.accountId !== subject) throw new BridgeError("account_changed", "Account identity changed unexpectedly; sign in again.");
    this.state.auth!.accountId = subject;
    await this.save();
    return jwt;
  }

  async logout() {
    if (this.state.auth?.sessionId) {
      try {
        await this.request(`/v1/client/sessions/${encodeURIComponent(this.state.auth.sessionId)}/end`, z.unknown(), {});
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "auth_required") throw error;
      }
    }
    delete this.state.auth;
    delete this.state.privateJwk;
    await this.save();
  }
}
