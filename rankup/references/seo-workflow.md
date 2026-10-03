# SEO：每轮工作流与经验沉淀协议

> 渐进式加载：本篇只讲每轮优化的工作流和经验回流规则。

## 四、工作流(每轮优化按此走)

0. **读项目 `.rankup/`**：按 [`project-memory.md`](project-memory.md) 恢复并对账上下文；没有就初始化项目记忆。新项目、新产品线或新词族的验证顺序与裁决只见 [entry.md](playbooks/entry.md)；[机会池卡](seo-opportunity.md#6机会池卡模板)只整理背景。
1. **先拉真实数据再动手**:已运行站点读 GSC 查询词(点击+曝光+CTR)与国家分布，定位本轮问题；没有 GSC 时按 [数据通道地图](seo-data-channels.md)收集候选与缺项。
2. **意图核验后再选词**:新增词族或问法回 [entry.md 流水线](playbooks/entry.md#3--流水线)，复用有效证据、补缺项；问法链方法见 [seo-geo.md](seo-geo.md)，逐问法 Google 读法见 [seo-serp.md](seo-serp.md)。
3. **落地映射**:问法簇、页面、FAQ、description与本地化统一按 [stage-2-positioning.md 2.3](lifecycle/stage-2-positioning.md#23-问法簇--页面--faqdescription与站点结构)回填 `keywords.md` 与页面 Brief；页面实现检查见 [stage-4-prelaunch.md](lifecycle/stage-4-prelaunch.md)。
4. **验证闭环**:构建后脚本核对全语言 title/desc 长度与关键词落位 → commit → push → 轮询线上生效 → IndexNow ping(key 文件在站根)→ 记录 GSC 基线,1–2 周后回看 CTR/排名变化。
5. **AI 引用与合规检查**（见 [seo-ai-search.md](seo-ai-search.md)「落地清单」）：AI 引用检查（Google 侧）→ 非大众化内容审计 → Back Button 审计 → Discover 适配（内容站）→ Preferred Sources 引导。ChatGPT 侧上线后整改与复审只见 [seo-geo-recommendation-loop.md](seo-geo-recommendation-loop.md)。
6. **收尾必做**：按 [`maintenance.md`](maintenance.md)「二、收尾维护」走完五步（经验回流见其「五」第 2 条）。

## 六、经验沉淀协议

已并入 [`maintenance.md`](maintenance.md)（2026-09-30）：何时写项目日志、什么不写、双层分流（通用规则进 Skill，项目专属进 `.rankup/`）与「不用请示」都以那里为准。本篇只保留 SEO 经验库自己的格式约定：

- [`seo-experiences.md`](seo-experiences.md) 一条一行，`[日期] 结论:证据`；同一结论已有就更新旧条目的日期与内容，不另起一条；条目超过约 25 条时合并同类、删除过时。
- 数据通道变化直接改 [`seo-data-channels.md`](seo-data-channels.md) 对应行。
