#!/usr/bin/env node
/**
 * 用途：用几个爬虫 UA 抓同一个 URL，去掉 script/style 后比较 raw HTML 里的可见文本，
 *   判断 raw HTML 对各爬虫是否一致、正文是不是客户端渲染的空壳。
 *   OpenAI 的三个爬虫不执行 JS（唯一独立实测是 2024-12，见 references/seo-ai-search.md「三-D」），
 *   想被 AI 引用的价格表、推荐位、FAQ 必须在 raw HTML 里。ai-crawler-access.mjs 只比状态码，
 *   本脚本比正文，补的是 UA 差异与 JS 空壳这块盲区。判读见 references/seo-ssr.md「三-E」。
 *
 * 用法：node scripts/ua-parity.mjs <url> [--json] [--timeout-s 20]
 * 参数：
 *   <url>          必填，http(s) 页面地址（单个页面，不是站点根的批量检查）。
 *   --json         输出 JSON（每个 UA 一项加汇总，不含词集）；默认输出人读表格加结论。
 *   --timeout-s    单次请求超时秒数，默认 20。
 * 判定项（differs 的依据）：状态码、title、canonical、robots meta、h1 有无、JSON-LD 块数、词集差异（≥2%）、Vary 含 User-Agent。
 *   字节数、script 数只显示、不参与判定（字节数会被 nonce、时间戳带出噪声）。
 * 退出码：0 四个 UA 与基线一致；1 有差异、抓取失败或疑似空壳；2 参数错误。
 * 依赖：Node 18+（内置 fetch），无第三方依赖；不需要登录态、浏览器或配额，只发 4 次 GET。
 *
 * 四个 UA：OAI-SearchBot 与 ChatGPT-User 用 OpenAI 官方文档原文（2026-09-29 取样）；
 *   Googlebot Smartphone 是移动优先索引的主 UA，作为对比基线；桌面 Chrome 作为普通访客参照。
 *
 * 已知坑：
 *   - 只比 raw HTML，不执行 JS：证明「有没有」，证明不了 ChatGPT 是否引用，也测不出渲染后才出现的内容。
 *   - 词数是「长度 >2 的字母数字串」（CJK 保留 2 字以上）的去重个数，只用来做相对比较；
 *     中日韩无空格文本按标点切段，绝对词数偏小，别当字数用。
 *   - 空壳启发式只是提示，三条任一成立才提示（可执行 script 不含 ld+json、importmap 等数据块）：
 *     ① 常见框架挂载点（id=root/app/__next/__nuxt/react-root，引号可有可无）在 raw HTML 里是空的——最强证据，基本可以确认是客户端渲染；
 *     ② 基线可见词 <10 且有可执行 script（几乎没有正文）；③ 基线可见词 <50 且可执行 script ≥3 个。
 *     只带一两个统计/小组件脚本、正文有十几个词的极简静态页不会触发。反过来，挂载点不是上述几种、脚本又少、正文又不算太短的
 *     客户端渲染页会漏报，所以别只看结论行，同时读表里的「词=」：正文词数很少的页面先看 title 和词集，再判是不是空壳。
 *   - 四个 UA 全是 403、验证页或同一个错误时，多半拦的是本机出口 IP 或 TLS 指纹，不是 UA 规则：
 *     对照桌面 Chrome 那行，它也失败就不能据此判定爬虫被拦。
 *   - 自动跟随重定向，各 UA 落地的最终 URL 不同会在 finalUrl 里体现。
 *   - 随机推荐、时间戳、广告位会让词集差几个词，差异比例低于 2% 且 title、canonical、robots 一致时按一致处理。
 *
 * 已验证：2026-09-30，Node v26.10.0；对公开页面真实发 4 次 GET，各跑一次。
 *   - 公开静态页（IANA 保留的示例域名首页，example.com）：四个 UA 均 200、713 字节、20 个词、title 一致、
 *     1 个外链 script、无挂载点，与基线缺 0 多 0，四行都是 same，结论「一致」，退出码 0。
 *     旧阈值「有 1 个 script 即提示」在这个页面上误报为空壳、退出码 1，改成上面的两条判据后消除。
 *   - 公开客户端渲染页（React 构建产物的官方演示页）：四个 UA 均 200，基线可见词 10 个、2 个 script、
 *     根节点 `<section id="root">` 为空，四行 same（这站不按 UA 分支），触发空壳提示，退出码 1。
 *     这一页只有 2 个 script，所以靠挂载点为空的判据识别，而不是靠 script 数量。
 *   - 本机合成页（127.0.0.1，测完即停）另测过：JSON-LD 只有部分 UA 缺失、挂载点为空但无引号属性、带 ld+json 的短静态页，
 *     判定符合预期；这只证明逻辑，不等于真实站点样本。
 *   - 尚未验证：有 UA 分支（动态服务、m. 子域）的站，以及被 WAF 按 UA 拦截的站；这两类目前只有逻辑，没有真实样本。
 */

const UAS = {
  'OAI-SearchBot': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot',
  'ChatGPT-User': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  'Googlebot-Smartphone': 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Desktop-Chrome': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const BASELINE = 'Googlebot-Smartphone';
const TOLERANCE = 0.02; // 词集差异比例低于此值按一致处理
const SHELL_WORDS = 50; // 基线可见词少于此值、且可执行 script 不少于 SHELL_SCRIPTS 个，提示疑似空壳
const SHELL_SCRIPTS = 3; // 只数可执行脚本；1~2 个统计/小组件脚本的极简静态页不该被当成空壳
const FEW_WORDS = 10; // 可见词少于此值（几乎没有正文）且有任何可执行 script，也提示疑似空壳
// 常见前端框架的挂载点（React/Vue/Next/Nuxt）在 raw HTML 里是空的，就是客户端渲染的直接证据（引号可有可无）
const EMPTY_ROOT = /<(div|section|main|span)\b[^>]*\bid=(?:["']?)(?:root|app|__next|__nuxt|react-root)(?:["']?)(?=[\s>\/])[^>]*>\s*<\/\1>/i;
// 不会执行的 script 块（数据块）：JSON-LD、importmap、speculationrules 等
const EXEC_TYPE = /^(?:module|(?:text|application)\/(?:javascript|ecmascript)|text\/babel)$/i;
const execScriptCount = (html) => {
  let n = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const t = m[1].match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    if (!t || EXEC_TYPE.test(t[1])) n++;
  }
  return n;
};

function parseArgs(argv) {
  const out = { url: null, json: false, timeoutS: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--timeout-s') out.timeoutS = Number(argv[++i]);
    else if (a.startsWith('--')) return { error: `未知参数 ${a}` };
    else if (!out.url) out.url = a;
    else return { error: `多余的参数 ${a}` };
  }
  if (!out.url) return { error: '缺少 <url>' };
  if (!Number.isFinite(out.timeoutS) || out.timeoutS <= 0) return { error: '--timeout-s 必须是正数' };
  try {
    const u = new URL(out.url);
    if (!['http:', 'https:'].includes(u.protocol)) return { error: '只接受 http(s) 地址' };
  } catch {
    return { error: `不是合法 URL：${out.url}` };
  }
  return out;
}

const strip = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .toLowerCase();
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const words = (t) => new Set(t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 || (w.length === 2 && CJK.test(w))));
const first = (re, html) => (html.match(re) || [])[1]?.trim() ?? null;

async function probe(name, ua, url, timeoutMs) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const html = await r.text();
    const w = words(strip(html));
    return {
      name,
      status: r.status,
      finalUrl: r.url,
      vary: r.headers.get('vary'),
      bytes: html.length,
      textWords: w.size,
      h1: /<h1[\s>]/i.test(html),
      emptyRoot: EMPTY_ROOT.test(html.replace(/<!--[\s\S]*?-->/g, '')),
      title: first(/<title[^>]*>([\s\S]*?)<\/title>/i, html)?.replace(/\s+/g, ' ').slice(0, 80) ?? null,
      scripts: (html.match(/<script/gi) || []).length,
      execScripts: execScriptCount(html),
      jsonLd: (html.match(/<script[^>]+application\/ld\+json/gi) || []).length,
      canonical: first(/<link[^>]+rel=["']?canonical["']?[^>]*href=["']?([^"'\s>]+)/i, html),
      robotsMeta: first(/<meta[^>]+name=["']?robots["']?[^>]*content=["']([^"']+)/i, html),
      words: w,
    };
  } catch (error) {
    return { name, status: 'ERR', error: String(error.message || error), words: new Set() };
  }
}

function compare(rows) {
  const ok = (r) => typeof r.status === 'number' && r.status >= 200 && r.status < 300;
  const base = rows.find((r) => r.name === BASELINE && ok(r)) || rows.find(ok);
  const out = [];
  for (const r of rows) {
    if (!base) { out.push({ ...r, verdict: 'no-baseline', reasons: ['没有任何 UA 拿到 2xx，无法比较'] }); continue; }
    const missing = [...base.words].filter((w) => !r.words.has(w)).length;
    const extra = [...r.words].filter((w) => !base.words.has(w)).length;
    const reasons = [];
    if (!ok(r)) reasons.push(`状态 ${r.status}${r.error ? `（${r.error}）` : ''}`);
    else if (r !== base) {
      if (r.status !== base.status) reasons.push(`状态与基线不同（${r.status} 对 ${base.status}）`);
      if (r.title !== base.title) reasons.push('title 与基线不同');
      if (r.canonical !== base.canonical) reasons.push('canonical 与基线不同');
      if (r.robotsMeta !== base.robotsMeta) reasons.push('robots meta 与基线不同');
      if (r.h1 !== base.h1) reasons.push('h1 有无与基线不同');
      if (r.jsonLd !== base.jsonLd) reasons.push(`JSON-LD 块数与基线不同（${r.jsonLd} 对 ${base.jsonLd}）`);
      const ratio = (missing + extra) / Math.max(base.words.size, 1);
      if (ratio > TOLERANCE) reasons.push(`词集差异 ${(ratio * 100).toFixed(1)}%（缺 ${missing}、多 ${extra}）`);
    }
    if (r.vary && /user-agent/i.test(r.vary)) reasons.push('Vary 含 User-Agent，服务端可能按 UA 分支');
    const { words: _w, ...rest } = r;
    out.push({ ...rest, baseline: base.name, wordsMissingVsBaseline: missing, wordsExtraVsBaseline: extra, verdict: reasons.length ? 'differs' : 'same', reasons });
  }
  const b = out.find((r) => r.name === (base && base.name));
  const shell = Boolean(b && ok(b) && (b.emptyRoot || (b.textWords < FEW_WORDS && b.execScripts >= 1) || (b.textWords < SHELL_WORDS && b.execScripts >= SHELL_SCRIPTS)));
  return { rows: out, baseline: base ? base.name : null, shellSuspect: shell };
}

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  console.error(`${args.error}\n用法：node scripts/ua-parity.mjs <url> [--json] [--timeout-s 20]`);
  process.exit(2);
}

const rows = [];
for (const [name, ua] of Object.entries(UAS)) rows.push(await probe(name, ua, args.url, args.timeoutS * 1000));
const result = compare(rows);
const allSame = result.rows.every((r) => r.verdict === 'same');
const exit = allSame && !result.shellSuspect ? 0 : 1;

if (args.json) {
  console.log(JSON.stringify({ url: args.url, checkedAt: new Date().toISOString(), baseline: result.baseline, shellSuspect: result.shellSuspect, allSame, rows: result.rows }, null, 2));
} else {
  console.log(`URL ${args.url}\n基线 ${result.baseline ?? '无'}\n`);
  for (const r of result.rows) {
    console.log([
      r.name.padEnd(21),
      String(r.status).padEnd(4),
      `bytes=${r.bytes ?? '-'}`.padEnd(14),
      `词=${r.textWords ?? '-'}`.padEnd(9),
      `script=${r.execScripts ?? '-'}`.padEnd(11),
      `jsonld=${r.jsonLd ?? '-'}`.padEnd(9),
      `h1=${r.h1 ?? '-'}`.padEnd(9),
      `空根=${r.emptyRoot ?? '-'}`.padEnd(10),
      `缺=${r.wordsMissingVsBaseline ?? '-'}`.padEnd(7),
      `多=${r.wordsExtraVsBaseline ?? '-'}`.padEnd(7),
      r.verdict,
    ].join(' '));
    if (r.title) console.log(`  title: ${r.title}${r.canonical ? `  canonical: ${r.canonical}` : ''}${r.robotsMeta ? `  robots: ${r.robotsMeta}` : ''}${r.vary ? `  vary: ${r.vary}` : ''}`);
    for (const reason of r.reasons) console.log(`  - ${reason}`);
  }
  console.log(`\n结论：${allSame ? '四个 UA 的 raw HTML 与基线一致' : '存在差异或抓取失败，见上'}${result.shellSuspect ? `；疑似客户端渲染空壳（框架挂载点为空；或可见词 <${FEW_WORDS} 且有可执行脚本；或可见词 <${SHELL_WORDS} 且可执行脚本不少于 ${SHELL_SCRIPTS} 个）：想被 AI 引用的区块需进 raw HTML` : ''}`);
}
process.exit(exit);
