// 官方覆盖命令已移除；检查保留契约与本地计算，不发网络请求。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOCAL, TOOLS, parseBatchRows } from '../scripts/seo-webcafe.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

test('只保留官方暂无等价能力的旧命令', () => {
  assert.deepEqual(Object.keys(TOOLS), [
    'serpPage', 'translatePage', 'translateAggregate', 'translateMe',
    'mineSeed', 'minePage', 'mineReport', 'domainIntent', 'domainCollision', 'domainSessions',
  ]);
  assert.deepEqual(TOOLS.mineSeed.body({ input: 'reaction time test' }), { input: 'reaction time test' });
  assert.deepEqual(TOOLS.mineReport.query({ seed: 'reaction time test' }), { seed: 'reaction time test' });
  assert.deepEqual(TOOLS.translateAggregate.body({ query: 'test', pages: '[{"url":"https://example.com"}]' }), {
    query: 'test', pages: [{ url: 'https://example.com' }], related: [], sites: [],
  });
});

test('本地 KGR 和收入折算公式保持数值口径', () => {
  const kgr = LOCAL.kgr.run({ volume: '1000', intitle: '100', kd: '0' });
  assert.equal(kgr.kgr.value, 0.1);
  assert.equal(kgr.ekgr.value, 0.1);
  assert.equal(kgr.kdroi.requiredDomains, 0);
  assert.equal(kgr.kdroi.roiPct, null);
  const money = LOCAL.money.run({ income: '1000', kd: '0' });
  assert.equal(money.totalDailyUv, 3333);
  assert.equal(money.yearlyRevenue, 12000);
  assert.equal(money.totalLinkCost, 0);
  assert.equal(money.roi, null);
});

test('本地文本统计和邮箱去重保持中文与大小写口径', () => {
  const stats = LOCAL.string.run({ text: '你好 world' });
  assert.equal(stats.chars, 8);
  assert.equal(stats.words, 3);
  assert.equal(stats.bytes, 12);
  assert.deepEqual(LOCAL.email.run({ text: 'A@example.com a@example.com b@test.io' }).emails,
    ['a@example.com', 'b@test.io']);
});

test('批量参数跳过注释，保留值中空格，行内参数覆盖顶层', () => {
  const dir = mkdtempSync(`${here}seo-webcafe-batch-`);
  try {
    const batch = `${dir}/rows.txt`;
    writeFileSync(batch, '# comment\ntext=你好 world volume=1000\ntext=second volume=2000\n');
    const rows = parseBatchRows({ batch, volume: '50', kd: '0' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].text, '你好 world');
    assert.equal(rows[0].volume, '1000');
    assert.equal(rows[1].volume, '2000');
    assert.equal(rows[1].kd, '0');
  } finally { rmSync(dir, { recursive: true }); }
});

// 修复旧 KD 测试失效后，在同一文件检查迁移字段，避免官方换结构被读成空榜。
test('Stripe 官方 overview/top/monthly 与缺值语义', async () => {
  const source = readFileSync(new URL('../scripts/demand/stripe-referring.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const K ='), source.indexOf('const args = parseArgs();'));
  const outputs = [];
  const snapshots = {
    overview: { dataRange: { to: '202608' }, recentTotals: [{ month: '202608', visits: 34629582, listedShare: 61.2, top10Share: 28.1, longtailShare: 38.8 }] },
    month: { top: [{ domain: 'example.com', pos: 1, visits: 2287.7, share: 6.61, change: -15.04 }] },
    site: { domain: 'example.com', stats: { monthsOn: 8, monthsTotal: 32 }, monthly: [{ month: '202608', pos: 1, visits: 2287.7 }] },
  };
  const calls = [];
  const api = new Function('official', 'emit', 'die', 'console', 'fullMonth', body + '\nreturn { derive, cmdMonths, cmdTop, cmdSite };')(
    async (tool, params) => { calls.push({ tool, params }); return snapshots[params.view]; },
    (rows) => outputs.push(rows), (message) => { throw new Error(message); }, { error() {} }, async () => ({ rows: Array.from({ length: 25 }, (_, i) => ({ domain: `site${i}.com`, visits: 1, isNew: true })) }),
  );
  await api.cmdMonths({});
  await api.cmdTop({ limit: 20 });
  await api.cmdSite({ domain: 'example.com' });
  assert.equal(outputs[0].length, 1);
  assert.equal(outputs[0][0].前十占比, '28.1%');
  assert.equal(outputs[1][0]._raw.stripeVisits, 2287700);
  assert.equal(outputs[1][0].名次, 1);
  assert.equal(outputs[2][0].月份, '202608');
  assert.equal(calls[2].params.month, '202608');
  await api.cmdTop({ m: '202608', limit: 25 });
  await api.cmdTop({ m: '202608', limit: 20, 'new-only': true });
  assert.equal(outputs[3].length, 25);
  assert.equal(outputs[4].length, 20);
  assert.equal(calls.length, 4, '全榜和new-only不能误走官方前20名');
  assert.deepEqual(api.derive({}, 1000, 0.35, 19), {
    stripeVisits: null, monthlyVisits: 1000, reachRatio: null, revenueEstimate: null,
  });
  assert.equal(api.derive({ visits: 0 }, 1000, 0.35, 19).revenueEstimate, 0);
});

test('收入站 KD 经官方 CLI 并保留国家和语言', () => {
  const source = readFileSync(new URL('../scripts/demand/revenue-site-audit.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("kd: gefeiScript()"));
  assert.ok(source.includes("'keyword_difficulty', '--keyword', keywords[i], '--gl', db, '--hl', 'en'"));
  assert.ok(!source.includes('seo-webcafe.mjs'));
});
