#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
/**
 * receiver.mjs —— 只监听 127.0.0.1 的本地接收端。
 *
 * 存在的理由：页面 JS 没有文件系统，<a download> 只能落到浏览器默认下载目录，
 * 而那个目录在部分 macOS 上对终端和 Node 是 EPERM（而且可能任务跑到一半才生效）。
 * 让页面直接 POST 到本机，数据一步进项目目录，不用等文件落齐、不用归并 "xxx (1)"。
 *
 * 端口按项目根路径派生，绝不写死常量：两个项目同时开工时，写死端口的第二个实例
 * EADDRINUSE 起不来，而页面的 fetch 照样 200——打到的是另一个项目的接收端，
 * 数据写进别人的目录，全程零报错。所以占用时直接崩，并打印占用者排查命令。
 *
 * 端点：
 *   GET  /ping           -> {ok, root, port, run}   注入前必须核对 root 是不是本项目
 *   POST /rows?slice=... -> 追加一批行，回报累计行数
 *   GET  /script?name=   -> 白名单内的本机提取器源码，页面 fetch(...).then(eval) 注入
 *   POST /done           -> 收尾，写 manifest.json
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
// `--help` 是成功，不是用法错误。放在最前面：本文件在任何参数解析之前
// 就会开工（起服务 / 读文件 / 校验必填），走到那里再判就已经晚了。
// 帮助文案直接取本文件头部注释，不另写一份——两份必然漂移。
if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  const src = readFileSync(fileURLToPath(new URL(import.meta.url)), 'utf8');
  const block = src.match(/\/\*\*([\s\S]*?)\*\//)
    ? src.match(/\/\*\*([\s\S]*?)\*\//)[1].split('\n').map((l) => l.replace(/^\s*\* ?/, ''))
    : src.split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, ''));
  console.log(block.join('\n').trim());
  process.exit(0);
}

// 白名单由调用方给：`--script <name>=<绝对路径>`，或 startReceiver({scripts})。
// 只允许白名单里的路径，绝不接受调用方在请求里传路径——那是目录穿越。
function parseScriptAllowlist(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    const at = String(entry).indexOf('=');
    if (at < 0) throw new Error(`--script 需要 <name>=<path> 形式，收到：${entry}`);
    const name = entry.slice(0, at);
    const file = path.resolve(entry.slice(at + 1));
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) throw new Error(`不安全的 script 名：${name}`);
    if (!fs.existsSync(file)) throw new Error(`script 文件不存在：${file}`);
    map.set(name, file);
  }
  return map;
}

export function derivePort(root, { floor = 41000, span = 900 } = {}) {
  const digest = crypto.createHash('sha1').update(path.resolve(root)).digest();
  return floor + (digest.readUInt16BE(0) % span);
}

function safeSlice(value) {
  const slice = String(value ?? 'default');
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(slice)) throw new Error(`unsafe slice name: ${slice}`);
  return slice;
}

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 起接收端。返回 {port, root, outDir, rows, close()}。
 * rows 是一个 Map<slice, object[]>，harvest 收尾时自己落盘。
 */
export async function startReceiver({ root, outDir, runId, port, scripts = new Map() }) {
  const resolvedRoot = path.resolve(root);
  const resolvedOut = path.resolve(outDir);
  fs.mkdirSync(resolvedOut, { recursive: true });
  const chosenPort = port ?? derivePort(resolvedRoot);
  const rows = new Map();

  const server = http.createServer(async (req, res) => {
    // 页面在 https 源上，到 127.0.0.1 属于跨源，必须开 CORS。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const url = new URL(req.url, `http://127.0.0.1:${chosenPort}`);
    const json = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    try {
      if (url.pathname === '/ping') {
        return json(200, { ok: true, root: resolvedRoot, out: resolvedOut, port: chosenPort, run: runId });
      }

      if (url.pathname === '/script') {
        const file = scripts.get(url.searchParams.get('name') ?? '');
        if (!file) return json(404, { ok: false, error: 'not in allowlist' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(fs.readFileSync(file, 'utf8'));
      }

      if (url.pathname === '/rows' && req.method === 'POST') {
        const slice = safeSlice(url.searchParams.get('slice'));
        const batch = JSON.parse(await readBody(req));
        if (!Array.isArray(batch)) return json(400, { ok: false, error: 'body must be an array' });
        const bucket = rows.get(slice) ?? [];
        bucket.push(...batch);
        rows.set(slice, bucket);
        return json(200, { ok: true, slice, received: batch.length, total: bucket.length });
      }

      if (url.pathname === '/done' && req.method === 'POST') {
        return json(200, { ok: true, slices: [...rows].map(([k, v]) => ({ slice: k, rows: v.length })) });
      }

      return json(404, { ok: false, error: 'unknown endpoint' });
    } catch (error) {
      return json(500, { ok: false, error: String(error.message ?? error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') return reject(error);
      // 绝不静默退让到别的端口，也不复用现有实例——那正是数据写进别人目录的路径。
      let holder = '';
      try { holder = execSync(`lsof -nP -iTCP:${chosenPort} -sTCP:LISTEN || true`).toString().trim(); } catch { /* noop */ }
      reject(new Error(
        `端口 ${chosenPort} 已被占用，接收端拒绝启动（静默换端口会把数据写进别人的目录）。\n` +
        `占用者：\n${holder || '(lsof 无输出，手动跑：lsof -nP -iTCP:' + chosenPort + ' -sTCP:LISTEN)'}\n` +
        `确认那不是本项目的实例后，杀掉它，或用 --port 显式指定另一个端口。`,
      ));
    });
    server.listen(chosenPort, '127.0.0.1', resolve);
  });

  // 实际端口写进项目内的小文件，其它脚本读它而不是硬编码。
  const portFile = path.join(resolvedOut, '.receiver.json');
  fs.writeFileSync(portFile, JSON.stringify({ port: chosenPort, root: resolvedRoot, run: runId }, null, 2));

  return {
    port: chosenPort,
    root: resolvedRoot,
    outDir: resolvedOut,
    rows,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(portFile, { force: true });
    },
  };
}

// 独立跑：node <opencli-skill-dir>/scripts/receiver.mjs --root . --out data/raw \
//         [--port N] [--run 2026-08-23] [--script table-extractor=/abs/path/extractor.js]
let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
} catch { /* argv[1] 缺失或不可解析 → 视为被 import */ }

if (isMain) {
  const argv = process.argv.slice(2);
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const scriptArgs = argv.reduce((acc, token, i) => (token === '--script' ? [...acc, argv[i + 1]] : acc), []);
  const receiver = await startReceiver({
    root: get('root', process.cwd()),
    outDir: get('out', path.join(process.cwd(), 'data/raw')),
    runId: get('run', new Date().toISOString().slice(0, 10)),
    port: get('port') ? Number(get('port')) : undefined,
    scripts: parseScriptAllowlist(scriptArgs),
  });
  process.stdout.write(`receiver listening on http://127.0.0.1:${receiver.port} (root ${receiver.root})\n`);
}
