/**
 * 诊断 OpenCLI dedicated 专用窗口残留的空白窗口，按 slot 分类汇总。
 * 依赖：Google Chrome 已开、osascript、opencli 扩展 >=1.2.0。
 * 只读不关窗口。
 * 验证日期：2026-10-03。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { stdout: statusOutput } = await run('opencli', ['browser', 'window', 'status', '-f', 'json']);
const windows = JSON.parse(statusOutput).windows
  .filter(window => window.exists === true)
  .map(({ slot, holders, idleMs, windowId, tabs, activeTab }) => ({
    slot, holders, idleMs, windowId, tabs, activeTabUrl: activeTab?.url,
  }));
const bySlot = new Map(windows.map(window => [window.slot, window]));

const { stdout: chromeOutput } = await run('osascript', ['-e', `
tell application "Google Chrome"
  set windowLines to {}
  repeat with windowNumber from 1 to count of windows
    set windowLine to windowNumber as text
    repeat with chromeTab in tabs of window windowNumber
      set windowLine to windowLine & (ASCII character 9) & (URL of chromeTab)
    end repeat
    set end of windowLines to windowLine
  end repeat
end tell
set AppleScript's text item delimiters to linefeed
return windowLines as text
`]);

const blankWindows = [];
for (const line of chromeOutput.trim().split('\n').filter(Boolean)) {
  const [number, ...urls] = line.split('\t');
  if (!urls.every(url => url === 'about:blank' || url.startsWith('about:blank#opencli-dedicated='))) continue;
  const marker = urls.find(url => url.startsWith('about:blank#opencli-dedicated='));
  const slot = marker?.slice('about:blank#opencli-dedicated='.length);
  const tracked = bySlot.get(slot);
  const category = !tracked ? 'untracked'
    : tracked.holders >= 1 ? 'held'
    : tracked.idleMs > 30000 ? 'idle-overdue' : 'idle-ok';
  blankWindows.push({ number, slot, category });
}

const counts = { held: 0, 'idle-overdue': 0, 'idle-ok': 0, untracked: 0 };
for (const window of blankWindows) counts[window.category]++;
console.log(`空白窗口总数=${blankWindows.length} held=${counts.held} idle-overdue=${counts['idle-overdue']} idle-ok=${counts['idle-ok']} untracked=${counts.untracked}`);
for (const window of blankWindows) {
  console.log(`序号=${window.number} slot=${window.slot ?? '-'} 类别=${window.category}`);
}
process.exitCode = counts['idle-overdue'] || counts.untracked ? 2 : 0;
