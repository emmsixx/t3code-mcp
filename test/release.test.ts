import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../scripts/release-lib.mjs';

test('release gate rejects mismatched tags and missing version notes', () => {
  const manifest = { name: 't3code-mcp', version: '0.1.0', license: 'MIT' };
  const changelog = '# Changelog\n\n## [Unreleased]\n\nFuture work\n\n## [0.1.0] - 2026-09-15\n\nInitial release.\n\n## [0.0.1] - 2026-09-01\n\nOlder release.\n';
  assert.deepEqual(validateRelease(manifest, changelog, 'v0.1.0'), { version: '0.1.0', notes: 'Initial release.' });
  assert.throws(() => validateRelease(manifest, changelog, 'v0.2.0'), /does not match/);
  assert.throws(() => validateRelease(manifest, '# Changelog\n\n## [Unreleased]\nPending.', 'v0.1.0'), /changelog/);
  assert.throws(() => validateRelease({ ...manifest, version: '../escape' }, changelog, 'v../escape'), /semantic version/);
});
