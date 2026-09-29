# Cloudflare-first 全栈架构

本文件定义 `rankup` 新网站的默认运行平台和资源选择方法。Cloudflare-first 的含义是：没有已批准的例外时，TanStack Start 的 SSR、API、数据、对象存储、异步任务和部署统一使用 Cloudflare；它不意味着预先创建全部 Cloudflare 产品。每项资源都必须由当前需求驱动，并在目标环境完成真实验证。

## 1. 默认项目脚手架

仅在确认的空目录或绿地项目中运行以下精确命令：

```bash
pnpm dlx shadcn@latest init --preset b1D0eCA4 --template start --monorepo --rtl --pointer
```

该命令是默认起点，不是成功证明。执行后必须检查实际生成的 workspace、应用目录、共享 UI 包、TanStack Start 配置、TypeScript 配置和 scripts，并运行项目实际提供的类型检查与生产构建。已有网站不重新运行脚手架，应从当前架构进入对应生命周期阶段。

## 2. TanStack Start SSR 和 API

- 使用 Cloudflare Workers 承载 TanStack Start SSR、路由、API 和服务端逻辑。
- 通过 `@cloudflare/vite-plugin` 将 Worker 运行时、bindings 和 Vite/TanStack Start 构建串联。
- 配置必须明确 Worker 入口、兼容日期、静态资产、路由或 custom domain，以及各环境 bindings。
- 通过 `cloudflare:workers` 或当前官方集成提供的类型化环境访问 bindings，不把账号 ID、数据库 ID 等环境常量散落在业务代码中。
- 本地开发、预览和 production 的运行时差异必须有显式测试；Node.js 本地通过不代表 Workers 运行时可用。

SSR 最小验收不是进程启动，而是请求真实路由后同时确认：

1. 响应状态、content type 和关键响应头正确。
2. 返回的原始 HTML 已包含预期服务端内容，而不是只能依靠客户端 JavaScript 出现。
3. 客户端水合后关键交互正常且没有运行时错误。
4. API 错误与未授权路径不会泄露堆栈、配置或密钥。

### 2.1 New Module Registry（可选 flag，2026-09 关注，本仓库尚未实测）

2026-09-09 Cloudflare 官方博客（`workers-module-registry-nodejs`）宣布重写了 `workerd`
底层的 Module Registry，是 ESM/CJS/Wasm 解析加载体系本身的重写，不是 `nodejs_compat`
的增量升级。核心变化：

- 模块 specifier 按**标准 URL** 解析（之前是类文件路径的私有 mock），因此
  `import.meta.url`、`import.meta.main`、`import.meta.resolve()` 第一次原生可用。
- `require(esm)` 按 Node.js 最新规范工作——CommonJS 与 ESM 混用不再稳定触发
  `ERR_REQUIRE_ESM`。
- 懒编译：未被实际用到的模块不在启动时整体编译，冷启动与内存占用下降。
- 应用体积上限提到**所有套餐 64 MiB**（此前的限制逼着打包器把几百个 npm 包硬编译进
  单文件）。

**这是 opt-in flag，不是默认行为，也没有默认开启日期**：

```jsonc
{ "compatibility_flags": ["new_module_registry"] }
```

已部署的 Worker 不受影响，旧 registry 继续跑；只有显式加这个 flag 才切换。

**对本仓库现有项目的判断（2026-09-11 复核）**：四个同栈 Worker 项目
的 `wrangler.jsonc`/`wrangler.toml` 都只有
`nodejs_compat`，没有人加过 `new_module_registry`；`.rankup/` 里也没有任何项目记录过
`ERR_REQUIRE_ESM`、`import.meta` 报错或因 esbuild 单文件打包导致冷启动变慢的踩坑—— TanStack
Start 的 `@cloudflare/vite-plugin` 构建链目前没有把我们逼到这些墙上，因此**这不是紧急修复
项**，先记录可用性，不主动改现有项目配置。

**什么时候该回来试这个 flag**：以后新引入某个较重的 npm 包（尤其是仍发 CJS 主入口、或
显式用 `import.meta.url` 定位资源的库）在 Workers 上打包或运行时报错、或某个 Worker 冷启动
明显变慢/体积逼近旧上限时，先查是不是撞了旧 registry 的墙，再按上面的判据决定要不要加
`new_module_registry` 单独在预览环境试跑，两条兼容性 flag（`nodejs_compat` 与
`new_module_registry`）互不冲突、可以同时开。

## 3. 按需求选择资源

| 需求 | 默认资源 | 适用边界 | 最小验证 |
|---|---|---|---|
| SSR、API、服务端业务逻辑 | Workers | 每次请求计算、路由和服务集成 | 真实 SSR HTML、API 成功/失败路径、Worker 日志 |
| 关系型、可查询、事务型数据 | D1 | 用户、订单、内容元数据、关系和迁移 | 目标环境迁移状态及最小读写事务 |
| 文件、图片、导出物、用户上传 | R2 | 大对象与对象生命周期，不作为关系数据库 | 上传、读取、权限、content type、删除/保留策略 |
| 缓存和读多写少配置 | KV | 可接受最终一致性的缓存、特性配置、派生数据 | 命中、失效、过期和源数据回退 |
| 异步事件处理 | Queues | 可重试的后台消费、削峰、解耦 | 生产/消费、重试、死信或失败处置、幂等 |
| 多步骤长流程 | Workflows | 有状态步骤、等待、重试和可恢复编排 | 步骤恢复、重试、幂等与最终状态 |
| 协调状态和强一致实例 | Durable Objects | 房间、租约、计数器、会话协调和序列化写入 | 并发行为、实例寻址、持久化和失败恢复 |
| 密钥真实值 | Worker Secrets、Secrets Store 或 CI secrets | API key、签名 secret、凭证 | 目标环境可访问且仓库/日志扫描无泄露 |

### 强约束

- KV 仅用于缓存或读多写少配置，不能成为订单、余额、权限或其他事务事实的唯一真相。
- D1 保存关系和事务事实；大对象正文放 R2，D1 只保存对象键、所有权和业务元数据。
- Queues 适合事件式异步消费；Workflows 适合需要等待、多个步骤和恢复点的过程。不要仅因“以后可能用”同时引入二者。
- Durable Objects 只在需要协调、序列化写入或每实体强一致状态时使用，不能替代普通 D1 查询。
- Secret 名称、用途、环境、存储位置、负责人、访问状态和轮换信息可以写入 `.rankup/secrets.md`；真实值绝不进入 `.rankup/`、源码、Git、测试夹具、命令行参数或可回传日志。

## 4. cf CLI、Wrangler 和 bindings 工作流

Web 项目的 Cloudflare 工具链需要 `cf` CLI。它覆盖账号级 API（包括 zone、DNS 等），用本仓库 `/cf-cli` Skill 先搜索并核对当前命令。现有项目的构建、bindings 和部署仍按项目锁定的 Wrangler 工作流；装 `cf` 不等于迁移项目。安装 CLI 与 Skill：

```bash
npm i -g cf
npx skills add yan-labs/yan-skills --skill cf-cli -g -y
npx skills add cloudflare/skills --skill wrangler -g -y
npx skills add cloudflare/skills --skill workers-best-practices -g -y
```

项目仍应锁定与其兼容的 Wrangler 开发依赖；全局 Skill 不是项目依赖的替代品。

### Binding 变更顺序

1. 明确业务需求、binding 名称、资源类型和目标环境。
2. 创建或核对目标环境资源，记录非敏感资源标识。
3. 在 Wrangler 配置的正确环境声明 binding。
4. 每次 binding 变化后运行：

   ```bash
   wrangler types
   ```

   如果项目以包脚本或 `pnpm exec wrangler` 固定版本，应使用项目已有的等价命令，但仍须确认 `wrangler types` 实际执行成功。
5. 检查生成类型是否与应用访问名称一致，再运行类型检查和集成测试。
6. 在 preview/staging 做最小真实读写，确认资源没有错误指向 production。
7. 部署 production 后重复生产只读或低风险验证；写入验证使用可识别、可清理且不影响用户的数据。

不得手工修改生成类型来掩盖配置错误，也不得只因 TypeScript 通过就声称真实 binding 可用。

## 5. D1 数据与迁移

- D1 用于关系型数据、约束、索引、查询和需要事务边界的业务事实。
- 迁移文件必须进入版本控制，并保持顺序、幂等预期和回滚/前滚策略清晰。
- 本地、preview/staging、production 的迁移状态分别核对；本地成功不能证明远端已应用。
- 部署前记录待应用迁移、目标数据库和备份/恢复策略。
- 生产迁移后核对迁移列表、关键 schema、读路径与受控写路径。
- 对可能破坏兼容性的 schema 变更使用扩展—迁移—收缩或等价的分阶段方法，避免新 Worker 与旧 schema 短暂不兼容。

完成门禁：目标环境迁移状态与预期一致，应用通过 binding 完成真实查询和受控写入，错误路径不会回退到错误环境或静默丢数据。

## 6. R2 对象与上传

- R2 保存文件、图片、导出物和用户上传；对象键、所有权、content type、大小和业务状态通常记录在 D1。
- 明确上传方式（Worker 代理或受限签名 URL）、对象大小、content type 白名单、权限、配额、生命周期和删除策略。
- 私有对象不得仅依靠难猜 URL；下载路径必须验证授权。
- 上传完成后从实际读取路径核对字节、content type、缓存头和访问控制。
- 对失败、重复上传、超限、恶意类型和孤儿对象制定处置策略。

完成门禁：在目标环境完成真实上传和读取；未授权读取失败；元数据与对象一致；清理或保留策略可执行。

## 7. KV、Queues、Workflows 与 Durable Objects

### KV

只用于允许最终一致性的缓存、派生结果、功能开关和低频配置。必须定义 source of truth、缓存键、TTL、主动失效和未命中回退。验证既包括命中，也包括变更后的失效传播。

### Queues

用于把请求路径与后台工作解耦。消息需携带稳定 ID，消费者必须幂等，并定义重试上限、不可重试错误和死信/人工处理。验收要观察真实消息从生产到消费，而不是只直接调用消费者函数。

### Workflows

用于需要多步骤、等待、重试和恢复的长流程。每一步记录可重复执行边界，外部副作用使用幂等键。验收覆盖步骤失败、恢复和最终状态。

### Durable Objects

用于按实体协调的强一致状态或序列化处理。明确对象 ID 的生成规则、持久化内容、并发模型和迁移。验收需制造并发请求，观察冲突处理与恢复，而不是只测单请求。

## 8. 环境隔离

至少区分开发/preview、staging（若项目需要）和 production：

- 使用独立 D1 数据库、R2 bucket、KV namespace、Queue、Workflow、Durable Object 配置及 secret 值。
- binding 名可以一致，但底层资源 ID 必须属于目标环境；共享资源必须有记录充分的业务理由。
- production 数据不得复制到低环境，除非经过授权、最小化和脱敏。
- preview/staging 支付只能使用测试模式资源；production 使用 live 资源，并以目标环境凭证核验。
- custom domain、workers.dev、回调 URL、CORS、canonical 和 sitemap 必须与环境一致。
- `.rankup/infrastructure.md` 记录非敏感映射，`.rankup/secrets.md` 只记录 secret 元数据。

部署前门禁：

1. 精确目标环境和 Git SHA 已确认。
2. binding 名称和底层资源映射已核对。
3. D1 待执行迁移已核对并有恢复方案。
4. secrets 均存在于目标环境，但输出不包含真实值。
5. 回滚部署或前滚修复路径已记录。

## 8.5 接入域名 · 8.6 品牌邮箱（已下沉）

§8.5「接入域名：把 zone 加进 Cloudflare」（含域名绑定到 Workers 全 API 流程、AI 爬虫 Bot Management 四字段）与 §8.6「品牌邮箱：Cloudflare Email Routing」（含 SPF / DKIM / DMARC）全文见 [`cloudflare/domain-email.md`](cloudflare/domain-email.md)。

## 8.7 Cloudflare 的 AI 爬虫阻止（边缘拦截与 robots.txt）

Cloudflare 的 Bot Management 拦截与托管 robots.txt 是不同层。新 zone 接入时相关开关可能默认开启；robots.txt 放行仍可能让 AI UA 在边缘得到 403。【实测 2026-09-28】

两层设置分别核对：

| 开关 | 位置 | 含义 | 应设为 |
|---|---|---|---|
| Block AI Bots | Security → Bots → Bot Protection | `ai_bots_protection=block` 可在边缘直接给 AI UA 返回 403 | `ai_bots_protection=disabled`；另将 `ai_training`、`ai_search`、`ai_user` 设为 `disabled` |
| 托管 robots.txt | Security → Bots → Managed Content Protection | 可追加 Managed Content 与 Content Signals | 禁用 AI 禁止规则和 `ai-train=no`，保留站点自己的放行规则 |

托管 robots.txt 禁用后，确认没有 `# Cloudflare Managed Content` 和 `Content-Signal: ai-train=no`；Bot Management 四字段按 §8.5 通过 API 关闭并回读。最后用 `ai-crawler-access.mjs` 实测，任何层的 403 都不能算通过。

## 8.8 基础安全：主动补齐，按用途取舍

本节属于段 5 上站后的检查优化：**绑定正式域名并可访问后、上线验收前主动完成**；已上线站在 review 时补查。开发阶段先做好代码输入与接口边界，不要求未绑定域名就配置 DNS / HTTPS。用户只要求基础加固时，以这些适用项为范围，不扩成全面安全审计。先读线上响应、现有规则与实际路由，复用项目共享入口和平台能力，不为基础配置增加依赖。

| 项目 | 默认处理与边界 |
|---|---|
| HTTPS | 按 §8.5 收敛 HTTP / www 到规范 HTTPS，保留路径与查询参数；检查证书有效、无循环，不叠加已有重定向 |
| 类型与来源信息 | 补 `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`；已有更严格且兼容业务的策略保留，先纠正脚本、样式与 API 的 Content-Type |
| 页面嵌入 | 先确认工具是否供其他网站 iframe 嵌入。无跨站嵌入需求才设 `X-Frame-Options: SAMEORIGIN`；需要指定外域时按真实来源配置 CSP `frame-ancestors`，不加冲突的 X-Frame-Options |
| CSP | 保留并核验已有策略；新增时盘点内联脚本、分析、支付、登录与资源域，必要时先 Report-Only。不要为了评分批量套严格 CSP，也不拿放开所有来源冒充有效防护 |
| HSTS | 确认目标主机 HTTPS 稳定后，新增先用短 `max-age`（如 86400）观察；不默认加 `includeSubDomains` / `preload`，不降级已有有效策略。扩展前核对所有子域，回滚须经 HTTPS 下发 `max-age=0`，浏览器已缓存策略不会因删除服务器配置立即失效 |
| 实际 API | 沿共享处理入口核对参数、请求体/上传大小、外部请求超时、对象权限与必要鉴权；URL 抓取还要核对协议、目标及重定向后的地址范围。耗资源接口复用已有服务端限流/额度，按真实入口设阈值；不能把进程内计数当分布式硬限额，不能只信客户端或 Content-Length |
| AI 爬虫 | 不得为了安全开启 Security → Bots 的 **Block AI Bots**；不得用 Bot Fight Mode 或 WAF 拦截 AI 爬虫；托管 robots.txt 不得设置 `Content-Signal: ai-train=no`。按 §8.5 关闭 Bot Management 四字段，再按 [`checklists.md`](checklists.md) 段 5 逐 UA 实测 |
| 账号与凭据 | 可读时核对管理账号双重验证、令牌用途与最小权限；无法读取就注明未核验，不输出秘密，不自行轮换或撤销正在使用的凭据 |

纯前端工具无需为了这轮加验证码；不批量启用攻击模式、全站挑战、国家封禁、封爬虫或复杂 WAF。已发现的真实高风险缺口如无法小改修复，单列证据与影响，不能标成已安全。

**配置与验收顺序**：

1. CLI 支持则用 CLI，否则用官方 API；执行前查当前官方文档与可用权限。按需要精确设置响应头，不为了少一次调用启用捆绑多种响应头的托管开关；启用前核清全部效果，避免夹带不需要的旧机制。复用已有响应头中间件、静态资产 `_headers` 或 Cloudflare Response Header Transform Rules 中实际覆盖目标请求的一处。`_headers` 只覆盖静态资产响应，不能代表 Worker 动态 HTML / API 已覆盖。
2. 先保存现有配置与规则 ID，限定本次主机/路径；能改单条就改单条，必须更新规则集时先读取、合并并保留其他规则与顺序，发现并发变更则重读，不用整表覆盖模板。只填缺项，不削弱已有策略；权限不足时不改用范围更大的凭据绕过。
3. 本地验证本次逻辑，发布后以真实生产 **GET** 回读首页、代表内页、关键 JS/CSS 与适用 API 的状态、响应头和 Content-Type；抽查正常业务与本次新增拒绝路径，涉及嵌入/登录/支付等策略时做相应浏览器回归。兼查正常缓存请求与新版本证据，不把 API 成功或控制台开关当生效。
4. 在 `.rankup/audit.md` / `.rankup/infrastructure.md` 留本次范围、变更前后、规则 ID 或部署版本、验证时间、适用/不适用依据及精确回滚方法；应用代码发布另记 `.rankup/releases.md`。失败先回滚本次改动并复核，不撤销他人规则；未验证项单列，不宣称全面安全。

官方参考：[响应头规则](https://developers.cloudflare.com/rules/transform/response-header-modification/)、[静态资产响应头](https://developers.cloudflare.com/workers/static-assets/headers/)、[HSTS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/)。

## 9. 部署（已下沉）

§9「部署」（Cloudflare 原生 Git 集成、Workers Builds、模板与坑）全文见 [`cloudflare/deploy.md`](cloudflare/deploy.md)。

## 10. Live verification：真实线上验证

发布后的完成标准是从真实服务面验证预期结果。按项目适用范围执行：

### 部署与域名

- 核对 Cloudflare 返回的部署/版本状态与预期 Git SHA。
- 请求 workers.dev 和/或真实 custom domain，确认 DNS、TLS、路由和实际服务版本。
- 用版本标识、响应头、ETag、内容哈希或独特页面内容排除旧边缘缓存。

### SSR 与静态资源

- 获取原始响应并确认 HTML 已包含预期服务端内容、canonical、语言、robots 和关键元数据。
- 请求关键 JS/CSS/图片资源，核对状态、content type 和缓存策略。
- 用真实浏览器验证水合、关键交互、错误控制台和移动端路径。

### API 与 bindings

- 验证关键 API 的成功、输入错误、未授权和供应商失败路径。
- 通过应用 API 或受控诊断路径验证生产 D1 读写，而不是只查询本地数据库。
- 在 R2 执行受控上传、读取和权限测试，并清理测试对象。
- 对 KV 检查命中/失效；对 Queues/Workflows 检查异步最终结果；对 Durable Objects 检查需要的一致性行为。

### 鉴权与支付

- 验证登录、登出、会话过期、权限拒绝和回调 URL。
- 支付场景必须从 production API 创建真实目标模式的 Checkout/Payment 流程，并核对 live/test 模式、金额、币种、周期、签名 webhook、幂等和失败处理。
- 未获授权时不产生真实扣款；可以使用供应商批准的生产验证方式或停在明确的授权门禁。

### 观测与回滚

- 检查 Worker 日志、错误率、关键延迟和外部集成失败。
- 在 `.rankup/releases.md` 记录部署 ID、Git SHA、环境、时间、验证项目、结果、已知风险和回滚命令/目标。
- 若关键检查失败，停止扩大流量，执行已批准的回滚或前滚修复，并重新完成整套相关验证。

### 线上完成门禁

只有同时满足以下条件才可宣布上线完成：

1. Cloudflare 部署状态关联到预期提交或版本。
2. 真实域名返回预期 SSR HTML 和静态资源。
3. 关键 API 与所有实际使用的 bindings 在目标环境通过验证。
4. 上传、鉴权、支付回调等适用路径通过端到端验证。
5. 监控没有出现阻断性错误。
6. 部署证据和可执行的回滚信息已写入 `.rankup/releases.md`。

构建成功、测试环境通过、Worker 上传成功、控制台显示 Ready 或健康检查 `200` 都不能单独满足此门禁。

## 11. 已验证的部署陷阱(2026-08 回流)

- **Worker 部署下,仓库根的 `_redirects` 完全不生效**:那是 Cloudflare Pages 的约定,Worker 只跑你的入口代码,没有任何东西会去读它。站点从 Pages 迁到 Worker 后,这类文件会安静地留在仓库里,让人以为重定向还在工作——实测表现为一批 404 长期被误判成"搜索引擎还没重爬"。重定向规则必须写进 Worker 入口的路由函数;迁移后要 grep 并删掉 `_redirects`、`functions/` 等 Pages 时代的残留,否则它们会持续误导后来者。
- **自定义 Worker 入口必须在 `wrangler.jsonc` 里声明 `main`**,否则 Cloudflare Vite 插件会打包它自己的默认入口:dev 下一切正常,线上 Worker 却不含你的任何逻辑。判据是**同一路径在 dev 与 `wrangler preview` 下状态码不一致**——出现这个差异就先查 `main`,别去调业务代码。
- **`pnpm deploy` 会被 pnpm 的内置子命令吞掉**:它是 pnpm 自己的命令(把包部署到目录),不会执行你 `package.json` 里的 `deploy` 脚本,而且**返回成功**——于是什么都没发布却一片绿。必须写成 `pnpm --filter <包名> run deploy`。凡是脚本名与包管理器内置命令同名(`deploy`、`pack`、`link`、`add`),都要显式加 `run`。
- **上传成功不等于流量已经切过去**:新版本存在与旧响应仍在服务可以同时为真。判据只有一个——请求真实域名并断言响应内容里含本次的标识,`wrangler` 的输出不算。另外,OAuth 登录拿到的 wrangler 凭据**没有清缓存的权限**,边缘缓存到期前你无法强制刷新;对无哈希文件名的直连资产,这意味着"改完要等",不是"部署失败"。
- **静态资产托管的默认 `Cache-Control` 可能是 `max-age=0, must-revalidate`,连内容哈希产物也一样**:构建工具产出的 `index-<hash>.js` 本该永久缓存——哈希文件名的全部意义就是内容变了 URL 就变——但托管层的默认值会把浏览器缓存整个关掉。后果不是变慢一点:回访用户为**每一个**子资源发一条条件请求、各付一个往返,尽管服务器全部回 304(实测一个静态站的单页受影响子资源 13–21 个)。修法是在资产目录里放 `_headers`(Workers 静态资产原生支持,构建时要被拷进产物目录),哈希产物给 `max-age=31536000, immutable`,**非哈希产物只给有限 `max-age`、不加 `immutable`**——脚本生成的图片、字体会被同名重生成,`immutable` 会让老访客长期拿不到新版。HTML 保持 `max-age=0, must-revalidate` 是**正确**的,不要顺手一起改。
- **`cf-cache-status: HIT` 不能证明浏览器缓存生效**:它证明的是边缘缓存住了,省的是"边缘到源"那一段;`Cache-Control` 管的是"浏览器到边缘",而回访用户的耗时几乎全在后一段。这两层被混为一谈时的典型表现是"看到 HIT 就认为缓存没问题",而实际每次访问都在重新走网络。
- **验证响应头要识别实际缓存与生效层**：改完 `_headers` 可能仍读到旧缓存；随机查询参数仅在缓存键包含该参数时才可能避开旧副本，不能保证重新回源。先看实际 Cache Rules、Worker 缓存键与响应头处理层，再用部署版本、资源哈希、响应内容及可用的缓存状态交叉核实；同时验证正常 URL，不能只验证带参数的请求。必要时精确刷新受影响缓存，不盲目清空全站。按 §8.8 对每类目标 URL 分别回读，其他路径生效不能代表本路径。

## 12. 匿名页面 HTML 边缘缓存（Cache API）

**Worker 响应带 `Cache-Control` 不会自动进 Cloudflare 边缘缓存**——那条头只管浏览器，`cf-cache-status` 对 Worker 直出的响应根本不出现。要真正命中边缘，必须在 Worker 代码里手动读写 `caches.default`（`match` / `put`）。两个已上线的 TanStack Start + Workers 站漏了这一步：HTML 每次请求都冷启动加现场 SSR，不同地区节点测 PageSpeed，TTFB 差 1 秒以上，LCP 从 1.7s 拉到 4.7s。**匿名页面 HTML 几乎 100% 可命中，不做就是白丢这段延迟。**

**适用范围**：GET、无 `Cookie` / `Authorization`、非搜索结果页、非个性化内容——首页、分类/列表页、内页、说明/法律页，以及 `sitemap.xml`、`robots.txt`、`llms.txt`。**排除**：POST、带会话态、A/B 分支、后台/管理页。

**模板要点**（TanStack Start 的请求中间件位置，一般在 `src/start.ts` 附近）：

```ts
// 伪码，落地时按项目实际中间件签名调整
const cacheKey = new Request(
  normalizeUrl(request.url) + `?_v=${BUILD_ID}&_a=${normalizeAccept(request.headers.get("accept"))}`,
  request
);
const cache = caches.default;

const cached = await cache.match(cacheKey);
if (cached) return withHeader(cached, "x-edge-cache", "HIT");

const response = await renderSSR(request);
if (isCacheable(request, response)) {
  const toStore = response.clone();
  toStore.headers.set(
    "Cache-Control",
    "public, max-age=0, s-maxage=600, stale-while-revalidate=86400"
  );
  ctx.waitUntil(cache.put(cacheKey, toStore));
}
return withHeader(response, "x-edge-cache", "MISS");
```

- **缓存键**：URL + 归一化后的 `Accept`（HTML 与 `text/markdown` 分开缓存，和 `Vary: Accept` 保持一致）+ 构建 id（`import.meta.env` 在构建期注入 git sha，新部署自动失效，不用手动清缓存）。
- **默认 `Cache-Control`**：`public, max-age=0, s-maxage=600, stale-while-revalidate=86400`，项目可按流量调整 `s-maxage`。
- **写入用 `ctx.waitUntil`**，不阻塞响应返回。
- **4xx/5xx 一律不缓存**；带 `Set-Cookie` 的响应绝不 `put`。
- **`Vary` 头照常保留**，不因为加了 Cache API 就删。
- 用自定义响应头 `x-edge-cache: HIT|MISS` 做证据——Worker 直出的响应上没有 `cf-cache-status` 可看。

**验证**：

1. 本机 `curl -o /dev/null -s -w 'ttfb %{time_starttransfer}\n' <url>` 连跑两次，第二次响应带 `x-edge-cache: HIT` 且 TTFB 明显下降。
2. 不同出口验证：`curl --resolve <domain>:443:<另一节点IP>` 或用不同地区的代理/沙箱再测一遍，确认不是单一地区的偶然结果。
3. 部署新版本后，第一个请求应是 `x-edge-cache: MISS` 且内容是新版本——用「10. Live verification」里「用版本标识排除旧边缘缓存」的同一套判据核实缓存没有把旧版本焐住。

**坑**：

- **Early Hints 只对可缓存的响应生效**，没做边缘缓存之前配 Early Hints 是空转，先做这条再谈 Early Hints。
- **`caches.default` 在 `wrangler dev` 本地只是内存模拟**，不是真实边缘行为，验收必须在线上做，本地跑通不算数。
- 带 `Set-Cookie` 的响应绝不能 `put` 进缓存——那是把一个用户的会话种给所有访问者。
