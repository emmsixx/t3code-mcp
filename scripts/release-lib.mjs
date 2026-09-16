export function validateRelease(manifest, changelog, tag) {
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Release version must be a stable or prerelease semantic version.');
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match package version v${version}.`);
  if (manifest.name !== 't3code-mcp' || manifest.license !== 'MIT') throw new Error('Unexpected package identity or license.');
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find(value => value.startsWith(`[${version}] - `));
  if (!section || !section.trim().includes('\n')) throw new Error(`Add a dated changelog entry for ${version} before releasing.`);
  return { version, notes: section.slice(section.indexOf('\n')).trim() };
}
