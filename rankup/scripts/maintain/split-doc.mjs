#!/usr/bin/env node
// split-doc.mjs —— 按计划把一个超标 Markdown 拆成主文件 + 若干子文件，并自动修链接与锚点。
//
//   node scripts/maintain/split-doc.mjs <plan.json> [--root <Skill 目录>] [--dry-run]
//
// 用途：「维护」章节（references/maintenance.md）里「单文件超标就拆」的执行工具。
// 手工拆分最常见的事故是：入站链接和 `文件.md#锚点` 静默失效、搬走的段落里 `../x.md`
// 相对路径错位、漏搬几行。本脚本把这三件事变成机械步骤：
//   1. 按计划组装主文件与子文件（块 = 原文件行区间 或 字面文本）；
//   2. 断言原文件每一行恰好被用一次（显式 drop 的除外），否则拒绝写入；
//   3. 重写被搬走内容里的相对链接（按新位置重新计算相对路径；同文件锚点指向新位置）；
//   4. 扫描根目录下全部 Markdown，把指向原文件、但锚点已搬走的链接改指新文件。
// 计划文件格式（行号 1 起、闭区间）：
//   { "src": "references/x.md",
//     "compose": [ {"lines":[1,80]}, {"text":"## 某节\n\n见 [x-a.md](x/a.md)。\n"} ],
//     "parts": [ { "dest": "references/x/a.md",
//                  "compose": [ {"text":"# 标题\n\n"}, {"lines":[81,200]} ] } ],
//     "drop": [[201,203]] }
// 拆完必须跑 `node scripts/maintain/doc-lint.mjs` 确认断链为 0。
// 已验证：2026-09-30 用于拆分 lifecycle / provider-capabilities / demand-sources 等 9 个文件。

import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anchorsOf, linksOf, slugify, stripFences } from "./doc-lint.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function headingAnchorsByLine(lines) {
  // 与 doc-lint.anchorsOf 同一规则，额外记下每个锚点所在行号。
  const seen = new Map();
  const map = new Map();
  stripFences(lines.join("\n")).forEach((line, idx) => {
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) return;
    const base = slugify(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    map.set(n === 0 ? base : `${base}-${n}`, idx + 1);
  });
  return map;
}

const rel = (fromFile, toFile) => {
  const r = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  return r || path.basename(toFile);
};

function rewriteLinks(text, { oldFile, newFile, anchorHome }) {
  // anchorHome(anchor) → 该锚点现在所在文件的绝对路径（仅对 oldFile 的锚点有效）
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) return line;
      return line.replace(/(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (all, pre, target, post) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return all;
        const [p, anchor] = target.split("#");
        const abs = p ? path.resolve(path.dirname(oldFile), decodeURIComponent(p)) : oldFile;
        let dest = abs;
        if (abs === oldFile && anchor !== undefined) dest = anchorHome(anchor) ?? abs;
        let out;
        if (dest === newFile) out = anchor !== undefined ? `#${anchor}` : rel(newFile, dest);
        else out = rel(newFile, dest) + (anchor !== undefined ? `#${anchor}` : "");
        return `${pre}${out}${post}`;
      });
    })
    .join("\n");
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".rankup"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

export async function split(plan, { root = skillRoot, dryRun = false, force = false } = {}) {
  const srcAbs = path.resolve(root, plan.src);
  const srcLines = (await readFile(srcAbs, "utf8")).split("\n");
  const used = new Array(srcLines.length + 1).fill(0);
  const targets = [{ file: srcAbs, compose: plan.compose }, ...plan.parts.map((p) => ({ file: path.resolve(root, p.dest), compose: p.compose }))];
  const destinations = new Set();
  for (const { file } of targets) {
    if (destinations.has(file)) throw new Error(`重复目标路径（含源文件）：${file}`);
    destinations.add(file);
    if (file !== srcAbs && !force && await stat(file).catch((e) => { if (e.code !== "ENOENT") throw e; return null; })) throw new Error(`子文件已存在：${file}；显式 --force 才可覆盖`);
  }
  const lineHome = new Array(srcLines.length + 1).fill(null);
  for (const t of targets) {
    for (const block of t.compose) {
      if (!block.lines) continue;
      const [a, b] = block.lines;
      if (!(a >= 1 && b >= a && b <= srcLines.length)) throw new Error(`${t.file}: 非法区间 ${a}-${b}`);
      for (let i = a; i <= b; i++) {
        used[i]++;
        lineHome[i] = t.file;
      }
    }
  }
  for (const [a, b] of plan.drop ?? []) for (let i = a; i <= b; i++) used[i]++;
  const problems = [];
  for (let i = 1; i <= srcLines.length; i++) {
    if (used[i] !== 1 && !(i === srcLines.length && srcLines[i - 1] === "")) problems.push(`第 ${i} 行被使用 ${used[i]} 次`);
  }
  if (problems.length) throw new Error(`行覆盖不完整：\n${problems.slice(0, 20).join("\n")}`);

  const anchorLine = headingAnchorsByLine(srcLines);
  const anchorHome = (anchor) => {
    let a;
    try {
      a = decodeURIComponent(anchor).toLowerCase();
    } catch {
      a = anchor.toLowerCase();
    }
    const line = anchorLine.get(a);
    return line ? lineHome[line] : null;
  };

  const outputs = new Map();
  for (const t of targets) {
    let text = "";
    for (const block of t.compose) {
      if (block.text !== undefined) text += block.text;
      else {
        const [a, b] = block.lines;
        const chunk = srcLines.slice(a - 1, b).join("\n") + "\n";
        text += t.file === srcAbs ? rewriteLinks(chunk, { oldFile: srcAbs, newFile: srcAbs, anchorHome }) : rewriteLinks(chunk, { oldFile: srcAbs, newFile: t.file, anchorHome });
      }
    }
    outputs.set(t.file, text.replace(/\n{3,}/g, "\n\n"));
  }

  // 其余文件里指向 src#搬走锚点 的链接改指新家
  const inbound = [];
  for (const file of await walk(root)) {
    if (outputs.has(file)) continue;
    const text = await readFile(file, "utf8");
    let changed = false;
    const next = text
      .split("\n")
      .map((line) =>
        line.replace(/(!?\[[^\]]*\]\()([^)\s#]+)#([^)\s]+)((?:\s+"[^"]*")?\))/g, (all, pre, p, anchor, post) => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return all;
          let abs;
          try {
            abs = path.resolve(path.dirname(file), decodeURIComponent(p));
          } catch {
            return all;
          }
          if (abs !== srcAbs) return all;
          const home = anchorHome(anchor);
          if (!home || home === srcAbs) return all;
          changed = true;
          inbound.push(`${path.relative(root, file)} → ${path.relative(root, home)}#${anchor}`);
          return `${pre}${rel(file, home)}#${anchor}${post}`;
        }),
      )
      .join("\n");
    if (changed) outputs.set(file, next);
  }

  if (!dryRun) {
    await copyFile(srcAbs, `${srcAbs}.orig`, 1);
    for (const [file, text] of outputs) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
  }
  return {
    src: plan.src,
    written: [...outputs.keys()].map((f) => `${path.relative(root, f)} (${outputs.get(f).split("\n").length} 行)`),
    inbound,
  };
}

if (process.argv[1]?.endsWith("split-doc.mjs")) {
  const args = process.argv.slice(2);
  const planPath = args.find((a) => !a.startsWith("--"));
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : skillRoot;
  if (args.includes("--help") || args.includes("-h") || !planPath) {
    console.error("用法：node scripts/maintain/split-doc.mjs <plan.json> [--root <Skill 目录>] [--dry-run] [--force]（写入前保留源文件 .orig）");
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 2);
  }
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const plans = Array.isArray(plan) ? plan : [plan];
  for (const p of plans) {
    const r = await split(p, { root, dryRun: args.includes("--dry-run"), force: args.includes("--force") });
    console.log(`拆分 ${r.src}：`);
    for (const w of r.written) console.log(`  写入 ${w}`);
    for (const i of r.inbound) console.log(`  入站链接改指 ${i}`);
  }
}

export { anchorsOf, linksOf };
