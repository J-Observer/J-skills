# 调研流水线 · P1 挖需求

> 本文件从 [`research.md`](../research.md) 拆出（2026-09-30）。开跑前先读主文件的[四条铁律](../research.md#四条贯穿全部流水线的铁律)、[五个取数动作](../research.md#五个取数动作与编排探索循环)与[阶段 0](../research.md#阶段-0-开工前-30-秒每条流水线都以它开头)；路径变量 `$RANKUP` / `$BACKLINK` 见主文件「怎么用」。

## P1 · 挖需求 / 找方向 / 不知道做什么

### 触发

「不知道做什么」「找几个关键词」「挖点需求」「最近有什么能做的」「找个新方向」
「挖个新词的工具站」「有什么能做的方向」「找选题」「市场探测」「选品调研」

### 产出

1. `.rankup/decisions.md` —— 1–3 个候选方向，每个带：主词 + 支撑词矩阵（KD / 月搜 / CPC / SERP 盘面摘要）、竞品真实流量（Similarweb + Semrush **各标口径**）、收入估算区间、开发复杂度、量化的继续/停止标准。
2. `.rankup/keywords.md` —— 候选词表，每行带来源脚本 + 日期。
3. `.rankup/checks.md` —— [`research-checklist.md`](../../research-checklist.md) 那张检查矩阵，逐项打勾。
4. **被排除的方向 + 排除理由（带数据）** 和 **数据局限性声明**（哪些没取到、为什么）——这两项不是可选的，见 research-checklist 第九节。

### 流水线

候选池扩容同样按[「五个取数动作与编排」](../research.md#五个取数动作与编排探索循环)的编排④（什么都没有）跑：
从榜单候选域名做站→词，不要只在某一个候选词根上换后缀。

#### 第一小时最小可执行子集（面对 24 个脚本不要发呆，先跑这 6 个）

**公开源可直接跑；Stripe 官方分支需要 CLI 授权并按积分计费，全榜/新进筛选保留旧入口（本轮未重验）**，可以在**一条消息里派 6 个 sub agent 并行**。

| 阶段 | 并行/串行 | 跑什么 | 拿到什么 | 卡住了怎么办 |
|---|---|---|---|---|
| 1a | **并行 A** | `node $RANKUP/scripts/demand/stripe-referring.mjs top --m YYYYMM --new-only --limit 40 --json --out /tmp/r/stripe.json` | 本月**新进榜**的 Stripe 引荐域名 = 最强的「新机会」信号 | 新进筛选使用旧全榜入口（官方无等价、本轮未重验，原记录不计每日配额）；不指定月份另需官方 overview 1 积分。空了先核对 sources 状态与榜单月份 |
| 1b | **并行 A** | `node $RANKUP/scripts/demand/boards.mjs trustmrr --board growth --limit 40 --json --out /tmp/r/mrr.json`<br>`node $RANKUP/scripts/demand/boards.mjs traffic-cv --type traffic --tab new --json --out /tmp/r/tcv.json` | TrustMRR 是 **Stripe 实连**（唯一能当数字用的收入源）；traffic.cv 是定性信号 | 需真实浏览器过 CF 质询，不需登录。失败带 `--keep-open` 保住现场 |
| 1c | **并行 A** | `node $RANKUP/scripts/demand/boards.mjs taaft --board requests-top --pages 2 --json --out /tmp/r/wish.json` | 许愿区**按票数排**——真实需求信号最强的一档 | 同上，CF 质询 |
| 1d | **并行 A** | `node $RANKUP/scripts/demand/reddit-wishes.mjs --subreddit SaaS,startups,SideProject,Entrepreneur --time month --limit 40 --json --out /tmp/r/reddit.json` | 用户**原话**（可直接当页面标题用） | 没 token 会走 RSS，`--delay` 别低于 6000，否则 429 |
| 1e | **并行 A** | `node $RANKUP/scripts/demand/hn-signals.mjs --mode ask --days 14 --limit 40 --json --out /tmp/r/hn.json`<br>`node $RANKUP/scripts/demand/github-trending.mjs --since weekly --limit 30 --json --out /tmp/r/gh.json` | 痛点讨论 + 唯一公开的 star 增速信号 | HN 走 Algolia，稳；GitHub trending 是公开 HTML |
| 1f | **并行 A** | `/anysearch` → `python3 ~/.agents/skills/anysearch/scripts/anysearch_cli.py batch_search --query "site:turbo0.com new tools" --query "huggingface trending spaces this week" --query "indie hackers revenue milestone 2026" --max_results 10` | 覆盖 **capability-map「手工源」表**里 turbo0 / IndieHackers / HuggingFace Trending / Arena.ai 那几行——它们**没有脚本**，此前只能靠人 | 匿名可跑（已实测）；要更高频率再配 `ANYSEARCH_API_KEY` |

**合流（串行，主线做）**：

```bash
mkdir -p /tmp/r && cat /tmp/r/*.json | jq -r '..|.domain? // empty' | sort -u > /tmp/r/candidates.txt
wc -l /tmp/r/candidates.txt
```

#### 第二小时起：候选池 → 域名画像 → 阈值初筛

| 阶段 | 并行/串行 | 跑什么 | 拿到什么 | 卡住了怎么办 |
|---|---|---|---|---|
| 2 | **串行**（官方 API 按积分余额计费） | `node $RANKUP/scripts/demand/domain-profile.mjs --file /tmp/r/candidates.txt --out /tmp/r/profiles.jsonl --limit 60` | 每个域名的**注册日期 / 站龄 / 月访问 / 流量结构 / DR / 核心搜索词** | 官方 CLI 报错行 = 取数失败，**不是「该站没数据」**。按提示检查余额/每日上限或上游错误（`.jsonl` 可续跑，已有行会跳过，包括失败行） |
| 3 | 串行，主线判读，**不跑脚本** | 对 `/tmp/r/profiles.jsonl` 套 [`demand-discovery.md`](../../experiences/demand-discovery.md)「原帖给的阈值」：注册 <1 年 / 月访问 >3,000 / 搜索占比 >20% / 直接访问占比 >20% | 通常 60 个域名剩 0–2 个（**实测命中率约 300:1**，剩 0 个是正常结果，不是失败） | 剩 0 个 → 回阶段 1 换榜单源再来一轮，**不要放宽阈值**。阈值是可调的，但调之前要写明为什么调 |

#### 第三段：入选候选逐个走验证链路 → 进 P2

| 阶段 | 并行/串行 | 跑什么 | 拿到什么 | 卡住了怎么办 |
|---|---|---|---|---|
| 4 | **并行 B**（零配额那半） | 每个入选域名派一个 agent：<br>`node $RANKUP/scripts/demand/sitemap-diff.mjs --domain <域名> --all --slug-words --top-words 40`<br>`node $RANKUP/scripts/demand/site-network.mjs --domain <域名> --confirm --max 10 --json` | 它铺了哪些词族（slug 词频）、它背后还有哪些兄弟站 | `site-network` 空结果读成「这条路没找到」而不是「它没有兄弟站」——实测某组 10 个兄弟站没有一个共享指纹，绑住它们的是同一个 `utm_source` |
| 5 | **串行 · 独占面板**（铁律三） | **一个** agent 顺序跑完全部入选域名：<br>`node $BACKLINK/scripts/similarweb-query.mjs --domain <d> --report performance --out sw-<d>.json`<br>`node $BACKLINK/scripts/semrush-traffic.mjs --domain <d> --out semt-<d>.json`（**总访问口径，用来和上一行并排**）<br>`node $BACKLINK/scripts/semrush-overview.mjs --domain <d> --db <目标国> --out sem-<d>.json`（自然搜索口径，**不能和总访问裸比**） | 真实总访问、渠道构成 / 两家的总访问口径互证 / 单国家库自然流量 | `stable:false` 会直接抛错而不是给最后一次读数（**静默的错数比显式超时坏**）。失败前脚本已 `captureScene` 落截图+DOM 进 `--evidence-dir`，先开现场再下结论 |
| 6 | 与 5 并行（不同工具，不冲突） | `python3 $RANKUP/scripts/gt.py compare "<词1>" "<词2>" --geo <国> --time 12m` | 方向在涨还是在跌 | **全组连坐**：compare 里有一个词太冷，**整组**返回「没有数据」。处理顺序：先跑必然有量的词 → 逐个单跑 → 只把有量的进 compare。一次最多 5 个词 |
| 7 | 串行，本地零配额 | `node $RANKUP/scripts/seo-webcafe.mjs money --income 1000 --kws 5 --kd 30` | 目标收入需要多少 UV / 日搜索量 / 外链投入 / ROI | 纯本地计算，不会失败 |
| 8 | 串行 | 把每个存活候选的**主词当词根**交给 [P2](p2-keyword-root.md#p2--词根调研这个词能不能做扩成树) 走完整流水线 | 立项 / 否决 | — |

### 判读（每个阶段的结果对照哪份文档的哪一节）

| 阶段 | 判据在 |
|---|---|
| 1a/1b 收入信号 | [`demand-sources/revenue-and-ads.md`](../../demand-sources/revenue-and-ads.md) 二「收入数字该信谁」：**TrustMRR 是 Stripe 实连（能当数字用），traffic.cv 是定性信号，Toolify 只说明「在收钱」**。三家域名集合几乎不相交，是互补候选池 |
| 1c/1d 用户原话 | [`experiences/demand-discovery.md`](../../experiences/demand-discovery.md) 四·3「许愿句式」+ 四·2 高价值关键句（最值钱的一句是 `"I love this extension, but..."`） |
| 2/3 域名画像与阈值 | [`demand-sources/validation-chain.md`](../../demand-sources/validation-chain.md) 十「常用的筛选阈值：判据在裁定集」→ [`demand-discovery.md`](../../experiences/demand-discovery.md)；②·五「低 DR 站先查域名年龄」——**年龄 9–18 个月的高流量站是最强信号；<6 个月的低流量什么都不说明**（还在蜜月期） |
| 4 站群 | [`demand-sources/competitors-and-roots.md`](../../demand-sources/competitors-and-roots.md) 九·二那张 strong/medium/weak 指纹表（**那是给你的判读指引，不是脚本输出**）。价值在「哪几个做成了、哪几个没跑起来」，后者才是机会 |
| 5 两个面板打架 | [`demand-sources/validation-chain.md`](../../demand-sources/validation-chain.md#②六四-semrush-的自然流量什么时候不能信先看它的词库分布再决定信不信总数) **[②·六·四](../../demand-sources/validation-chain.md#②六四-semrush-的自然流量什么时候不能信先看它的词库分布再决定信不信总数)**：先拉排名词分布再决定信不信总数。第一大词占比 <20% 可信；**>50% 且位次 #5–#10 → 按高估 4–13 倍处理，以面板为准**；只有一套数时标「未验证」 |
| 6 趋势 | [`trends.md`](../../trends.md) 〇「0-100 是组内归一化，必须双锚」——实测两个锚点系数差 1.33 倍，**Trends 相对刻度约 ±30% 失真，单锚必须报区间** |
| 7 折成钱 | [`demand-sources/validation-chain.md`](../../demand-sources/validation-chain.md) **十·五**：低进入门槛恰恰是坏消息（没有护城河）；新进入者时间线在**加速**要读成「淘金潮末段」 |
| 元规则 | [`experiences/demand-discovery.md`](../../experiences/demand-discovery.md) 〇「取数失败会伪装成一个否定答案」——**只有零需要被证明是零**：决定生死的零，必须换一种调用方式复查到两次一致 |

### 省配额

| 档位 | 这条链路里的谁 | 代价 |
|---|---|---|
| **零配额，放开跑** | 1e hn-signals / github-trending · 1f anysearch · 4 sitemap-diff / site-network · 6 gt.py · 7 money · `seo-webcafe.mjs kgr/string/money/email` | 只花时间。**并行度只受机器限制** |
| **零配额但要真浏览器**（过反爬，不需登录） | 1b boards trustmrr/traffic-cv · 1c taaft · reviews-mine 的 trustpilot/g2/capterra · chrome-stats | 每个源一个**描述性会话名**，跑完 `opencli browser <session> close`。sub agent 退出前必须显式关 |
| **官方 API 积分** | 1a `stripe-referring` 官方分支每业务调用 1（全榜保留旧入口）；`payment-referrers serp` 每查询 2；KD 等工具按官方实时目录 | 阶段 0 查价格与余额，保留实际扣费字段；不沿用旧网站共享池或缓存免费口径 |
| **面板配额，一次一个采集器** | 5 similarweb-query / semrush-overview / semrush-report / similarweb-keywords | 会话名固定，**不许并行**。`similarweb-batch` 单域 6–10 秒，可续跑 |
| **要钱的** | `domain-profile.mjs` 默认官方 gefei CLI（domain_overview 当前 2 积分/域名，以目录为准）；`--provider tabapi` 按 credit · `serp-query`（serper 付费额度） | 官方 API 扣余额，不用网站每日赠送额度 |

### 收尾

- 候选词表 → `.rankup/keywords.md`（每行带来源脚本 + 日期 + 引擎/国家）
- 方向级结论、排除理由、数据局限性 → `.rankup/decisions.md`
- [`research-checklist.md`](../../research-checklist.md) 的检查矩阵复制进 `.rankup/checks.md` 并逐项打勾：
  **全部必做项 + 全部应做项 + 至少 3 个按需项**打完才算调研完成
- 证据目录留在 `.rankup/evidence/demand/`，**不要清理**——manifest 是下一轮判读的唯一依据

---

