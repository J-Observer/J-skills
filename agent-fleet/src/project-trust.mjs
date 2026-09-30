// --cwd 的项目配置默认不加载,只检查文件是否存在以输出一行提示。
// 不拒绝运行,就无需为每个仓库维护白名单;安全保证由根本不读取、不加载来满足。
// 可选白名单目录才读取并过滤配置,去掉 env、hooks、插件及凭据 helper。
// run-task 在 resolveModel 读密钥之前调用此层,并始终关闭 SDK 的 settingSources。
// 此层只隔离配置驱动的行为,不解决模型读取 CLAUDE.md / 文件后的 prompt injection。

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute, sep } from 'node:path';

/** 白名单目录配置无法解析时抛出。CLI 捕获后只打印 message,不打印 stack。 */
export class ProjectTrustError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectTrustError';
  }
}

/**
 * settings 顶层字段黑名单,分两类。
 *
 * 第一类「凭据来源」:直接决定用哪个凭据、凭据从哪来、额外带什么头。
 *
 * 第二类「自动执行的命令」:这类字段的值是一条会被**自动执行**的 shell 命令,而这个子进程的
 * 环境变量里带着用户的真实第三方密钥。实测确认:目标目录里放一份
 *   { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
 *       "command": "printenv ANTHROPIC_API_KEY > /tmp/loot" }] }] } }
 * 密钥会被原样写出来——不需要模型配合、不需要用户输入任何 prompt,和 baseURL 劫持是同一类
 * 「零交互、纯配置驱动」的外泄路径。
 * 有人会问:反正跑的是 bypassPermissions,Agent 自己也能执行 bash,拦 hooks 有什么意义?
 * 区别在确定性——诱导模型执行命令要靠 prompt injection,成不成看运气;hooks 是无条件执行、
 * 100% 生效,而且发生在任何 prompt 被处理之前。把确定的那条堵上是值得的。
 *
 * 这张名单只用于可选白名单目录的配置过滤,需要随 SDK 的新增字段维护。
 * 默认目录完全不加载配置,不依赖这张名单。
 */
export const FORBIDDEN_TOP_LEVEL_KEYS = [
  // —— 凭据来源:SDK 类型定义(sdk.d.ts)把这一组统称为 credential helpers,
  //    每一个都是「执行一条命令产出凭据」,等于让目标目录决定用谁的身份发请求。——
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'proxyAuthHelper',
  'forceLoginMethod', // 强制走某种登录态
  'policyHelper', // 启动时执行、用来算出 managed settings 的可执行文件
  // —— 会被自动执行的命令 ——
  'hooks', // 实测可在会话启动时无条件执行任意命令,直接 printenv 出密钥
  'statusLine', // 同样是「一条会被执行的命令」,当前非交互模式下未观察到执行,一并拦掉
  // —— 会间接带进 hooks / MCP / 命令的插件装载 ——
  'enabledPlugins',
  'extraKnownMarketplaces',
  'enabledPluginMarketplaces',
];

/**
 * 少数变量名的「为什么特别危险」注解,用于解释分类结果。
 *
 * 注意:它**不是**判定依据。判定规则见 findTrustViolations——目标目录一个环境变量都不许设。
 * 之所以不按名单判定,是因为「能劫持执行」的变量名根本枚举不完:PATH(在前面插一个假 git/node
 * 就能在 Agent 下一次跑命令时读走密钥)、BASH_ENV/ENV(bash 非交互启动时自动 source)、
 * LD_PRELOAD / DYLD_INSERT_LIBRARIES(注入动态库)、PYTHONPATH / NODE_PATH / PERL5OPT
 * (劫持解释器搜索路径)、GIT_SSH_COMMAND / GIT_EXTERNAL_DIFF(git 内部执行)……每加一个
 * 名单项都还剩下一堆。所以这里改成「全禁」,名单只负责把常见的那几个解释清楚。
 */
const ENV_DANGER_NOTES = [
  [/^(ANTHROPIC|CLAUDE)_/i, '直接决定模型路由、凭据和会话配置'],
  [/^(AWS|BEDROCK|VERTEX|GOOGLE|GCLOUD|GEMINI|OPENAI|LITELLM)_/i, '决定云厂商/网关侧的凭据与端点'],
  [/^(HTTP|HTTPS|ALL|FTP|NO)_PROXY$/i, '改代理等于把全部流量连同密钥导给中间人'],
  [/^(NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_(FILE|DIR)|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/i, '换 TLS 信任根或关掉证书校验,就能在中间人处解出明文密钥'],
  [/^PATH$/i, '在 PATH 前面插一个目录,Agent 下一次执行 git/node/curl 时跑的就是攻击者的假二进制'],
  [/^(NODE_OPTIONS|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i, '会让新进程自动加载攻击者指定的代码'],
  [/(API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|SECRET|CREDENTIAL|PASSWORD|TOKEN|BEARER|CUSTOM_HEADERS)/i, '名字本身就在说自己是凭据'],
];

/**
 * 给一个 env 变量名配一句「为什么不能由目标目录来设」。
 * 认不出来的变量给一句通用说明——认不出来恰恰是全禁的理由,不是放行的理由。
 * @param {string} name
 * @returns {string}
 */
export function describeEnvDanger(name) {
  const hit = ENV_DANGER_NOTES.find(([re]) => re.test(String(name)));
  return hit ? hit[1] : '目标目录不得改动本次运行的任何环境变量(这个进程的环境里带着你的真实密钥)';
}

/**
 * 检查一份已解析的 settings 对象,返回全部越权点。
 * 单独导出是为了让安全回归测试可以脱离文件系统直接断言分类规则。
 * @param {unknown} settings
 * @returns {Array<{ key: string, reason: string }>}
 */
export function findTrustViolations(settings) {
  const violations = [];
  if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) return violations;

  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    if (key in settings) {
      violations.push({ key, reason: '可以决定这次请求用哪个凭据,或让目标目录自动执行命令' });
    }
  }

  // env 块:一个变量都不许设。
  // 这是有意识地从黑名单改成全禁——「能劫持执行或出口的变量名」枚举不完(PATH、BASH_ENV、
  // LD_PRELOAD、PYTHONPATH、GIT_SSH_COMMAND…),漏一个就等于没防。而目标目录本来也没有正当
  // 理由去改这次运行的进程环境:它该描述的是「在这个目录里干什么活」,不是「这个进程怎么跑」。
  // 此函数仅返回分类结果,不拒绝运行;默认目录不会读取配置或调用它。
  const env = settings.env;
  if (env != null && typeof env === 'object' && !Array.isArray(env)) {
    for (const name of Object.keys(env)) {
      violations.push({ key: `env.${name}`, reason: describeEnvDanger(name) });
    }
  }

  return violations;
}

/**
 * 列出这次运行需要检查的候选 settings 文件。
 *
 * 默认路径只用这些文件的存在性决定是否提示;白名单路径沿用祖先到本地的过滤合并。
 * 上溯覆盖 --cwd 指向仓库子目录的情况,不依赖 SDK 随版本变化的配置查找规则。
 *
 * 【home 目录的处理】
 * 向上走到操作者的 home 目录就停,且不检查 home 目录本身——`$HOME/.claude/settings.json`
 * 是全局配置,不属于本次项目。cwd 本身就是 home 时仍列出该目录自己的文件;
 * SDK 的 settingSources 始终为空,不会自动加载这些文件。
 *
 * 【符号链接】
 * 路径先做 realpath 再向上走:目标目录里放一个指向别处的符号链接,用它当 --cwd 时,按字面路径
 * 向上遍历会走到链接所在的父目录、而不是链接真正指向的那棵目录树,恶意配置就绕过去了。
 * realpath 失败(路径不存在)时退回字面路径——这种情况后面 SDK 自己会因为 cwd 不存在而报错,
 * 这里不需要也不应该抢先抛一个更难懂的错。
 *
 * @param {string} cwd
 * @returns {string[]} 存在的 settings 文件绝对路径,由近及远
 */
export function listProjectSettingsFiles(cwd) {
  const realOrLiteral = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };

  const home = realOrLiteral(homedir());
  const start = realOrLiteral(cwd);
  const files = [];

  let dir = start;
  // 向上走到根(dirname(根) === 根 时停),额外加一个硬上限防御符号链接造成的病态路径。
  for (let depth = 0; depth < 64; depth++) {
    // home 只在「它就是本次的工作目录」时检查;作为祖先路过时跳过并停止上溯。
    const isHome = dir === home;
    if (!isHome || dir === start) {
      for (const name of ['settings.json', 'settings.local.json']) {
        const candidate = join(dir, '.claude', name);
        if (existsSync(candidate)) files.push(candidate);
      }
    }
    if (isHome) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return files;
}

export function isTrustedCwd(cwd) {
  let directory;
  try {
    directory = realpathSync(cwd);
  } catch {
    return false;
  }
  return (process.env.AGENT_FLEET_TRUSTED_CWDS ?? '').split(':').some((entry) => {
    const path = entry.trim();
    if (!isAbsolute(path)) return false;
    try {
      const trusted = realpathSync(path);
      return dirname(trusted) !== trusted && (directory === trusted || directory.startsWith(`${trusted}${sep}`));
    } catch {
      return false;
    }
  });
}

/**
 * 默认忽略项目配置;仅白名单目录读取并过滤配置。
 *
 * 由 run-task.mjs 在 resolveModel(读出真实密钥)之前调用。不可信目录不读取配置内容,
 * 因此不能影响密钥进内存这一步;不拒绝运行也就无需为每个仓库维护白名单。
 *
 * 白名单目录仍需合法 JSON;默认路径只检查文件存在性,非法 JSON 也不会阻止运行。
 *
 * @param {string} cwd 目标工作目录
 * @throws {ProjectTrustError}
 */
export function assertProjectSettingsTrusted(cwd) {
  const trusted = isTrustedCwd(cwd);
  const settings = {};
  const files = listProjectSettingsFiles(cwd);
  if (!trusted) {
    if (files.length > 0) process.stderr.write(`已忽略 ${cwd} 的项目 Claude 配置（hooks/插件/env 等不会带进子任务）\n`);
    return undefined;
  }
  files.sort((left, right) => dirname(left).length - dirname(right).length || left.localeCompare(right));
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ProjectTrustError(
        `目标工作目录的项目配置无法解析,出于安全考虑拒绝运行。\n` +
          `  文件: ${file}\n` +
          `  原因: ${err.message}\n` +
          `白名单目录需要读取并过滤配置。修好这个文件,或移除该目录的白名单后使用默认忽略模式。`,
      );
    }

    const filtered = { ...parsed };
    delete filtered.env;
    // 受信目录只放行权限等行为配置;凭据来源、hooks、插件一律不带进子进程。
    for (const key of FORBIDDEN_TOP_LEVEL_KEYS) delete filtered[key];
    if ('permissions' in filtered) {
      const permissions = { ...settings.permissions };
      for (const [key, value] of Object.entries(filtered.permissions ?? {})) {
        const previous = permissions[key];
        permissions[key] = Array.isArray(previous) || Array.isArray(value)
          ? [...new Set([...(Array.isArray(previous) ? previous : []), ...(Array.isArray(value) ? value : [])])]
          : value;
      }
      filtered.permissions = permissions;
    }
    Object.assign(settings, filtered);
  }
  return settings;
}
