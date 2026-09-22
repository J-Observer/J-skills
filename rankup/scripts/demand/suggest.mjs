#!/usr/bin/env node
/**
 * 用途：把一个词根丢进 Google / Bing / DuckDuckGo 的搜索框，取回下拉联想（autocomplete）。
 *   下拉联想是用户真实搜索行为的直接投射：它推荐的是有人在搜的串，更新比任何
 *   第三方关键词库都快。这是「扩树」的第一层叶子来源，配合 word-roots.mjs（本地模板）
 *   与面板相关词（similarweb-keywords / semrush-keyword）一起用。
 *
 * 示例命令：
 *   node scripts/demand/suggest.mjs "clipboard history"
 *   node scripts/demand/suggest.mjs "clipboard history" --engine google,bing,ddg --hl en --gl us --json
 *   node scripts/demand/suggest.mjs "クリップボード 履歴" --hl ja --gl jp --json --out /tmp/k/suggest-ja.json
 *   node scripts/demand/suggest.mjs "clipboard history" --engine google --hl en --gl us --evidence-dir /tmp/k/ev
 *
 * 三个端点（纯 HTTP，零依赖，Node 20+，不需要浏览器、不需要钥匙、不计任何配额）：
 *   google  https://suggestqueries.google.com/complete/search?client=firefox&q=..&hl=..&gl=..&oe=utf-8&ie=utf-8
 *           响应形状 ["<query>", ["s1","s2",...]]
 *   bing    https://api.bing.com/osjson.aspx?query=..&language=<hl>&market=<hl>-<GL>
 *           响应形状 ["<query>", ["s1","s2",...]]（OpenSearch JSON，后面可能再跟两个空数组）
 *   ddg     https://duckduckgo.com/ac/?q=..&kl=<gl>-<hl>
 *           响应形状 [{"phrase":"s1"},{"phrase":"s2"},...]
 *   --hl 是界面/查询语言（ja、en、de…），--gl 是国家（jp、us、de…）；两者都默认 en/us，
 *   但**全球市场逐国查**——目标市场不是美国时必须显式传。非拉丁语种一律 utf-8 编解码。
 *
 * 产出（--json）：
 *   { root, hl, gl, engines: { google: [...], bing: [...], ddg: [...] }, manifest: {...} }
 *   某引擎采集失败时它的值是 null，不是 []——「0 条」和「没取到」在产出里必须长得不一样。
 *   每引擎独立请求、互不影响；失败把 {engine,url,status,body} 原样落进证据目录
 *   （--evidence-dir 或默认 .rankup/evidence/demand/suggest-<时间戳>/），manifest.json 逐引擎记状态。
 *
 * 只采集不判读：不去重、不打分、不合并三引擎、不猜意图。三引擎的差集本身就是信息
 * （Bing 有而 Google 没有的串常是另一批用户的说法），合并与筛选交给读结果的人。
 * 下拉联想是**候选串**，不是关键词——没有量也没有难度，下一步必须取量。
 *
 * 已验证日期：2026-09-02（三引擎 en/us 联网实测，见文件末尾的「实测记录」）。
 *
 * 已知坑：
 *   - Google 端点偶发 HTTP 429 / 302 到 sorry 页（同 IP 短时间请求过多），脚本不重试超过 2 次；
 *     落到 manifest 之后换时间再跑，不要把 429 读成「这个词没有联想」。
 *   - Bing 的 market 参数格式是 `en-US`（语言小写-国家大写），传错不报错、静默回英文美国。
 *   - DDG 的 kl 是「国家-语言」（`us-en`、`jp-jp`），与 Google 的 hl/gl 顺序相反；
 *     且 DDG 网页结果主要来自 Bing 索引，联想词也高度重合——它不构成第三个独立样本。
 *   - 三个端点都只回 8–10 条最热的；要 26 个方向用 alphabet soup：
 *     `for c in {a..z}; do node scripts/demand/suggest.mjs "<词根> $c" --json --out /tmp/k/soup-$c.json; done`
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  parseArgs, asList, get, initEvidence, recordSource, saveEvidence, writeManifest,
  sourceStatusSummary, evidenceDir, writeOut, die,
} from './_lib.mjs';

export const ENGINES = ['google', 'bing', 'ddg'];

const HELP = `
suggest.mjs — 词根 → Google / Bing / DuckDuckGo 搜索框下拉联想（只采集不判读）

用法:
  node suggest.mjs <词根> [选项]

选项:
  --engine <list>      google,bing,ddg 逗号分隔，默认三个都跑
  --hl <lang>          查询语言（默认 en）
  --gl <country>       国家（默认 us）。全球市场逐国查，目标市场不是美国时必须传
  --timeout <ms>       单引擎超时（默认 15000）
  --evidence-dir <d>   证据目录（默认 .rankup/evidence/demand/suggest-<时间戳>/）
  --json               输出 JSON 对象 {root,hl,gl,engines,manifest}
  --out <file>         同时写入文件（JSON）
  --help

产出:
  engines.<引擎> 是原样顺序的联想串数组；采集失败为 null（不是 []）。
  manifest.sources 逐引擎记 {source,status,rawCount,url,error,evidence}。
`.trim();

// ── URL 构造 ─────────────────────────────────────────────────────────────────

/** 三引擎各自的参数约定；hl/gl 大小写在这里统一，调用方不用记。 */
export function buildUrl(engine, root, { hl = 'en', gl = 'us' } = {}) {
  const q = encodeURIComponent(String(root));
  const lang = String(hl).toLowerCase();
  const cc = String(gl).toLowerCase();
  switch (engine) {
    case 'google':
      return `https://suggestqueries.google.com/complete/search?client=firefox&q=${q}&hl=${lang}&gl=${cc}&oe=utf-8&ie=utf-8`;
    case 'bing':
      return `https://api.bing.com/osjson.aspx?query=${q}&language=${lang}&market=${lang}-${cc.toUpperCase()}`;
    case 'ddg':
      return `https://duckduckgo.com/ac/?q=${q}&kl=${cc}-${lang}`;
    default:
      throw new Error(`未知引擎：${engine}（可选 ${ENGINES.join(', ')}）`);
  }
}

// ── 解析（纯函数，离线可测）────────────────────────────────────────────────

/** Google：["query", ["s1", "s2", ...]] */
export function parseGoogle(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data) || !Array.isArray(data[1])) throw new Error('Google 响应不是 [query, [..]] 形状');
  return data[1].map((s) => (Array.isArray(s) ? s[0] : s)).filter((s) => typeof s === 'string');
}

/** Bing（OpenSearch JSON）：["query", ["s1", "s2", ...], [...], [...]] */
export function parseBing(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data) || !Array.isArray(data[1])) throw new Error('Bing 响应不是 OpenSearch [query, [..]] 形状');
  return data[1].filter((s) => typeof s === 'string');
}

/** DuckDuckGo：[{"phrase": "s1"}, {"phrase": "s2"}, ...] */
export function parseDdg(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('DDG 响应不是数组');
  return data.map((o) => (o && typeof o === 'object' ? o.phrase : o)).filter((s) => typeof s === 'string');
}

export const PARSERS = { google: parseGoogle, bing: parseBing, ddg: parseDdg };

// ── 采集 ────────────────────────────────────────────────────────────────────

/**
 * 默认取数器：走 _lib.get（带浏览器 UA、超时、5xx/429 重试）。
 * 网络层失败（连不上/超时）get 会自己落现场再抛，这里统一成 {status:null,body:错误信息}。
 */
async function defaultFetcher(url, { hl, timeout }) {
  try {
    const res = await get(url, {
      timeout,
      retries: 1,
      headers: { accept: 'application/json,text/plain;q=0.9,*/*;q=0.8', 'accept-language': `${hl},en;q=0.5` },
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: null, body: String(e?.message ?? e) };
  }
}

/**
 * 采集一个引擎。永远不抛：成功回数组并记 ok；失败回 null，把 {engine,url,status,body}
 * 落证据目录并在 manifest 记非 ok 状态。fetcher 可注入（离线测试用）。
 */
export async function collectEngine(engine, root, { hl = 'en', gl = 'us', timeout = 15000, fetcher = defaultFetcher } = {}) {
  const url = buildUrl(engine, root, { hl, gl });
  const parse = PARSERS[engine];
  let status = null;
  let body = null;
  try {
    ({ status, body } = await fetcher(url, { hl, gl, timeout }));
  } catch (e) {
    status = null;
    body = String(e?.message ?? e);
  }
  const fail = (kind, error) => {
    const evidence = saveEvidence(`suggest-${engine}-${status ?? 'neterr'}.json`, {
      at: new Date().toISOString(), engine, url, status, body: body == null ? null : String(body).slice(0, 20000),
    });
    recordSource({ source: engine, status: kind, rawCount: 0, url, error: String(error).slice(0, 300), evidence });
    return null;
  };
  if (status == null) return fail('network_error', body);
  if (status < 200 || status >= 300) return fail(`http_${status}`, `HTTP ${status}`);
  let items;
  try { items = parse(body); } catch (e) { return fail('parse_error', e.message); }
  recordSource({ source: engine, status: 'ok', rawCount: items.length, url });
  return items;
}

/** 跑一组引擎，返回 {root,hl,gl,engines}；manifest 由调用方落。 */
export async function collect(root, { engines = ENGINES, hl = 'en', gl = 'us', timeout = 15000, fetcher = defaultFetcher } = {}) {
  const out = { root, hl, gl, engines: {} };
  for (const engine of engines) {
    out.engines[engine] = await collectEngine(engine, root, { hl, gl, timeout, fetcher });
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  if (args.help || !args._.length) { console.log(HELP); process.exit(args.help ? 0 : 2); }
  const root = args._.join(' ').trim();
  const engines = asList(args.engine).flatMap((s) => String(s).split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const chosen = engines.length ? engines : ENGINES;
  for (const e of chosen) if (!ENGINES.includes(e)) die(`--engine 只认 ${ENGINES.join(',')}，收到「${e}」`);
  const hl = String(args.hl || 'en');
  const gl = String(args.gl || 'us');
  const timeout = Number(args.timeout || 15000);

  initEvidence('suggest', { dir: args['evidence-dir'] ?? null });
  const result = await collect(root, { engines: chosen, hl, gl, timeout });
  const summary = sourceStatusSummary();
  const manifestFile = writeManifest(summary?.failed ? (summary.ok ? 'partial' : 'failed') : 'completed');
  const manifest = {
    evidenceDir: evidenceDir(),
    file: manifestFile,
    sources: summary ? summary.lines.map((l) => l.trim()) : [],
    ok: summary?.ok ?? 0,
    failed: summary?.failed ?? 0,
  };
  const payload = { ...result, manifest };

  if (args.out) {
    const p = writeOut(args.out, payload);
    if (!args.json) console.error(`已写入 ${p}`);
  }
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`词根：${root}   hl=${hl} gl=${gl}`);
    for (const e of chosen) {
      const items = result.engines[e];
      if (items === null) { console.log(`\n[${e}] 采集失败（见 manifest，不是「没有联想」）`); continue; }
      console.log(`\n[${e}] ${items.length} 条`);
      for (const s of items) console.log(`  ${s}`);
    }
    console.log('\n下拉联想是候选串，不是关键词——没有量也没有难度，下一步必须取量。');
  }
  if (manifest.failed) {
    process.exitCode = 1;
    console.error(`注意：${manifest.failed}/${chosen.length} 个引擎采集失败——null 是「没取到」，不是「没有联想」。`);
    for (const l of manifest.sources) console.error(`  - ${l}`);
  }
  console.error(`manifest：${manifestFile}`);
}

// 只有直接执行时才跑 main；被测试 import 时保持零副作用。
// 两边都取 realpath：通过 ~/.claude/skills/rankup 这类软链调用时 argv[1] 是链接路径、
// import.meta.url 是真实路径，直接比会永远不相等 → 静默退出 0、什么都不跑（2026-09-03 实测踩坑）。
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch { return false; }
})();
if (invokedDirectly) main().catch((e) => die(e.message));

/*
 * 实测记录（2026-09-02，`"clipboard history" --engine google,bing,ddg --hl en --gl us --json`）：
 *   google ok rawCount=10 · bing ok rawCount=16 · ddg ok rawCount=8，三引擎全 200，
 *   耗时 <3 秒；Bing 独有 "not working" / "hotkey" / "on this computer" 这类问题串，
 *   Google 独有 android / iphone / macos 平台串——差集就是各引擎用户说法的差异。
 *   离线测试（tests/suggest.test.mjs）只覆盖解析与 manifest；端点形状一旦变化，
 *   先改 PARSERS 再更新头部「已验证日期」。
 */
