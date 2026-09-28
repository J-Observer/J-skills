#!/usr/bin/env node
/**
 * 在 GA4 管理后台关联同域名的 Search Console 网域资源。
 * 用法：node scripts/ga4-gsc-link.mjs status|link --domain example.com [--account <账号号>] [--property <媒体资源号>] [--session <名>] [--window-slot <slot>] [--screenshot <路径>]
 * 依赖：OpenCLI 连接的 Chrome 已登录 GA4，且账号有目标 GSC 资源权限。
 * 已知坑：GA4 hash URL 直接 open 可能报 Navigation rejected；先开 /analytics/web/ 再改 hash。
 * 验证日期：2026-09-29。
 */
import { execFileSync } from "node:child_process"
import { sessionSuffix } from "./lib-scene.mjs"

const argv = process.argv.slice(2)
const action = argv[0]
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法：node scripts/ga4-gsc-link.mjs status|link --domain <域名> [--account <账号号>] [--property <媒体资源号>] [--session <名>] [--window-slot <slot>] [--screenshot <路径>]")
  process.exit(0)
}
let domain, account, property, screenshot
let session = `ga4-gsc-link-${sessionSuffix()}`
let windowSlot = null
let keepSession = false
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--domain") { domain = argv[++i]; continue }
  if (a === "--account") { account = argv[++i]; continue }
  if (a === "--property") { property = argv[++i]; continue }
  if (a === "--session") { session = argv[++i]; continue }
  if (a === "--window-slot") { windowSlot = argv[++i]; continue }
  if (a === "--screenshot") { screenshot = argv[++i]; continue }
  if (a === "--keep-session") { keepSession = true; continue }
  throw new Error(`未知参数: ${a}`)
}
if (!["status", "link"].includes(action) || !domain) throw new Error("需要 status|link --domain <域名>")
domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")

function cli(args, timeout = 30000) {
  try {
    return execFileSync("opencli", ["browser", session, "--window", "dedicated", ...(windowSlot ? ["--window-slot", windowSlot] : []), ...args],
      { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e) {
    throw new Error((e.stderr?.toString() || e.stdout?.toString() || e.message).trim())
  }
}
const evaluate = js => cli(["eval", `(()=>{${js}})()`])
const pause = ms => evaluate(`return new Promise(r=>setTimeout(()=>r(true),${ms}))`)
function waitFor(js, seconds = 25) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    try { if (evaluate(js) === "true") return } catch { /* navigation */ }
    pause(500)
  }
  throw new Error(`页面未出现预期内容：${evaluate("return (document.body.innerText||'').slice(0,1200)")}`)
}
function click(js, label) {
  evaluate(`document.querySelectorAll('[data-rankup-ga4-gsc]').forEach(x=>x.removeAttribute('data-rankup-ga4-gsc'));const x=${js};if(!x)throw new Error(${JSON.stringify(`找不到${label}`)});x.setAttribute('data-rankup-ga4-gsc','1');return true`)
  cli(["click", "[data-rankup-ga4-gsc='1']"])
  pause(700)
}
const button = label => `[...document.querySelectorAll('button,[role="button"]')].find(x=>x.offsetParent && (x.innerText||'').trim()===${JSON.stringify(label)})`
function linked() {
  const rows = JSON.parse(evaluate(`return JSON.stringify([...document.querySelectorAll('tr,[role="row"],mat-row')].map(x=>[...x.querySelectorAll('td,mat-cell,[role="cell"]')].map(c=>(c.innerText||'').trim())))`))
  return rows.some(c => c[0] === domain)
}
function discover() {
  const out = execFileSync(process.execPath, [new URL("./ga4-setup.mjs", import.meta.url).pathname, "status", "--domain", domain],
    { encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] })
  const ids = out.match(/账号[^\n]*\((\d+)\).*资源[^\n]*\((\d+)\)/)
  if (!ids) throw new Error("无法从 GA4 媒体资源列表定位域名；请传 --account 和 --property")
  if (property && property !== ids[2]) throw new Error(`域名匹配的 GA4 媒体资源号是 ${ids[2]}，与 --property 不一致`)
  account ||= ids[1]
  property ||= ids[2]
}
function goToLinks() {
  try { cli(["open", "https://analytics.google.com/analytics/web/"], 45000) }
  catch (e) { if (!/Navigation rejected/i.test(e.message)) throw e }
  waitFor("return /管理|Admin|媒体资源/.test(document.body.innerText||'')", 40)
  evaluate(`location.hash=${JSON.stringify(`#/a${account}p${property}/admin/integrations/search-console`)};return true`)
  waitFor("return /Search Console/.test(document.body.innerText||'') && /关联|Link/.test(document.body.innerText||'')", 40)
  pause(1500)
  cli(["screenshot"], 90000)
}
function run() {
  if (!property || !account) discover()
  if (!account) throw new Error("请传 --account；无法从媒体资源号确定 GA4 账号")
  goToLinks()
  if (linked()) { if (screenshot) cli(["screenshot", screenshot], 90000); console.log(`${domain} 已关联 GA4 Search Console`); return }
  if (action === "status") { console.log(`${domain} 未关联 GA4 Search Console`); return }
  click(button("关联"), "关联")
  waitFor("return /选择 Search Console 媒体资源/.test(document.body.innerText||'')")
  click(button("选择账号"), "选择账号")
  waitFor("return /关联到我管理的某个媒体资源/.test(document.body.innerText||'')")
  waitFor("return /每页项数/.test(document.body.innerText||'')")
  const row = `[...document.querySelectorAll('tr,[role="row"],mat-row')].find(x=>(x.innerText||'').trim().split(/\\s+/).includes(${JSON.stringify(domain)}))`
  const choice = JSON.parse(evaluate(`const x=${row};return JSON.stringify(x?{found:true,checkbox:!!x.querySelector('input[type="checkbox"],[role="checkbox"]')}: {found:false})`))
  if (!choice.found) throw new Error(`GSC 列表没有 ${domain}`)
  if (!choice.checkbox) throw new Error(`${domain} 显示链接图标，可能已关联其他 GA4 媒体资源`)
  click(`${row}.querySelector('input[type="checkbox"],[role="checkbox"]')`, "GSC 网域资源")
  click(button("确认"), "确认")
  click(button("下一步"), "下一步")
  cli(["screenshot"], 90000)
  waitFor("return [...document.querySelectorAll('button')].some(x=>(x.innerText||'').trim()==='选择')")
  click(button("选择"), "选择数据流")
  const stream = `[...document.querySelectorAll('tr,[role="row"],mat-row')].find(x=>(x.innerText||'').includes(${JSON.stringify(`https://${domain}`)}))`
  waitFor(`return !!${stream}`)
  click(stream, "匹配域名的数据流")
  click(button("下一步"), "下一步")
  cli(["screenshot"], 90000)
  waitFor("return [...document.querySelectorAll('button')].some(x=>(x.innerText||'').trim()==='提交')")
  click(button("提交"), "提交")
  cli(["screenshot"], 90000)
  waitFor("return /链接已创建|关联已创建|Link created/.test(document.body.innerText||'')", 30)
  goToLinks()
  if (!linked()) throw new Error("提交后关联列表未显示目标 GSC 资源")
  if (screenshot) cli(["screenshot", screenshot], 90000)
  console.log(`${domain} 已关联 GA4 Search Console`)
}
try { run() } catch (e) { console.error(e.message); process.exitCode = 1 } finally { if (!keepSession) try { cli(["close"]) } catch { /* no session */ } }
