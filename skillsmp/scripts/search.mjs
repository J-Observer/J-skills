#!/usr/bin/env node
// SkillsMP 搜索客户端。可翻页、可过滤、可输出表格或 JSON。
//
// 【凭据】
// API Key 从环境变量 `SKILLSMP_API_KEY` 读，或本 Skill 根目录的 `.env`。
// **没有 Key 也能跑**——匿名 50 次/天、10 次/分钟，带 Key 是 500/天、30/分钟。
// 所以这个脚本对没配 Key 的人不报错，只是配额低。Key 绝不进仓库。
//
// 【翻页要认 hasNext，不要认 total】
// 响应里的 `pagination.total` 带一个 `totalIsExact: false`，而且实测严重偏低
// （百万级索引里搜 SEO 只报 total=5）。**按 total 算页数会漏掉绝大部分结果。**
// 唯一可靠的翻页依据是 `hasNext`。
//
// 用法：
//   node scripts/search.mjs "keyword" [--pages 3] [--limit 50] [--sort stars|recent]
//     [--category <slug>] [--occupation <slug>] [--lang en|zh|ja|mul|und] [--json]

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
// 本文件是不是被直接执行的那一个。**help 守卫必须先问这一句**：
// 2026-08-30 实测，treasure.mjs `import` 本文件时，ESM 的 import 提升让这段
// 顶层代码抢在 treasure 自己的 help 守卫之前跑完——于是
// `treasure.mjs --help` 打印的是 search.mjs 的帮助并 exit 0，
// treasure 自己的帮助永远到不了用户眼前，而 check-help 因为「退出码 0 且有输出」
// 判它绿灯。被 import 时这段必须整段沉默。
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch { return false; }
})();

// `--help` 是成功，不是用法错误。放在最前面：本文件在任何参数解析之前
// 就会开工（起服务 / 读文件 / 校验必填），走到那里再判就已经晚了。
// 帮助文案直接取本文件头部注释，不另写一份——两份必然漂移。
if (invokedDirectly && process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  const src = readFileSync(fileURLToPath(new URL(import.meta.url)), 'utf8');
  const block = src.match(/\/\*\*([\s\S]*?)\*\//)
    ? src.match(/\/\*\*([\s\S]*?)\*\//)[1].split('\n').map((l) => l.replace(/^\s*\* ?/, ''))
    : src.split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, ''));
  console.log(block.join('\n').trim());
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));

export async function apiKey() {
  if (process.env.SKILLSMP_API_KEY) return process.env.SKILLSMP_API_KEY;
  try {
    const env = await readFile(join(HERE, '..', '.env'), 'utf8');
    const m = env.match(/^\s*SKILLSMP_API_KEY\s*=\s*(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

const ERRORS = {
  INVALID_API_KEY: 'API Key 无效。检查 .env 里的 SKILLSMP_API_KEY，或删掉它改用匿名配额。',
  MISSING_QUERY: '缺少 q 参数——这个 API 不支持空查询，也不支持通配符 `*`。',
  INVALID_OCCUPATION: '职业 slug 不认识。可用值见 skillsmp.com/docs/api。',
  INVALID_LANGUAGE: '语言代码不认识。用 en / zh / ja 这类 ISO 码，mul=混合，und=判不出。',
  DAILY_QUOTA_EXCEEDED: '当日配额用完了。匿名 50/天，带 Key 500/天——响应头 x-ratelimit-daily-remaining 一直在报剩余量。',
};

export async function search(q, opts = {}) {
  const key = opts.key ?? await apiKey();
  const url = new URL('https://skillsmp.com/api/v1/skills/search');
  url.searchParams.set('q', q);
  if (opts.page) url.searchParams.set('page', String(opts.page));
  if (opts.limit) url.searchParams.set('limit', String(Math.min(opts.limit, 100)));
  if (opts.sortBy) url.searchParams.set('sortBy', opts.sortBy);
  if (opts.category) url.searchParams.set('category', opts.category);
  if (opts.occupation) url.searchParams.set('occupation', opts.occupation);
  if (opts.language) url.searchParams.set('language', opts.language);

  const r = await fetch(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.success) {
    const code = body?.error?.code || `HTTP_${r.status}`;
    const e = new Error(ERRORS[code] || body?.error?.message || `请求失败：${code}`);
    e.code = code;
    throw e;
  }
  return {
    skills: body.data.skills || [],
    pagination: body.data.pagination || {},
    quota: {
      dailyRemaining: r.headers.get('x-ratelimit-daily-remaining'),
      dailyLimit: r.headers.get('x-ratelimit-daily-limit'),
    },
    anonymous: !key,
  };
}

// 连续翻页。**停止条件是 hasNext，不是 total。**
export async function searchAll(q, { pages = 1, ...opts } = {}) {
  const out = []; let quota = null, anonymous = false;
  for (let p = 1; p <= pages; p += 1) {
    const r = await search(q, { ...opts, page: p });
    out.push(...r.skills);
    quota = r.quota; anonymous = r.anonymous;
    if (!r.pagination.hasNext) break;
    if (p < pages) await new Promise((s) => setTimeout(s, 2_200)); // 匿名 10 次/分钟，留余量
  }
  return { skills: out, quota, anonymous };
}

// 与文件顶部 help 守卫用的是同一个判断（那里必须早于 import 提升，所以先算了一次）。
const isMain = invokedDirectly;

if (isMain) {
  const argv = process.argv.slice(2);
  const q = argv.find((a) => !a.startsWith('--'));
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const n = argv[i + 1];
    if (n && !n.startsWith('--')) { flags[argv[i].slice(2)] = n; i += 1; } else flags[argv[i].slice(2)] = true;
  }
  if (!q) { process.stderr.write('用法：node scripts/search.mjs "keyword" [--pages N] [--limit N] [--sort stars|recent] [--category s] [--occupation s] [--lang xx] [--json]\n'); process.exit(1); }

  try {
    const r = await searchAll(q, {
      pages: Number(flags.pages || 1), limit: Number(flags.limit || 20),
      sortBy: flags.sort, category: flags.category, occupation: flags.occupation, language: flags.lang,
    });
    if (flags.json) { process.stdout.write(JSON.stringify(r, null, 1) + '\n'); }
    else {
      for (const s of r.skills) {
        const age = s.updatedAt ? new Date(s.updatedAt * 1000).toISOString().slice(0, 10) : '?';
        process.stdout.write(`${String(s.stars ?? '?').padStart(7)}★ ${age}  ${s.author}/${s.name}  [${s.contentLanguage}]\n`);
        process.stdout.write(`         ${(s.description || '').replace(/\s+/g, ' ').slice(0, 150)}\n`);
        process.stdout.write(`         ${s.githubUrl}\n`);
      }
      process.stdout.write(`\n${r.skills.length} 条${r.anonymous ? '（匿名配额）' : ''}；今日剩余 ${r.quota?.dailyRemaining ?? '?'}/${r.quota?.dailyLimit ?? '?'}\n`);
      process.stdout.write('注意：★ 是**所在仓库**的星数，不是这个 Skill 的。见 SKILL.md。\n');
    }
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
