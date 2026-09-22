#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
/**
 * daemon-restart-safe.mjs — 重启守护进程，并确保浏览器桥真的回来了。
 *
 * 为什么不能直接 `opencli daemon restart`：
 *
 *   1. **它会打断所有在飞的浏览器命令。** 配额站上打断一个跑了一小时的采集，
 *      等于白烧一小时配额。所以先看有没有活儿在跑。
 *   2. **扩展不会自动重连。** 它是 MV3 的 service worker，Chrome 闲置约 30 秒就把它
 *      杀掉，靠事件唤醒；而守护进程断开**本身不是一个能唤醒它的事件**。
 *      实测 2026-08-28：重启后连续两次 restart 都没让它回来，扩展日志整整
 *      16 分钟一个字都没有，doctor 一直是 [MISSING] Extension: not connected。
 *      唤醒方法是给 Chrome 一个导航事件，实测 8 秒重连。
 *
 * 少了第 2 步的后果不是脚本报错，是它后面所有浏览器操作都跑在一个没有桥的
 * 守护进程上，每一条都失败——而失败原因看起来跟当时在测的东西有关。
 * 那次踩到时，一个本来该验证会话锁的测试报了 FAIL，其实跟锁毫无关系。
 *
 * 用法：
 *   node daemon-restart-safe.mjs                  # 有活儿在跑就拒绝重启
 *   node daemon-restart-safe.mjs --force          # 照样重启（会打断别人）
 *   node daemon-restart-safe.mjs --busy-pattern 'my-collector'
 */
import { execFileSync } from './lib-opencli-process.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
  console.log(await import('node:fs').then(({ readFileSync }) =>
    readFileSync(fileURLToPath(new URL(import.meta.url)), 'utf8')
      .match(/\/\*\*([\s\S]*?)\*\//)[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim()));
  process.exit(0);
}

const sh = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 60_000 }); }
  catch (error) { return String(error.stdout || '') + String(error.stderr || ''); }
};
const doctorOk = () => /\[OK\]\s+Extension/.test(sh('opencli', ['doctor']));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 有活儿在跑就别动
const busyPattern = val('--busy-pattern', 'tm[0-9]|sweep|semrush|similarweb|harvest|backlink/scripts');
const busy = sh('pgrep', ['-f', busyPattern]).trim();
if (busy && !has('--force')) {
  console.error('有浏览器任务在跑，拒绝重启（--force 可强行来，但会打断它们）：');
  console.error(sh('pgrep', ['-fl', busyPattern]).trim().split('\n').slice(0, 5).join('\n'));
  process.exit(2);
}

console.log('重启守护进程…');
console.log(sh('opencli', ['daemon', 'restart']).split('\n').filter((l) => /Daemon|⚠/.test(l)).join('\n'));

// 2) 等桥回来；不回来就唤醒 service worker
for (let round = 0; round < 3; round += 1) {
  for (let i = 0; i < 5; i += 1) {
    await sleep(3000);
    if (doctorOk()) { console.log('扩展已连接，doctor 绿。'); process.exit(0); }
  }
  // 再 restart 一次是没用的——重启的是守护进程，睡着的是扩展。
  console.log(`扩展仍未连接，唤醒 service worker（第 ${round + 1} 次）…`);
  sh('open', ['-g', '-a', 'Google Chrome', 'https://example.com']);  // -g 不抢焦点
}

console.error('扩展始终没连上。去 chrome://extensions 手动 reload 一次，或确认 Chrome 在跑。');
process.exit(1);
