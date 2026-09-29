# SEO：每轮工作流与经验沉淀协议

> 渐进式加载：本篇只讲每轮优化的工作流和经验回流规则。

## 四、工作流(每轮优化按此走)

0. **读项目 `.rankup/`**：按 [`project-memory.md`](project-memory.md) 恢复并对账上下文；没有就初始化项目记忆。新项目、新产品线或新词族先填【机会池卡】并通过 `D+C+W+M` 门禁;已运行站点的存量优化直接从 GSC 真实数据开始。
1. **先拉真实数据再动手**:GSC 查询词(点击+曝光+CTR)→ 按语义聚类 → 国家分布交叉(哪个市场曝光大 CTR 低 = 收割空间)。没有 GSC 就用 Suggest 摸需求形态。
2. **意图核验后再选词**:对候选主词查 KD 的 `details[]`(前十是谁、dedicated?、DR、体验分)。**SERP 被电商/实体货占据的词 = 意图不匹配,放 H1 蹭不进 title**。
3. **落地映射**:title ≤60 字符、主词只出现一次 + Suggest 验证过的修饰词;description 110–160 字符、动词开头、写差异化(free/秒出/免注册);H1 承接第二词组;FAQ 逐条承接长尾(一条 FAQ = 一个查询意图);多语言不是翻译而是本地化(音译、方言词、当地搜索习惯)。
4. **验证闭环**:构建后脚本核对全语言 title/desc 长度与关键词落位 → commit → push → 轮询线上生效 → IndexNow ping(key 文件在站根)→ 记录 GSC 基线,1–2 周后回看 CTR/排名变化。
5. **AI 引用与合规检查**（见 [seo-ai-search.md](seo-ai-search.md)「落地清单」）：AI 引用检查（Google 侧）→ 非大众化内容审计 → Back Button 审计 → Discover 适配（内容站）→ Preferred Sources 引导。ChatGPT 侧的采样与推荐位见 [seo-geo.md](seo-geo.md)（付费工具 / 游戏站 / 平台类研究阶段已做 4b，上线后按其步骤 6 复测）。
6. **收尾必做**：按 [`maintenance.md`](maintenance.md)「二、收尾维护」走完五步（经验回流见其「五」第 2 条）。

## 六、经验沉淀协议

已并入 [`maintenance.md`](maintenance.md)（2026-09-30）：何时写项目日志、什么不写、双层分流（通用规则进 Skill，项目专属进 `.rankup/`）与「不用请示」都以那里为准。本篇只保留 SEO 经验库自己的格式约定：

- [`seo-experiences.md`](seo-experiences.md) 一条一行，`[日期] 结论:证据`；同一结论已有就更新旧条目的日期与内容，不另起一条；条目超过约 25 条时合并同类、删除过时。
- 数据通道变化直接改 [`seo-data-channels.md`](seo-data-channels.md) 对应行。
