#!/usr/bin/env node
/**
 * chrome-stats.mjs —— chrome-stats.com 榜单取数（趋势 / 新增 / 已下架）
 *
 * 用途：
 *   1) 趋势榜：一周/一月用户数涨得最快的浏览器扩展 = 正在被验证的新需求。
 *   2) 新增榜：刚上架的扩展 = 别人刚下注的方向。
 *   3) **已下架榜（obsolete / recently removed）**：产品被下架 = 存量用户无处可去，
 *      迁移刚需有强时效性，是本脚本最独特的信号。
 *   还支持 Edge / Firefox / Android / Apple 同结构榜单。
 *
 * 示例命令：
 *   node chrome-stats.mjs --list trending-week
 *   node chrome-stats.mjs --list obsolete --min-users 10000 --json
 *   node chrome-stats.mjs --platform edge --list newly-added --out edge-new.json
 *   node chrome-stats.mjs --list trending-month --session demand-x-cs --keep-open
 *
 * 依赖：
 *   **必须走 OpenCLI 驱动用户本机真实 Chrome**。chrome-stats.com 全站挂 Cloudflare
 *   托管挑战，curl / fetch 一律 403（"Just a moment..."）。不需要 chrome-stats 账号登录，
 *   只是需要一个真浏览器过挑战。
 *   前置：`opencli doctor` 要绿。
 *
 * 已验证日期：2026-08-24
 * 失败留现场（2026-08-30 重构第二波，截图链路已实盘验证）：
 *   任何浏览器路径失败（打不开 / eval 不回 / 0 张卡片）都会先把**截图 + 页面全文**
 *   落进证据目录再关标签页（--keep-open 则连关都不关），并写 manifest.json。
 *   「0 张卡片」是留证陈述不是结论——是 CF 没过完、改版、还是真空榜，
 *   由 AI 对着证据目录里的双证人判。
 *
 * 已知坑：
 *   - **免费只有第 1 页**：每个榜单固定 25 条，翻页链接（2/3/Next）全部指向 /pricing，
 *     即翻页要付费账号。想要更多样本就换不同榜单 / 不同平台各拉 25 条。
 *   - 站点是 Svelte 构建，class 带编译哈希（`svelte-xxxxxxx`），本脚本只用不带哈希的
 *     基础类名（.extension-card / .rank / .extension-name / .stats-item.users ...），
 *     改版仍可能断。出数为 0 时先看证据目录里的截图和页面全文。
 *   - obsolete 榜默认不是按用户数排序，小扩展会排在前面；用 --min-users 过滤，
 *     但因为只有 25 条，**大产品下架不一定当天就能被这个榜捞到**。
 *   - users 是 chrome-stats 自己的估算/快照，和 Chrome Web Store 页面上的四舍五入值可能不同。
 *   - 会话纪律：本脚本用完会自己 `opencli browser <session> close`；
 *     多 agent 并行时务必用 --session 传**带你自己前缀的字面常量**，不要用 $$。
 *     永远不要跑 `opencli browser cleanup`（会关掉别人的标签页）。
 */

import { writeFileSync } from 'node:fs';
import { execFile } from '../../../backlink/scripts/lib-opencli-process.mjs';
import { promisify } from 'node:util';
import {
  sessionName, requireBrowserBridge, initEvidence, saveEvidence, recordSource,
  writeManifest, captureBrowserScene, evidenceDir,
} from './_lib.mjs';

const exec = promisify(execFile);

const LISTS = [
  'trending', 'trending-by-delta',
  'trending-week', 'trending-week-by-delta',
  'trending-month', 'trending-month-by-delta',
];
const HELP = `chrome-stats.mjs — chrome-stats.com 榜单取数（需要 OpenCLI 真浏览器）

用法:
  node chrome-stats.mjs [--list <name>] [选项]

榜单 --list:
  ${LISTS.join(' | ')}
  newly-added          刚上架
  obsolete             已下架 / 停止维护（"Recently removed"）—— 迁移需求信号
  (默认 trending-week)

  也可以直接 --path /chrome/advanced/... 传任意 chrome-stats 列表路径

选项:
  --platform <p>   chrome | edge | firefox | android | apple  (默认 chrome)
  --min-users <n>  最少用户数                                 (默认 0)
  --max-rating <x> 最高评分（挖执行差的机会用 4.3）            (默认 5)
  --limit <n>      最多输出                                   (默认 不限)
  --session <s>    OpenCLI 会话名，必须是带你前缀的字面常量
                                                (默认 demand-chrome-stats)
  --keep-open      跑完不关标签页（默认会 close；失败排查时建议带上）
  --timeout <ms>   页面就绪轮询预算                            (默认 9000)
  --evidence-dir <d> 失败现场与 manifest 落点
                     (默认 .rankup/evidence/demand/chrome-stats-<ts>/)
  --debug          出错时把页面文本片段也打到 stderr（截图/全文总会落证据目录）
  --json / --jsonl / --out <file>
  -h, --help

输出字段: {source, name, url, domain, users, rating, ratingCount, date, extra}
  extra: {id, rank, author, summary, delta, percentChange, prevUsers, list, platform}
`;

function parseArgs(argv) {
  const o = {
    list: 'trending-week', path: null, platform: 'chrome',
    minUsers: 0, maxRating: 5, limit: Infinity,
    session: sessionName('demand-chrome-stats'), keepOpen: false, timeout: 9000, debug: false,
    json: false, jsonl: false, out: null, evidenceDir: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--list': o.list = next(); break;
      case '--path': o.path = next(); break;
      case '--platform': o.platform = next(); break;
      case '--min-users': o.minUsers = Number(next()); break;
      case '--max-rating': o.maxRating = Number(next()); break;
      case '--limit': o.limit = Number(next()); break;
      case '--session': o.session = next(); break;
      case '--keep-open': o.keepOpen = true; break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--debug': o.debug = true; break;
      case '--json': o.json = true; break;
      case '--jsonl': o.jsonl = true; break;
      case '--out': o.out = next(); break;
      case '--evidence-dir': o.evidenceDir = next(); break;
      default:
        if (a.startsWith('-')) { console.error(`未知参数: ${a}\n${HELP}`); process.exit(2); }
    }
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function opencli(args) {
  const { stdout } = await exec('opencli', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function jsonFromStdout(stdout) {
  const i = stdout.indexOf('{');
  const j = stdout.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error(`OpenCLI 未返回 JSON:\n${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(i, j + 1));
}

// 在页面里跑的提取器。只用不带 svelte 哈希的基础类名。
const EXTRACTOR = `(()=>{
  const num = (s) => { if(!s) return null; const m = String(s).replace(/,/g,'').match(/-?\\d+(\\.\\d+)?/); return m ? Number(m[0]) : null; };
  const txt = (el) => el ? el.innerText.trim().replace(/\\s+/g,' ') : null;
  const cards = [...document.querySelectorAll('.extension-card')];
  const rows = cards.map((c) => {
    const link = c.querySelector('.extension-name a') || c.querySelector('a[href^="/d/"]');
    const href = link ? link.getAttribute('href') : null;
    const delta = c.querySelector('.delta-info');
    return {
      id: href ? href.split('/').pop() : null,
      name: txt(link),
      path: href,
      rank: num(txt(c.querySelector('.rank'))),
      author: txt(c.querySelector('.author-link')),
      summary: txt(c.querySelector('.extension-description')),
      users: num(txt(c.querySelector('.stats-item.users span'))),
      rating: num(txt(c.querySelector('.stats-item.rating .rating'))),
      ratingCount: num(txt(c.querySelector('.stats-item.rating .caption'))),
      delta: delta ? num(txt(delta).replace(/\\(.*/,'').replace(/[↑↓]/g,'')) : null,
      percentChange: delta ? txt(delta.querySelector('.percent-change')) : null,
      prevUsers: delta ? num(txt(delta.querySelector('.prev-count'))) : null,
    };
  });
  return { title: document.title, url: location.href, count: cards.length, rows,
           text: cards.length ? null : document.body.innerText.slice(0, 500) };
})()`;

function fmtNum(n) {
  if (n == null) return '-';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }

  let path = o.path;
  if (!path) {
    if (o.list === 'newly-added' || o.list === 'obsolete') path = `/${o.platform}/${o.list}`;
    else path = `/${o.platform}/trending/${o.list}`;
  }
  const url = `https://chrome-stats.com${path}`;

  // 注意：`opencli doctor` 即使桥没连上也照样退出码 0，只是文案里带 [FAIL]——
  // 之前这里 catch 退出码的写法从来没真正生效过。真正的判据在 requireBrowserBridge()
  // 里（认 `[OK] Connectivity`，探测本身失败/超时则放行，不拿它当「没连上」）。
  requireBrowserBridge();
  initEvidence('chrome-stats', { dir: o.evidenceDir });

  // 铁律：先取证后死、先取证后关。失败路径先把截图+页面全文落进证据目录，
  // 再决定关不关标签页（--keep-open 连关都不关，留活现场）。
  const leaveScene = (tag) => captureBrowserScene(o.session, tag);
  const closeTab = async () => {
    if (o.keepOpen) return;
    try { await opencli(['browser', o.session, 'close']); } catch { /* 已关就算了 */ }
  };

  let payload = null;
  try {
    await opencli(['browser', o.session, '--window', 'background', 'open', url]);
    // waitFor 不 sleep：在 --timeout 预算内轮询提取器，出卡片就走，不傻等整个预算。
    const deadline = Date.now() + Math.max(o.timeout, 3000);
    do {
      await sleep(1200);
      try { payload = jsonFromStdout(await opencli(['browser', o.session, 'eval', EXTRACTOR])); }
      catch { payload = null; /* 页面可能还在过 CF 挑战，继续轮询 */ }
      if (payload?.count) break;
    } while (Date.now() < deadline);
    if (!payload) throw new Error('轮询预算内 eval 一直没有返回 JSON（页面可能没打开/挑战没过）');
  } catch (e) {
    const scene = leaveScene('open-eval-failed');
    recordSource({ source: `chrome-stats:${o.list}`, status: 'browser_error', rawCount: 0, error: String(e.message), scene });
    writeManifest('died: browser_error');
    await closeTab();
    console.error(`错误: ${e.message}`);
    console.error(`现场已留（截图+页面文本）：${evidenceDir()}${o.keepOpen ? '，标签页保持打开' : ''}`);
    process.exit(1);
  }

  if (!payload.count) {
    // 留证陈述，不是结论：0 张卡片只说明「这次没取到」，可能是 CF 挑战没过完、
    // 站点改版、或榜单页确实空——哪一种由 AI 对着证据目录里的截图+全文判。
    const scene = leaveScene('zero-cards');
    saveEvidence('zero-cards-payload.json', payload);
    recordSource({ source: `chrome-stats:${o.list}`, status: 'zero_cards', rawCount: 0, error: '提取器返回 0 张卡片', scene });
    const mf = writeManifest('died: zero_cards');
    await closeTab();
    console.error('未取到任何卡片——这是「这次没取到」，不是「榜单为空」。');
    console.error(`截图+页面全文已落证据目录，自己看：${evidenceDir()}（manifest：${mf}）`);
    if (o.debug) console.error(payload.text || '(无页面文本)');
    process.exit(1);
  }
  recordSource({ source: `chrome-stats:${o.list}`, status: 'ok', rawCount: payload.count });
  await closeTab();

  let rows = payload.rows
    .filter((r) => r.id)
    .map((r) => ({
      source: `chrome-stats:${o.platform}`,
      name: r.name,
      url: `https://chrome-stats.com${r.path}`,
      domain: 'chrome-stats.com',
      users: r.users,
      rating: r.rating,
      ratingCount: r.ratingCount,
      date: null,
      extra: {
        id: r.id, rank: r.rank, author: r.author, summary: r.summary,
        delta: r.delta, percentChange: r.percentChange, prevUsers: r.prevUsers,
        list: o.list, platform: o.platform,
        storeUrl: o.platform === 'chrome'
          ? `https://chromewebstore.google.com/detail/x/${r.id}` : null,
      },
    }))
    .filter((r) => (r.users ?? 0) >= o.minUsers && (r.rating ?? 0) <= o.maxRating);

  if (Number.isFinite(o.limit)) rows = rows.slice(0, o.limit);
  console.error(`manifest：${writeManifest('completed')}`);

  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n');
  if (o.out) {
    writeFileSync(o.out, o.jsonl ? jsonl + '\n' : JSON.stringify(rows, null, 2));
    console.error(`已写入 ${o.out} (${rows.length} 条)`);
  }
  if (o.jsonl) { console.log(jsonl); return; }
  if (o.json) { console.log(JSON.stringify(rows, null, 2)); return; }

  console.log(`${payload.title}\n`);
  const head = ['users', 'Δ', '%', 'rating', 'name', 'url'];
  const body = rows.map((r) => [
    fmtNum(r.users), fmtNum(r.extra.delta), r.extra.percentChange || '-',
    r.rating == null ? '-' : r.rating.toFixed(2),
    (r.name || '').slice(0, 46), r.url,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c) => c.map((v, i) => (i >= 4 ? v : v.padStart(w[i]))).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const b of body) console.log(line(b));
  console.log(`\n共 ${rows.length} 条（免费仅第 1 页 25 条）`);
}

main().catch((e) => { console.error(`错误: ${e.message}`); process.exit(1); });
