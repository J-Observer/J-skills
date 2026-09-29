# SEO：2026 AI 搜索范式（引用 > 排名）

> 渐进式加载：本篇只讲 AI 搜索范式、官方指南与算法更新。GEO 反推测试见 [seo-geo.md](seo-geo.md)。

## 三-B、2026 AI 搜索范式：引用 > 排名（Google 官方指南 + @googlesearchc 实测）

> **定位**：本节整合 Google Search Central 2026 年全年官方博客、@googlesearchc 推文、
> Google I/O 2026 公告、以及 Google 首份 AI 优化指南（2026-05-15）。
> 只收录 Google 官方发布或其官方账号确认的信息，第三方解读仅作佐证。
> 2026-08 更新。

### 核心判断：被 AI 引用比排第一更值钱

网站上线时先按 [`checklists.md`](checklists.md) 段 4、段 5 的 AI 爬虫可访问性判据逐 UA 实测；robots.txt 放行不能排除 Cloudflare 边缘 403。

Google I/O 2026（5 月 19 日）宣布搜索 25 年来最大改版：AI Mode 月活突破 10 亿、
查询量每季度翻倍。**AI Mode 是全页替换，不显示传统结果；AI Overviews 叠在有机结果上方。**
被 AI 引用的品牌获得的有机点击比未被引用的竞品高 35%（Digital Applied，2026-03）；
而 Position 1 的 CTR 从 27% 跌到 11%（SISTRIX，2026-03，限有 AI 功能的查询）。
零点击搜索已达 58.5%（SparkToro/Datos）。

**对我们的影响**：传统排名仍有价值但不再是唯一目标。每轮 SEO 规划必须同时回答两个问题：
1. 这个词我能排进前十吗？（传统 KD/SERP 分析，已有流程不变）
2. 这个词的 AI 回答会引用我吗？（下面的新流程）

### Google 官方 AI 优化指南要点（2026-05-15 发布）

Google 明确说 **AEO/GEO 不是独立学科，就是 SEO**。以下是官方指南的完整可执行清单：

**该做的：**
1. **写非大众化（non-commodity）内容**——AI 自己能生成的摘要毫无引用价值；
   只有一手评测、原创数据、亲历经验才会被引用。
2. **保持可抓取**——AI 模型用的是公开可抓取的内容。技术 SEO 基础不变。
3. **页面结构清晰**——段落、小节、描述性标题，为人类写而不是为 AI 写。
4. **加多媒体**——高质量相关图片和视频，遵循既有图片/视频 SEO。
5. **负责任地用 AI 辅助写作**——内容必须达到 Search Essentials 标准。
6. **Merchant Center + Google Business Profile**——本地和电商内容的 AI 可见性靠这两个。
7. **关注 agent-readiness**——交易型站点为 AI agent 做好准备（Universal Commerce Protocol）。

**不该做的（Google 明确否定）：**
1. ❌ **不需要 `llms.txt` 或任何特殊 AI 文件**——Google Search 不使用它们。
2. ❌ **不需要把内容切成小块（chunking）**——Google 系统理解多主题页面。
3. ❌ **不需要为 AI 改写内容**——AI 理解同义词和通用含义。
4. ❌ **不需要在全网刷品牌提及**——虚假提及无效且有反噬风险。
5. ❌ **结构化数据不是 AI 引用的前提**——继续用它拿 rich results，但别指望它是 AI 通行证。

### Preferred Sources：品牌忠诚度成为 SEO 因子

2026-01-30 上线，04-30 全球全语言推出，05-27 扩展到 AI Overviews 和 AI Mode。
用户可以标记信任的出版商，标记后的来源在搜索结果中获得视觉标记且排名提升。
截至 05-27 已有 34.5 万个被标记的来源。**用户标记为 Preferred 的站点点击率翻倍。**

**对我们的影响**：经营自有受众（邮件订阅、注册用户、回头客）不再只是产品运营，
它直接影响 AI 搜索可见性。08-20 更新的文档还增加了自定义按钮引导用户设为 Preferred Source。

### Search Console 新工具：Generative AI 效果报告（2026-06）

2026-06-03 上线，目前按子集推出。报告包含：AI 功能中的曝光次数、页面、国家、设备、日期。
**暂无点击/CTR/查询词数据**（Google 称后续会加）。
另有 opt-out 开关：可以阻止内容出现在 AI 功能中，且不影响传统有机排名。

**对我们的影响**：段 7（7.2 与 7.3）的监控清单必须加入 AI 曝光指标。
在 `.rankup/baseline.md` 里新增 AI 曝光基线（可用时）。

### February 2026 Discover Core Update：Discover 独立算法

Google 首次为 Discover 发布独立核心更新（02-05 至 02-27）。
**Discover 现在使用独立于搜索的排名算法**，不再是搜索算法的副产品。
三个新信号：

1. **Topic Authority**——在特定主题上持续发布建立 Discover 可见性；追热点不再管用。
2. **反 Clickbait**——标题必须兑现内容承诺；依赖煽情标题的站流量跌 30-60%。
3. **本地相关性**——针对特定地区的内容优先推送给该地区用户。

**对我们的影响**：工具站受影响较小（Discover 偏内容消费），
但内容站必须把 Discover 当独立渠道规划，不能假设「搜索排好了 Discover 自然有」。
图片要求：1200px+ 宽度 + `max-image-preview:large` meta 标签，实测 CTR 高 45%。

### 2026 算法更新时间线（用于排障定位）

| 日期 | 更新 | 完成 | 要点 |
|---|---|---|---|
| 02-05 | February Discover Core Update | 02-27 | Discover 独立算法、Topic Authority |
| 03-24 | March Spam Update | 一天内 | 反垃圾 |
| 03-27 | March Core Update | 04-08 | E-E-A-T 仍核心、Information Gain 信号 |
| 04-13 | Back Button Hijacking 政策 | 06-15 执行 | 新 spam 类型，劫持浏览器后退按钮 |
| 05-07 | FAQ Rich Results 下架 | 06 月移除工具 | FAQPage schema 仍有效但不再产生富结果 |
| 05-15 | AI 优化指南发布 | — | AEO/GEO = SEO 的官方定论 |
| 05-21 | May Core Update | 06-02 | 常规核心更新 |
| 06-03 | GSC Gen AI 效果报告 | 按子集推出 | AI 功能曝光数据 |
| 06-15 | FAQ Rich Results 从 GSC 移除 | 08 月移除 API | — |
| 06-24 | June Spam Update | 06-26 | 年度第二次反垃圾 |
| 08-01~03 | 未确认排名波动 | — | 多工具检测到大幅波动，Google 未确认 |
| 08-18 | August Spam Update | 08-22 | 年度第三次反垃圾 |

**排障用法**：站点流量异常时，先对照此表看是否落在更新窗口内。
Core Update 完成后 2-4 周才能看到稳定影响。

### Information Gain：内容独特性成为排名信号

March 2026 Core Update 重新加权了 Information Gain——衡量一篇内容相对于
已排名内容增加了多少**真正新知识**。这不是新概念（Google 2020 年专利），
但 2026 是它被明确观察到影响排名的一年。

**对我们的影响**：
- 工具站的内容页不能只是同类工具页的改写，必须有独特切角。
- 「原创数据」「一手测评」「独特方法论」是 Information Gain 的三大来源。
- 与 experiences/webcafe-experiences.md 第九条（「已抓取但未编入索引」是内容问题）互证：
  Google 不只是不收低质量内容，它现在主动降权「没有新信息增量」的内容。

### 2026 年 Google 十大排名因素（哥飞解读版）

来源：@gefei55 2026-09-10 [X](https://x.com/gefei55/status/2098068562237890880)｜证据等级：【经验】（哥飞基于 Google 官方信息的个人解读，非原始实测数据）

哥飞对 Google 排名因素的十条个人排序，供交叉验证用，不当作独立判据：

1. **内容相关性**——网页内容与用户搜索词之间的相关性，最基础的一条。
2. **反向链接**——反链没死，依然有用；有真实流量页面给的外链效果更好。
   → 见 `experiences/webcafe-topics.md` 五「外链」章节。
3. **内容质量**——原创性、准确性、时效性。→ 与上方「Information Gain」小节同一判断的另一种表述。
4. **权威性和信任度**——谷歌对网站所属公司、品牌、创建者等多维度评估。
   → 对应算法更新时间线里「E-E-A-T 仍核心」（March Core Update）。
5. **行为数据**——可以提升权重，能以小博大、以弱胜强。
6. **品牌信号**——有唯一品牌名称，真的有人搜索，散布在互联网各角落，被谷歌识别为实体。
   → 与上方「Preferred Sources」小节互证：经营自有受众和品牌搜索量直接影响 AI 搜索可见性。
7. **用户满意度**——与行为数据相关但不同，好的行为数据不一定是最佳体验；别乱搞假排队。
8. **技术 SEO 健康度**——页面是否后端渲染、On Page SEO 细节是否到位。
   → 对应段 4 闸门 1（技术 SEO），见 [`checklists.md`](checklists.md)。
9. **主题权威性/聚焦度**——全站聚焦一个大主题，比什么关键词都做的站更容易拿排名；
   对应三大原则「一个关键词组一个页面」「举全站之力打一个词」。
   → 与[seo-opportunity.md](seo-opportunity.md)「机会池选型」和 `experiences/webcafe-topics.md` 一·三（词龄比 KD 更能决定难度）呼应。
10. **内部链接**——合理分配权重，让爬虫更容易理解网站结构。
    → 对应段 4 闸门 1 的「内链零 404、零 `href="#"`」，见 [`checklists.md`](checklists.md)。

**用法**：这十条是解读而非实测，不新增独立检查项；已有对应判据/闸门的条目按交叉引用核对，
没有对应判据的（#1、#5、#7）先记录为观察方向，等实测积累后再考虑收编。

### Back Button Hijacking：新增 Spam 政策（2026-04 发布，06-15 执行）

劫持浏览器后退按钮现在是明确的 spam 违规，可触发人工处罚或算法降权。
**站主对第三方广告网络或互动脚本注入的劫持代码同样负责。**

**必检项**（加入技术审计清单）：
- 审计所有第三方脚本，确认无 `history.pushState` 滥用或后退拦截。
- 测试方法：从搜索结果进入页面 → 点后退 → 必须回到搜索结果页。

### FAQ Rich Results 下架（2026-05-07 生效）

FAQ 富结果不再出现在 Google Search 中。FAQPage schema 仍是有效的 Schema.org 类型，
但不再产生任何搜索可见性收益。**已实测：结构良好的 FAQ schema（80-150 词答案）
仍被 ChatGPT/Perplexity 等 LLM 优先引用**——从 Google 富结果资产变成了 LLM 引用资产。

**对我们的影响**：
- 现有 FAQ schema 不删，但不再为获取 Google 富结果而新增。
- FAQ 内容本身仍有价值（长尾查询承接、AI 引用），只是展现形式变了。

### Information Agents：Google 的后台持续搜索

Google I/O 2026 推出的 Information Agents 是 24/7 后台运行的 AI 程序，
可同时发出 16 个子查询，扫描博客、新闻、社交帖、实时数据，
在匹配条件时向用户推送综合更新。

**对我们的影响**：你的内容可能被 AI agent 阅读而非人类阅读，
因此**机器可读的准确性**在任何时候都至关重要——不只是发布时。
这强化了已有的「结构化数据 + 语义 HTML + 事实准确」要求，不需要新流程。

### 落地清单：每轮 SEO 工作流新增检查项

在现有工作流（section 四）基础上，每轮额外检查：

1. **AI 引用检查**：目标页面是否出现在 AI Overviews / AI Mode 的引用中？
   （用 Search Console Gen AI 报告，或手动搜索目标词观察）
2. **非大众化内容审计**：页面有没有 AI 自己就能生成的泛泛之谈？
   有就加独特切角或一手数据。
3. **Back Button 审计**：第三方脚本有无后退劫持？
4. **Discover 适配**（内容站）：OG image ≥ 1200px？`max-image-preview:large`？
   主题是否持续发布而非追热点？
5. **Preferred Sources 引导**：有无引导忠实用户设为 Preferred Source？

### AI Agent 就绪度：让 AI 代理能发现和使用你的站点

> **与 AEO/GEO 的区别**：AEO/GEO 关心「被 AI 搜索引用」（Google 说等于 SEO）；
> Agent Readiness 关心「AI 代理（编码助手、购物机器人、自动化助手等）能不能
> 发现、访问、理解、使用你的站点」。两者互补，不互相替代。
> Google 说不需要 llms.txt，但 AI 代理生态（ChatGPT Plugins、MCP、Cursor 等）需要。
> 2026 年 Vercel 推出 is-agentic.com 和开源 CLI，这是第一个系统化的评分工具。

**工具**：`scripts/is-agentic.mjs`（包装 is-agentic.com 公开 API，零配置可跑）。

```bash
