import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Keep the upstream location first, then reuse installations in other agent homes.
export function gefeiScript({ home = homedir(), env = process.env, exists = existsSync } = {}) {
  const roots = [join(home, '.claude/skills'), join(home, '.agents/skills'),
    join(env.CODEX_HOME || join(home, '.codex'), 'skills')];
  const candidates = roots.map((root) => join(root, 'gefei/scripts/webcafe.mjs'));
  return candidates.find((candidate) => exists(candidate)) || candidates[0];
}

/** 官方 gefei CLI 在有环境代理时启用 Node 的环境代理支持。 */
export function gefeiEnv(env = process.env) {
  return env.NODE_USE_ENV_PROXY === undefined
    && ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some((key) => process.env[key] !== undefined)
    ? { ...env, NODE_USE_ENV_PROXY: '1' }
    : env;
}
