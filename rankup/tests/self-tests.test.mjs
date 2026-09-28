// Scripts that carry a --self-test are only as good as something running them.
//
// Several had rich offline checks that `node --test` could not reach, so a break
// stayed invisible until someone ran the pipeline by hand. Rather than listing
// them — the list is what went stale last time — this discovers every script that
// declares the flag and runs it. A new script with a self-test is covered the
// moment it lands; one that stops declaring the flag shows up as a drop in count.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH_ROOTS = ['rankup/scripts', 'backlink/scripts'];

// Excluded on purpose, with the reason, so an empty run is never mistaken for a pass.
const EXCLUDED = new Map([
  ['backlink/scripts/self-test.mjs', 'an end-to-end smoke that drives opencli, not an offline check'],
  ['rankup/scripts/rankup-cli.mjs', 'names the flag only to refuse it, so capture cannot be tricked into running the evidence CLI self-test'],
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}
const scripts = SEARCH_ROOTS
  .flatMap((dir) => walk(path.join(root, dir)))
  .map((full) => path.relative(root, full).split(path.sep).join('/'))
  .filter((rel) => !EXCLUDED.has(rel))
  // Declaring the flag means parsing it, not merely mentioning it in help text.
  .filter((rel) => /['"]self-test['"]|--self-test/.test(readFileSync(path.join(root, rel), 'utf8')))
  .sort();

test('the offline self-tests are discoverable', () => {
  // A refactor that stops the scan from matching would otherwise silently test nothing.
  assert.ok(scripts.length >= 7, `expected the scan to find the known self-tests, found ${scripts.length}: ${scripts.join(', ')}`);
  for (const expected of ['rankup/scripts/demand/revenue-site-audit.mjs']) {
    assert.ok(scripts.includes(expected), `${expected} dropped out of the self-test scan`);
  }
});

for (const script of scripts) {
  test(`${script} --self-test passes`, () => {
    const result = spawnSync(process.execPath, [path.join(root, script), '--self-test'], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, `self-test failed:\n${result.stdout}\n${result.stderr}`);
  });
}
