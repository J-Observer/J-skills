import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock, randomMs, windowWait, reserveConversation, healthFailure, checkExit } from '../scripts/demand/_chatgpt_guard.mjs';

const script = resolve('rankup/scripts/geo-loop.mjs');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'geo-loop-pacing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.agents/skills/opencli/scripts'), {recursive:true});
  writeFileSync(join(dir, '.agents/skills/opencli/scripts/opencli-core.mjs'), "export const defaultSession = () => 'geo-test';");
  const preload = join(dir, 'offline.mjs');
  writeFileSync(preload, `let count = 0; globalThis.fetch = async url => { if (url !== 'https://api.country.is/') throw new Error('Unexpected network request'); return {ok:true,json:async()=>({ip:process.env.MOCK_EXIT_CHANGE && ++count > 1 ? '192.0.2.2' : '192.0.2.1',country:'JP'})}; };`);
  writeFileSync(join(dir, 'opencli'), `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), statePath=process.env.HOME+'/mock-count';
let count=0; try { count=Number(readFileSync(statePath,'utf8')); } catch {}
if(args[0]==='doctor') console.log('[OK] Daemon: mock\\n[OK] Extension: mock\\n[OK] Connectivity: mock');
else if(args[2]==='open') writeFileSync(statePath,'0');
else if(args[2]==='click') {writeFileSync(statePath,String(++count));writeFileSync(process.env.HOME+'/sent','yes',{flag:'a'});}
else if(args[2]==='eval') {
 const expression=args[3];
 const gate=process.env.MOCK_GATE || '';
 const result=expression.includes('loggedIn:') ? {text:gate,loggedIn:gate!=='logout',login:gate==='logout'}
 : expression.includes('mode:document') ? {url:'https://chatgpt.com/?temporary-chat=true',text:'临时聊天'}
 : expression.includes('ready:') ? {ready:true,text:'临时聊天'}
 : expression.includes('const answers') ? {text:'{"recommendations":[],"suggestions":[]}',count,busy:false,links:[],sources:false}
 : {count,blocked:false,auth:false};
 console.log(JSON.stringify(result));
}
`, {mode:0o755});
  const env={...process.env, HOME:dir, PATH:dir+':'+process.env.PATH, NODE_OPTIONS:'--import='+preload};
  const base=['--domain','example.invalid','--prompt','test need','--no-pitch','--reps','2','--out',join(dir,'out'),'--sample-min','0','--sample-max','0','--followup-min','0','--followup-max','0'];
  return {dir, env, base, run:(extra=[], overrides={})=>spawnSync(process.execPath,[script,...base,...extra],{env:{...env,...overrides},encoding:'utf8',timeout:10000})};
}

test('random bounds and rolling window boundary, including history over a lower limit',()=>{
  assert.equal(randomMs(30,90,()=>0),30000);
  assert.equal(randomMs(30,90,()=>1),90000);
  assert.equal(randomMs(10,25,()=>0),10000);
  assert.equal(randomMs(10,25,()=>1),25000);
  assert.equal(windowWait(Array(18).fill(1),18,2),3599999);
  assert.equal(windowWait([0],1,3600000),0);
  assert.equal(windowWait([100,200,300],2,400),3599800);
});
test('persisted quota waits, logs, survives a new invocation and never resets history',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'geo-loop-pacing-quota-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let clock=100; const logs=[];
  const opts={dir,limit:1,now:()=>clock,wait:async ms=>{clock+=ms;},log:s=>logs.push(s)};
  await reserveConversation(opts);await reserveConversation(opts);
  assert.equal(clock,3600100);assert.ok(logs.some(s=>s.includes('等待')));
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'chatgpt-web-starts.json'),'utf8')),[3600100]);
});
test('live PID lock conflicts, dead PID and timed-out malformed locks are reclaimed',t=>{
  const f=fixture(t),dir=join(f.dir,'.cache/rankup');
  const release=acquireLock(dir);assert.throws(()=>acquireLock(dir),/锁冲突/);
  const collision=f.run(['--plan']);assert.notEqual(collision.status,0);assert.match(collision.stderr,/锁冲突/);
  release();
  const dead=Number(spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim());
  writeFileSync(join(dir,'chatgpt-web.lock'),JSON.stringify({pid:dead,createdAt:0}));acquireLock(dir)();
  writeFileSync(join(dir,'chatgpt-web.lock'),'');utimesSync(join(dir,'chatgpt-web.lock'),new Date(0),new Date(0));acquireLock(dir)();
});
test('health rejects logout even when a composer exists, captcha and rate limits',()=>{
  assert.equal(healthFailure({loggedIn:false,ready:true}),'auth');
  assert.equal(healthFailure({loggedIn:true,text:'captcha'}),'captcha');
  assert.equal(healthFailure({loggedIn:true,text:'Too many requests'}),'rate-limit');
  assert.equal(healthFailure({loggedIn:true,text:'正常'}),null);
});
test('exit lookup prints baseline, detects a changed IP, fails closed on unavailable data',async()=>{
  const web={},logs=[];
  const fetcher=async()=>({ok:true,json:async()=>({ip:'192.0.2.1',country:'JP'})});
  await checkExit(web,fetcher,s=>logs.push(s));await checkExit(web,fetcher,s=>logs.push(s));
  assert.equal(logs.length,1);
  await assert.rejects(checkExit(web,async()=>({ok:true,json:async()=>({ip:'192.0.2.2',country:'JP'})})),/出口 IP 变化/);
  await assert.rejects(checkExit({},async()=>({ok:false})),/查询失败/);
  await assert.rejects(checkExit({},async()=>({ok:true,json:async()=>({ip:'unknown',country:'JP'})})),/无法确认/);
});
test('help and plan work offline; default cap is 25, 19th start waits, explicit override works',t=>{
  const f=fixture(t);
  assert.equal(f.run(['--help']).status,0);
  const run=extra=>spawnSync(process.execPath,[script,'--domain','example.invalid','--prompt','need','--reps','27','--out',join(f.dir,'plan'),'--plan',...extra],{env:f.env,encoding:'utf8'});
  const result=run([]);assert.equal(result.status,0,result.stderr);
  const rows=result.stdout.trim().split('\n').map(s=>JSON.parse(s));
  assert.deepEqual(rows[0].sampleSeconds,[30,90]);assert.deepEqual(rows[0].followupSeconds,[10,25]);
  assert.equal(rows[0].planned,25);assert.equal(rows[0].remaining,2);assert.ok(rows[19].quotaWaitMs>0);
  assert.equal(JSON.parse(run(['--max-conversations','27']).stdout.split('\n')[0]).planned,27);
  assert.equal(existsSync(join(f.dir,'sent')),false);
  assert.equal(existsSync(join(f.dir,'plan')),false);
});
test('mocked run pauses at cap, refuses overwrite, resumes without repeating completed samples',t=>{
  const f=fixture(t);
  let result=f.run(['--max-conversations','1']);assert.equal(result.status,0,result.stderr);
  let data=JSON.parse(readFileSync(join(f.dir,'out/summary.json'),'utf8'));
  assert.equal(data.status,'paused');assert.equal(data.progress.completed,1);
  assert.equal(f.run([]).status,1);
  result=f.run(['--resume','--max-conversations','1']);assert.equal(result.status,0,result.stderr);
  data=JSON.parse(readFileSync(join(f.dir,'out/summary.json'),'utf8'));
  assert.equal(data.status,'completed');assert.equal(data.progress.completed,2);assert.equal(data.samples.length,2);
  assert.equal(readFileSync(join(f.dir,'sent'),'utf8'),'yes'.repeat(6));
  assert.equal(f.run(['--resume','--prompt','different']).status,1);
});
for (const gate of ['logout','captcha','Too many requests']) test(`mocked ${gate} stops before sending, preserves progress`,t=>{
  const f=fixture(t),result=f.run([],{MOCK_GATE:gate});
  assert.equal(result.status,1,result.stderr);
  const data=JSON.parse(readFileSync(join(f.dir,'out/summary.json'),'utf8'));
  assert.equal(data.status,'stopped');assert.equal(data.progress.completed,0);assert.ok(data.stopReason.includes(gate==='logout'?'auth':gate==='captcha'?'captcha':'rate-limit'));
  assert.equal(existsSync(join(f.dir,'sent')),false);
  assert.equal(existsSync(join(f.dir,'.cache/rankup/chatgpt-web.lock')),false);
});
test('mocked exit change stops before sending and incomplete sample is retried only on explicit resume',t=>{
  const f=fixture(t),first=f.run([],{MOCK_EXIT_CHANGE:'1'});
  assert.equal(first.status,1);assert.equal(existsSync(join(f.dir,'sent')),false);
  const result=f.run(['--resume']);assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(readFileSync(join(f.dir,'out/summary.json'),'utf8'));
  assert.equal(data.samples.length,3);assert.equal(data.samples[0].invalid,true);assert.equal(data.progress.completed,2);
  assert.equal(data.summary[0].samples,2);
});
test('ai-probe shares the same lock and aborts its queue on logged-out temporary pages',t=>{
  const f=fixture(t),dir=join(f.dir,'.cache/rankup');
  const probeArgs=[resolve('rankup/scripts/demand/ai-probe.mjs'),'--topic','test','--need-prompt','need','--out',join(f.dir,'probe'),'--channel','chatgpt-web','--kinds','N','--reps','2','--multi-turn','--turns','1','--gap-ms','0'];
  const run=()=>spawnSync(process.execPath,probeArgs,{env:{...f.env,MOCK_GATE:'logout'},encoding:'utf8',timeout:10000});
  const release=acquireLock(dir);const collision=run();assert.notEqual(collision.status,0);assert.match(collision.stderr,/锁冲突/);release();
  const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/停止后续提问/);
  assert.equal(existsSync(join(f.dir,'sent')),false);
  assert.equal(existsSync(join(f.dir,'probe/raw/N-2.json')),false);
});
