#!/usr/bin/env node
/**
 * 用途：长尾支付网关反查。Stripe 榜（stripe-referring.mjs）只覆盖 Stripe，
 *       而独立开发者大量用 Creem / Lemon Squeezy / Paddle / FastSpring / Dodo /
 *       Polar / Gumroad / Payhip，国内用虎皮椒 / PayJS。
 *       本脚本回答同一个问题——**谁在往这些收银台送人**——用两条互补的路径：
 *
 *   serp        用「结账域名 / powered-by 徽标 / SDK 脚本域名」当指纹去搜索引擎反查。
 *               按引擎消耗积分或公开搜索，覆盖广，但**噪音大**：搜到的多是文档、SDK、教程，
 *               真正的商户站要靠 --exclude 和人工过一遍。适合发现生态与集成方。
 *   similarweb  查网关域名自己的「引荐流量 · 流入」报表，直接列出**给它送流量的域名**
 *               及各自占比。这才是干净的商户清单，但要共享面板的登录态与配额。
 *
 * 示例：
 *   node payment-referrers.mjs list
 *   node payment-referrers.mjs serp creem --json
 *   node payment-referrers.mjs serp lemonsqueezy --engine brave
 *   node payment-referrers.mjs serp paddle --query '"powered by Paddle" -site:paddle.com'
 *   node payment-referrers.mjs similarweb creem --out creem-referrers.json
 *   node payment-referrers.mjs similarweb polar --direction outgoing
 *
 * 依赖：
 *   - serp --engine webcafe（默认）：官方 gefei CLI 的 serp，2 积分/查询。
 *     2026-09-30 目录核对；使用 Google 原始自然结果，不再走旧需求翻译端点。
 *     官方 CLI 自管凭据，本脚本不读取令牌或配置。
 *   - serp --engine brave：`opencli brave search`，**不花配额**，但实测覆盖差、
 *     对 `-site:` 之类算符基本无效，常直接 EMPTY_RESULT。当兜底用，别当主力。
 *   - similarweb：复用 backlink Skill 的共享面板启动器
 *     （../../backlink/scripts/lib-tools-share.mjs）。需要那边的登录态/令牌。
 *     **有配额**，开工前先看启动时打印的配额百分比，不要跑批量。
 *
 * 已验证日期：2026-08-24
 *
 * 已知坑：
 *   1. **Similarweb 是 hash 路由 SPA，直接深链到 referrals 会有一定概率白屏**
 *      （实测同一条 URL 两次，一次出数一次空）。本脚本因此先落到已知稳定的
 *      marketing-channels 路由，再切到 referrals，并轮询「只有数据到了才会出现的字符串」。
 *      即便如此仍可能超时——那是站点行为，不是脚本坏了，重跑即可。
 *      **这条「白屏」至今未被实测过**：2026-08-28 之前 marketing-channels 那一跳
 *      必抛错（窗口段误报），referrals 那一跳从来没被执行到。窗口误报修掉之后
 *      它才第一次会跑起来，这条链路上的白屏概率仍是开放问题。
 *   1b. **面板会改写时间窗口**：小站没有 28 天数据时，`.../999/28d` 会静默落到
 *      `.../999/6m`（2026-08-28 实测 creem.io；同一条路由在 canva.com 上不改写）。
 *      本脚本的全部用途就是查小站，所以这是常态而非异常。输出里的
 *      `requestedWindow` / `window` / `windowRewritten` / `windowSource` 记的就是这件事——
 *      **拿数字之前先看 `window`，那才是这些百分比真正对应的时间跨度。**
 *      改写有**两条通道**：路由末段（上面这条），以及查询串里的窗口参数
 *      （2026-08-29 实测 canva.com：`?duration=365d` 被改成 `28d`，那条路由的末段是
 *      `999`，路径通道完全看不见它）。`windowSource` 说的就是哪一扇门。
 *      改写还可能发生在 **settle 之后**，所以这里在轮询收敛时用当时的 `location.href`
 *      重算一次窗口，比导航瞬间那次更接近最终值。
 *   2. **`-site:` 在 Brave / DuckDuckGo 上基本无效**（实测直接返回无结果）。
 *      真要排除自身域名就用 --exclude，在本地过滤，不要指望搜索引擎。
 *   3. 指纹表里的结账域名会变（网关改版就会失效）。跑出来全是文档站时，
 *      第一件事是去网关官网看一眼现在的 checkout URL 长什么样，然后更新 GATEWAYS。
 *   4. 「搜不到」不等于「没人用」。小网关的商户站通常没有外链、也不被索引，
 *      SERP 天然看不到它们；这种时候只有 similarweb 那条路。
 */

import { execFile } from 'node:child_process';
import { gefeiEnv } from '../lib-gefei-env.mjs';
import { promisify } from 'node:util';
import {
  parseArgs, emit, die, sleep, printTable,
  initEvidence, saveEvidence, recordSource, writeManifest, captureBrowserScene, evidenceDir,
} from './_lib.mjs';
import path from 'node:path';
import { homedir } from 'node:os';

const execFileP = promisify(execFile);

/**
 * 网关指纹表。每加一个网关只动这里。
 *   own       网关自己的域名（结果里要排除掉，否则前十全是它自己的文档）
 *   queries   反查用的检索式，按「越像商户页越靠前」排序
 */
const GATEWAYS = {
  stripe: {
    label: 'Stripe',
    own: ['stripe.com', 'stripe.dev'],
    queries: ['"checkout.stripe.com" -site:stripe.com', '"buy.stripe.com"'],
    note: '有专门的引荐流量榜，优先用 stripe-referring.mjs',
  },
  creem: {
    label: 'Creem',
    own: ['creem.io'],
    queries: ['"checkout.creem.io"', '"powered by Creem"', '"www.creem.io/payment"'],
  },
  lemonsqueezy: {
    label: 'Lemon Squeezy',
    own: ['lemonsqueezy.com'],
    queries: ['"powered by Lemon Squeezy"', '".lemonsqueezy.com/checkout"', '"lemonsqueezy.com/buy"'],
  },
  paddle: {
    label: 'Paddle',
    own: ['paddle.com'],
    queries: ['"buy.paddle.com"', '"powered by Paddle"', '"cdn.paddle.com/paddle"'],
  },
  fastspring: {
    label: 'FastSpring',
    own: ['fastspring.com'],
    queries: ['".onfastspring.com"', '"powered by FastSpring"'],
  },
  dodo: {
    label: 'Dodo Payments',
    own: ['dodopayments.com'],
    queries: ['"checkout.dodopayments.com"', '"powered by Dodo Payments"'],
  },
  polar: {
    label: 'Polar',
    own: ['polar.sh'],
    queries: ['"polar.sh/checkout"', '"buy.polar.sh"', '"powered by Polar"'],
  },
  gumroad: {
    label: 'Gumroad',
    own: ['gumroad.com'],
    queries: ['".gumroad.com/l/"', '"powered by Gumroad"'],
  },
  payhip: {
    label: 'Payhip',
    own: ['payhip.com'],
    queries: ['"payhip.com/b/"', '"powered by Payhip"'],
  },
  xunhupay: {
    label: '虎皮椒 XunhuPay',
    own: ['xunhupay.com', 'xunhuweb.com'],
    queries: ['"api.xunhupay.com"', '"虎皮椒" 支付 接入', '"xunhupay"'],
  },
  payjs: {
    label: 'PayJS',
    own: ['payjs.cn'],
    queries: ['"payjs.cn/api"', '"payjs" 支付接口 接入', '"https://payjs.cn"'],
  },
};

const HELP = `长尾支付网关反查 —— 谁在往这些收银台送人

用法: node payment-referrers.mjs <命令> [选项]

命令:
  list                        列出内置网关与它们的反查指纹
  serp <网关|--query ...>     用指纹在搜索引擎反查引用它的站（广但噪音大）
  similarweb <网关>           查网关自己的引荐流量报表（干净，但要面板配额）

serp 选项:
  --engine webcafe|brave      默认 webcafe（官方 Google serp，2 积分/查询）
  --query <检索式>            用自定义检索式，覆盖内置指纹（可重复）
  --max-queries <n>           最多跑几条内置指纹，默认 2（省配额）
  --exclude <域名>            额外排除的域名（可重复）；网关自身域名总是排除
  --keep-docs                 不过滤 github/npm/文档站等开发者噪音源

similarweb 选项:
  --direction incoming|outgoing   默认 incoming（谁给它送流量）
  --sw-session <name>         面板会话名，默认 demand-payment-sw
  --settle <秒>               SPA 渲染等待，默认 20；白屏就调大

通用: --json  --out <file>  --evidence-dir <d>  --help

失败留现场（2026-08-30 重构第二波，截图链路已实盘验证）：
  serp 逐 query 记状态进 manifest（查询失败 ≠ 没人引用）；similarweb 白屏时
  截图+页面文本先落证据目录再退出，标签页留在原地供人工排查。`;

// 开发者噪音源：这些站几乎必然出现在任何「支付 SDK」检索里，
// 但它们不是商户，留着会把结果淹掉。--keep-docs 可以关掉这层过滤。
const DEV_NOISE = /(^|\.)(github\.com|github\.io|gitlab\.com|npmjs\.com|jsdelivr\.com|unpkg\.com|stackoverflow\.com|medium\.com|dev\.to|readthedocs\.io|context7\.com|packagist\.org|pypi\.org|reddit\.com|youtube\.com)$/i;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const isUnder = (host, roots) => roots.some((r) => host === r || host.endsWith(`.${r}`));

// ── serp ────────────────────────────────────────────────────────────────────

async function searchWebcafe(query) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [
      path.join(homedir(), '.claude/skills/gefei/scripts/webcafe.mjs'),
      'serp', '--q', query, '--gl', 'us', '--hl', 'en', '--json',
    ], { env: gefeiEnv(), timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    if (stderr) process.stderr.write(stderr);
    return JSON.parse(stdout);
  } catch (error) {
    return { error: String(error.stderr || error.message).trim() };
  }
}

async function searchBrave(query) {
  try {
    const { stdout } = await execFileP('opencli', ['brave', 'search', query, '-f', 'json'], { timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
    const i = stdout.indexOf('[');
    if (i === -1) return { error: 'Brave 无结果' };
    return { organic: JSON.parse(stdout.slice(i)).map((x) => ({ position: x.rank, title: x.title, link: x.url, snippet: x.snippet })) };
  } catch (e) {
    // opencli 在无结果时退出码非 0；这是「没搜到」不是「脚本坏了」，要说清楚。
    return { error: `Brave 查询失败或无结果（${String(e.message).split('\n')[0].slice(0, 100)}）` };
  }
}

async function cmdSerp(args) {
  const key = args._[1];
  const custom = args.query ? (Array.isArray(args.query) ? args.query : [args.query]) : [];
  const gw = key ? GATEWAYS[key] : null;
  if (!gw && !custom.length) die(`serp 需要网关名（${Object.keys(GATEWAYS).join(' / ')}）或 --query`);
  const queries = custom.length ? custom : gw.queries.slice(0, Number(args['max-queries'] || 2));
  const own = [...(gw?.own || []), ...(args.exclude ? [].concat(args.exclude) : [])];
  const engine = args.engine === 'brave' ? 'brave' : 'webcafe';
  initEvidence('payment-referrers', { dir: args['evidence-dir'] ?? null });
  if (engine === 'webcafe') console.error(`· 将消耗 ${queries.length} 次官方 serp 调用（2 积分/次，gl=us hl=en）`);

  const byHost = new Map();
  for (const q of queries) {
    const res = engine === 'brave' ? await searchBrave(q) : await searchWebcafe(q);
    if (res.error) {
      // 逐 query 记状态：查询失败/无结果和「没人引用这个网关」在 manifest 里分得开。
      recordSource({ source: `serp:${engine}:${q}`, status: 'query_failed', rawCount: 0, error: res.error });
      console.error(`✗ ${q} → ${res.error}`);
      continue;
    }
    const hits = res.organic || [];
    recordSource({ source: `serp:${engine}:${q}`, status: 'ok', rawCount: hits.length });
    console.error(`✓ ${q} → ${hits.length} 条`);
    for (const h of hits) {
      const host = hostOf(h.link);
      if (!host) continue;
      if (isUnder(host, own)) continue;
      if (!args['keep-docs'] && DEV_NOISE.test(host)) continue;
      const cur = byHost.get(host) || { 域名: host, 命中次数: 0, 命中指纹: new Set(), 首条标题: h.title, 证据: h.link };
      cur.命中次数 += 1;
      cur.命中指纹.add(q);
      byHost.set(host, cur);
    }
    await sleep(600);
  }


  const rows = [...byHost.values()]
    .map((r) => ({ ...r, 命中指纹: [...r.命中指纹].join(' | '), 网关: gw?.label ?? '(自定义)' }))
    .sort((a, b) => b.命中次数 - a.命中次数);
  emit(rows, args, [
    { key: '域名', label: '候选域名', max: 34 }, { key: '命中次数', label: '命中' },
    { key: '首条标题', label: '标题', max: 40 }, { key: '证据', label: '证据 URL', max: 52 },
  ]);
}

// ── similarweb ──────────────────────────────────────────────────────────────

async function cmdSimilarweb(args) {
  const key = args._[1];
  const gw = GATEWAYS[key];
  const domain = gw ? gw.own[0] : key;
  if (!domain) die(`similarweb 需要网关名（${Object.keys(GATEWAYS).join(' / ')}）或一个域名`);
  const tab = args.direction === 'outgoing' ? 'outgoingTraffic' : 'incomingTraffic';
  // 只在调用方显式给了名字时才传：Similarweb 是配额站，launchTool 会把缺省收敛到
  // similarweb-nav。原来这里写死 'demand-payment-sw'，等于每次都在跟那条收敛较劲。
  const session = args['sw-session'];
  const settle = Number(args.settle || 20);
  initEvidence('payment-referrers', { dir: args['evidence-dir'] ?? null });

  // 跨 Skill 引用：启动器只有 backlink 那一份是对的（四个必须踩对的细节都在里面）。
  // 自己再抄一份简化版正是那边文档点名的历史事故，所以宁可跨目录 import。
  let lib, core;
  try {
    lib = await import(new URL('../../../backlink/scripts/lib-tools-share.mjs', import.meta.url).href);
    core = await import(new URL('../../../backlink/scripts/opencli-core.mjs', import.meta.url).href);
  } catch (e) {
    die(`找不到 backlink Skill 的共享面板启动器（${e.message}）。\n这条路径要求 rankup 与 backlink 两个 Skill 在同一层目录下。`);
  }

  let out;
  // 实际用上的会话名要从 launchTool 的返回里拿：Similarweb 是配额站，
  // 不传 --sw-session 时 launchTool 会把它收敛到固定的 similarweb-nav。
  // 原来 finally 里关的是这里的 `session`（多半是 undefined），等于没关——
  // 2026-08-28 就这样在一次未捕获抛错里泄漏过一个标签页。
  // 只关自己开的这一个会话，**绝不调用 cleanup**（那会连别人的标签页一起端掉）。
  let openedSession = null;
  try {
    const l = await lib.launchTool({ session, tool: 'similarweb', window: 'background', wait: 8, timeout: 60 });
    openedSession = l.session ?? session ?? null;
    const ev = l.evalPage;
    console.error(`· 面板订阅到期 ${l.state.expiry ?? '—'}（剩 ${l.state.daysLeft ?? '—'} 天）· 配额 ${JSON.stringify(l.state.quotas ?? '—')}`);
    const base = 'https://similarweb.example.com/#/digitalsuite/websiteanalysis';
    // 先落到已知稳定的路由再切过去；直接深链到 referrals 有概率白屏。
    //
    // **请求的窗口是 28d，但面板会自己改写它。** 2026-08-28 实测 creem.io：
    // marketing-channels 请求 `.../999/28d` 落地 `.../999/6m`（顶层报表没变，只有窗口段）。
    // 合理解释是小站没有 28 天数据，面板自动放宽。同一条路由在 canva.com 上不改写,
    // 所以这个网关脚本（全部用途就是查 creem / lemonsqueezy 这类小站）**必踩**。
    // gotoInTool 现在容忍这条改写并把真实窗口回传，我们必须把它写进输出。
    const hopWindow = (await lib.gotoInTool(ev, `${base}/traffic-overview/marketing-channels/999/28d/?webSource=Total&key=${encodeURIComponent(domain)}`, 12)).routeWindow;
    const referralsUrl = `${base}/referrals/*/999/28d?webSource=Total&selectedTab=${tab}&key=${encodeURIComponent(domain)}`;
    // ⚠️ 开放问题（至今未验证）：本文件顶部「直接深链 referrals 有一定概率白屏」这句
    // 一直没被实测过——2026-08-28 之前，上面那次 marketing-channels 跳转必抛错，
    // 这一行**从来没被执行到**。修掉窗口误报之后它才第一次会跑起来。
    // 下面的轮询失败时要能区分两种情况：白屏（页面根本没渲染）与窗口被改写
    // （页面渲染了，但是另一个时间窗口的数字）——后者不是失败，只需正确标注。
    const refLanded = await lib.gotoInTool(ev, referralsUrl, settle);

    // 轮询「只有数据到了才会出现的东西」：这一页的表格里必然带 % 份额。
    const started = Date.now();
    let cap = null;
    while (Date.now() - started < 180000) {
      cap = await ev(`(()=>{
        const t=(document.body?.innerText||'');
        return { ready: /%/.test(t) && t.length > 800, url: location.href, text: t.slice(0, 30000) };
      })()`);
      if (cap.ready) break;
      await sleep(3000);
    }
    // 落地窗口以轮询结束时的 location.href 为准（面板可能在 settle 之后才改写窗口），
    // 取不到窗口段时退回导航当时回传的那份。
    const capWindow = cap?.url ? lib.routeWindow(referralsUrl, cap.url) : null;
    const timeWindow = (capWindow?.landed ? capWindow : refLanded.routeWindow) ?? null;

    if (!cap?.ready) {
      // 先取证后死：截图 + 轮询到的页面文本落进证据目录，白屏还是半渲染由 AI 看图判。
      // （die 用 process.exit 跳过 finally，标签页因此留在原地——现场也就保住了；
      //   排查完自己 close。截图链路已实盘验证。）
      const scene = openedSession ? captureBrowserScene(openedSession, `similarweb-${domain}-blank`) : null;
      saveEvidence(`similarweb-${domain}-last-poll.json`, { url: cap?.url ?? null, textLength: cap?.text?.length ?? 0, text: cap?.text ?? null, timeWindow });
      recordSource({ source: `similarweb:${domain}:${tab}`, status: 'render_timeout', rawCount: 0, scene });
      const rewritten = timeWindow?.rewritten ? `落地窗口是 ${timeWindow.landed}（请求的是 ${timeWindow.requested}）；` : '';
      die(`Similarweb 的引荐流量页没渲染出来（白屏或超时）。${rewritten}` +
        `页面正文 ${cap?.text?.length ?? 0} 字符、未出现份额百分比，属于白屏/未水合，不是窗口问题。` +
        `截图+页面文本已留 ${evidenceDir()}。加大 --settle 后重跑；这是 SPA 行为，不是脚本坏了。`);
    }

    // 表格在文本里是「一列域名，然后一列分类，然后一列排名，然后一列份额」这种竖排。
    // 靠位置配对极易错位，所以只做一件保守的事：把域名和百分比按各自出现顺序取出来，
    // 数量对得上才配对；对不上就只给域名清单并明确说明未配对。
    const lines = cap.text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    // 域名判据要卡死顶级域是 2 位以上纯字母，否则图表 X 轴上的日期标签
    // （实测出现过 `1.Aug`）会被当成域名混进清单里 —— 一条假数据比少一条更糟。
    const DOMAIN_RE = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
    const domains = lines
      .map((s) => s.toLowerCase())
      .filter((s) => {
        if (!DOMAIN_RE.test(s)) return false;
        const labels = s.split('.');
        const sld = labels[labels.length - 2];
        // `1.Aug` 这种日期标签：注册域名的二级标签不会是单个数字。
        if (sld.length < 2 || /^\d+$/.test(sld)) return false;
        return !isUnder(s, gw?.own || [domain]);
      });
    const shares = lines.filter((s) => /^\d+(\.\d+)?%$/.test(s));
    const paired = domains.length && domains.length === shares.length;
    out = {
      gateway: gw?.label ?? domain, domain, direction: tab, url: cap.url,
      retrievedAt: new Date().toISOString(),
      // 请求的窗口和**实际落地的窗口**都写出来：只写实际窗口的话，下游看到 `6m`
      // 也不知道它本来要的是 28 天，同样没法判断这份数字能不能跟别的报表并排比。
      requestedWindow: timeWindow?.requested ?? null,
      window: timeWindow?.landed ?? null,
      windowRewritten: Boolean(timeWindow?.rewritten),
      // 窗口改写有两条通道：路由末段（`.../999/28d` → `.../999/6m`）和查询串
      // （`?duration=365d` → `?duration=28d`，末段是 `999` 的路由只有这一条）。
      // 三个字段单看分不出是哪一扇门被改的，排查时得知道，所以把通道也写出来。
      windowSource: timeWindow?.source ?? null,
      windowParam: timeWindow?.param ?? null,
      // 中转跳转的窗口也留一份：两跳落到不同窗口是面板行为变化的早期信号。
      hopWindow: hopWindow
        ? { requested: hopWindow.requested, landed: hopWindow.landed, source: hopWindow.source ?? null }
        : null,
      paired,
      referrers: domains.map((d, i) => ({ domain: d, share: paired ? shares[i] : null })),
      note: paired ? null
        : `域名 ${domains.length} 个、份额 ${shares.length} 个，数量对不上，已放弃配对——错位的份额比没有份额更危险。份额请在面板里人工核对。`,
    };
    recordSource({ source: `similarweb:${domain}:${tab}`, status: 'ok', rawCount: out.referrers.length, window: out.window });
    console.error(`manifest：${writeManifest('completed')}`);
  } finally {
    // 只关自己开的那一个会话。**绝不调用 cleanup**——它会把机主别的标签页一起端掉。
    if (openedSession) {
      try { await core?.closeSession(openedSession); } catch { /* 关不掉不该让命令失败 */ }
    }
  }

  if (args.out) { const p = (await import('node:fs')).writeFileSync(args.out, JSON.stringify(out, null, 2) + '\n'); console.error(`已写入 ${args.out}`); void p; }
  if (args.json) { console.log(JSON.stringify(out, null, 2)); return; }
  if (out.note) console.error(`· ${out.note}`);
  if (out.windowRewritten) {
    const via = out.windowSource === 'query' ? `查询串参数 ${out.windowParam}` : '路由末段';
    console.error(`⚠ 时间窗口被面板改写（${via}）：请求 ${out.requestedWindow}，实际 ${out.window}。` +
      `下面这些数字是 ${out.window} 的，别按 ${out.requestedWindow} 解读。`);
  }
  printTable(out.referrers, [{ key: 'domain', label: '引荐域名', max: 40 }, { key: 'share', label: '份额' }]);
  console.error(`\n${out.gateway} · ${out.direction} · 共 ${out.referrers.length} 个域名`);
}

function cmdList(args) {
  const rows = Object.entries(GATEWAYS).map(([k, v]) => ({
    键: k, 网关: v.label, 自身域名: v.own.join(', '),
    反查指纹: v.queries.join('  ·  '), 备注: v.note || '',
  }));
  emit(rows, args, [
    { key: '键', label: '键' }, { key: '网关', label: '网关', max: 18 },
    { key: '自身域名', label: '自身域名', max: 26 }, { key: '反查指纹', label: '反查指纹', max: 62 },
  ]);
}

const args = parseArgs();
const cmd = args._[0];
if (args.help || !cmd) { console.log(HELP); process.exit(0); }
const table = { list: cmdList, serp: cmdSerp, similarweb: cmdSimilarweb };
if (!table[cmd]) die(`未知命令 ${cmd}（--help 看用法）`);
await table[cmd](args);
