# Agent setup guide

Install the **latest stable release** of `emmsixx/t3code-mcp` and configure it for the user's MCP client. If the user requests a particular release, use that instead. Setup stops after read-only verification; launching a coding task requires the user's selected machine, project, and instructions.

## 1. Check the environment

```sh
node --version
pnpm --version
```

Require Node 22+ and pnpm on Linux or macOS. If pnpm is missing, follow its [installation instructions](https://pnpm.io/installation). Linux under WSL can be used for Windows hosts; run login and the MCP process in the same Linux environment. Ask which MCP client to configure if the current client cannot be determined. Inspect its existing configuration and preserve other entries.

## 2. Select and install a release

Read [the latest release](https://github.com/emmsixx/t3code-mcp/releases/latest), or fetch its metadata from `https://api.github.com/repos/emmsixx/t3code-mcp/releases/latest`. Public release metadata does not require GitHub authentication.

Record the release's `tag_name` and the `browser_download_url` of its `t3code-mcp.tgz` asset. Set `package_url` to that asset URL, which includes the resolved tag. Use this same release throughout setup so a newly published release cannot change versions halfway through. Read any compatibility notes in its release description.

```sh
pnpm add --global "$package_url"
t3code-mcp --version
command -v t3code-mcp
```

Check that `--version` matches the selected tag without its leading `v`. Distribution is through GitHub release assets; the bare npm registry name is not used by this project. If no release is available, report that instead of substituting a different package or a development checkout.

### Verify the release checksum

For an explicit checksum check, download `t3code-mcp.tgz` and `SHA256SUMS` from that same release into a fresh temporary directory, then install only after verification:

```sh
shasum -a 256 --check SHA256SUMS && pnpm add --global ./t3code-mcp.tgz
```

Proceed with installation only if the checksum passes. Linux users can use `sha256sum --check SHA256SUMS` instead. These checks detect a damaged or mismatched download; both files are distributed by the same release.

### Without a global install

Use the resolved asset URL for login and the MCP process:

```sh
pnpm --package="$package_url" dlx t3code-mcp login-status
```

```json
{
  "mcpServers": {
    "t3code": {
      "command": "pnpm",
      "args": [
        "--package=RELEASE_ASSET_URL",
        "dlx",
        "t3code-mcp",
        "serve"
      ]
    }
  }
}
```

Replace `RELEASE_ASSET_URL` with the full value of `package_url` before saving the configuration. Pinning the resolved release here keeps subsequent MCP launches on the installed version. To upgrade, resolve the latest release again and update this URL.

The initial dlx launch needs network access for the package and its dependencies. This mode does not need a global install. For global installs, run `pnpm setup` and reopen the terminal if the global bin directory is missing.

## 3. Guide the user through login

Run these commands on the machine hosting MCP, with the same OS user and state directory. For dlx, substitute the launch prefix from above for `t3code-mcp`. Each command finishes before you ask the user for the next reply; no terminal session needs to stay open.

First, check for an existing session:

```sh
t3code-mcp login-status
```

If it returns `{"status":"signed_in"}`, continue to MCP registration. If it returns `signed_out`, ask **“What's your T3 account email?”** Once the user replies, send it as JSON on stdin:

```sh
t3code-mcp login-start <<'JSON'
{"email":"person@example.test"}
JSON
```

Replace the example email with the user's answer, correctly JSON-encoded. Use a tool's stdin facility when available; otherwise a quoted heredoc prevents shell expansion. Do not interpolate unescaped input into shell commands or pass it as command-line arguments.

The result identifies the next step:

```json
{
  "status": "code_required",
  "loginId": "00000000-0000-4000-8000-000000000000",
  "factor": "email_code",
  "expiresAt": "2026-01-01T12:10:00.000Z"
}
```

Keep the **actual** returned `loginId` and `factor`. Ask **“What's the verification code from your email?”** Then submit the user's code as a string, preserving leading zeros:

```sh
t3code-mcp login-verify <<'JSON'
{"loginId":"00000000-0000-4000-8000-000000000000","factor":"email_code","code":"123456"}
JSON
```

Replace all example values with the current login's values. If the result is `code_required` with `factor: "totp"`, ask **“What's the code from your authenticator?”** Repeat `login-verify` using the returned factor and the new code. When it returns `{"status":"signed_in"}`, the local account session is ready.

### Resume and recover

| Result | Next step |
| --- | --- |
| `code_required` | Ask for the indicated code and retain the returned login ID and factor. |
| `signed_in` | Continue setup; the command has verified account-token issuance. |
| `expired` or `restart_required` | Run `logout`, then ask for the email again and start a fresh login. |
| `login_in_progress` | Run `login-status` to resume the existing attempt. |
| `login_mismatch` | Run `login-status`; use its current login ID and ask for the corresponding code. |
| Error reason `form_code_incorrect` | Ask for a corrected code. Keep the same login ID and factor. |
| Error reason `verification_expired` | Run `logout`, then start again with a fresh email code. |
| HTTP 429 | Pause before retrying; do not repeatedly request emails or submit codes. |
| Timeout or unreadable response | Run `login-status` before submitting another code. It reconciles the server's current step. |
| `auth_required` | The saved session is no longer usable. Run `logout` and sign in again. |

`login-status` resumes an interrupted conversation without sending another email. Pending attempts have a ten-minute local limit; the server may expire or reject a code sooner. `logout` also cancels a pending login, and revokes a session if verification completed before its response was lost. To change accounts, use `logout` before starting again. If cancellation fails, retain the state and retry once connectivity is restored.

The CLI never prints session tokens or saves the submitted email/code in its state. Do not read the state file, add credentials to MCP configuration, or automate an existing browser session. Users who prefer terminal prompts can run `t3code-mcp login`; it uses the same resumable flow.

If sign-in needs an unsupported method, report the error. The CLI supports email-code login and TOTP; it cannot complete SSO-only, passkey-only, other second-factor, or CAPTCHA flows. The user's T3 machines must already be linked through T3 Connect.

## 4. Register the stdio MCP server

For clients using the common JSON structure, merge:

```json
{
  "mcpServers": {
    "t3code": {
      "command": "t3code-mcp",
      "args": ["serve"]
    }
  }
}
```

For Hermes, merge into `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  t3code:
    command: t3code-mcp
    args: [serve]
```

Use the resolved absolute executable path if the client has a different PATH. Other clients may use a different configuration file or schema; follow that client's supported mechanism instead of overwriting a guessed file. For custom `T3_MCP_STATE_DIR`, set the same value during login and in the MCP entry's `env` object. Do not add credentials to configuration.

Restart or reconnect the MCP client. `serve` uses stdin/stdout for MCP; it does not expose a local HTTP port.

## 5. Verify and report

- Confirm the installed version and executable path.
- Confirm MCP tool discovery exposes all seven tools named in the README.
- Call `list_environments` (read-only). Optionally read projects and `list_threads` on a user-selected environment. Use a returned thread ID with `get_thread` when the user wants its conversation.
- Report the configuration location and whether discovery succeeded. Do not report tokens or publish the state directory.

If the agent cannot inspect the current client's tools, verify `t3code-mcp environments` and ask the user to reconnect their client; distinguish that CLI check from a completed MCP check. Zero environments means the account is signed in but has no linked machines. `login_required` means the process is using missing/different state. See [configuration and recovery](configuration.md) for other errors.
