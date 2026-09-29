# SEO：无关区块 SSR（价格表、推荐位）

> 渐进式加载：本篇讲"SSR 只输出目标文案"的两种做法（三-C），以及 AI 爬虫读到的 raw HTML 与 UA 一致性检查（三-E）。

## 三-C、无关区块（价格表、推荐位）：SSR 只输出本页目标文案

### 目的

密度、TDK、首屏文案这些检查都是对**一页一个目标词**做的。页面里与目标词无关的区块
——价格表、其它产品的推荐位、全站通用的 UI 控件文案（position / px / size / shadow 这类标签）、
每个卡片都重复一遍的免责声明——会把主题词从 top 榜里挤出去。段 4 的硬规则是：
**SSR 输出里只有本页目标文案**，无关区块不进首屏 HTML。

判据先于手法：先用 `scripts/seo-audit.mjs` 看 raw HTML 的 1/2/3-gram top15，
主题词不在前列、榜上全是控件词或价格表词，才动手；主题词已经在前列就不要为了「更干净」去改结构。

### 做法一：无关区块改客户端加载（最简单）

价格表、推荐位改成 mount 后再渲染（或 `hidden` + 客户端展开）。SSR 产物里没有它们，
密度工具立刻通过，实现只是把一个组件挪到客户端。

**边界**：它只对「密度工具读 raw HTML」这一件事成立。Googlebot 的 WRS 会渲染 JS，
DOMContentLoaded 或 mount 时注入的内容**照样进渲染后 DOM**——所以密度工具通过，不代表 Google
看到的一样。用这个做法要接受一个前提：那块内容 Google 看见也无妨（价格表通常如此，它本来就该被索引），
你只是不想让它压主题词的**工具读数**。反过来，如果目的是让 Google 的渲染层也不看见，这个做法不够。

**想被 AI 引用的区块（价格表、推荐位、FAQ）不能用做法一**：Google 的 WRS 能渲染，不等于 ChatGPT 直接抓取能看到。OpenAI 的三个爬虫唯一的独立实测（2024-12）显示它们不执行 JS，mount 后才渲染的价格表对它们是空的，而价格表正是 AI 推荐常用的依据【实测，单一来源，见 [seo-ai-search.md](seo-ai-search.md)「三-D」】。这类区块保持 SSR，密度靠别的手段控（缩短、合并、把重复样板提到容器层只写一次）。

### 做法二：首次真实交互后再注入（更稳）

Googlebot 渲染 JS 但**从不交互**。所以唯一可靠的逐出是：等到第一次真实交互
（pointerdown / pointermove / keydown / touchstart / wheel 五事件，`once` + `passive`）才注入。
已实证的形态：

- 文案来源是 SSR 内嵌的 JSON blob，与 SSR 同一个 `t()` 调用生成——**单真源**，blob 属 script 内容不计入可见文本；
- 注入目标是空 span（`data-i18n-lazy`，并摘掉 `data-i18n` 防运行时包提前水合）；
- `:empty::before` 占位防 CLS，px / ° / % 后缀走 `data-unit`。

实证数字：64 个 label + 16 个单位转换后，raw top15 的 position（1.88%）/ px（1.78%）/ size / shadow
全部出榜、主题词回正；无头零输入 3s 后全空、单击后双语全对、面板高度 Δ0。

**边界**：它只适用于**不该被索引的装饰性文案**——控件标签、单位、工具面板。
把正文、FAQ、价格这类**你希望被索引**的内容放到交互后注入，等于亲手把它们从 Google 面前藏起来；
「把结果预加载进 DOM 但首页不展示」已经吃过整域 shadow ban
（[`experiences/webcafe-experiences-2.md`](experiences/webcafe-experiences-2.md) 十七·一），方向相反但同一条红线。

### 两种做法怎么选

| 区块 | Google 看见有没有问题 | 做法 |
|---|---|---|
| 价格表、其它产品推荐位、相关页卡片 | 无妨，甚至该被索引 | 做法一：客户端加载，只压工具读数；**想被 AI 引用的价格表与推荐位除外，保持 SSR** |
| 控件标签、单位、面板文案、每卡重复的免责声明 | 稀释主题、无索引价值 | 做法二：首次交互后注入；重复样板提到容器层只写一次 |
| 分月 / 分类面板的长尾正文 | **必须**被看见 | 都不用：全量 SSR + `hidden` 切换（五 2026-07-26 那条） |

改完必须两处都验：raw HTML 的密度（工具视角）和无头加载 + settle 后的 DOM（Google 视角），
只测一处会漏掉另一侧（[seo-experiences.md](seo-experiences.md) 2026-07-18「双真源站的运行时包」那条讲的是同一件事）。

## 三-E、AI 爬虫读到什么：UA 与桌面/移动一致性检查

### 目的

判 raw HTML 里有没有想让 AI 引用的正文、价格、表格与 FAQ，以及不同爬虫 UA 拿到的是不是同一份内容。[`ai-crawler-access.mjs`](../scripts/ai-crawler-access.mjs) 只验证各 UA 返回 200 与 robots，**不比较返回的正文**，UA 差异与 JS 空壳是它的盲区，本节补这一块。三个 OpenAI 爬虫的 UA 原文、用途与 JS 渲染证据见 [seo-ai-search.md](seo-ai-search.md)「三-D」，本节不重复。

### 做法

1. `node scripts/ua-parity.mjs <url>`：用四个 UA（OAI-SearchBot、ChatGPT-User、Googlebot Smartphone、桌面 Chrome）各抓一次，去掉 script 与 style 后比较可见文本的词集，同时比状态码、`Vary`、`<title>`、是否有 `<h1>`、JSON-LD 块数、canonical、meta robots（这些任一不同就判 `differs`）。字节数与 script 数只显示、不参与判定。以 Googlebot Smartphone 为基线，输出每个 UA 相对基线缺失与多出的词数。参数与已知坑见脚本头部注释。
2. 禁用 JS 再看一遍：Chrome 开发者工具「Disable JavaScript」后刷新，主体内容、价格表、FAQ 必须还在。这等价于 OAI-SearchBot 的视角。
3. 每类模板页至少测一个，正式域名上重验；预览域的封锁记设计，不算红灯。判据在 [`checklists.md`](checklists.md) 段 4「AI 爬虫读到的 raw HTML 与桌面/移动一致」。

### 怎么读结果

| 现象 | 含义 | 动作 |
|---|---|---|
| 四个 UA 词集、title、canonical、robots meta 一致，正文词数正常 | raw HTML 对各爬虫一致 | 通过 |
| 结论行提示「疑似客户端渲染空壳」：框架挂载点（`id=root`、`app`、`__next`、`__nuxt`）在 raw HTML 里是空的；或可见词极少且有可执行脚本；或可见词偏少且可执行脚本 ≥3 个。四个 UA 通常一样 | 客户端渲染空壳，AI 爬虫读不到正文（Googlebot 靠 WRS 渲染或许能读到）。这是启发式提示：只带一两个统计脚本的极简静态页不会触发；反过来，挂载点不是上述几种、脚本又少的客户端渲染页会漏报，要同时读表里的「词=」 | 关键区块改 SSR，再复测；提示成立与否先读 title 与词集，核实是误报的逐条记驳回理由 |
| 某个 UA 拿到 403、验证页或不同的 title | 边缘规则或 WAF 按 UA 拦截 | 按 [`cloudflare-stack.md`](cloudflare-stack.md) §8.5、§8.8 排查，复测 |
| 某个 UA 的词数明显少于基线、JSON-LD 块数比基线少，或 `Vary: User-Agent` 出现 | 服务端按 UA 或视口返回不同 HTML（动态服务、m. 子域、响应式里用 JS 按视口删内容） | 逐个 UA 读内容，把 AI 要看的区块补进所有版本 |
| 词数差异很小但不为零 | 多为时间戳、随机推荐、广告位 | 记录即可，不当问题 |

**边界**：脚本只比 raw HTML，不渲染 JS；能证明「有没有」，证明不了「ChatGPT 是否引用」。「桌面 UA 或陌生 UA 拿到简版」是从 UA 字符串推理出来的【猜测】，没有找到公开的对照实验；纯响应式、同一份 HTML 的站没有这个问题。
