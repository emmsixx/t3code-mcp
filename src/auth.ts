import { z } from "zod";
import { randomUUID } from "node:crypto";
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
export const loginStartInput = z.strictObject({ email: z.string().trim().max(320).pipe(z.email()) });
export const loginVerifyInput = z.strictObject({
  loginId: z.uuid(), factor: z.enum(["email_code", "totp"]), code: z.string().trim().regex(/^\d{6}$/),
});
export type LoginStatus =
  | { status: "signed_out" | "signed_in" }
  | { status: "code_required"; loginId: string; factor: "email_code" | "totp"; expiresAt: string }
  | { status: "expired" | "restart_required"; loginId: string };

export class ClerkAuth {
  constructor(private config: Config, private http: Http, private state: State, private save: () => Promise<void>) {}

  private async request<T>(path: string, schema: z.ZodType<T>, fields?: Record<string, string>) {
    this.checkBinding();
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
    }).catch(error => {
      if (error instanceof BridgeError && error.code === "transport_error") {
        throw new BridgeError("transport_error", "The authentication request failed or timed out. If signing in, run login-status before submitting another code.");
      }
      throw error;
    });
    const envelope = z.object({ response: z.unknown() }).safeParse(data);
    const decoded = schema.safeParse(envelope.success ? envelope.data.response : data);
    if (!decoded.success) throw new BridgeError("incompatible_auth_response", "Clerk returned an unsupported authentication response.");
    return decoded.data;
  }

  private checkBinding() {
    if (this.state.auth && this.state.auth.binding !== authBinding(this.config)) {
      throw new BridgeError("config_mismatch", "Stored credentials belong to different endpoints. Use a separate T3_MCP_STATE_DIR.");
    }
  }

  private pendingStatus(): LoginStatus {
    const pending = this.state.auth?.pendingLogin;
    if (!pending) return { status: "signed_out" };
    if (Date.now() >= pending.expiresAt) return { status: "expired", loginId: pending.loginId };
    if (pending.factor === "preparing") return { status: "restart_required", loginId: pending.loginId };
    return { status: "code_required", loginId: pending.loginId, factor: pending.factor, expiresAt: new Date(pending.expiresAt).toISOString() };
  }

  private async acceptAttempt(attempt: z.infer<typeof signIn>): Promise<LoginStatus> {
    const pending = this.state.auth?.pendingLogin;
    if (!pending || attempt.id !== pending.signInId) throw new BridgeError("incompatible_auth_response", "Clerk returned a different sign-in attempt.");
    if (attempt.status === "complete" && attempt.created_session_id) {
      this.state.auth!.sessionId = attempt.created_session_id;
      await this.save();
      return this.finishLogin();
    }
    if (attempt.status === "needs_second_factor") {
      if (!attempt.supported_second_factors?.some(f => f.strategy === "totp")) {
        throw new BridgeError("unsupported_second_factor", "This account requires a second factor other than TOTP; this CLI does not support it yet.");
      }
      this.state.auth!.pendingLogin!.factor = "totp";
      await this.save();
    } else if (attempt.status !== "needs_first_factor") {
      throw new BridgeError("incomplete_sign_in", "Sign-in needs an additional step that this CLI does not support.");
    } else if (pending.factor === "totp") {
      throw new BridgeError("incompatible_auth_response", "The sign-in unexpectedly returned to its first factor.");
    }
    return this.pendingStatus();
  }

  private async finishLogin(): Promise<LoginStatus> {
    await this.token();
    delete this.state.auth!.pendingLogin;
    await this.save();
    return { status: "signed_in" };
  }

  async loginStatus(): Promise<LoginStatus> {
    this.checkBinding();
    if (this.state.auth?.sessionId) return this.finishLogin();
    const pending = this.state.auth?.pendingLogin;
    if (!pending) return { status: "signed_out" };
    // Reconcile the remote attempt before a retry: its previous response may have been lost.
    try {
      return await this.acceptAttempt(await this.request(`/v1/client/sign_ins/${encodeURIComponent(pending.signInId)}`, signIn));
    } catch (error) {
      if (error instanceof BridgeError && error.code === "http_error" && error.details.status === 404 && !this.state.auth?.sessionId) {
        return { status: "expired", loginId: pending.loginId };
      }
      throw error;
    }
  }

  async loginStart(input: z.infer<typeof loginStartInput>): Promise<LoginStatus> {
    this.checkBinding();
    if (this.state.auth?.sessionId) throw new BridgeError("already_signed_in", "Already signed in. Run logout before signing in to another account.");
    if (this.state.auth?.pendingLogin) throw new BridgeError("login_in_progress", "Run login-status to resume, or logout to discard the pending login before starting again.");
    let attempt = await this.request("/v1/client/sign_ins", signIn, { identifier: input.email });
    const emailFactor = attempt.supported_first_factors?.find(f => f.strategy === "email_code" && f.email_address_id);
    if (!emailFactor?.email_address_id) throw new BridgeError("unsupported_sign_in", "This account does not offer email-code sign-in. SSO-only and passkey-only sign-in are not implemented.");
    if (!this.state.auth) throw new BridgeError("incompatible_auth_response", "Clerk did not issue a native client credential.");
    this.state.auth.pendingLogin = { loginId: randomUUID(), signInId: attempt.id, expiresAt: Date.now() + 10 * 60_000, factor: "preparing" };
    await this.save();
    attempt = await this.request(`/v1/client/sign_ins/${encodeURIComponent(attempt.id)}/prepare_first_factor`, signIn, {
      strategy: "email_code", email_address_id: emailFactor.email_address_id,
    });
    // request() replaces auth when credentials rotate, so always read its current value.
    this.state.auth.pendingLogin!.factor = "email_code";
    await this.save();
    return this.acceptAttempt(attempt);
  }

  async loginVerify(input: z.infer<typeof loginVerifyInput>): Promise<LoginStatus> {
    this.checkBinding();
    if (this.state.auth?.sessionId) return this.finishLogin();
    if (!this.state.auth?.pendingLogin) throw new BridgeError("login_required", "Run login-start first.");
    if (this.state.auth.pendingLogin.loginId !== input.loginId) throw new BridgeError("login_mismatch", "This code belongs to a different login attempt. Run login-status.");
    const status = await this.loginStatus();
    if (status.status !== "code_required") return status;
    // An email-code retry must never be submitted as an authenticator code after a lost response.
    if (status.factor !== input.factor) return status;
    const pending = this.state.auth!.pendingLogin!;
    const action = input.factor === "email_code" ? "attempt_first_factor" : "attempt_second_factor";
    return this.acceptAttempt(await this.request(`/v1/client/sign_ins/${encodeURIComponent(pending.signInId)}/${action}`, signIn, {
      strategy: input.factor, code: input.code,
    }));
  }

  async token(): Promise<string> {
    const sessionId = this.state.auth?.sessionId;
    if (!sessionId) throw new BridgeError("login_required", "Sign in with t3code-mcp login, or use login-start and login-verify for agent-guided setup.");
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
    // A verification may have completed even when its response was unreadable.
    const pending = this.state.auth?.pendingLogin;
    if (pending && !this.state.auth?.sessionId) {
      try {
        const attempt = await this.request(`/v1/client/sign_ins/${encodeURIComponent(pending.signInId)}`, signIn);
        if (attempt.id !== pending.signInId) throw new BridgeError("incompatible_auth_response", "Clerk returned a different sign-in attempt.");
        if (attempt.status === "complete" && attempt.created_session_id) {
          this.state.auth!.sessionId = attempt.created_session_id;
          await this.save();
        }
      } catch (error) {
        if (!(error instanceof BridgeError) || (error.code !== "auth_required" && error.details.status !== 404)) throw error;
      }
    }
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
