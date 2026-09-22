import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise only the subprocess boundary. Importing setup entrypoints would
// execute their top-level website flows, which these offline tests must avoid.
for (const name of ['ahrefs-setup', 'clarity-setup', 'gsc-remove-urls', 'naver-setup', 'webmaster-sitemap', 'yandex-setup']) {
  test(`${name}: subprocess boundary preserves browser arguments`, () => {
    const source = readFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('function cli(');
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start);
    const calls = [];
    const cli = new Function('execFileSync', 'session', `${source.slice(start, end)}; return cli;`)((...args) => { calls.push(args); return 'ok\n'; }, 'offline-test');
    const js = `({text: "中文 & | 'quotes'", long: "${'x'.repeat(10000)}"})`;
    assert.equal(cli(['eval', js], { timeout: 1234 }), 'ok');
    assert.equal(calls[0][0], 'opencli');
    assert.deepEqual(calls[0][1].slice(-2), ['eval', js]);
    assert.equal(calls[0][2].timeout, 1234);
    assert.doesNotMatch(source, /\bcli\([`'"]/u, 'all call sites must pass argument arrays');
  });
}
