# 页面组件与数据源（实现落地后以代码为准）

> 2026-10-11 的设计决定。组件的具体文件路径、schema 字段在实现完成后回填到这里；回填前以画布“文章页标准”页和 `~/.agent-reports/*/ev-article-*.md` 为准。

| 组件 | 用途 | 数据来源 |
|---|---|---|
| ArticleHero | 标题、摘要、模型事实（无生成器） | frontmatter |
| GuideCard | 点击跳 `/generator` 并带模型参数；出现在首屏、文中、文末 | 模型 id → 深链接参数 |
| SpecTable | 入参/出参、最长时长、每秒积分 | **由 create-models.ts 与报价函数生成**，不手写 |
| CompareTable | 我们 vs 他们的价格与功能 | 站内计价 + 有出处的竞品采集 |
| YouTubeEmbed | 官方 iframe（lazy），可全屏播放 | sources.youtube |
| XPostWall | X share card 评论墙，含可播放视频 | sources.x（嵌入方案按摸底报告） |
| RedditLinks | 仅超链接 | sources.reddit |
| PromptCollection | 内置 Prompt 集合卡（公共组件） | prompts 数据按模型筛选 |
| Chart | shadcn 图表组件（需要图表时） | 站内数据或有出处的数据 |
| References | 官方/二手资料列表（EEAT） | sources.official / other |
| FAQ / Related | 常规 | frontmatter |

保持 URL、slug、canonical、JSON-LD 不变；frontmatter 向后兼容；新增字段写在 schema 里，未填的区块不渲染，不放“建设中”占位。
