# Account-wide authentication findings

Investigated September 15, 2026 against T3 `origin/main` at `37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2`. This integration uses account-wide login; per-machine pairing is not implemented. T3 source was used as a protocol reference and is not a runtime dependency.

## Why the existing CLI OAuth flow is insufficient

T3's hosted `/connect` flow returns a Clerk OAuth access/refresh token to a CLI using PKCE. Relay bearer authentication accepts that token for discovery. However, `/v1/client/dpop-token` directly verifies a Clerk JWT with the relay audience. It does not invoke the OAuth fallback used by the discovery handler.

The contract also recognizes only `t3-web` and `t3-mobile` as public clients. Therefore CLI login followed by relay discovery is insufficient evidence that environment connections work.

Source evidence:

- [CLI connect protocol](https://github.com/pingdotgg/t3code/blob/37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2/packages/shared/src/connectAuth.ts).
- [Relay token exchange and bearer verification](https://github.com/pingdotgg/t3code/blob/37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2/infra/relay/src/http/Api.ts): `tokenApi`, `verifyClerkBearerToken`, `verifyRelayClientBearerToken`, and `requireDpopPrincipalScope`.
- [Relay public client IDs and contracts](https://github.com/pingdotgg/t3code/blob/37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2/packages/contracts/src/relay.ts).

## Account flow implemented here

Clerk provides a native frontend API that owns a separate client session. Its native SDK sends `_is_native=1`, passes its client JWT directly in the `authorization` header, and saves replacement credentials from that response header. This is distinct from a short-lived session JWT. See [Clerk's native implementation](https://github.com/clerk/javascript/blob/main/packages/expo/src/provider/singleton/createClerkInstance.ts) and the [Frontend API reference](https://clerk.com/docs/reference/frontend-api).

The bridge uses that mechanism directly, with its own state directory:

1. `POST /v1/client/sign_ins` with the user's email; discover supported factors.
2. Prepare `email_code` for the returned email-address ID; prompt in the user's terminal.
3. Attempt the first factor, and TOTP if requested. Require `status: complete` and a created session ID. Retain the bridge's client JWT as it rotates, including on unsuccessful responses.
4. `POST /v1/client/sessions/:sessionId/tokens/t3-relay` to obtain the JWT template used by T3. Reissue this JWT from the owned native client session as needed.
5. `GET /v1/environments` with the Clerk JWT to discover the account's linked machines.
6. Generate a P-256 proof key owned by the bridge. Exchange the Clerk JWT at `/v1/client/dpop-token`, requesting `environment:connect environment:status`, `client_id=t3-web`, and an ES256 DPoP proof.
7. Select an environment ID. Request `/v1/environments/:id/connect` with the DPoP-bound relay token, a fresh proof including its access-token hash, and `clientProofKeyThumbprint` in the JSON body.
8. Verify the returned environment ID and endpoint against discovery. Exchange the bootstrap credential at the environment's `/oauth/token`, with a proof from the same key, for `orchestration:read orchestration:operate` access.
9. Send authenticated HTTP orchestration requests directly to that environment, each with a fresh proof and access-token hash. Reconnect when the environment token expires. No pairing credentials are stored or required.

The relay profile `t3-web` is intentionally visible in code and documentation. It does not provide a new MCP-specific client identity. No upstream app secret, browser token extraction, registration change, or relay deployment change is used. Whether T3 treats this as a supported external integration remains unestablished; the flow is experimental compatibility with existing public APIs.

## Public production checks performed

The initial investigation fetched these unauthenticated public resources:

- `https://app.t3.codes` and its referenced JavaScript assets expose the public Clerk key for `clerk.t3.codes`, template `t3-relay`, and relay `https://relay.t3.codes`.
- `GET https://clerk.t3.codes/v1/environment?__clerk_api_version=2025-11-10&_is_native=1` reported native API enabled, email-code first-factor support, and native device attestation disabled.
- `GET https://relay.t3.codes/.well-known/oauth-authorization-server` advertised `/v1/client/dpop-token`, public token exchange (`none` endpoint authentication), ES256 DPoP, and environment connection/status scopes.

Those initial observations established feasibility, not authenticated interoperability. The subsequent live check below verified this path for one real account. Account-specific sign-in restrictions and future deployment changes may still reject it.

## Authenticated live check — September 15, 2026

The user completed email-code login in their terminal. Account discovery returned three linked environments. Using the bridge's saved session, subsequent checks succeeded for all three:

- Reissue the `t3-relay` JWT from the owned native Clerk session.
- Exchange for a DPoP-bound relay token using `t3-web`.
- Probe each environment: all reported online.
- Connect through each tunnel, exchange its bootstrap credential for an environment session, and read projects through a real stdio MCP client/server connection.

The three environments spanned Linux and macOS and reported T3 nightly versions `0.0.41-nightly.20260915.1752` and `0.0.41-nightly.20260915.1780`. No per-environment pairing or upstream modification was needed. Personal machine names, identifiers, credentials, and verification codes are omitted from the public records.

## Protocol details that matter

- Clerk and both OAuth token exchanges use form encoding. Relay connect and orchestration dispatch use JSON.
- Clerk native authorization is the raw client credential; relay discovery uses `Bearer`; bound relay/environment requests use `DPoP`.
- The proof header includes only the public JWK. The thumbprint hashes canonical `{crv,kty,x,y}` JSON. Proof URLs exclude query strings/fragments. Each proof has a new `jti`; authenticated requests include `ath`.
- Node's ES256 signature is normalized to low-S because T3's verifier uses `@noble/curves` with canonical signature validation. Tests verify the signature and low-S property independently.
- [Environment token exchange](https://github.com/pingdotgg/t3code/blob/37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2/packages/contracts/src/auth.ts) uses subject type `urn:t3:params:oauth:token-type:environment-bootstrap`.
- [HTTP orchestration](https://github.com/pingdotgg/t3code/blob/37a8ab2b29dfa33b4e20ad709a9860f0da7b7eb2/apps/server/src/orchestration/http.ts) does not implement WebSocket launch bootstrap. This bridge submits `thread.create` and `thread.turn.start` separately, recording their exact payloads before dispatch.

## Live launch confirmation

A user authorized a reply-only smoke test in an existing project and selected Astra. `start_thread` used `codex / gpt-6-astra` with approval-required mode. T3 accepted both launch commands, started the provider, and completed the turn with `T3 MCP smoke test passed.`; `get_thread` retrieved the response over MCP. This confirms the account-to-environment-to-agent path for the tested deployment. See [the verification summary](verification.md).

## Remaining live validation

Real editing tasks, follow-up/interruption operations, mutation retries under real network failures, logout/re-login, and eventual session expiry/revocation still require live validation before describing the integration as production-ready.
