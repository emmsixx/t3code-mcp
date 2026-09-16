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
pnpm --package="$package_url" dlx t3code-mcp login
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

## 3. Hand authentication to the user

Have the user run `t3code-mcp login` in an interactive terminal on the machine hosting the MCP process. They enter their T3 email and verification code there. Do not request the code in chat, pass credentials as arguments, read their state file, or automate their existing browser session.

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
- Confirm MCP tool discovery exposes all six tools named in the README.
- Call `list_environments` (read-only). Optionally read projects on a user-selected environment.
- Report the configuration location and whether discovery succeeded. Do not report tokens or publish the state directory.

If the agent cannot inspect the current client's tools, verify `t3code-mcp environments` and ask the user to reconnect their client; distinguish that CLI check from a completed MCP check. Zero environments means the account is signed in but has no linked machines. `login_required` means the process is using missing/different state. See [configuration and recovery](configuration.md) for other errors.
