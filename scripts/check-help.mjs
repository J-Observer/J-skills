#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
/**
 * check-help.mjs —— 全仓脚本的 `--help` 体检：必须退出码 0，且要有输出。
 *
 * 【为什么这值得一个闸门】
 * 「`--help` 打印用法但退出码非零」这个毛病 2026-08-24 一天之内在两个 Skill 里
 * 各犯了一次，加起来 10 个脚本：
 *   rankup 侧 5 个——3 个把 `--help` 当未知参数抛异常，2 个打印用法后 exit 2
 *   backlink 侧 5 个——`--help` 一路走到必填校验，抛未捕获异常 + 一屏堆栈
 *
 * 它的后果不是「体验差一点」：任何 `set -e` 的批处理或 CI 扫过去，
 * 都会把这些**完全正常的脚本**判成坏了；而想看用法的人反而以为装挂了。
 * 两次都是人工偶然发现的，所以把它固化成机器判据。
 *
 * 判据只有两条，故意定得很松，避免变成风格警察：
 *   1. 退出码必须是 0（`--help` 是成功，不是用法错误）
 *   2. stdout 不能为空（打了个寂寞等于没有帮助）
 *
 * 用法：node scripts/check-help.mjs        （有不合格的就退出码 1）
 * 依赖：无。
 * 已验证日期：2026-08-24
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SELF = resolve(fileURLToPath(new URL(import.meta.url)));

/**
 * 库文件不是可执行入口，`--help` 对它们没有意义。
 *
 * **判据用结构而不是命名**：CLI 入口必然读 `process.argv`，库不读。
 * 一开始用的是命名约定（`_` 开头 / `lib-` 前缀 / 带 `-core`），
 * 结果 `webcafe-rsc.mjs`、`webcafe-transport.mjs` 这种纯库照样被当成 CLI 扫，
 * 报「退出码 0 但 stdout 是空的」——那是库的正常表现，不是缺陷。
 * 命名约定会随着新文件不断漏，读不读 argv 不会。
 */
const isLibraryByName = (name) => name.startsWith("_") || name.startsWith("lib-") || /-core\.mjs$/.test(name);
const isLibraryBySrc = (src) => !/process\.argv/.test(src);
// 两条并用：名字判据挡住 `_lib.mjs` 这种「提供 argv 解析工具、自己却不是入口」的库
//（它因为函数签名里写了 process.argv 而骗过结构判据）；
// 结构判据挡住命名上看不出是库的那些（webcafe-rsc / webcafe-transport）。

function collectScripts(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules" || name === "__pycache__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // tests / evals 不是给人跑的入口
      if (name === "tests" || name === "test" || name === "evals" || name === "archive") continue;
      collectScripts(p, out);
    } else if (/\.mjs$/.test(name)) {
      // 排除自己：否则它会递归调用自己，表现为整个体检卡死。
      if (p === SELF) continue;
      if (isLibraryByName(name)) continue;
      if (isLibraryBySrc(readFileSync(p, "utf8"))) continue;
      out.push(p);
    }
  }
  return out;
}

const targets = [];
for (const skill of readdirSync(ROOT)) {
  const scripts = join(ROOT, skill, "scripts");
  if (existsSync(scripts) && statSync(scripts).isDirectory()) collectScripts(scripts, targets);
}
collectScripts(join(ROOT, "scripts"), targets);

const bad = [];
for (const file of targets) {
  // 必须用 spawnSync + SIGKILL 硬超时，不能用 execFileSync：
  // 有脚本会派生子进程（opencli 之类），孙进程继承了 stdout，
  // 于是父进程即使早就退出，execFileSync 仍在等管道 EOF——表现为整个体检卡死，
  // 而不是某一个脚本失败。实测这会把一次 12 秒的检查拖成 2 分钟以上。
  const r = spawnSync("node", [file, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
    killSignal: "SIGKILL",
  });
  const rel = file.slice(ROOT.length + 1);
  const stdout = r.stdout || "";
  if (r.error && r.error.code === "ETIMEDOUT") {
    bad.push({ rel, why: "--help 10 秒没有返回（卡住了）——服务器/测试类脚本必须在启动前先处理 --help" });
    continue;
  }
  const code = typeof r.status === "number" ? r.status : 1;
  if (code !== 0) bad.push({ rel, why: `退出码 ${code}（--help 应该是 0）` });
  else if (!stdout.trim()) bad.push({ rel, why: "退出码 0 但 stdout 是空的" });
}

if (bad.length) {
  console.error(`✗ ${bad.length}/${targets.length} 个脚本的 --help 不合格：\n`);
  for (const b of bad) console.error(`  ${b.rel}\n    ${b.why}`);
  console.error(
    `\n修法：显式 --help 走 stdout 并 process.exit(0)；` +
      `\n什么参数都不给才是用法错误，那个仍然应该非零。`,
  );
  process.exit(1);
}

console.log(`✓ ${targets.length} 个脚本的 --help 全部退出码 0 且有输出`);
