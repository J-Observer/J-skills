/** 官方 gefei CLI 在有环境代理时启用 Node 的环境代理支持。 */
export function gefeiEnv(env = process.env) {
  return env.NODE_USE_ENV_PROXY === undefined
    && ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some((key) => process.env[key] !== undefined)
    ? { ...env, NODE_USE_ENV_PROXY: '1' }
    : env;
}
