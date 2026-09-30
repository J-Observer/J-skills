// 用途：环境与后台地址。参数：由上层 CLI 传入；登录态：无需浏览器登录。
// 已知坑：stg 与 prod 的 key 和 JWKS 地址独立。验证日期：2026-09-07（原流程）。
// Environment table for the Anyway Business Merchant API CLI.
//
// Selection priority (highest first):
//   1. `--env stg|prod` CLI flag
//   2. `ANYWAY_ENV` environment variable
//   3. default: `stg`
//
// `ANYWAY_API_BASE` (if set) overrides the resolved environment's `apiBase`
// directly — see lib/client.mjs.

export const ENVIRONMENTS = {
  prod: {
    name: 'prod',
    apiBase: 'https://merchant-api-prod.anyway.sh',
    keyEnvVar: 'ANYWAY_API_KEY',
    jwksUrl: 'https://api.anyway.sh/v1/webhooks/signing-key',
    dashboardUrl: 'https://app.anyway.sh/',
  },
  stg: {
    name: 'stg',
    apiBase: 'https://merchant-api-stg.anyway.sh',
    keyEnvVar: 'ANYWAY_STG_API_KEY',
    jwksUrl: 'https://webapp-api-stg.anyway.sh/v1/webhooks/signing-key',
    dashboardUrl: 'https://stg.anyway.sh/',
  },
};

export const DEFAULT_ENV = 'stg';

/**
 * Resolve the environment name from an explicit value (e.g. a `--env` flag),
 * falling back to `ANYWAY_ENV`, then `stg`. Throws on an unknown name.
 * @param {string|undefined} explicit
 * @returns {'prod'|'stg'}
 */
export function resolveEnvName(explicit) {
  const candidate = (explicit && String(explicit).trim()) || process.env.ANYWAY_ENV || DEFAULT_ENV;
  if (!ENVIRONMENTS[candidate]) {
    throw new Error(
      `Unknown env "${candidate}". Expected one of: ${Object.keys(ENVIRONMENTS).join(', ')}`
    );
  }
  return candidate;
}

export function getEnvConfig(envName) {
  return ENVIRONMENTS[envName] ?? ENVIRONMENTS[DEFAULT_ENV];
}
