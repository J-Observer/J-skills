# SEO：数据通道地图与项目接入

> 渐进式加载：本篇只讲数据从哪来、新项目怎么接入。

## 一、数据通道地图(2026-08 实测)

| 通道 | 用法 | 坑 |
|---|---|---|
| **GSC(真实点击,最高优先)** | `opencli browser <描述性会话名>` 驱动用户真实 Chrome 的 dedicated 窗口，导航 performance 报告；每页行数调 100 逐维度读 | 复用用户登录态，读回实际页面和数据 |
| **Google Suggest(真实输入,免费无限)** | `curl --retry 3 --retry-all-errors ${HTTP_PROXY:+-x "$HTTP_PROXY"} "https://suggestqueries.google.com/complete/search?client=firefox&oe=utf-8&ie=utf-8&hl=<hl>&gl=<gl>&q=<enc>"` | **oe/ie=utf-8 必带**,否则非拉丁文字结果丢失;`[512]` subtype = 高量词;成功响应但空列表只记「未返回联想」，不否决需求；不可用与裁决口径见 [entry.md](playbooks/entry.md#4--判读)，GT 失败口径见 [trends.md](trends.md#trends-侧) |
| **哥飞官方关键词工具** | 加载 `gefei-keywords`，按官方 Skill 取目标市场及全球月量、趋势和 CPC | 记录工具名、市场、日期与原始响应；不以站内 AI 转述当原始数据 |
| **哥飞官方页面与竞品工具** | 加载 `gefei-page` / `gefei-competitor`，按官方 Skill 取页面检查和竞品数据 | 工具结果需与真实页面、目标市场和其他来源核对；失败状态不能记为零 |
| **PageSpeed 网页版(lab + field 两套)** | `node <rankup>/scripts/pagespeed.mjs collect <url> --strategy both` 直接落盘完整 LHR JSON(2026-09-12 起默认路径,opencli 驱动真实可见 Chrome 无人值守出分);`plan <url> --strategy both` 只出链接、不采数,是没有 opencli / 非 macOS 时的兜底,拿到链接要在真实前台可见的浏览器标签页里打开才会读数 | **零 key 零配额**(2026-08-31 起停用带 key 的 PSI API)。跑分只在标签页真的可见时才渲染得完,后台标签页会一直停在 Running analysis;跑不出来**不等于**没有数据。本地 lighthouse median-of-N 仍可做同环境"修复前"基线,绝对值不可跨环境比 |
| **GSC Gen AI 效果报告(AI 曝光,2026-06 新)** | Search Console → 效果 → Generative AI 报告;追踪内容在 AI Overviews/AI Mode 中的曝光次数、页面、国家、设备 | 2026-06-03 上线,2026-08-31 起向所有网站推出(旧稿写「按子集推出」已过期);**暂无点击/CTR/查询词数据**;另有 opt-out 开关(不影响传统排名) |
| **死路(勿再试)** | **Semrush / Similarweb / Ahrefs 的全部程序化接口(API + MCP)**——共享账号代理**出借的是会话,不是账号**;API key 与 OAuth 同意页都住在账号设置区,面板不会递出来,绕过面板去取等于绕过访问控制。2026-08-27 逐家核实:Semrush Analytics/Projects API 要 Business 档+另购 units、MCP 与 HTTP 共用同一份 units(实测 units=0,**换客户端/换传输/重连 OAuth 都不会改变**);Similarweb Data API 与 MCP 要 Business/Enterprise/API-only 档;Ahrefs 2026-07-18 复验全接口 "Insufficient plan"。**浏览器抓取不是临时替代方案,它是这个账号形态下唯一正确的方案**(详见 `provider-capabilities.md` 四·五)。另:agent-browser 连真实 Chrome(Chrome 136+ 禁 CDP)、Google Trends(共享代理 IP 常年 429) | |
| 网络 | 本机 shell 直连部分外网 TLS 间歇重置(curl exit 35):Google 系/github/npm registry/ui.shadcn.com 走本机代理($HTTP_PROXY,按需)(node 系 CLI 另加 `NODE_USE_ENV_PROXY=1` 才吃 env,undici EHPA),git push 带 `HTTPS_PROXY`,所有 curl 带 `--retry-all-errors`;**api.cloudflare.com 反着来:必须直连**(2026-07-18 实证代理下 wrangler 全部 fetch failed,直连一次成)——wrangler deploy 不带代理+重试 | zsh 内联 for 循环易 parse error,写成 .sh 脚本跑;管道尾接 tail 会吞退出码,成功判定用输出 grep;刚部署完 workers.dev 可能瞬态回 CF 1042,几十秒自愈勿误判 |

> **2026-08 起，所有二手 SERP 通道都在 `google.com/goto` 的影响半径内**——
> Google 把 SERP 出站链接换成了不可解码的服务端跳转。通道异常先按
> [`seo-serp.md`](seo-serp.md)「Google 出站链接改成 `google.com/goto` 跳板」一节自检，不要直接当成盘面变化。

## 二、SEO 项目接入

项目目录结构、初始化模板、密钥元数据边界和状态对账规则统一读取 [`project-memory.md`](project-memory.md)，不在本文件维护第二份目录协议。

SEO 接入按三步进行：

1. **收集事实**：读取站点代码和线上 HTML，检查 sitemap、robots、canonical、hreflang、结构化数据、GSC、SERP、关键词、性能和已有转化路径。
2. **汇总落档**：把基线写入 `.rankup/baseline.md`，词库写入 `keywords.md`，技术发现写入 `audit.md`，取舍写入 `decisions.md`。
3. **形成计划**：将工作按 P0–P2 排序，每项写明动作、证据、预期影响和完成判定；已有站点直接从真实数据暴露的瓶颈开始，不重做无关的初始化。

允许并行做互不依赖的只读调查，但是否使用多 Agent 由当前执行环境和任务规模决定，不是 SEO 接入的前置条件。
