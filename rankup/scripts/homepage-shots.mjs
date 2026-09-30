#!/usr/bin/env node
/**
 * homepage-shots.mjs —— 用用户 Chrome 批量截取竞品营销官网首屏、整页及元信息。
 *
 * 参数：--urls <逗号分隔 URL> / --file <每行一个 URL>、--out <目录>、
 *   --engine opencli|agent-browser（默认 opencli；agent-browser 仅用户点名时）、--routes <JSON 文件>、
 *   --session <名称>、--window background|dedicated|isolated（仅 opencli）、
 *   --scrolls <屏数>（整页失败时分段截图）、--delay <加载等待毫秒数>、
 *   --color-scheme light|dark（默认 light，仅 agent-browser）、
 *   --resume（跳过 manifest 中已有的成功站点并重新生成对照图）。
 * --routes 是域名到营销页绝对 URL 的映射；自动发现的营销路由也写回此文件。
 *
 * 已知坑：已登录 Chrome 访问根域名常直达工作台，可用 --routes 指定营销页。
 * agent-browser 引擎仅在用户明确点名时使用。
 * Cookie 弹窗仅拒绝或关闭；动态 Canvas、视频、长页面可能需要较长等待，
 * 整页截图失败时改为分段截图。同域名不同路径会追加路径 slug；slug 重复时追加序号。
 * OpenCLI 不支持此脚本的色彩模式设置。上次验证日期：2026-09-28。
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const BROWSER = process.env.AGENT_BROWSER_BIN ?? "agent-browser";
const PATH_APP = /\/(?:app|chat|workspace|dashboard|login|log-in|signin|sign-in|auth|home|blank)(?:\/|$)/i;
const BLOCKED = /just a moment|请稍候|attention required|access denied|403 forbidden|\b403\b|security filter|permission to access|captcha|bot verification|cloudflare|正在进行安全验证|verify you are human|checking your browser|security verification/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = {
    urls: [], file: null, routes: null,
    out: path.join(homedir(), "kollab-imagegen", "homepage-refs"),
    engine: "opencli", session: "homepage-refs", window: "dedicated",
    scrolls: 3, delay: 4000, resume: false, colorScheme: "light",
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--urls") options.urls.push(...(argv[++i] || "").split(",").map((u) => u.trim()).filter(Boolean));
    else if (["--file", "--out", "--engine", "--routes", "--session", "--window", "--color-scheme"].includes(arg)) {
      options[arg === "--color-scheme" ? "colorScheme" : arg.slice(2)] = argv[++i];
    } else if (arg === "--scrolls" || arg === "--delay") {
      options[arg.slice(2)] = Number(argv[++i]);
    } else if (!arg.startsWith("-")) options.urls.push(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && !["agent-browser", "opencli"].includes(options.engine)) throw new Error("--engine must be agent-browser or opencli");
  if (!options.help && !["light", "dark"].includes(options.colorScheme)) throw new Error("--color-scheme must be light or dark");
  if (!Number.isInteger(options.scrolls) || options.scrolls < 0 || options.scrolls > 20) throw new Error("--scrolls must be 0–20");
  if (!Number.isInteger(options.delay) || options.delay < 0) throw new Error("--delay must be a nonnegative integer");
  return options;
}

function runCommand(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM"); // Only the command spawned by this invocation.
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Timed out (${timeoutMs}ms): ${cmd} ${args.slice(-2).join(" ")}`));
      else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function checked(result, label) {
  if (result.code !== 0) throw new Error(`${label}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  return result.stdout;
}

function browser(options, session) {
  if (options.engine === "agent-browser") {
    return async (command, args = [], timeout = 60000) => checked(
      await runCommand(BROWSER, ["--session", session, command, ...args], timeout), `${command} ${args[0] || ""}`,
    );
  }
  return async (command, args = [], timeout = 60000) => checked(
    await runCommand("opencli", ["browser", session, "--window", options.window, command, ...args], timeout), `${command} ${args[0] || ""}`,
  );
}

function deriveSiteKey(urlStr) {
  const u = new URL(urlStr);
  const host = u.hostname.replace(/^www\./, "");
  let key = host.split(".")[0];
  if (host === "zapier.com" && u.pathname.includes("agents")) key = "zapier-agents";
  if (host === "notion.com" && u.pathname.includes("ai")) key = "notion-ai";
  if (host === "freepik.com" && u.pathname.includes("ai")) key = "freepik-ai";
  const slug = u.pathname.replace(/^\/+|\/+$/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `${key}-${slug}` : key;
}

const EXTRACT_SCRIPT = `(() => {
  const visible = el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 15 && rect.height > 15 && getComputedStyle(el).visibility !== 'hidden';
  };
  const text = el => (el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
  const consent = [...document.querySelectorAll('button, [role="button"]')].find(el => {
    const parent = el.closest('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i]');
    return visible(el) && (/^(reject|decline|deny|refuse|necessary only|only necessary|reject all|decline all|拒绝|不同意|仅必要|关闭)$/i.test(text(el)) ||
      (parent && (/^decline all$/i.test(text(el)) || /^(close|关闭|×|✕)$/i.test(text(el)))));
  });
  if (consent) consent.click();
  // Dismiss promotional/account-recovery overlays without choosing an auth or form action.
  for (const dialog of document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i]')) {
    if (!visible(dialog)) continue;
    const close = [...dialog.querySelectorAll('button, [role="button"], [aria-label]')].find(el =>
      visible(el) && (/^(close|dismiss|关闭|×|✕)$/i.test(text(el)) ||
      /^(close|dismiss|关闭|×|✕)$/i.test(el.getAttribute('aria-label') || '')));
    if (close) close.click();
    else dialog.querySelector('svg.lucide-x')?.parentElement?.click();
  }
  const body = text(document.body);
  const footer = document.querySelector('footer, [role="contentinfo"]');
  const inputs = [...document.querySelectorAll('input:not([type="hidden"]), textarea')]
    .filter(el => visible(el) && el.getBoundingClientRect().top < 900)
    .map(el => ({ type: el.getAttribute('type') || 'text', placeholder: el.getAttribute('placeholder') || '' }));
  const links = [...document.querySelectorAll('a[href]')]
    .filter(el => /about|product|features|pricing|solutions|platform|landing|company|learn more|了解|产品|功能|定价|关于/i.test(text(el)))
    .slice(0, 50).map(el => ({ text: text(el).slice(0, 90), href: el.href }));
  const buttons = [...document.querySelectorAll('button, a[role="button"], a.btn, a[class*="button"], a[class*="btn"], main a')]
    .filter(el => visible(el) && el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < 900 && text(el))
    .map(el => text(el).slice(0, 100)).filter((value, index, values) => values.indexOf(value) === index).slice(0, 12);
  return JSON.stringify({
    finalUrl: location.href, title: document.title || '',
    metaDesc: document.querySelector('meta[name="description"]')?.content || '',
    h1List: [...document.querySelectorAll('h1')].map(text).filter(Boolean).slice(0, 5),
    h2List: [...document.querySelectorAll('h2')].map(text).filter(Boolean).slice(0, 6),
    buttons, inputs, links,
    footerLinks: footer?.querySelectorAll('a[href]').length || 0,
    bodyLength: body.length,
    bodyExcerpt: body.slice(0, 500),
    marketingSections: document.querySelectorAll('main section, section, [class*="feature" i], [class*="testimonial" i], [class*="pricing" i]').length,
    appSignals: !!document.querySelector('[class*="sidebar" i], [class*="workspace" i], [class*="canvas" i]'),
    authDialogVisible: [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i]')].some(el =>
      visible(el) && /sign (in|up)|log ?in|注册|登录|恢复您的账户|创建账户|welcome back/i.test(text(el).slice(0, 600))),
  });
})()`;

function parseEval(output) {
  let parsed = JSON.parse(output);
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  if (!parsed || typeof parsed !== "object" || !parsed.finalUrl) throw new Error(`Incomplete browser metadata: ${output.slice(0, 200)}`);
  return parsed;
}

function classify(meta) {
  let url;
  try { url = new URL(meta.finalUrl); } catch { return "app-or-login"; }
  if (PATH_APP.test(url.pathname) && !/^(?:\/(?:[a-z]{2}\/)?home\/?|\/pricing\/?)$/i.test(url.pathname)) return "app-or-login";
  if (BLOCKED.test(meta.title) || BLOCKED.test(meta.bodyExcerpt) || /security filter|permission to access|\b403\b/i.test(meta.h1List?.join(" "))) return "app-or-login";
  if (meta.authDialogVisible) return "app-or-login";
  if (meta.appSignals && /workspace|canvas|flowith/i.test(meta.title) && meta.footerLinks === 0) return "app-or-login";
  if (/shut down|discontinued|no longer available/i.test(meta.title + " " + meta.h1List?.join(" "))) return "app-or-login";
  if (meta.bodyLength < 150 && meta.marketingSections === 0) return "app-or-login";
  const loginInputs = meta.inputs.some((input) => /password|email|tel/i.test(input.type) || /email|password|登录|sign in/i.test(input.placeholder));
  const loginOnly = loginInputs && meta.bodyLength < 500 && meta.footerLinks === 0 && meta.marketingSections === 0;
  const emptyInputPage = meta.inputs.length > 0 && meta.bodyLength < 300 && meta.footerLinks === 0 && meta.marketingSections === 0;
  if (loginOnly || emptyInputPage) return "app-or-login";
  return "marketing";
}

async function readRoutes(filename) {
  if (!filename) return {};
  try {
    const routes = JSON.parse(await readFile(filename, "utf8"));
    if (!routes || Array.isArray(routes) || typeof routes !== "object") throw new Error("expected an object");
    for (const [domain, route] of Object.entries(routes)) {
      if (typeof route !== "string" || !/^https?:\/\//.test(route)) throw new Error(`invalid route for ${domain}`);
    }
    return routes;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Invalid routes file ${filename}: ${error.message}`);
  }
}

async function inspectPage(run, options, url) {
  try {
    if (options.engine === "agent-browser") await run("open", [url]);
    else await run("open", [url, "--timeout", "30000"]);
  } catch (error) {
    // Navigation may time out on pages that keep loading; the DOM can still be usable.
    if (!/timed out/i.test(error.message)) throw error;
    console.warn(`  Navigation timeout at ${url}; inspecting the loaded DOM`);
  }
  await sleep(options.delay);
  const meta = parseEval(await run("eval", [EXTRACT_SCRIPT]));
  if (new URL(meta.finalUrl).hostname.replace(/^www\./, "") !== new URL(url).hostname.replace(/^www\./, "")) {
    console.warn(`  Redirected to ${meta.finalUrl}`);
  }
  return meta;
}

function candidates(requestedUrl, meta) {
  const origin = new URL(requestedUrl).origin;
  const host = new URL(requestedUrl).hostname;
  const urls = meta.links
    .filter(({ text, href }) => /about|product|features|pricing|solutions|platform|landing|company|了解|产品|功能|定价|关于/i.test(text + " " + href))
    .map(({ href }) => href);
  urls.push(...["/about", "/product", "/features", "/pricing", "/landing"].map((p) => origin + p));
  if (!host.startsWith("www.")) urls.push(`https://www.${host}/`);
  // 公共研究目标适配，持续支持则保留。
  if (host === "flowith.io") urls.unshift("https://flowith.io/home", "https://flowith.io/pricing/");
  if (host === "genspark.ai") urls.unshift("https://www.genspark.ai/about", "https://www.genspark.ai/pricing");
  return [...new Set(urls)].filter((candidate) => {
    try {
      const u = new URL(candidate);
      return u.protocol === "https:" && u.hostname.replace(/^www\./, "") === host.replace(/^www\./, "") && !PATH_APP.test(u.pathname);
    } catch { return false; }
  }).slice(0, 10);
}

async function discoverMarketing(run, options, requestedUrl, meta) {
  for (const candidate of candidates(requestedUrl, meta)) {
    try {
      const found = await inspectPage(run, { ...options, delay: Math.min(options.delay, 1800) }, candidate);
      if (classify(found) === "marketing" && found.bodyLength >= 300 && (found.marketingSections > 0 || found.footerLinks >= 2)) {
        console.log(`  Found marketing route: ${found.finalUrl}`);
        return { url: found.finalUrl, meta: found };
      }
    } catch (error) { console.warn(`  Route candidate ${candidate}: ${error.message.slice(0, 120)}`); }
  }
  return null;
}

async function fileExists(filename) {
  try { return (await stat(filename)).size > 0; } catch { return false; }
}

async function makeSheet(records, out) {
  const heroes = records.filter((r) => r.status === "success" && r.heroImg).map((r) => [r.heroImg, new URL(r.requestedUrl).hostname]);
  if (heroes.length === 0) return;
  const script = `import json, sys, math
from PIL import Image, ImageDraw, ImageFont, ImageOps
entries = json.loads(sys.argv[1]); target = sys.argv[2]
w, h, label, margin, cols = 480, 300, 38, 12, 3
sheet = Image.new('RGB', (cols*w+(cols+1)*margin, math.ceil(len(entries)/cols)*(h+label+margin)+margin), '#f1f2f4')
draw = ImageDraw.Draw(sheet)
try: font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 19)
except OSError: font = ImageFont.load_default()
for i, (filename, domain) in enumerate(entries):
    x = margin+(i%cols)*(w+margin); y = margin+(i//cols)*(h+label+margin)
    with Image.open(filename) as source: thumb = ImageOps.fit(source.convert('RGB'), (w, h))
    sheet.paste(thumb, (x, y))
    draw.text((x+8, y+h+8), domain, fill='#15191e', font=font)
sheet.save(target, 'JPEG', quality=88)
`;
  checked(await runCommand("python3", ["-c", script, JSON.stringify(heroes), path.join(out, "heroes-sheet.jpg")], 90000), "Pillow contact sheet");
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(`homepage-shots.mjs\n  --urls <url1,url2,...>\n  --file <path>\n  --out <dir>\n  --engine opencli|agent-browser  (default: opencli; agent-browser only when requested)\n  --routes <routes.json>         (domain -> marketing URL; discoveries saved here)\n  --resume                       (preserve successful entries in manifest)\n  --session <name>\n  --window background|dedicated|isolated  (default: dedicated; opencli only)\n  --color-scheme light|dark      (default: light; agent-browser only)\n  --scrolls <n>\n  --delay <ms>\n  --help`);
    return;
  }
  if (options.file) {
    options.urls.push(...(await readFile(options.file, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  }
  const targetUrls = [...new Set(options.urls.map((url) => new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).href))];
  if (targetUrls.length === 0) throw new Error("No URLs provided. Use --urls or --file.");
  const routes = await readRoutes(options.routes);
  await mkdir(options.out, { recursive: true });
  const manifestFile = path.join(options.out, "manifest.json");
  let previous = [];
  if (options.resume) {
    try { previous = JSON.parse(await readFile(manifestFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!Array.isArray(previous)) throw new Error("Existing manifest must be an array");
  }
  const summary = [];
  const usedKeys = new Set();
  console.log(`[homepage-shots] ${targetUrls.length} sites; engine=${options.engine}; output=${options.out}`);
  for (let idx = 0; idx < targetUrls.length; idx++) {
    const requestedUrl = targetUrls[idx];
    const host = new URL(requestedUrl).hostname.replace(/^www\./, "");
    const baseKey = deriveSiteKey(requestedUrl);
    let siteKey = baseKey, suffix = 2;
    while (usedKeys.has(siteKey)) siteKey = `${baseKey}-${suffix++}`;
    usedKeys.add(siteKey);
    const old = previous.find((entry) => entry.requestedUrl === requestedUrl);
    if (old?.status === "success" && old.routeOverride === (routes[host] || null) &&
        old.landing !== "app-or-login" && await fileExists(old.heroImg)) {
      console.log(`[${idx + 1}/${targetUrls.length}] ${host} (resumed)`);
      summary.push(old);
      await writeFile(manifestFile, JSON.stringify([...summary, ...previous.filter((entry) => !summary.some((item) => item.requestedUrl === entry.requestedUrl))], null, 2) + "\n");
      continue;
    }
    const session = options.engine === "agent-browser" ? `${options.session}-${process.pid}-${idx}` : options.session;
    const run = browser(options, session);
    const record = {
      siteKey, url: requestedUrl, requestedUrl, finalUrl: null, landing: "app-or-login",
      routeOverride: routes[host] || null,
      heroImg: path.join(options.out, `${siteKey}-hero.png`),
      fullImg: path.join(options.out, `${siteKey}-full.png`),
      metaFile: path.join(options.out, `${siteKey}-meta.json`),
      scrollImgs: [], status: "pending", error: null,
    };
    console.log(`[${idx + 1}/${targetUrls.length}] ${host} (${record.routeOverride || requestedUrl})`);
    try {
      if (options.engine === "agent-browser") {
        await run("set", ["viewport", "1440", "900"]);
        await run("set", ["media", options.colorScheme]);
        // Per-site sessions have no restore state. Clear again before the capture navigation.
        try { await run("open", [record.routeOverride || requestedUrl]); }
        catch (error) { if (!/timed out/i.test(error.message)) throw error; }
        await run("cookies", ["clear"]);
        await run("storage", ["local", "clear"]);
        await run("storage", ["session", "clear"]);
      }
      let meta = await inspectPage(run, options, record.routeOverride || requestedUrl);
      let landing = classify(meta);
      if (landing === "app-or-login" && options.engine === "agent-browser") {
        const found = await discoverMarketing(run, options, requestedUrl, meta);
        if (found) {
          routes[host] = found.url;
          record.routeOverride = found.url;
          if (options.routes) await writeFile(options.routes, JSON.stringify(routes, null, 2) + "\n");
          // Explicitly navigate back to the selected marketing route before capture.
          meta = await inspectPage(run, options, found.url);
          landing = classify(meta);
        } else if (!BLOCKED.test(meta.title + " " + meta.bodyExcerpt) &&
                   !/shut down|discontinued/i.test(meta.title + " " + meta.h1List.join(" ")) &&
                   !meta.authDialogVisible && meta.inputs.length > 0 &&
                   !/password|email/i.test(meta.inputs.map((i) => i.type).join(" "))) {
          // Search/chat products without a separate marketing site are their own homepage.
          landing = "product-is-homepage";
          meta = await inspectPage(run, options, record.routeOverride || requestedUrl);
        }
      }
      record.finalUrl = meta.finalUrl;
      record.landing = landing;
      if (landing === "app-or-login" && !BLOCKED.test(meta.title + " " + meta.bodyExcerpt) &&
          !/shut down|discontinued/i.test(meta.title + " " + meta.h1List.join(" ")) &&
          !record.routeOverride) {
        // Do not silently count a detected workspace or login page as a marketing screenshot.
        console.warn(`  No marketing route found for ${host}; retaining the reference as app-or-login`);
      }
      record.title = meta.title;
      record.h1 = meta.h1List[0] || "";
      record.buttons = meta.buttons;
      record.meta = meta;
      await writeFile(record.metaFile, JSON.stringify(meta, null, 2) + "\n");
      if (options.engine === "agent-browser") {
        await run("screenshot", [record.heroImg], 90000);
        try { await run("screenshot", ["--full", record.fullImg], 120000); }
        catch (error) { console.warn(`  Full-page screenshot unavailable: ${error.message.slice(0, 180)}`); }
      } else {
        await run("screenshot", [record.heroImg, "--width", "1440", "--height", "900"], 90000);
        try { await run("screenshot", [record.fullImg, "--width", "1440", "--full-page"], 120000); }
        catch (error) { console.warn(`  Full-page screenshot unavailable: ${error.message.slice(0, 180)}`); }
      }
      if (!(await fileExists(record.heroImg))) throw new Error("Hero screenshot missing or empty");
      if (!(await fileExists(record.fullImg))) {
        for (let s = 1; s <= options.scrolls; s++) {
          const scrollImg = path.join(options.out, `${siteKey}-s${s + 1}.png`);
          if (options.engine === "agent-browser") await run("scroll", ["down", "800"]);
          else await run("scroll", ["down", "--amount", "800"]);
          await sleep(800);
          if (options.engine === "agent-browser") await run("screenshot", [scrollImg]);
          else await run("screenshot", [scrollImg, "--width", "1440", "--height", "900"]);
          record.scrollImgs.push(scrollImg);
        }
      }
      record.status = "success";
      console.log(`  ${record.landing}: ${record.finalUrl} | ${record.h1.slice(0, 80)}`);
    } catch (error) {
      record.status = "failed";
      record.error = error.message;
      console.error(`  Failed ${siteKey}: ${error.message.slice(0, 250)}`);
    } finally {
      if (options.engine === "agent-browser" || idx === targetUrls.length - 1) {
        try { await run("close", [], 15000); }
        catch (error) { console.warn(`  Session cleanup: ${error.message.slice(0, 120)}`); }
      }
      summary.push(record);
      await writeFile(manifestFile, JSON.stringify([...summary, ...previous.filter((entry) => !summary.some((item) => item.requestedUrl === entry.requestedUrl))], null, 2) + "\n");
    }
  }
  await writeFile(manifestFile, JSON.stringify(summary, null, 2) + "\n");
  await makeSheet(summary, options.out);
  console.log(`[homepage-shots] Captured ${summary.filter((r) => r.status === "success").length}/${summary.length}; manifest and heroes-sheet.jpg in ${options.out}`);
  if (summary.some((r) => r.status !== "success")) process.exitCode = 1;
}

main().catch((error) => { console.error("Fatal error:", error.message); process.exitCode = 1; });
