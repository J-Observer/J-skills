import { pathToFileURL } from 'node:url';
/**
 * 任何驱动 Tools Share 的脚本，把错误文本放进输出前必须过 redactSecrets。
 *
 * 为什么需要这条检查：这条规则 2026-08-27 就以注释形式写在 semrush-report.mjs
 * 里了（「opencli 失败时会把带 __gmitm 令牌的会话 URL 打进 stderr」），
 * 而 semrush-keyword.mjs 依然把裸的 `error.message` 写进了 --out 的 JSONL。
 * 2026-08-28 实测抓到：那条 message 的内容确实就是 opencli 的 stderr 原文。
 *
 * **注释不是强制手段。** 一条只写在某个文件顶部的红线，管不住下一个文件。
 * 所以把它变成一条会红的检查——新脚本漏了会在这里停下，而不是在某次真实
 * 失败里把令牌写进日志之后才被发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/** 把错误文本放进一个会被序列化出去的字段里 —— 这才是要拦的形态。
 * 只是拿 message 做正则判断（`/xxx/.test(error.message)`）不产生输出，放行。 */
const EMITS_ERROR = /(?:error|message|reason)\s*:\s*(?:[^,\n]*\b)?(?:error\.message|String\(error\)|err\.message|error\.message \|\| error)/;

test('每个驱动 Tools Share 的脚本，输出错误文本前都过了 redactSecrets', async () => {
  const files = (await readdir(scriptsDir)).filter((f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const file of files) {
    const src = await readFile(join(scriptsDir, file), 'utf8');
    if (!src.includes('lib-tools-share.mjs')) continue; // 不碰共享会话的脚本不在范围内
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (code.trimStart().startsWith('*')) return;      // 注释块
      if (!EMITS_ERROR.test(code)) return;
      if (code.includes('redactSecrets')) return;
      offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `这些地方把未脱敏的错误文本写进了输出：\n${offenders.join('\n')}`);
});

test('redactSecrets 确实会抹掉 __gmitm 令牌（保留键名，只抹值）', async () => {
  const { redactSecrets } = await import(pathToFileURL(join(scriptsDir, 'lib-tools-share.mjs')).href);
  const dirty = 'failed to open https://sem.example/app?__gmitm=SECRETVALUE123&db=us';
  const clean = redactSecrets(dirty);
  assert.ok(!clean.includes('SECRETVALUE123'), '令牌值必须被抹掉');
  assert.ok(clean.includes('__gmitm=<redacted>'), '键名保留，便于排查是哪一类泄漏');
  assert.ok(clean.includes('db=us'), '不相关的参数不该被误伤');
});
