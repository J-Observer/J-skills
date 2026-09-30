# new.web.cafe（哥飞社区论坛）接口地图与取数 SOP

## 目录

- [一、最重要的一节：匿名不会 401，它会静默给你半份数据](#一最重要的一节匿名不会-401它会静默给你半份数据)
- [二、正文为空有四个原因，只有一个是登录能解决的](#二正文为空有四个原因只有一个是登录能解决的)
- [三、两套问答产品，别混：round ≠ bounty](#三两套问答产品别混round--bounty)
- [四、bounty 还分两种 kind，内容放在不同数组里](#四bounty-还分两种-kind内容放在不同数组里)
- [五、接口表（/ask/，有 JSON API）](#五接口表ask有-json-api)
- [六、经验 / 帖子 / 教程：没有 API，解析服务端渲染](#六经验--帖子--教程没有-api解析服务端渲染)
- [七、站内搜索：必须登录，而且没有 JSON 端点](#七站内搜索必须登录而且没有-json-端点)
- [八、群聊归档：可直接搜索的知识库](#八群聊归档哥飞ai-的知识库可以直接搜)
- [九、站内聊天：两套服务的区别](#九哥飞aichat-和-seowebcafechat-是两个东西)
- [四、SOP：给一个 URL 就把内容取回来](#四sop给一个-url-就把内容取回来)
- [五、给这个站写脚本时会踩的坑](#五给这个站写脚本时会踩的坑)
- [六、只读红线](#六只读红线)

哥飞的社区论坛，域名 `new.web.cafe`。**和 `seo.web.cafe` 是两个站、两套 API，不要混**：
那边是工具箱（KD / SERP / 体检 / 估值，见 [`seo-webcafe.md`](seo-webcafe.md)），
这边是内容社区（悬赏问答 / 经验 / 话题 / 教程）。

技术栈是 Next.js App Router。**这决定了站里有两种完全不同的取法**，
选错了会拿到空结果而且不报错：

| 内容 | 怎么渲染 | 怎么取 |
|---|---|---|
| `/ask/*`（悬赏问答） | 客户端 fetch | **有干净的 JSON API**，走 `/api/ask/*` |
| `/experiences`、`/topics` 等 | 服务端渲染（RSC） | **不打任何内容 API**，正文在 HTML 的 `self.__next_f` 里 |

**判据：打开页面看 `network` 里有没有 `/api/` 请求。** 没有就别再找 API 了，
它就是 SSR，去解析 HTML。反过来，对着有 API 的页面去抠 HTML 是自找麻烦。

脚本：[`../scripts/webcafe-forum.mjs`](../scripts/webcafe-forum.mjs)（命令行）
+ [`../scripts/webcafe-transport.mjs`](../scripts/webcafe-transport.mjs)（传输层）。

---

## 一、最重要的一节：匿名不会 401，它会**静默给你半份数据**

这是本站最容易踩、后果最脏的一个坑。实测同一个端点
`GET /api/ask/bounty/fd0wrgx7fh`（2026-08-24）：

| 传输 | HTTP | 字节 | answers | 正文 | `visible` | `vote_count` |
|---|---|---|---|---|---|---|
| 匿名 curl | **200** | 80,941 | **23 条全在** | **0 字** | false | **全 0** |
| 已登录浏览器 | 200 | 140,491 | 23 条 | **19,651 字** | true | 26 / 8 / 20… |

匿名**不报错、不少给条目**：它照样返回 23 条答案、342 个投资人、每条答案的
作者名和 `content_len`，只把正文换成空串、`visible` 置 false、票数归零。

> **所以「拿到了吗」不能看状态码，要看正文空不空。**
> 不检查 `visible` 就落盘，会把「我没登录」写成「这条答案是空的」——
> 一份看起来完整、实际全是空壳的数据文件，而且没有任何报错提醒你。

---

## 二、正文为空有**四个**原因，只有一个是登录能解决的

分不清这四种，最坏的后果不是少拿数据，是**被推去点那个要花钱的解锁按钮**。
判据全部来自服务端返回的 `bounty.viewer`，不要自己从状态瞎推。

2026-08-30 双证人化后，脚本输出改成两层：`access_evidence`（viewer 原始字段、
status、各计数、解锁价、rawExcerpt——**这才是判据**）+ `suggested_access`
（脚本按下表给的**建议**，不是判决：站点改字段语义时 evidence 仍真、suggested
会陪着错；存疑时看 evidence 与 `--transport browser` 的截图）。取数失败 die 前
会把状态码/原文片段落 `.rankup/evidence/webcafe-forum-<ts>/`。

| `suggested_access` | 判据 | 含义与处置 |
|---|---|---|
| `full` | `viewer.canSeeAll === true` | 拿全了 |
| `anonymous` | `viewer.isLoggedIn === false` | 没登录。**唯一一个开浏览器有用的情况**。默认的 `auto` 会自动升级；`--transport http` 下需手动改 `auto` 或 `browser` |
| `sealed` | 已登录，且 `status` ∈ funding/collecting/open/**answering** | 答案对**所有人**封存（答题期防抄袭）。**登录和付钱都没用**，等它进入 `voting` |
| `needs-unlock` | 已登录，`status` ∈ voting/settled，但 `canSeeAll` 仍为 false | 要花钱解锁（`unlock_price`，单位分）。**脚本绝不自动做**，你自己在网页上决定 |

### `hasUnlocked` 不是判据，`canSeeAll` 才是

实测 `fd0wrgx7fh`：`hasUnlocked:false` 但 `canSeeAll:true` —— 照样能看全 23 条。
原因是本人是这场的答题者之一（`isAnswerer:true`）。
**拿 `hasUnlocked` 当判据，会让你为一份已经能看的内容再付一次钱。**

`canSeeAll` 为真的已知来源有三条，任一即可：`isAnswerer`（你答过）、
`hasUnlocked`（你付过）、`isInvestor`（你投过，实测 `wlhmhdaoqg` 如此）。

### 一条没能验证的边界，如实记在这里

站内当前 5 场 `voting` 悬赏，**本账号恰好全都能看**（4 场付过、1 场答过），
所以「一场 voting 且完全没参与过的悬赏，正文是不是真要付费」**没有观察到反例**，
无法断言。已知的只有：匿名对 voting 场次是看不到正文的（上表实测）。
真遇到 `needs-unlock` 时，**按「要花钱」处理**，别赌。

---

## 三、两套问答产品，别混：round ≠ bounty

站内 `/ask` 前缀下并排放着**两个完全不同的产品**，字段和端点都不一样：

| | **round（付费问答）** | **bounty（悬赏）** |
|---|---|---|
| 是什么 | 1 对 1：提问者付钱给某个专家 | 众筹：多人凑钱、多人竞答或征集 |
| 列表 | `/api/ask/publicRounds`、`/api/ask/featured` | `/api/ask/bounty/list` |
| 详情 | `/api/ask/question/<root_uid>` | `/api/ask/bounty/<uid>` |
| 页面 | `/ask/rounds` → `/ask/q/<root_uid>` | `/ask/bounty` → `/ask/bounty/<uid>` |

**一个 round = 一问一答一轮**，不是「一个 round 里有多个问题」。同一个 `root_uid`
下 `seq` 递增就是追问，列表按 round 展开（同一 root 的不同 seq 各占一行）。

> **详情端点吃的是 `root_uid`，不是列表里的 `uid`。** `seq>1` 的行两者不同，
> 用错会 404 或者**拿到另一条线程**。

round 的付费墙只挡**一个字段** `answer_content`；其余元数据（含 `answer_char_count`
和 31 字 `answer_teaser`）匿名全给。

## 四、bounty 还分两种 kind，内容放在不同数组里

| `kind` | 内容在哪 | 说明 |
|---|---|---|
| `answer` | `answers[]` | 竞答：多人各写一篇，投票排名 |
| `collect` | **`collect.board[]`** | 征集：众人提交条目，按票汇总成一个榜单 |

> **这是个静默失败点。** 只读 `answers[]` 的脚本对着一个 588 条的征集榜单
> 会报「0 条答案」——不报错、不为空、就是答错了。实测 `wlhmhdaoqg`
> （「网站上线之后，你会去哪些地方提交外链？」）`answers` 长度 0，
> `collect.board` 长度 **588**。

`board[]` 每条：`display_text` · `site_domain` · `vote_count` ·
`merged_aliases[]` · **`submitters[].note`（提交者写的理由，这类题最有价值的字段）**。

**征集榜单要到「已开榜」(`open`) 才可见**：`collecting` 阶段
`option_count` 有值（109）但 `board` 是空数组，登录也一样。

## 五、接口表（`/ask/*`，有 JSON API）

| 端点 | 参数 | 匿名 | 给什么 |
|---|---|---|---|
| `GET /api/ask/bounty/list` | `status=` `mine=` `page=` | ✅ 全量 | 悬赏列表。**全站仅 18 条**，一页到底 |
| `GET /api/ask/bounty/<uid>` | — | ⚠️ 仅元数据 | 悬赏详情 |
| `GET /api/ask/bounty/<uid>/comments` | — | ⚠️ `locked:true` | **`locked` 是「你没资格看」不是「没评论」**，`total` 会一并压成 0 |
| `GET /api/ask/publicRounds` | `page=` `sort=` | ✅ | 付费问答列表 |
| `GET /api/ask/question/<root_uid>` | — | ⚠️ 缺 `answer_content` | 一条线程的全部轮次 |
| `GET /api/ask/featured` | — | ✅ | 固定 10 条，**参数全被忽略** |
| `GET /api/ask/home` | — | ✅ | 首页聚合：轮次 + 榜单 + 专家 |
| `GET /api/ask/experts` | `page=` `pageSize=` | ✅ | 122 位专家，`pageSize` **封顶 50** |
| `GET /api/ask/activity` | — | ✅ | 固定 30 条动态流，无分页 |
| `GET /api/auth/session` | — | ✅ | **登录态探针**：未登录返回字面量 `null` |
| `GET /api/ask/mine` | `role=` | **401** | 需登录；`role` ∈ asker/expert/viewer/tipper |
| `GET /api/ask/bounty/<uid>/review` | — | **401** | 对账数据，仅投资人/管理员 |

`status` 合法值（来自页面筛选 tab，不是猜的）：
`funding`(众筹中) · `answering`(竞答中) · `collecting`(盲征中) · `voting`(公示计分中) ·
`settled`(已结题) · `open`(已开榜)。另有 `failed` / `reviewing` 接口接受但页面无对应 tab。
`mine` 只有 `invested` / `answered` 两个值，**匿名带任何非空 `mine` 一律 401**。

`publicRounds` 的 `sort`：`smart`(默认) · `latest` · `tips` · `likes` · `unlocks` · `price`。

### 参数写错**不报错**，这是这套 API 最脏的地方

| 传错 | 实际行为 |
|---|---|
| `status=bogus` | 静默返回**全部** 18 条，等同 `status=` |
| `mine=bogus`（登录态） | 静默落回全部 18 条 |
| `sort=bogus` | 静默落回 `smart`——**唯一能自查的一个**：响应里的 `sort` 字段会回显成 `smart` |
| `pageSize=100` | `publicRounds` / `bounty/list` 固定 20，**直接忽略**；`experts` 认但封顶 50 |
| 翻过尾页 | `200 + success:true + list:[]`。**别把空数组当错误重试** |

**未观察到限流**：连翻 12 页 + 同端点连打 15 次，全 200，无 429、无退避。
但 `robots.txt` 写着 `Disallow: /api/`——我们是以用户身份读自己有权限的数据，
不是爬虫，**但也别做高频轮询**。

> **别把脚本里那个「连续 5 次就熔断」当成限流证据。** `webcafe-forum.mjs` 正文
> 批量抓取确实有一个 `FUSE = 5` 的熔断（连续 5 条空正文或连续 5 次解析失败即触发），
> 但它治的**不是限流，是掉线**：命中后的动作是**自动重新登录并把这一批重排到队尾**，
> 不是退避等待。触发原因是这个站的会话会自己断（实测第一轮撑约 100 条、
> 重登后约 20 条就再断一次），所以它**经常触发**，是常态处置而非异常保护——
> 完成行打印的 `自动重登 N 次` 就是它的计数。把它读成「站点会限流」会导出错误的对策
> （降速、加退避），而正确对策是保证重登路径可用。

### 单位：三种货币混在一个响应里

**`1 咖啡豆 = 10 分 = 0.1 元`**，三条独立证据闭合（前端 tooltip `amount/10` 得豆、
站内 FAQ「1 元 = 10 咖啡豆」、`share_fen:1000` = 10 元/份）。

- `*_fen` 结尾一律是**分**：`pool_fen:376000` = **3760 元**。
- ⚠️ **round 侧的 `price` 和 `tip_total` 没有 `_fen` 后缀，单位却也是分**：
  `price:10000` = **100 元**。字段名反直觉，是最容易错 100 倍的地方。
- `payouts.rows[].tokens` 是**豆**，同一行的 `fen` 是**分**，两者相差 10 倍。

### `answers[]` 里几个容易误读的字段

| 字段 | 含义 | 匿名 |
|---|---|---|
| `rank` | **结题后冻结**的名次。当前站内 `settled` 为 0，所以**任何身份下都是 `null`** | null |
| `live_rank` | 公示期实时名次，前端排行用的就是它。**匿名侧该字段根本不存在** | 无 |
| `score` = `vote_score` + `tip_score` | 后两个字段**只有登录才存在** | 被抹成 0 |
| `vote_count` | 投票**人数** | 被抹成 0 |
| `tip_total_fen` / `like_count` / `fold_count` | 打赏、点赞、被折叠数 | ✅ **真值** |
| `post_settle` | `true` = 结题后追加的回答，不参与分成 | ✅ |

> **`fold_count` > 0 不等于没价值。** 实测 `fd0wrgx7fh` 的 23 条里 17 条被折叠，
> 而本库 [`experiences/demand-discovery.md`](experiences/demand-discovery.md)
> 最可执行的几条方法恰恰出自被折叠的答案（`fold_count>=3` 前端会默认折起来）。
> **按 `vote_count` 排序读，但不要按 `fold_count` 丢弃。**

一句话：**匿名能拿到约九成元数据 + 完整投资人名单 + 打赏/点赞明细 + 每条回答的字数；
拿不到的是正文、票数/得分、实时名次。**

## 六、经验 / 帖子 / 教程：没有 API，解析服务端渲染

这三块**不打任何内容 API**，正文在 HTML 的 `self.__next_f`（RSC flight）里。
解析器：[`../scripts/webcafe-rsc.mjs`](../scripts/webcafe-rsc.mjs)。

| 集合 | 列表 URL | 每页 | 页数 | 总数 | 详情 URL |
|---|---|---|---|---|---|
| 经验 | `/experiences`、`/experiences/<N>` | 10 | 10 | **91** | `/experience/<uid>` |
| 帖子 | `/topics`、`/topics/<N>` | 20 | 37 | **722** | `/topic/<uid>` |
| 教程专栏 | `/tutorials`、`/tutorials/<N>` | 30 | 2 | **40** | `/tutorial/<columnUid>` |
| 专栏内文章 | `/tutorial/<col>/<N>` | 20 | 按专栏 | 单专栏实测 **1148** | `/tutorial/detail/<uid>` |

`/experience/<uid>` 和 `/topic/<uid>` 是**同一个详情页的两个别名**，
同一个 uid 两条路径都 200，只有面包屑不同。但两条**流**的内容不重叠（uid 交集为空）。

### 分页与终止

- **只认路径段 `/xxx/<N>`。`?page=N` 被静默忽略**——返回第 1 页，
  HTTP 200 且字节数与第 1 页完全相同。用 `?page=` 翻页的脚本会把第 1 页抓 N 遍。
- 终止用 `pageData.totalPage`。**不要用 `pagination`**（那是页码按钮的滑动窗口，
  第 1 页 `[1..6]`、第 10 页变成 `[5..10]`），**也不要只判 404**
  （专栏翻页越界返回的是 **308**）。
- `page` prop 类型不一致：第 1 页是数字 `1`，第 2 页起是字符串数组 `["2"]`。

### 登录墙：元数据匿名可见，正文匿名恒为空串

| | 匿名 | 登录 |
|---|---|---|
| 列表元数据（uid / 阅读 / 点赞 / totalPage） | ✅ 逐字段相同 | 同 |
| `markdown` | `""` | 全文 |
| `/tutorial/detail` 的 `canViewTutorial` | `false` | `true` |

**默认的 `--transport auto` 会自己跨过这道墙**：先匿名取，解析出的 `markdown` 全空才
升级到浏览器重取一次。判据不在传输层（那层只看得到 HTML 字符串，看不出正文空不空），
而在 `webcafe-forum.mjs` 的 `fetchProps(path, ctx, gated)`——**给有正文的页面漏传
`gated`，后果不是报错，是 auto 静默退化成 http 拿回一堆空正文**。
反过来，`/topics` 和两个教程列表页**必须不传**，否则每页白开一次浏览器。

> **登录态最省的取数路径：`/experiences/<1..10>`。**
> 登录后**经验列表页的每一项就带完整 `markdown`**，10 个请求拿完全部 91 条全文，
> 完全不用逐条打详情页。
>
> **但这条只对经验成立。** `/topics` 的列表项**根本没有 `markdown` 字段**
> （登录也没有），帖子正文必须逐条打详情页。

### 三个静默陷阱

| 写法 | 实际行为 |
|---|---|
| `/topics/<uid>`（把详情当列表路径） | **不是 404**，静默渲染**列表第 1 页**，200 / 98KB。详情是 `/topic/<uid>`（单数） |
| `/tutorial/<articleUid>`（把文章当专栏） | 200 的**空壳专栏页**，`columnInfo:null`。文章必须走 `/tutorial/detail/<uid>` |
| 靠 `/tutorials` 翻完所有教程文章 | `tutorialTopicPageData.totalPage:79` **够不着**——路由上限被专栏的 `totalPage:2` 卡死，`/tutorials/3` 是 404。只能按专栏逐个下钻 |

## 七、站内搜索：必须登录，而且没有 JSON 端点

| 项 | 值 |
|---|---|
| URL | `/search?q=<词>&page=<n>`，**只认 `q`**（`keyword`/`query`/`s` 全无效） |
| 匿名 | **307 跳回首页**。站内其它页面匿名都是 200，只有它被网关掉 |
| 端点 | **没有**。登录后也不打任何 `/api/*search*`，是 Server Component 直出 HTML |
| 每页 | 30 条；总数从页面文案 `共有 N 条结果` 取，`ceil(N/30)` 是页数 |
| 覆盖 | `/experience/`、`/topic/`、`/tutorial/detail/`。**不覆盖悬赏**（搜「悬赏」返回 0 条） |

- **加 `RSC: 1` 头是陷阱**：返回 200 和 5 万多字节，看起来很正常，
  但里面**没有任何搜索结果**。必须走普通 HTML fetch。
- 底部分页是**按钮不是 `<a>`**，抓不到 href，只能靠 `N` 自己算页数。
- 页面上三个复选框（完全匹配 / 大小写敏感 / **不搜索群聊总结**）**不进 URL**，
  纯客户端状态，脚本控制不了。第三个**默认勾选**——
  也就是说**默认搜索结果里不含群聊内容**，群聊要单独走下一节。
- 顶栏搜索框是 React 受控 input，`type` + 回车**打不动它**（值写进去了但 URL 不变）。
  直接拼 `/search?q=` 导航。

官方 Skill 暂无可证明的等价能力（依据：官方 `gefei/SKILL.md`「哥飞说过什么：知识库」只说明 `knowledge_ask` 返回相关段落与出处、`knowledge_search` 返回标题/日期/链接/短节选、`knowledge_read` 按文档读取；`gefei/scripts/webcafe.mjs` 动态取接口合同，未给原始群聊或论坛全集字段）；保留本地 `webcafe-forum.mjs`。已知差异：本地读取论坛原文、悬赏 `collect.board[]` 投票榜及群聊 `message_list[]`（消息 ID、发送者、时间、群名），官方说明未承诺相同语料覆盖、原始字段或分页范围，且知识库接口扣积分。

## 八、群聊归档：哥飞.ai 的知识库，可以直接搜

`/messages` 是「哥飞的朋友们」**14 个微信群的完整聊天记录归档**。
这就是站内哥飞.ai 的底层语料——它回答里的 `<chat_cite msg_id="...">`
指向的就是这里的原始消息。

**所以想要那批素材，不必去问 AI**：直接搜归档拿到的是**原文**，
不经模型转述、不消耗任何对话额度。

```
POST /api/community/message/search-message
{"room_id":"all","keyword":"挖掘需求","case_sensitive":false,"exact_match":false,"content_only":true}
```

返回 `message_list[]`，每条含 `msgsvrid`(即 chat_cite 的 msg_id) · `msg_content` ·
`sender_nickname` · `pub_time` · `group_name` · `room_id`。

- **必须登录**（匿名 401）。
- **硬上限 50 条，且完全静默**：传 `limit:200` / `page:2` 不报错、不生效，
  返回的 50 条与不传时逐条相同。要更多只能**换关键词**或 `--room` 逐群缩小。
- 同前缀下还有 `save-*` / `update-*` 写端点，脚本里必须显式白名单。

## 九、哥飞.ai（`/chat`）—— 和 seo.web.cafe/chat 是两个东西

站内导航「AI 工具」下并列三条，**各有各的后端，别互相替代**：

| 入口 | 是什么 | 我们的脚本 |
|---|---|---|
| `new.web.cafe/chat` | 哥飞.ai，语料 = 群聊归档 + 站内教程 | `webcafe-forum.mjs ask` |
| 站内聊天入口 | 旧站内 SEO Agent；Rankup 改用官方 `gefei` Skill 的 `knowledge_ask` / `knowledge_search` / `knowledge_read` | [`seo-webcafe.md`](seo-webcafe.md) |
| 工具箱首页 | SEO 工具箱 | [`seo-webcafe.md`](seo-webcafe.md) 指向官方 Skill |

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/ai/sessions` | GET | 历史会话列表（**读历史免费**） |
| `/api/ai/sessions/<id>/messages` | GET | 一整条对话 |
| `/api/ai/chat` | POST | `{session_id, message}` → **裸 `data: {json}` 行协议**（不是标准 SSE 头） |

**计费：读侧看不出来。** 把 `/chat` 加载的全部 29 个 chunk 扫过
`今日|剩余|次数|额度|咖啡豆|上限|quota`，**没有任何配额文案，页面上也没有计数器**
——不像 `seo.web.cafe/chat` 会明写「今日已用 N/M」。服务端扣不扣额度无法从只读侧证实。

> 所以脚本的 `ask` **默认 dry-run，要真发必须显式 `--send`**。
> 2026-08-24 实测发过一条（复用已有会话，未新建）：正常返回带引用标记的长答案，
> **未出现任何配额提示或报错**。但这不等于免费，只等于「没有可见的计费反馈」。

**多数场景应该用 `chat-search` 而不是 `ask`**：同一批语料，拿原文、零额度风险。
只有需要「让它替你跨来源综合归纳」时才值得走 `ask`。

## 四、SOP：给一个 URL 就把内容取回来

```bash
cd rankup/scripts

# 万能入口：任意站内 URL，自动路由到对应取法；认不出就退回通用 SSR 抓取
node webcafe-forum.mjs get https://new.web.cafe/ask/bounty/fd0wrgx7fh

# 悬赏全文落成 Markdown，直接能读
node webcafe-forum.mjs bounty fd0wrgx7fh --md --out out/fd0wrgx7fh.md

# 只要元数据（免费、可并发、给别人用零门槛）
node webcafe-forum.mjs bounties --transport http

# 浏览器里到底是不是登录态
node webcafe-forum.mjs whoami

# 逃生舱：站里数据量小的端点（首页聚合/专家/动态流/广告位）和以后新增的任何端点，
# 不用改代码，直接打
node webcafe-forum.mjs api /api/ask/home
node webcafe-forum.mjs api /api/ask/experts
```

`--transport` 三档：`auto`（默认，先免费 HTTP，**确认被匿名降级了才动用户的 Chrome**）·
`http`（强制匿名）· `browser`（强制走已登录浏览器）。

### 为什么 browser 这条路走「页面内 fetch」而不是读 Cookie

这个站的会话 Cookie 是 **HttpOnly**，脚本读不到；要拿就得去翻浏览器的 Cookie 存储，
等于把用户的登录凭据抠出来落盘。页面内 `fetch` 这条路，
请求在用户已登录的页面上下文里发出，**Cookie 由浏览器自动附带，脚本全程碰不到它**。

这也是回答「开源出去别人怎么用」的关键：拿到脚本的人**不需要配任何 token**，
浏览器登录着就能跑；只要元数据的话连浏览器都不用开。

---

## 五、给这个站写脚本时会踩的坑

- **必须显式带 User-Agent。** 不带 UA 的请求会被挡，且返回 HTML 错误页不是 JSON，
  脚本里表现为「解析失败」而不是「被拒绝」，极难定位。和 `seo-webcafe.md` 同源的坑。
- **不要猜 API 路径。** 实测 `/api/ask/bounty`、`/api/experiences`、`/api/topics`
  等 13 个「看起来应该有」的路径**全部 404**。这个站的 404 页面还会返回 3–52KB 的 HTML，
  按字节数判断成功的脚本会被骗过去。正确做法是打开真实页面看 `network` 里实际打了什么。
- **页面内 fetch 用的是相对路径**，所以会话必须停在本站 origin 上。会话恰好停在别的网站时，
  `fetch("/api/...")` 打到那个站去，**返回它的 404 页面，HTTP 仍是 200**。
  传输层的 `ensureOrigin()` 就是防这个。
- **`network --detail` 有 24 小时缓存**，按 request key 缓存，同一端点换了参数还是同一个 key，
  会拿回上一次的 body 且不报错。每次带 `--ttl 1`。

---

## 六、只读红线

这个论坛跑在**用户本人的真实账号**上，账号里有余额、有积分、有发帖历史。
本目录下所有脚本对本站**只做 GET**。

**禁止**：解锁 / 支付 / 投入 / 提交答案 / 投票 / 点赞 / 打赏 / 收藏 / 删除 / 改设置。
悬赏解锁是**真花钱**的（`unlock_price` 单位分），
脚本遇到 `needs-unlock` 只报告、不代劳——**花不花这笔钱是用户的决定，不是脚本的**。
