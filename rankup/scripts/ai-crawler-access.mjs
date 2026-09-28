#!/usr/bin/env node
/**
 * 检查正式站点对 AI 爬虫的实际可访问性。用法：--url <站点根> [--paths /,/en/,...]。
 * 默认检查首页、robots.txt、llms.txt 与 sitemap 中第一个内页。
 * 已知坑：Cloudflare Block AI Bots 可直接返回 403，robots.txt 放行也不能证明可访问。
 * 已验证：2026-09-28。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agents = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User',
  'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended',
  'Applebot-Extended', 'CCBot', 'Bytespider', 'Amazonbot', 'meta-externalagent',
];

function argumentsFrom(argv) {
  const urlIndex = argv.indexOf('--url');
  if (urlIndex < 0 || !argv[urlIndex + 1]) throw new Error('用法：--url <站点根> [--paths /,/en/,...]');
  const origin = new URL(argv[urlIndex + 1]);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('只接受 HTTP(S) 站点');
  const pathsIndex = argv.indexOf('--paths');
  const paths = pathsIndex < 0 ? null : (argv[pathsIndex + 1] || '').split(',');
  if (paths?.some(path => !path.startsWith('/') || path.startsWith('//'))) throw new Error('--paths 必须是本站以 / 开头的路径列表');
  return { origin: origin.origin, paths };
}

async function get(url, agent) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': agent }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: response };
  } catch (error) {
    return { status: 'ERR', error: error.message };
  }
}

function blockedByRobots(body, agent) {
  let names = [];
  let directives = [];
  function blocked() {
    return names.some(name => name === '*' || name.toLowerCase() === agent.toLowerCase()) && directives.some(line => /^disallow\s*:\s*\/\s*$/i.test(line));
  }
  for (const raw of `${body}\nUser-agent: end`.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line && names.length) {
      if (blocked()) return true;
      names = [];
      directives = [];
      continue;
    }
    if (/^user-agent\s*:/i.test(line)) {
      if (directives.length) {
        if (blocked()) return true;
        names = [];
        directives = [];
      }
      names.push(line.split(':').slice(1).join(':').trim());
    } else if (line && names.length) directives.push(line);
  }
  return false;
}

async function firstInnerPage(origin) {
  const sitemap = await get(`${origin}/sitemap.xml`, 'Mozilla/5.0');
  if (sitemap.status !== 200) return null;
  const xml = await sitemap.body.text();
  for (const match of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
    try {
      const page = new URL(match[1].replaceAll('&amp;', '&'));
      if (page.origin === origin && page.pathname !== '/' && !page.pathname.endsWith('.xml')) return `${page.pathname}${page.search}`;
    } catch { /* malformed sitemap entry */ }
  }
  return null;
}

async function main() {
  const { origin, paths: requested } = argumentsFrom(process.argv.slice(2));
  const inner = requested ? null : await firstInnerPage(origin);
  const paths = [...new Set([...(requested || ['/', ...(inner ? [inner] : [])]), '/robots.txt', '/llms.txt'])];
  let failed = !requested && !inner;
  if (failed) console.error('sitemap 未找到站内内页；请用 --paths 明确指定。');
  const robots = await get(`${origin}/robots.txt`, 'Mozilla/5.0');
  const robotsText = robots.status === 200 ? await robots.body.text() : '';
  console.log('| UA | 路径 | 状态 | 结果 |\n|---|---|---:|---|');
  for (const agent of agents) {
    const disallowed = blockedByRobots(robotsText, agent);
    for (const path of paths) {
      const { status } = await get(new URL(path, origin), agent);
      const note = path === '/llms.txt' && status === 404 ? '缺少 llms.txt（非拦截）' : status === 200 ? '通过' : '失败';
      if (status !== 200 && !(path === '/llms.txt' && status === 404)) failed = true;
      console.log(`| ${agent} | ${path} | ${status} | ${note} |`);
    }
    if (disallowed) {
      failed = true;
      console.error(`robots.txt 禁止 ${agent}: Disallow: /`);
    }
  }
  if (robots.status !== 200) failed = true;
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv.includes('--self-test')) {
    const { strict: assert } = await import('node:assert');
    assert.equal(blockedByRobots('User-agent: *\nDisallow: /\n', 'GPTBot'), true);
    assert.equal(blockedByRobots('User-agent: ClaudeBot\nDisallow: /\n', 'GPTBot'), false);
    assert.equal(blockedByRobots('User-agent: GPTBot\nAllow: /\n', 'GPTBot'), false);
    console.log('ai-crawler-access self-test passed');
  } else main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

export { blockedByRobots };
