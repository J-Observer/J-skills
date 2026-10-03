#!/usr/bin/env node
/** 种子 Rising 七步；仅调用唯一 GT 脚本，依赖本机 Chrome/OpenCLI。
 * --data-dir DIR（其次 RANKUP_TRENDS_DIR，默认 cwd/.rankup/trends）
 * --region US|JP|KR --limit N --seeds a,b,c --dry-run --session NAME
 * --tracker-limit N 用于小样本验证（默认 8）；间隔 10 秒。验证日期 2026-10-01。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const gt = resolve(scriptDir, '../gt-browser.mjs');
const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].slice(2);
  opts[key] = key === 'dry-run' ? true : process.argv[++i];
}
const root = resolve(opts['data-dir'] || process.env.RANKUP_TRENDS_DIR || join(process.cwd(), '.rankup/trends'));
const region = opts.region || 'US', session = opts.session || `trends-${region.toLowerCase()}`;
const started = new Date(), stamp = started.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
const base = join(root, 'evidence/runs', `${region}-${stamp}`), rawDir = `${base}-raw`;
mkdirSync(rawDir, { recursive: true });
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const call = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const python = (script, ...args) => JSON.parse(call('python3', [join(scriptDir, script), '--data-dir', root, ...args]));
const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
const trackerPath = join(root, 'hot_tracker.json');
const tracker = json(trackerPath), local = tracker.terms.filter(t => (t.region || 'US') === region);
const must = local.filter(t => t.status === 'must-do');
const queue = local.filter(t => ['tracking', 'must-do'].includes(t.status))
  .sort((a, b) => Number(b.status === 'must-do') - Number(a.status === 'must-do') || (b.first_seen || '').localeCompare(a.first_seen || ''))
  .slice(0, Math.min(8, Number(opts['tracker-limit'] ?? 8)));
const result = { region, session, dryRun: !!opts['dry-run'], startedAt: started.toISOString(), scanned: 0, ok: 0, empty: 0, fail: 0, new: [], count429: 0, tracking: [], stop: null };
const lines = [];
const qualifies = value => value === 'Breakout' || Number(value.replace(/[^\d]/g, '')) >= 1000;
const seenPath = join(root, region === 'US' ? 'seed_seen.json' : `seed_seen_${region.toLowerCase()}.json`);
const round = started.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16);
function compare(term, time, index) {
  wait();
  const dir = join(rawDir, `tracker-${index}-${time}`);
  mkdirSync(dir, { recursive: true });
  let error;
  try {
    const output = call('node', [gt, 'compare', term, '--geo', region, '--time', time, '--session', session, '--keep-session'], dir);
    writeFileSync(join(dir, 'output.md'), output);
  } catch (e) { error = String(e.stderr || e.message); }
  const evidenceRoot = join(dir, '.rankup/evidence');
  const evidence = join(evidenceRoot, readdirSync(evidenceRoot)[0]);
  const manifest = json(join(evidence, 'manifest.json'));
  result.count429 += manifest.attempts.filter(a => a.status === 429).length;
  if (manifest.page?.captcha || manifest.stopReason === 'opencli-open-failed' || /eval 失败|timeout|disconnected|bridge/i.test(error || ''))
    throw new Error(manifest.page?.captcha ? 'Google 验证码，停止采集' : error);
  if (error) return { status: 'fail', reason: error, evidence };
  if (manifest.stopReason === 'no-data') return { status: 'empty', evidence };
  const data = json(join(evidence, 'compare-result.json'));
  const rows = data.rows.filter(r => r[1] !== '' && r[2] !== '');
  const values = rows.map(r => Number(r[1])), anchors = rows.map(r => Number(r[2]));
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const unresolved = rows.length > 0 && values.every(v => v === 0);
  const anchor = mean(anchors), ratio = !unresolved && anchor > 0 ? mean(values) / anchor : null;
  const current = values.at(-1), peak = Math.max(...values);
  const recent = mean(values.slice(-7)), previous = mean(values.slice(-14, -7));
  // ponytail: 末两组7点均值按10%判形状；人工看原曲线，需要时再定义行业阈值。
  const trend = unresolved ? '未知' : !rows.length ? '缺测' : recent > previous * 1.1 ? '上升' : recent < previous * .9 ? '回落' : '平稳';
  return { status: data.status === 'ok' && rows.length ? 'ok' : 'empty', trend, unresolved, peakRatio: peak > 0 ? current / peak : null, r: ratio, evidence };
}
try {
  let seeds = python('seed_health.py', '--active-seeds', region);
  if (opts.seeds) seeds = seeds.filter(s => opts.seeds.split(',').includes(s.seed));
  if (opts.limit) seeds = seeds.slice(0, Number(opts.limit));
  save(join(rawDir, 'keywords.json'), seeds.map(s => s.seed));
  const batch = JSON.parse(call('node', [gt, 'related-batch', '--keywords-file', join(rawDir, 'keywords.json'), '--geo', region, '--time', '7d', '--rising-only', '--sleep-sec', '10', '--evidence', 'off', '--out', rawDir, '--session', session, '--keep-session']));
  result.stop = batch.stop;
  const hits = [];
  for (const row of batch.results) {
    result.scanned++; result[row.status]++;
    result.count429 += row.attempts.filter(a => a.status === 429).length;
    for (const r of row.rising.filter(r => qualifies(r.formattedValue))) {
      lines.push(`${row.keyword} | ${r.query} | ${r.formattedValue}`);
      hits.push({ seed: row.keyword, query: r.query, growth: r.formattedValue, vertical: seeds.find(s => s.seed === row.keyword)?.vertical, judgment: '待判断' });
    }
    lines.push(`种子状态 | ${row.keyword} | ${region} | ${row.status} | ${(row.reason || `Rising ${row.rising.length}条`).replace(/[\r\n|]/g, ' ')}`);
  }
  writeFileSync(`${base}.txt`, lines.join('\n') + '\n');
  if (opts['dry-run']) {
    const seen = json(seenPath), added = new Set();
    result.new = hits.filter(h => {
      const key = `${h.seed}\n${h.query}`;
      if (seen[h.seed]?.[h.query] || added.has(key)) return false;
      added.add(key); return true;
    });
  } else {
    const parsed = python('seed_report_parse.py', `${base}.txt`, ...(region === 'US' ? [] : [seenPath]));
    result.new = parsed.new.map(h => ({ ...h, vertical: seeds.find(s => s.seed === h.seed)?.vertical, judgment: '待判断' }));
    result.stats = parsed.stats;
    result.health = python('seed_health.py', '--region', region, `${base}.txt`);
  }
  if (!result.stop) for (const [index, item] of queue.entries()) {
    console.log(`追踪复查 ${item.term}`);
    const shape = compare(item.term, '3m', index);
    const volume = region === 'US' ? compare(item.term, '30d', index) : shape;
    const monthly = region === 'US' && volume.r !== null && volume.r !== undefined
      ? { lower: Math.round(volume.r * 5400 * .65), upper: volume.r >= 10 ? null : Math.round(volume.r * 5400 * 1.35) } : null;
    const anchorSource = region === 'US' ? { monthly: 5400, source: 'Semrush', date: '2026-09-09', refetched: false } : null;
    const unresolved = shape.unresolved || volume.unresolved;
    const check = { round, trend: unresolved ? '未知' : shape.trend || '缺测', peak_ratio: shape.peakRatio === null || shape.peakRatio === undefined ? '未知' : `峰值${Math.round(shape.peakRatio * 100)}%`,
      volume: volume.unresolved ? `r=未知（Trends 无法分辨）；月量未知（Trends 无法分辨）${region === 'US' ? '；锚点 5,400（Semrush 2026-09-09，未重取）' : ''}`
        : region === 'US' ? `${monthly === null ? '未知' : monthly.upper === null ? `≥ ${monthly.lower}/月（特大体量，仅下界）` : `估算${monthly.lower}–${monthly.upper}/月`}；锚点 5,400（Semrush 2026-09-09，未重取）`
        : `r=${volume.r ?? '未知'}（无当地锚点，不折月量）`,
      checked_at: new Date().toISOString(), status: shape.status, r: volume.r ?? null, anchorSource, evidence: shape.evidence, volume_evidence: volume.evidence };
    let consecutive = ['上升', '平稳'].includes(check.trend) ? 1 : 0;
    if (consecutive) for (const prior of [...(item.checks || [])].reverse()) {
      if (!['上升', '平稳'].includes(prior.trend)) break;
      consecutive++;
    }
    const candidate = consecutive >= 2 && monthly !== null && monthly.lower >= 2000;
    result.tracking.push({ term: item.term, ...check, monthlyEstimate: monthly, upgradeCandidate: candidate, candidateNote: candidate ? '满足升级条件候选（估算区间下界≥2000；不是已核实过线，量级/SERP/GEO仍须复核）' : monthly && monthly.lower < 2000 && monthly.upper >= 2000 ? '跨线，需复核' : '未满足已核实升级条件' });
    if (!opts['dry-run'] && !unresolved) {
      (item.checks ||= []).push(check);
      save(trackerPath, tracker);
    }
  }
} catch (e) {
  result.stop = String(e.stderr || e.message);
} finally {
  try { call('node', [gt, 'close', '--session', session]); }
  catch (e) { result.closeError = String(e.stderr || e.message); }
  result.elapsedMs = Date.now() - started.getTime();
  save(`${base}-result.json`, result);
  const reminder = must.length ? must.map(t => `- ${t.term}：${t.note || ''}；连续上升/平稳 ${t.consecutive_up || 0} 轮；最近证据 ${JSON.stringify(t.checks?.at(-1) || {})}；请人工推进。`).join('\n') : '本区暂无 must-do';
  const news = result.new.length ? '| 分组 | 种子 | 新词 | 涨幅 | 判断 |\n|---|---|---|---|---|\n' + result.new.map(h => `| ${h.vertical || ''} | ${h.seed} | ${h.query} | ${h.growth} | 待判断 |`).join('\n') : result.stop ? '扫描停止，无新增 Breakout/≥1000% 词；见停止原因' : '扫描完成，无新增 Breakout/≥1000% 词';
  const checks = result.tracking.map(t => `| ${t.term} | ${t.trend} | ${t.peak_ratio} | ${t.volume} | ${t.candidateNote} |`).join('\n');
  writeFileSync(`${base}-report.md`, `🔥 必做提醒\n\n${reminder}\n\n## 扫描结果\n\n${region}：扫描 ${result.scanned}，ok ${result.ok} / empty ${result.empty} / fail ${result.fail}；429 ${result.count429} 次；dry-run=${result.dryRun}。\n\n${news}\n\n## 健康台账\n\n${JSON.stringify(result.health || { note: result.dryRun ? 'dry-run，不写台账' : '未执行健康台账更新，见停止原因' })}\n\n## 追踪复查\n\n| 词 | 形状 | 当前/峰值 | 量级 | 提醒 |\n|---|---|---|---|---|\n${checks}\n\n停止原因：${result.stop || '无'}\n耗时：${(result.elapsedMs / 1000).toFixed(1)} 秒。\n原始产物：${rawDir}\n`);
  console.log(JSON.stringify({ result: `${base}-result.json`, report: `${base}-report.md`, scanned: result.scanned, ok: result.ok, empty: result.empty, fail: result.fail, new: result.new.length, count429: result.count429, tracking: result.tracking.length, stop: result.stop }));
}
if (result.stop) process.exitCode = 1;
