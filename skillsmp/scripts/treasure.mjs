#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
// 挖「叫好不叫卖」的 Skill：**故意不按星数排**，因为星数在这个索引里根本不是质量信号。
//
// 【为什么星数会误导，这是实测的】
// API 返回的 `stars` 是**所在 GitHub 仓库**的星数，不是这个 Skill 的。
// 实测 `affaan-m/ECC` 报 240467，与该仓库真实星数 240743 对得上——所以确认无疑。
// 后果：一个塞在超高星仓库里的 Skill 自动继承那个星数，
// 而一个作者单独开仓库、认真写的 Skill 只有 3 颗星。
// 实测搜 `backlink` 按星排序，前四条有三条来自同一个 28562★ 的笔记仓库，
// 讲的是笔记内部的双链，跟外链毫无关系。**高星把语义对口的结果淹掉了。**
//
// 【所以按什么排】
// 用四个跟仓库名气无关的信号，全部可从搜索结果本身算出，不额外花配额：
//   1. 独立性     —— 所在仓库星数越低，越说明这个 Skill 是靠自己站住的，不是搭便车。
//   2. 专注度     —— 同一仓库在本次结果里贡献了多少条。一个仓库刷出几十条通常是
//                    批量生成或整包翻译的文档堆，不是有人认真写了几十个 Skill。
//   3. 描述具体度 —— 好的 SKILL.md 描述会写清**什么时候该用它**（触发条件、场景、
//                    反例），而不是一句「帮你做 X」。这是最能分辨用心与否的单一信号。
//   4. 新鲜度     —— 长期没动的多半已经烂掉。
//
// 这些是**启发式排序，不是判决**，而且第三波（2026-08-30）把这句话落实到了输出上：
//
//   1. **不丢候选。** `--max-stars` 以前有个 5000 的默认值，会在你没要求的情况下
//      悄悄滤掉一批行——「搜出来就这些」和「搜出来一批但被脚本扔了」看起来一模一样。
//      现在**默认不过滤**；给了 `--max-stars` 也只是把超标的行折叠出默认视图，
//      并明说折叠了几条，`--json` 里它们照样在，带 `aboveMaxStars: true`。
//   2. **原始信号照给。** 每条候选带 `signals`（stars / repoCount / descLength /
//      hasTriggerWording / ageDays），这些是可核对的观测值。`sortKey` 是这四项
//      压成的一个排序用数字，**只是排序键**，不是评分、不是质量结论——
//      `--sort stars|updated|none` 随时换一个排法，或者干脆不排。
//   3. 排在第一不代表最好。读 SKILL.md 仍然要你自己做。
//
// 用法：
//   node scripts/treasure.mjs "keyword" [--pages 5] [--lang zh] [--max-stars 2000]
//                                       [--top 15] [--sort key|stars|updated|none] [--json]

import { searchAll } from './search.mjs';
import { readFileSync } from 'node:fs';
// `--help` 是成功，不是用法错误。放在最前面：本文件在任何参数解析之前
// 就会开工（起服务 / 读文件 / 校验必填），走到那里再判就已经晚了。
// 帮助文案直接取本文件头部注释，不另写一份——两份必然漂移。
if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  const src = readFileSync(fileURLToPath(new URL(import.meta.url)), 'utf8');
  const block = src.match(/\/\*\*([\s\S]*?)\*\//)
    ? src.match(/\/\*\*([\s\S]*?)\*\//)[1].split('\n').map((l) => l.replace(/^\s*\* ?/, ''))
    : src.split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, ''));
  console.log(block.join('\n').trim());
  process.exit(0);
}

const argv = process.argv.slice(2);
const q = argv.find((a) => !a.startsWith('--'));
const flags = {};
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue;
  const n = argv[i + 1];
  if (n && !n.startsWith('--')) { flags[argv[i].slice(2)] = n; i += 1; } else flags[argv[i].slice(2)] = true;
}
if (!q) { process.stderr.write('用法：node scripts/treasure.mjs "keyword" [--pages N] [--lang xx] [--max-stars N] [--top N] [--sort key|stars|updated|none] [--json]\n'); process.exit(1); }

// **没有默认值。** 以前这里是 `flags['max-stars'] || 5000`，一个没人要求过的
// 阈值在静默地扔行；「搜出来就这些」和「被扔了一半」在输出上完全同形。
const maxStars = flags['max-stars'] === undefined ? null : Number(flags['max-stars']);
if (maxStars !== null && !Number.isFinite(maxStars)) {
  process.stderr.write('--max-stars 需要一个数字\n'); process.exit(1);
}
const top = Number(flags.top || 15);
const SORTS = { key: 'sortKey', stars: 'stars', updated: 'updatedAt', none: null };
const sortBy = flags.sort === undefined ? 'key' : String(flags.sort);
if (!(sortBy in SORTS)) {
  process.stderr.write(`--sort 只认 ${Object.keys(SORTS).join(' / ')}\n`); process.exit(1);
}

// 描述里出现这些，说明作者写清了「什么时候用」——SKILL.md 的描述字段本来就是给
// 模型做路由判断用的，写得具体的人通常整个 Skill 都写得具体。
const SPECIFIC = /\buse (this )?when\b|\btrigger\b|\bfor example\b|\bdo not use\b|\bnot for\b|什么时候|使用场景|触发|适用于|不适用/i;

/**
 * 原始信号——**可核对的观测值**，每一项都能回到搜索结果里对照。
 * 这些才是输出的主体；下面的 sortKey 只是把它们压成一个排序用的数。
 */
function signalsOf(s, repoCount) {
  const desc = (s.description || '').replace(/\s+/g, ' ').trim();
  return {
    stars: s.stars ?? null,                       // 所在仓库的星数，不是这个 Skill 的（见文件头）
    repoCount,                                    // 同一仓库在本次结果里贡献了几条
    descLength: desc.length,
    hasTriggerWording: SPECIFIC.test(desc),       // 描述里写没写「什么时候该用」
    updatedAt: s.updatedAt ?? null,
    ageDays: s.updatedAt ? Math.round((Date.now() / 1000 - s.updatedAt) / 86400) : null,
  };
}

/**
 * 把四个信号压成一个数，**只用来排序**。它不是评分，不是质量结论，
 * 也不该被写进任何报告里当证据——权重是随手定的，没有实测支撑。
 * 换个排法（`--sort stars|updated|none`）看到的仍然是同一批候选。
 */
function sortKeyOf(g) {
  const parts = {
    // 星数越低越加分，但 0 星不额外奖励——0 星也可能是刚推上去还没人看过的空壳。
    independence: Math.max(0, 30 - Math.log10((g.stars || 0) + 10) * 6),
    focus: g.repoCount === 1 ? 25 : Math.max(0, 25 - (g.repoCount - 1) * 5),
    specificity: (g.hasTriggerWording ? 20 : 0) + Math.min(15, Math.floor(g.descLength / 40)),
    freshness: g.ageDays === null ? 0 : g.ageDays < 90 ? 15 : g.ageDays < 365 ? 8 : 0,
  };
  return { sortKey: Math.round(Object.values(parts).reduce((a, b) => a + b, 0)), sortKeyParts: parts };
}

try {
  const r = await searchAll(q, { pages: Number(flags.pages || 5), limit: 100, language: flags.lang });

  const byRepo = new Map();
  for (const s of r.skills) {
    const repo = (s.githubUrl || '').split('/tree/')[0];
    byRepo.set(repo, (byRepo.get(repo) || 0) + 1);
  }

  // 同名同作者跨多语言 = 整包机翻的文档堆，只留一条，否则一个仓库能刷满整页。
  // **去重是唯一会减少候选数的一步，而且减了多少要报出来。**
  const seen = new Set();
  let deduped = 0;
  const candidates = r.skills
    .filter((s) => {
      const k = `${s.author}/${s.name}`;
      if (seen.has(k)) { deduped += 1; return false; }
      seen.add(k); return true;
    })
    .map((s) => {
      const repoCount = byRepo.get((s.githubUrl || '').split('/tree/')[0]) || 1;
      const signals = signalsOf(s, repoCount);
      return {
        ...s,
        repoCount,
        signals,
        ...sortKeyOf(signals),
        // 过滤器只**标记**，不删行。超标的行在 --json 里照样在。
        aboveMaxStars: maxStars !== null && (s.stars ?? 0) > maxStars,
      };
    });

  const sortField = SORTS[sortBy];
  const sorted = sortField === null ? candidates
    : [...candidates].sort((a, b) => (b[sortField] ?? -Infinity) - (a[sortField] ?? -Infinity));
  const hidden = sorted.filter((s) => s.aboveMaxStars);
  const shown = sorted.filter((s) => !s.aboveMaxStars).slice(0, top);

  if (flags.json) {
    // JSON 出**全量候选**，一条不少：过滤是 aboveMaxStars 这个标记，不是删除。
    process.stdout.write(JSON.stringify({
      query: q,
      scanned: r.skills.length,
      dedupedAway: deduped,
      candidates: candidates.length,
      maxStars,
      aboveMaxStars: hidden.length,
      sortedBy: sortBy,
      note: 'sortKey 只是排序键，不是评分也不是质量判断；signals 才是可核对的观测值。'
        + 'aboveMaxStars 的行没有被删除，只是不进默认视图。',
      shown: shown.map((s) => s.githubUrl),
      candidateList: candidates,
    }, null, 1) + '\n');
  } else {
    process.stdout.write(
      `扫了 ${r.skills.length} 条，同名同作者去重掉 ${deduped} 条，剩 ${candidates.length} 条候选`
      + `${maxStars === null ? '（未设 --max-stars，没有任何行被过滤）' : `，其中 ${hidden.length} 条 >${maxStars}★ 折叠出默认视图（--json 里仍在）`}`
      + `；按 ${sortBy} 排，显示前 ${shown.length} 条\n\n`);
    for (const s of shown) {
      const age = s.updatedAt ? new Date(s.updatedAt * 1000).toISOString().slice(0, 10) : '?';
      process.stdout.write(`[排序键 ${String(s.sortKey).padStart(2)}] ${s.author}/${s.name}  ${s.stars}★  ${age}  [${s.contentLanguage}]  该仓库贡献 ${s.repoCount} 条\n`);
      process.stdout.write(`     ${(s.description || '').replace(/\s+/g, ' ').slice(0, 160)}\n`);
      process.stdout.write(`     ${s.githubUrl}\n\n`);
    }
    if (hidden.length) {
      process.stdout.write(`被 --max-stars ${maxStars} 折叠的 ${hidden.length} 条（没有被丢弃，加 --json 或抬高阈值可见）：\n`);
      for (const s of hidden.slice(0, 10)) process.stdout.write(`     ${s.author}/${s.name}  ${s.stars}★  ${s.githubUrl}\n`);
      if (hidden.length > 10) process.stdout.write(`     …还有 ${hidden.length - 10} 条\n`);
      process.stdout.write('\n');
    }
    process.stdout.write('「排序键」是四个信号压出来的一个排序用数字，**不是评分、不是判决**——\n');
    process.stdout.write('换 --sort stars/updated/none 看到的是同一批候选，只是顺序不同。\n');
    process.stdout.write('真正决定要不要用，仍然得打开 SKILL.md 读一遍。\n');
    process.stdout.write(`今日剩余配额 ${r.quota?.dailyRemaining ?? '?'}/${r.quota?.dailyLimit ?? '?'}${r.anonymous ? '（匿名）' : ''}\n`);
  }
} catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
