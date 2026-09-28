#!/usr/bin/env node
/**
 * 已部署 Cloudflare 站点的上线接入总入口；顺序查询并调用现有脚本。
 * 用法：node scripts/site-onboard.mjs --domain example.com --repo <仓库> [--session 名] [--only cf,ga4,...] [--skip cf,ga4,...] [--check]
 * 依赖：cf-analytics-setup、ga4-setup、clarity-setup、indexnow-submit、gsc-domain-verify、
 * bing-import-from-gsc、yandex-setup、ahrefs-setup、webmaster-sitemap（均在同目录）。
 * 登录态：OpenCLI 所连接的 Chrome 已登录 GA4、Clarity、GSC、Bing、Yandex、Ahrefs；
 * Cloudflare API 凭据沿用各脚本。Bing 掉线时点「使用 Google 登录」；Ahrefs 冻结项目
 * 会挡新建，GSC 验证不过才考虑 DNS；Google 账户下拉默认选第一项。
 * 验证日期：2026-09-28。
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const argv = process.argv.slice(2)
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法：node scripts/site-onboard.mjs --domain <域名> --repo <仓库> [--session <名>] [--only cf,ga4,clarity,indexnow,gsc,bing,yandex,ahrefs] [--skip <列表>] [--check]")
  process.exit(0)
}
const arg = name => argv[argv.indexOf(name) + 1]
const domain = argv.includes("--domain") ? arg("--domain") : null
const repo = argv.includes("--repo") ? resolve(arg("--repo")) : null
const session = argv.includes("--session") ? arg("--session") : `onboard-${domain?.replaceAll(".", "")}`
const only = argv.includes("--only") ? new Set(arg("--only").split(",")) : null
const skip = argv.includes("--skip") ? new Set(arg("--skip").split(",")) : new Set()
const check = argv.includes("--check")
const names = ["cf", "ga4", "clarity", "indexnow", "gsc", "bing", "yandex", "ahrefs"]
if (!domain || (!repo && (!only || only.has("indexnow")) && !skip.has("indexnow"))) {
  console.error("需要 --domain；执行 IndexNow 还需要 --repo")
  process.exit(1)
}
const site = `https://${domain}`
const script = name => new URL(`./${name}.mjs`, import.meta.url).pathname
const run = (name, ...args) => execFileSync(process.execPath, [script(name), ...args],
  { encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] })
const browser = name => ["--session", `${session}-${name}`]
const has = (name, args, pattern) => pattern.test(run(name, ...args))
const sitemap = (platform, id, value) => has("webmaster-sitemap",
  [platform, "status", id, value, ...browser(platform)], /sitemap\.xml/i)
let submittedIndexNow = false
const steps = {
  cf: {
    done: () => has("cf-analytics-setup", ["status", domain], /Web Analytics 已启用/),
    apply: () => run("cf-analytics-setup", "enable", domain),
  },
  ga4: {
    done: () => has("ga4-setup", ["status", "--domain", domain, ...browser("ga4")], /已找到网站数据流|线上已部署 GA4 Measurement ID/),
    apply: () => run("ga4-setup", "create", "--domain", domain, ...browser("ga4")),
  },
  clarity: {
    done: () => has("clarity-setup", ["status", ...browser("clarity")], new RegExp(domain.replaceAll(".", "\\."), "i")),
    apply: () => run("clarity-setup", "create", "--site", domain, ...browser("clarity")),
  },
  indexnow: {
    async done() {
      const dir = join(repo, "apps/web/public")
      const file = existsSync(dir) && readdirSync(dir).find(x => /^[a-f0-9]{32}\.txt$/.test(x))
      if (!file) return false
      const key = file.slice(0, -4)
      const response = await fetch(`${site}/${file}`)
      const online = response.status === 200 && (await response.text()).trim() === key
      const record = join(repo, ".rankup/integrations.md")
      return online && (submittedIndexNow || (existsSync(record) &&
        /IndexNow[^\n]*(?:HTTP 20[02]|返回[^\n]*20[02]|推送[^\n]*20[02])/i.test(readFileSync(record, "utf8"))))
    },
    async apply() {
      const dir = join(repo, "apps/web/public")
      let file = existsSync(dir) && readdirSync(dir).find(x => /^[a-f0-9]{32}\.txt$/.test(x))
      if (!file) {
        execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: repo })
        const key = run("indexnow-submit", "--generate-key").match(/^[a-f0-9]{32}/)?.[0]
        file = `${key}.txt`
        writeFileSync(join(dir, file), `${key}\n`, { flag: "wx" })
        const envFile = join(repo, ".env")
        const old = existsSync(envFile) ? readFileSync(envFile, "utf8") : ""
        writeFileSync(envFile, /^INDEXNOW_KEY=/m.test(old)
          ? old.replace(/^INDEXNOW_KEY=.*$/m, `INDEXNOW_KEY=${key}`)
          : `${old}${old && !old.endsWith("\n") ? "\n" : ""}INDEXNOW_KEY=${key}\n`)
        throw new Error("密钥文件已写入仓库；需要提交部署后再推送")
      }
      const key = file.slice(0, -4)
      const response = await fetch(`${site}/${file}`)
      if (response.status !== 200 || (await response.text()).trim() !== key) throw new Error("密钥文件尚未在线上返回 200 且正文匹配；需要提交部署")
      run("indexnow-submit", "--site-url", site, "--key", key)
      submittedIndexNow = true
    },
  },
  gsc: {
    done: () => has("gsc-domain-verify", ["status", "--domain", domain, ...browser("gsc")], /已验证；页面显示 sitemap\.xml/) &&
      sitemap("gsc", "--property", `sc-domain:${domain}`),
    apply: () => {
      run("gsc-domain-verify", "add-site", "--domain", domain, ...browser("gsc"))
      if (!sitemap("gsc", "--property", `sc-domain:${domain}`))
        run("webmaster-sitemap", "gsc", "submit", "--property", `sc-domain:${domain}`, "--sitemap", "sitemap.xml", ...browser("gsc"))
    },
  },
  bing: {
    done: () => sitemap("bing", "--site", site),
    apply: () => run("bing-import-from-gsc", "--sites", domain, "--sitemap", ...browser("bing")),
  },
  yandex: {
    done: () => has("yandex-setup", ["status", "--site", site, ...browser("yandex")], /状态: verified/) &&
      sitemap("yandex", "--site", site),
    apply: () => {
      run("yandex-setup", "add-site", "--site", site, "--submit-sitemap", ...browser("yandex"))
      run("yandex-setup", "verify", "--site", site, ...browser("yandex"))
      if (!sitemap("yandex", "--site", site))
        run("webmaster-sitemap", "yandex", "submit", "--site", site, "--sitemap", `${site}/sitemap.xml`, ...browser("yandex"))
    },
  },
  ahrefs: {
    done: () => has("ahrefs-setup", ["status", "--site", domain, ...browser("ahrefs")], /所有权已验证/),
    apply: () => {
      run("ahrefs-setup", "create", "--site", domain, ...browser("ahrefs"))
      run("ahrefs-setup", "verify", "--site", domain, ...browser("ahrefs"))
    },
  },
}

const result = []
for (const name of names) {
  if ((only && !only.has(name)) || skip.has(name)) continue
  try {
    if (await steps[name].done()) {
      result.push([name, "已完成"])
      console.log(`${name}: 已完成`)
    } else if (check) {
      result.push([name, "失败（未完成）"])
      console.log(`${name}: 未完成`)
    } else {
      await steps[name].apply()
      if (!await steps[name].done()) throw new Error("执行后状态仍未完成")
      result.push([name, "本次完成"])
      console.log(`${name}: 本次完成`)
    }
  } catch (error) {
    const reason = (error.stderr?.toString() || error.message).trim().split("\n").at(-1)
      .replace(/[a-f0-9]{32}/gi, "[REDACTED]").replace(/google-site-verification=\S+/g, "[REDACTED]").slice(0, 240)
    result.push([name, `失败（${reason}）`])
    console.log(`${name}: 失败（${reason}）`)
  }
}
console.log("\n| 步骤 | 状态 |\n|---|---|")
for (const [name, status] of result) console.log(`| ${name} | ${status} |`)
if (result.some(([, status]) => status.startsWith("失败"))) process.exitCode = 1
