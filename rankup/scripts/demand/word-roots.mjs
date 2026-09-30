#!/usr/bin/env node
/**
 * 用途：词根库。挖需求的起手式不是「想一个好点子」，而是**拿一个词根去数据平台漫游**——
 *       在 Ahrefs / Similarweb / Semrush / Google Trends 的关键词页输入一个词根，
 *       看它带出来的成千上万个长尾，再按 KD / 搜索量 / 意图筛。
 *       本脚本负责第一步：给出词根，并把词根按工具站常见形态扩展成可直接投喂的候选串。
 *
 * 数据：../../data/word-roots.json（51 条工具类词根 + 扩展模板）。
 *       来源是公开文章，见该文件的 source 字段。**纯词根，不含任何个人信息。**
 *
 * 示例：
 *   node word-roots.mjs list
 *   node word-roots.mjs list --grep gener --json
 *   node word-roots.mjs expand converter --seeds pdf,image,video
 *   node word-roots.mjs expand generator --seeds "qr code" --patterns x-root,online,free
 *   node word-roots.mjs expand converter --seeds pdf --target word --out cands.json
 *   node word-roots.mjs seeds            # 只把词根本身列成一行一个，喂给别的脚本
 *
 * 依赖：无（纯本地数据，不发任何请求）
 * 已验证日期：2026-08-23
 *
 * 已知坑：
 *   1. **扩展出来的是候选串，不是关键词。** 它们没有搜索量、没有难度，
 *      必须再过一遍 官方 gefei CLI 的 `keyword_difficulty` 或数据平台才算数。
 *      把扩展结果当成「我找到了 300 个词」是这条路上最常见的自欺。
 *   2. 不给 --seeds 时只能套用 bare 模板（词根本身），因为其余模板都需要一个主语。
 *      这不是限制，是提醒：光有词根不构成需求，词根 × 领域才构成需求。
 *   3. --target 只对 a-to-b 模板有意义（`X to Y converter`），不给就跳过该模板。
 */

import fs from 'node:fs';
import { parseArgs, emit, die, printTable } from './_lib.mjs';

const DATA = new URL('../../data/word-roots.json', import.meta.url);
let db;
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
catch (e) { die(`读不到词根库 ${DATA.pathname}：${e.message}`); }

const HELP = `词根库 —— 漫游找词的起点

用法: node word-roots.mjs <命令> [选项]

命令:
  list                   列出全部词根（含中文释义与原文给的常见搭配）
  seeds                  只输出词根本身，一行一个，方便管道喂给别的脚本
  expand <词根>          按工具站常见形态把词根扩展成候选串
  patterns               列出可用的扩展模板

list 选项:
  --grep <子串>          只保留词根或中文释义里含该子串的（不区分大小写）

expand 选项:
  --seeds <a,b,c>        主语列表，逗号分隔。不给就只能得到词根本身
  --target <词>          仅 a-to-b 模板用："{seed} to {target} {root}"
  --patterns <id,id>     只用指定模板，默认全部适用的模板（见 patterns 命令）
  --root-all             忽略位置参数，对库里**每一条**词根都做扩展（会很多）

通用: --json  --out <file>  --help

来源：${db.source?.url ?? '(未记录)'}
共 ${db.roots.length} 条词根、${db.patterns.length} 个模板。`;

function cmdList(args) {
  let rows = db.roots;
  if (args.grep) {
    const g = String(args.grep).toLowerCase();
    rows = rows.filter((r) => r.slug.includes(g) || r.zh.includes(args.grep) || (r.meaning || '').includes(args.grep));
  }
  emit(
    rows.map((r) => ({ 序号: r.index, 词根: r.root, 中文: r.zh, 常见搭配: r.collocations.join(' · ') })),
    args,
    [{ key: '序号', label: '#' }, { key: '词根', label: '词根', max: 14 }, { key: '中文', label: '中文', max: 12 }, { key: '常见搭配', label: '原文给的常见搭配', max: 60 }],
  );
}

function cmdSeeds() {
  for (const r of db.roots) console.log(r.slug);
}

function cmdPatterns(args) {
  emit(
    db.patterns.map((p) => ({ 模板: p.id, 形态: p.template, 例子: p.example })),
    args,
    [{ key: '模板', label: '模板 id' }, { key: '形态', label: '形态', max: 30 }, { key: '例子', label: '例子', max: 30 }],
  );
}

function expandOne(root, seeds, target, patterns) {
  const out = [];
  for (const p of patterns) {
    const needsSeed = p.template.includes('{seed}');
    const needsTarget = p.template.includes('{target}');
    if (needsTarget && !target) continue;
    const list = needsSeed ? seeds : [null];
    if (needsSeed && !seeds.length) continue;
    for (const s of list) {
      const q = p.template
        .replace('{root}', root.slug)
        .replace('{seed}', s ?? '')
        .replace('{target}', target ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      out.push({ 词根: root.root, 模板: p.id, 候选串: q, 主语: s ?? '' });
    }
  }
  return out;
}

function cmdExpand(args) {
  const seeds = args.seeds ? String(args.seeds).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const target = args.target ? String(args.target).trim() : null;
  const only = args.patterns ? new Set(String(args.patterns).split(',').map((s) => s.trim())) : null;
  const patterns = only ? db.patterns.filter((p) => only.has(p.id)) : db.patterns;
  if (only && !patterns.length) die(`--patterns 里没有一个是已知模板（用 patterns 命令看清单）`);

  let roots;
  if (args['root-all']) roots = db.roots;
  else {
    const name = args._[1];
    if (!name) die('expand 需要一个词根名，或者用 --root-all 对全库扩展');
    roots = db.roots.filter((r) => r.slug === String(name).toLowerCase());
    if (!roots.length) die(`词根库里没有「${name}」。用 list --grep ${name} 找找看。`);
  }

  const rows = roots.flatMap((r) => expandOne(r, seeds, target, patterns));
  if (!rows.length) {
    console.error('没有生成任何候选串：多数模板需要 --seeds。词根本身不构成需求，词根 × 领域才构成需求。');
  }
  emit(rows, args, [
    { key: '词根', label: '词根', max: 14 }, { key: '模板', label: '模板' },
    { key: '候选串', label: '候选串', max: 46 },
  ]);
  if (rows.length && !args.json) {
    console.error('提醒：这些只是候选串，没有搜索量也没有难度。下一步必须过一遍 KD/搜索量：');
    console.error('  node ~/.claude/skills/gefei/scripts/webcafe.mjs keyword_difficulty --keyword "<候选串>"');
  }
  void printTable;
}

const args = parseArgs();
const cmd = args._[0];
if (args.help || !cmd) { console.log(HELP); process.exit(0); }
const table = { list: cmdList, seeds: cmdSeeds, expand: cmdExpand, patterns: cmdPatterns };
if (!table[cmd]) die(`未知命令 ${cmd}（--help 看用法）`);
table[cmd](args);
