import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

export function pnpm(args, options = {}) {
  return execFileSync('pnpm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

export function pack(destination) {
  // A consistent asset name supports GitHub's /releases/latest/download URL.
  const archive = resolve(destination, 't3code-mcp.tgz');
  pnpm(['pack', '--out', archive], { stdio: 'inherit' });
  return archive;
}
