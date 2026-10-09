import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname ?? new URL('..', import.meta.url).pathname, import.meta.dirname ? '..' : '.');
const script = join(root, 'bin/fleet-go');
const temp = mkdtempSync(join(tmpdir(), 'fleet-go-test-'));
const home = join(temp, 'home');
const bin = join(temp, 'bin');
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(bin);
const source = join(homedir(), '.claude/CLAUDE.md');
const rule = readFileSync(join(root, 'skill/templates/blocks/rule-sentence.md'), 'utf8').trim();
if (existsSync(source)) {
  const live = readFileSync(source, 'utf8').match(/禁止单纯转发，允许分发子步骤：[^\n]+?最终给出真正的结论作为你的最终答案/)[0];
  assert.equal(rule, live);
  writeFileSync(join(home, '.claude/CLAUDE.md'), readFileSync(source));
} else {
  console.log('SKIP：本机 CLAUDE.md 不存在，跳过真实规则句比较。');
  writeFileSync(join(home, '.claude/CLAUDE.md'), rule);
}
const calls = join(temp, 'calls.jsonl');
const states = join(temp, 'states.json');
writeFileSync(states, '[]');
writeFileSync(join(bin, 'fleet'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({args, pid:process.pid})+'\\n');
if(args[0]==='status') console.log(fs.readFileSync(process.env.STATES,'utf8'));
if(args[0]==='stop') fs.writeFileSync(process.env.STATES,'[]');
if(args[0]==='say' && process.env.SAY_FAIL) process.exit(1);
if(['code','copy','grok','haiku','sonnet'].includes(args[0])) process.exit(7);
`, { mode: 0o755 });
writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\nif [ -n "${RESIDUAL:-}" ]; then\n printf "%s\\n" "$RESIDUAL"\n exit 0\nfi\nexit 1\n', { mode: 0o755 });
const env = { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, CALLS: calls, STATES: states };
const run = (args, extra={}) => spawnSync(script, args, { encoding:'utf8', env:{...env,...extra}, input:'' });
const history = () => existsSync(calls) ? readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const reset = () => writeFileSync(calls, '');
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS - '+name); }
try {
  let brief;
  test('dry-run 必需元素及顺序、最后一行逐字规则、无文件或派发', () => {
    const r=run(['new','one','--goal','独有目标','--dry-run','--write','/tmp/project','--read','/tmp/source']);
    assert.equal(r.status,0,r.stderr); brief=r.stdout;
    let previous=-1;
    for(const text of ['归类：','REPORT:','围绕本 brief','## 授权覆盖','## 目标','## 允许读写/禁止','## 已知坑','## 验收',rule]) {
      const i=brief.indexOf(text); assert.ok(i>previous,text); previous=i;
    }
    assert.equal(brief.trim().split('\n').at(-1),rule);
    assert.match(r.stderr,/将执行：fleet code .*--name one --report /);
    assert.match(brief,/NODE_USE_ENV_PROXY=1/);
    assert.match(brief,/规则回执/);
    assert.equal(history().length,0);
    assert.ok(!existsSync(join(home,'.agent-reports')));
  });
  // 使用输出的 REPORT 路径，避免日期 locale 与时区差异。
  const report = brief.match(/^REPORT: (.+)$/m)[1];
  const path = report.replace(/\.md$/,'.brief.md');
  test('new 前台 exec、参数正确、退出码透传', () => {
    const r=run(['new','one','--goal','独有目标']);
    assert.equal(r.status,7,r.stderr);
    assert.equal(history().at(-1).pid,r.pid);
    assert.deepEqual(history().at(-1).args,['code',path,'--name','one','--report',report]);
    assert.ok(existsSync(path));
  });
  const original=readFileSync(path,'utf8');
  test('同名拒绝覆盖', () => {
    const r=run(['new','one','--goal','覆盖']); assert.equal(r.status,1); assert.match(r.stderr,/amend/); assert.equal(readFileSync(path,'utf8'),original);
  });
  test('amend 递增、不重复、原文保留、归类首行和规则末行保留', () => {
    for(const message of ['第一处要求','第二处要求','第二处要求']) assert.equal(run(['amend','one',message]).status,0);
    const revised=readFileSync(path,'utf8');
    assert.match(revised,/修订 1（/); assert.match(revised,/修订 2（/); assert.doesNotMatch(revised,/修订 3（/);
    assert.equal(revised.replace(/\n## 【修订 \d+（[^\n]+）】\n[^\n]+\n\n/g,''),original);
    assert.equal(run(['lint',path]).status,0);
  });
  const state=()=>writeFileSync(states,JSON.stringify([{runId:'fake-run',name:'one',briefPath:path,status:'running',duration:'3m',launchDetached:true}]));
  test('say 发送给运行 run、不 stop 或重派', () => {
    state(); reset(); assert.equal(run(['amend','one','插话','--say']).status,0);
    assert.deepEqual(history().map(c=>c.args[0]),['status','say']);
    assert.deepEqual(history().at(-1).args,['say','fake-run','插话']);
  });
  test('say 不支持时保留修订、不杀不重派', () => {
    state(); reset(); const r=run(['amend','one','Codex插话','--say'],{SAY_FAIL:'1'});
    assert.equal(r.status,1); assert.match(r.stderr,/未 stop、未重派/); assert.match(readFileSync(path,'utf8'),/Codex插话/);
    assert.deepEqual(history().map(c=>c.args[0]),['status','say']);
  });
  test('restart 先 stop、核验退出、再执行', () => {
    state(); reset(); assert.equal(run(['amend','one','重启','--restart']).status,7);
    assert.deepEqual(history().map(c=>c.args[0]),['status','stop','status','code']);
  });
  test('restart 有残留不重派', () => {
    state(); reset(); const r=run(['amend','one','残留','--restart'],{RESIDUAL:'123 codex exec one'});
    assert.equal(r.status,1); assert.match(r.stderr,/残留/); assert.ok(!history().some(c=>c.args[0]==='code'));
  });
  test('找不到运行 run 清楚提示', () => {
    writeFileSync(states,'[]'); const r=run(['amend','one','离线修订','--say']); assert.equal(r.status,1); assert.match(r.stderr,/找不到唯一运行/);
  });
  test('lint 缺项失败、合格通过、后台命令和秘密拒绝且不回显', () => {
    const bad=join(temp,'bad.md'); writeFileSync(bad,'没有必需项');
    let r=run(['lint',bad]); assert.equal(r.status,1); for(const word of ['第一行','REPORT','逐字规则']) assert.ok(r.stderr.includes(word));
    assert.equal(run(['lint',path]).status,0);
    for(const unsafe of ['fleet code task.md &','nohup fleet code task.md','fleet code task.md > /tmp/out 2>&1 &','nohup npm run dev','node server.mjs &','sk-'+'x'.repeat(24),'Bearer '+'x'.repeat(24)]) {
      writeFileSync(bad,original+'\n'+unsafe); r=run(['lint',bad]); assert.equal(r.status,1,unsafe); assert.ok(!r.stderr.includes(unsafe));
    }
    writeFileSync(bad,original+'\n错误示范：nohup fleet code task.md &'); assert.equal(run(['lint',bad]).status,0);
  });
  test('body 文件、stdin、授权叠加、paid 必须预算、默认报告和 no-launch', () => {
    const body=join(temp,'body.md'); writeFileSync(body,'## 独有正文\n只处理本目标');
    let r=run(['new','body','--body',body,'--auth','local,readonly-web','--no-launch']); assert.equal(r.status,0,r.stderr);
    assert.equal(run(['new','paid','--goal','付费','--auth','paid','--dry-run']).status,1);
    r=run(['new','paid','--goal','付费','--auth','paid','--budget','$2，重试 1 次','--dry-run']); assert.equal(r.status,0); assert.match(r.stdout,/\$2，重试 1 次/);
    r=spawnSync(script,['new','stdin','--dry-run'],{encoding:'utf8',env,input:'## stdin 独有正文'}); assert.equal(r.status,0); assert.match(r.stdout,/stdin 独有正文/);
  });
  test('所有 kind 映射', () => {
    for(const [kind,cmd] of Object.entries({code:'code',review:'code --review',research:'code',copy:'copy',grok:'grok',haiku:'haiku',sonnet:'sonnet'})) {
      const r=run(['new',kind,'--kind',kind,'--goal','映射','--dry-run']); assert.equal(r.status,0); assert.ok(r.stderr.includes('fleet '+cmd+' '));
    }
  });
  test('status 提醒 launchDetached 与 wait',()=> {
    state(); const r=run(['status']); assert.equal(r.status,0); assert.match(r.stdout,/⚠/); assert.match(r.stdout,/fleet wait fake-run/);
  });
  test('源码不包含真实后台化调用', () => {
    const shell=readFileSync(script,'utf8'); assert.doesNotMatch(shell,/&|nohup|setsid|disown/);
    const python=readFileSync(join(root,'src/fleet-go.py'),'utf8');
    assert.doesNotMatch(python,/subprocess\.(?:Popen|run)\([^\n]*(?:shell\s*=\s*True|start_new_session|nohup|setsid|disown)/);
    assert.doesNotMatch(python,/os\.(?:fork|setsid|system)\(/);
    assert.match(python,/os\.execvp\('fleet'/);
  });
  console.log(`fleet-go：${checks} 组通过。`);
} finally { rmSync(temp,{recursive:true,force:true}); }
