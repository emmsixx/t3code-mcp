import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pnpm, pack, root } from './package-lib.mjs';

const temporary = await mkdtemp(join(tmpdir(), 't3code-mcp-package-'));
let client;
try {
  if (process.argv.length > 3) throw new Error('Usage: pnpm run test:package [archive.tgz]');
  const archive = process.argv[2] ? resolve(process.argv[2]) : pack(temporary);
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const allowed = /^package\/(?:package\.json|README\.md|LICENSE|NOTICE|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md|docs\/(?:agent-setup|configuration|tools|authentication|verification)\.md|dist\/[a-z][a-z0-9-]*\.(?:js|d\.ts))$/;
  for (const name of names) assert.match(name, allowed, `Unexpected package entry: ${name}`);
  for (const name of ['package.json', 'dist/cli.js', 'dist/server.js', 'dist/version.js', 'LICENSE', 'NOTICE', 'docs/agent-setup.md']) {
    assert.ok(names.includes(`package/${name}`), `Missing package entry: ${name}`);
  }

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packed = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(packed.name, 't3code-mcp');
  assert.equal(packed.version, manifest.version, 'Archive version must match this checkout.');
  assert.equal(packed.license, 'MIT');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(packed.scripts?.[hook], undefined, `Release must not require an install-time ${hook} script.`);
  }
  const pnpmHome = join(temporary, 'pnpm');
  const bin = join(pnpmHome, 'bin');
  await mkdir(bin, { recursive: true });
  const installEnv = { ...process.env, PNPM_HOME: pnpmHome, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
  const installOptions = { cwd: temporary, env: installEnv };
  // Check isolation before a global installation can write anything.
  assert.equal(pnpm(['bin', '--global'], installOptions).trim(), bin);
  assert.ok(pnpm(['root', '--global'], installOptions).trim().startsWith(`${temporary}/`));
  pnpm(['add', '--global', '--ignore-scripts', archive], installOptions);
  const executable = join(bin, 't3code-mcp');
  const env = {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    T3_MCP_STATE_DIR: join(temporary, 'state'),
  };
  const run = args => execFileSync(executable, args, { cwd: temporary, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run(['--version']).trim(), manifest.version);
  assert.match(run(['--help']), /Sign in with an email code/);
  assert.match(run(['--help']), /login-start/);
  assert.deepEqual(JSON.parse(run(['login-status'])), { status: 'signed_out' });

  for (const launch of [
    { command: executable, args: ['serve'], env },
    { command: 'pnpm', args: [`--package=${archive}`, 'dlx', 't3code-mcp', 'serve'], env: { ...installEnv, ...env } },
  ]) {
    const transport = new StdioClientTransport({ ...launch, cwd: temporary, stderr: 'pipe' });
    client = new Client({ name: 'installed-package-check', version: '1.0.0' });
    // Drain pnpm's install progress on stderr; stdout must remain valid MCP.
    transport.stderr?.resume();
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, manifest.version);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
      'get_thread', 'interrupt_thread', 'list_environments', 'list_projects', 'send_message', 'start_thread',
    ]);
    const result = await client.callTool({ name: 'list_environments', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /login_required/);
    await client.close();
    client = undefined;
  }
  console.log(`Package verified: ${packed.name}@${packed.version}, ${names.length} files; global install and pnpm dlx expose all six MCP tools.`);
} finally {
  try { await client?.close(); } finally { await rm(temporary, { recursive: true, force: true }); }
}
