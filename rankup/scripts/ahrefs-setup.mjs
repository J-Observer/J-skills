#!/usr/bin/env node
/**
 * ahrefs-setup.mjs —— 通过已登录 Chrome 查看 Ahrefs 项目所有权状态、
 * 默认用已关联的 GSC 账户验证所有权；保留既有创建/分析子命令。无需 API key。
 *
 * 用法：
 *   # 查看 Dashboard 上的项目列表（只读）
 *   node <rankup-skill-dir>/scripts/ahrefs-setup.mjs status
 *
 *   # 为指定域名创建新项目
 *   node <rankup-skill-dir>/scripts/ahrefs-setup.mjs create --site example.com --name example
 *
 *   # 默认通过已关联的 GSC 账户验证项目所有权（账户下拉选第一项）
 *   node <rankup-skill-dir>/scripts/ahrefs-setup.mjs verify --site example.com
 *   # 仅用户指定账户时覆盖默认第一项
 *   node <rankup-skill-dir>/scripts/ahrefs-setup.mjs verify --site example.com --gsc-account name@example.com
 *
 *   # 启用 Web Analytics（总访问量监控）并获取追踪脚本
 *   node <rankup-skill-dir>/scripts/ahrefs-setup.mjs enable-wa --site example.com
 *
 * 标志：
 *   --site <域名>     要追踪的域名（不带协议，例如 example.com）
 *   --name <名称>     项目显示名，默认取 --site 的二级域名
 *   --project-id <ID> 直接指定 Ahrefs 项目 ID，跳过 Dashboard 自动查找
 *   --gsc-account <邮箱> 验证时覆盖 GSC 账户下拉第一项（只有用户指定时才用）
 *   --session <名>    opencli 会话名（默认 ahrefs-setup-<每对话唯一后缀>，不用 pid）
 *   --keep-session    完成后不关闭会话
 *
 * 依赖：opencli，且用户浏览器已登录 app.ahrefs.com。
 *
 * ── 为什么是浏览器而不是 API ────────────────────────────────
 *
 * Ahrefs API v3 只暴露数据查询端点（backlinks、keywords、SERPs），
 * 不暴露项目管理。创建项目 / 启动 Site Audit 只能走 Dashboard UI。
 *
 * ── 关于所有权验证（2026-09-28 复核） ──────────────────────
 *
 * 优先使用 Ahrefs 已关联的 GSC 账户验证，不优先走 DNS TXT / HTML 文件或标签。
 * `verify`：所有权设置 →「谷歌搜索控制台（建议）」→ Google 账户下拉默认第一项
 * （通常只有第一项有内容）→ 等验证通过 → 保存。仅用户指定账户时才传
 * `--gsc-account` 改选；验证失败须如实退出，由调用方确认 GSC 是否已验证，
 * 再决定是否退回 DNS（此脚本不自动改 DNS）。创建时不跳过可用的 GSC 验证。
 * 已知坑：Dashboard 先渲染侧栏后加载项目；项目搜索与分页只显示局部结果；
 * 项目存在冻结项时 Ahrefs 禁止新增项目（2026-09-28 实测弹窗）。
 * GSC 已关联账户和浏览器登录 Google 不是同一件事：下拉若显示「未连接谷歌帐户」
 * 则绝不声称 GSC 已验证；首次授权同意页出现时停下，交用户处理。
 * 验证后必须回读「所有权已验证」，不能把点击、保存或向导跳转当成功。
 * /add-project/site-audit 的按钮文案随设置变化，不能从导航推断已创建。
 * 依赖用户 Chrome 已登录 Ahrefs，GSC 验证还依赖 Ahrefs 的账户关联。
 *
 * ── 关于 Web Analytics ──────────────────────────────────────
 *
 * Ahrefs Web Analytics 是 Ahrefs 自有的流量追踪（独立于 GA4）。
 * Dashboard「总访问量」列需要启用它才会显示数据。
 * `enable-wa` 子命令：导航到 Web Analytics 设置 → 提取 data-key → 保存。
 * 保存后需要将输出的 <script> 标签写入站点 <head> 并部署。
 * 注意：TanStack Start 的 head() scripts 不支持 data-* 属性，
 * 需要在 RootDocument 的 JSX <head> 中直接写 <script> 标签。
 *
 * 验证日期：2026-09-28（中文界面；真实账户存在冻结项目时，创建会在最后一步被拒绝）。
 * 已知坑：Dashboard 搜索/分页只显示当前结果；新项目的「完成」按钮不能
 * 证明成功，须回读项目列表；若工作区有冻结项目，不得擅自删除项目。
 *
 * ── 双证人化（2026-08-30，截图链路已实盘验证）────────────────
 * 向导每一步（打开 / 每次点击后）都截图落 `.rankup/evidence/ahrefs-setup-<ts>/`；
 * `execSync("sleep")` 全部革除，换页内条件等待；**删除了无条件的「✅ 创建成功」**
 * ——create 只报告「流程分支走完了」这个事实，成没成以最后一张截图为准。
 * 会话名不再用 pid（Bash tool 里每次调用都是新进程）。
 */
import { execSync } from "node:child_process"
import { newEvidenceDir, captureScene, writeManifest, sessionSuffix } from "./lib-scene.mjs"

// ── 参数 ──────────────────────────────────────────────────
const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") { usage(); process.exit(argv.length === 0 ? 1 : 0) }
const action = argv[0]
let site = null
let name = null
let projectId = null
let gscAccount = null
let session = `ahrefs-setup-${sessionSuffix()}`
let keepSession = false

for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--site" && argv[i + 1]) { site = argv[++i]; continue }
  if (a === "--name" && argv[i + 1]) { name = argv[++i]; continue }
  if (a === "--project-id" && argv[i + 1]) { projectId = argv[++i]; continue }
  if (a === "--gsc-account" && argv[i + 1]) { gscAccount = argv[++i]; continue }
  if (a === "--session" && argv[i + 1]) { session = argv[++i]; continue }
  if (a === "--keep-session") { keepSession = true; continue }
  if (a === "-h" || a === "--help") { usage(); process.exit(0) }
  console.error(`未知参数: ${a}`); usage(); process.exit(1)
}

function usage() {
  console.log(`用法:
  node ahrefs-setup.mjs status [--site <域名>] [--project-id <ID>]
  node ahrefs-setup.mjs create --site <域名> [--name <项目名>]
  node ahrefs-setup.mjs verify --site <域名> [--project-id <ID>] [--gsc-account <邮箱>]
  node ahrefs-setup.mjs enable-wa --site <域名> [--project-id <ID>]`)
}

if (!["status", "create", "verify", "enable-wa"].includes(action)) { usage(); process.exit(1) }
if (["create", "verify", "enable-wa"].includes(action) && !site) { console.error(`错误：${action} 需要 --site`); process.exit(1) }
if (action === "create" && !name) name = site.split(".")[0]

// ── OpenCLI 封装 ──────────────────────────────────────────
function cli(action_, { timeout = 30000 } = {}) {
  try {
    return execSync(`opencli browser "${session}" --window background ${action_}`,
      { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e) {
    const err = (e.stderr?.toString() || e.stdout?.toString() || e.message).trim()
    throw new Error(`opencli 失败: ${action_}\n  ${err}`)
  }
}
function evalJs(js) { return cli(`eval '${`(()=>{${js}})()`.replace(/'/g, "'\\''")}'`) }
function open(url) { cli(`open "${url}"`) }
function pageText(max = 4000) {
  return evalJs(`return (document.querySelector('main')||document.body).innerText.replace(/\\n{2,}/g,'\\n').slice(0,${max})`)
}
/** 页内定时器，替换 execSync("sleep")：那是壳层硬睡，页面快时白等、慢时不够。 */
function settle(ms) {
  cli(`eval '(async()=>{await new Promise(r=>setTimeout(r,${ms}));return true})()'`, { timeout: ms + 30000 })
}
/** 条件轮询：js 返回真值或超时。页面导航期间 eval 失败按「还没就绪」继续等。 */
function waitFor(js, seconds = 15) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    try { if (String(evalJs(js)).includes("true")) return true } catch { /* 导航中 */ }
    settle(500)
  }
  return false
}
/** 打开后等页面真的可读，代替原来的 settle(5000/8000) 赌秒数。 */
function waitPageReady(seconds = 20) {
  return waitFor(`return document.readyState==='complete' && ((document.body&&document.body.innerText)||'').length>50`, seconds)
}

/* ── 取证 ─────────────────────────────────────────────────── */
let evidence = null
function evidenceDir() {
  if (!evidence) evidence = newEvidenceDir("ahrefs-setup")
  return evidence
}
let sceneN = 0
function scene(tag, extra) {
  sceneN++
  return captureScene({
    dir: evidenceDir(),
    tag: `${String(sceneN).padStart(2, "0")}-${tag}`,
    screenshot: (p) => cli(`screenshot "${p}"`, { timeout: 90000 }),
    pageText: () => pageText(20000),
    extra,
  })
}
/** 失败退出：现场 → manifest(stopReason) → 关会话 → exit 1。 */
function bail(stopReason, msg, extra) {
  try {
    scene(`fail-${stopReason}`, extra)
    writeManifest(evidenceDir(), { script: "ahrefs-setup", action, site, stopReason, finishedAt: new Date().toISOString() })
    console.error(`现场已落盘：${evidenceDir()}`)
  } catch (e) { console.error(`（取证失败：${String(e?.message || e).slice(0, 200)}）`) }
  console.error(msg)
  if (!keepSession) { try { cli("close") } catch { /* ignore */ } }
  process.exit(1)
}

function stampAndClick(js, label) {
  evalJs(`const el=${js};if(!el)throw new Error('找不到: ${label}');el.setAttribute('data-rankup-target','1')`)
  cli('click "[data-rankup-target=\\"1\\"]"')
  evalJs(`document.querySelector('[data-rankup-target]')?.removeAttribute('data-rankup-target')`)
  scene(`clicked-${label.replace(/[^\w一-鿿-]/g, "_")}`)
}

/** opencli 新版 `type` 要求显式 target（不再支持只传 text 打到当前焦点元素）。
 *  这里复用 stampAndClick 的打标签思路：先用 evalJs 给目标元素打上唯一属性，
 *  再用该属性做 CSS 选择器传给 opencli type <target> <text>。 */
function stampAndType(js, text, label) {
  evalJs(`const el=${js};if(!el)throw new Error('找不到: ${label}');el.setAttribute('data-rankup-target','1')`)
  cli(`type "[data-rankup-target=\\"1\\"]" "${text}"`)
  evalJs(`document.querySelector('[data-rankup-target]')?.removeAttribute('data-rankup-target')`)
  scene(`typed-${label.replace(/[^\w一-鿿-]/g, "_")}`)
}

// ── status：列出项目，或回读单个项目的所有权状态 ───────────────
async function doStatus() {
  if (projectId || site) {
    const id = findProjectId()
    open(`https://app.ahrefs.com/project-settings/${id}/ownership`)
    if (!waitFor(`return /所有权已验证[。.]|所有权未验证[。.]|Ownership (?:verified|not verified)/i.test(document.body.innerText)`, 30)) {
      bail("ownership-not-loaded", "所有权页面未出现可确认的验证状态。")
    }
    const status = evalJs(`return (document.body.innerText.match(/所有权(?:已|未)验证[。.]|Ownership (?:verified|not verified)[.!]?/i)||[])[0]||''`)
    console.log(`${site || id} | ${id} | ${status}`)
    return
  }
  open("https://app.ahrefs.com/dashboard")
  waitPageReady(25)

  // Dashboard shell renders before project cards; reading it early silently reports navigation as projects.
  // Ahrefs may show project settings without Site Explorer links (frozen projects).
  waitFor(`return !!document.querySelector('a[href*="projectId="],a[href*="/project-settings/"]') || /无符合搜索条件的项目|No projects/i.test(document.body.innerText)`, 30)
  const url = evalJs(`return location.href`)
  if (/\/(?:login|sign-in|signin)(?:[/?#]|$)/i.test(url)) {
    bail("redirected-to-login", "Ahrefs 已跳转登录页，请先在浏览器中登录 app.ahrefs.com")
  }

  const projects = evalJs(`
    const links = [...document.querySelectorAll('a[href*="projectId="]')];
    const items = new Map();
    for (const link of links) {
      const u = new URL(link.href);
      const id = u.searchParams.get('projectId');
      const domain = (u.searchParams.get('target') || '').replace(/^\\*\\./, '').replace(/\\/.*$/, '');
      if (!id || !domain || items.has(id)) continue;
      const card = link.closest('[class*="projectHeader"]') || link.closest('[class*="projectCard"]');
      const name = card?.querySelector('h3')?.textContent?.trim() || link.textContent.trim() || domain;
      items.set(id, name + ' | ' + domain + ' | ' + id + ' | 未冻结（所有权仍需回读）');
    }
    for (const link of document.querySelectorAll('a[href*="/project-settings/"][href*="/ownership"]')) {
      const id = link.getAttribute('href').match(/project-settings\\/(\\d+)/)?.[1];
      if (!id || items.has(id)) continue;
      const header = link.closest('[class*="projectHeader"]');
      const text = header?.innerText || link.parentElement?.parentElement?.innerText || '';
      items.set(id, text.replace(/\\s+/g, ' ').trim().slice(0, 180) + ' | ' + id + ' | 冻结（未验证）');
    }
    return [...items.values()].join('\\n');
  `)
  const pageInfo = evalJs(`return location.href + ' | ' + (document.body.innerText.match(/每页\\d+个结果|\\d+ results per page/i)?.[0] || '')`)
  if (!projects) bail("projects-not-rendered", "Dashboard 未解析到项目链接；不把侧栏文本误报为项目列表。请检查现场截图。")
  console.log("── Ahrefs 项目列表（当前页；搜索和分页结果不代表全工作区）──")
  console.log(pageInfo)
  console.log(projects)
}

// ── create：新建项目 ──────────────────────────────────────
async function doCreate() {
  // 直接导航到手动添加项目页面
  open("https://app.ahrefs.com/add-project/scope")
  waitPageReady(20)

  const text = pageText()
  if (text.includes("Log in") || text.includes("Sign in")) {
    bail("login-text-seen", "页面文本命中 Log in/Sign in——多半未登录 Ahrefs（也可能是页面自身内容撞词，看截图）。请先在浏览器中登录 app.ahrefs.com")
  }

  // 如果到了选择页面（导入/手动），点"手动添加"
  if (text.includes("手动添加") || text.includes("Add manually")) {
    stampAndClick(
      `[...document.querySelectorAll('button,a')].find(b=>/手动添加|Add manually/i.test(b.textContent))`,
      "手动添加按钮"
    )
    settle(3000)
  }

  // 填写域名
  const domainInput = `document.querySelector('input[placeholder*="域" i],input[placeholder*="domain" i],input[placeholder*="路径" i],input[placeholder*="path" i]')`
  evalJs(`const el=${domainInput};if(!el)throw new Error('找不到域名输入框');el.value='';`)
  stampAndType(domainInput, site, "域名输入框")
  settle(1000)

  // 填写项目名称（如果输入框已自动填充则跳过）。
  // 中文界面下这个字段没有 name/id/placeholder 特征（标签在旁边的 <div> 里，
  // 不在 input 属性上），所以英文属性选择器会落空——改成：找所有可见文本
  // input，排除已经填过域名的那个，取第一个空的当作项目名称框；找不到就
  // 退化成"就近找标注为 项目名称/project name 的容器里的 input"。
  const nameInput = `(() => {
    const domainEl = ${domainInput};
    const texts = [...document.querySelectorAll('input[type="text"],input:not([type])')]
      .filter(el => el.offsetParent !== null && el !== domainEl);
    let byLabel = texts.find(el => {
      const label = el.closest('div')?.parentElement?.textContent || '';
      return /项目名称|project name/i.test(label);
    });
    return byLabel || texts.find(el => !el.value);
  })()`
  const currentName = evalJs(`const el=${nameInput};return el?.value||''`)
  if (!currentName || currentName === "") {
    evalJs(`const el=${nameInput};if(el){el.value='';}`)
    stampAndType(nameInput, name, "项目名称输入框")
    settle(500)
  }

  // 等待域名可访问性检查
  console.log("等待域名可访问性检查...")
  settle(8000)

  // 点击"继续"
  stampAndClick(
    `[...document.querySelectorAll('button')].find(b=>/继续|continue|next/i.test(b.textContent))`,
    "继续按钮"
  )
  settle(3000)

  // 第 2 步：Web Analytics（跳过）
  const text2 = pageText()
  if (text2.includes("Web Analytics") || text2.includes("分析功能")) {
    stampAndClick(
      `[...document.querySelectorAll('button,a')].find(b=>/不使用.*继续|skip|跳过/i.test(b.textContent))`,
      "跳过分析按钮"
    )
    settle(3000)
  }

  // 第 3 步：所有权验证。页面加载时会先「检查验证」，已验证的项目无需再选账户。
  if (evalJs(`return location.pathname.endsWith('/ownership')`) === "true") {
    waitFor(`return !/检查验证[.…]?/.test(document.body.innerText)`, 35)
    let result = selectGscAccount()
    if (result === "not-found") bail("gsc-section-not-found", "创建向导找不到 GSC 验证区域。")
    if (result === "selected" && !waitFor(`return /所有权已验证|Ownership verified|已通过谷歌搜索控制台验证/.test(document.body.innerText)`, 35)) {
      bail("gsc-verification-pending", "创建向导未显示 GSC 所有权已验证；待 GSC 就绪后重试，不自动写 DNS。")
    }
    scene("create-gsc-verified")
    stampAndClick(`[...document.querySelectorAll('button')].find(b=>/^继续$|^Continue$/i.test(b.textContent.trim()))`, "验证后继续")
    if (!waitFor(`return location.pathname.endsWith('/site-audit')`, 20)) bail("site-audit-not-reached", "GSC 验证后未到达 Site Audit 步骤。")
  }

  // 第 4 步：使用一次性抓取而不是开启周期性任务或付费的 Always-On。
  if (evalJs(`return location.pathname.endsWith('/site-audit')`) === "true") {
    stampAndClick(`[...document.querySelectorAll('button[role="radio"]')].find(b=>/一次性|one[- ]?time/i.test(b.textContent))`, "一次性抓取")
    stampAndClick(`[...document.querySelectorAll('button')].find(b=>/^完成$|^Finish$|^Done$/i.test(b.textContent.trim()))`, "完成按钮")
    if (!waitFor(`return !location.pathname.includes('/add-project/') || /工作区存在冻结项目|frozen projects/i.test(document.body.innerText)`, 25)) {
      bail("project-creation-unconfirmed", "点击完成后仍在向导；项目未确认创建。")
    }
    if (evalJs(`return /工作区存在冻结项目|frozen projects/i.test(document.body.innerText)`) === "true") {
      bail("frozen-project-blocks-create", "Ahrefs 提示工作区有冻结项目，不允许添加项目；不擅自删除已有项目。")
    }
  }

  // 不再无条件宣布「创建成功」：上面每个分支都是「文案命中才点」，全都没命中时
  // 流程一样会走到这里。只报告事实，成没成以最后一张截图与页面文本为准。
  const finalScene = scene("create-final")
  writeManifest(evidenceDir(), { script: "ahrefs-setup", action, site, name, stopReason: "flow-completed", finishedAt: new Date().toISOString() })
  console.log(`create 流程已走完（走没走到最后一步、项目建没建起来，以 ${evidenceDir()} 里 create-final 的截图与文本为准）`)
  console.log(`   项目名: ${name}`)
  console.log(`   域名:   ${site}`)
  console.log(`   （新建项目通常处于「冻结」状态，需验证所有权后激活 Site Audit）`)
  console.log(`\n验证方式：优先谷歌搜索控制台；账户下拉默认选第一项，仅失败后才考虑 DNS TXT。`)
}

// ── 共通：Dashboard から項目 ID を取得 ──────────────────────
function findProjectId() {
  if (projectId) {
    console.log(`使用指定的项目 ID: ${projectId}`)
    return projectId
  }

  open("https://app.ahrefs.com/dashboard")
  waitPageReady(25)

  const text = pageText(8000)
  if (text.includes("Log in") || text.includes("Sign in")) {
    bail("login-text-seen", "页面文本命中 Log in/Sign in——多半未登录 Ahrefs（也可能是页面自身内容撞词，看截图）。请先在浏览器中登录 app.ahrefs.com")
  }

  let foundId = evalJs(`
    const links = [...document.querySelectorAll('a[href*="/project-settings/"]')];
    const results = [];
    for (const link of links) {
      const id = link.href.match(/project-settings\\/(\\d+)/)?.[1];
      if (!id) continue;
      let el = link.parentElement;
      let depth = 0;
      while (el && el !== document.body && depth < 8) {
        depth++;
        const count = el.querySelectorAll('a[href*="/project-settings/"]').length;
        if (count > 1) break;
        const ownText = el.textContent || '';
        if (ownText.includes('${site}')) {
          results.push({ id, depth });
          break;
        }
        el = el.parentElement;
      }
    }
    if (results.length === 1) return results[0].id;
    if (results.length > 1) {
      results.sort((a, b) => a.depth - b.depth);
      return results[0].id;
    }
    return '';
  `)

  if (!foundId) {
    bail("project-id-not-found", `Dashboard 上没解析到域名 ${site} 对应的项目链接（「没有这个项目」与「页面没渲染完/改版」看截图分辨）。
   请使用 --project-id <ID> 手动指定，或先用 create 创建。项目 ID 可在项目设置页 URL 中找到。`)
  }

  return foundId
}

// ── verify：通过 GSC 验证所有权 ─────────────────────────────
function selectGscAccount() {
  const verified = `return /所有权已验证[。.]|Ownership verified[.!]?/i.test(document.body.innerText)`
  if (evalJs(verified) === "true") return "verified"
  const heading = `[...document.querySelectorAll('[class*="itemHeader"]')].find(el=>/谷歌搜索控制台|Google Search Console/i.test(el.textContent))`
  if (evalJs(`return !!(${heading})`) !== "true") return "not-found"
  const expanded = evalJs(`const h=${heading};return !!h.querySelector('[class*="itemTitleIconOpened"]')`)
  if (expanded !== "true") stampAndClick(heading, "GSC 折叠标题")
  const selector = `[...document.querySelectorAll('button,[role="button"],[role="listbox"],[class*="select"],[class*="Select"],[class*="dropdown"],[class*="Dropdown"]')].find(el=>/选择谷歌账号|Select.*Google.*account|选择帐号/i.test(el.textContent) && el.textContent.trim().length<120 && !el.disabled)`
  // Do not screenshot or run unrelated steps while the transient portal menu is open.
  evalJs(`const el=${selector};if(!el)throw new Error('找不到 GSC 账户下拉框');el.setAttribute('data-rankup-target','1')`)
  cli('click "[data-rankup-target=\\"1\\"]"')
  // Ahrefs menu uses button[class*=menuItem], not role=option or class*=option.
  const options = `[...document.querySelectorAll('button[class*="menuItem"], [role="option"]')].filter(el=>/\\S+@\\S+/.test(el.textContent) && el.getBoundingClientRect().width>0)`
  const selection = gscAccount
    ? `${options}.find(el=>el.textContent.includes(${JSON.stringify(gscAccount)}))`
    : `${options}[0]`
  const available = waitFor(`const el=${selection};if(!el)return false;el.setAttribute('data-rankup-account','1');return true`, 10)
  if (!available) bail("gsc-account-not-found", gscAccount ? "找不到指定的 GSC 账户选项" : "GSC 账户下拉没有可见的账户选项（Ahrefs 尚未关联 Google 账户或授权失效）")
  cli('click "[data-rankup-account=\\"1\\"]"')
  scene("gsc-account-selected")
  return "selected"
}

async function doVerify() {
  const projectId = findProjectId()
  await doVerifyWithId(projectId)
}

async function doVerifyWithId(projectId) {
  console.log(`项目 ID: ${projectId}，导航到所有权验证页面...`)

  // 1. 导航到所有权验证设置页
  open(`https://app.ahrefs.com/project-settings/${projectId}/ownership`)
  settle(5000)

  // Default to the first linked Google account; only --gsc-account overrides it.
  const selected = selectGscAccount()
  if (selected === "not-found") bail("gsc-section-not-found", "找不到 GSC 验证区域；看现场截图。")
  if (selected === "verified") {
    console.log(`${site}：页面已显示所有权已验证，无需再次选择账户。`)
    return
  }

  // 每 15 秒回读一次实际所有权结果；选择账户本身并不等于成功。
  let isVerified = false
  for (let attempts = 0; attempts <= 12; attempts++) {
    const text = pageText(20000)
    if (/所有权已验证[。.]|Ownership verified[.!]?/i.test(text)) { isVerified = true; break }
    if (/密码|两步验证|验证码|授权同意|consent|captcha/i.test(text)) {
      bail("manual-authorization-required", "检测到需要用户操作的授权或身份验证步骤；不自动同意。")
    }
    if (attempts < 12) settle(15000)
  }
  if (!isVerified) bail("verify-banner-not-seen", "3 分钟内未见「所有权已验证」；页面可见原文已随失败现场落盘，不把选中 GSC 账户当成功。")

  // 设置页可能有「保存」；创建向导则要点「继续」。只点实际存在的按钮。
  const save = evalJs(`return !![...document.querySelectorAll('button')].find(b=>/^保存$|^Save$/i.test(b.textContent.trim()))`)
  if (save === "true") stampAndClick(`[...document.querySelectorAll('button')].find(b=>/^保存$|^Save$/i.test(b.textContent.trim()))`, "保存按钮")
  scene("verify-final")
  console.log(`${site}：页面出现「所有权已验证」横幅（${save === "true" ? "已点击保存" : "页面没有保存按钮"}）。`)
}

// ── enable-wa：启用 Web Analytics 并获取追踪脚本 ────────────
async function doEnableWa() {
  const projectId = findProjectId()
  console.log(`项目 ID: ${projectId}，导航到 Web Analytics 设置...`)

  // 1. 导航到 Web Analytics 设置页
  open(`https://app.ahrefs.com/project-settings/${projectId}/web-analytics`)
  settle(5000)

  // 2. 提取 data-key
  const dataKey = evalJs(`
    const codeBlock = document.querySelector('code,pre,[class*="code"],[class*="Code"]');
    if (codeBlock) {
      const m = codeBlock.textContent.match(/data-key="([^"]+)"/);
      if (m) return m[1];
    }
    const text = document.body.innerText;
    const m2 = text.match(/data-key="([^"]+)"/);
    if (m2) return m2[1];
    const m3 = text.match(/数据密钥值[：:] *([A-Za-z0-9+/=]+)/);
    return m3?.[1] || '';
  `)

  if (!dataKey) {
    bail("data-key-not-found", "无法从页面提取 data-key，页面结构可能已变化——页面现在长什么样，看截图。")
  }

  console.log(`   data-key: ${dataKey}`)

  // 3. 点击「保存」按钮
  stampAndClick(
    `[...document.querySelectorAll('button')].find(b=>/^保存$|^Save$/i.test(b.textContent.trim()))`,
    "保存按钮"
  )
  settle(5000)

  scene("enable-wa-final")
  console.log(`\nWeb Analytics 设置页已提取到 data-key 并点击了保存（是否真的启用，以 ${evidenceDir()} 的 enable-wa-final 截图为准）`)
  console.log(`   项目 ID: ${projectId}`)
  console.log(`   域名:    ${site}`)
  console.log(`   data-key: ${dataKey}`)
  console.log(`\n追踪脚本（写入站点 <head>）:`)
  console.log(`<script async src="https://analytics.ahrefs.com/analytics.js" data-key="${dataKey}"></script>`)
  console.log(`\n⚠️  TanStack Start 注意: head() 的 scripts 不支持 data-* 属性，`)
  console.log(`   需要在 RootDocument 的 JSX <head> 中直接写 <script> 标签。`)
}

// ── 执行 ──────────────────────────────────────────────────
try {
  if (action === "status") await doStatus()
  else if (action === "verify") await doVerify()
  else if (action === "enable-wa") await doEnableWa()
  else await doCreate()
} finally {
  if (!keepSession) {
    try { cli("close") } catch {}
  }
}
