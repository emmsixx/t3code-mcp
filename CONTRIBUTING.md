# Contributing

## Development

Use Node 22+ and [pnpm](https://pnpm.io/installation) on Linux or macOS. The `packageManager` field pins pnpm for development and CI; keep `pnpm-lock.yaml` committed.

```sh
git clone https://github.com/emmsixx/t3code-mcp.git
cd t3code-mcp
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm test
pnpm run test:package
pnpm run check:public
```

Tests use fake HTTP services and temporary credential directories. `test:package` installs a compiled tarball in an isolated pnpm home and requires registry access for dependencies. It does not use a real T3 account. Use `pnpm add` or `pnpm update` to change dependencies and include the updated lockfile in your pull request.

To use your checkout, run `node dist/cli.js login` in your terminal, then configure your MCP client with `command: node` and `args: ["/absolute/path/to/t3code-mcp/dist/cli.js", "serve"]`. Rebuild after changing source files.

## Scope

- Keep this package independent of a T3 checkout or fork. Treat upstream source as a versioned protocol reference.
- Keep auth/transport logic out of MCP tool handlers. Reserve stdout for the protocol when running `serve`.
- Preserve command IDs and payloads across retries; test ambiguous outcomes before changing mutation behavior.
- Do not run tests against a developer's real state directory. A real agent launch requires an explicit machine, project, and authorized task.
- Never commit credentials, verification codes, personal environment/thread IDs, raw live transcripts, or local handoffs. Keep local investigation material under ignored `.local/`.
- Explain the user-visible change, protocol assumptions, and validation in your pull request. Include an upstream source link for changes in wire contracts.

## Layout

- `src/auth.ts`, `src/dpop.ts`, `src/t3.ts`: authentication and T3 HTTP adapter.
- `src/store.ts`, `src/bridge.ts`: private state, operation journal, and application behavior.
- `src/server.ts`, `src/cli.ts`: MCP registration and terminal commands.
- `test/`: fake-service and MCP integration tests.
- `scripts/`: build, public-content checks, package validation, and release preparation.

## Commit messages

Always use Conventional Commits: `<type>[optional scope][!]: <description>`. Use the same format for PR titles that will become squash commit messages.

Examples:

- `feat: expose thread activity status`
- `fix(auth): resume interrupted login`
- `docs: clarify installation instructions`
- `chore(release): prepare v0.3.0`

Use `!` or a `BREAKING CHANGE:` footer for breaking changes.

## Releases

Releases are published by GitHub Actions when a maintainer pushes a `v*` tag. CI tests Node 22 and 24 on Linux and macOS before publishing the compiled package, checksum, and changelog notes. Publishing uses GitHub's built-in token.

1. Update the version with `pnpm version patch --no-git-tag-version` (or `minor`, `major`, or an explicit prerelease version). The package version lives in `package.json`; pnpm's lockfile records dependency resolutions.
2. Move the relevant changes from `Unreleased` into a dated `CHANGELOG.md` entry for that version.
3. Run the checks above, then prepare and test the release package:

   ```sh
   pnpm run release:prepare
   release_tag="v$(node -p "require('./package.json').version")"
   pnpm run test:package "release/$release_tag/t3code-mcp.tgz"
   ```

4. Review the generated notes and checksum in `release/$release_tag/`. Commit the version and changelog changes, merge them into `main`, and wait for CI to pass.
5. From the release commit, publish the matching tag:

   ```sh
   release_tag="v$(node -p "require('./package.json').version")"
   git tag -a "$release_tag" -m "Release $release_tag"
   git push origin "$release_tag"
   ```

The workflow rejects mismatched versions, stale dependency locks, and missing changelog entries, tests the exact archive, and uploads assets to a draft before publishing. Hyphenated versions are marked as prereleases. If publication fails after creating a draft, inspect its assets before completing it or deleting the incomplete draft and rerunning the unchanged tag. Never move a published tag or replace published assets.

Every release uses the asset name `t3code-mcp.tgz`; its tag and package metadata identify the version. This keeps the README's latest-release URL and agent prompt current without edits for each release. CLI output, MCP metadata, and the HTTP user-agent read the version from `package.json`.
