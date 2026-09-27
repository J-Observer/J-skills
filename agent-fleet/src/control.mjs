// status / say / stop 的控制面。只按 pid.json 里的 pid 操作,绝不 pkill/killall。

import { appendInbox } from './inbox.mjs';
import {
  assertSafeToSignal,
  isPidAlive,
  listAllPidRecords,
  patchPidRecord,
  readPidRecord,
  resolveRunId,
  sameCwd,
  signalProcessTree,
} from './pid.mjs';

function formatDuration(startedAt) {
  const t = Date.parse(startedAt ?? '');
  if (!Number.isFinite(t)) return '?';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s}s`;
}

export function collectStatus({ cwd } = {}) {
  const rows = [];
  for (const rec of listAllPidRecords()) {
    if (cwd && !sameCwd(rec.cwd, cwd)) continue;
    const alive = isPidAlive(rec.pid);
    if (rec.finished && !alive) continue;
    let state = 'running';
    if (!alive && !rec.finished) state = 'abnormal';
    else if (rec.finished && alive) state = 'running';
    rows.push({
      runId: rec.runId,
      model: rec.model ?? '?',
      pid: rec.pid,
      cwd: rec.cwd ?? '',
      startedAt: rec.startedAt ?? null,
      duration: formatDuration(rec.startedAt),
      state,
      logPath: rec.logPath ?? null,
    });
  }
  rows.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  return rows;
}

export function formatStatusHuman(rows) {
  if (rows.length === 0) return '没有运行中的任务。\n';
  const lines = rows.map((r) => {
    if (r.state === 'abnormal') {
      return `${r.runId}  ${r.model}  pid=${r.pid}  ${r.duration}  ${r.cwd}  异常终止（可能被外部信号杀掉）`;
    }
    return `${r.runId}  ${r.model}  pid=${r.pid}  ${r.duration}  ${r.cwd}`;
  });
  return `${lines.join('\n')}\n`;
}

export function deliverSay(spec, text, { cwd } = {}) {
  if (!text) throw new Error('缺少消息。用法: agent-fleet say <run-id|latest> "<消息>"');
  const runId = resolveRunId(spec, cwd);
  const rec = readPidRecord(runId);
  if (!rec) throw new Error(`找不到任务 ${runId} 的 pid.json`);
  if (rec.finished || !isPidAlive(rec.pid)) {
    throw new Error(`任务 ${runId} 已不在运行,无法投递插话。`);
  }
  appendInbox(runId, { type: 'say', text });
  return { runId, delivered: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 先投递 stop 到收件箱;宽限期后若仍在,校验 pid 再 SIGTERM,再 5 秒 SIGKILL。
 * 共享同一个 pid 的其它未结束任务存在时不发信号(run-many 同进程),只靠 inbox + interrupt。
 */
export async function requestStop(spec, { grace = 60, sleepFn = sleep, cwd } = {}) {
  const runId = resolveRunId(spec, cwd);
  const rec = readPidRecord(runId);
  if (!rec) throw new Error(`找不到任务 ${runId} 的 pid.json`);
  const graceSec = Number.isFinite(Number(grace)) ? Math.max(0, Number(grace)) : 60;

  appendInbox(runId, { type: 'stop', text: '', grace: graceSec });
  patchPidRecord(runId, { stopRequested: true });

  const deadline = Date.now() + graceSec * 1000;
  while (Date.now() < deadline) {
    const latest = readPidRecord(runId);
    if (!latest || latest.finished || !isPidAlive(latest.pid)) {
      return { runId, delivered: true, signaled: false, exited: true };
    }
    await sleepFn(200);
  }

  const latest = readPidRecord(runId);
  if (!latest || latest.finished || !isPidAlive(latest.pid)) {
    return { runId, delivered: true, signaled: false, exited: true };
  }

  const others = listAllPidRecords().filter(
    (r) => r.runId !== runId && !r.finished && r.pid === latest.pid && isPidAlive(r.pid),
  );
  if (others.length > 0) {
    return {
      runId,
      delivered: true,
      signaled: false,
      exited: false,
      skippedSignal: `pid ${latest.pid} 还被其它任务占用(${others.map((r) => r.runId).join(', ')}),不发 SIGTERM`,
    };
  }

  const check = assertSafeToSignal(latest);
  if (!check.ok) {
    return { runId, delivered: true, signaled: false, exited: false, skippedSignal: check.reason };
  }

  patchPidRecord(runId, { stopSignal: true });
  signalProcessTree(latest.pid, 'SIGTERM');
  await sleepFn(5000);
  if (isPidAlive(latest.pid)) {
    const again = assertSafeToSignal(readPidRecord(runId) ?? latest);
    if (again.ok) signalProcessTree(latest.pid, 'SIGKILL');
  }
  return {
    runId,
    delivered: true,
    signaled: true,
    exited: !isPidAlive(latest.pid),
  };
}
