# 趋势监控执行入口

【实测·流程迁入，2026-10-01】种子 Rising、热榜 Spike、追踪复查与 sitemap 上游信号共用项目数据目录；不自带调度器。量级判据见 [trends.md](trends.md)，SEO / GEO 通道与采样见 [seo-geo.md](seo-geo.md)。

## 一条命令

在需要保存数据的工作目录执行，`$RANKUP_SKILL` 代表实际 Skill 目录：

```bash
node "$RANKUP_SKILL/scripts/trends/run-seeds.mjs" --region US
node "$RANKUP_SKILL/scripts/trends/run-seeds.mjs" --region US --dry-run --limit 1
node "$RANKUP_SKILL/scripts/trends/run-seeds.mjs" --region JP --seeds 'ai generator,cozy game' --data-dir ./data/trends
```

参数：`--region US|JP|KR`（默认 US）、`--limit N`、`--seeds a,b,c`、`--dry-run`、`--session NAME`（默认 trends-地区小写）、`--tracker-limit N`（最多 8，默认 8）。只调用同一 Skill 的 `scripts/gt-browser.mjs`，不另写 GT 取数逻辑。

## 数据目录约定

四个脚本均按 `--data-dir` → `RANKUP_TRENDS_DIR` → 当前工作目录的 `.rankup/trends` 解析数据目录；相对路径相对于调用时的工作目录。运行状态、账号配置、案例与证据留在该目录，不进 Skill。

| 文件或目录 | 用途 |
|---|---|
| `seeds.json` | 活的种子词与 vertical；初始化可复制 Skill 的 `scripts/trends/seeds.default.json`，以后不覆盖活库 |
| `seed_seen.json` / `seed_seen_jp.json` / `seed_seen_kr.json` | US / JP / KR 去重台账；US 历史命名无 `_us` 后缀 |
| `seed_health.json` | 各区连续 empty/fail 与 dormant 台账 |
| `hot_tracker.json` | `terms` 数组；tracking / must-do / dropped 与检查记录 |
| `evidence/runs/` | 原始状态、结果 JSON、中文简报与每词原始证据 |
| `sitemap_sources.json` | 站点名称到 sitemap URL 的对象，由项目自行选择来源 |
| `sitemap-monitor/snapshots/` / `sitemap-monitor/reports/` | 上游 sitemap 快照与新增报告 |
| `crons-archive/` | 原始任务定义与目标，仅存档，不加载调度或消息字段 |

## 三区执行与产物

US、JP、KR 分开去重和健康统计，顺序运行。tracker 缺 region 的条目按 US；每轮只复查本区。种子与 vertical 动态读取，不写死数量。

1. `seed_health.py --active-seeds <区>` 取活跃种子，逐词采集过去 7 天 Rising；只保留 Breakout / ≥1,000%。词根扫描不带锚点。
2. 写 `种子词 | 查询词 | 涨幅` 和 `种子状态 | 种子词 | 地区 | ok/empty/fail | 原因`。JP/KR 查询词保留原文。
3. `seed_report_parse.py <报告> [本区去重文件]` 输出 `new` 与 `stats`；`seed_health.py --region <区> <报告>` 更新健康度。连续 3 轮 empty 或连续 3 轮 fail 才 dormant；不自动恢复。
4. 复查本区 tracking / must-do 最多 8 个，must-do 优先，其次最近加入优先；90 天看形状，US 另取 30 天同框量级。
5. 中文报告以「🔥 必做提醒」开头，列全部本区 must-do；无新增也写结果、健康统计、复查与失败原因。

主脚本自动串联以上步骤。dry-run 仍真实采集并写证据和报告，只跳过去重库、健康台账、追踪器写入。新词判断固定「待判断」，不自动加入 tracker，不自动改变 must-do / dropped，只追加已有追踪词 checks。

追踪升级候选须连续 2 轮上升或平稳，且估算月量区间下界 ≥2,000；这仅是监控提醒，量级、SERP 与工具词 GEO 推荐位仍需复核，不等于立项。回落或脉冲结束由人工判 dropped 并保留原因；pin 不自动降级。must-do 持续提醒至行动或衰减。

## 浏览器与限流恢复

浏览器一律 OpenCLI 驱动已登录 Chrome，先 `opencli doctor`，dedicated 窗口、单会话、全程串行，词间隔 10 秒；任何时刻只有一个采集器。结束与失败均关闭自己的会话。

- `Oops! Something went wrong` 为失败，整页重载；Navigation rejected 使用既有 open 重试。
- 429 约等 30 秒后重载，最多重试 3 次；302、接口错误、未确认空响应算 fail，不能当零需求。
- `doesn't have enough data` 或已确认 Rising 空列表算 empty。
- 验证码、浏览器桥异常停止并记录原始错误，不无限重试。

## 月量与终判

r = 候选词与当地锚点在同一 30 天窗口的均值比；月量约为 r × 当地锚点月量，按 ±35% 报取整区间，r ≥10 仅报下界并注明特大体量。当前脚本的 US 历史锚为 gpts 5,400（Semrush，2026-09-09，未重取）；报告保留 r、日期、来源与未重取标记，不能冒充当轮校准。正式决策按 [锚点规则](trends.md#〇六锚点体量的选择用中等量词作锚细分词才能看清形状semrush-月量的交叉验证是硬规则不是可选步骤)重取与第二锚交叉验证。

90 天用于形状，不能替代 30 天量级。JP/KR 缺当地锚点只报 r，不借 US 数折月量。区间跨线写「跨线，需复核」。候选全 0 写「未知（Trends 无法分辨）」，不累计追踪轮数；词簇机械相加只能作上限。

终判分开写 `SEO 做/不做` 与 `GEO 待测/可做`，各列证据；GT 见顶或 SERP 垄断后仍需独立实测 AI 推荐位，不做 GT × 固定倍数推断。

## Spike 与其他信号

热榜用 `gt-browser.mjs hot --region <区>` 或同一 OpenCLI 会话读取；记录词、量级、涨幅、开始时间，与上一轮证据比新增，首次只建基线。新上榜 ≥100K 为 hot，5K 至 <100K 为 watch，热榜量级不等于月量。Spike 只追加人工确认的候选，复查与升降级交种子轮次；原任务若引用未提供的脚本，不能声称已跑通。

```bash
python3 "$RANKUP_SKILL/scripts/trends/sitemap_diff.py" --baseline
python3 "$RANKUP_SKILL/scripts/trends/sitemap_diff.py"
```

sitemap 首日建基线，后续输出新增 URL 的 slug 候选；codes/wiki/tier list/guide 标高价值模式。来源配置由项目维护：公开 sitemap 只有静态页则无增量价值，无 lastmod 且子 sitemap 过多的来源需评估采集成本。聪明钱与竞品反查见 [通用方法](trends.md#趋势候选的验证与反查)。
