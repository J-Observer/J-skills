#!/usr/bin/env node
/**
 * google-oauth-client.mjs —— 配置 Google OAuth 2.0 Web Client（含 consent
 * screen / 品牌配置），停在创建按钮前；用户手点创建后，另行读取成功弹窗并
 * 写入目标 Worker。驱动用户已登录的 Chrome（OpenCLI）。
 *
 * ── 研究结论：没有 API/gcloud 能建标准 Web OAuth client（2026-09-29 核实）──
 *
 * `gcloud iam oauth-clients` 管的是 Workforce Identity Federation（外部 IdP
 * 登录 GCP 本身），不是给自家网站用的「Sign in with Google」client。
 * `gcloud iap oauth-clients create projects/<num>/brands/<id>` 管的是
 * Identity-Aware Proxy 专用 brand 下的 client，作用域被锁定在 IAP 资源上，
 * 不能拿来当通用 Web app 的登录 client。除此之外 Google 没有公开 REST API
 * 或 gcloud 命令能创建「APIs & Services → Credentials → OAuth 2.0 Client ID
 * （Web application）」这一类标准凭据 —— 这是 Google 自己认下的限制
 * （console-only），Terraform 的 google provider 也没有对应资源。
 * 结论：只能通过 Console UI 创建，最后的「创建」需用户手点。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *
 *   node google-oauth-client.mjs \
 *     --project my-app | --project new:my-app \
 *     --name "My App" \
 *     --origins https://my-app.<account>.workers.dev,https://example.com,https://www.example.com,http://localhost:3000 \
 *     --redirect-path /api/auth/google/callback \
 *     [--app-name "My App"] [--publish] \
 *     --session oauth-my-app --stop-before-create --commit
 *   # 在保留的浏览器标签页手点「创建」后：
 *   node google-oauth-client.mjs --capture --session oauth-my-app \
 *     --worker-dir /path/to/apps/web [--write-dev-vars] --commit
 *
 * 默认 **dry-run**：只打印将要执行的计划（项目解析结果、consent screen 要
 * 补的字段、要加的 origins/redirect URIs、要跑的 wrangler 命令），不碰任何
 * 外部状态。只有传 `--commit` 才真正执行。
 *
 * 参数：
 *   --project <id|new:名字>   已存在的 GCP project id，或 `new:<project 名>`
 *                             现建一个（project id 由 Google 按名字派生，
 *                             脚本会读回真实 id）。
 *   --name <名称>             OAuth client 的显示名（只在 Console 里可见）。
 *   --origins <逗号分隔>      Authorized JavaScript origins 的完整 origin
 *                             （`https://host[:port]`，不带路径）。同一批
 *                             host 也用来算 Authorized redirect URIs 和
 *                             consent screen 的「已获授权的网域」。
 *   --redirect-path <path>   追加到每个 origin 后面拼成 redirect URI，
 *                             默认 `/api/auth/google/callback`。
 *   --app-name <名称>        consent screen 的应用名，默认等于 --name。
 *   --support-email <邮箱>   consent screen 用户支持邮箱；不传则自动选
 *                             该 Google 账号下拉里唯一/第一个选项。
 *   --publish                consent screen 建完后从「测试」推到「正式版」
 *                             （External、仅基础 scope 时不需要人工审核）。
 *                             不传则保持「测试」，client 仍然可以正常创建
 *                             和使用，只是仅测试用户能登录。
 *   --worker-dir <路径>      --capture 时的 Worker 项目目录。
 *   --write-dev-vars        --capture 时额外写入 .dev.vars。
 *   --session <名>           OpenCLI 会话名，默认
 *                             `oauth-client-<8位随机>`（不用 `$$`，见
 *                             opencli Skill 会话纪律）。
 *   --stop-before-create    填好 client 表单后停下，保留标签页。
 *   --capture               从同一会话的成功弹窗读取凭据并写入 Worker。
 *   --commit                 真正执行；不传就是 dry-run。
 *
 * ── 已知限制（2026-09-29 实测）───────────────────────────────
 *
 * 自动点击「创建 OAuth 客户端」连续 7 次被拒，用户手点一次成功。
 * 因此脚本只填表，保留页面供用户手点；--capture 读取成功弹窗。
 *
 * ── 品牌页「已获授权的网域」踩坑（已验证）────────────────────────────
 *
 * consent screen 的「发布应用」按钮初始是禁用的，errorless 提示只说
 * 「如需发布应用，您必须在品牌页面中完成配置」，不说具体缺什么字段。
 * 实测：只填 App name + 支持邮箱 + 开发者联系邮箱 + 一个 authorized
 * domain 仍然禁用；补上「应用首页」链接后 disabled 消失。本脚本因此在
 * --publish 时自动把 origins 里第一个 https 域名派生出 homepage/privacy/
 * terms 三个链接（`<origin>`、`<origin>/privacy`、`<origin>/terms`），
 * 不要求这些路径当下就存在真实页面 —— Google 在「测试」/未验证阶段不校验
 * 可达性，只校验「填了」。上线前请把 /privacy 和 /terms 换成真实页面。
 *
 * ── OpenCLI 使用要点（写脚本时踩过的坑，供复用）──────────────────────
 *
 *  1. 所有 OpenCLI 调用显式传 `--window dedicated`，使用专用窗口，
 *     不借用用户当前窗口；池满时保留 `dedicated-pool-exhausted` 错误。
 *  2. Google Auth Platform 这几个页面（/auth/overview、/auth/branding、
 *     /auth/audience、/auth/clients/*）会让 OpenCLI 的 `find`/`state`
 *     （用来built accessibility 快照）稳定抛
 *     `TypeError: object is not a function`（页面自身 Angular 路由代码
 *     覆盖了 `HTMLAnchorElement.prototype.getAttribute`，与 OpenCLI 的
 *     无障碍角色计算撞车）。本脚本因此全程只用 `eval` + 原生 DOM 查询
 *     （`document.querySelectorAll` 按文字/id 定位），不调 `find`/`state`。
 *  3. 多步向导「看起来没反应」时不要无脑重试，先去客户端列表确认。
 *
 * ── 2026-10-02 Console 实测踩坑（已在脚本里修掉，改动前请先读）────────────
 *
 *  A. 顶栏全局搜索框也是 `<input>` 和 `[role=combobox]`，且排在页面最前。
 *     旧脚本用 `querySelector('input')` 判定「向导已加载」（立刻为真）、
 *     用 `querySelector('[role=combobox]')` 点支持邮箱下拉（点到了搜索框），
 *     结果第 1 步「用户支持邮箱」没选，「下一步」只触发校验不前进；而后面
 *     每一步的「下一步」和最终的「创建」按钮在 DOM 里都一直可见，脚本就这样
 *     连点到底，最后只报「consent screen 创建似乎未成功」。现在：按字段标签
 *     找可见 input、支持邮箱下拉用 `cfc-select`，且每一步点完都校验下一步的
 *     专属元素确实可见，卡住时 bail 并附当前页面文字。
 *  B. 向导 4 步：应用信息 → 受众群体（External）→ 联系信息（chip 输入框，
 *     失焦即提交 chip，无需回车）→ 完成（勾选同意，按钮是「继续」，再点
 *     「创建」）。联系信息步只点一次「下一步」，第二次点会找不到按钮。
 *  C. 「已获授权的网域」必须是顶级专用域名（可注册域，按 Public Suffix List）：
 *     `www.example.com` 与 `my-app.<account>.workers.dev` 会报
 *     「域名无效：必须为顶级专用域名」，`example.com` 和
 *     `<account>.workers.dev` 通过，裸 `workers.dev` 不通过。旧脚本把
 *     origin 的 host 原样当域名，保存会失败。现在先折算成可注册域，页面仍报
 *     错的行会被删除并跳过（打印警告）。
 *  D. 客户端创建页偶发「加载失败 / 重试」（同一跟踪编号，重新 open 同一 URL
 *     不会重新加载），要点页面上的「重试」。`open`/`waitFor` 已自动处理。
 *  E. 创建页里 `id` 含 `mat-input-` 的 input 也包括顶栏搜索框
 *     （`mat-input-OneCloudBarMicroUi__…`），旧脚本按这个过滤会把 origins
 *     整体错位一格。现在只取可见的 type=text 输入框，按 DOM 顺序：名称、
 *     N 个 JS origins、M 个 redirect URIs。
 *  F. 向导只在 consent screen 未配置时可用；已配置时访问 /auth/overview/create
 *     会被重定向到 /auth/overview，所以重跑脚本是幂等的（跳过向导）。
 *  G. 发布到正式版后「目标对象」页出现「返回测试版」按钮；以此判断是否已发布。
 *  H. Console 界面语言必须是简体中文（脚本按中文按钮/标签定位）。
 */

import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// ───────────────────────── 参数解析 ─────────────────────────

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
  usage()
  process.exit(argv.length === 0 ? 1 : 0)
}

const opt = {
  project: null,
  name: null,
  origins: [],
  redirectPath: "/api/auth/google/callback",
  appName: null,
  supportEmail: null,
  publish: false,
  workerDir: null,
  session: `oauth-client-${randomBytes(4).toString("hex")}`,
  capture: false,
  writeDevVars: false,
  commit: false,
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--project" && argv[i + 1]) { opt.project = argv[++i]; continue }
  if (a === "--name" && argv[i + 1]) { opt.name = argv[++i]; continue }
  if (a === "--origins" && argv[i + 1]) { opt.origins = argv[++i].split(",").map(s => s.trim()).filter(Boolean); continue }
  if (a === "--redirect-path" && argv[i + 1]) { opt.redirectPath = argv[++i]; continue }
  if (a === "--app-name" && argv[i + 1]) { opt.appName = argv[++i]; continue }
  if (a === "--support-email" && argv[i + 1]) { opt.supportEmail = argv[++i]; continue }
  if (a === "--publish") { opt.publish = true; continue }
  if (a === "--worker-dir" && argv[i + 1]) { opt.workerDir = argv[++i]; continue }
  if (a === "--session" && argv[i + 1]) { opt.session = argv[++i]; continue }
  if (a === "--stop-before-create") continue // 第一阶段也是默认执行方式
  if (a === "--capture") { opt.capture = true; continue }
  if (a === "--write-dev-vars") { opt.writeDevVars = true; continue }
  if (a === "--commit") { opt.commit = true; continue }
  if (a === "-h" || a === "--help") { usage(); process.exit(0) }
  console.error(`未知参数: ${a}`); usage(); process.exit(1)
}

if (!opt.capture && !opt.project) { console.error("错误：需要 --project <id|new:名字>"); process.exit(1) }
if (!opt.capture && !opt.name) { console.error("错误：需要 --name <client 名称>"); process.exit(1) }
if (!opt.capture && opt.origins.length === 0) { console.error("错误：需要 --origins <逗号分隔的 origin 列表>"); process.exit(1) }
for (const o of opt.origins) {
  if (!/^https?:\/\/[^/]+$/.test(o)) { console.error(`错误：origin 必须是不带路径的 "协议://host[:port]" 形式，收到: ${o}`); process.exit(1) }
}
if (!opt.appName) opt.appName = opt.name
const isNewProject = opt.project?.startsWith("new:") || false
const newProjectName = isNewProject ? opt.project.slice(4) : null

function usage() {
  console.log(`用法:
  node google-oauth-client.mjs --project <id|new:名字> --name <client名> \\
    --origins <逗号分隔 origin> [--redirect-path /api/auth/google/callback] \\
    [--app-name 名称] [--support-email user@example.com] [--publish] \\
    [--session 名] [--stop-before-create] [--commit]
  node google-oauth-client.mjs --capture --session <同一会话名> \\
    --worker-dir <dir> [--write-dev-vars] [--commit]

默认 dry-run，只打印计划。--commit 才真正执行。详见文件头注释。`)
}

// ───────────────────────── OpenCLI 封装 ─────────────────────────

function cli(args, { timeout = 30000 } = {}) {
  try {
    return execFileSync("opencli", ["browser", opt.session, "--window", "dedicated", ...args],
      { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e) {
    const err = (e.stderr?.toString() || e.stdout?.toString() || e.message || "").trim()
    throw new Error(`opencli 失败 (${args[0]}): ${err.slice(0, 800)}`)
  }
}
function evalJs(js) { return cli(["eval", `(()=>{${DOM}${js}})()`], { timeout: 45000 }) }
function pageText(max = 6000) {
  try { return JSON.parse(evalJs(`return JSON.stringify((document.body.innerText||"").slice(0,${max}))`)) }
  catch { return evalJs(`return (document.body.innerText||"").slice(0,${max})`) }
}
function settle(ms) {
  cli(["eval", `(async()=>{await new Promise(r=>setTimeout(r,${ms}));return true})()`], { timeout: ms + 30000 })
}

/** 页面里公共的 DOM 小工具（以字符串拼进 eval）。顶栏全局搜索框也是 input /
 *  role=combobox，所以一律按「可见 + 标签文字」找，不用裸 querySelector('input')。 */
const DOM = `
  const vis = e => !!e && e.getClientRects().length > 0;
  const fieldText = i => ((i.closest('mat-form-field, .mat-mdc-form-field, cfc-form-field')||{}).innerText||'').trim();
  const inputByLabel = label => Array.from(document.querySelectorAll('input'))
    .find(i => vis(i) && i.type !== 'search' && fieldText(i).startsWith(label));
  const btnByText = text => Array.from(document.querySelectorAll('button'))
    .filter(b => vis(b) && b.innerText.trim() === text);
`
/** 控制台偶发「加载失败 / 重试」页（同一跟踪编号，重新 open 同 URL 不会重载），
 *  必须点页面上的「重试」。返回是否点了。 */
function retryIfLoadFailed() {
  const r = evalJs(`
    const t = document.body.innerText || '';
    if (!/加载失败|时出错。请重试/.test(t)) return 'NO';
    const b = Array.from(document.querySelectorAll('button, a')).find(x => x.innerText.trim() === '重试');
    if (!b) return 'NO_BUTTON';
    b.click();
    return 'RETRIED';
  `)
  return r === "RETRIED"
}
function open(url) {
  cli(["open", url], { timeout: 45000 })
  settle(1500)
}
function waitFor(predicateJs, seconds = 20) {
  const deadline = Date.now() + seconds * 1000
  let retries = 0
  while (Date.now() < deadline) {
    try {
      if (String(evalJs(predicateJs)).includes("true")) return true
      if (retries < 4 && retryIfLoadFailed()) { retries++; settle(3000); continue }
    } catch { /* 导航中，继续等 */ }
    settle(600)
  }
  return false
}

/** 原生 setter 写 input.value 并派发 input/change/blur —— Angular Material
 *  受控输入必须这样写才会被框架捕获，直接赋值不会触发校验/保存按钮启用。 */
function fillInputById(id, value) {
  const v = JSON.stringify(value)
  evalJs(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) throw new Error('找不到 input#${id}');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${v});
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    el.dispatchEvent(new Event('blur', {bubbles:true}));
    return el.value;
  `)
}
/** 按标签文字（字段容器文字以它开头）找到可见 input 的 id，没有返回空串。 */
function inputIdByLabel(label) {
  return evalJs(`const el = inputByLabel(${JSON.stringify(label)}); return el ? el.id : '';`)
}
/** 按可见文字点按钮；找不到/全部禁用抛错，多个取第一个可用的。 */
function clickButtonByText(text) {
  const r = evalJs(`
    const cands = btnByText(${JSON.stringify(text)});
    if (!cands.length) return 'NOT_FOUND';
    const b = cands.find(x => !x.disabled && x.getAttribute('aria-disabled') !== 'true');
    if (!b) return 'DISABLED';
    b.click();
    return 'OK';
  `)
  if (r === "NOT_FOUND") throw new Error(`按钮未找到: "${text}"`)
  if (r === "DISABLED") throw new Error(`按钮被禁用: "${text}"`)
  return r
}
function buttonState(text) {
  return evalJs(`
    const cands = btnByText(${JSON.stringify(text)});
    if (!cands.length) return JSON.stringify({found:false});
    const b = cands[0];
    return JSON.stringify({found:true, disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled')});
  `)
}

// ───────────────────────── 计划打印（dry-run） ─────────────────────────

function hostOf(origin) { return new URL(origin).hostname }
function redirectUris() { return opt.origins.map(o => o.replace(/\/$/, "") + opt.redirectPath) }

// 「已获授权的网域」只收顶级专用域名（可注册域，按 Public Suffix List）：
// www.example.com、foo.bar.workers.dev、裸 workers.dev 都会被 Console 拒绝，
// bar.workers.dev 和 example.com 可以。这里内置常见的多段公共后缀；漏掉的
// 后缀由 ensureBrandingAndPublish 在页面报错时兜底（删除该行并跳过）。
const MULTI_LABEL_SUFFIXES = new Set([
  // 私有后缀（PSL 私有区）：用户的子域本身就是可注册域
  "workers.dev", "pages.dev", "vercel.app", "netlify.app", "github.io", "gitlab.io",
  "herokuapp.com", "web.app", "firebaseapp.com", "appspot.com", "onrender.com",
  "fly.dev", "deno.dev", "glitch.me", "repl.co", "pythonanywhere.com",
  "ngrok.io", "ngrok-free.app", "trycloudflare.com", "azurewebsites.net",
  // 常见 ccTLD 二级
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "ne.jp",
  "or.jp", "com.cn", "net.cn", "org.cn", "com.hk", "com.tw", "co.kr", "co.in", "com.br",
  "com.mx", "co.nz", "co.za", "com.sg", "com.my", "com.tr",
])
/** host → 可注册域；裸后缀 / 非域名（IP、localhost）返回 null。 */
function registrableDomain(host) {
  const labels = host.toLowerCase().split(".").filter(Boolean)
  if (labels.length < 2 || /^[\d.]+$/.test(host)) return null
  const last2 = labels.slice(-2).join(".")
  const suffixLen = MULTI_LABEL_SUFFIXES.has(last2) ? 2 : 1
  if (labels.length <= suffixLen) return null
  return labels.slice(-(suffixLen + 1)).join(".")
}
function authorizedDomains() {
  const out = new Set()
  for (const o of opt.origins.filter(o => o.startsWith("https://"))) {
    const d = registrableDomain(hostOf(o))
    if (d) out.add(d)
  }
  return [...out]
}

function printPlan() {
  console.log("=== dry-run 计划（不会执行，加 --commit 才会真正操作）===")
  console.log(`GCP project     : ${isNewProject ? `新建 "${newProjectName}"` : opt.project}`)
  console.log(`Client 类型      : Web application`)
  console.log(`Client 名称      : ${opt.name}`)
  console.log(`Consent app 名   : ${opt.appName}`)
  console.log(`支持邮箱         : ${opt.supportEmail || "(自动选账号下拉里的第一项)"}`)
  console.log(`Authorized 来源  :`)
  for (const o of opt.origins) console.log(`  - ${o}`)
  console.log(`Redirect URIs   :`)
  for (const u of redirectUris()) console.log(`  - ${u}`)
  console.log(`Authorized 网域  : ${authorizedDomains().join(", ") || "(无 https origin，跳过)"}`)
  console.log(`发布到正式版     : ${opt.publish ? "是" : "否（保持测试状态）"}`)
  if (opt.workerDir) {
    console.log(`Worker 目录      : ${opt.workerDir}`)
    console.log(`捕获阶段将执行   : wrangler secret put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET`)
    if (opt.writeDevVars) console.log(`                   写入 ${opt.workerDir}/.dev.vars`)
  } else {
    console.log(`Worker 目录      : (未提供 --worker-dir，不会碰 wrangler secrets / .dev.vars)`)
  }
  console.log("将填好 Web client 表单并停在「创建」按钮前，用户手点后用 --capture 读取成功弹窗。")
}

if (!opt.commit) {
  if (opt.capture) {
    console.log("=== dry-run 计划（不会执行）===")
    console.log("从现有成功弹窗读取 Client ID / Secret，使用 stdin 写入两个 Wrangler secret。")
    if (opt.writeDevVars) console.log("另写入 .dev.vars。")
  } else printPlan()
  process.exit(0)
}

// ───────────────────────── 执行（--commit） ─────────────────────────

/** 失败时保留标签页（旧版直接关会话，现场证据全没了），并附上当前页面文字。 */
function bail(msg) {
  console.error(msg)
  if (!opt.capture) {
    try {
      const url = evalJs(`return location.href`)
      console.error(`当前页面: ${url.replace(/[?#].*$/, "")}`)
      console.error(`页面文字(前 500 字): ${pageText(500).replace(/\s+/g, " ")}`)
    } catch { /* ignore */ }
    console.error(`标签页已保留；检查完后关闭: opencli browser ${opt.session} close`)
  }
  process.exit(1)
}

/** 读回真实 project id：GCP 按项目名派生 id（可能带数字后缀），URL 里的 `?project=`
 *  只认 id。读不到就退回传入值。 */
function readProjectId(candidate) {
  try {
    open(`https://console.cloud.google.com/iam-admin/settings?project=${encodeURIComponent(candidate)}`)
    const sel = `Array.from(document.querySelectorAll('input')).find(i => vis(i) && /^项目 ID/.test(fieldText(i) || (i.parentElement?.parentElement?.innerText||'').trim()))`
    if (!waitFor(`const el = ${sel}; return !!el && !!el.value`, 30)) return candidate
    const id = evalJs(`const el = ${sel}; return el.value`).trim()
    return /^[a-z][a-z0-9-]{4,29}$/.test(id) ? id : candidate
  } catch { return candidate }
}

function resolveProject() {
  if (!isNewProject) {
    const real = readProjectId(opt.project)
    console.log(`GCP project id: ${real}${real !== opt.project ? `（传入 ${opt.project}）` : ""}`)
    return real
  }
  console.log(`创建新 GCP project: ${newProjectName} ...`)
  open("https://console.cloud.google.com/projectcreate")
  if (!waitFor(`return !!inputByLabel('项目名称')`, 30)) bail("项目创建页未加载出「项目名称」输入框")
  fillInputById(inputIdByLabel("项目名称"), newProjectName)
  settle(500)
  clickButtonByText("创建")
  // Google 项目创建是异步的；用「访问 welcome?project=<name>」并检查项目切换器
  // 文案里是否变成这个名字来判定，而不是等 URL 跳转（创建成功后往往留在原页面）。
  let confirmed = false
  for (let i = 0; i < 20 && !confirmed; i++) {
    settle(3000)
    try {
      open(`https://console.cloud.google.com/welcome?project=${encodeURIComponent(newProjectName)}`)
      settle(1500)
      const label = evalJs(`
        const btn = document.querySelector('[aria-label*="目前正在"], [aria-label*="Currently in"]');
        return btn ? btn.getAttribute('aria-label') : '';
      `)
      if (label.includes(newProjectName)) confirmed = true
    } catch { /* 导航中，继续轮询 */ }
  }
  if (!confirmed) bail(`项目 "${newProjectName}" 创建后未能确认存在，请去 Console 手动核对`)
  const real = readProjectId(newProjectName)
  console.log(`项目已创建并确认: ${newProjectName}（project id: ${real}）`)
  return real
}

function consentScreenConfigured(projectId) {
  open(`https://console.cloud.google.com/auth/overview?project=${encodeURIComponent(projectId)}`)
  // 概览页：未配置显示「尚未配置 Google Auth Platform」，已配置显示指标/项目检查
  if (!waitFor(`
    const t = document.body.innerText || '';
    return t.includes('尚未配置 Google Auth Platform') || t.includes('not been configured')
      || (t.includes('OAuth 概览') && (t.includes('指标') || t.includes('项目检查')))`, 30)) {
    bail("概览页未能判断 consent screen 是否已配置")
  }
  const text = pageText(2000)
  return !text.includes("尚未配置 Google Auth Platform") && !text.includes("not been configured")
}

/** 点「下一步」并等下一步的专属元素可见；点了没前进就 bail（见头部踩坑 A）。 */
function nextStep(fromName, visiblePredicateJs) {
  clickButtonByText("下一步")
  if (!waitFor(visiblePredicateJs, 15)) bail(`consent screen 向导卡在「${fromName}」：点「下一步」后没有进入下一步（必填项可能没填上）`)
}

function ensureConsentScreen(projectId) {
  if (consentScreenConfigured(projectId)) {
    console.log("Consent screen 已配置，跳过创建向导。")
    return
  }
  console.log("Consent screen 未配置，开始创建向导 ...")
  open(`https://console.cloud.google.com/auth/overview/create?project=${encodeURIComponent(projectId)}`)
  // 注意：顶栏搜索框也是 input，不能拿「有 input」当向导已加载的信号
  if (!waitFor(`return !!inputByLabel('应用名称')`, 30)) bail("consent screen 向导页未加载出「应用名称」输入框")

  // 步骤 1：应用信息（App 名 + 支持邮箱）
  fillInputById(inputIdByLabel("应用名称"), opt.appName)
  settle(300)
  // 支持邮箱下拉是页面上的 cfc-select（[role=combobox] 第一个是顶栏搜索框，别用）
  evalJs(`const s = Array.from(document.querySelectorAll('cfc-select')).find(vis); if (!s) throw new Error('找不到支持邮箱下拉'); s.click(); return 'ok'`)
  if (!waitFor(`return Array.from(document.querySelectorAll('mat-option')).some(vis)`, 10)) bail("支持邮箱下拉没有展开")
  const picked = evalJs(`
    const opts = Array.from(document.querySelectorAll('mat-option')).filter(x => vis(x) && !x.className.includes('disabled'));
    const want = ${JSON.stringify(opt.supportEmail || "")};
    const o = want ? opts.find(x => x.innerText.includes(want)) : opts[0];
    if (!o) return '';
    const t = o.innerText.trim();
    o.click();
    return t;
  `).trim()
  if (!picked) bail(opt.supportEmail ? `支持邮箱下拉里找不到 ${opt.supportEmail}` : "支持邮箱下拉里没有可选项")
  console.log(`  支持邮箱: ${picked}`)
  settle(500)
  nextStep("应用信息", `const r = document.querySelector('input[type=radio][value=external]'); return vis(r)`)

  // 步骤 2：受众群体（External）
  const ext = evalJs(`
    const r = document.querySelector('input[type=radio][value=external]');
    r.click();
    return String(r.checked);
  `)
  if (ext !== "true") bail("External 单选按钮没有选中")
  settle(300)
  nextStep("受众群体", `return vis(document.querySelector('input.mat-mdc-chip-input'))`)

  // 步骤 3：联系信息（开发者邮箱，chip input，失焦即提交 chip）
  const devEmail = (picked.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || opt.supportEmail || accountEmailGuess()
  const chipInputId = evalJs(`const el = Array.from(document.querySelectorAll('input.mat-mdc-chip-input')).find(vis); return el ? el.id : '';`)
  if (!chipInputId) bail("找不到开发者联系邮箱输入框")
  fillInputById(chipInputId, devEmail)
  settle(600)
  const chips = evalJs(`return String(Array.from(document.querySelectorAll('mat-chip-row, mat-chip, .mat-mdc-chip')).filter(vis).length)`)
  if (chips === "0") bail("开发者联系邮箱没有被提交成 chip")
  nextStep("联系信息", `return vis(document.querySelector('input[type=checkbox]'))`)

  // 步骤 4：同意用户数据政策 → 「继续」→「创建」
  const agreed = evalJs(`
    const cb = Array.from(document.querySelectorAll('input[type=checkbox]')).find(vis);
    if (!cb.checked) cb.click();
    return String(cb.checked);
  `)
  if (agreed !== "true") bail("未能勾选「用户数据政策」同意框")
  settle(400)
  if (JSON.parse(buttonState("继续")).found) { clickButtonByText("继续"); settle(800) }
  clickButtonByText("创建")
  // 创建是异步的（页面显示「正在处理…」），成功后跳回 /auth/overview 并提示「已创建 OAuth 配置」
  if (!waitFor(`return !location.pathname.includes('/overview/create') || (document.body.innerText||'').includes('已创建 OAuth 配置')`, 60)) {
    bail("consent screen 创建似乎未成功（60 秒内未离开向导页）")
  }
  if (!consentScreenConfigured(projectId)) bail("向导已提交但概览页仍显示未配置")
  console.log("Consent screen 创建完成。")
}

function accountEmailGuess() {
  // 从账号选择器按钮的 aria-label 里抠邮箱，形如「账号：示例用户 (user@example.com)」
  const label = evalJs(`
    const btn = document.querySelector('[aria-label*="账号："], [aria-label*="Account:"]');
    return btn ? btn.getAttribute('aria-label') : '';
  `)
  const m = label.match(/[\w.+-]+@[\w.-]+\.\w+/)
  if (!m) bail("无法自动识别账号邮箱，请显式传 --support-email")
  return m[0]
}

/** 读品牌页现状：已获授权网域 + 三个链接。 */
function readBranding() {
  return JSON.parse(evalJs(`
    const val = l => { const el = inputByLabel(l); return el ? el.value : null };
    return JSON.stringify({
      domains: Array.from(document.querySelectorAll('input[placeholder="example.com"]')).filter(vis).map(i => i.value).filter(Boolean),
      homepage: val('应用首页'), privacy: val('应用隐私权政策链接'), terms: val('应用服务条款链接'),
    });
  `))
}

function ensureBrandingAndPublish(projectId) {
  const brandingUrl = `https://console.cloud.google.com/auth/branding?project=${encodeURIComponent(projectId)}`
  open(brandingUrl)
  if (!waitFor(`return !!inputByLabel('应用名称') && !!inputByLabel('应用首页')`, 30)) bail("品牌页未加载")
  settle(800) // 已保存的网域行是异步渲染的，等一下再读

  let changed = false
  const added = []
  const before = readBranding()

  // 已获授权的网域：逐个补齐缺失的；页面判定无效的行（顶级专用域名校验）删掉并跳过
  const missing = authorizedDomains().filter(d => !before.domains.includes(d))
  for (const d of missing) {
    evalJs(`const b = btnByText('添加网域')[0]; if (!b) throw new Error('找不到「添加网域」按钮'); b.click(); return 'ok'`)
    settle(500)
    const newInputId = evalJs(`
      const inputs = Array.from(document.querySelectorAll('input[placeholder="example.com"]')).filter(vis);
      const empty = inputs.find(i => !i.value);
      return empty ? empty.id : '';
    `)
    if (!newInputId) bail(`点了「添加网域」但没有出现新的空输入框（${d}）`)
    fillInputById(newInputId, d)
    settle(900)
    const err = evalJs(`
      const el = document.getElementById(${JSON.stringify(newInputId)});
      const field = el.closest('mat-form-field, .mat-mdc-form-field, cfc-form-field');
      const errs = Array.from((field || document).querySelectorAll('mat-error, .mat-mdc-form-field-error')).map(e => e.innerText.trim()).filter(Boolean);
      return errs.join(';');
    `)
    if (err) {
      // 删掉这一行：删除按钮在输入框所在行的容器里，aria-label 形如「删除内容。项 N」
      evalJs(`
        const el = document.getElementById(${JSON.stringify(newInputId)});
        const row = el.closest('cfc-form-stack-input-wrapper')?.parentElement;
        const del = row && row.querySelector('button[aria-label^="删除内容"]');
        if (del) del.click();
        return del ? 'removed' : 'NO_DELETE_BUTTON';
      `)
      settle(500)
      console.warn(`  跳过网域 ${d}：Console 校验未通过（${err}）`)
      continue
    }
    console.log(`  已添加授权网域: ${d}`)
    added.push(d)
    changed = true
  }

  if (opt.publish) {
    // 发布到正式版前，homepage/privacy/terms 缺一个都会让「发布应用」按钮保持禁用
    // （实测结论，Google 没有在 UI 上直接说明，见文件头注释）。
    const primary = opt.origins.find(o => o.startsWith("https://")) || opt.origins[0]
    const links = { homepage: primary, privacy: `${primary}/privacy`, terms: `${primary}/terms` }
    const labels = { homepage: "应用首页", privacy: "应用隐私权政策链接", terms: "应用服务条款链接" }
    for (const key of ["homepage", "privacy", "terms"]) {
      if (before[key]) continue
      const id = inputIdByLabel(labels[key])
      if (!id) bail(`品牌页找不到「${labels[key]}」输入框`)
      fillInputById(id, links[key])
      changed = true
    }
  }

  if (changed) {
    settle(500)
    clickButtonByText("保存")
    settle(2500)
    // 保存没有成功提示，重新加载品牌页读回来确认
    open(brandingUrl)
    if (!waitFor(`return !!inputByLabel('应用首页')`, 30)) bail("保存后品牌页重新加载失败")
    settle(800)
    const after = readBranding()
    // 被 Console 拒绝而跳过的网域不算丢失；只有「加成功却没存下」才算
    const lost = added.filter(d => !after.domains.includes(d))
    if (lost.length) bail(`品牌页保存后这些授权网域没有存下来: ${lost.join(", ")}`)
    console.log(`  品牌页已保存。授权网域: ${after.domains.join(", ") || "(无)"}`)
    if (opt.publish && !(after.homepage && after.privacy && after.terms)) bail("品牌页保存后应用首页/隐私权政策/服务条款没有存下来")
  } else {
    console.log("  品牌页无需改动。")
  }

  if (!opt.publish) return
  open(`https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(projectId)}`)
  if (!waitFor(`return (document.body.innerText||'').includes('发布状态')`, 30)) bail("目标对象页未加载")
  settle(800)
  if (pageText(1500).includes("返回测试版")) { console.log("Audience 已是正式版，跳过发布。"); return }
  const state = JSON.parse(buttonState("发布应用"))
  if (!state.found) bail("找不到「发布应用」按钮")
  if (state.disabled || state.ariaDisabled === "true") {
    bail("「发布应用」按钮仍被禁用 —— 品牌页字段可能还有缺失，请人工检查 /auth/branding")
  }
  clickButtonByText("发布应用")
  const dlgBtn = `Array.from(document.querySelectorAll('[role=dialog] button, mat-dialog-container button')).find(b => vis(b) && b.innerText.trim() === '确认')`
  if (!waitFor(`return !!(${dlgBtn})`, 15)) bail("点「发布应用」后没有出现确认对话框")
  evalJs(`const b = ${dlgBtn}; b.click(); return 'ok'`)
  // 发布是异步的（对话框里先转圈），成功后页面出现「返回测试版」
  if (!waitFor(`return (document.body.innerText||'').includes('返回测试版')`, 60)) {
    bail("发布到正式版后未能确认状态，请人工检查 /auth/audience")
  }
  console.log("已发布到正式版。")
}

function clientExistsInList(projectId, name) {
  open(`https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(projectId)}`)
  // 列表是异步渲染的：等到「没有要显示的 OAuth 客户端」或出现客户端 ID 为止
  waitFor(`const t = document.body.innerText || ''; return t.includes('没有要显示') || t.includes('.apps.googleusercontent.com')`, 20)
  settle(500)
  return pageText(4000).includes(name)
}

function prepareClient(projectId) {
  if (clientExistsInList(projectId, opt.name)) {
    console.log(`Client "${opt.name}" 已存在于列表，跳过填表。`)
    return
  }
  console.log("填写 OAuth client 表单 ...")
  open(`https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(projectId)}`)
  // waitFor 会在「加载失败」页自动点「重试」（见踩坑 D）
  if (!waitFor(`return Array.from(document.querySelectorAll('cfc-select, mat-select')).some(vis)`, 40)) bail("创建页未加载出应用类型选择器")
  evalJs(`Array.from(document.querySelectorAll('cfc-select, mat-select')).find(vis).click(); return 'ok'`)
  if (!waitFor(`return Array.from(document.querySelectorAll('mat-option, [role=option]')).some(vis)`, 10)) bail("应用类型下拉没有展开")
  const typeClicked = evalJs(`
    const opts = Array.from(document.querySelectorAll('mat-option, [role=option]')).filter(vis);
    const o = opts.find(x => x.innerText.trim() === 'Web 应用' || x.innerText.trim() === 'Web application');
    if (!o) return 'NOT_FOUND';
    o.click();
    return 'OK';
  `)
  if (typeClicked === "NOT_FOUND") bail("找不到「Web 应用」选项")
  if (!waitFor(`return !!inputByLabel('名称')`, 15)) bail("选了 Web 应用后没有出现「名称」输入框")
  fillInputById(inputIdByLabel("名称"), opt.name)

  // 两个「添加 URI」按钮：第一个是 JS origins，第二个是 redirect URIs
  const redirects = redirectUris()
  const addUri = (which, n) => {
    for (let i = 0; i < n; i++) {
      evalJs(`const b = btnByText('添加 URI')[${which}]; if (!b) throw new Error('找不到第 ${which + 1} 个「添加 URI」按钮'); b.click(); return 'ok'`)
      settle(350)
    }
  }
  addUri(0, opt.origins.length)
  addUri(1, redirects.length)

  // 文本输入框按 DOM 顺序：名称、origins…、redirects…。以「已获授权的重定向 URI」标题
  // 为界划分两组（顶栏搜索框是 type=search，不在其中）。
  const groups = JSON.parse(evalJs(`
    const inputs = Array.from(document.querySelectorAll('input')).filter(i => vis(i) && i.type === 'text'); // 这些 input 没有 type 属性，不能用 [type=text]
    const heads = Array.from(document.querySelectorAll('*'))
      .filter(e => e.textContent.trim().startsWith('已获授权的重定向 URI') && !e.querySelector('input'))
      .sort((a, b) => a.textContent.length - b.textContent.length);
    const head = heads[0];
    const after = i => !!head && !!(head.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING);
    const rest = inputs.filter(i => fieldText(i).indexOf('名称') !== 0);
    return JSON.stringify({
      origins: rest.filter(i => !after(i)).map(i => i.id),
      redirects: rest.filter(after).map(i => i.id),
    });
  `))
  if (groups.origins.length !== opt.origins.length || groups.redirects.length !== redirects.length) {
    bail(`URI 输入框数量不符：origins ${groups.origins.length}/${opt.origins.length}，redirects ${groups.redirects.length}/${redirects.length}`)
  }
  groups.origins.forEach((id, i) => fillInputById(id, opt.origins[i]))
  groups.redirects.forEach((id, i) => fillInputById(id, redirects[i]))
  settle(800)

  // 读回校验：值一致、无报错、「创建」按钮可点（但不点）
  const got = JSON.parse(evalJs(`
    const v = ids => ids.map(id => document.getElementById(id)?.value ?? null);
    return JSON.stringify({
      name: inputByLabel('名称')?.value ?? null,
      origins: v(${JSON.stringify(groups.origins)}),
      redirects: v(${JSON.stringify(groups.redirects)}),
      errors: Array.from(document.querySelectorAll('mat-error, .mat-mdc-form-field-error')).filter(vis).map(e => e.innerText.trim()),
    });
  `))
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  if (got.name !== opt.name || !same(got.origins, opt.origins) || !same(got.redirects, redirects) || got.errors.length) {
    bail(`表单读回与预期不一致：${JSON.stringify(got)}`)
  }
  const create = JSON.parse(buttonState("创建"))
  if (!create.found || create.disabled) bail("表单已填但「创建」按钮不可点，请人工检查页面")
  const path = evalJs(`return location.pathname`)
  console.log(`表单已填好（${opt.origins.length} 个 origins + ${redirects.length} 个 redirect URIs 已读回校验），停在 ${path}。`)
  console.log("请在保留的浏览器标签页手点「创建」，成功弹窗保持打开，再运行 --capture。")
}

function tryExtractCredentials() {
  try {
    const json = evalJs(`
      const dialog = document.querySelector('[role=dialog], mat-dialog-container');
      if (!dialog) return 'null';
      const text = dialog.innerText || '';
      const idMatch = text.match(/\\d+-[a-z0-9_-]+\\.apps\\.googleusercontent\\.com/);
      const inputs = Array.from(dialog.querySelectorAll('input')).map(i => i.value).filter(Boolean);
      const secretGuess = inputs.find(v => v && !v.includes('.apps.googleusercontent.com') && v.length > 10);
      if (!idMatch || !secretGuess) return 'null';
      return JSON.stringify({ clientId: idMatch[0], clientSecret: secretGuess || null });
    `)
    if (json === "null") return null
    return JSON.parse(json)
  } catch { return null }
}

// ───────────────────────── wrangler secrets ─────────────────────────

function wranglerSecretPut(dir, name, value) {
  execFileSync("npx", ["wrangler", "secret", "put", name], {
    cwd: dir, input: value, stdio: ["pipe", "pipe", "pipe"], timeout: 60000,
  })
}

function updateDevVars(dir, kv) {
  const path = resolve(dir, ".dev.vars")
  const gitignore = resolve(dir, "..", "..", ".gitignore")
  let ignored = false
  try { ignored = readFileSync(gitignore, "utf8").includes(".dev.vars") } catch { /* 找不到就当没忽略处理，走保守分支 */ }
  if (!ignored) {
    console.error("未能确认 .dev.vars 已被 .gitignore 忽略，未写入本地文件。")
    return
  }
  let lines = []
  if (existsSync(path)) lines = readFileSync(path, "utf8").split("\n")
  const map = new Map()
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) map.set(m[1], m[2])
  }
  for (const [k, v] of Object.entries(kv)) map.set(k, v)
  const out = [...map.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n"
  writeFileSync(path, out)
  console.log(`已写入 ${path}（合并已有内容）。`)
}

function applyWranglerSecrets(creds) {
  const dir = resolve(opt.workerDir)
  if (!existsSync(dir)) bail(`--worker-dir 不存在: ${dir}`)
  wranglerSecretPut(dir, "GOOGLE_CLIENT_ID", creds.clientId)
  console.log("GOOGLE_CLIENT_ID 已写入。")
  wranglerSecretPut(dir, "GOOGLE_CLIENT_SECRET", creds.clientSecret)
  console.log("GOOGLE_CLIENT_SECRET 已写入。")
  if (opt.writeDevVars) updateDevVars(dir, { GOOGLE_CLIENT_ID: creds.clientId, GOOGLE_CLIENT_SECRET: creds.clientSecret })
}

// ───────────────────────── 主流程 ─────────────────────────

let captureDone = false
try {
  if (opt.capture) {
    if (!opt.workerDir) bail("--capture 需要 --worker-dir")
    const creds = tryExtractCredentials()
    if (!creds) bail("当前会话中未读到包含 Client ID 和 Secret 的成功弹窗，请保持弹窗打开。")
    applyWranglerSecrets(creds)
    captureDone = true
    console.log("捕获完成。")
  } else {
    const projectId = resolveProject()
    ensureConsentScreen(projectId)
    ensureBrandingAndPublish(projectId)
    prepareClient(projectId)
  }
} finally {
  if (captureDone) try { cli(["close"]) } catch { /* ignore */ }
}
