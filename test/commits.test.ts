import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("commitlint accepts conventional messages and rejects default ignore shortcuts", () => {
  const examples: [string, boolean][] = [
    ["feat: expose thread activity", true],
    ["fix(auth): recover an interrupted login", true],
    ["feat(api)!: change the thread response", true],
    ["fix: update the response\n\nBREAKING CHANGE: remove the legacy field", true],
    ["revert: undo the cache change", true],
    ["Update the README", false],
    ["feat:", false],
    ["Merge branch 'main'", false],
    ["Revert \"feat: add a cache\"", false],
    ["v1.2.3", false],
  ];
  for (const [message, valid] of examples) {
    const result = spawnSync("pnpm", ["exec", "commitlint"], { input: `${message}\n`, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, valid, `${message}: ${result.stdout}${result.stderr}`);
  }
});
