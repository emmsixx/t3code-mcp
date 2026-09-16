import { chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compiler = resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [compiler, '-p', resolve(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
await chmod(resolve(root, 'dist/cli.js'), 0o755);
