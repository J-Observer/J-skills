#!/usr/bin/env node
// 可复制 Miniflare 脚手架；仅本地 HTTP、临时目录、D1/R2，永不读真 key。验证：2026-10-04。
import { createRequire } from 'node:module';
import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { args } from '../../scripts/kie-lib.mjs';
const o=args(process.argv.slice(2));
if(o.help) {console.log('node templates/kie/local-verify.mjs --deps-project DIR --out JSON [--dry-run]');process.exit(0)}
if(o['dry-run']) {console.log('dry-run，本地验证未运行');process.exit(0)}
if(!o['deps-project']||!o.out)throw Error('缺 --deps-project / --out');
const root=path.dirname(fileURLToPath(import.meta.url)),temp=await mkdtemp(path.join(tmpdir(),'kie-local-'));
const req=createRequire(path.resolve(o['deps-project'],'package.json')),wr=createRequire(req.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wr('miniflare'),{build}=wr('esbuild');
let created=0,mailed=0,balance=1000;
const server=createServer((req,res)=>{const u=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');
 if(u.pathname==='/api/v1/chat/credit')return res.end(JSON.stringify({code:200,data:balance}));
 if(u.pathname==='/api/v1/jobs/createTask'){created++;return res.end(JSON.stringify({code:200,data:{taskId:'fake'}}))}
 if(u.pathname==='/mail'){mailed++;return res.end('{}')}
 res.writeHead(404);res.end('{}');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
let mf;
try {
 const bundled=await build({stdin:{contents:`import {reserve,refund} from './budget';import {monitor} from './ops';import {KieClient,verifyWebhook} from './kie-client';
 export default {async fetch(request,env){const url=new URL(request.url);const kie=new KieClient('local-fixture',env.ORIGIN);
 if(url.pathname==='/reserve'){const ok=await reserve(env.DB,{id:url.searchParams.get('id'),userId:'u',siteCredits:10,micros:410000,dailyLimit:Number(url.searchParams.get('daily')||1000000),totalLimit:Number(url.searchParams.get('total')||410000),day:'2026-10-04',sourceExpiresAt:Date.now()+3600000});if(ok)await kie.create('fake',{});return Response.json({ok})}
 if(url.pathname==='/refund'){await refund(env.DB,'one');await refund(env.DB,'one');return Response.json({ok:true})}
 if(url.pathname==='/monitor'){await monitor(env.DB,kie,{warn:1000,pause:164,resume:1000,totalLimit:410000},async(message,key)=>{await fetch(env.ORIGIN+'/mail',{method:'POST',body:JSON.stringify({message,key})})});return Response.json({ok:true})}
 if(url.pathname==='/hmac'){return Response.json({taskId:await verifyWebhook(request,'local-hmac')})}
 await env.OUTPUTS.put('fixture','local-result');return new Response(await env.OUTPUTS.get('fixture').then(o=>o.text()))}}`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
 const options={modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-01',d1Databases:['DB'],r2Buckets:['OUTPUTS'],bindings:{ORIGIN:origin}};
 mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
 const db=await mf.getD1Database('DB');
 // D1 exec 对触发器内的分号不能逐行拆；逐 SQL 语句经 prepare 执行。
 const sql=await readFile(path.join(root,'migration.sql'),'utf8');
 const statements=sql.replace(/^--.*$/mg,'').match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/g);
 for(const statement of statements)await db.prepare(statement).run();
 await db.prepare("INSERT INTO kie_users(id,credits) VALUES('u',100)").run();
 const call=async(route)=> (await mf.dispatchFetch('http://local'+route)).json();
 const concurrent=await Promise.all([call('/reserve?id=one'),call('/reserve?id=one')]);assert.equal(concurrent.filter(r=>r.ok).length,1);assert.equal((await call('/reserve?id=two')).ok,false);assert.equal((await call('/reserve?id=three&daily=410000&total=1000000')).ok,false);assert.equal(created,1);
 await call('/refund');assert.equal((await db.prepare("SELECT credits FROM kie_users WHERE id='u'").first()).credits,100);
 assert.equal((await db.prepare("SELECT reserved_micros FROM kie_ops WHERE id=1").first()).reserved_micros,410000);
 balance=40;await call('/monitor');await call('/monitor');assert.equal(mailed,1);assert.equal((await db.prepare('SELECT paused FROM kie_ops').first()).paused,1);
 balance=500;await call('/monitor');assert.equal((await db.prepare('SELECT paused FROM kie_ops').first()).paused,1);
 balance=1000;await call('/monitor');assert.equal((await db.prepare('SELECT paused FROM kie_ops').first()).paused,0);
 const timestamp=String(Math.floor(Date.now()/1000));const {createHmac}=await import('node:crypto');const signature=createHmac('sha256','local-hmac').update('fake.'+timestamp).digest('base64');
 const h=await mf.dispatchFetch('http://local/hmac',{method:'POST',headers:{'X-Webhook-Timestamp':timestamp,'X-Webhook-Signature':signature},body:JSON.stringify({data:{taskId:'fake'}})});assert.equal((await h.json()).taskId,'fake');
 assert.equal(await (await mf.dispatchFetch('http://local/r2')).text(),'local-result');
 const evidence={passed:true,created,mailed,checks:['atomic daily/total reservation','idempotent submit','refund once','budget retained','pause/hysteresis/recovery','mail dedup','HMAC wire format','R2 roundtrip'],realProviderCalls:0};
 await writeFile(o.out,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{if(mf)await mf.dispose();await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true})}
