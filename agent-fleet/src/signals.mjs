// 进程级 SIGTERM/SIGINT 分发。每个 runTask 注册自己的收尾回调,
// 避免 run-many 同进程多任务重复 process.on 叠一层。
// 本工具 stop 发出的 SIGTERM 由回调自己对照 pid.json/stopRequested 区分。

const handlers = new Set();
let hooked = false;

function dispatch(name) {
  for (const fn of [...handlers]) {
    try {
      fn(name);
    } catch {
      /* 单个任务的收尾失败不能挡住其它任务 */
    }
  }
}

function ensureHooked() {
  if (hooked) return;
  hooked = true;
  process.on('SIGTERM', () => dispatch('SIGTERM'));
  process.on('SIGINT', () => dispatch('SIGINT'));
}

/** @param {(name: string) => void} fn @returns {() => void} unsubscribe */
export function onProcessSignal(fn) {
  ensureHooked();
  handlers.add(fn);
  return () => handlers.delete(fn);
}
