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
 * *   node stripe-referring.mjs site --domain example.com
 *
 * 依赖：官方 gefei CLI 自管凭据，本脚本不读取令牌或配置。
 * 2026-09-30 目录/实测：stripe_checkout_referrals 每次 1 积分；month 返回前 20 名，
 * site 返回 monthly 与 stats；overview 返回最近月份（最多 12），不是完整历史总表。
 * --enrich 经官方 domain_overview，每域 2 积分；--visits 可复用本地数据。
 * 官方月榜仅前20名；超过20或--new-only保留旧全榜请求，不能称全榜已迁。
 * 官方 Skill 暂无全榜筛选等价（目录/试用2026-09-30）；旧全榜原记录不计每日配额，
 * 本轮探测预算用尽，未重新验证该端点当前状态。凭据经原取数方式留在进程内。
 * 未知字段保持 null / 未知。
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
 *   4. `--enrich` 每域消耗官方积分，批量前核对目录价格。
 */

import { execFile } from 'node:child_process';
import { gefeiEnv, gefeiScript } from '../lib-gefei-env.mjs';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emit, die, sleep } from './_lib.mjs';
import { BASE, UA, toolAuth } from '../seo-webcafe.mjs';

const execFileP = promisify(execFile);

const HELP = `Stripe 引荐流量榜 —— 反查谁在赚钱

用法: node stripe-referring.mjs <命令> [选项]

命令:
  months                 最近 12 个月的总量/集中度（官方 overview 范围）
  top                    某月榜单（默认最新月），可选补总访问量与营收估算
  site  --domain <d>     某个域名在榜的历史轨迹

top 的选项:
  --m <YYYYMM>           指定月份，默认取 months 里的最后一个月
  --limit <n>            只取前 n 名，默认 25；超过 20 或 --new-only 用保留旧全榜
  --min-visits <n>       过滤：Stripe 引荐流量（次/月）低于此值的丢掉
  --new-only             只保留本月新进榜的域名（isNew），最强的「新机会」信号
  --enrich               补每个域名的月总访问量，用来算到达付费页比例（官方积分）
  --visits <file>        用本地 JSON 映射 {"域名": 月访问量} 代替 --enrich，不花积分
  --pay-rate <0~1>       支付成功率（无默认值，必须自己给）
  --aov <number>         客单价（美元，无默认值，必须自己给）

通用选项:
  --json                 输出 JSON 而不是表格
  --out <file>           落盘（.jsonl 走 JSON Lines，其它走 pretty JSON）
  --help

营收估算只有同时给了 --pay-rate 和 --aov 才会算。两个都是你对这门生意的**假设**，
不是数据；脚本不提供默认值，就是为了逼你把假设写出来。`;

// 官方 CLI 自管凭据；stderr 保留扣费与请求号。
async function official(tool, params) {
  const { stdout, stderr } = await execFileP(process.execPath, [
    gefeiScript(),
    tool, '--data', JSON.stringify(params), '--json',
  ], { env: gefeiEnv(), timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (stderr) process.stderr.write(stderr);
  return JSON.parse(stdout);
}

// 官方月榜仅前20；旧全榜仍承担超过20名及新进筛选，不能静默缩减覆盖。
async function fullMonth(month) {
  const auth = await toolAuth('referring');
  const response = await fetch(`${BASE}/referring/api/month?${new URLSearchParams({ m: month })}`, {
    headers: { ...auth, 'user-agent': UA },
  });
  if (!response.ok) die(`旧全榜取数失败：HTTP ${response.status}`);
  return response.json();
}

async function totalVisits(domain) {
  try {
    const data = await official('domain_overview', { domain });
    return { visits: data.visits ?? null, status: data.noData ? 'no_data' : 'ok' };
  } catch (error) {
    console.error(String(error.stderr || error.message));
    return { visits: null, status: 'cli_error' };
  }
}

// ── 派生指标 ────────────────────────────────────────────────────────────────

const K = 1000; // 榜单 visits 的单位是千次

function derive(row, monthlyVisits, payRate, aov) {
  const stripeVisits = row.visits == null ? null : Math.round(row.visits * K);
  const reachRatio = monthlyVisits && stripeVisits != null ? stripeVisits / monthlyVisits : null;
  const revenue = stripeVisits != null && payRate != null && aov != null ? stripeVisits * payRate * aov : null;
  return { stripeVisits, monthlyVisits: monthlyVisits ?? null, reachRatio, revenueEstimate: revenue };
}

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
const num = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));

// ── 命令 ────────────────────────────────────────────────────────────────────

async function cmdMonths(args) {
  const s = await official('stripe_checkout_referrals', { view: 'overview', recentMonths: 12 });
  const rows = (s.recentTotals || []).map((t) => ({
    月份: t.month,
    榜单总引荐: num(t.visits),
    上榜集中度: t.listedShare == null ? '未知' : `${t.listedShare}%`,
    前十占比: t.top10Share == null ? '未知' : `${t.top10Share}%`,
    长尾占比: t.longtailShare == null ? '未知' : `${t.longtailShare}%`,
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
    const s = await official('stripe_checkout_referrals', { view: 'overview', recentMonths: 12 });
    m = s.dataRange?.to;
    if (!m) die('官方 overview 没有 dataRange.to，站点可能改版了');
    console.error(`· 未指定 --m，取最新月 ${m}`);
  }
  const limit = Number(args.limit || 25);
  const full = limit > 20 || args['new-only'];
  const data = full ? await fullMonth(m)
    : await official('stripe_checkout_referrals', { view: 'month', month: m });
  console.error(full ? '· 使用保留旧全榜（原记录不计每日配额，本轮未重验可用性）'
    : '· 官方月榜仅返回前 20 名，筛选结果不代表全榜');
  let rows = full ? data.rows || [] : data.top || [];
  if (args['new-only']) rows = rows.filter((r) => r.isNew);
  const minVisits = args['min-visits'] ? Number(args['min-visits']) : null;
  if (minVisits) rows = rows.filter((r) => (r.visits ?? 0) * K >= minVisits);
  rows = rows.slice(0, limit);

  const payRate = args['pay-rate'] != null ? Number(args['pay-rate']) : null;
  const aov = args.aov != null ? Number(args.aov) : null;

  let visitsMap = {};
  if (args.visits) visitsMap = JSON.parse(fs.readFileSync(args.visits, 'utf8'));

  if (args.enrich) console.error(`· --enrich 每域调用 domain_overview，当前 2 积分/域名（共 ${rows.length} 域）`);

  const out = [];
  let enrichFailed = 0;
  for (const r of rows) {
    let mv = visitsMap[r.domain] ?? null;
    // 三种状态分开：not_requested（没开 --enrich 也不在 --visits 里）/ ok / 具体失败码。
    let mvStatus = mv != null ? 'ok' : 'not_requested';
    if (mv == null && args.enrich) {
      const t = await totalVisits(r.domain);
      mv = t.visits;
      mvStatus = t.status;
      if (t.status !== 'ok') enrichFailed += 1;
      await sleep(800);
    }
    const d = derive(r, mv, payRate, aov);
    out.push({
      月份: m, 名次: r.pos ?? null, 域名: r.domain,
      Stripe引荐: num(d.stripeVisits),
      // `—` 只表示「没请求过」；请求了但失败要把失败码亮出来，
      // 配额耗尽的一列不许和「无数据」长得一样。
      月总访问: mvStatus === 'ok' ? num(d.monthlyVisits)
        : mvStatus === 'not_requested' ? '—' : `失败(${mvStatus})`,
      到达付费页比例: pct(d.reachRatio),
      月营收估算: d.revenueEstimate == null ? '—' : `$${num(d.revenueEstimate)}`,
      榜内份额: r.share == null ? '未知' : `${r.share}%`,
      环比: r.change == null ? '—' : `${r.change > 0 ? '+' : ''}${r.change}%`,
      新进: r.isNew == null && r.isReturn == null ? '未知' : r.isNew ? '新' : r.isReturn ? '回' : '',
      全球排名: r.globalRank ?? '—',
      _raw: { ...r, ...d, monthlyVisitsStatus: mvStatus },
    });
  }
  if (enrichFailed) {
    console.error(`注意：--enrich 有 ${enrichFailed}/${rows.length} 个域名取数失败（见官方 CLI 错误）——` +
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
  const d = await official('stripe_checkout_referrals', { view: 'site', domain });
  if (d.noData) console.error('· 官方返回 noData：未观察到在榜历史，不代表没有收入');
  const s = d.stats || {};
  console.error(
    `· ${d.domain}：在榜 ${s.monthsOn ?? "未知"}/${s.monthsTotal ?? "未知"} 月 · 最好名次 ${s.bestPos ?? "未知"} · 均名 ${s.avgPos ?? "未知"} · ` +
    `累计送出 ${num(s.totalSentK == null ? null : s.totalSentK * K)} 次 · 最新月${s.onLatest == null ? '未知' : s.onLatest ? '在榜' : '不在榜'}`
  );
  const payRate = args['pay-rate'] != null ? Number(args['pay-rate']) : null;
  const aov = args.aov != null ? Number(args.aov) : null;
  const rows = (d.monthly || []).map((r) => {
    const v = r.visits == null ? null : Math.round(r.visits * K);
    return {
      月份: r.month ?? null, 名次: r.pos ?? null, Stripe引荐: num(v), 榜内份额: r.share == null ? '未知' : `${r.share}%`,
      环比: r.change == null ? '—' : `${r.change > 0 ? '+' : ''}${r.change}%`,
      月营收估算: v != null && payRate != null && aov != null ? `$${num(v * payRate * aov)}` : '—',
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
