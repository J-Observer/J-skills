# 需求挖掘数据源：源 → 脚本路由表

用户说「**找几个关键词**」「**挖点需求**」「**最近有什么能做的**」「**找个新方向/新词的工具站**」时，
本文件是入口。它只回答一件事：**要这个信号，跑哪条命令。**

- 「往哪儿看、怎么判断这个需求值不值得做」在
  [`experiences/demand-discovery.md`](experiences/demand-discovery.md)——那是裁定集。
- 「拿到候选之后怎么验证词」在 [`seo-webcafe.md`](seo-webcafe.md) 与 [`trends.md`](trends.md)。

全部脚本在 `<rankup-skill-dir>/scripts/demand/`。Node 22、零第三方依赖、
统一支持 `--help` / `--json` / `--out <file>`。**所有条目的取数路径都在 2026-08-23 逐个发过真请求验证**，
不是照文档抄的。

> **口径已变，验证日未重跑（2026-08-30 声明）。** 那次验证在三波去判决化重构**之前**：
> 此后脚本删掉了全部 verdict 与阈值分档（`level`、`belowFloor`、`strength` 等字段已不存在）、
> 失败改为落 `{url,status,body}` 现场 + manifest 逐源记状态。**取数路径本身仍然成立，
> 但输出形状变了**——本文件描述某个脚本「会输出什么」时，以 `--help` 和实际产物为准，
> 与本文措辞冲突时**信脚本**。判读一律看
> [`capability-map.md`](capability-map.md) 声明的当前行为与
> `backlink/SKILL.md` 法律 `scripts-collect-ai-judges`。

---

## 一、先决定：你现在缺的是哪一类信号

| 你想知道 | 去第几节 |
|---|---|
| 谁已经收到钱了 | [二](demand-sources/revenue-and-ads.md#二谁已经收到钱了) |
| 谁在用哪个支付网关（长尾反查） | [二·五](demand-sources/revenue-and-ads.md#二五长尾支付网关反查) |
| 谁在花钱买流量 | [三](demand-sources/revenue-and-ads.md#三谁在花钱买流量) |
| 谁做了但没做好（差评） | [四](demand-sources/users-and-launches.md#四谁做了但没做好差评矿) |
| 谁在为这件事付外包费 | [五](demand-sources/users-and-launches.md#五谁在为这件事付外包费) |
| 正在冒出来的新产品 | [六](demand-sources/users-and-launches.md#六正在冒出来的新产品) |
| 持续涌现新词的平台 | [七](demand-sources/users-and-launches.md#七持续涌现新词的平台) |
| 用户的原话（许愿与吐槽） | [八](demand-sources/users-and-launches.md#八用户的原话) |
| 竞品正在往哪儿下注 | [九](demand-sources/competitors-and-roots.md#九竞品正在往哪儿下注) |
| 我盯上了一个跑通的站，想把它整个站群拆开 | [九·二](demand-sources/competitors-and-roots.md#九二一个站背后的整个站群) |
| 我连方向都没有，只有一个词根 | [九·五](demand-sources/competitors-and-roots.md#九五从词根出发) |
| 正在上涨的新站（平台子域名监控） | [九·三](demand-sources/competitors-and-roots.md#九三平台子域名监控certificate-transparency) |
| 跨平台自动补全扩词 | [九·七](demand-sources/competitors-and-roots.md#九七跨平台自动补全扩词) |
| **同行已经把答案写出来了，我只是没去读** | [九·八](demand-sources/competitors-and-roots.md#九八已经有人替你调研过了哥飞社区) |
| **不管缺哪类信号，先亲眼看一遍搜索结果首页** | [一·五](#一五先亲眼看一遍搜索结果首页多引擎实勘) |
| 拿到候选之后怎么验证 | [十](demand-sources/validation-chain.md#十候选验证链路) |
| 排上去到底值不值 | [十·五](demand-sources/validation-chain.md#十五能排上去和能赚钱是两个独立命题--判据见裁定集) |

**一条通则**：任何一节拿到的候选，最终都要汇成一份**域名清单**或**关键词清单**，
再走第十节验证。别在没验证之前就开工。

```bash
# 多个榜单合流成去重域名清单的标准姿势
node scripts/demand/boards.mjs traffic-cv --json \
  | jq -r '.[].domain' | sort -u > /tmp/candidates.txt
```

---

---

## 一·五、先亲眼看一遍搜索结果首页（多引擎实勘）

**任何调研的第一个动作，是去搜索引擎里把目标词搜一遍，亲眼看第一页排的是什么。**
不是第二步，不是补充材料，是第一步。

理由很硬：**数据平台给的都是加工过的二手结论**——Semrush 的自然流量是模型输出
（追踪到的关键词 × 搜索量 × 位次点击率），Similarweb 是面板外推，KD 是估算分。
而搜索结果首页是搜索引擎**此刻真正端给用户的东西**，没有中间层。
一个词的量再好看，首页十条全是平台自己的产品页，这个词就不该做——
这个判断只有亲眼看首页能得出，任何指标都给不了。

### 至少搜这几个，且知道哪些不是独立样本

| 引擎 | 为什么要看 | 注意 |
|---|---|---|
| **Google** | 绝大多数市场的主战场；AI Overviews / AI Mode 也在这里 | 必看 |
| **Bing** | 独立索引，与 Google 的取舍经常不同；也是 Copilot 的底座 | 必看 |
| **DuckDuckGo** | 隐私向用户的入口 | **网页结果主要来自 Bing 索引**——它和 Bing **不是两个独立样本**，两边一致不构成交叉验证 |
| **Brave Search** | 自有索引，是 Google/Bing 之外真正的第三个视角 | 想要第三个独立样本时用它，不要拿 DuckDuckGo 凑数 |
| **目标市场的本地引擎** | 韩国 Naver、俄语区 Yandex、中文区百度、捷克 Seznam | 做非英语市场时**必看**：本地引擎的首页构成常常和 Google 完全不同 |
| **AI 搜索**（AI Overviews / AI Mode / Perplexity / ChatGPT 搜索） | 2026 的分发里**引用优先于排名**，被引用的是谁比谁排第一更重要 | 记下它引用了哪几个域名，只作线索，**单次查询不是权威名单**：同一提示重复问得到同一名单的概率不到 1%。要下判断，按 [`seo-geo.md`](seo-geo.md) 步骤 2 在目标引擎里重复采样、只报出现率 |

### 怎么搜才算数

1. **OpenCLI 使用 dedicated 窗口。** 登录态和搜索历史可能影响结果，记录实际页面和查询参数。
2. **显式指定地区与语言**（`gl` / `hl`，或引擎自己的地区设置）。
   不指定就是按出口 IP 判定——用代理时可能拿到代理所在国的结果，
   看起来完全正常，实际测的是另一个市场。
3. **公开 SERP 也用 `opencli browser <描述性会话名>` 驱动用户的 Chrome**；
   显式指定地区与语言，结束后关闭会话。
4. **不要用二手 SERP 接口代替这一步。** `serp-query.mjs`、官方 Skill 的 `serp`
   是给规模化统计用的，返回的是结构化字段，看不到版式、看不到 SERP 特性占了多少屏、
   看不到 AI 答案。而且 2026-08 起 Google 把出站链接换成了 `google.com/goto` 跳板，
   二手通道更容易降级而接口照样回 200——见 [`seo-data-channels.md`](seo-data-channels.md) 对应一节。

### 每个引擎记下这七样

写进 `.rankup/keywords.md`（词级）或 `.rankup/decisions.md`（方向级），**带引擎、国家、日期**：

| 记什么 | 它回答的问题 |
|---|---|
| 前十的**页面类型构成** | 真工具站 / 论坛 UGC / 素材库 / 官方文档 / 平台商品页各占几席 |
| 有几个是**专门为该词制作的页面** | 这是唯一跨工具、跨时间可比的竞争强度指标 |
| **最弱的那个占位者**长什么样 | 免费托管页、个人子域、内容单薄的页面 = 可攻的缺口 |
| **SERP 特性**占了多少屏 | PAA、视频、图片包、商品卡、地图、论坛模块——自然结果被挤到哪里 |
| **有没有 AI 答案，引用了谁** | 引用名单就是这个主题的实际权威清单 |
| **广告几条、谁在投** | 有人持续买这个词 = 这个需求能变现（但不证明他在盈利） |
| **有没有独立站的空位** | 最终裁决：这盘面是「有空位没人争」，还是「没人打算把它交给独立站」 |

### SERP 盘面怎么读（`serp-query.mjs` 的派生计数）

`scripts/demand/serp-query.mjs` 输出的是**计数不是结论**（原始 serper 响应每次
都会落进证据目录，字段哪天解析错了拿 raw 对质）。判读归这里：

- **domainMatch 是启发式，不是事实。** 它只看域名主标签里有没有关键词的实义词素：
  命中不等于对方真的专营这个词，品牌名站漏判也常见。当信号看，别当判据。
- **精确域名命中多**（前十里好几个站把词做进主域名）→ 成熟小生态，垂直老站扎堆，
  难度分往往低估；**一个都没有** → 要么没人专门做，要么这个词根本不构成一个站的定位。
- **首页多** → 大站拿主页硬顶，新站单页难以插入；**内页多** → 有靠单页切进去的缝。
- **有答案框/知识图谱** → 零点击比例高，先估一眼自然结果还剩多少屏。
- 这些计数只看前十；第二页之后的盘面对「这个词好不好切」没有解释力。

### 引擎之间不一致，本身就是结论

不要急着把差异当噪声抹平：

- **Google 全是平台占位、Bing 首页有独立站** → Bing 那侧有空位，
  同时说明 Google 已经把这类意图判给了平台，Google 侧的天花板很低。
- **英语盘面被占满、目标语种的本地引擎首页还很空** → 机会在语言差里，
  不在词本身（验证方法见 [`seo-experiences.md`](seo-experiences.md) 的「多语言站架构参考（Apple 模型）」条目）。
- **所有引擎首页都是新闻、影视、赛事或成人内容** → 需求真实但不是工具需求，
  这个种子直接否掉，不用再进横向比较。

**记录差异，不要只记一个「综合印象」。** 一句「竞争激烈」在下一轮复盘时什么都不是；
「2026-08-28 Google US 前十 8 个专门页 / Bing US 前十 3 个专门页，Bing 侧最弱位是一个免费托管页」
才能在两个月后拿来对比。

## 分册索引（2026-09-30 拆分）

文字里写「`demand-sources.md` 第 N 节」的指针按下表找文件；一次任务只读需要的分册。

| 原节号 | 文件 |
|---|---|
| 二、二·五、三（谁收到钱 / 支付网关反查 / 谁买流量） | [`demand-sources/revenue-and-ads.md`](demand-sources/revenue-and-ads.md) |
| 四～八（差评 / 外包 / 新产品 / 新词平台 / 用户原话） | [`demand-sources/users-and-launches.md`](demand-sources/users-and-launches.md) |
| 九、九·二、九·三、九·五～九·八（竞品下注 / 站群 / 子域名 / 词根 / 反查 / 自动补全 / 哥飞社区） | [`demand-sources/competitors-and-roots.md`](demand-sources/competitors-and-roots.md) |
| 十、十·五（候选验证链路 / 能排上去 ≠ 能赚钱） | [`demand-sources/validation-chain.md`](demand-sources/validation-chain.md) |
| App 市场证据、十一令牌、十二维护契约 | 本文件 |

## App 市场证据与原生分发

用于 `research.md` App 分支；产品形态不限，包括macOS、iOS、iPad App 与 Web/SaaS 按任务选择，不交付 Android App，Android 只作参考。**每条指标带 store/platform/country/window/source/is_estimate/gross_or_net/access_status**，不适用字段写 N/A，未取到写 unknown/null，不把缺数据补成零。

| 要验证什么 | 公开竞品事实/估计 | 自有或获授权后台 | 不能推导什么 |
|---|---|---|---|
| 商店搜索需求 | 目标国家/设备实际搜索结果、关键词相关性、ASO相对热度 | 商店搜索来源的展示、下载、转化 | 相对热度不是月搜索次数，不能用Google Trends锚点换算 |
| 榜单与历史 | 同国家/设备/类别/免费或付费榜的日期快照、持续位置；历史取决于权限 | 与活动/版本/获取数据对照 | 单日冲榜不证明长期需求；排名不能乘固定系数变安装或收入 |
| 下载/安装量级 | Appfigures/AppTweak等明确标注的模型估计，核查平台覆盖 | 首次下载、重新下载、安装分别记录，按原报告定义 | 评分数不是安装数；同账号多设备、更新与重装不等新用户；iOS估计不能借给Mac |
| 价格、IAP与订阅 | 地区价格、周期、试用、解锁点、是否存在付费产品 | 试用转付费、付款人数、续订/退款与交易明细 | 开价/有IAP不是成交；试用、活跃订阅不等付费人数 |
| 收入 | 平台核验的经营数据或有出处的估计；开发者自述单列 | Sales、Proceeds、结算/到账各按原定义对账 | 榜单/价格/下载不等收入，收银台引荐不等成交；毛收入与净所得不能混比 |
| 评分/评论增量 | 同地区、版本、日期快照与新增书面评论；找任务、失败、替代、付费原话 | 反馈与版本/客服记录 | 评分可能重置；均分/评论好评率不是留存，评论数不能按固定比例推安装 |
| 使用与留存 | 有出处的公开披露/研究仅作有限证据，缺项未知 | 固定cohort、D1/D7/D30、分母、窗口、平台与来源；注明分析同意覆盖 | 下载不等活跃，订阅续订留存与App使用留存不同；未开发候选不要求先有自家留存 |

**取数入口**：现成 `appstore-charts.mjs --lookup` 取榜单及价格/评分，`reviews-mine.mjs --source appstore` 取评论；二者不提供竞品真实下载或留存。公开竞品先读商店页与现成榜单，再查第三方估计。Appfigures、AppTweak有公开/免费与付费深度差异，先查当前账号权限、平台和时间窗；不能因可免费注册就声称历史全可用，也不要未查就说全部付费。Sensor Tower、七麦、点点等按官方当前覆盖与权限核验，未实跑不记已配置。不新增或杜撰私有API。方法定义与权限复查入口：

- [Apple商店评分与评论](https://developer.apple.com/app-store/ratings-and-reviews/)；[Apple Analytics指标](https://developer.apple.com/help/app-store-connect-analytics/reference/metrics-definitions)：下载/安装与分析同意覆盖、Sales/Proceeds按各指标定义分列。
- [Apple Sales and Trends](https://developer.apple.com/help/app-store-connect/reference/reporting/sales-and-trends-metrics-and-dimensions)：Units、付款/续订事件与付费人数口径不同，不机械合并报表。
- [Apple Ads指标](https://ads.apple.com/app-store/help/reporting/0023-reporting-options-and-definitions)：Search Popularity是相对热度，按当前量表记录，非搜索次数；查看现有数据不授权投放。
- [Appfigures权限](https://appfigures.com/platform/pricing)、[AppTweak估计方法](https://www.apptweak.com/en/aso-blog/app-download-revenue-estimates)、[历史图权限](https://help.apptweak.com/en/articles/4785076-compare-downloads-estimates-with-competitors)：估计不是账本，先核国家、设备、月份及收入是否含广告/站外支付。Mac榜单支持不自动意味着Mac竞品下载估计可用。

**macOS 直销另开一行**：Mac App Store不能代表全部Mac市场，见[Apple macOS分发](https://developer.apple.com/macos/distribution/)。自有产品串联下载→首次启动/激活→完成任务→付费→留存/退款的原始事件和支付记录；DMG请求、重复下载、Sparkle更新流量不能计为独立用户。竞品无授权后台时，用公开价格/用户原话/可信经营披露分级，真实安装、激活、收入、留存留未知，不能从网站访问估成事实。

**Appfigures 公开快照**：从站内搜索结果或公开应用页确认 **Appfigures product ID**（不是 Apple App ID），再用 `https://app.appfigures.com/reports/app-profile/<product-id>?dates=last-month`。复用兄弟 `opencli/scripts/appfigures.mjs --product-id <id> --out-dir <目录>`，读取实际页面的 Est. Downloads、Est. Revenue (After Fees)、地区/月份与新评分卡片；`Not Available` 留空，`<$5K` 保留为严格上限区间，不能输出为收入 5000。每次核对显示的是 iOS 还是包含 Google Play 的统一应用。历史/关键词页若出现登录墙或 Loading 占位，不采占位排名；公开概览可读不代表深度报表已获授权，控制应用有数也不保证每个长尾应用有估计。 下载页若说明多数买断付费应用不提供下载估计，记录为该提供方的覆盖缺口，不能归因于未登录、无需求，也不能靠升级承诺解决；收入有数仍需核查国家覆盖和估计口径。 登录后另查关键词表；Popularity、Competitiveness、# Apps 与应用排名分别记录，不能当月搜索次数或 SEO KD。遇到结果截断保留条数/限制；竞品跟踪可用额度与套餐升级分开核验。

**Mac 安装代理渠道**：先在 [Homebrew Cask](https://formulae.brew.sh/cask/) 找产品的实际 token，再读 `https://formulae.brew.sh/api/cask/<token>.json` 的 `analytics.install`（30/90/365 天）与 `generated_date`。这些是启用 analytics 的 Homebrew 安装事件样本（用户可退出统计），不是全渠道下载、独立用户或付款人数；窗口相互重叠，不能相加，未收录或缺失不记零。结合开发者官网价格、Mac App Store 评论和有出处的经营披露判断，仍沿用上面的实际值/估计/代理指标分列。

新候选至少两类独立证据，尚无自家后台时记录竞品证据缺口和后续小样本验证计划，不因缺自家留存直接否决；已上线产品则回读自己真实漏斗。**网页月量低只能说明该网页获客路径弱，不能单独否决有商店或直销证据的App市场。**

---

## 十一、令牌与登录态

需要凭据的源，键名统一放 `<rankup-skill-dir>/.env`（`KEY=value` 每行一个，已被 gitignore
排除并由 `scripts/validate-rankup.mjs` 断言不被 git 追踪）。读取顺序一律**环境变量优先，
再退到 `.env`**。

| 键名 | 谁用 | 没有会怎样 |
|---|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | `github-trending`（search/issues）、`github-skill-search` | trending 照跑；search 降到 10 次/分；**code search 直接不可用**，脚本提示改 `--mode repo` |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | `reddit-wishes` | 自动降级 RSS，能跑但慢且没有 score |
| `SERPER_API_KEY` | `serp-query` | 报错并指路；改用官方 `gefei-keywords` Skill 的 SERP 工具 |
| `PRODUCTHUNT_TOKEN` | `boards.mjs producthunt` | 自动降级到浏览器路径（浏览器路径本来就更全） |
| `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` | `game-newtitles --source igdb` | 清晰报错；其余 game 源不受影响 |
| `TABAPI_KEY` | `domain-profile.mjs --provider tabapi` | 默认 webcafe 经官方 gefei CLI，需其已有授权，按积分余额计费；不需要 TABAPI_KEY |

**需要登录态**（不是需要令牌）的只有两处：闲鱼、以及 `payment-referrers.mjs similarweb`
所依赖的数据面板。其余「必须真实浏览器」的源
（Trustpilot / G2 / Capterra / Fiverr / Upwork / PH / Toolify / SteamDB / chrome-stats）
都**不需要登录**，只是要绕过反爬质询。

### 浏览器纪律

凡是走 OpenCLI 的脚本，都必须遵守 `opencli` Skill 的会话法律：
一个会话一个标签页、**会话名描述性但必须带并发后缀**、
默认 `--window background`、用完 `close`、**sub agent 绝不跑 `cleanup`**。
本目录的脚本已在 `finally` 里自动 close。

**会话名不许是字面常量**（2026-08-24 修）：`boards.mjs` 曾把三个会话名写死成
`demand-b-taaft` 这样的常量，两个 agent 同跑就共用同一个标签页，各自读回对方的页面——
**导航报成功、数据是别人的、全程不报错**。现在统一走 `sessionName(base)`，
后缀取 `OPENCLI_SESSION_SUFFIX` → `CLAUDE_CODE_SESSION_ID` → `CLAUDE_CODE_HOST_SESSION_ID`
→ `ppid`。注意 `HOST_SESSION_ID` 是整个桌面端共用的，只能垫底；
**Bash tool 里绝不用 `$$`**（每次调用都是新进程，PID 都不同）。

**不要用 `opencli doctor` 的文案判断桥能不能用**（2026-08-24 实测坑）：
`reddit-wishes.mjs` 原来匹配 `"Everything looks good"` 来决定走不走 OpenCLI，
而 doctor 只要有任何 Issue 就不再打印那句话——哪怕三行全 `[OK]`、桥完全可用。
结果是**静默降级回 RSS**：输出少了「赞 / 评论数」两列，不报任何错。
判据应当用 `[OK] Connectivity` 这类结构化行，不是吉祥话。

**`opencli doctor` 的退出码同样不能当判据**：它汇报的是「诊断本身跑完了」，
不是「被诊断的东西是健康的」——扩展断连时退出码依然是 0，状态只写在 stdout 里。
两个脚本曾把连通性检查写成「`doctor` 抛异常或退出非 0 才算坏」，这个条件因此**永远不成立**，
后面那个没设超时的调用就在扩展断连的情况下挂到天荒地老，零输出、零报错。
判据必须是探这行具体的 stdout（`[OK] Connectivity`），不是退出码，也不是任何一句汇总文案——
**一个永远不触发的检查和一个永远通过的检查，行为上没有区别，而且要等到卡死才会被发现。**

---

## 十二、维护契约

- **每个源的取数路径都会坏。** 站点改版、反爬升级、API 下线都是正常损耗。
  坏了**修脚本**，不要绕过去手工点一遍——手工的结果不可比，且下次还得再摸一遍。
- 修完更新脚本头部注释的**已验证日期**，并把失败原因写进去，下次少走一遍。
- **「空」不等于「坏」**：平台会在反爬启发式下主动降级结果，也会用 200 + 空 body 代替 404。
  换个查询词、在普通标签页里肉眼看一下，能复现再进修复流程。
- 新增源时，先按第一节判断它属于哪一类信号，再决定放进哪一节——
  **按「回答什么问题」分类，不按站点类型分类**。
