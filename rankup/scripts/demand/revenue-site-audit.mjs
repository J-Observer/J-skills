#!/usr/bin/env node
/**
 * 薄编排：复用现有域名画像 / Similarweb / Semrush / sitemap / 官方 KD CLI，
 * 2026-09-30 KD 改走官方 gefei keyword_difficulty，gl=--db、hl=en，凭据由官方自管。
 * 把「收入站案例」整理成同口径的**原始对照数据**。这里不采集、不解析面板，
 * 也不下判决——「证实/部分证实/反证」这类 verdict 由 AI 对着输出里的
 * 各源数值、scope 记录和倍差事实来下（判据见 references/demand-sources/validation-chain.md「十、候选验证链路」）。
 *
 * 2026-08-30 起：不再删除工作目录。各采集器的原始输出文件全部保留在
 * 输出 rawFilesDir 指向的目录里（默认 .rankup/evidence/demand/revenue-site-audit-<ts>/），
 * 同目录还有一份 manifest.json 记录每个采集器的成败——采集失败 ≠ 该站没数据。
 *
 *   node revenue-site-audit.mjs --domain example.com --source-url https://example.com/post \
 *     --claimed-visits 150000 --claimed-organic-share 74.32 --keyword "png to svg" --out audit.json
 *   node revenue-site-audit.mjs --domain example.com --from ./saved-results --out audit.json
 *   node revenue-site-audit.mjs --self-test
 */
import { execFile } from 'node:child_process';
import { gefeiEnv, gefeiScript } from '../lib-gefei-env.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { initEvidence, evidenceDir, recordSource, writeManifest } from './_lib.mjs';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const scripts = {
  aitdk: path.join(here, 'domain-profile.mjs'),
  sitemap: path.join(here, 'sitemap-diff.mjs'),
  kd: gefeiScript(),
  similarweb: path.join(repo, 'backlink/scripts/similarweb-query.mjs'),
  semrush: path.join(repo, 'backlink/scripts/semrush-overview.mjs'),
};

function argsOf(argv) {
  const out = { _: [], keyword: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) out._.push(token);
    else {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (key === 'keyword') out.keyword.push(value); else out[key] = value;
    }
  }
  return out;
}

const normalizeDomain = (value) => {
  const host = value?.includes('://') ? new URL(value).hostname : String(value || '').split('/')[0];
  const domain = host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
    throw new Error(`Invalid domain: ${value}`);
  }
  return domain;
};

async function json(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

const money = (value) => {
  const n = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function parseTrustMrrMarkdown(markdown, sourceUrl) {
  const pick = (pattern) => markdown.match(pattern)?.[1]?.trim() ?? null;
  return {
    status: 'available', source: 'TrustMRR public AI-readable Markdown', sourceUrl,
    website: pick(/^- Website:\s*\[[^\]]+\]\((https?:\/\/[^)]+)\)/m),
    paymentProvider: pick(/^- Verified payment provider API source:\s*([^\n]+)/m),
    stripeVerified: /^- Verified payment provider API source:\s*Stripe\b/im.test(markdown),
    mrr: money(pick(/^- Current MRR:\s*([^\n]+)/m)),
    activeSubscriptions: money(pick(/^- Current active subscriptions:\s*([^\n]+)/m)),
    revenueLast30d: money(pick(/^- Last 30 days revenue snapshot:\s*([^\n]+)/m)
      ?? pick(/^\| Last 30 days \|\s*([^|]+)\|/m)),
    revenueLastSynced: pick(/^- Revenue (?:data )?last synced:\s*([^\n]+)/mi),
  };
}

async function fetchTrustMrr(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname !== 'trustmrr.com' || !/^\/startup\/[^/]+\/?$/.test(url.pathname)) return null;
    const mdUrl = `${url.origin}${url.pathname.replace(/\/$/, '')}.md`;
    const response = await fetch(mdUrl, { headers: { 'user-agent': 'rankup-revenue-audit/1.0' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseTrustMrrMarkdown(await response.text(), mdUrl);
    if (!parsed.stripeVerified || parsed.mrr == null) throw new Error('Stripe verification or MRR missing from public Markdown');
    return parsed;
  } catch (error) {
    return { status: 'unavailable', source: 'TrustMRR public AI-readable Markdown', sourceUrl, error: String(error.message).slice(0, 300) };
  }
}

async function run(outputFile, commandArgs, cwd) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, commandArgs, { cwd, env: commandArgs[0] === scripts.kd ? gefeiEnv() : process.env, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
    if (stderr) process.stderr.write(stderr);
    return outputFile ? await json(outputFile) : JSON.parse(stdout);
  } catch (error) {
    const saved = outputFile ? await json(outputFile) : null;
    return saved ?? { status: 'unavailable', error: { code: 'collector_failed', message: String(error.message).slice(0, 500) } };
  }
}

/** 每个采集器的成败进 manifest：unavailable 是「没取到」，绝不能被读成 0。 */
function noteSource(source, value) {
  const bad = value == null || value.status === 'unavailable' || value.error;
  recordSource({
    source, status: bad ? 'unavailable' : 'ok', rawCount: bad ? 0 : 1,
    error: bad ? String(value?.error?.message ?? value?.error ?? '无输出').slice(0, 300) : undefined,
  });
  return value;
}

async function collect(domain, keywords, db, work, sourceUrl) {
  const files = Object.fromEntries(['similarweb-performance', 'similarweb-channels', 'semrush', 'sitemap-urls']
    .map((name) => [name, path.join(work, `${name}.json`)]));
  const aitdk = noteSource('aitdk', await run(null, [scripts.aitdk, domain, '--json'], work));
  const swPerformance = noteSource('similarweb-performance', await run(files['similarweb-performance'], [scripts.similarweb, '--domain', domain, '--report', 'performance', '--window', 'isolated', '--out', files['similarweb-performance']], work));
  const swChannels = noteSource('similarweb-channels', await run(files['similarweb-channels'], [scripts.similarweb, '--domain', domain, '--report', 'channels', '--window', 'isolated', '--out', files['similarweb-channels']], work));
  const semrush = noteSource('semrush', await run(files.semrush, [scripts.semrush, '--domain', domain, '--db', db, '--out', files.semrush], work));
  await run(files['sitemap-urls'], [scripts.sitemap, '--domain', domain, '--all', '--track-lastmod', '--limit', '1000000', '--state', path.join(work, 'sitemap-state'), '--out', files['sitemap-urls'], '--json'], work);
  const sitemap = noteSource('sitemap', await json(path.join(work, 'sitemap-state', `${domain}.json`)));
  const kd = [];
  for (let i = 0; i < keywords.length; i++) {
    const file = path.join(work, `kd-${i}.json`);
    kd.push(noteSource(`kd:${keywords[i]}`, await run(file, [scripts.kd, 'keyword_difficulty', '--keyword', keywords[i], '--gl', db, '--hl', 'en', '--out', file, '--json'], work)));
  }
  const trustmrr = sourceUrl ? noteSource('trustmrr', await fetchTrustMrr(sourceUrl)) : null;
  return { aitdk, similarweb: { performance: swPerformance, channels: swChannels }, semrush, sitemap, kd, trustmrr };
}

async function loadSaved(dir) {
  const read = (name) => json(path.join(dir, name));
  const kd = await read('kd.json');
  return {
    aitdk: await read('aitdk.json'),
    similarweb: { performance: await read('similarweb-performance.json'), channels: await read('similarweb-channels.json') },
    semrush: await read('semrush.json'), sitemap: await read('sitemap.json'), kd: Array.isArray(kd) ? kd : kd ? [kd] : [],
    trustmrr: await read('trustmrr.json'),
  };
}

const valueAt = (obj, paths) => {
  for (const keys of paths) {
    let value = obj;
    for (const key of keys) value = value?.[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
};

function sitemapSummary(snapshot) {
  const entries = Array.isArray(snapshot?.urls)
    ? snapshot.urls.map((url) => [url, '']) : Object.entries(snapshot?.urls ?? {});
  const pathCount = (needle) => entries.filter(([url]) => { try { return new URL(url).pathname.includes(needle); } catch { return false; } }).length;
  const dates = new Map();
  for (const [, lastmod] of entries) if (lastmod) dates.set(lastmod, (dates.get(lastmod) ?? 0) + 1);
  const bulk = [...dates].sort((a, b) => b[1] - a[1])[0] ?? null;
  return snapshot ? {
    retrievedAt: snapshot.fetchedAt ?? null, source: snapshot.source ?? [], totalUrls: snapshot.count ?? entries.length,
    routeCounts: { convert: pathCount('/convert/'), blog: pathCount('/blog') },
    mostCommonLastmod: bulk ? { value: bulk[0], urls: bulk[1] } : null,
  } : { status: 'unavailable' };
}

function buildAudit(domain, sourceUrl, raw, claimed = {}) {
  const aitdkVisits = valueAt(raw.aitdk, [['monthlyVisits']]);
  const swPerformanceVisits = valueAt(raw.similarweb?.performance, [['metrics', 'totalVisits']]);
  const swChannelsSum = valueAt(raw.similarweb?.channels, [['channels', 'totalFromChannels']]);
  const swVisits = swPerformanceVisits ?? swChannelsSum;
  const swPerformanceOrganic = valueAt(raw.similarweb?.performance, [['metrics', 'organicSearchSharePct']]);
  const swChannelsOrganic = valueAt(raw.similarweb?.channels, [['channels', 'sharePercent', 'Search - Organic']]);
  const swOrganic = swPerformanceOrganic ?? swChannelsOrganic;
  const estimates = [aitdkVisits, swVisits].filter((v) => v > 0);
  const ratio = estimates.length > 1 ? Math.max(...estimates) / Math.min(...estimates) : null;
  const trustDomain = (() => { try { return new URL(raw.trustmrr?.website).hostname.replace(/^www\./, ''); } catch { return null; } })();
  const verifiedRevenue = raw.trustmrr?.status === 'available' && raw.trustmrr?.stripeVerified && trustDomain === domain;
  const mrrRatio = verifiedRevenue && claimed.mrr ? Math.max(raw.trustmrr.mrr, claimed.mrr) / Math.min(raw.trustmrr.mrr, claimed.mrr) : null;
  const swReportRatio = swPerformanceVisits && swChannelsSum
    ? Math.max(swPerformanceVisits, swChannelsSum) / Math.min(swPerformanceVisits, swChannelsSum) : null;
  const scopeFrom = (report, page, rawField) => ({
    geography: /全球|Worldwide/i.test(report?.rawText ?? '') ? 'worldwide' : 'unknown',
    period: (report?.rawText ?? '').match(/Last 28 days \(As of [^)]+\)|最后 28 天数 \(As of [^)]+\)/i)?.[0] ?? 'unknown',
    trafficType: /所有流量|All Traffic|webSource=Total/i.test(`${report?.rawText ?? ''} ${report?.url ?? ''}`) ? 'all traffic' : 'unknown',
    device: 'all traffic view; device split not exposed by collector', page, url: report?.url ?? null, rawField,
  });
  const scope = {
    aitdk: { geography: 'worldwide estimate', period: 'latest month returned by provider' },
    similarwebPerformance: scopeFrom(raw.similarweb?.performance, 'Website Performance', 'metrics.totalVisits'),
    similarwebChannels: scopeFrom(raw.similarweb?.channels, 'Marketing Channels', 'channels.totalFromChannels (sum of parsed channel rows; not interchangeable with Performance total)'),
    semrush: { geography: raw.semrush?.db ? `country database: ${raw.semrush.db}` : 'unknown country database', period: 'current overview', metric: 'organic search estimate; not total visits' },
  };
  // 2026-08-30 起：不再产出 verdict（证实/部分证实/反证）和 alerts 判决。
  // 这里只并列原始数值、scope 与倍差事实；结论由 AI 对着这些下。
  const claims = [
    {
      claim: 'traffic scale', claimed: claimed.visits ?? null,
      evidence: { aitdkMonthlyVisits: aitdkVisits, similarwebPerformanceTotalVisits: swPerformanceVisits, similarwebChannelRowsSum: swChannelsSum, estimateRatio: ratio, sameSourceReportRatio: swReportRatio },
    },
    {
      claim: 'organic search share', claimed: claimed.organicShare ?? null,
      evidence: { similarwebPerformanceOrganicSharePct: swPerformanceOrganic, similarwebChannelsOrganicSharePct: swChannelsOrganic },
    },
    {
      claim: 'MRR', claimed: claimed.mrr ?? null,
      evidence: {
        trustmrr: raw.trustmrr ?? { status: 'unavailable' },
        stripeVerifiedForThisDomain: verifiedRevenue,
        trustmrrWebsiteDomain: trustDomain,
        claimedToVerifiedRatio: mrrRatio,
      },
    },
    { claim: 'revenue and product/channel causality', claimed: null, evidence: 'Stripe verifies revenue scale, not which page type or acquisition channel caused it. No collector here can settle causality.' },
    { claim: 'pSEO matrix exists', claimed: null, evidence: sitemapSummary(raw.sitemap) },
  ];
  return {
    schemaVersion: 2, domain, sourceUrl: sourceUrl || null, retrievedAt: new Date().toISOString(),
    methodology: 'Existing collectors are invoked unchanged; unavailable is never converted to zero. Semrush country organic traffic is not compared arithmetically with Similarweb worldwide total visits. This script records raw values, scope and ratio facts only — verdicts are for the reader (AI) to make; see references/demand-sources/validation-chain.md section 十、候选验证链路.',
    scope,
    crossChecks: {
      // 事实，不是判决：倍差多大算冲突、冲突了信哪边，由 AI 按 references/demand-sources/validation-chain.md 的判据定。
      comparableEstimates: estimates,
      estimateRatio: ratio,
      similarwebPerformanceVsChannelsRatio: swReportRatio,
    },
    claims, sources: { trustmrr: raw.trustmrr, aitdk: raw.aitdk, similarweb: raw.similarweb, semrush: raw.semrush, sitemap: sitemapSummary(raw.sitemap), kd: raw.kd },
  };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args['self-test']) {
    const trustmrr = parseTrustMrrMarkdown(`- Website: [https://example.com/](https://example.com/)\n- Verified payment provider API source: Stripe (API key)\n- Revenue last synced: 2026-08-26T05:35:57.711Z\n- Last 30 days revenue snapshot: $2,863\n- Current MRR: $1,438\n- Current active subscriptions: 216\n`, 'https://trustmrr.com/startup/example.md');
    const audit = buildAudit('example.com', '', {
      aitdk: { monthlyVisits: 150000 },
      similarweb: { performance: { metrics: { totalVisits: 126000, organicSearchSharePct: 69 } }, channels: { channels: { totalFromChannels: 45000, sharePercent: { 'Search - Organic': 59 } } } },
      semrush: { db: 'us', metrics: { organicTraffic: 1100 } }, sitemap: { count: 2, urls: ['https://example.com/', 'https://example.com/convert/a'] }, kd: [], trustmrr,
    }, { visits: 150000, organicShare: 74, mrr: 1400 });
    const checks = [
      // 判决已移除：任何 claim 都不许再带 verdict，alerts 字段整体消失。
      audit.claims.every((c) => !('verdict' in c)),
      !('alerts' in audit),
      // 倍差作为事实保留，解读交给 AI。
      audit.crossChecks.similarwebPerformanceVsChannelsRatio > 1.35,
      audit.crossChecks.estimateRatio != null,
      audit.claims.find((c) => c.claim === 'MRR')?.evidence?.stripeVerifiedForThisDomain === true,
      trustmrr.revenueLast30d === 2863,
      trustmrr.activeSubscriptions === 216,
      audit.sources.sitemap.routeCounts.convert === 1,
    ];
    if (!checks.every(Boolean)) throw new Error(`self-test failed: ${checks.map((c, i) => (c ? '' : i)).filter((x) => x !== '').join(',')}`);
    console.log('revenue-site-audit self-test passed'); return;
  }
  if (args.help || !args.domain) {
    console.log('Usage: revenue-site-audit.mjs --domain <domain> [--source-url <url>] [--claimed-visits <n>] [--claimed-organic-share <pct>] [--claimed-mrr <n>] [--keyword <kw> ...] [--db us] [--from <saved-dir>] [--evidence-dir <dir>] --out <file>');
    console.log('输出是原始对照数据（不含 verdict）；各采集器的原始文件保留在输出 rawFilesDir 指向的目录里。');
    return;
  }
  const domain = normalizeDomain(args.domain);
  // 工作目录即证据目录：原始文件全保留（以前是 tmpdir + 用完 rm -rf，现场全毁）。
  initEvidence('revenue-site-audit', { dir: typeof args['evidence-dir'] === 'string' ? args['evidence-dir'] : null });
  const work = args.from ? null : evidenceDir();
  if (work) await mkdir(work, { recursive: true });
  const raw = args.from ? await loadSaved(path.resolve(args.from)) : await collect(domain, args.keyword, String(args.db || 'us'), work, args['source-url']);
  if (args.from && !raw.trustmrr && args['source-url']) raw.trustmrr = await fetchTrustMrr(args['source-url']);
  const audit = buildAudit(domain, args['source-url'], raw, {
    visits: args['claimed-visits'] == null ? null : Number(args['claimed-visits']),
    organicShare: args['claimed-organic-share'] == null ? null : Number(args['claimed-organic-share']),
    mrr: args['claimed-mrr'] == null ? null : Number(args['claimed-mrr']),
  });
  audit.rawFilesDir = work ?? path.resolve(args.from);
  audit.manifest = writeManifest('completed');
  const text = `${JSON.stringify(audit, null, 2)}\n`;
  if (args.out) await writeFile(path.resolve(args.out), text, 'utf8');
  console.log(text.trim());
  console.error(`原始文件目录（已保留，不再删除）：${audit.rawFilesDir}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
