import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as runCanonical } from '../../opencli/scripts/opencli-core.mjs';
import { run as runVendored } from '../scripts/opencli-core.mjs';
import { execFile, execFileSync, spawnSync } from '../scripts/lib-opencli-process.mjs';
import { promisify } from 'node:util';

test('direct wrappers preserve Node output and honor explicit OpenCLI binaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencli explicit '));
  try {
    const entry = join(root, 'opencli.mjs');
    await writeFile(entry, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));console.error("stderr-kept");', { mode: 0o755 });
    const args = ['eval', '中文 & "quoted" || false'];
    const options = { encoding: 'utf8', env: { ...process.env, OPENCLI_BIN: entry } };
    const result = await promisify(execFile)('opencli', args, options);
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.match(result.stderr, /stderr-kept/);
    assert.deepEqual(JSON.parse(execFileSync('opencli', args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })), args);
    assert.deepEqual(JSON.parse(spawnSync('opencli', args, options).stdout), args);
    const missing = spawnSync('opencli', [], { env: { ...process.env, OPENCLI_BIN: join(root, 'missing-opencli.mjs') } });
    assert.ok(missing.error, 'an explicit missing binary must not fall back to the real browser');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, run] of [['canonical', runCanonical], ['vendored', runVendored]]) {
  test(`${name}: Windows launcher preserves eval arguments and caller options`, { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencli launcher '));
    try {
      const entry = join(root, 'npm', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js');
      await mkdir(join(entry, '..'), { recursive: true });
      await writeFile(entry, 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),marker:process.env.LAUNCHER_TEST_MARKER}));');
      const args = ['browser', 'test-session', 'eval', `({text:"中文 & | < > % !", fallback: false || true, long:"${'x'.repeat(10000)}"})`];
      const result = await run('opencli', args, { cwd: root, env: { APPDATA: root, LAUNCHER_TEST_MARKER: 'preserved' } });
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), { args, cwd: root, marker: 'preserved' });
      assert.equal(args[0], 'browser', 'the caller argument array must not be modified');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${name}: missing Windows installation fails explicitly`, { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencli missing '));
    try {
      await assert.rejects(run('opencli', ['--version'], { env: { APPDATA: root } }), /OpenCLI Windows entry not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${name}: unrelated executable and allowFailure behavior are unchanged`, async () => {
    const result = await run(process.execPath, ['-e', 'console.log("expected-output");process.exit(7)'], { allowFailure: true });
    assert.equal(result.code, 7);
    assert.equal(result.stdout, 'expected-output');
  });
}
