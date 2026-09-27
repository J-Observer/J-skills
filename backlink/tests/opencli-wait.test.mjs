// Checks the native batch wait step and its elapsed time with a live browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { batchBrowser, sleepStep } from '../scripts/opencli-core.mjs';

const REQUESTED_SECONDS = 6;
const session = `opencli-wait-probe-${process.pid}`;
const opencli = (...args) => spawnSync('opencli', args, { encoding: 'utf8', timeout: 120_000 });
const available = () => {
  const probe = spawnSync('opencli', ['--version'], { encoding: 'utf8', timeout: 20_000 });
  return probe.status === 0;
};
test('sleepStep builds a native wait with nonnegative seconds', () => {
  assert.deepEqual(sleepStep(2), { cmd: 'wait', args: { seconds: 2 } });
  assert.equal(sleepStep(0.25).args.seconds, 0.25);
  assert.equal(sleepStep(-5).args.seconds, 0);
  assert.equal(sleepStep('invalid').args.seconds, 0);
});

test('batch wait sleeps for the requested time', { skip: !available() && 'opencli is not installed' }, async (t) => {
  const opened = opencli('browser', session, 'open', 'https://example.com');
  if (opened.status !== 0) return t.skip('no browser bridge available in this environment');
  try {
    const started = Date.now();
    const results = await batchBrowser(session, [sleepStep(REQUESTED_SECONDS)]);
    const elapsed = (Date.now() - started) / 1000;
    assert.equal(results[0]?.ok, true, JSON.stringify(results));
    assert.ok(
      elapsed >= REQUESTED_SECONDS,
      `batch wait lasted ${elapsed.toFixed(2)}s for ${REQUESTED_SECONDS}s`,
    );
  } finally {
    opencli('browser', session, 'close');
  }
});
