# 选品闸门 · 候选生成器与工具清单

> 本文件从 [`selection.md`](../selection.md) 拆出（2026-09-30）。候选生成器在闸门体系之外，只负责产出候选，判定仍走七道闸门。

## 9 · 候选生成器（闸门体系之外）

七道闸门筛的是"已经有的候选"，这一节回答候选从哪来——**在旧方法论"拉关键词表找洼地"之外的另一条路**。

### 领先指标法

搜索量是**滞后指标**——等一个词有搜索量了，AI 工厂早就铺满了；**买量和榜单是领先指标**。

逻辑链：有人持续买量 → 值得查需求和转化；投放不证明 LTV 撑得住成本，也不保证未来出现搜索量。

路径：**谁在买量/谁在冲榜 → 这个需求是什么 → 哪个平台适合完成任务 → 进闸门 0**。

没有广告不能证明需求不值钱；仍须独立查付费与使用证据。

**重要限定：我们自己不买量，只读别人的买量行为当信号。** 这条生成器不改变硬约束里"不买量"的红线，
它只是把别人已经花出去的钱当作免费情报来源。

### App 需求与交付平台

App 榜单提供候选，不证明市场已验证。macOS、iOS、iPad 可直接作为交付平台；不要强行转成 Web SaaS。Android 只作跨平台需求参考，不作为开发交付。采集、证据分级与市场判断统一走 [`research.md` App 市场验证分支](../research.md#app-市场验证分支)，网页低量不否决 App。

### 脚本化工具：`scripts/select/leading-indicator.mjs`（候选生成）+ `scripts/select/gate-runner.mjs`（闸门判定）

上面两条生成路径已经封装进 `leading-indicator.mjs`：`scan --source ads|appstore|gplay|stripe` 调用对应
demand 脚本产出候选并落盘去重，`report` 负责聚类/巨头过滤/工厂识别/导出。判定仍然是 `gate-runner.mjs`
的 `gate <0-6> --pass/--kill` 系列命令在做（自动写 `.rankup/decisions.md`/`rejected.md`，见 §13「收尾」），
两个脚本各司其职，产出不互相覆盖——具体参数见各自 `--help`。

**信号源族**：`ads`/`appstore`/`gplay`/`stripe` 四个信号源，`appstore` 与 `gplay` 同属一族 `app-charts`
（同一个"App 冲榜"观测的两次采样点），`ads`、`stripe` 各自独立成族。**"多个独立方法论撞到同一方向"
这个硬信号只能看跨族命中**（`report --cluster` 的 familyCount≥2），**不能看命中源数**：appstore+gplay
都命中同一候选只算同族内 1 族，实测目前真实数据里跨族命中是 0 次（ads/stripe 候选量太少，撑不起与
app-charts 族的印证）——"多个信号源汇聚""三个独立信号源汇聚到同一方向"这类说法已被证伪，**只有跨族
命中才算交叉验证，同族内多店命中不算**。

**聚类只做同名/同域名去重，不做模式识别**：早先设计过用"开发者名"当第二把聚类钥匙去抓"同一家公司跨源
撞车"，真实数据证明代工壳公司挂靠同一账号做不相关 App 太常见，链式传递会把无关产品误并，已移除——
**"聚类能发现跨垂类模式"这个说法已被证伪**，精确名字/域名匹配抓不到"措辞不同但其实是同一类需求"这种
模式，字符串匹配做不到，交给人或 LLM 通读 `report --export-jsonl` 导出的紧凑 JSONL（scan 时已自动写一份）。

**工厂识别**（`report --factories`，阈值 `--min-factory-products` 默认 2）：同一个开发者账号在当前数据集
里挂了 ≥ 阈值个候选，标成"疑似工厂"，提醒去核实是不是同一套模板批量复制到了不同垂类（真实案例：Glority
把"拍照识别+估值"用马甲公司 Next Vision Limited 复制到 9+ 个垂类——字符串匹配抓不出这种别名/DBA，仍需
人工翻开发者页核实）。**工厂 ≠ 巨头**——`--giants` 判"这一个产品体量大/发行商是知名大厂"，`--factories`
判"这个开发者名下挂了好几个产品"，两套判据/名单/阈值完全独立，不要混着看。同一模式跨垂类出现有两种
相反含义：**多个独立团队各自验证了同一模式**（好信号，见 §5 闸门 4"监控/聚合型工具"正面样本）vs
**一家工厂批量铺货，地已经被收割**（坏信号）——区分看开发者是不是同一个账号/公司，不是看模式本身像不像。

**信号源覆盖差异（用工厂识别前先确认字段有没有）**：appstore 的 `extra.artist` 每次 scan 都带；**gplay
的 `extra.developer` 只有 `--ranking` 模式才带**，默认搜索/分类列表模式（字段是 `position`）拿不到——
scan gplay 时不显式加 `--ranking`，gplay 侧的工厂识别、以及"跨商店同名匹配"这条巨头过滤补救路径都会
测不出来；ads 只有 `creatives` 子命令有开发者字段，`advertisers` 子命令本身就是广告主，没有独立开发者
字段；stripe 只有域名，不参与工厂识别。

**巨头过滤只在 `scan` 时生效，`report` 不回溯**：appstore/gplay 默认过滤掉命中已知巨头名单、或跨商店
同名匹配到对面已判过巨头的候选（`--no-filter` 关闭），但只作用于这次新落盘的候选——已经 scan 过的历史
候选不会因为后来更新巨头名单而重新过滤，想重新过滤要重新 scan。

**`--ads-mode` 必填**（仅 `--source ads`）：显式声明这次透传的子命令是 `creatives` 还是 `advertisers`，
跳过字段探测；不传会从透传参数自动识别，两条都没有才报错，不会静默瞎猜。ads/appstore/gplay 连续快速
查询可能触发 Google 的异常流量检测并弹验证码/限流，脚本会侦测并进入跨进程冷却（`<out-dir>/block-state.json`），
冷却期内拒绝再发请求——看到"🚫 被墙"不要立刻重跑，等冷却结束或换个信号源。

### 三问链：候选生成之后，先按顺序问完这三句再决定进不进闸门 0

①**有人在找吗**——这个方向在目标网页或商店有没有需求表达；App搜索与网页搜索分开记。**这是零配额的轻量
观察，不是提前把闸门 6 做掉**（【经验】）：看搜索框下拉、底部相关搜索、首页结果的构成，记下用户
用的原词，顺手判一句他是在了解这个问题还是想马上完成一个动作；量、CPC、KD 一律留到闸门 6 再花
配额。这一步只确认一件事——**这个问题有没有被用户用搜索表达出来**。
②**有人赚到钱吗**——现有玩家有没有可核验收入；付费墙、挂牌价格、收银台引荐只说明收费或付费入口，不是成交。
③**还有位置吗**——SERP/榜单前排是不是已经被巨头或工厂占满。**知道有人赚钱 ≠ 还有位置**：①②都成立
只说明这不是伪需求，③才是决定还要不要花时间往下走的关键，最容易被漏问。

### 脚本

| 信号 | 脚本 | 备注 |
|---|---|---|
| 广告主持续投放（不证明 ROI） | `demand/ads-transparency.mjs` | 零依赖；逆向 RPC，Google 改协议随时可能断；`leading-indicator.mjs scan --source ads` 用时必须显式给 `--ads-mode`（`creatives` 或 `advertisers`）|
| App Store 付费榜/畅销榜 | `demand/appstore-charts.mjs` | 零依赖，官方 RSS，这 10 个核心脚本里第二直接的付费证据；`--lookup` 才带 `ratingCount`（可选评分数巨头判据） |
| Google Play 付费榜/畅销榜 | `demand/gplay-charts.mjs` | 零依赖；**要参与工厂识别就必须传 `--ranking`**（`extra.developer` 只有这个模式才有） |
| Stripe 收银台新上榜域名 | `demand/stripe-referring.mjs` | `--new-only` 使用旧全榜入口（官方无等价，本轮未重验；旧记录不计每日配额），本月新进榜 = "新机会"线索；只认 `top` 子命令的行形状 |
| 新品/流量/收入榜（ProductHunt/Toolify/TAAFT/TrustMRR/Columbus） | `demand/boards.mjs` | producthunt 分支缺 `PRODUCTHUNT_TOKEN` 自动降级浏览器，不算硬失败 |
| Steam/itch/Poki 新游戏（配套工具信号） | `demand/game-newtitles.mjs` | igdb 源缺 `IGDB_CLIENT_ID` 跑不了，换 `--source steam/itch/poki` |
| 别人写好的 SKILL.md/自动化配置（反推被验证过的需求） | `demand/github-skill-search.mjs` | `--mode code/recent` 需要 `GITHUB_TOKEN`；本机 `gh` CLI 已登录，`gh auth token` 一行就能取得，不必单独申请；不取也能用 `--mode repo`（10 次/分） |
| 外包平台真实成交（已经有人花钱雇人做） | `demand/freelance-demand.mjs` | freelancer 子源零依赖，付费证据强度与 stripe-referring 同级 |

---

## 12 · 工具清单与可选加速通道（6 个未配 key 均非必需）

可选 API 通道与免费替代路径：

| Key | 它本来是什么 | 免费替代路径（实测可用） |
|---|---|---|
| `REDDIT_CLIENT_ID` | Reddit 官方 OAuth API 的替代通道 | 不需要配：Reddit 走 `agent-reach` 路由到的 OpenCLI 登录态即可，见 §3 速查表（**实测**，2026-09-12） |
| `SERPER_API_KEY` | 付费 SERP 抓取 API 的替代通道 | `opencli google search "<query>" --lang <lang> --limit 10 -f json`（本项目实战验证过）；也可用 官方 `gefei-keywords` Skill 的 SERP 工具（按实时报价） |
| `GITHUB_TOKEN` | 提高 GitHub API 限流上限的替代通道 | `gh` CLI 本机已登录，直接可用；想要更高限流一行 `gh auth token` 就能取得，不需要单独去 GitHub 后台申请 |
| `TABAPI_KEY` | 官方数据源的付费替代通道 | 脚本默认 `--provider webcafe` 经官方 gefei CLI，每域名 2 积分（以实时目录为准）；失败保留错误，不能当无数据 |
| `PRODUCTHUNT_TOKEN` | ProductHunt 官方 GraphQL API 的替代通道 | 脚本默认 provider 免费可用，自动降级浏览器路径，数据更全，不算硬失败 |
| `IGDB_CLIENT_ID` | 游戏方向专用官方数据源 | 只影响游戏方向；换 `--source steam/itch/poki` 同样能跑 |

逐闸门影响：闸门 0/1/5/6 完全不涉及这 6 个 key；闸门 2/3/4 各自有一个"配了更快"的可选分支，
不配就走上表对应的免费默认路径，**不是跑不了，只是少一条更快的选项**；候选生成器阶段同理（见 §9 脚本表）。

**结论**：七道闸门体系在这 6 个 key 全部未配的情况下完整可用，不构成能力缺口——遇到"缺 XX key"字样，
一律理解成"有更快的路可以配，但现在这条免费路径已经在跑"，不要理解成"这一步做不了"。

---

