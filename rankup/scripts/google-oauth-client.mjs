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
 *     --project oc-maker-hub | --project new:oc-maker-hub \
 *     --name "OC Maker Hub" \
 *     --origins https://oc-maker-hub.kanchaishaoxia.workers.dev,https://ocmakerhub.com,https://www.ocmakerhub.com,http://localhost:3000 \
 *     --redirect-path /api/auth/google/callback \
 *     [--app-name "OC Maker Hub"] [--publish] \
 *     --session oauth-oc-maker-hub --stop-before-create --commit
 *   # 在保留的浏览器标签页手点「创建」后：
 *   node google-oauth-client.mjs --capture --session oauth-oc-maker-hub \
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
 *  1. 这台机器上 OpenCLI 默认 `--window dedicated`，而 dedicated 窗口池
 *     在单显示器上容量可能是 1 —— 别的会话占着就会报
 *     `dedicated-pool-exhausted`。本脚本所有调用都显式传
 *     `--window background`，不依赖默认值。
 *  2. Google Auth Platform 这几个页面（/auth/overview、/auth/branding、
 *     /auth/audience、/auth/clients/*）会让 OpenCLI 的 `find`/`state`
 *     （用来built accessibility 快照）稳定抛
 *     `TypeError: object is not a function`（页面自身 Angular 路由代码
 *     覆盖了 `HTMLAnchorElement.prototype.getAttribute`，与 OpenCLI 的
 *     无障碍角色计算撞车）。本脚本因此全程只用 `eval` + 原生 DOM 查询
 *     （`document.querySelectorAll` 按文字/id 定位），不调 `find`/`state`。
 *  3. 多步向导「看起来没反应」时不要无脑重试，先去客户端列表确认。
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
    [--app-name 名称] [--support-email x@y.com] [--publish] \\
    [--session 名] [--stop-before-create] [--commit]
  node google-oauth-client.mjs --capture --session <同一会话名> \\
    --worker-dir <dir> [--write-dev-vars] [--commit]

默认 dry-run，只打印计划。--commit 才真正执行。详见文件头注释。`)
}

// ───────────────────────── OpenCLI 封装 ─────────────────────────

function cli(args, { timeout = 30000 } = {}) {
  try {
    return execFileSync("opencli", ["browser", opt.session, "--window", "background", ...args],
      { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e) {
    const err = (e.stderr?.toString() || e.stdout?.toString() || e.message || "").trim()
    throw new Error(`opencli 失败 (${args[0]}): ${err.slice(0, 800)}`)
  }
}
function evalJs(js) { return cli(["eval", `(()=>{${js}})()`], { timeout: 45000 }) }
function open(url) { cli(["open", url], { timeout: 45000 }) }
function pageText(max = 6000) {
  try { return JSON.parse(evalJs(`return JSON.stringify((document.body.innerText||"").slice(0,${max}))`)) }
  catch { return evalJs(`return (document.body.innerText||"").slice(0,${max})`) }
}
function settle(ms) {
  cli(["eval", `(async()=>{await new Promise(r=>setTimeout(r,${ms}));return true})()`], { timeout: ms + 30000 })
}
function waitFor(predicateJs, seconds = 20) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    try { if (String(evalJs(predicateJs)).includes("true")) return true } catch { /* 导航中，继续等 */ }
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
/** 按可见文字点按钮；找不到抛错，找到多个取第一个可见的。 */
function clickButtonByText(text) {
  const r = evalJs(`
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(x => x.innerText.trim() === ${JSON.stringify(text)} && x.offsetParent !== null);
    if (!b) return 'NOT_FOUND';
    if (b.disabled) return 'DISABLED';
    b.click();
    return 'OK';
  `)
  if (r === "NOT_FOUND") throw new Error(`按钮未找到: "${text}"`)
  if (r === "DISABLED") throw new Error(`按钮被禁用: "${text}"`)
  return r
}
function buttonState(text) {
  return evalJs(`
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(x => x.innerText.trim() === ${JSON.stringify(text)});
    if (!b) return JSON.stringify({found:false});
    return JSON.stringify({found:true, disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled')});
  `)
}

// ───────────────────────── 计划打印（dry-run） ─────────────────────────

function hostOf(origin) { return new URL(origin).hostname }
function redirectUris() { return opt.origins.map(o => o.replace(/\/$/, "") + opt.redirectPath) }
function authorizedDomains() { return [...new Set(opt.origins.filter(o => o.startsWith("https://")).map(hostOf))] }

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

function bail(msg) {
  console.error(msg)
  if (!opt.capture) try { cli(["close"]) } catch { /* ignore */ }
  process.exit(1)
}

function resolveProject() {
  if (!isNewProject) return opt.project
  console.log(`创建新 GCP project: ${newProjectName} ...`)
  open("https://console.cloud.google.com/projectcreate")
  if (!waitFor(`return !!document.querySelector('input')`, 20)) bail("项目创建页未加载出输入框")
  const inputId = evalJs(`
    const inputs = Array.from(document.querySelectorAll('input[type=text], input:not([type])'));
    const el = inputs[0];
    return el ? el.id : '';
  `)
  if (!inputId) bail("找不到项目名称输入框")
  fillInputById(inputId, newProjectName)
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
  console.log(`项目已创建并确认: ${newProjectName}`)
  return newProjectName
}

function consentScreenConfigured(projectId) {
  open(`https://console.cloud.google.com/auth/overview?project=${encodeURIComponent(projectId)}`)
  settle(2000)
  const text = pageText(2000)
  return !text.includes("尚未配置 Google Auth Platform") && !text.includes("not been configured")
}

function ensureConsentScreen(projectId) {
  if (consentScreenConfigured(projectId)) {
    console.log("Consent screen 已配置，跳过创建向导。")
    return
  }
  console.log("Consent screen 未配置，开始创建向导 ...")
  open(`https://console.cloud.google.com/auth/overview/create?project=${encodeURIComponent(projectId)}`)
  if (!waitFor(`return !!document.querySelector('input')`, 20)) bail("consent screen 向导页未加载")

  // 步骤 1：应用信息（App 名 + 支持邮箱）
  const appNameInputId = evalJs(`
    const els = Array.from(document.querySelectorAll('input'));
    const el = els.find(i => i.closest('mat-form-field, .mat-mdc-form-field')?.innerText?.startsWith('应用名称'));
    return el ? el.id : (els[0] ? els[0].id : '');
  `)
  if (!appNameInputId) bail("找不到应用名称输入框")
  fillInputById(appNameInputId, opt.appName)
  settle(300)
  // 支持邮箱：点开下拉，选中 --support-email 或第一个选项
  evalJs(`document.querySelector('[role=combobox]')?.click()`)
  settle(500)
  if (opt.supportEmail) {
    const clicked = evalJs(`
      const opts = Array.from(document.querySelectorAll('mat-option, [role=option]'));
      const o = opts.find(x => x.innerText.includes(${JSON.stringify(opt.supportEmail)}));
      if (!o) return 'NOT_FOUND';
      o.click();
      return 'OK';
    `)
    if (clicked === "NOT_FOUND") bail(`支持邮箱下拉里找不到 ${opt.supportEmail}`)
  } else {
    evalJs(`
      const opts = Array.from(document.querySelectorAll('mat-option, [role=option]'));
      const o = opts.find(x => !x.className.includes('disabled'));
      if (o) o.click();
    `)
  }
  settle(300)
  clickButtonByText("下一步")
  settle(1000)

  // 步骤 2：受众群体（External）
  const extRadio = evalJs(`
    const r = document.querySelector('input[type=radio][value=external]');
    if (!r) return 'NOT_FOUND';
    r.click();
    return 'OK';
  `)
  if (extRadio === "NOT_FOUND") bail("找不到 External 单选按钮")
  settle(300)
  clickButtonByText("下一步")
  settle(1000)

  // 步骤 3：联系信息（开发者邮箱，chip input）
  const chipInputId = evalJs(`
    const el = document.querySelector('.mat-mdc-chip-input, [aria-label*="电子邮件"]');
    return el ? el.id : '';
  `)
  const devEmail = opt.supportEmail || accountEmailGuess()
  if (chipInputId) fillInputById(chipInputId, devEmail)
  settle(300)
  clickButtonByText("下一步") // 提交 chip（第一次点击常常只是让输入框失焦提交 chip）
  settle(800)
  clickButtonByText("下一步") // 真正进入下一步
  settle(1000)

  // 步骤 4：同意用户数据政策 + 创建
  evalJs(`
    const cb = document.querySelector('input[type=checkbox]');
    if (cb && !cb.checked) cb.click();
  `)
  settle(300)
  clickButtonByText("创建")
  if (!waitFor(`return (document.body.innerText||'').includes('已创建 OAuth 配置') || (document.body.innerText||'').includes('OAuth 概览')`, 20)) {
    bail("consent screen 创建似乎未成功，请检查页面")
  }
  console.log("Consent screen 创建完成。")
}

function accountEmailGuess() {
  // 从账号选择器按钮的 aria-label 里抠邮箱，形如「账号：少侠 (foo@bar.com)」
  const label = evalJs(`
    const btn = document.querySelector('[aria-label*="账号："], [aria-label*="Account:"]');
    return btn ? btn.getAttribute('aria-label') : '';
  `)
  const m = label.match(/[\w.+-]+@[\w.-]+\.\w+/)
  if (!m) bail("无法自动识别账号邮箱，请显式传 --support-email")
  return m[0]
}

function ensureBrandingAndPublish(projectId) {
  open(`https://console.cloud.google.com/auth/branding?project=${encodeURIComponent(projectId)}`)
  if (!waitFor(`return !!document.querySelector('input')`, 20)) bail("品牌页未加载")

  // 已获授权的网域：逐个补齐缺失的
  const existing = JSON.parse(evalJs(`
    const inputs = Array.from(document.querySelectorAll('input'));
    const vals = inputs
      .filter(i => i.closest('mat-form-field, .mat-mdc-form-field')?.innerText?.includes('已获授权的网域'))
      .map(i => i.value).filter(Boolean);
    return JSON.stringify(vals);
  `))
  const domains = authorizedDomains()
  const missing = domains.filter(d => !existing.includes(d))
  for (const d of missing) {
    evalJs(`
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => x.innerText.trim() === '添加网域');
      if (b) b.click();
    `)
    settle(400)
    const newInputId = evalJs(`
      const inputs = Array.from(document.querySelectorAll('input[placeholder="example.com"]'));
      const empty = inputs.find(i => !i.value);
      return empty ? empty.id : (inputs.length ? inputs[inputs.length-1].id : '');
    `)
    if (newInputId) fillInputById(newInputId, d)
  }

  if (opt.publish) {
    // 发布到正式版前，homepage/privacy/terms 缺一个都会让「发布应用」按钮保持禁用
    // （实测结论，Google 没有在 UI 上直接说明，见文件头注释）。
    const primary = opt.origins.find(o => o.startsWith("https://")) || opt.origins[0]
    const links = { homepage: primary, privacy: `${primary}/privacy`, terms: `${primary}/terms` }
    const labels = { homepage: "应用首页", privacy: "应用隐私权政策链接", terms: "应用服务条款链接" }
    for (const key of ["homepage", "privacy", "terms"]) {
      const id = evalJs(`
        const els = Array.from(document.querySelectorAll('input'));
        const el = els.find(i => i.closest('mat-form-field, .mat-mdc-form-field')?.innerText?.startsWith(${JSON.stringify(labels[key])}));
        return el ? el.id : '';
      `)
      if (id) {
        const cur = evalJs(`return document.getElementById(${JSON.stringify(id)}).value`)
        if (!cur) fillInputById(id, links[key])
      }
    }
  }

  settle(300)
  const saveState = buttonState("保存")
  if (JSON.parse(saveState).found) {
    clickButtonByText("保存")
    settle(2000)
  }

  if (!opt.publish) return
  open(`https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(projectId)}`)
  settle(1500)
  const already = pageText(500).includes("正式版")
  if (already) { console.log("Audience 已是正式版，跳过发布。"); return }
  const state = JSON.parse(buttonState("发布应用"))
  if (!state.found) bail("找不到「发布应用」按钮")
  if (state.disabled || state.ariaDisabled === "true") {
    bail("「发布应用」按钮仍被禁用 —— 品牌页字段可能还有缺失，请人工检查 /auth/branding")
  }
  clickButtonByText("发布应用")
  settle(1000)
  clickButtonByText("确认")
  if (!waitFor(`return (document.body.innerText||'').includes('正式版')`, 20)) {
    bail("发布到正式版后未能确认状态，请人工检查 /auth/audience")
  }
  console.log("已发布到正式版。")
}

function clientExistsInList(projectId, name) {
  open(`https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(projectId)}`)
  settle(1500)
  const text = pageText(4000)
  return text.includes(name)
}

function prepareClient(projectId) {
  if (clientExistsInList(projectId, opt.name)) {
    console.log(`Client "${opt.name}" 已存在于列表，跳过填表。`)
    return
  }
  console.log("填写 OAuth client 表单 ...")
  open(`https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(projectId)}`)
  if (!waitFor(`return !!document.querySelector('cfc-select, mat-select')`, 20)) throw new Error("创建页未加载出类型选择器")
  evalJs(`document.querySelector('cfc-select, mat-select')?.click()`)
  settle(500)
  const typeClicked = evalJs(`
    const opts = Array.from(document.querySelectorAll('mat-option, [role=option]'));
    const o = opts.find(x => x.innerText.trim() === 'Web 应用' || x.innerText.trim() === 'Web application');
    if (!o) return 'NOT_FOUND';
    o.click();
    return 'OK';
  `)
  if (typeClicked === "NOT_FOUND") throw new Error("找不到「Web 应用」选项")
  settle(500)
  const nameInputId = evalJs(`
    const els = Array.from(document.querySelectorAll('input'));
    const el = els.find(i => i.closest('mat-form-field, .mat-mdc-form-field')?.innerText?.startsWith('名称'));
    return el ? el.id : '';
  `)
  if (!nameInputId) throw new Error("找不到名称输入框")
  fillInputById(nameInputId, opt.name)

  // 两个「添加 URI」按钮：第一个是 JS origins，第二个是 redirect URIs
  for (let i = 0; i < opt.origins.length; i++) {
    evalJs(`
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.trim() === '添加 URI');
      if (btns[0]) btns[0].click();
    `)
  }
  const redirects = redirectUris()
  for (let i = 0; i < redirects.length; i++) {
    evalJs(`
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.trim() === '添加 URI');
      if (btns[1]) btns[1].click();
    `)
  }
  settle(300)
  const ids = JSON.parse(evalJs(`
    const inputs = Array.from(document.querySelectorAll('input'));
    return JSON.stringify(inputs.map(i => i.id).filter(id => id.includes('mat-input-') && id !== ${JSON.stringify(nameInputId)}));
  `))
  const originIds = ids.slice(0, opt.origins.length)
  const redirectIds = ids.slice(opt.origins.length, opt.origins.length + redirects.length)
  originIds.forEach((id, i) => fillInputById(id, opt.origins[i]))
  redirectIds.forEach((id, i) => fillInputById(id, redirects[i]))
  settle(300)

  console.log("表单已填好。请在保留的浏览器标签页手点「创建」，成功弹窗保持打开，再运行 --capture。")
}

function tryExtractCredentials() {
  try {
    const json = evalJs(`
      const dialog = document.querySelector('[role=dialog], mat-dialog-container');
      if (!dialog) return 'null';
      const text = dialog.innerText || '';
      const idMatch = text.match(/[\\d-]+\\.apps\\.googleusercontent\\.com/);
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
