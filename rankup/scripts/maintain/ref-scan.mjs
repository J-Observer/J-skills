#!/usr/bin/env node
// ref-scan.mjs —— 全量扫描：给一组术语 / 脚本名 / 路径 / 阈值，列出它们在 Skill 与项目记录里的全部出现位置。
//
//   node scripts/maintain/ref-scan.mjs <词或路径> [更多…] [--rankup <项目>/.rankup]… [--regex] [--no-skill] [--json]
//
// 用途：「维护」章节（references/maintenance.md「二、收尾维护」第 ① 步）的执行工具。
// 改了一个术语、脚本名、路径、阈值或结论后，旧说法常常还躺在 experiences、checklists、
// 路由表、README、旧 journal、根层登记表这些角落里；凭回忆找一定漏。本脚本把「找全」变成
// 一条命令：先扫一次拿到清单逐处改，改完再扫一次确认只剩有意保留的命中。
//
// 扫描范围：
//   - 默认包含本 Skill 全目录（.md .mjs .js .json .py .sh .txt），并附带仓库根的 README.md（若存在）；
//     跳过 node_modules、.git 与 Skill 自己的 .rankup/。
//   - 每个 --rankup <目录> 追加一个项目或工作区根层的 .rankup/（含 journal/、research/、portfolio.md、projects.json）。
//   - --no-skill 只扫 --rankup 给的目录。
// 匹配：默认按字面子串、忽略大小写；--regex 时每个参数当正则（忽略大小写）。
// 输出：按文件分组的 `行号: 摘录`，以及每个词的命中总数；--json 输出结构化结果。
// 退出码：0 正常（有无命中都算正常）；2 参数或扫描路径错误。只读，不改任何文件。
// 已验证：2026-09-30 在本 Skill 与一个项目 .rankup 副本上运行。

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEXT = /\.(?:md|mjs|js|cjs|json|py|sh|txt|ya?ml)$/i;

function parseArgs(argv) {
  const opts = { terms: [], rankup: [], regex: false, skill: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rankup") opts.rankup.push(path.resolve(argv[++i] ?? ""));
    else if (a === "--regex") opts.regex = true;
    else if (a === "--no-skill") opts.skill = false;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--")) throw new Error(`未知参数：${a}`);
    else opts.terms.push(a);
  }
  if (!opts.help && !opts.terms.length) throw new Error("至少给一个要扫描的词或路径");
  return opts;
}

async function walk(dir, { skipRankup }) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    if (skipRankup && e.name === ".rankup") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, { skipRankup })));
    else if (TEXT.test(e.name)) out.push(p);
  }
  return out;
}

export async function scan({ terms, rankup = [], regex = false, skill = true }) {
  const matchers = terms.map((t) => ({
    term: t,
    re: new RegExp(regex ? t : t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
  }));
  const roots = [];
  if (skill) {
    roots.push({ label: "skill", dir: skillRoot, skipRankup: true });
    const readme = path.join(skillRoot, "..", "README.md");
    try {
      if ((await stat(readme)).isFile()) roots.push({ label: "repo", file: readme });
    } catch {}
  }
  for (const dir of rankup) roots.push({ label: "rankup", dir, skipRankup: false });

  const hits = [];
  const counts = Object.fromEntries(terms.map((t) => [t, 0]));
  for (const root of roots) {
    const files = root.file ? [root.file] : await walk(root.dir, { skipRankup: root.skipRankup });
    for (const file of files) {
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        const matched = matchers.filter((m) => m.re.test(line)).map((m) => m.term);
        if (!matched.length) return;
        for (const t of matched) counts[t]++;
        const base = root.file ? path.dirname(root.file) : root.dir;
        hits.push({
          scope: root.label,
          file: root.label === "rankup" ? path.join(path.basename(path.dirname(root.dir)) || ".", path.relative(path.dirname(root.dir), file)) : path.relative(root.label === "repo" ? path.join(skillRoot, "..") : base, file),
          line: idx + 1,
          terms: matched,
          text: line.trim().slice(0, 160),
        });
      });
    }
  }
  return { terms, counts, hits };
}

function render({ counts, hits }) {
  const out = [];
  let current = null;
  for (const h of hits) {
    const key = `[${h.scope}] ${h.file}`;
    if (key !== current) {
      out.push(`\n${key}`);
      current = key;
    }
    out.push(`  ${h.line}: ${h.text}`);
  }
  out.push("\n命中统计：");
  for (const [t, n] of Object.entries(counts)) out.push(`  ${t}：${n} 行`);
  return out.join("\n");
}

if (process.argv[1]?.endsWith("ref-scan.mjs")) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error("用法：node scripts/maintain/ref-scan.mjs <词或路径…> [--rankup <目录>]… [--regex] [--no-skill] [--json]");
    process.exit(2);
  }
  if (opts.help) {
    console.log("用法：node scripts/maintain/ref-scan.mjs <词或路径…> [--rankup <目录>]… [--regex] [--no-skill] [--json]");
    process.exit(0);
  }
  try {
    const result = await scan(opts);
    console.log(opts.json ? JSON.stringify(result, null, 2) : render(result));
  } catch (e) {
    console.error(`扫描失败：${e.message}`);
    process.exit(2);
  }
}
