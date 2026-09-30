import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gefeiScript } from '../scripts/lib-gefei-env.mjs';

test('official CLI resolves existing Claude, shared and Codex installations in order', () => {
  const home = join(process.cwd(), 'fixture-home');
  const locations = ['.claude', '.agents', '.codex'].map((name) => join(home, name, 'skills/gefei/scripts/webcafe.mjs'));
  for (let i = 0; i < locations.length; i++) {
    assert.equal(gefeiScript({ home, env: {}, exists: (p) => locations.slice(i).includes(p) }), locations[i]);
  }
  const custom = join(home, 'custom-codex');
  const expected = join(custom, 'skills/gefei/scripts/webcafe.mjs');
  assert.equal(gefeiScript({ home, env: { CODEX_HOME: custom }, exists: (p) => p === expected }), expected);
  assert.equal(gefeiScript({ home, env: {}, exists: () => false }), locations[0]);
});
