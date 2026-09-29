#!/usr/bin/env node
/**
 * site-network.mjs —— 站群反查：给一个域名，找出同一个主体运营的其它站。
 *
 * 为什么需要它：
 *   悬赏帖里信号最强的一条方法是「找到一个已经跑通的站，把它整个站群逐个拆解」——
 *   因为同一个团队会把同一套已验证的关键词打法复制到十几个赛道上，
 *   拆一个站你拿到一个方向，拆一个站群你拿到的是**这套打法在哪些赛道上被验证过**。
 *   但帖子给的是人肉贴出来的链接清单，换个种子域名就没了。本脚本把它变成可复用的。
 *
 * 怎么找（三类指纹，都来自首页 HTML，纯公开 HTTP）：
 *   analytics  GA4 / GTM / AdSense / Clarity / Plausible / Umami / Hotjar 的账号 ID。
 *              **最硬的一类**——ID 相同基本可以断定同一主体，因为那是要登录后台才能配的。
 *   utm        站群互链时常带同一个 utm_source 标记（帖子里那批就是 ?UTM_SOURCE=flux-ai）。
 *              强度中等：标记相同说明是同一批推广位，但也可能是联盟客。
 *   outlink    首页/页脚指向的其它 apex 域名。**最弱**，一条外链谁都能发，
 *              所以默认要 --confirm 回访对方、拿到共同指纹才算数。
 *
 * 用法：
 *   node site-network.mjs --domain flux-ai.com
 *   node site-network.mjs --domain flux-ai.com --confirm          # 回访候选，标注共同指纹与回访状态
 *   node site-network.mjs --domain flux-ai.com --confirm --json --out out.json
 *
 * 选项：
 *   --domain <d>     种子域名（必填）
 *   --confirm        回访每个候选域名，验证是否共享指纹（慢，但结论可信得多）
 *   --max <n>        最多回访几个候选   (默认 25)
 *   --sleep <ms>     回访间隔           (默认 400)
 *   --json / --out <file> / -h
 *
 * 依赖：无 token，无登录态，纯公开 HTTP。
 * 已验证日期：2026-08-24
 *
 * 已知坑：
 *   - **没有指纹不等于不是站群。** 用服务端埋点、或把 GA 装在 GTM 容器里的站，
 *     首页 HTML 里什么都看不到。返回空只说明「这条路没找到」，不是「它没有兄弟站」。
 *   - 反过来，**共享 GTM 容器 ID 的强度弱于共享 GA4 ID**：代理商会给多个客户配同一个容器。
 *     所以输出里保留了指纹类型；强弱怎么判是 AI 的事，判读指引见
 *     references/demand-sources/competitors-and-roots.md「九·二、一个站背后的整个站群」一节（2026-08-30 起脚本不再输出
 *     strength/confirmed 判定，也不再默认过滤弱行——过滤发生在判断层，不在采集层）。
 *   - **「无共同指纹」是站群的常态，不是失败。** 成规模的操盘手会给每个站单独建
 *     GA4 属性（好分开看数据），所以兄弟站之间根本不共享埋点 ID。
 *     实测 videoweb.ai 那一组：10 个兄弟站没有一个共享指纹，
 *     真正把它们绑在一起的是同一个 `utm_source`。
 *   - `--confirm` 会对每个候选发一次请求，站点多时很慢，且可能触发对方限流。
 *     回访失败的行 revisit=fetch_failed——那是「这次没看到」，不是「无共同指纹」。
 *   - CF 挡纯 HTTP 客户端的站（如 producthunt.com）这条路取不到，
 *     需要时改走 opencli 的真实浏览器再把 HTML 喂进 extractFingerprints()。
 */
import { parseArgs, get, emit, sleep, die } from './_lib.mjs';

const FINGERPRINTS = [
  // [类型, 正则]。类型原样透出，强弱判读归 AI（见 demand-sources/competitors-and-roots.md「九·二、一个站背后的整个站群」）。
  ['ga4',       /\bG-[A-Z0-9]{6,12}\b/g],
  ['ua',        /\bUA-\d{4,10}-\d{1,4}\b/g],
  ['adsense',   /\bca-pub-\d{10,20}\b/g],
  ['clarity',   /clarity\.ms\/tag\/([a-z0-9]{8,12})/g],
  ['gtm',       /\bGTM-[A-Z0-9]{5,9}\b/g],
  ['plausible', /plausible\.io\/js\/[^"']*?data-domain="([^"]+)"/g],
  ['umami',     /data-website-id="([0-9a-f-]{30,40})"/g],
  ['hotjar',    /hjid\s*[:=]\s*(\d{6,9})/g],
];

const IGNORE_HOSTS = new Set([
  'w3.org', 'schema.org', 'google.com', 'googleapis.com', 'gstatic.com',
  'youtube.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'linkedin.com', 'github.com', 'discord.com', 'discord.gg', 'reddit.com',
  'tiktok.com', 'producthunt.com', 'cloudflare.com', 'vercel.app', 'stripe.com',
  'jsdelivr.net', 'unpkg.com', 'gravatar.com', 'wikipedia.org', 'medium.com',
  // 基础设施与短链：出现频次极高但和「谁运营这个站」无关，不过滤掉会淹没真信号。
  'googletagmanager.com', 'google-analytics.com', 'googleadservices.com',
  'doubleclick.net', 'clarity.ms', 'twimg.com', 't.co', 'fbcdn.net',
  'cloudflareinsights.com', 'sentry.io', 'intercom.io', 'crisp.chat',
  'paypal.com', 'creem.io', 'lemonsqueezy.com', 'paddle.com', 'apple.com',
]);

const apexOf = (host) => {
  const parts = String(host).toLowerCase().replace(/^www\./, '').split('.');
  // 够用的近似：不处理 co.uk 这类二级后缀，站群反查里它们本来就少见。
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
};

export function extractFingerprints(html) {
  const out = [];
  for (const [kind, re] of FINGERPRINTS) {
    for (const m of html.matchAll(re)) {
      const value = m[1] ?? m[0];
      if (value) out.push({ kind, value });
    }
  }
  // 同一个 ID 在页面里会出现很多次，去重。
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.kind}:${f.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function extractOutlinks(html, seedApex) {
  const hits = new Map(); // apex -> {utm:Set, count}
  for (const m of html.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)([^\s"'<>]*)/g)) {
    const apex = apexOf(m[1]);
    if (!apex || apex === seedApex || IGNORE_HOSTS.has(apex)) continue;
    if (!/\.[a-z]{2,}$/.test(apex)) continue;
    const rec = hits.get(apex) ?? { utm: new Set(), count: 0 };
    rec.count += 1;
    // 结束符里必须带上反斜杠：HTML 里 JSON 内嵌的 URL 是 \" 转义的，
    // 不排除它会把尾巴上的反斜杠一起吃进 utm 值里。
    const utm = /[?&]utm_source=([^&"'\s\\]+)/i.exec(m[2]);
    if (utm) rec.utm.add(decodeURIComponent(utm[1]).toLowerCase());
    hits.set(apex, rec);
  }
  return hits;
}

async function fetchHtml(domain) {
  for (const scheme of ['https', 'http']) {
    try {
      const r = await get(`${scheme}://${domain}/`, { retries: 1, timeout: 20000 });
      const html = typeof r === 'string' ? r : await r.text?.() ?? String(r);
      if (html && html.length > 200) return html;
    } catch { /* 换 scheme 再试 */ }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.h || args.help) { console.log(HELP); process.exit(0); }
  const seed = String(args.domain ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!seed) die('必须给 --domain');
  const seedApex = apexOf(seed);

  const html = await fetchHtml(seed);
  if (!html) die(`取不到 ${seed} 的首页 HTML（可能是 CF 挡了纯 HTTP 客户端，改走 opencli 真实浏览器）`);

  const seedPrints = extractFingerprints(html);
  const outlinks = extractOutlinks(html, seedApex);
  const seedKeys = new Set(seedPrints.map((f) => `${f.kind}:${f.value}`));

  if (!seedPrints.length) {
    console.error(`提示：${seed} 首页里没抓到任何埋点指纹——可能用了服务端埋点或 GTM 容器。`);
    console.error('     这不代表它没有兄弟站，只代表这条路看不见。下面的候选全部只有 outlink 证据。');
  }

  const rows = [];
  const max = Number(args.max ?? 25);
  let visited = 0;

  for (const [apex, rec] of [...outlinks].sort((a, b) => b[1].count - a[1].count)) {
    const via = [];
    if (rec.utm.size) via.push(`utm:${[...rec.utm].join('/')}`);
    via.push(`outlink×${rec.count}`);
    // 只记事实：发现路径、共同指纹、回访状态。强弱与「算不算同一主体」的裁定归 AI，
    // 判读指引见 references/demand-sources/competitors-and-roots.md「九·二、一个站背后的整个站群」一节。
    const row = { seed: seedApex, domain: apex, via: via.join(' '), shared: '', revisit: 'not_visited' };

    if (args.confirm && visited < max) {
      visited += 1;
      await sleep(Number(args.sleep ?? 400));
      const h = await fetchHtml(apex);
      if (h) {
        row.revisit = 'ok';
        const shared = extractFingerprints(h).filter((f) => seedKeys.has(`${f.kind}:${f.value}`));
        if (shared.length) row.shared = shared.map((f) => `${f.kind}=${f.value}`).join(',');
      } else {
        // 回访失败 ≠ 无共同指纹：这次根本没看到对方首页。
        row.revisit = 'fetch_failed';
      }
    }
    rows.push(row);
  }

  if (seedPrints.length) {
    console.error(`种子指纹：${seedPrints.map((f) => `${f.kind}=${f.value}`).join(', ')}\n`);
  }
  // 弱行不再默认过滤：全量输出，取舍在判断层做。
  emit(rows, args, [
    { key: 'domain', label: '域名', max: 32 },
    { key: 'revisit', label: '回访', max: 12 },
    { key: 'shared', label: '共同指纹', max: 34 },
    { key: 'via', label: '发现路径', max: 30 },
  ]);
  if (args.confirm) {
    const failed = rows.filter((r) => r.revisit === 'fetch_failed').length;
    if (failed) console.error(`注意：${failed} 个候选回访失败——那些行的空「共同指纹」是「没看到」，不是「不共享」。`);
    console.error('指纹类型的证据强弱判读见 rankup/references/demand-sources/competitors-and-roots.md「九·二、一个站背后的整个站群」。');
  }
}

const HELP = `site-network.mjs —— 站群反查：给一个域名，找出同一个主体运营的其它站

用法：
  node site-network.mjs --domain <域名> [--confirm] [--max 25] [--json] [--out f]

  --confirm   回访每个候选，看是否共享埋点指纹（慢；回访失败会标 fetch_failed）
  --max <n>   最多回访几个        (默认 25)
  --sleep <ms> 回访间隔           (默认 400)

输出只记事实（发现路径 / 共同指纹 / 回访状态），不做强弱裁定与过滤；
指纹类型怎么读、哪类算硬证据，见 rankup/references/demand-sources/competitors-and-roots.md「九·二、一个站背后的整个站群」。
`;

main().catch((e) => die(e.message));
