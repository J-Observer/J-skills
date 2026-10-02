// 用途：Merchant API 只读请求及 key 解析。参数：由上层 CLI 传入；登录态：无需浏览器登录。
// 已知坑：stg 与 prod 的 key 和 JWKS 地址独立。验证日期：2026-09-07（原流程）。
// Thin HTTP client for the Anyway Business Merchant API.
// Docs: https://docs.anyway.sh/api-reference/merchant-api
// Auth: header `X-API-Key: <key>` (format `ak_BASE64`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENTS, DEFAULT_ENV, getEnvConfig } from './env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..', '..', '..');
let projectEnvFile;

// Default base for callers; prefer resolveApiBase().
export const BASE_URL = ENVIRONMENTS[DEFAULT_ENV].apiBase;

let activeEnvName = DEFAULT_ENV;

/** Set the environment (`'prod'|'stg'`) that apiGet()/resolveApiKey()/resolveApiBase() use by default. */
export function setActiveEnv(envName) {
  activeEnvName = envName;
}

/** Currently active environment name. */
export function getActiveEnv() {
  return activeEnvName;
}

function readEnvFileValue(varName, envPath) {
  if (!envPath || !fs.existsSync(envPath)) return null;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === varName && value) return value;
  }
  return null;
}

/**
 * Resolve the API key for an environment: env var first (`ANYWAY_API_KEY` for
 * prod, `ANYWAY_STG_API_KEY` for stg), then rankup/.env, then --env-file. Never logs the value.
 * @param {string} [envName] defaults to the active environment
 */
export function setEnvFile(file) { projectEnvFile = file; }

export function resolveApiKey(envName = activeEnvName) {
  const { keyEnvVar } = getEnvConfig(envName);
  if (process.env[keyEnvVar] && process.env[keyEnvVar].trim()) {
    return process.env[keyEnvVar].trim();
  }
  return readEnvFileValue(keyEnvVar, path.join(SKILL_ROOT, '.env')) || readEnvFileValue(keyEnvVar, projectEnvFile);
}

/**
 * Resolve the API base URL for an environment. `ANYWAY_API_BASE` (if set)
 * overrides the environment's configured base directly.
 * @param {string} [envName] defaults to the active environment
 */
export function resolveApiBase(envName = activeEnvName) {
  if (process.env.ANYWAY_API_BASE && process.env.ANYWAY_API_BASE.trim()) {
    return process.env.ANYWAY_API_BASE.trim().replace(/\/+$/, '');
  }
  return getEnvConfig(envName).apiBase;
}

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Perform a GET request against the Merchant API.
 * @param {string} pathname e.g. "/v1/orders"
 * @param {Record<string, string|number|boolean|undefined|null>} query
 */
export async function apiGet(pathname, query = {}) {
  const envName = activeEnvName;
  const { keyEnvVar } = getEnvConfig(envName);
  const apiKey = resolveApiKey(envName);
  if (!apiKey) {
    throw new ApiError(
      `No API key found for env "${envName}". Set ${keyEnvVar} env var or add it to rankup/.env or --env-file <path>.`,
      { status: 0 }
    );
  }

  const url = new URL(pathname, resolveApiBase(envName));
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  // Node fetch to merchant-api-*.anyway.sh can fail intermittently
  // (ECONNRESET during TLS via a proxy, 2026-10-02); retry transient network failures.
  let res;
  let lastErr;
  for (let attempt = 0; attempt < 8 && !res; attempt++) {
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-API-Key': apiKey,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, Math.min(400 * (attempt + 1), 2500)));
    }
  }
  if (!res) {
    const c = lastErr?.cause;
    throw new ApiError(`Network error calling ${url.pathname}: ${lastErr?.message}${c ? ` (${c.code || ''} ${c.message || ''})` : ''}`, { status: 0 });
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiError(
        `401 Unauthorized (env: ${envName}) — API key missing/invalid/revoked. Check ${keyEnvVar} or rankup/.env or --env-file <path>.\nResponse: ${text}`,
        { status: 401, body: json ?? text }
      );
    }
    const errMsg = json?.error?.message || json?.message || text || res.statusText;
    throw new ApiError(`HTTP ${res.status}: ${errMsg}`, { status: res.status, body: json ?? text });
  }

  if (json && typeof json === 'object' && 'success' in json) {
    if (json.success === false) {
      const errMsg = json.error?.message || json.message || 'Request failed';
      throw new ApiError(`API error: ${errMsg}`, { status: res.status, body: json });
    }
    return json.data;
  }

  return json;
}
