// BrowserLeaks DNS/WebRTC复查；使用已登录Chrome及OpenCLI扩展，不改代理配置。
// 用法：node clash-leak-check.mjs；2026-09-30验证。WebRTC无地址不代表节点支持UDP。
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { defaultSession } from './opencli-core.mjs';

const session = defaultSession('clash-leak-check');
function browser(...args) {
  const output = execFileSync('opencli', ['browser', session, '--window', 'dedicated', ...args], { encoding: 'utf8', timeout: 45000 });
  return args[0] === 'close' ? output : JSON.parse(output);
}
async function readUntil(expression, complete) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const result = browser('eval', expression);
    if (complete(result)) return result;
    await setTimeout(3000);
  }
  throw new Error('检测未完成，不能据此判定无泄漏');
}
try {
  browser('open', 'https://browserleaks.com/dns');
  const dns = await readUntil('(() => ({status:document.querySelector("#dns-test")?.innerText ?? "",list:document.querySelector("#dns-list")?.innerText ?? ""}))()', r => /^Found \d+ Servers/.test(r.status));
  assert(dns.list.trim(), 'DNS列表为空');
  browser('open', 'https://browserleaks.com/webrtc');
  const rtcExpression = '(() => Object.fromEntries(["client-ipv4","rtc-leak","rtc-public"].map(id => [id,document.getElementById(id)?.innerText ?? ""])))()';
  await readUntil(rtcExpression, r => /Leak/.test(r['rtc-leak']));
  // Public ICE candidates can arrive after the initial local-leak status.
  await setTimeout(15000);
  const rtc = browser('eval', rtcExpression);
  console.log(JSON.stringify({ dns: dns.status, dnsServers: dns.list, domesticResolvers: dns.list.split('\n').filter(row => /\bChina\b|中国/.test(row)), webExit: rtc['client-ipv4'], webrtc: rtc['rtc-leak'], udpPublicIP: rtc['rtc-public'] }, null, 2));
} finally {
  browser('close');
}
