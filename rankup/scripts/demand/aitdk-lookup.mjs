#!/usr/bin/env node
/**
 * 用途：给一个域名，拿回悬赏帖里 AITDK 那套判断所需要的四件事——
 *         域名注册日期 / 月访问量 / 流量结构（搜索占比、直接访问占比）/ 核心搜索关键词。
 *       用途一句话：**采回「一个刚注册不久却已经跑起量的站」的原始画像。**
 *       本脚本只采集：不做阈值筛选，「新站 + 有量 + 搜索为主」这类判断由 AI
 *       对着完整输出（含出错行）来下——见 references/demand-sources.md 第十节。
 *
 * 关于 AITDK 本身（2026-08-23 实测，重要，别再重复探）：
 *   - aitdk.com 网站本身**已经没有域名查询入口了**，只剩 13 个 AI 文案生成器。
 *     整站是 TanStack Start SSR，前端 JS 里只有 /api/auth 和 /api/config/public，
 *     猜 /api/traffic、/api/domain、/api/whois 一律 404。**没有公开的免费查询端点。**
 *   - 那套流量数据现在在它的 Chrome 扩展里，扩展背后的公开 API 是同一作者的
 *     **TabAPI**（tabapi.com，页脚「API」链接）：GET /api/v1/domains/{domain}/traffic
 *     返回 overview.visits / sources / top_keywords / country_rank，3–12 credits，
 *     **必须 Bearer sk_live_ 付费令牌**，匿名调用 401。它还有 WHOIS/RDAP（各 1 credit）
 *     给注册日期。所以 AITDK 这条线是「可用但要花钱」。
 *   - 免费等价物是 seo.web.cafe 的 /mine/api/domain：实测返回
 *     {domain, dr, visits, registeredAt, ageYears, trend, searchShare, topKeywords,
 *      trafficSources, topCountries, monthlyHistory, behavior, aiSources, globalRank}
 *     ——**字段和 AITDK 面板一一对得上**，而且免费，只吃站点共享配额。
 *     代价：searchShare / trafficSources / topCountries 对冷门域名经常是 null
 *     （服务端就没有数据，不是脚本没解析）。
 *
 * 所以本脚本有两个 provider，同一套归一化输出：
 *   webcafe（默认，免费，吃配额）   tabapi（要 TABAPI_KEY，付费 credit，字段更全）
 *
 * 示例：
 *   node aitdk-lookup.mjs example.com
 *   node aitdk-lookup.mjs example.com --provider tabapi --json
 *   node aitdk-lookup.mjs --file domains.txt --out profiles.jsonl --via browser
 *
 * 依赖：
 *   - provider=webcafe：无令牌。配额游客 10/日、登录 100/日、VIP 500/日。
 *     `--via browser` 把请求发进用户已登录的 Chrome，用那边的档位（凭据不离开浏览器）。
 *   - provider=tabapi：TABAPI_KEY（环境变量或 rankup/.env）。
 *
 * 已验证日期：2026-08-24（webcafe 单域名 / --file 批量 / 续跑 / 阈值筛选都真跑过；
 *                        tabapi 只验证到「匿名 401、契约如上」——没有付费令牌可测）
 *
 * 已知坑：
 *   1. `--file` 批量是**逐条追加落盘**（.jsonl），中断后再跑会自动跳过已完成的域名。
 *      所以 --out 一定要给 .jsonl；给 .json 会在结束时整体覆写，中断就全丢。
 *   2. 本脚本不做阈值筛选（2026-08-30 移除了 --max-age-days 等四个筛选旗标）：
 *      配额 429、CAPTCHA、改版都会让字段缺失，脚本层过滤会把「没取到」筛成
 *      「不合格」。筛选判断由 AI 对完整输出做，出错行必须显示在默认输出里。
 *   3. searchShare 是 0~100 的百分数还是 0~1 的比例，服务端两种都出现过。
 *      本脚本统一归一化成百分数，比较前会判断量级。
 *   4. 批量跑之前先看一眼配额：`node ../seo-webcafe.mjs referring` 会打印档位。
 */

import { execFile } from '../../../backlink/scripts/lib-opencli-process.mjs';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, readToken, die, sleep, printTable, requireBrowserBridge,
  initEvidence, recordSource, writeManifest, saveEvidence,
} from './_lib.mjs';
import { BASE, UA, toolAuth } from '../seo-webcafe.mjs';

const execFileP = promisify(execFile);

const HELP = `域名画像（AITDK 那套字段）—— 注册日期 / 月访问 / 流量结构 / 核心词

用法:
  node aitdk-lookup.mjs <域名> [选项]
  node aitdk-lookup.mjs --file <每行一个域名的文件> --out out.jsonl [选项]

Provider:
  --provider webcafe     默认。免费，走 seo.web.cafe /mine/api/domain，吃站点共享配额
  --provider tabapi      AITDK 扩展背后的官方付费 API，需要 TABAPI_KEY，按 credit 计费
  --months <3-12>        仅 tabapi：回溯几个月，默认 3（按实际返回月数计费）

通道（仅 webcafe）:
  --via browser          把请求发进已登录的 Chrome，用那边的配额档位
  --session <name>       会话名，默认 demand-aitdk-lookup

输出:
  --json                 输出 JSON
  --out <file.jsonl>     逐条追加落盘，可续跑（强烈建议批量时使用）
  --limit <n>            批量时最多处理 n 个
  --evidence-dir <dir>   失败现场与 manifest 落点，默认 .rankup/evidence/demand/aitdk-lookup-<ts>/
  --help

注意：本脚本只采集，不做阈值筛选。出错的域名（配额 429、CAPTCHA、改版）会带着
HTTP 状态显示在默认输出里——「取数失败」和「字段为空」是两回事，判断交给 AI。`;

// ── provider: seo.web.cafe /mine/api/domain ─────────────────────────────────

const MINE_EXPR = (domain) => `(async()=>{
  const html = await (await fetch("/mine/", {credentials:"include"})).text();
  const tok = (html.match(/[0-9]{13}\\.[0-9a-f]{64}/)||[])[0];
  const hdr = (html.match(/X-[A-Z]{2,8}-Token/)||[])[0];
  const r = await fetch("/mine/api/domain", {method:"POST", credentials:"include",
    headers:{[hdr]:tok, "content-type":"application/json"},
    body: JSON.stringify({domain: ${JSON.stringify(domain)}})});
  return { status: r.status, data: await r.json().catch(()=>null) };
})()`;

let browserReady = false;
async function opencliEval(session, expr) {
  if (!browserReady) {
    // --via browser 是可选档位，桥没连上时原来要等满 120s 的 execFile timeout
    // 才报错，还是个和「桥」八竿子打不着的超时消息。先短探测，明确没连就直说。
    requireBrowserBridge();
    await execFileP('opencli', ['browser', session, '--window', 'background', 'open', `${BASE}/mine/`], { timeout: 120000 });
    browserReady = true;
    await sleep(2500);
  }
  const { stdout } = await execFileP('opencli', ['browser', session, '--window', 'background', 'eval', expr], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  const i = stdout.indexOf('{');
  if (i === -1) die(`opencli eval 没有返回 JSON：${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(i));
}

async function fetchWebcafe(domain, { via, session }) {
  if (via === 'browser') {
    const res = await opencliEval(session, MINE_EXPR(domain));
    if (res.status !== 200) {
      const f = saveEvidence(`webcafe-${domain}-${res.status}.json`, { domain, via, status: res.status, body: res.data ?? null });
      return { error: `HTTP ${res.status}（现场已留 ${f}）`, status: res.status };
    }
    return res.data || { error: '空响应', status: 200 };
  }
  const auth = await toolAuth('mine');
  const r = await fetch(`${BASE}/mine/api/domain`, {
    method: 'POST',
    headers: { ...auth, 'user-agent': UA, 'content-type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
  const t = await r.text();
  if (!r.ok) {
    const f = saveEvidence(`webcafe-${domain}-${r.status}.json`, {
      domain, via, url: `${BASE}/mine/api/domain`, status: r.status,
      headers: { 'content-type': r.headers.get('content-type'), 'retry-after': r.headers.get('retry-after') },
      body: t,
    });
    return { error: `HTTP ${r.status} ${t.slice(0, 120)}（现场已留 ${f}）`, status: r.status };
  }
  try { return JSON.parse(t); } catch {
    const f = saveEvidence(`webcafe-${domain}-nonjson.json`, { domain, via, status: r.status, body: t });
    return { error: `非 JSON 响应（现场已留 ${f}）`, status: r.status };
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
      topKeywords: (raw.topKeywords || []).map((k) => ({ keyword: k.name, volume: k.volume, cpc: k.cpc, isBrand: k.isBrand, isNav: k.isNav })),
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
initEvidence('aitdk-lookup', { dir: args['evidence-dir'] || null });

const provider = args.provider === 'tabapi' ? 'tabapi' : 'webcafe';
const via = args.via === 'browser' ? 'browser' : 'http';
const session = args.session || 'demand-aitdk-lookup';
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
  const raw = provider === 'tabapi' ? await fetchTabapi(domain, { months }) : await fetchWebcafe(domain, { via, session });
  const rec = normalize(domain, provider, raw);
  results.push(rec);
  recordSource({
    source: `${provider}${via === 'browser' ? '(browser)' : ''}:${domain}`,
    status: rec.error ? (rec.httpStatus ? `http_${rec.httpStatus}` : 'error') : 'ok',
    rawCount: rec.error ? 0 : 1,
    error: rec.error ?? undefined,
  });
  if (outFile && outFile.endsWith('.jsonl')) fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
  console.error(`${rec.error ? '✗' : '✓'} ${domain}${rec.error ? ` → ${rec.error}` : ''}`);
  await sleep(800);
}

if (via === 'browser' && browserReady) {
  try { await execFileP('opencli', ['browser', session, 'close'], { timeout: 60000 }); } catch { /* 关不掉不该让命令失败 */ }
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
    注册: r.error ? '' : r.registeredAt ? r.registeredAt.slice(0, 10) : '—',
    站龄天: r.error ? '' : r.ageDays ?? '—',
    月访问: r.error ? '' : r.monthlyVisits == null ? '—' : r.monthlyVisits.toLocaleString('en-US'),
    搜索占比: r.error ? '' : r.searchSharePct == null ? '—' : `${r.searchSharePct}%`,
    直接占比: r.error ? '' : r.directSharePct == null ? '—' : `${r.directSharePct}%`,
    环比: r.error ? '' : r.trendPct == null ? '—' : `${r.trendPct}%`,
    核心词: r.error
      ? String(r.error).slice(0, 60)
      : (r.topKeywords || []).filter((k) => !k.isBrand).slice(0, 3).map((k) => k.keyword).join(' / ') || '(只有品牌词)',
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
