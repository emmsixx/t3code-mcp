import { execFileSync } from 'node:child_process';
import { access, lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { root } from './package-lib.mjs';

// Include untracked candidates during first publication and tracked files even
// if someone later adds an ignore rule. Never print suspected secret values.
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean))];
const forbidden = /(?:^|\/)(?:\.local|\.t3code-mcp|node_modules|dist|release|coverage)(?:\/|$)|(?:^|\/)(?:HANDOFF\.md|live-smoke-test\.json|state\.json|\.env(?:\..*)?)$|\.tgz$/i;
const patterns = [
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['service secret', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['encoded JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b/],
  ['personal tunnel', /\bprod-[a-f0-9]{12,}\.t3coderelay\.com\b/],
  ['personal home path', /\/(?:home|Users)\/[a-zA-Z0-9_.-]+\//],
];
const errors = [];
for (const file of files) {
  if (forbidden.test(file) && !file.endsWith('.env.example')) errors.push(`${file}: private or generated file`);
  const path = resolve(root, file);
  // Skip content checks for deleted files; path checks still cover unstaged deletions.
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) continue;
  if (!info.isFile()) { errors.push(`${file}: only regular files belong in this source tree`); continue; }
  const content = await readFile(path, 'utf8');
  for (const [label, pattern] of patterns) if (pattern.test(content)) errors.push(`${file}: possible ${label}`);
  if (!file.endsWith('.md')) continue;
  for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
    const link = match[1].split('#')[0];
    if (!link || /^[a-z]+:/i.test(link)) continue;
    try { await access(resolve(dirname(path), decodeURIComponent(link))); }
    catch { errors.push(`${file}: broken local link ${link}`); }
  }
}
for (const path of ['.local/probe', '.t3code-mcp/state.json', '.env', 'release/probe.tgz']) {
  try { execFileSync('git', ['check-ignore', '--quiet', path], { cwd: root }); }
  catch { errors.push(`${path}: required ignore rule is missing`); }
}
if (errors.length) throw new Error(`Public-content check failed:\n${errors.join('\n')}`);
console.log(`Public-content check passed for ${files.length} candidate files and local Markdown links. Review changes before committing; this is not a complete secret scanner.`);
