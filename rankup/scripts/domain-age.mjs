#!/usr/bin/env node
/**
 * Domain age from public WHOIS and Wayback CDX; no login or dependencies (Node 18+).
 * Usage: node domain-age.mjs a.com,b.com [--json] [--out file]
 *        node domain-age.mjs --file list.txt [--json] [--out file]
 *        node domain-age.mjs --whois-file saved-whois.txt
 * WHOIS may be rate limited; some TLDs do not expose a registration date.
 * Verified: 2026-09-28.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
let input = '', file, whoisFile, out, json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') json = true;
  else if (a === '--file' || a === '--out' || a === '--whois-file') {
    if (!args[i + 1]) throw Error(`${a} needs a value`);
    if (a === '--file') file = args[++i]; else if (a === '--whois-file') whoisFile = args[++i]; else out = args[++i];
  } else if (!a.startsWith('-') && !input) input = a;
  else throw Error(`Unknown argument: ${a}`);
}
if (whoisFile) {
  if (input || file || out || json) throw Error('--whois-file takes only a path');
} else if (Boolean(input) === Boolean(file)) throw Error('Provide domains or --file list.txt');
const domains = whoisFile ? [] : [...new Set((file ? await readFile(file, 'utf8') : input).split(/[\s,]+/).filter(Boolean))];
if (!whoisFile && (!domains.length || domains.some(d => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d)))) throw Error('Invalid or empty domain list');

function whois(domain, timeout) {
  return new Promise((resolve, reject) => execFile('whois', [domain], { timeout, encoding: 'utf8', maxBuffer: 2e6 }, (e, stdout) => e ? reject(e) : resolve(stdout)));
}
function dateOf(value) {
  const s = value.trim();
  const d = /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s.slice(0, 10) + 'T00:00:00Z') : new Date(s);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString().slice(0, 10);
}
function registration(raw) {
  let iana = false, registry = false;
  const preferred = [], fallback = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*#\s*whois\./i.test(line)) { iana = false; registry = true; }
    else if (!registry && (/^\s*%\s*IANA WHOIS server/i.test(line) || /^\s*(?:refer|whois):/i.test(line))) iana = true;
    if (iana) continue;
    const m = line.match(/^\s*(Creation Date|Registered on|Registration Time|Registration Date|Domain Create Date|created(?: on)?)\s*:\s*(.+?)\s*$/i);
    const d = m && dateOf(m[2]);
    if (d && d > '1990-01-01') (/^created(?: on)?$/i.test(m[1]) ? fallback : preferred).push(d);
  }
  return (preferred.length ? preferred : fallback).sort()[0] ?? null;
}
if (whoisFile) {
  console.log(registration(await readFile(whoisFile, 'utf8')) ?? 'null');
  process.exit(0);
}
function monthsSince(iso) {
  const now = new Date(), d = new Date(iso + 'T00:00:00Z');
  return Math.max(0, (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + now.getUTCMonth() - d.getUTCMonth() - (now.getUTCDate() < d.getUTCDate() ? 1 : 0));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let lastWayback = 0;
for (const domain of domains) {
  const reasons = [];
  let registered = null, firstSnapshot = null;
  try { registered = registration(await whois(domain, 10000)); }
  catch (e) { reasons.push(`WHOIS: ${e.killed ? 'timeout' : (e.stderr || e.message).trim().split(/\r?\n/).at(-1)}`); }
  if (!registered && !reasons.some(r => r.startsWith('WHOIS:'))) reasons.push('WHOIS: registration date unavailable');
  await sleep(Math.max(0, 1000 - (Date.now() - lastWayback)));
  lastWayback = Date.now();
  try {
    const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp`;
    let response;
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try { response = await fetch(url, { signal: controller.signal }); }
      finally { clearTimeout(timer); }
      if (![429, 503, 504].includes(response.status) || attempt === 3) break;
      await sleep(2000 * 2 ** attempt);
    }
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const data = await response.json();
    const ts = data?.[1]?.[0];
    if (typeof ts === 'string' && /^\d{8}/.test(ts)) firstSnapshot = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    else reasons.push('Wayback: no snapshot');
  } catch (e) { reasons.push(`Wayback: ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
  results.push({ domain, registered, firstSnapshot, ageMonths: registered ? monthsSince(registered) : null, note: reasons.join('; ') || '—' });
}
const output = json ? JSON.stringify(results, null, 2) : [
  '| 域名 | 注册日期 | 首次快照 | 域龄(月) | 备注 |',
  '|---|---|---|---:|---|',
  ...results.map(r => `| ${r.domain} | ${r.registered ?? 'null'} | ${r.firstSnapshot ?? 'null'} | ${r.ageMonths ?? 'null'} | ${r.note} |`),
].join('\n');
if (out) await writeFile(out, output + '\n');
else console.log(output);
