import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { snapshotGit, inspectGit } from './brief.mjs';
import { runsDir } from './progress.mjs';
import { SCOPE_LOCK } from './scope.mjs';

const REVIEW_REFERENCE = fileURLToPath(new URL('../skill/references/codex-coding.md', import.meta.url));

export function reviewPrompt() {
  const source = readFileSync(REVIEW_REFERENCE, 'utf8');
  const match = source.match(/## 可直接使用的 review 提示词\s+```text\n([\s\S]*?)\n```/);
  if (!match) throw new Error('找不到 codex-coding.md 中的 review 提示词');
  return match[1];
}

export function codexFallbackReason(error, log) {
  if (error?.code === 'ENOENT') return '找不到本机 codex';
  if (/login (?:expired|required)|not logged in|authentication (?:expired|required)|(?:access|refresh) token (?:expired|invalid|could not be refreshed)|please (?:log in|sign in)|sign in again|unauthorized/i.test(log)) return 'Codex 登录失效';
  if (/(?:model.{0,80}(?:not supported|unsupported|not available|does not exist|not found|无权限|不支持))|(?:unsupported model)/i.test(log)) return 'Codex 模型不支持';
  return null;
}

export async function runCode({ prompt, cwd = process.cwd(), low = false, review = false, codexBin = process.env.FLEET_CODEX_BIN || 'codex', onFallback }) {
  const workdir = resolve(cwd);
  const fullPrompt = review ? `${reviewPrompt()}\n\n${prompt}` : `${SCOPE_LOCK}\n\n${prompt}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(runsDir(), { recursive: true });
  const base = join(runsDir(), `${stamp}-codex`);
  const logPath = `${base}.log`;
  const resultPath = `${base}.result.md`;
  const before = snapshotGit(workdir);
  const startedAt = Date.now();
  const fd = openSync(logPath, 'w');
  // 非 review 运行使用 danger-full-access：用户要求 Codex 拥有最大权限（含网络/代理），workspace-write 会断网导致 AWS 等取数任务全部失败；review 保持 read-only 以维持 checker 只读边界。
  const args = ['exec', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', '-c', `model_reasoning_effort=${low ? 'low' : 'medium'}`, '--sandbox', review ? 'read-only' : 'danger-full-access', '-C', workdir, '-o', resultPath, '-'];
  let child;
  try {
    child = spawn(codexBin, args, { stdio: ['pipe', fd, fd] });
  } finally {
    closeSync(fd);
  }
  const outcome = await new Promise((done) => {
    child.once('error', (error) => done({ error }));
    child.once('close', (code, signal) => done({ code, signal }));
    child.stdin.on('error', () => {});
    child.stdin.end(fullPrompt);
  });
  const log = readFileSync(logPath, 'utf8');
  const reason = outcome.code === 0 ? null : codexFallbackReason(outcome.error, log);
  if (reason) {
    if (onFallback) return onFallback(reason, review ? fullPrompt : prompt); // 网关路径的系统提示已含范围锁
    return { fallbackReason: reason };
  }
  const result = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : '';
  if (!existsSync(resultPath)) writeFileSync(resultPath, '');
  const git = inspectGit(workdir, before);
  return {
    ok: outcome.code === 0 && Boolean(result.trim()),
    result,
    error: outcome.error?.message ?? (outcome.code === 0 ? (result.trim() ? null : 'Codex 没有写出结果') : `Codex 退出码 ${outcome.code ?? outcome.signal ?? '?'}`),
    durationMs: Date.now() - startedAt,
    model: 'gpt-6.1-sol',
    cwd: workdir,
    resultPath,
    logPath,
    ...git,
  };
}
