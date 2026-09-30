import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'rankup/scripts/rankup-cli.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const temp = await mkdtemp(path.join(tmpdir(), 'rankup-cli-test-'));
try {
  assert.equal(run('--help').status, 0);
  const catalog = run('catalog', 'semrush', '--json');
  assert.equal(catalog.status, 0);
  const capability = JSON.parse(catalog.stdout);
  assert.equal(capability.provider, 'semrush');
  assert.equal(capability.capabilities.status, 'public-catalog-bounded');
  assert.equal(capability.capabilities.liveAudit.auditedAt, '2026-08-27');
  assert.equal(capability.capabilities.scriptCoverage.status, 'script-verified');

  // The API/MCP line was judged dead on 2026-08-27. A regression to the old vague
  // "account entitlement dependent" wording reads as "maybe try it again", which is
  // exactly the wasted effort the verdict exists to prevent.
  const both = JSON.parse(run('catalog', '--json').stdout).providers;
  for (const [name, capability] of Object.entries(both)) {
    for (const surface of capability.interfaces) {
      assert.equal(surface.access, 'blocked-shared-account', `${name} ${surface.name} keeps a decided verdict`);
      assert(surface.reason && surface.evidence && surface.checkedAt, `${name} ${surface.name} carries reason, evidence, and a date`);
    }
  }

  const modules = run('catalog', 'semrush', '--modules');
  assert.equal(modules.status, 0);
  assert.match(modules.stdout, /^semrush: \d+ modules, \d+ pages$/m);
  assert(modules.stdout.includes('SEO Toolkit'), 'module view names the toolkits');
  assert(modules.stdout.includes('    - Keyword Magic Tool'), 'module view lists feature pages');

  const gaps = run('catalog', 'similarweb', '--gaps');
  assert.equal(gaps.status, 0);
  assert(gaps.stdout.includes('audited 2026-08-27'), 'gap view dates the audit');
  // Every unsettled question must reach this view under some heading. Resolving the
  // last knownMissing entry must not make the gap view look empty.
  assert(/\n {2}(knownMissing|openQuestions|notReached):/.test(gaps.stdout), 'gap view reports what is still unsettled');
  assert(gaps.stdout.includes('notObserved:'), 'gap view reports unobserved modules');
  assert(gaps.stdout.includes('App Intelligence'), 'gap view names the separate products');
  // A gap view that hides the boundaries would read as "we saw everything".
  assert(gaps.stdout.includes('boundaries:'), 'gap view keeps the audit boundaries visible');

  assert.notEqual(run('catalog', '--nope').status, 0, 'unknown catalog view is rejected');
  assert.notEqual(run('catalog', '--json', '--gaps').status, 0, 'catalog views are mutually exclusive');
  assert.notEqual(run('catalog', 'semrush', 'similarweb').status, 0, 'catalog takes at most one provider');

  const badManifest = path.join(temp, 'bad.json');
  await writeFile(badManifest, JSON.stringify([{id: '../bad', provider: 'semrush', report: 'organic-pages', nope: true}]));
  assert.notEqual(run('audit', 'semrush', '--manifest', badManifest, '--out-dir', path.join(temp, 'bad'), '--session', 'fixed', '--dry-run').status, 0);
  for (const [name, url] of Object.entries({crossOrigin: 'https://example.com/report', token: 'https://semrush.example.com/report?token=secret', accessToken: 'https://semrush.example.com/report?access_token=secret', apiKey: 'https://semrush.example.com/report?api-key=secret', csrf: 'https://semrush.example.com/report?x-csrf-token=secret', session: 'https://semrush.example.com/#/report?sessionKey=secret'})) {
    const file = path.join(temp, `${name}.json`);
    await writeFile(file, JSON.stringify([{id: name, provider: 'semrush', report: 'custom', url, pageKind: 'table'}]));
    const result = run('audit', 'semrush', '--manifest', file, '--out-dir', path.join(temp, name), '--session', 'fixed', '--dry-run');
    assert.notEqual(result.status, 0);
    assert(!result.stdout.includes('secret'));
    assert(!existsSync(path.join(temp, name, 'summary.json')));
  }

  const similarweb = path.join(temp, 'similarweb.json');
  await writeFile(similarweb, JSON.stringify([{id: 'similarweb', provider: 'Similarweb', module: 'Website Analysis', label: 'Performance', status: 'captured', receiptPath: 'evidence/receipt.json', dataCompleteness: 'unknown', url: 'https://similarweb.example.com/#/digitalsuite/websiteanalysis/overview/website-performance/*/999/28d?webSource=Total&key=example.com', pageKind: 'table'}]));
  const similarwebOut = path.join(temp, 'similarweb');
  assert.equal(run('audit', 'similarweb', '--manifest', similarweb, '--out-dir', similarwebOut, '--session', 'fixed', '--dry-run').status, 0);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(similarwebOut, 'summary.json'), 'utf8')).entries[0], 'args'), false, 'summary omits child arguments');

  const authority = path.join(temp, 'authority.json');
  await writeFile(authority, JSON.stringify([{id: 'authority', provider: 'semrush', report: 'custom', url: 'https://semrush.example.com/report?authority=ok', pageKind: 'table'}]));
  assert.equal(run('audit', 'semrush', '--manifest', authority, '--out-dir', path.join(temp, 'authority'), '--session', 'fixed', '--dry-run').status, 0);

  const manifest = path.join(temp, 'manifest.json');
  await writeFile(manifest, JSON.stringify([
    {id: 'first', provider: 'semrush', report: 'organic-pages', domain: 'example.com', db: 'us'},
    {id: 'second', provider: 'semrush', report: 'keyword-overview', keyword: 'rankup', db: 'jp'}
  ]));
  const dry = path.join(temp, 'dry');
  assert.equal(run('audit', 'semrush', '--manifest', manifest, '--out-dir', dry, '--session', 'fixed', '--dry-run', '--resume', '--accept-bounded').status, 0);
  const summary = JSON.parse(await readFile(path.join(dry, 'summary.json'), 'utf8'));
  assert(!JSON.stringify(summary).includes('secret'));
  assert.deepEqual(summary.entries.map((entry) => entry.id), ['first', 'second']);
  assert(summary.entries.every((entry) => !Object.hasOwn(entry, 'args')), 'summary never persists raw child arguments');

  const failures = path.join(temp, 'failures.json');
  await writeFile(failures, JSON.stringify([
    {id: 'one', provider: 'semrush', report: 'unsupported', domain: 'example.com'},
    {id: 'two', provider: 'semrush', report: 'unsupported', domain: 'example.org'}
  ]));
  const failed = path.join(temp, 'failed');
  assert.notEqual(run('audit', 'semrush', '--manifest', failures, '--out-dir', failed, '--session', 'fixed').status, 0);
  const failureSummary = JSON.parse(await readFile(path.join(failed, 'summary.json'), 'utf8'));
  assert.equal(failureSummary.failed, 2);
  assert.deepEqual(failureSummary.entries.map((entry) => entry.id), ['one', 'two']);
  console.log('provider-cli: PASS');
} finally {
  await rm(temp, { recursive: true, force: true });
}
