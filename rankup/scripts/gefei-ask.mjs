#!/usr/bin/env node
/**
 * gefei-ask.mjs —— 问哥飞 SEO Agent（seo.web.cafe/chat/）一个问题并把答案落盘。
 * 一条命令走完「注入 → 提问 → 反复轮询 → 取回 → 截断检查 → 落盘」全流程。
 * 状态：双证人化改造 2026-08-30（截图链路已实盘验证）——超时/自检失败退出前
 * 把截图+页面文本+最后轮询态落进 `.rankup/evidence/gefei-ask-<ts>/`。
 *
 * 移植自来源项目 `.rankup/scripts/gefei-ask.mjs`（原文件已验证：2026-08-21），
 * 2026-08-22 移植进 Skill 时做了两处泛化：
 *   1. 去掉了对项目内 `receiver.mjs`（一个要先手动起的本机 HTTP 接收进程）的依赖——
 *      本文件是 Node 进程，本来就能读本机文件系统，于是改成**直接从磁盘读取
 *      同目录下的 `gefei-chat.browser.js` 并把源码整段塞进 eval 表达式**，
 *      浏览器端 `grab()` 也相应改成直接把全文放进返回值而不是 POST 给接收端
 *      （见该文件头部注释）。新项目拿到这两个文件，浏览器登录着就能跑，
 *      不需要额外起任何进程。
 *   2. 落盘目录从项目内固定路径改成 `--out-dir`（默认当前目录下的 `gefei-out/`），
 *      不再假定调用者是原项目。
 *
 * 【为什么要有这一层编排，不能让人手工调 __gf 的四个函数】
 * 浏览器侧的 `gefei-chat.browser.js` 只是**页面里的三个函数**（ask / poll / grab /
 * check），每次用都要人肉走「注入 → 提问 → 反复轮询 → 取回 → 检查有没有被截断」。
 * 来源项目 2026-08-21 就因为缺这一层出过岔子：明明脚本在，还是被手抄了
 * 一份删掉注释的精简版粘进页面——**有脚本 ≠ 用得上脚本**，中间这层编排不做出来，
 * 重造就一定会发生。这也是为什么本文件与 `gefei-chat.browser.js` 必须配对移植，
 * 缺一个都不完整。
 *
 * 【和 seo-webcafe.mjs 的 chat 命令是什么关系——两条路径，不是谁取代谁】
 * `seo-webcafe.mjs chat` 走 HTTP `/chat/api/chat`，那个端点**强制要求登录**
 * （匿名 401），需要 `SEO_WEBCAFE_COOKIE`。而那枚会话 Cookie 是 HttpOnly，
 * 脚本读不到，要拿就得去翻浏览器的 Cookie 存储——等于把用户的登录凭据抠出来落盘。
 * 本脚本走另一条路：**请求在用户已登录的浏览器页面上下文里发出**，Cookie 由浏览器
 * 自动附带，脚本全程碰不到它。两条路径怎么选：
 *
 *   | 场景 | 用哪个 |
 *   |---|---|
 *   | 已经有 `SEO_WEBCAFE_COOKIE`（愿意把会话 Cookie 存进环境变量） | `seo-webcafe.mjs chat --ask "..."`，纯 HTTP，不用开浏览器 |
 *   | 不想 / 不能保存会话 Cookie，但有一个已登录的浏览器可用 | 本脚本，驱动那个浏览器，全程不碰凭据 |
 *   | 要跑无人值守的批量任务、没有浏览器可用 | 只能用 `seo-webcafe.mjs chat`，先解决 Cookie 怎么来 |
 *
 * 不要删除或替换 `seo-webcafe.mjs` 的 `chat` 命令——两者服务不同前提，
 * 谁都没有过时。
 *
 * 【前置】
 *   会话已经打开 https://seo.web.cafe/chat/ 且是登录态：
 *     opencli browser <名> --window background open https://seo.web.cafe/chat/
 *   会话名要描述性且唯一，开工前先 `tab list` 确认没被占用。
 *   不需要额外起任何本机进程——见上方「移植时做了两处泛化」第 1 条。
 *
 * 【用法】
 *   node gefei-ask.mjs --session gefei-0821 \
 *        --question-file q.md --slice review-0821
 *   node gefei-ask.mjs --session gefei-0821 \
 *        --question "一句话问题" --slice quick
 *   # 上一条还在生成、脚本先超时退出了——**不要重新提问**，接着轮询同一个会话：
 *   node gefei-ask.mjs --session gefei-0821 --slice review-0821 --resume
 *
 *   # 上一条被服务端截断时，续问比重问便宜得多（它保留着已查到的数据）：
 *   node gefei-ask.mjs --session gefei-0821 --continue-from "……" --slice review-0821b
 *
 * 【标志】
 *   --session <名>        必需。opencli browser 会话名（描述性且唯一）
 *   --question <文本>     直接给问题正文
 *   --question-file <路径> 从文件读问题正文（和 --question 二选一）
 *   --continue-from <片段> 续问：告诉它上次截断在哪，从那里接着写（比重问省积分）
 *   --resume               跳过提问，接着轮询同一个会话的上一条回答（脚本先超时时用）
 *   --slice <名>           必需。落盘文件名（不含扩展名）；重抓必须换名，见下方「必须知道」
 *   --out-dir <路径>       落盘目录，默认 `./gefei-out`（相对当前工作目录，会自动创建）
 *   --timeout <分钟>       轮询超时，默认 10（长回答建议 20+）
 *
 * 【必须知道的四条，都是实测踩出来的】
 * - **一条消息扣的不是 1 分。** 一次带调研的长回答实测扣 52 分（它自己要跑
 *   DR / SERP / 知识库检索），日额度上限见页面「今日已用 N/M」（VIP 档 500）。
 *   所以问题要一次问完，不要靠追问补；历史回答重新 grab 不扣费。
 * - **判完成不能只看按钮。** 「停止」这个文案在流结束后会滞留一会儿，
 *   而调研期间长度也会长时间不变。判据是**长度连续两次不变且按钮回到发送**，
 *   两条都满足才算完。
 * - **回答会被服务端拦腰截断，而按钮照样回到「发送」。** 落盘前必须看结尾
 *   是不是完整句子。本脚本会自己检查并在 `truncated` 字段报出来。
 * - **同名 slice 不会被覆盖。** 重抓要换 `--slice` 名，否则文件已存在时本脚本
 *   直接拒绝写入并报错退出，不会像原版接收端那样返回 200 却悄悄不覆盖——
 *   两种做法都是为了同一件事：绝不让你以为刷新了数据、实际磁盘上还是旧的那份，
 *   只是移植后改成了「显式报错」而不是「响应体里说了实话但状态码骗人」。
 */
import { execFile, execFileSync } from "../../backlink/scripts/lib-opencli-process.mjs"
import { promisify } from "node:util"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { newEvidenceDir, captureScene, writeManifest } from "./lib-scene.mjs"

const run = promisify(execFile)
const HELP = `gefei-ask.mjs —— 问哥飞 SEO Agent 一个问题并把答案落盘

用法：
  node gefei-ask.mjs --session <名> --slice <名> --question "问题"
  node gefei-ask.mjs --session <名> --slice <名> --question-file q.md
  node gefei-ask.mjs --session <名> --slice <名> --resume
  node gefei-ask.mjs --session <名> --slice <名> --continue-from "被截断处的原文片段"

标志：
  --session <名>          必需。opencli browser 会话名，需已打开 seo.web.cafe/chat/ 且登录
  --question <文本>       问题正文
  --question-file <路径>  从文件读问题正文
  --continue-from <片段>  续问：接着上次被截断处写完（比重问省积分）
  --resume                跳过提问，接着轮询同一会话的上一条回答
  --slice <名>            必需。落盘文件名（不含扩展名），重抓必须换名
  --out-dir <路径>        落盘目录，默认 ./gefei-out
  --timeout <分钟>        轮询超时，默认 10
  --help                  打印本帮助并退出

必读的四条坑，见文件头注释。和 seo-webcafe.mjs 的 chat 命令是两条路径不是替代关系，
选哪个见文件头「两条路径怎么选」表。`

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP)
  process.exit(0)
}

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > -1 ? process.argv[i + 1] : d
}
const die = (m) => {
  console.error(m)
  process.exit(1)
}

/**
 * 取证退出（双证人化 2026-08-30，截图链路已实盘验证）：超时/自检失败不再
 * 只留一句结论。die 之前把「截图 + 页面文本 + 最后轮询态」落进
 * `.rankup/evidence/gefei-ask-<ts>/`——「按钮还是停止」「额度到底读没读到」
 * 这类问题，事后只有截图能回答。会话**不关**（本脚本从不关会话，回答可能
 * 还在生成，--resume 还要用它）。
 */
const dieWithScene = (stopReason, m, extra) => {
  try {
    const dir = newEvidenceDir("gefei-ask")
    captureScene({
      dir,
      tag: `fail-${stopReason}`,
      screenshot: (p) => execFileSync("opencli", ["browser", session, "screenshot", p], { stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 }),
      pageText: () => execFileSync("opencli", ["browser", session, "--window", "background", "eval",
        "(()=>{try{return document.body?document.body.innerText.slice(0,20000):''}catch(e){return 'PAGE_TEXT_FAILED:'+e}})()"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }),
      extra,
    })
    writeManifest(dir, { script: "gefei-ask", session, slice, stopReason, finishedAt: new Date().toISOString() })
    console.error(`现场已落盘：${dir}（截图 + 页面文本 + 最后状态，判读以它们为准）`)
  } catch (e) {
    console.error(`（取证失败：${String(e?.message || e).slice(0, 200)}）`)
  }
  die(m)
}

const session = arg("session") || die("必须给 --session（描述性且唯一，开工前先 tab list 确认没被占用）。--help 看用法")
const slice = arg("slice") || die("必须给 --slice（落盘名；重抓必须换名，同名文件已存在会被拒绝写入）")
const outDir = arg("out-dir", "./gefei-out")
const maxMinutes = Number(arg("timeout", "10"))

const resume = process.argv.includes("--resume")
let question = arg("question")
const qFile = arg("question-file")
const continueFrom = arg("continue-from")
if (qFile) question = readFileSync(qFile, "utf8")
if (continueFrom) {
  question = `你上一条在「${continueFrom}」处被截断了。不用重新调研，从那里接着写完。`
}
// --resume 是「上一轮已经问过了，只是脚本先超时退出」的入口。
// 带调研的回答实测能跑十几分钟，而重新提问要再扣一次积分（一次约 52 分），
// 所以超时**绝不能**走重问。这个分支跳过提问，直接接着轮询同一个会话。
if (!question && !resume) die("必须给 --question / --question-file / --continue-from / --resume 之一。--help 看用法")

// 落盘目标提前算好、提前查重——避免跑完一整轮提问和轮询（真金白银的积分）
// 之后才发现文件已存在、写不进去。
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `${slice}.md`)
if (existsSync(outFile) && !resume) {
  die(
    `${outFile} 已存在，本脚本不会覆盖同名 slice（避免你以为刷新了数据、` +
      `实际磁盘上还是旧的那份）。\n换一个 --slice 名，或者先手动移走旧文件。`,
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 所有表达式都用 JSON.stringify 包一层——eval 返回裸字符串时没有 JSON 信封。 */
async function ev(js) {
  const { stdout } = await run("opencli", ["browser", session, "--window", "background", "eval", js], {
    maxBuffer: 32 * 1024 * 1024,
  })
  const i = stdout.indexOf("{")
  if (i < 0) return stdout.trim()
  try {
    const j = JSON.parse(stdout.slice(i, stdout.lastIndexOf("}") + 1))
    return typeof j === "string" ? JSON.parse(j) : j.result !== undefined ? j.result : j
  } catch {
    return stdout.trim()
  }
}

// 1. 注入：把同目录下 gefei-chat.browser.js 的源码整段读出来，直接塞进 eval 表达式。
//    不再依赖任何本机 HTTP 接收进程（原版靠一个项目内的 receiver.mjs 提供 /script
//    端点，见该文件头注释「移植时做了两处泛化」）。execFile 走 args 数组不经过 shell，
//    参数长度上限是系统 ARG_MAX（macOS 通常几 MB），这份脚本几 KB，稳稳够用。
const browserScriptPath = join(dirname(fileURLToPath(import.meta.url)), "gefei-chat.browser.js")
const browserScript = readFileSync(browserScriptPath, "utf8")
const injected = await ev(
  `(() => { (0, eval)(${JSON.stringify(browserScript)}); return JSON.stringify({ 注入: !!window.__gf }); })()`,
)
if (!injected?.注入) dieWithScene("inject-failed", `注入失败：${JSON.stringify(injected)}\n先确认会话停在 seo.web.cafe/chat/ 且已加载完成——会话停在哪一页，看截图。`, { injected })

// 2. 自检：是不是登录态。不是登录态就停，别浪费一次提问。
const check = await ev(`(() => JSON.stringify(window.__gf.check()))()`)
console.log("自检：", JSON.stringify(check))
if (!check?.已登录) dieWithScene("login-check-failed", "自检读不到额度（判据：页面上的「今日已用 N/M」）。「没登录」与「页面改版让判据失配」在此不可分辨——看截图。", { check })

// 3. 提问。到这一步才开始扣积分。--resume 直接跳过，接着轮询上一轮的回答。
if (resume) {
  console.log("--resume：跳过提问，接着轮询同一个会话的上一条回答")
} else {
  const asked = await ev(`(() => JSON.stringify(window.__gf.ask(${JSON.stringify(question)})))()`)
  if (asked?.错误) dieWithScene("ask-failed", `提问失败：${asked.错误}`, { asked })
  console.log(`已发送 ${asked.已发送} 字，开始轮询…`)
}

// 4. 轮询。单次 eval 别超 12 秒——流式输出期间渲染器很忙，超时拿到的是
//    「渲染器无响应」，这次调用有没有副作用无从确认。
const deadline = Date.now() + maxMinutes * 60 * 1000
let last = null
while (Date.now() < deadline) {
  await sleep(8000)
  const st = await ev(`(() => JSON.stringify(window.__gf.poll()))()`)
  if (JSON.stringify(st) !== JSON.stringify(last)) {
    console.log(`  ${new Date().toISOString().slice(11, 19)}  长度 ${st?.长度}  按钮 ${st?.按钮}`)
    last = st
  }
  if (st?.done) break
}
if (!last?.done) dieWithScene("poll-timeout",
  `${maxMinutes} 分钟内没等到回答结束。最后状态：${JSON.stringify(last)}\n` +
  `答案可能还在生成（按钮仍是「停止」= 它在跑调研，长度会先缩后涨，属正常）。\n` +
  `**不要重新提问**，会再扣一次积分。接着轮询同一个会话：\n` +
  `  node gefei-ask.mjs --session ${session} --slice ${slice} --resume --out-dir ${outDir} --timeout 20`,
  { lastPoll: last })

// 5. 取回。走「复制本段」按钮拿原始 Markdown，不用 innerText——
//    回答含表格时 innerText 会把表格压成制表符，和页面自己的 Markdown 不是一份东西。
//    grab() 现在直接把全文放进返回值（见 gefei-chat.browser.js 头注释），
//    本脚本自己用 fs 落盘，不再经过任何本机接收进程。
const got = await ev(`(async () => JSON.stringify(await window.__gf.grab()))()`)
if (got?.错误) dieWithScene("grab-failed", `取回失败：${JSON.stringify(got)}`, { got, lastPoll: last })

// 6. 截断检查。服务端拦腰截断时按钮照样回到「发送」，poll 也照样 done。
const tail = String(got.结尾 || "")
// 判截断之前先剥掉 Markdown 的收尾标记。回答常以「……路径。**」结尾——
// 句子是完整的，`**` 只是加粗的闭合符。不剥就会把完整回答误报成截断
// （来源项目 2026-08-22 实测误报一次）。误报的代价是白花一次续问的积分。
const cleanTail = tail.replace(/[*_`~\s]+$/, "")
const truncated = !/[。！？.!?」』）)\]】>]$/.test(cleanTail)

// 落盘。existsSync 已在最前面查过一次，这里是提问/轮询期间被别的进程抢先写入的
// 兜底：宁可重复报错也不覆盖。
if (existsSync(outFile) && !resume) {
  die(`${outFile} 在本次运行期间被写入了（并发跑了两次同名 slice？）。答案已取回但未落盘，换个 --slice 名重跑取回步骤。`)
}
writeFileSync(outFile, String(got.文本 || ""), "utf8")

console.log(
  JSON.stringify(
    { 字数: got.字数, 落盘: outFile, 结尾: tail, truncated },
    null,
    2,
  ),
)
if (truncated) {
  console.error(
    `\n⚠️  结尾不是完整句子，大概率被服务端截断了。\n` +
      `   续问（便宜，保留已查到的数据）：\n` +
      `   node gefei-ask.mjs --session ${session} --slice ${slice}b --out-dir ${outDir} \\\n` +
      `     --continue-from ${JSON.stringify(tail.slice(-20))}`,
  )
  process.exitCode = 2
}
