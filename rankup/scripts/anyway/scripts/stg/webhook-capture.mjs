#!/usr/bin/env node
// 用途：本机接收 stg webhook，把原始请求写到项目侧证据目录。
// 参数：--evidence-dir <项目侧目录>（默认当前目录 .rankup/evidence/anyway/stg）；PORT 环境变量可指定监听端口。
// 登录态：无；需调用方自行提供可到达的隧道与 stg webhook 端点。
// 已知坑：验签须使用 .raw 原始字节；部分网络中 cloudflared 需 --protocol http2。验证日期：2026-09-07（原流程）。

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evidenceArg = process.argv.indexOf('--evidence-dir');
const evidenceDir = path.resolve(evidenceArg >= 0 ? process.argv[evidenceArg + 1] : path.join(process.cwd(), '.rankup', 'evidence', 'anyway', 'stg'));
fs.mkdirSync(evidenceDir, { recursive: true });

let counter = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    counter += 1;
    const seq = String(counter).padStart(3, '0');
    const rawBody = Buffer.concat(chunks);
    const record = {
      seq: counter,
      receivedAt: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyLength: rawBody.length,
      bodyBase64: rawBody.toString('base64'),
    };
    const jsonPath = path.join(evidenceDir, `webhook-${seq}.json`);
    const rawPath = path.join(evidenceDir, `webhook-${seq}.raw`);
    fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2));
    fs.writeFileSync(rawPath, rawBody); // exact raw bytes, for signature verification
    console.error(`[capture] #${seq} ${req.method} ${req.url} (${rawBody.length} bytes) -> ${jsonPath}`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
});

const desiredPort = process.env.PORT ? Number(process.env.PORT) : 0;
server.listen(desiredPort, '127.0.0.1', () => {
  const { port } = server.address();
  // Single machine-readable line for the caller to parse.
  console.log(`PORT=${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
