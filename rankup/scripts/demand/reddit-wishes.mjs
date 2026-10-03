#!/usr/bin/env node
/**
 * 用途：用「许愿句式」在 Reddit 上捞用户原话。
 *   "is there a tool that…" / "I wish there was…" / "does anyone know a…" /
 *   "alternative to…" / "too expensive" —— 这些句子本身就是搜索意图，
 *   用户的原话往往可以直接当页面标题和 H1 用，比任何关键词工具给的词都贴。
 *   限定到 r/SaaS、r/startups、r/SideProject、r/Entrepreneur 这类子版，
 *   捞出来的就是有付费能力的人在抱怨的事。
 *
 * 示例命令：
 *   node scripts/demand/reddit-wishes.mjs --limit 40
 *   node scripts/demand/reddit-wishes.mjs --template "is there a tool that" --template "I wish there was"
 *   node scripts/demand/reddit-wishes.mjs --subreddit SaaS,startups,SideProject,Entrepreneur --time year
 *   node scripts/demand/reddit-wishes.mjs --topic "invoice" --time month --json --out wishes.jsonl
 *   node scripts/demand/reddit-wishes.mjs --source pullpush --template "alternative to" --limit 50
 *
 * 依赖 / 四条取数路径（--source 切换，默认 auto 依次降级）：
 *   0) opencli（**推荐，2026-08-23 新增，auto 链第一站**）：`opencli reddit search`。
 *      走用户本机已登录的真实 Chrome（adapter strategy=cookie），
 *      **不用注册 OAuth app、不吃匿名限流**，直接给 score / comments / selftext 全字段。
 *      代价：需要 `opencli doctor` 绿 + 本机 Chrome 已登录 Reddit，进不了 CI；
 *      一次查询实测 ~13s（比 oauth 慢，比 rss 的 6s sleep 快）。
 *      `--no-opencli` 可在 auto 链里跳过它。
 *   1) rss（零配置，纯 HTTP 默认）：https://www.reddit.com/search/.rss?q=... 与
 *      https://www.reddit.com/r/<sub>/search/.rss?...
 *      **必须带浏览器 User-Agent**，脚本已内置；自定义 UA 想覆盖用 --ua。
 *   2) oauth（推荐用于 CI）：Reddit script app 的 client_credentials。
 *      需要 REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET（环境变量 → rankup/.env）。
 *      在 https://www.reddit.com/prefs/apps 建一个 "script" 类型 app 即可拿到。
 *      有 token 时走 oauth.reddit.com，配额 100 次/分钟，且**能拿到 score 和评论数**。
 *   3) pullpush（无 auth 的历史全文检索兜底）：https://api.pullpush.io/reddit/search/submission/
 *      第三方 Pushshift 镜像，覆盖历史深、能拿到 score/评论数，但数据有滞后，
 *      且限流极严（实测连着两次就 429，返回 "Rate limit exceeded ... paid scraping service"），
 *      只适合偶尔手动跑，不要放进 CI。
 * 已验证日期：2026-08-24
 *
 * 已知坑（都是实测出来的，别踩第二遍）：
 *   - **https://www.reddit.com/…/*.json 已经不能匿名用了**：无论什么 UA，实测一律
 *     HTTP 403 + 一整页 HTML（不是 JSON）。旧教程里的 `search.json?q=` 已经失效。
 *   - RSS 路径限流非常紧：连续请求几次就 429。脚本默认每次请求之间 sleep 6 秒，
 *     429 时指数退避重试。想快就配 OAuth。
 *   - RSS 路径**拿不到 score / 评论数 / upvote ratio**（Atom feed 里没有这些字段），
 *     只有标题、作者、子版、正文 HTML、链接、时间。要排序打分必须走 oauth。
 *   - `old.reddit.com` **整站已经不再返回老界面**：2026-08-23 实测
 *     `old.reddit.com/r/<sub>/new/.json` 和 `.rss` 都回 HTTP 200 + 320KB 的
 *     新版 "Welcome to Reddit" 拦截页（`text/html`），既不是 JSON 也不是 Atom，
 *     里面一条 `data-fullname="t3_` 都没有。**old.reddit 这条路彻底没了。**
 *   - `np.reddit.com` 和 `oauth.reddit.com`（不带 Bearer）一律 403 + 189KB HTML。
 *   - redlib / libreddit 公开实例前面挂了 Anubis 工作量证明（"Verifying your browser…"），
 *     纯 HTTP 拿到的是挑战页；实例清单在
 *     raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json（每日更新），
 *     但实测 6 个实例里 2 个 403 挑战、1 个 503、3 个连不上。**不要依赖镜像。**
 *   - Reddit 搜索里引号短语匹配是「尽力而为」，会返回近似结果；脚本默认对标题+正文
 *     再做一次本地句式过滤（--no-strict 关掉）。
 *   - `--time` 只有 hour/day/week/month/year/all 六个值。
 *   - 别把并发拉满，Reddit 会按 IP 封一段时间。
 */

import { execFile } from '../../../backlink/scripts/lib-opencli-process.mjs';
import { promisify } from 'node:util';
import { parseArgs, get, getJson, emit, die, sleep, readToken, asList, probeBrowserBridge, initEvidence, recordSource } from './_lib.mjs';

const execFileP = promisify(execFile);

/** opencli 是否可用（reddit adapter 走 cookie 策略，需要浏览器桥绿）
 *
 * 判据复用 _lib.mjs 的 probeBrowserBridge()（同一条 `[OK] Connectivity` 正则，
 * 坑见那边的注释：2026-08-23 曾错误匹配 "Everything looks good"，doctor 只要有
 * 任何一条纯建议性 Issue 就不再打印那句话，导致 auto 链静默退回 rss）。
 * 这里是「链选择」不是硬闸门：探测不确定（null）时按「不可用」处理，
 * 静默换下一站，不影响用户——和 requireBrowserBridge() 的 fail-open 语义不同，
 * 是特意的：那边挡的是唯一路径，这里只是挑链里的第一站。
 */
async function opencliReady(bin) {
  return probeBrowserBridge(bin) === true;
}

const DEFAULT_TEMPLATES = [
  'is there a tool that',
  'is there an app that',
  'is there anything that',
  'I wish there was',
  'does anyone know a',
  'looking for a tool',
  'alternative to',
  'too expensive',
  'why is there no',
  'any tool to',
];

const HELP = `
reddit-wishes.mjs — 用「许愿句式」在 Reddit 捞用户原话

用法:
  node reddit-wishes.mjs [选项]

选项:
  --template <t>     许愿句式，可重复或逗号分隔。不传则用内置的一组默认句式（见下）
  --topic <t>        额外主题词，和每个句式做 AND，例如 --topic invoice
  --subreddit <s>    限定子版，逗号分隔可多个（如 SaaS,startups,SideProject,Entrepreneur）
                     不传则搜全站
  --time <t>         hour|day|week|month|year|all（默认 year）
  --sort <s>         new|relevance|top|comments（默认 new）
  --limit <n>        总共最多返回多少条（默认 40）
  --source <s>       auto|opencli|rss|oauth|pullpush（默认 auto）
  --no-opencli       auto 链里跳过 opencli 这一站
  --opencli-bin <p>  opencli 可执行文件路径（默认 opencli）
  --no-strict        不做本地句式二次过滤
  --delay <ms>       每次请求之间的间隔（默认 6000，rss 路径限流很紧）
  --ua <ua>          自定义 User-Agent
  --json / --out <f>
  --help

内置默认句式:
${DEFAULT_TEMPLATES.map((s) => `  "${s}"`).join('\n')}

产出字段:
  template, subreddit, title, author, url, permalink, createdAt, text,
  score/numComments（--source oauth / opencli / pullpush）
`.trim();


const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-zA-Z]+);/g, (m, n) => NAMED[n.toLowerCase()] ?? m);
const clean = (s) => decode(decode(String(s)).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/* ---------- 路径 1：RSS ---------- */

function parseAtom(xml, template) {
  const out = [];
  for (const e of xml.split('<entry>').slice(1)) {
    const body = e.split('</entry>')[0];
    const pick = (tag) => (body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] ?? '';
    const href = (body.match(/<link[^>]+href="([^"]+)"/) || [])[1] ?? '';
    const sub = (body.match(/<category term="([^"]+)"/) || [])[1] ?? '';
    const content = pick('content');
    // 正文 HTML 里最后一个 comments 链接是 permalink
    const perma = (decode(content).match(/href="(https:\/\/www\.reddit\.com\/r\/[^"]+\/comments\/[^"]+)"/) || [])[1] ?? href;
    out.push({
      template,
      subreddit: sub,
      title: clean(pick('title')),
      author: clean(pick('name')).replace(/^\/u\//, ''),
      url: href,
      permalink: perma.split('?')[0],
      createdAt: pick('published') || pick('updated'),
      text: clean(content).replace(/\s*submitted by\s*\/u\/\S+\s*to\s*r\/\S+\s*\[link\]\s*\[comments\]\s*$/i, '').slice(0, 900),
    });
  }
  return out;
}

async function viaRss({ query, subreddit, time, sort, ua, delay }) {
  const u = subreddit
    ? new URL(`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search/.rss`)
    : new URL('https://www.reddit.com/search/.rss');
  u.searchParams.set('q', query);
  u.searchParams.set('sort', sort);
  u.searchParams.set('t', time);
  if (subreddit) u.searchParams.set('restrict_sr', '1');

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await get(u.toString(), { ua, headers: { accept: 'application/atom+xml, text/xml' }, retries: 0 });
    if (res.status === 429) { await sleep(delay * (attempt + 2)); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`);
    if (!text.includes('<entry>') && !text.includes('<feed')) {
      throw new Error(`Reddit 返回的不是 Atom（可能被挡了）：${text.slice(0, 120)}`);
    }
    return text;
  }
  throw new Error(`Reddit RSS 连续 429（限流）。加大 --delay，或配 REDDIT_CLIENT_ID/SECRET 走 --source oauth`);
}

/* ---------- 路径 2：OAuth ---------- */

async function getOauthToken(id, secret, ua) {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': ua,
    },
    body: 'grant_type=client_credentials',
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`取 Reddit token 失败 HTTP ${res.status}：${txt.slice(0, 200)}`);
  return JSON.parse(txt).access_token;
}

async function viaOauth({ query, subreddit, time, sort, limit, token, ua, template }) {
  const u = subreddit
    ? new URL(`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search`)
    : new URL('https://oauth.reddit.com/search');
  u.searchParams.set('q', query);
  u.searchParams.set('sort', sort);
  u.searchParams.set('t', time);
  u.searchParams.set('limit', String(Math.min(100, limit)));
  u.searchParams.set('raw_json', '1');
  if (subreddit) u.searchParams.set('restrict_sr', '1');
  const d = await getJson(u.toString(), { ua, headers: { authorization: `Bearer ${token}` } });
  return (d.data?.children ?? []).map((c) => c.data).map((p) => ({
    template,
    subreddit: p.subreddit,
    title: p.title,
    author: p.author,
    url: p.url,
    permalink: `https://www.reddit.com${p.permalink}`,
    createdAt: new Date(p.created_utc * 1000).toISOString(),
    score: p.score,
    numComments: p.num_comments,
    text: String(p.selftext ?? '').replace(/\s+/g, ' ').trim().slice(0, 900),
  }));
}

/* ---------- 路径 3：pullpush ---------- */

async function viaPullpush({ query, subreddit, limit, template, ua }) {
  const u = new URL('https://api.pullpush.io/reddit/search/submission/');
  u.searchParams.set('q', query);
  u.searchParams.set('size', String(Math.min(100, limit)));
  u.searchParams.set('sort', 'desc');
  if (subreddit) u.searchParams.set('subreddit', subreddit);
  const d = await getJson(u.toString(), { ua, timeout: 40000 });
  return (d.data ?? []).map((p) => ({
    template,
    subreddit: p.subreddit,
    title: p.title,
    author: p.author,
    url: p.url,
    permalink: `https://www.reddit.com${p.permalink ?? `/r/${p.subreddit}/comments/${p.id}/`}`,
    createdAt: new Date(p.created_utc * 1000).toISOString(),
    score: p.score,
    numComments: p.num_comments,
    text: String(p.selftext ?? '').replace(/\s+/g, ' ').trim().slice(0, 900),
  }));
}

/* ---------- 路径 4：OpenCLI reddit adapter（推荐，2026-08-23 新增） ----------
 * 走用户本机那个真实的、已登录的 Chrome 里的 reddit 会话（strategy=cookie），
 * 所以既不用注册 OAuth app，也不吃匿名 RSS 那套限流。
 * 一次查询实测 ~13s，返回 score / comments / selftext 全字段。
 * 纪律：命令必须带 `--window dedicated` 与 `--site-session persistent`，绝不用 foreground，
 * 绝不跑 `browser cleanup`（那会关掉别的任务的标签页）；整批跑完只 close 自己的 `site:reddit` 会话。
 */
async function viaOpencli({ query, subreddit, time, sort, limit, template, bin }) {
  // --site-session persistent：整批查询复用同一个 site:reddit 标签页。默认的 ephemeral 会给
  // 每一次调用新开一个 site:reddit:<uuid> 标签页并先导航到 reddit.com 首页（COOKIE 策略的
  // navigateBefore），一批 4 词×5 子版×N 句式就是几十次首页导航——用户看到的是「一直在刷新首页、
  // 从没搜索」（搜索其实是页内 fetch，看不见），而且 reddit.com 首页经常 15s 内加载不完，导航超时后
  // 页内 fetch 拿到的不是 JSON，就是 2026-09-02 那次 `<anonymous>:50` 的报错。持久会话只导航一次，
  // 后续调用检测到已在 reddit.com 域就跳过导航（execution.ts shouldRunPreNav）。跑完由本脚本显式 close。
  const args = ['reddit', 'search', query, '--window', 'dedicated', '--site-session', 'persistent', '-f', 'json',
    '--sort', sort, '--time', time, '--limit', String(Math.min(100, limit))];
  if (subreddit) args.push('--subreddit', subreddit);
  const { stdout } = await execFileP(bin, args, { maxBuffer: 64 * 1024 * 1024 });
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`opencli 没有返回 JSON 数组：${stdout.slice(0, 200)}`);
  const list = JSON.parse(stdout.slice(start));
  return list.map((p) => ({
    template,
    subreddit: String(p.subreddit ?? '').replace(/^r\//, ''),
    title: p.title ?? '',
    author: p.author ?? '',
    url: p.url ?? '',
    permalink: String(p.url ?? '').split('?')[0],
    createdAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : '',
    score: p.score,
    numComments: p.comments,
    text: String(p.selftext ?? '').replace(/\s+/g, ' ').trim().slice(0, 900),
  }));
}

/* ---------- main ---------- */

async function main() {
  const args = parseArgs();
  if (args.help || args.h) { console.log(HELP); return; }

  const templates = asList(args.template).flatMap((t) => String(t).split(',')).map((s) => s.trim()).filter(Boolean);
  const tpls = templates.length ? templates : DEFAULT_TEMPLATES;
  const subs = asList(args.subreddit).flatMap((s) => String(s).split(',')).map((s) => s.trim().replace(/^r\//, '')).filter(Boolean);
  const time = String(args.time ?? 'year');
  const sort = String(args.sort ?? 'new');
  const limit = Number(args.limit ?? 40);
  const delay = Number(args.delay ?? 6000);
  const ua = String(args.ua ?? BROWSER_UA);
  const strict = !args['no-strict'];
  const topic = args.topic ? String(args.topic) : '';

  let source = String(args.source ?? 'auto');
  const bin = String(args['opencli-bin'] ?? 'opencli');
  let token = null;
  const id = readToken('REDDIT_CLIENT_ID');
  const secret = readToken('REDDIT_CLIENT_SECRET');

  // auto 链第一站：OpenCLI reddit adapter（要浏览器桥绿）。不可用就静默降级。
  if (source === 'auto' && !args['no-opencli']) {
    if (await opencliReady(bin)) source = 'opencli';
  } else if (source === 'opencli' && !(await opencliReady(bin))) {
    die('--source opencli 需要 OpenCLI 浏览器桥可用。先跑 `opencli doctor` 看哪一行红了。');
  }

  if ((source === 'auto' || source === 'oauth') && id && secret) {
    try { token = await getOauthToken(id, secret, ua); source = 'oauth'; }
    catch (e) {
      if (source === 'oauth') die(e.message);
      console.error(`OAuth 取 token 失败，降级到 RSS：${e.message}`);
      source = 'rss';
    }
  } else if (source === 'oauth') {
    die('--source oauth 需要 REDDIT_CLIENT_ID 和 REDDIT_CLIENT_SECRET（环境变量或 rankup/.env）。'
      + '\n到 https://www.reddit.com/prefs/apps 建一个 script 类型 app 即可拿到。');
  } else if (source === 'auto') {
    source = 'rss';
  }
  if (!args.json) console.error(`# 取数路径：${source}${source === 'rss' ? '（无 token，限流紧，每请求间隔 ' + delay + 'ms）' : ''}`);
  initEvidence('reddit-wishes', { dir: args['evidence-dir'] ?? null });

  const targets = subs.length ? subs : [''];
  const rows = [];
  const seen = new Set();
  let first = true;
  let filteredByStrict = 0;
  let filteredAsDup = 0;

  outer:
  for (const tpl of tpls) {
    for (const sub of targets) {
      if (rows.length >= limit) break outer;
      const query = `"${tpl}"${topic ? ` ${topic}` : ''}`;
      const srcTag = `${source}:${tpl}${sub ? `@r/${sub}` : '@all'}`;
      if (!first && source === 'rss') await sleep(delay);
      first = false;
      let batch = [];
      try {
        if (source === 'opencli') {
          batch = await viaOpencli({ query, subreddit: sub, time, sort, limit, template: tpl, bin });
        } else if (source === 'oauth') {
          batch = await viaOauth({ query, subreddit: sub, time, sort, limit, token, ua, template: tpl });
        } else if (source === 'pullpush') {
          batch = await viaPullpush({ query, subreddit: sub, limit, template: tpl, ua });
        } else {
          batch = parseAtom(await viaRss({ query, subreddit: sub, time, sort, ua, delay }), tpl);
        }
      } catch (e) {
        // 逐 (template, subreddit) 记状态：限流/被挡的组合和「这个句式真没帖子」分得开。
        recordSource({ source: srcTag, status: 'fetch_failed', rawCount: 0, error: String(e.message) });
        console.error(`[${tpl}${sub ? ' @r/' + sub : ''}] 取数失败：${e.message}`);
        continue;
      }
      let kept = 0;
      for (const r of batch) {
        if (seen.has(r.permalink)) { filteredAsDup += 1; continue; }
        if (strict && !`${r.title} ${r.text}`.toLowerCase().includes(tpl.toLowerCase())) { filteredByStrict += 1; continue; }
        seen.add(r.permalink);
        rows.push(r);
        kept += 1;
        if (rows.length >= limit) { recordSource({ source: srcTag, status: 'ok', rawCount: batch.length, kept }); break outer; }
      }
      recordSource({ source: srcTag, status: 'ok', rawCount: batch.length, kept });
    }
  }

  // 本地过滤丢了多少要报出来：rawCount 和最终行数之间的差不是「Reddit 没给」。
  if (filteredByStrict || filteredAsDup) {
    console.error(`# 本地过滤：句式二次过滤丢弃 ${filteredByStrict} 条（--no-strict 可关），跨查询去重丢弃 ${filteredAsDup} 条`);
  }

  if (!rows.length && source === 'rss') {
    console.error('一条都没捞到。多半是被限流了，试试：加大 --delay、缩小 --template 数量、'
      + '或配 REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET 走 --source oauth。'
      + '\n再不行用 --source pullpush（第三方历史镜像，数据有滞后）。');
  }

  // 持久会话 `site:reddit` 那个标签页会留在用户浏览器里（adapter 持久会话按设计 keep-tab，
  // 且 `opencli browser site:reddit close` 关的是 browser surface 的同名租约，碰不到它）。
  // 留着是有意的：下一批查询直接复用、不再导航首页；它在会话组里、不抢焦点。用户想关随手关掉即可。

  emit(rows, args, source === 'oauth' || source === 'pullpush' || source === 'opencli'
    ? [
      { key: 'score', label: '赞', max: 5 },
      { key: 'numComments', label: '评', max: 4 },
      { key: 'subreddit', label: '版块', max: 18 },
      { key: 'title', label: '标题（可直接当页面选题）', max: 78 },
      { key: 'permalink', label: '链接', max: 40 },
    ]
    : [
      { key: 'createdAt', label: '时间', max: 20 },
      { key: 'subreddit', label: '版块', max: 18 },
      { key: 'title', label: '标题（可直接当页面选题）', max: 80 },
      { key: 'permalink', label: '链接', max: 40 },
    ]);
}

main().catch((e) => die(e.message));
