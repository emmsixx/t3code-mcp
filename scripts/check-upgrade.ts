import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeT3 } from '../test/fake.js';
import { pack, root } from './package-lib.mjs';

const repository = 'emmsixx/t3code-mcp';
const temporary = await mkdtemp(join(tmpdir(), 't3code-mcp-upgrade-'));
let fake: Awaited<ReturnType<typeof fakeT3>> | undefined;
let client: Client | undefined;
let assets: ReturnType<typeof createServer> | undefined;

async function download(url: string, authenticated = false): Promise<Buffer> {
  const response = await fetch(url, {
    headers: authenticated && process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `Download failed: HTTP ${response.status} for ${url}`);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body!) {
    length += chunk.length;
    assert.ok(length <= 20_000_000, 'Release download exceeded 20 MB.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function versionParts(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  assert.ok(match, 'Expected a semantic version.');
  return match.slice(1, 4).map(Number);
}
function compareVersions(a: string, b: string) {
  const left = versionParts(a), right = versionParts(b);
  return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
}
const archiveFile = (archive: Buffer, file: string) => execFileSync('tar', ['-xOzf', '-', `package/${file}`], { input: archive, encoding: 'utf8' });

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, input = '') {
  const child = spawn(command, args, { cwd: temporary, env, stdio: 'pipe', timeout: 180_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, `${command} ${args.join(' ')} failed:\n${stdout}\n${stderr}`);
  return stdout;
}

try {
  if (process.argv.length > 3) throw new Error('Usage: pnpm run test:upgrade [archive.tgz]');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const releases = JSON.parse((await download(`https://api.github.com/repos/${repository}/releases?per_page=100`, true)).toString());
  const previous = releases
    .filter((r: any) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name)
      && compareVersions(r.tag_name.slice(1), manifest.version) < 0)
    .sort((a: any, b: any) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
  assert.ok(previous, 'Upgrade verification needs an earlier stable GitHub release.');
  const previousVersion: string = previous.tag_name.slice(1);
  assert.ok(compareVersions(previousVersion, '0.2.0') >= 0, 'The upgrade baseline must support JSON login commands.');
  const base = `https://github.com/${repository}/releases/download/${previous.tag_name}/`;
  const [oldArchive, sums] = await Promise.all([download(`${base}t3code-mcp.tgz`), download(`${base}SHA256SUMS`)]);
  const checksum = /^([a-f0-9]{64})\s+\*?t3code-mcp\.tgz\s*$/m.exec(sums.toString());
  assert.ok(checksum, 'The earlier release has no package checksum.');
  assert.equal(createHash('sha256').update(oldArchive).digest('hex'), checksum[1]);
  const oldManifest = JSON.parse(archiveFile(oldArchive, 'package.json'));
  assert.equal(oldManifest.name, manifest.name); assert.equal(oldManifest.version, previousVersion);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(oldManifest.scripts?.[hook], undefined);
  const archivePath = process.argv[2] ? resolve(process.argv[2]) : pack(temporary);
  const newArchive = await readFile(archivePath);
  const newManifest = JSON.parse(archiveFile(newArchive, 'package.json'));
  assert.equal(newManifest.name, manifest.name); assert.equal(newManifest.version, manifest.version);

  // Serve actual release bytes through a moving URL, like GitHub's "latest" asset.
  // Both pnpm installs use the same URL, so stale resolution/cache bugs are observable.
  let servedArchive = oldArchive;
  assets = createServer((req, res) => {
    if (req.url !== '/releases/latest/download/t3code-mcp.tgz') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': servedArchive.length, 'cache-control': 'no-cache' });
    res.end(servedArchive);
  });
  assets.listen(0, '127.0.0.1'); await once(assets, 'listening');
  const assetUrl = `http://127.0.0.1:${(assets.address() as { port: number }).port}/releases/latest/download/t3code-mcp.tgz`;
  const pnpmHome = join(temporary, 'pnpm'), bin = join(pnpmHome, 'bin');
  await mkdir(bin, { recursive: true });
  const installEnv = { ...process.env, PNPM_HOME: pnpmHome, PATH: `${dirname(process.execPath)}${delimiter}${bin}${delimiter}${process.env.PATH ?? ''}` };
  delete installEnv.GH_TOKEN; delete installEnv.GITHUB_TOKEN;
  assert.equal((await run('pnpm', ['bin', '--global'], installEnv)).trim(), bin);
  assert.ok((await run('pnpm', ['root', '--global'], installEnv)).trim().startsWith(`${temporary}/`));
  const executable = join(bin, 't3code-mcp');
  fake = await fakeT3();
  const env = {
    PATH: installEnv.PATH, T3_MCP_STATE_DIR: fake.config.stateDir,
    T3_MCP_CLERK_ORIGIN: fake.config.clerkOrigin, T3_MCP_RELAY_ORIGIN: fake.config.relayOrigin, T3_MCP_JWT_TEMPLATE: 't3-relay',
  };
  const cli = async (command: string, input?: unknown) => JSON.parse(await run(executable, [command], env, input ? JSON.stringify(input) : ''));
  async function connect() {
    const transport = new StdioClientTransport({ command: executable, args: ['serve'], cwd: temporary, env, stderr: 'pipe' });
    transport.stderr?.resume();
    const connected = new Client({ name: 'upgrade-check', version: '1.0.0' });
    client = connected;
    await connected.connect(transport);
    return connected;
  }
  await run('pnpm', ['add', '--global', assetUrl], installEnv);
  assert.equal((await run(executable, ['--version'], env)).trim(), previousVersion);
  const login = await cli('login-start', { email: 'person@example.test' });
  assert.equal(login.status, 'code_required');
  assert.deepEqual(await cli('login-verify', { loginId: login.loginId, factor: login.factor, code: '123456' }), { status: 'signed_in' });
  const beforeClient = await connect();
  assert.equal(beforeClient.getServerVersion()?.version, previousVersion);
  const operation = { operationId: 'upgrade-retry', environmentId: 'env-1', projectId: 'project-1', title: 'Upgrade fixture', instructions: 'Reply with the fixture response.' };
  fake.flags.dropCommand = 'thread.create';
  const interrupted = await beforeClient.callTool({ name: 'start_thread', arguments: operation });
  assert.equal(interrupted.isError, true);
  assert.match(JSON.stringify(interrupted.content), /operation_incomplete/);
  assert.equal(fake.threads.size, 1);
  const threadId = [...fake.threads.keys()][0];
  await beforeClient.close(); client = undefined;
  const statePath = join(fake.config.stateDir, 'state.json');
  const savedState = await readFile(statePath, 'utf8');

  // Parse only the documented, allowlisted pnpm command; never execute Markdown as shell code.
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const upgradeSection = readme.split('## Upgrade or uninstall\n')[1]?.split('\n## ')[0];
  const command = /^pnpm (add --global(?: --force)?) https:\/\/github\.com\/emmsixx\/t3code-mcp\/releases\/latest\/download\/t3code-mcp\.tgz$/m.exec(upgradeSection ?? '');
  assert.ok(command, 'Document an explicit pnpm upgrade command in README.md.');
  servedArchive = newArchive;
  await run('pnpm', [...command[1]!.split(' '), assetUrl], installEnv);
  assert.equal((await run(executable, ['--version'], env)).trim(), manifest.version, 'The documented upgrade command left the previous version installed.');
  assert.equal(await readFile(statePath, 'utf8'), savedState, 'Installing an upgrade changed the saved login or journal.');
  assert.deepEqual(await cli('login-status'), { status: 'signed_in' });
  const afterClient = await connect();
  assert.equal(afterClient.getServerVersion()?.version, manifest.version);
  assert.deepEqual((await afterClient.listTools()).tools.map(t => t.name).sort(), [
    'get_thread', 'interrupt_thread', 'list_environments', 'list_projects', 'list_threads', 'send_message', 'start_thread',
  ]);
  const environments = await afterClient.callTool({ name: 'list_environments', arguments: {} });
  assert.equal(environments.isError, undefined);
  const resumed = await afterClient.callTool({ name: 'start_thread', arguments: operation });
  assert.equal(resumed.isError, undefined); assert.equal((resumed.structuredContent as any).threadId, threadId);
  assert.equal(fake.threads.size, 1); assert.equal(fake.receipts.size, 2);
  const listed = await afterClient.callTool({ name: 'list_threads', arguments: { environmentId: 'env-1' } });
  assert.equal(listed.isError, undefined); assert.equal((listed.structuredContent as any).threads[0].threadId, threadId);
  assert.equal(fake.requests.filter(r => r.path === '/v1/client/sign_ins' && r.method === 'POST').length, 1);
  const finalState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(finalState.auth.sessionId, JSON.parse(savedState).auth.sessionId);
  assert.deepEqual(finalState.privateJwk, JSON.parse(savedState).privateJwk);
  const originalOperation: any = Object.values(JSON.parse(savedState).operations)[0];
  const resumedOperation: any = Object.values(finalState.operations)[0];
  assert.deepEqual(resumedOperation.commands, originalOperation.commands);
  console.log(`Upgrade verified: ${previousVersion} → ${manifest.version}; saved login, proof key, pending operation, and seven MCP tools verified.`);
} finally {
  try { await client?.close(); }
  finally {
    try { await fake?.close(); }
    finally {
      if (assets?.listening) { assets.closeAllConnections(); assets.close(); await once(assets, 'close'); }
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
