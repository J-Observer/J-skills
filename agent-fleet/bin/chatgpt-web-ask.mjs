#!/usr/bin/env node
/** 常驻临时 ChatGPT；使用用户已登录 Chrome，成功常驻由调用方显式 close，失败与中断关闭。 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { oc, parseEvalJson, openSession, sendTurn, closeSession, browserCommand, sleep, manageSession } from '../../rankup/scripts/demand/_chatgpt_web.mjs';

const HELP = `fleet web start "问题" [--name 描述性会话名] [--json] [--out file]
fleet web say <session> "追问" [--json] [--out file]
fleet web list
fleet web close <session>
fleet web "问题" [--followup "追问" ...] [--out file] [--json] [--close]
不限轮次，默认不关页；用完请 close。占一个 dedicated 池位（容量 10）。
常驻对话不自动回收，需显式 close；无追问且带 --close 的一次性问答默认 10 分钟回收。AI_PROBE_WEB_WINDOW 可覆盖窗口模式。
须用户确认账号关闭记忆；发送前自动确认临时聊天与「不个性化」并回读，无法确认即停止；未开路径需用户在当前聊天手动选择。内容发给 OpenAI，答案当线索。
订阅额度可能限流（原因未确认）；限流/验证码/登录失败即停，保存 pageText 后关闭。
`;
const KEY = 'fleet.chatgpt-web';
const LOST = '会话已丢失，需 start 重新开始（临时聊天内容无法找回）';
const webFor = session => ({ session, opened: true, keepAlive: true });
let activeWeb;
function sessions() {
  const result = oc(['browser', 'sessions', '-f', 'json']);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function readMeta(web) {
  const result = browserCommand(web, ['eval', `sessionStorage.getItem(${JSON.stringify(KEY)})`]);
  if (result.status !== 0) throw new Error(LOST);
  return parseEvalJson(result.stdout);
}
function saveMeta(web, meta) {
  const result = browserCommand(web, ['eval', `(() => {sessionStorage.setItem(${JSON.stringify(KEY)},${JSON.stringify(JSON.stringify(meta))});return 'saved';})()`]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function existing(session) {
  if (!sessions().some(row => row.session === session && row.surface === 'browser')) throw new Error(LOST);
  const web = webFor(session);
  activeWeb = web;
  manageSession(web);
  const meta = readMeta(web);
  if (!meta) throw new Error(LOST);
  web.temporaryNotice = meta.temporaryNotice;
  return { web, meta };
}
async function ask(web, meta, question) {
  if (meta.lastTurnAt) await sleep(Math.max(0, Date.parse(meta.lastTurnAt) + 8000 - Date.now()));
  if (!sessions().some(row => row.session === web.session && row.surface === 'browser')) throw new Error(LOST);
  const result = await sendTurn({ web, prompt: question, timeoutS: 150, continuation: true, natural: true });
  const turn = { n: (meta.n || 0) + 1, question, answer: result.answer || '', cited: result.cited || [],
    domains: [...new Set((result.cited || []).map(source => source.domain))], durationMs: result.durationMs,
    ok: result.ok, failure: result.failure || null, ...(!result.ok ? { error: result.error, pageText: result.pageText, pageUrl: result.pageUrl } : {}) };
  meta.n = turn.n;
  meta.lastTurnAt = new Date().toISOString();
  if (!turn.ok) meta.failure = turn; // 保存失败页面文字，原文在输出中保留。
  saveMeta(web, meta);
  return turn;
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, followup: { type: 'string', multiple: true },
    name: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, close: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const [command, ...rest] = positionals;
  if (command === 'list') {
    const rows = [];
    for (const row of sessions().filter(row => row.surface === 'browser' && row.session.startsWith('chatgpt-web-'))) {
      const meta = readMeta(webFor(row.session));
      if (meta) rows.push({ session: row.session, windowId: row.windowId, position: row.dedicatedSlot, lastTurnAt: meta.lastTurnAt || null });
    }
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  if (command === 'close') {
    const web = webFor(rest[0]);
    const result = closeSession(web);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    console.log(`已关闭：${web.session}`);
    return;
  }
  let web, meta;
  const turns = [];
  if (command === 'say') {
    ({ web, meta } = existing(rest[0]));
    if (!rest[1]) throw new Error('需要追问。\n' + HELP);
    turns.push(await ask(web, meta, rest[1]));
  } else {
    const question = command === 'start' ? rest[0] : command;
    if (!question) throw new Error(HELP);
    const name = values.name || Date.now().toString(36);
    const session = (name.startsWith('chatgpt-web-') ? name : `chatgpt-web-${name}`) + (/\d{3,6}$/.test(name) ? '-chat' : '');
    if (sessions().some(row => row.session === session)) throw new Error(`会话已存在：${session}；请用 say 继续。`);
    web = webFor(session);
    web.keepAlive = command === 'start' || !!values.followup?.length || !values.close;
    activeWeb = web;
    manageSession(web);
    const opened = await openSession({ web });
    meta = { temporaryNotice: web.temporaryNotice || '', n: 0 };
    if (!opened.ok) {
      meta.failure = opened;
      saveMeta(web, meta);
      turns.push({ question, ...opened });
    } else {
      saveMeta(web, meta);
      turns.push(await ask(web, meta, question));
      for (const followup of values.followup || []) {
        if (!turns.at(-1).ok) break;
        turns.push(await ask(web, meta, followup));
      }
    }
  }
  const ok = turns.every(turn => turn.ok);
  if (values.close || !ok) {
    const result = closeSession(web);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  }
  const hint = !web.opened ? `已关闭：${web.session}` : !ok ? `关闭失败；用 fleet web close ${web.session} 重试` : `用 fleet web say ${web.session} "追问" 继续，或 fleet web close ${web.session} 关闭`;
  const output = values.json ? JSON.stringify({ session: web.session, turns, hint }, null, 2) + '\n'
    : `会话：${web.session}\n\n` + turns.map(turn => `## 第 ${turn.n || 1} 轮\n\n${turn.question}\n\n${turn.answer || ''}\n\n引用域名：${(turn.domains || []).join('、') || '（无）'}\n${turn.ok ? '' : `\n失败：${turn.failure} ${turn.error}\npageText：${turn.pageText}\npageUrl：${turn.pageUrl}\n`}`).join('\n') + `\n${hint}\n`;
  if (values.out) writeFileSync(values.out, output);
  process.stdout.write(output);
  if (!ok) process.exitCode = 1;
  else if (web.opened) web.retained = true;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  if (activeWeb?.opened && !activeWeb.retained) closeSession(activeWeb);
});
