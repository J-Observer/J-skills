#!/usr/bin/env node
// 用途：打开商户后台 webhook 对话框；默认只读 dry-run，--commit 才提交。
// 参数：--url <endpoint> [--name n] [--events all|标签列表] [--env stg|prod] [--session anyway-dashboard] [--commit]。
// 登录态：OpenCLI 已连接用户浏览器，且对应环境的商户后台已登录。
// 已知坑：Merchant API 无端点读取接口；UI 不展示 signing secret。验证日期：2026-09-07（原流程）。

import { execFileSync } from 'node:child_process';

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq !== -1) {
      flags[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[tok.slice(2)] = next;
        i++;
      } else {
        flags[tok.slice(2)] = true;
      }
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

const URL = flags.url;
const NAME = flags.name || '';
const EVENTS = flags.events || 'all'; // 'all' or comma-separated Chinese labels
const SESSION = flags.session || 'anyway-dashboard';
const COMMIT = !!flags.commit;
const ENV = flags.env || process.env.ANYWAY_ENV || 'stg';
if (!['stg', 'prod'].includes(ENV)) throw new Error('expected --env stg|prod');
const DASHBOARD_BASE = ENV === 'stg' ? 'https://stg.anyway.sh' : 'https://app.anyway.sh';

const KNOWN_EVENTS = [
  '订单待处理',
  '订单已付款',
  '订单失败',
  '订阅已创建',
  '订阅已更新',
  '订阅已过期',
  '订阅已结束',
];

function log(...args) {
  console.error(...args);
}

function runOpencliBrowser(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync('opencli', ['browser', SESSION, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const trimmed = out.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      return { raw: trimmed };
    }
  } catch (err) {
    if (allowFail) return { error: true, raw: String(err.stdout || err.message) };
    throw err;
  }
}

function checkDoctor() {
  try {
    const out = execFileSync('opencli', ['doctor'], { encoding: 'utf8' });
    if (!/\[OK\] Daemon/.test(out) || !/\[OK\] Extension/.test(out)) {
      throw new Error('opencli doctor did not report both Daemon and Extension OK:\n' + out);
    }
    log('[doctor] OpenCLI bridge OK');
  } catch (err) {
    console.error('opencli doctor failed — fix the browser bridge before retrying.');
    console.error(String(err.stdout || err.message || err));
    process.exit(1);
  }
}

async function main() {
  if (!URL) {
    console.error('Usage: create-webhook.mjs --url <endpoint-url> [--name n] [--events all|"a,b"] [--env stg|prod] [--commit]');
    process.exit(1);
  }

  let selectedEvents = null;
  if (EVENTS !== 'all') {
    selectedEvents = EVENTS.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = selectedEvents.filter((e) => !KNOWN_EVENTS.includes(e));
    if (unknown.length) {
      console.error(`[error] unknown event(s): ${unknown.join(', ')}`);
      console.error(`Known events: ${KNOWN_EVENTS.join(', ')}`);
      process.exit(1);
    }
  }

  checkDoctor();

  log(`[browser] env="${ENV}" session="${SESSION}" opening ${DASHBOARD_BASE}/settings/setup`);
  runOpencliBrowser(['open', `${DASHBOARD_BASE}/settings/setup`]);
  await new Promise((r) => setTimeout(r, 1500));

  log('[browser] opening "配置 Webhook 端点" dialog...');
  // Two elements match --name "配置 Webhook 端点" (one is the card wrapper
  // whose accessible name includes the subtitle "实时获取后台信息", one is
  // the label span itself) and --nth only disambiguates CSS-selector targets,
  // not semantic --role/--name locators — so resolve via `find` (which picks
  // the exact-text match at a known index) and click that ref right away.
  const found = runOpencliBrowser(['find', '--role', 'button', '--name', '配置 Webhook 端点']);
  const exact = (found.entries || []).find((e) => e.text === '配置 Webhook 端点') || (found.entries || [])[0];
  if (!exact) throw new Error('Webhook button unavailable; log in to the selected merchant dashboard first.');
  runOpencliBrowser(['click', String(exact.ref)]);
  await new Promise((r) => setTimeout(r, 800));

  log('[survey] form fields: 名称 (input), 端点 URL (input), 事件 (radiogroup: 所有活动 / 选择特定事件)');
  log(`[survey] known events: ${KNOWN_EVENTS.join(', ')}`);

  if (!COMMIT) {
    log('[dry-run] not filling or submitting — pass --commit to actually create the endpoint.');
    runOpencliBrowser(['keys', 'Escape']);
    log('[dry-run] dialog closed, nothing created.');
    return;
  }

  log(`[commit] filling name="${NAME}" url="${URL}" events=${EVENTS}`);

  if (NAME) {
    runOpencliBrowser(['fill', 'input[placeholder="例如生产服务器"]', NAME]);
  }
  runOpencliBrowser(['fill', 'input[placeholder="https://api.example.com/webhooks/anyway"]', URL]);

  if (selectedEvents) {
    // Switch to "选择特定事件" (2nd radio in the 事件订阅 radiogroup), then
    // check each requested event button by its visible text.
    runOpencliBrowser(['click', '[role=radiogroup] button[role=radio]:nth-of-type(2)']);
    await new Promise((r) => setTimeout(r, 400));
    for (const label of selectedEvents) {
      runOpencliBrowser(['click', '--role', 'button', '--name', label], { allowFail: true });
    }
  }
  // else: leave default "所有活动" (all events) selected.

  log('[commit] submitting "创建端点"...');
  const result = runOpencliBrowser(['click', '--role', 'button', '--name', '创建端点']);
  await new Promise((r) => setTimeout(r, 1500));

  log('[done] endpoint submitted. Verify in the dashboard (Settings → 支付接入 → Webhook) — ');
  log('the Merchant API is read-only and does not expose webhook endpoints, so there is no API-side check here.');
  if (result && result.error) {
    console.error('[warn] the click envelope reported an error — check the browser session for details.');
  }
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exitCode = 1;
}).finally(() => {
  runOpencliBrowser(['close'], { allowFail: true });
});
