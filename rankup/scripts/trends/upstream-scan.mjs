#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const opts = {};
for (let i = 2; i < process.argv.length; i++) opts[process.argv[i].slice(2)] = process.argv[i] === '--dry-run' ? true : process.argv[++i];
const root = resolve(opts['data-dir'] || process.env.RANKUP_TRENDS_DIR || '.rankup/trends');
const base = join(root, 'upstream'), dry = !!opts['dry-run'];
const fetchedAt = new Date().toISOString();
const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', '-').replace(/:/g, '');
const day = stamp.slice(0, 10);
if (!dry) {
  mkdirSync(base, { recursive: true });
  const lockFile = join(base, '.lock');
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive && Date.now() - Date.parse(lock.time) <= 2 * 60 * 60 * 1000) {
      console.error('另一轮在运行');
      process.exit(1);
    }
    unlinkSync(lockFile);
  }
  const lock = JSON.stringify({ pid: process.pid, time: fetchedAt });
  try { writeFileSync(lockFile, lock, { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; console.error('另一轮在运行'); process.exit(1); }
  process.on('exit', () => {
    if (existsSync(lockFile) && readFileSync(lockFile, 'utf8') === lock) unlinkSync(lockFile);
  });
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}
let runId = stamp;
for (let sequence = 1; existsSync(join(base, 'reports', `${runId}.md`)) || sourcesForRunId(runId); sequence++) {
  runId = `${stamp}-${String(sequence).padStart(3, '0')}`;
}
function sourcesForRunId(id) {
  const dir = join(base, 'snapshots', day);
  return existsSync(dir) && readdirSync(dir).some(file => file.startsWith(`${id.slice(11)}-`));
}
const normalize = s => s.toLowerCase().replace(/#/g, '').replace(/\s+/g, ' ').trim();
const text = s => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '})[n]).replace(/\s+/g, ' ').trim();
const attr = (s, name) => text(s.match(new RegExp(`${name}=(["'])([\\s\\S]*?)\\1`))?.[2] || '');
const matches = (s, regex) => [...s.matchAll(regex)];
const cells = row => matches(row, /<td\b[^>]*>([\s\S]*?)<\/td>/g).map(m => m[1]);
const readJson = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const saveAtomic = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
};
let lastRequest = 0;
async function request(url, options = {}) {
  await sleep(Math.max(0, 2000 - (Date.now() - lastRequest)));
  lastRequest = Date.now();
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', ...options.headers } });
  const body = await response.text();
  lastRequest = Date.now();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return body;
}
async function trends24(url) {
  let html;
  try { html = await request(url); } catch { html = await request(url); }
  const list = html.match(/<ol class=["']?trend-card__list["']?>([\s\S]*?)<\/ol>/)?.[1] || '';
  return matches(list, /<li\b[^>]*>([\s\S]*?)<\/li>/g).map((m, i) => ({ term: text(m[1].match(/<a\b[^>]*>([\s\S]*?)<\/a>/)?.[1] || ''), rank: i + 1, extra: { snapshotTimestamp: html.match(/data-timestamp=["']?([\d.]+)/)?.[1] || null, tweetCount: attr(m[1], 'data-count') || null } }));
}
async function getdaytrends(url) {
  return matches(await request(url), /<tr\b[^>]*>([\s\S]*?)<\/tr>/g).filter(m => /class="pos"/.test(m[1]) && /class="string"/.test(m[1])).map(m => ({ term: text(m[1].match(/<a class="string"[^>]*>([\s\S]*?)<\/a>/)?.[1] || ''), rank: Number(m[1].match(/class="pos">(\d+)/)?.[1]), extra: { url: new URL(attr(m[1], 'href'), url).href } }));
}
async function kworb(url) {
  const html = await request(url), table = html.match(/<table id="trendingcountry"[^>]*>([\s\S]*?)<\/table>/)?.[1] || '';
  return matches(table, /<tr\b[^>]*>([\s\S]*?)<\/tr>/g).filter(m => /youtu.be/.test(m[1])).map(m => { const c = cells(m[1]); return { term: text(c[2]), rank: Number(text(c[0])), extra: { change: text(c[1]), url: attr(c[2], 'href'), updated: text(html.match(/<span class="pagetitle">([\s\S]*?)<\/span>/)?.[1] || '') } }; });
}
async function shorts(url) {
  // 留样有端点和响应，但缺请求体；两种请求格式均失败则跳过，不使用历史榜冒充当前榜。
  let reason;
  for (const period of ['DAILY', 'WEEKLY']) {
    try {
      const params = { perspective: 'CHART_DETAILS', chartParams: { countryCode: 'us', chartType: 'CHART_TYPE_SHORTS_TRACKS_BY_USAGE', chartPeriodType: `CHART_PERIOD_TYPE_${period}` }, flags: 'MusicCharts__enable_apac_and_shorts_charts_expansion' };
      const data = JSON.parse(await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: { client: { clientName: 'WEB_MUSIC_ANALYTICS', clientVersion: '2.0', hl: 'en', gl: 'US' } }, browseId: 'FEmusic_analytics', query: JSON.stringify(params) }) }));
      const content = data.contents?.sectionListRenderer?.contents?.[0]?.musicAnalyticsSectionRenderer?.content;
      const tracks = content?.trackTypes?.flatMap(t => t.trackViews || []) || [];
      if (tracks.length) return tracks.map(t => ({ term: t.name, rank: t.chartEntryMetadata.currentPosition, extra: { artists: t.artists?.map(a => a.name), ...t.chartEntryMetadata, chart: content.perspectiveMetadata, period } }));
      reason = '响应没有歌曲榜';
    } catch (e) { reason = e.message; }
  }
  throw Object.assign(new Error(`请求格式未复现（${reason}；尝试 2 次）`), { skipped: true });
}
async function kym(url) {
  return matches(await retryRequest(url), /<a class="item"[^>]*>/g).filter(m => /data-title=/.test(m[0])).map((m, i) => ({ term: attr(m[0], 'data-title'), rank: i + 1, extra: { author: attr(m[0], 'data-author'), url: new URL(attr(m[0], 'href'), url).href, rankMeaning: 'newest 列表顺序，非热度排名' } }));
}
async function tokchart(url) {
  return matches(await retryRequest(url), /<tr\b[^>]*data-sound-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g).map((m, i) => { const c = cells(m[2]); return { term: text(c[1].match(/<a[^>]*class="inline-block[^>]*>([\s\S]*?)<\/a>/)?.[1] || ''), rank: i + 1, extra: { soundId: m[1], score: text(c[0]), music: text(c[2]), videos7dDailyAverage: text(c[3]), growth: text(c[4]), countries: text(c[9]), cells: c.map(text) } }; });
}
async function retryRequest(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await request(url, { signal: AbortSignal.timeout(20000) }); }
    catch (e) { if (attempt === 2) throw e; await sleep((attempt + 1) * 3000); }
  }
}
async function heyorca(url) {
  const rows = matches(await request(url), /<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h[23]\b|$)/g)
    .filter(m => /^\d+\./.test(text(m[1])) && /https:\/\/www\.tiktok\.com\/@[^"']+\/video\//.test(m[0]))
    .map((m, i) => ({ term: text(m[1]).replace(/^\d+\.\s*/, ''), rank: i + 1, extra: { source: 'editorial', description: matches(m[2].split('<blockquote')[0], /<p\b[^>]*>([\s\S]*?)<\/p>/g).map(p => text(p[1])).join(' '), links: [...new Set(matches(m[0], /(?:href|cite)=["'](https:\/\/www\.tiktok\.com\/(?:@[^"']+\/video\/|music\/)[^"']+)["']/g).map(link => text(link[1])))], rankMeaning: '页面顺序，人工整理，非实时热度榜' } }));
  if (!rows.length) throw new Error('解析 0 条');
  return rows;
}
// 新来源只需登记元数据及采集函数；所有来源共用快照、健康和对比流程。
const sources = [
  { id: 'trends24-us', platform: 'X', kind: 'topic', region: 'US', url: 'https://trends24.in/united-states/', fetch: trends24 },
  { id: 'getdaytrends-us', platform: 'X', kind: 'topic', region: 'US', url: 'https://getdaytrends.com/united-states/', fetch: getdaytrends },
  { id: 'kworb-yt-us', platform: 'YouTube', kind: 'video', region: 'US', url: 'https://kworb.net/youtube/trending/us.html', fetch: kworb },
  { id: 'yt-charts-shorts-us', platform: 'YouTube Shorts', kind: 'music', region: 'US', url: 'https://charts.youtube.com/youtubei/v1/browse?alt=json', fetch: shorts },
  { id: 'kym-newest', platform: '梗', kind: 'meme', region: 'global', url: 'https://knowyourmeme.com/memes?sort=newest', fetch: kym },
  { id: 'tokchart-audios', platform: 'TikTok 音乐', kind: 'audio', region: 'global', url: 'https://tokchart.com/', fetch: tokchart },
  { id: 'heyorca-tiktok', platform: 'TikTok', kind: 'meme/template/sound', region: 'global', url: 'https://www.heyorca.com/blog/capcut-trends-and-templates', fetch: heyorca },
].filter(s => !opts.sources || opts.sources.split(',').includes(s.id));
const seenFile = join(base, 'upstream_seen.json'), seen = readJson(seenFile, {});
const tracked = new Set(readJson(join(root, 'hot_tracker.json'), { terms: [] }).terms.map(t => normalize(t.term)));
const rejectedFile = '/Users/kcsx/Project/kcsx/macmini/.rankup/rejected.md';
const rejected = existsSync(rejectedFile) ? normalize(readFileSync(rejectedFile, 'utf8')) : '';
const health = [], all = [], newRows = [], jumps = [];
const snapshotRoot = join(base, 'snapshots');
for (const source of sources) {
  try {
    const rows = await source.fetch(source.url);
    if (!rows.length || rows.some(r => !r.term)) throw new Error('未解析到完整榜单词条');
    const records = [...new Map(rows.map(r => [normalize(r.term), { source: source.id, platform: source.platform, kind: source.kind, region: source.region, ...r, fetchedAt }])).values()];
    const files = existsSync(snapshotRoot) ? readdirSync(snapshotRoot).sort().flatMap(d => readdirSync(join(snapshotRoot, d)).filter(f => f.endsWith(`-${source.id}.json`)).sort().map(f => join(snapshotRoot, d, f))) : [];
    const previous = new Map((files.length ? readJson(files.at(-1), []) : []).map(r => [normalize(r.term), r.rank]));
    for (const row of records) {
      const oldRank = previous.get(normalize(row.term));
      if (oldRank === undefined) newRows.push(row);
      else if (oldRank - row.rank >= 10) jumps.push({ ...row, oldRank, rise: oldRank - row.rank });
    }
    all.push(...records);
    health.push({ source: source.id, status: 'ok', count: records.length, reason: '' });
    if (!dry) { const dir = join(snapshotRoot, day); mkdirSync(dir, { recursive: true }); save(join(dir, `${runId.slice(11)}-${source.id}.json`), records); }
  } catch (e) { health.push({ source: source.id, status: e.skipped ? 'skipped' : 'fail', count: null, reason: e.message }); }
  lastRequest = Date.now();
  console.log(`${health.at(-1).source}: ${health.at(-1).status} ${health.at(-1).count ?? health.at(-1).reason}`);
}
const grouped = new Map();
for (const row of all) { const key = normalize(row.term); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(row); }
const newKeys = new Set(newRows.map(r => normalize(r.term)));
const candidates = [...grouped].map(([key, rows]) => {
  const sources = [...new Set(rows.map(r => r.source))], platforms = [...new Set(rows.map(r => r.platform))], best = Math.min(...rows.map(r => r.rank));
  const old = seen[key];
  const alreadyTracked = tracked.has(key), alreadyRejected = rejected.includes(key);
  const tags = [...(newKeys.has(key) ? ['new-entry'] : []), ...(sources.length > 1 ? ['cross-source'] : []), ...(platforms.length > 1 ? ['cross-platform'] : []), ...(/effect|filter|template|ai|trend|challenge|generator|preset|sound/i.test(key) ? ['tool-hint'] : []), ...(alreadyTracked ? ['already-tracked'] : []), ...(alreadyRejected ? ['already-rejected'] : [])];
  if (!tags.includes('tool-hint') && /^[A-Z][a-z]*(?: [A-Z][a-z]*){0,2}$/.test(rows[0].term.replace(/^#/, ''))) tags.push('person-or-news?');
  seen[key] = { first_seen: old?.first_seen || fetchedAt, last_seen: fetchedAt, appearances: (old?.appearances || 0) + 1, best_rank: Math.min(old?.best_rank ?? Infinity, best), sources: [...new Set([...(old?.sources || []), ...sources])] };
  return { term: rows[0].term, score: sources.length * 100 + (newKeys.has(key) ? 30 : 0) + Math.round(50 / best), sources, platforms, firstSeen: seen[key].first_seen, tags, alreadyTracked, alreadyRejected };
}).sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
async function verifyGt(n) {
  const gt = join(homedir(), '.claude/skills/rankup/scripts/gt.py'), session = `upstream-scan-${process.pid}`;
  const cwd = join(base, 'gt'); mkdirSync(cwd, { recursive: true });
  const call = args => execFileSync('python3', [gt, ...args, '--session', session], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const candidate of candidates.slice(0, n)) {
      await sleep(10000);
      // 429 沿用 gt.py 内置退避，不叠加外层重试。
        let output, error;
        try { output = call(['compare', candidate.term, '--geo', 'US', '--time', '7d', '--keep-session']); }
        catch (e) { error = String(e.stderr || e.message); }
        if (error) {
          candidate.gt7d = { status: 'fail', reason: error };
          if (/timeout|超时|slot|槽位|captcha|验证码|opencli-open-failed/i.test(error)) { health.push({ source: 'google-trends', status: 'fail', count: null, reason: error }); return; }
          continue;
        }
        const rows = output.split('\n').map(line => line.match(/^\|\s*(\d{4}-\d{2}-\d{2}(?:[^|]*)?)\s*\|\s*(\d+)\s*\|/)).filter(Boolean).map(m => ({ date: m[1].trim(), value: Number(m[2]) }));
        // 7d 可能返回小时点；按日期取均值，最后七个可测日再计算两组比值。
        const days = new Map(); for (const row of rows) { if (!days.has(row.date.slice(0, 10))) days.set(row.date.slice(0, 10), []); days.get(row.date.slice(0, 10)).push(row.value); }
        const mean = a => a.reduce((sum, v) => sum + v, 0) / a.length;
        const daily = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, value: mean(values) })).slice(-7);
        const values = daily.map(r => r.value), first5 = values.length === 7 ? mean(values.slice(0, 5)) : null;
        candidate.gt7d = daily.length ? { status: 'ok', mean: mean(values), peakDay: daily.reduce((a, b) => b.value > a.value ? b : a).date, recent2OverPrevious5: first5 > 0 ? mean(values.slice(-2)) / first5 : null, daily } : { status: 'empty', reason: '未返回可测日期读数' };
    }
  } finally { try { call(['close']); } catch (e) { health.push({ source: 'google-trends-close', status: 'fail', count: null, reason: String(e.stderr || e.message) }); } }
}
if (Number(opts['verify-gt']) > 0) await verifyGt(Number(opts['verify-gt']));
const cross = candidates.filter(c => c.sources.length > 1);
const cell = value => String(value ?? '—').replace(/[\r\n|]/g, ' ');
const table = (headers, rows) => `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.length ? rows.map(row => `| ${row.map(cell).join(' | ')} |`).join('\n') : `| 无 | ${headers.slice(1).map(() => '—').join(' | ')} |`}`;
const report = [
  '## 来源健康', table(['来源', '状态', '条数', '原因'], health.map(h => [h.source, h.status, h.count, h.reason || '成功'])),
  `抓取时间：${fetchedAt}。首次采集视为新上榜；名次大涨指同来源较上次提升至少 10 位。appearances 每词每次运行加 1。X 两站重合不代表跨平台；KYM 为 newest 顺序；全球音乐不能代替美国特效榜。`,
  '## 新上榜词', table(['词', '来源', '名次'], newRows.map(r => [r.term, r.source, r.rank])),
  '## 名次大涨', table(['词', '来源', '上次 → 本次', '提升'], jumps.map(r => [r.term, r.source, `${r.oldRank} → ${r.rank}`, r.rise])),
  '## 跨来源同时出现', table(['词', '来源', '平台'], cross.map(c => [c.term, c.sources.join(', '), c.platforms.join(', ')])),
  '## 候选清单', table(['词', '评分', '来源', '标签', '已追踪', '已否决'], candidates.slice(0, 30).map(c => [c.term, c.score, c.sources.join(', '), c.tags.join(', '), c.alreadyTracked ? '是' : '否', c.alreadyRejected ? '是' : '否'])),
].join('\n\n') + '\n';
console.log(JSON.stringify({ dryRun: dry, terms: candidates.length, newEntries: newRows.length, rankJumps: jumps.length, crossSource: cross.length, top10: candidates.slice(0, 10).map(c => c.term) }, null, 2));
if (!dry) {
  mkdirSync(join(base, 'reports'), { recursive: true });
  saveAtomic(seenFile, seen); saveAtomic(join(base, 'candidates.json'), candidates);
  writeFileSync(join(base, 'reports', `${runId}.md`), report, { flag: 'wx' });
  console.log(`报告：${join(base, 'reports', `${runId}.md`)}`);
}
