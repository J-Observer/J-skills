#!/usr/bin/env node
/**
 * 用途：反查「谁在赚钱」。seo.web.cafe 的 Stripe 引荐流量榜是公开数据里少有的
 *       **真金白银信号**——一个域名往 Stripe 收银台送了多少访问，就意味着有多少人
 *       走到了付款那一步。不问用户想要什么，直接看钱已经流向了哪里。
 *
 *       同时实现两个派生指标：
 *         到达付费页比例 = Stripe 引荐流量 ÷ 网站月总访问量
 *         月营收估算     ≈ 月访问量 × 到达付费页比例 × 支付成功率 × 客单价
 *
 * 示例：
 *   node stripe-referring.mjs months
 *   node stripe-referring.mjs top --limit 20
 *   node stripe-referring.mjs top --m 202607 --limit 30 --json --out top.json
 *   node stripe-referring.mjs top --limit 10 --enrich --pay-rate 0.35 --aov 19
 *   node stripe-referring.mjs top --limit 10 --enrich --via browser --pay-rate 0.35 --aov 19
 *   node stripe-referring.mjs site --domain example.com
 *
 * 依赖：
 *   - 榜单本身：**零配置**，三个 /referring/* 端点不计配额、不需登录。
 *   - `--enrich`（补网站总访问量）走 /mine/api/domain，**要吃配额**
 *     （游客 10/日、登录 100/日、VIP 500/日，全站共用）。
 *     `--via browser` 把请求发进用户已登录的 Chrome，用的是那边的档位；
 *     不给 `--via browser` 就是匿名档。凭据全程不离开浏览器。
 *   - 也可以完全不花配额：`--visits visits.json`，内容是 {"域名": 月访问量} 的映射。
 *
 * 已验证日期：2026-08-24（months / top / top --enrich / site 四条命令都真跑过）
 *
 * 已知坑：
 *   1. **榜单 `visits` 的单位是千次（K）。** 2692.6 表示 269 万次。不换算会把量级看小 1000 倍。
 *   2. **月营收公式里的「总访问量」会自己约掉。**
 *      月访问量 × (Stripe引荐 ÷ 月访问量) × 支付成功率 × 客单价 ≡ Stripe引荐 × 支付成功率 × 客单价。
 *      所以营收估算其实只依赖榜单本身，不需要总访问量。总访问量的价值在**另一处**：
 *      到达付费页比例是独立的诊断指标——比例高说明这个站的流量筛得准（小而精），
 *      比例低说明它在靠体量硬砸。本脚本两个都算，但不要以为补了总访问量营收就更准了。
 *   3. 榜单只覆盖 Stripe。用 Creem / Paddle / Lemon Squeezy 的站根本不会出现在这里，
 *      「不在榜」不等于「不赚钱」。长尾网关反查见 payment-referrers.mjs。
 *   4. `--enrich` 每个域名 1 次配额，`--limit 30` 就是 30 次。先想清楚再跑。
 */

import { execFile } from '../../../backlink/scripts/lib-opencli-process.mjs';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { parseArgs, emit, die, sleep, requireBrowserBridge, sessionName } from './_lib.mjs';
import { BASE, UA, toolAuth } from '../seo-webcafe.mjs';

const execFileP = promisify(execFile);

const HELP = `Stripe 引荐流量榜 —— 反查谁在赚钱

用法: node stripe-referring.mjs <命令> [选项]

命令:
  months                 列出榜单覆盖的月份与每月总量/集中度
  top                    某月榜单（默认最新月），可选补总访问量与营收估算
  site  --domain <d>     某个域名在榜的历史轨迹

top 的选项:
  --m <YYYYMM>           指定月份，默认取 months 里的最后一个月
  --limit <n>            只取前 n 名，默认 25
  --min-visits <n>       过滤：Stripe 引荐流量（次/月）低于此值的丢掉
  --new-only             只保留本月新进榜的域名（isNew），最强的「新机会」信号
  --enrich               补每个域名的月总访问量，用来算到达付费页比例（吃配额！）
  --visits <file>        用本地 JSON 映射 {"域名": 月访问量} 代替 --enrich，不花配额
  --via browser          --enrich 时把请求发进已登录的 Chrome（拿高档配额）
  --session <name>       --via browser 的会话名，默认 demand-stripe-referring-<会话后缀>
                         （后缀取并发单位，见 _lib.sessionName——字面常量会撞标签页）
  --pay-rate <0~1>       支付成功率（无默认值，必须自己给）
  --aov <number>         客单价（美元，无默认值，必须自己给）

通用选项:
  --json                 输出 JSON 而不是表格
  --out <file>           落盘（.jsonl 走 JSON Lines，其它走 pretty JSON）
  --help

营收估算只有同时给了 --pay-rate 和 --aov 才会算。两个都是你对这门生意的**假设**，
不是数据；脚本不提供默认值，就是为了逼你把假设写出来。`;

// ── 取数：两条通道 ───────────────────────────────────────────────────────────
// 直连（匿名）与「发进已登录浏览器」。后者不是为了绕过什么，而是因为
// seo.web.cafe 的登录 cookie 是 httpOnly，node 侧拿不到，把调用挪进页面里
// 是唯一既能用上高档配额、又不需要把凭据搬出浏览器的做法。

async function apiGet(path, params) {
  const auth = await toolAuth('referring');
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const r = await fetch(`${BASE}${path}${qs}`, { headers: { ...auth, 'user-agent': UA } });
  const t = await r.text();
  if (!r.ok) die(`GET ${path} → HTTP ${r.status} ${t.slice(0, 160)}`);
  try { return JSON.parse(t); } catch { die(`GET ${path} 返回的不是 JSON：${t.slice(0, 160)}`); }
}

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
async function closeBrowser(session) {
  if (!browserReady) return;
  try { await execFileP('opencli', ['browser', session, 'close'], { timeout: 60000 }); } catch { /* 关不掉不该让整个命令失败 */ }
}

/**
 * 取一个域名的月总访问量。走 /mine/api/domain —— 它返回的字段和 AITDK 插件那一套
 * 完全对得上（visits / registeredAt / topKeywords），详见 aitdk-lookup.mjs。
 */
const MINE_EXPR = (domain) => `(async()=>{
  const html = await (await fetch("/mine/", {credentials:"include"})).text();
  const tok = (html.match(/[0-9]{13}\\.[0-9a-f]{64}/)||[])[0];
  const hdr = (html.match(/X-[A-Z]{2,8}-Token/)||[])[0];
  const r = await fetch("/mine/api/domain", {method:"POST", credentials:"include",
    headers:{[hdr]:tok, "content-type":"application/json"},
    body: JSON.stringify({domain: ${JSON.stringify(domain)}})});
  return { status: r.status, data: await r.json().catch(()=>null) };
})()`;

/**
 * 返回 {visits, status}，绝不把「取数失败」折叠成 null：
 * 配额 4xx/解析失败和「没请求过」在输出里必须长得不一样，
 * 否则 --enrich 撞配额的那一列会被读成「这些站没有总访问量数据」。
 */
async function totalVisits(domain, { via, session }) {
  if (via === 'browser') {
    const res = await opencliEval(session, MINE_EXPR(domain));
    if (res?.status !== 200 || !res.data) return { visits: null, status: `http_${res?.status ?? 'noresp'}` };
    return { visits: res.data.visits ?? null, status: 'ok' };
  }
  const auth = await toolAuth('mine');
  const r = await fetch(`${BASE}/mine/api/domain`, {
    method: 'POST',
    headers: { ...auth, 'user-agent': UA, 'content-type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
  if (!r.ok) return { visits: null, status: `http_${r.status}` };
  const d = await r.json().catch(() => null);
  if (!d) return { visits: null, status: 'parse_error' };
  return { visits: d.visits ?? null, status: 'ok' };
}

// ── 派生指标 ────────────────────────────────────────────────────────────────

const K = 1000; // 榜单 visits 的单位是千次

function derive(row, monthlyVisits, payRate, aov) {
  const stripeVisits = Math.round((row.visits ?? 0) * K);
  const reachRatio = monthlyVisits ? stripeVisits / monthlyVisits : null;
  const revenue = payRate != null && aov != null ? stripeVisits * payRate * aov : null;
  return { stripeVisits, monthlyVisits: monthlyVisits ?? null, reachRatio, revenueEstimate: revenue };
}

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
const num = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));

// ── 命令 ────────────────────────────────────────────────────────────────────

async function cmdMonths(args) {
  const s = await apiGet('/referring/api/summary');
  const rows = (s.totals || []).map((t) => ({
    月份: t.month,
    榜单总引荐: num(t.visits),
    上榜集中度: `${t.listedShare}%`,
    前十占比: `${t.top10Share}%`,
    长尾占比: `${t.longtailShare}%`,
  }));
  emit(rows, args, [
    { key: '月份', label: '月份' }, { key: '榜单总引荐', label: '榜单总引荐' },
    { key: '上榜集中度', label: '上榜集中度' }, { key: '前十占比', label: '前十占比' },
    { key: '长尾占比', label: '长尾占比' },
  ]);
}

async function cmdTop(args) {
  let m = args.m;
  if (!m) {
    const s = await apiGet('/referring/api/summary');
    m = (s.months || []).at(-1);
    if (!m) die('summary 里没有月份列表，站点可能改版了');
    console.error(`· 未指定 --m，取最新月 ${m}`);
  }
  const data = await apiGet('/referring/api/month', { m });
  let rows = data.rows || [];
  if (args['new-only']) rows = rows.filter((r) => r.isNew);
  const minVisits = args['min-visits'] ? Number(args['min-visits']) : null;
  if (minVisits) rows = rows.filter((r) => (r.visits ?? 0) * K >= minVisits);
  rows = rows.slice(0, Number(args.limit || 25));

  const payRate = args['pay-rate'] != null ? Number(args['pay-rate']) : null;
  const aov = args.aov != null ? Number(args.aov) : null;

  let visitsMap = {};
  if (args.visits) visitsMap = JSON.parse(fs.readFileSync(args.visits, 'utf8'));

  // 会话名不许是字面常量（纪律见 _lib.sessionName）：两个并行任务撞名就共用标签页。
  const session = args.session || sessionName('demand-stripe-referring');
  const via = args.via === 'browser' ? 'browser' : 'http';
  if (args.enrich) console.error(`· --enrich 会消耗 ${rows.length} 次 seo.web.cafe 配额（通道 ${via}）`);

  const out = [];
  let enrichFailed = 0;
  for (const r of rows) {
    let mv = visitsMap[r.domain] ?? null;
    // 三种状态分开：not_requested（没开 --enrich 也不在 --visits 里）/ ok / 具体失败码。
    let mvStatus = mv != null ? 'ok' : 'not_requested';
    if (mv == null && args.enrich) {
      const t = await totalVisits(r.domain, { via, session });
      mv = t.visits;
      mvStatus = t.status;
      if (t.status !== 'ok') enrichFailed += 1;
      await sleep(800);
    }
    const d = derive(r, mv, payRate, aov);
    out.push({
      月份: m, 名次: r.pos, 域名: r.domain,
      Stripe引荐: num(d.stripeVisits),
      // `—` 只表示「没请求过」；请求了但失败要把失败码亮出来，
      // 配额耗尽的一列不许和「无数据」长得一样。
      月总访问: mvStatus === 'ok' ? num(d.monthlyVisits)
        : mvStatus === 'not_requested' ? '—' : `失败(${mvStatus})`,
      到达付费页比例: pct(d.reachRatio),
      月营收估算: d.revenueEstimate == null ? '—' : `$${num(d.revenueEstimate)}`,
      榜内份额: `${r.share}%`,
      环比: r.change == null ? '—' : `${r.change > 0 ? '+' : ''}${r.change}%`,
      新进: r.isNew ? '新' : r.isReturn ? '回' : '',
      全球排名: r.globalRank ?? '—',
      _raw: { ...r, ...d, monthlyVisitsStatus: mvStatus },
    });
  }
  if (args.enrich && via === 'browser') await closeBrowser(session);
  if (enrichFailed) {
    console.error(`注意：--enrich 有 ${enrichFailed}/${rows.length} 个域名取数失败（多半是配额）——` +
      '那些行缺的是「没取到」，不是「无总访问量」。');
  }

  emit(out, args, [
    { key: '名次', label: '#' }, { key: '域名', label: '域名', max: 32 },
    { key: 'Stripe引荐', label: 'Stripe引荐' }, { key: '月总访问', label: '月总访问' },
    { key: '到达付费页比例', label: '到达付费页' }, { key: '月营收估算', label: '月营收估算' },
    { key: '榜内份额', label: '份额' }, { key: '环比', label: '环比' }, { key: '新进', label: '新' },
  ]);
}

async function cmdSite(args) {
  const domain = args.domain || die('site 需要 --domain');
  const d = await apiGet('/referring/api/site', { domain });
  const s = d.stats || {};
  console.error(
    `· ${d.domain}：在榜 ${s.monthsOn}/${s.monthsTotal} 月 · 最好名次 ${s.bestPos} · 均名 ${s.avgPos} · ` +
    `累计送出 ${num((s.totalSentK ?? 0) * K)} 次 · 最新月${s.onLatest ? '在榜' : '不在榜'}`
  );
  const payRate = args['pay-rate'] != null ? Number(args['pay-rate']) : null;
  const aov = args.aov != null ? Number(args.aov) : null;
  const rows = (d.rows || []).map((r) => {
    const v = Math.round((r.visits ?? 0) * K);
    return {
      月份: r.month, 名次: r.pos, Stripe引荐: num(v), 榜内份额: `${r.share}%`,
      环比: r.change == null ? '—' : `${r.change > 0 ? '+' : ''}${r.change}%`,
      月营收估算: payRate != null && aov != null ? `$${num(v * payRate * aov)}` : '—',
      _raw: r,
    };
  });
  emit(rows, args, [
    { key: '月份', label: '月份' }, { key: '名次', label: '#' },
    { key: 'Stripe引荐', label: 'Stripe引荐' }, { key: '榜内份额', label: '份额' },
    { key: '环比', label: '环比' }, { key: '月营收估算', label: '月营收估算' },
  ]);
}

const args = parseArgs();
const cmd = args._[0];
if (args.help || !cmd) { console.log(HELP); process.exit(0); }
const table = { months: cmdMonths, top: cmdTop, site: cmdSite };
if (!table[cmd]) die(`未知命令 ${cmd}（--help 看用法）`);
await table[cmd](args);
