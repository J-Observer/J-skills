#!/usr/bin/env node
// 用途：在已登录后台创建一次性或月/年订阅商品与支付链接，再用只读 Merchant API 复核。
// 参数：--name --description --price --currency --success-url [--type one-time|subscription] [--interval month|year] [--dry-run] [--env stg|prod] [--env-file <path>] [--session anyway-dashboard] [--json]。
// 登录态：OpenCLI 已连接用户浏览器，且当前环境的商户后台已登录；复核需要相应 API key。
// 已知坑：商品表单没有 cancel URL；提交即发布并创建支付链接；已归档同名商品不阻止重建。验证日期：2026-09-29。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEnvName, getEnvConfig } from '../lib/env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANYWAY_DIR = path.dirname(__dirname); // shared Anyway tool
const ANYWAY_CLI = path.join(ANYWAY_DIR, 'anyway.mjs');

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

const NAME = flags.name;
const DESCRIPTION = flags.description;
const PRICE = String(flags.price ?? '');
const CURRENCY = flags.currency || 'USD';
const SUCCESS_URL = flags['success-url'] || '';
const TYPE = flags.type || 'one-time';
const INTERVAL = flags.interval || 'month';
const DRY_RUN = !!flags['dry-run'];

const SESSION = flags.session || 'anyway-dashboard';
const WINDOW = flags.window || 'dedicated';
const JSON_OUT = !!flags.json;
const ENV = resolveEnvName(flags.env);
const ENV_CONFIG = getEnvConfig(ENV);
const DASHBOARD_BASE = ENV_CONFIG.dashboardUrl.replace(/\/$/, '');

function log(...args) {
  if (!JSON_OUT) console.error(...args);
}

function runAnywayApi(args) {
  const out = execFileSync('node', [ANYWAY_CLI, '--env', ENV, ...(flags['env-file'] ? ['--env-file', flags['env-file']] : []), ...args, '--json'], {
    cwd: ANYWAY_DIR,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function runOpencliBrowser(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync('opencli', ['browser', SESSION, ...args, '--window', WINDOW], {
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

function findExistingProduct(name) {
  const res = runAnywayApi(['products', 'list', '--all']);
  const records = res.records || [];
  return records.find((p) => p.name === name && p.status !== 'ARCHIVED') || null;
}

function getLinks(productId) {
  return runAnywayApi(['products', 'links', productId]);
}

async function main() {
  if (!NAME || !DESCRIPTION || !PRICE) throw new Error('usage: --name --description --price required');
  if (!['one-time', 'subscription'].includes(TYPE)) throw new Error('--type must be one-time or subscription');
  if (!['month', 'year'].includes(INTERVAL) || (TYPE !== 'subscription' && flags.interval)) throw new Error('--interval month|year requires --type subscription');

  if (DRY_RUN) {
    console.log(JSON.stringify({ env: ENV, name: NAME, description: DESCRIPTION, price: PRICE, currency: CURRENCY, type: TYPE, ...(TYPE === 'subscription' ? { interval: INTERVAL } : {}), successUrl: SUCCESS_URL, create: false }, null, 2));
    return;
  }

  checkDoctor();

  log(`[check] looking for an existing product named "${NAME}" via Merchant API...`);
  let product = findExistingProduct(NAME);

  if (product) {
    log(`[skip] product "${NAME}" already exists (id=${product.id}, status=${product.status}). Not creating again.`);
  } else {
    log(`[create] no existing product named "${NAME}" — driving the browser to create it.`);
    log(`[browser] session="${SESSION}" opening ${DASHBOARD_BASE}/products/new`);

    runOpencliBrowser(['open', `${DASHBOARD_BASE}/products/new`]);

    // Fields addressed by CSS id/attribute selectors — stable across
    // re-renders, unlike numeric state refs (which reflow on every dialog
    // open/close and go stale mid-script; see opencli skill session-laws).
    runOpencliBrowser(['fill', '#product-name', NAME]);
    runOpencliBrowser(['fill', '#product-description', DESCRIPTION]);

    runOpencliBrowser(['click', '--text', TYPE === 'subscription' ? '订阅' : '一次性', '--nth', '0']);
    if (TYPE === 'subscription') {
      runOpencliBrowser(['click', '[role=combobox]']);
      runOpencliBrowser(['click', '--role', 'option', '--name', INTERVAL === 'year' ? '每年' : '每月']);
      let selected;
      for (let attempt = 0; attempt < 3; attempt++) {
        selected = runOpencliBrowser(['get', 'text', '[role=combobox]'], { allowFail: true });
        if (selected.value) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (selected.value?.trim() !== (INTERVAL === 'year' ? '每年' : '每月')) {
        throw new Error(`billing interval was not selected: expected ${INTERVAL}, got ${selected.value || 'unknown'}`);
      }
    }

    if (CURRENCY !== 'USD') {
      runOpencliBrowser(['click', '[aria-label=币种]']);
      runOpencliBrowser(['click', `[role=menuitem]:has-text(${CURRENCY})`], { allowFail: true });
    }

    // Price is a plain number input with no id — target by placeholder.
    runOpencliBrowser(['type', 'input[placeholder="输入价格"]', PRICE]);

    if (SUCCESS_URL) {
      runOpencliBrowser(['fill', '#payment-link-success-url', SUCCESS_URL]);
    }

    log('[browser] submitting form...');
    runOpencliBrowser(['click', '--role', 'button', '--name', '创建产品']);

    // Give the create + auto-publish + auto-link-creation round trip a moment.
    await new Promise((r) => setTimeout(r, 2500));

    log('[verify] polling Merchant API for the new product...');
    for (let attempt = 0; attempt < 5 && !product; attempt++) {
      product = findExistingProduct(NAME);
      if (!product) await new Promise((r) => setTimeout(r, 1500));
    }

    if (!product) {
      console.error(
        '[error] product creation was submitted but the Merchant API does not show it yet. ' +
          'Check the browser (session "' + SESSION + '") for a validation error or a merchant-review gate.',
      );
      throw new Error('Merchant API does not show the submitted product');
    }

    log(`[ok] product created: id=${product.id} status=${product.status}`);
  }

  const links = getLinks(product.id);
  const result = { product, links };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`product: ${product.name} (${product.id}) — ${product.status}`);
    for (const link of links) {
      console.log(
        `  link: ${link.linkId} — ${link.amount} ${link.currency} · ${link.pricingType} · ` +
          `${DASHBOARD_BASE}/pay/${link.linkId}` +
          (link.successUrl ? ` · success=${link.successUrl}` : ''),
      );
    }
  }
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exitCode = 1;
}).finally(() => {
  runOpencliBrowser(['close'], { allowFail: true });
});
