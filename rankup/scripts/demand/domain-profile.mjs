#!/usr/bin/env node
/**
 * domain-profile.mjs：给一个域名，取回注册日期 / 月访问量 / 流量结构 / 核心搜索关键词。
 * 本脚本只采集域名画像，不做阈值筛选；判断由 AI 对着完整输出（含出错行）来下，
 * 见 references/demand-sources/validation-chain.md「十、候选验证链路」。
 *
 * 历史上为复现 AITDK 那套判断而写。AITDK 自身无公开免费查询端点，
 * 故默认取数走官方哥飞 CLI；本脚本不是 AITDK 面板查询或验收入口。
 * 可选 tabapi provider 使用付费流量与 WHOIS/RDAP API，按 credit 计费。
 * 默认 webcafe provider 经官方 gefei CLI 调 domain_overview，按积分余额计费。
 * 2026-09-30 两站实测：注册日期、访问、DR、环比、渠道、核心词、曲线字段覆盖。
 * 凭据由官方 CLI 自行管理；本脚本不读取 WEBCAFE_TOKEN 或其配置。
 * tabapi provider 保留，需要 TABAPI_KEY，按 credit 计费。
 *
 * 示例：node domain-profile.mjs example.com --json
 * 批量：node domain-profile.mjs --file domains.txt --out profiles.jsonl
 *
 * 已知坑：
 *   1. `--file` 批量是**逐条追加落盘**（.jsonl），中断后再跑会自动跳过已完成的域名。
 *      所以 --out 一定要给 .jsonl；给 .json 会在结束时整体覆写，中断就全丢。
 *   2. 本脚本不做阈值筛选（2026-08-30 移除了 --max-age-days 等四个筛选旗标）：
 *      配额 429、CAPTCHA、改版都会让字段缺失，脚本层过滤会把「没取到」筛成
 *      「不合格」。筛选判断由 AI 对完整输出做，出错行必须显示在默认输出里。
 *   3. searchShare 是 0~100 的百分数还是 0~1 的比例，服务端两种都出现过。
 *      本脚本统一归一化成百分数，比较前会判断量级。
 *   4. 批量前用官方 gefei CLI 的 tools / me 查看价格与余额，API 不用每日赠送额度。
 */

import { execFile } from 'node:child_process';
import { gefeiEnv, gefeiScript } from '../lib-gefei-env.mjs';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, readToken, die, sleep, printTable,
  initEvidence, recordSource, writeManifest, saveEvidence,
} from './_lib.mjs';
import { UA } from '../seo-webcafe.mjs';

const execFileP = promisify(execFile);

const HELP = `域名画像 —— 注册日期 / 月访问 / 流量结构 / 核心词

用法:
  node domain-profile.mjs <域名> [选项]
  node domain-profile.mjs --file <每行一个域名的文件> --out out.jsonl [选项]

Provider:
  --provider webcafe     默认。经官方 gefei CLI 调 domain_overview，当前 2 积分/域名（以官方目录为准）
  --provider tabapi      AITDK 扩展背后的官方付费 API，需要 TABAPI_KEY，按 credit 计费
  --months <3-12>        仅 tabapi：回溯几个月，默认 3（按实际返回月数计费）

输出:
  --json                 输出 JSON
  --out <file.jsonl>     逐条追加落盘，可续跑（强烈建议批量时使用）
  --limit <n>            批量时最多处理 n 个
  --evidence-dir <dir>   失败现场与 manifest 落点，默认 .rankup/evidence/demand/domain-profile-<ts>/
  --help

注意：本脚本只采集，不做阈值筛选。官方 CLI 的积分、上限或网络错误会显示在默认输出里——「取数失败」和「字段为空」是两回事，判断交给 AI。`;

// ── provider: 官方 gefei CLI ────────────────────────────────────────────────

async function fetchWebcafe(domain) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [
      gefeiScript(),
      'domain_overview', domain, '--json',
    ], { env: gefeiEnv(), timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    if (stderr) process.stderr.write(stderr);
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(error.stderr || `官方 CLI 调用失败：${error.code}`).trim();
    const f = saveEvidence(`webcafe-${domain}-error.json`, { domain, error: detail });
    return { error: `${detail}（现场已留 ${f}）` };
  }
}

// ── provider: TabAPI ────────────────────────────────────────────────────────

async function fetchTabapi(domain, { months }) {
  const key = readToken('TABAPI_KEY');
  if (!key) die('provider=tabapi 需要 TABAPI_KEY（环境变量或 rankup/.env）。在 tabapi.com 自助申请。');
  const h = { Authorization: `Bearer ${key}`, 'user-agent': UA };
  const t = await fetch(`https://tabapi.com/api/v1/domains/${encodeURIComponent(domain)}/traffic?months=${months}`, { headers: h });
  const traffic = await t.json().catch(() => null);
  if (!t.ok) {
    const f = saveEvidence(`tabapi-${domain}-${t.status}.json`, { domain, status: t.status, body: traffic });
    return { error: `traffic HTTP ${t.status} ${JSON.stringify(traffic?.error ?? '').slice(0, 160)}（现场已留 ${f}）`, status: t.status };
  }
  // 注册日期在 traffic 里没有，要另外花 1 credit 走 RDAP。
  const d = await fetch(`https://tabapi.com/api/v1/domains/${encodeURIComponent(domain)}/rdap`, { headers: h });
  const rdap = d.ok ? await d.json().catch(() => null) : null;
  return { traffic, rdap };
}

// ── 归一化：两个 provider 出一样形状的记录 ───────────────────────────────────

/** searchShare 服务端两种量级都出现过；统一成 0~100 的百分数。 */
const toPct = (v) => (v == null ? null : v <= 1 ? Number((v * 100).toFixed(2)) : Number(Number(v).toFixed(2)));

function shareOf(sources, ...names) {
  if (!sources) return null;
  if (Array.isArray(sources)) {
    const hit = sources.find((s) => names.some((n) => new RegExp(n, 'i').test(s.name ?? s.channel ?? s.source ?? '')));
    return hit ? toPct(hit.share ?? hit.value ?? hit.percent) : null;
  }
  for (const n of names) {
    for (const [k, v] of Object.entries(sources)) if (new RegExp(n, 'i').test(k)) return toPct(v);
  }
  return null;
}

function ageDays(registeredAt) {
  if (!registeredAt) return null;
  const t = Date.parse(registeredAt);
  return Number.isNaN(t) ? null : Math.round((Date.now() - t) / 86400000);
}

function normalize(domain, provider, raw) {
  if (raw?.error) return { domain, provider, error: raw.error, httpStatus: raw.status ?? null, retrievedAt: new Date().toISOString() };
  if (provider === 'webcafe') {
    const search = raw.searchShare != null ? toPct(raw.searchShare) : shareOf(raw.trafficSources, 'search', '搜索', 'organic');
    return {
      domain, provider, retrievedAt: new Date().toISOString(),
      registeredAt: raw.registeredAt ?? null,
      ageDays: ageDays(raw.registeredAt),
      monthlyVisits: raw.visits ?? null,
      globalRank: raw.globalRank ?? null,
      domainRating: raw.dr ?? null,
      searchSharePct: search,
      directSharePct: shareOf(raw.trafficSources, 'direct', '直接'),
      referralSharePct: shareOf(raw.trafficSources, 'referral', '外链', '引荐'),
      trendPct: raw.trend?.changePct ?? null,
      topKeywords: raw.topKeywords?.map((k) => ({ keyword: k.name, volume: k.volume, cpc: k.cpc, isBrand: k.isBrand, isNav: k.isNav })) ?? null,
      monthlyHistory: raw.monthlyHistory ?? null,
      noData: raw.noData ?? false,
    };
  }
  const t = raw.traffic || {};
  const o = t.overview || {};
  const reg = raw.rdap?.events?.find?.((e) => /registration/i.test(e.action || ''))?.date
    ?? raw.rdap?.registered_at ?? raw.rdap?.creation_date ?? null;
  return {
    domain, provider, retrievedAt: new Date().toISOString(),
    registeredAt: reg, ageDays: ageDays(reg),
    monthlyVisits: o.visits ?? null,
    globalRank: o.global_rank ?? null,
    domainRating: null,
    searchSharePct: shareOf(t.sources, 'search'),
    directSharePct: shareOf(t.sources, 'direct'),
    referralSharePct: shareOf(t.sources, 'referral'),
    trendPct: null,
    topKeywords: (t.top_keywords || []).map((k) => ({ keyword: k.keyword ?? k.name, volume: k.volume, cpc: k.cpc })),
    monthlyHistory: t.monthly_visits ?? null,
    noData: false,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
// 阈值筛选已于 2026-08-30 移出脚本：脚本只采集，筛选判断由 AI 对完整输出做。

const args = parseArgs();
if (args.help || (!args._[0] && !args.file)) { console.log(HELP); process.exit(0); }
for (const gone of ['max-age-days', 'min-visits', 'min-search-share', 'max-direct-share', 'strict']) {
  if (args[gone] != null) die(`--${gone} 已移除：脚本不再做阈值筛选（会把「没取到」筛成「不合格」）。拿完整输出去判断。`);
}
initEvidence('domain-profile', { dir: args['evidence-dir'] || null });

const provider = args.provider === 'tabapi' ? 'tabapi' : 'webcafe';
const months = Math.min(12, Math.max(3, Number(args.months || 3)));

let domains = args.file
  ? fs.readFileSync(args.file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [args._[0]];
domains = domains.map((d) => (d.includes('://') ? new URL(d).hostname : d.split('/')[0]).toLowerCase().replace(/^www\./, ''));
if (args.limit) domains = domains.slice(0, Number(args.limit));

// 续跑：.jsonl 里已有的域名直接跳过。这是批量脚本能被中断的前提。
const outFile = args.out ? path.resolve(process.cwd(), args.out) : null;
const done = new Set();
if (outFile && outFile.endsWith('.jsonl') && fs.existsSync(outFile)) {
  for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).domain); } catch { /* 坏行跳过，不要让一行脏数据挡住续跑 */ }
  }
  if (done.size) console.error(`· 续跑：${outFile} 里已有 ${done.size} 条，跳过`);
}

const results = [];
for (const domain of domains) {
  if (done.has(domain)) continue;
  const raw = provider === 'tabapi' ? await fetchTabapi(domain, { months }) : await fetchWebcafe(domain);
  const rec = normalize(domain, provider, raw);
  results.push(rec);
  recordSource({
    source: `${provider}:${domain}`,
    status: rec.error ? (rec.httpStatus ? `http_${rec.httpStatus}` : 'error') : 'ok',
    rawCount: rec.error ? 0 : 1,
    error: rec.error ?? undefined,
  });
  if (outFile && outFile.endsWith('.jsonl')) fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
  console.error(`${rec.error ? '✗' : '✓'} ${domain}${rec.error ? ` → ${rec.error}` : ''}`);
  await sleep(800);
}

const errored = results.filter((r) => r.error);
const manifestPath = writeManifest(errored.length ? `completed_with_failures: ${errored.length}/${results.length}` : 'completed');
if (outFile && !outFile.endsWith('.jsonl')) { fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n'); console.error(`已写入 ${outFile}`); }
if (args.json) {
  console.log(JSON.stringify(results, null, 2));
  if (errored.length) console.error(`注意：${errored.length}/${results.length} 个域名采集失败——那不是「该站没数据」。manifest：${manifestPath}`);
  process.exit(0);
}

// 默认输出显示全部行，出错行带 HTTP 状态——「取数失败」绝不允许从表里消失。
printTable(
  results.map((r) => ({
    状态: r.error ? `✗ ${r.httpStatus ? `HTTP ${r.httpStatus}` : '错误'}` : '✓',
    域名: r.domain,
    注册: r.error ? '' : r.registeredAt ? r.registeredAt.slice(0, 10) : '未知',
    站龄天: r.error ? '' : r.ageDays ?? '未知',
    月访问: r.error ? '' : r.monthlyVisits == null ? '未知' : r.monthlyVisits.toLocaleString('en-US'),
    搜索占比: r.error ? '' : r.searchSharePct == null ? '未知' : `${r.searchSharePct}%`,
    直接占比: r.error ? '' : r.directSharePct == null ? '未知' : `${r.directSharePct}%`,
    环比: r.error ? '' : r.trendPct == null ? '未知' : `${r.trendPct}%`,
    核心词: r.error
      ? String(r.error).slice(0, 60)
      : (r.topKeywords || []).filter((k) => !k.isBrand).slice(0, 3).map((k) => k.keyword).join(' / ') || (r.topKeywords?.length ? '(只有品牌词)' : '未知'),
  })),
  [
    { key: '状态', label: '状态', max: 12 }, { key: '域名', label: '域名', max: 30 },
    { key: '注册', label: '注册' }, { key: '站龄天', label: '站龄' },
    { key: '月访问', label: '月访问' }, { key: '搜索占比', label: '搜索' }, { key: '直接占比', label: '直接' },
    { key: '环比', label: '环比' }, { key: '核心词', label: '核心搜索词 / 失败原因', max: 60 },
  ],
);
console.error(`\n取到 ${results.length - errored.length} / 失败 ${errored.length} / 请求 ${results.length}` +
  (errored.length ? '——失败 ≠ 没数据，先看证据目录再下判断' : ''));
if (manifestPath) console.error(`manifest：${manifestPath}`);
