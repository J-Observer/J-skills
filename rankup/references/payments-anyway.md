# Anyway 支付接入（2026-09-29 核对）

## 选型

Anyway 官方将 Business 定义为 Merchant of Record（MoR）：对其覆盖的交易计算、收取和申报适用的 sales tax / VAT / GST，并提供支付链接、托管结账、订单与净额结算。[Anyway Business](https://anyway.sh/)（2026-09-29 访问）。直接使用 Stripe Payments 时，商家仍是销售主体；税务处理须按自己的模式配置。[Anyway 的 MoR 与支付处理商对比](https://anyway.sh/blog/merchant-of-record-vs-payment-processor)（2026-09-29 访问）。

- 需要服务商承担其覆盖交易的间接税处理、接受跳转式托管结账时，可评估 Anyway。商户审核、覆盖地区、付款方式及结算资格应按目标账户当前状态核验。
- 需要自己管理销售主体与支付流程时，可评估 Stripe 直连；PayPal 仍是另一可选通道，见 [`monetization.md`](monetization.md)。
- 【猜测】将 Anyway 作为独立备份，可能降低单一支付账户故障对收入的影响；两个通道是否真正独立，须用账户审核、目标地区付款及结算结果验证。

[Merchant API 订单读取文档](https://docs.anyway.sh/fetch-order-361860806e0)列出 `GET /v1/orders/{orderId}`；同站 [Webhook 文档](https://docs.anyway.sh/webhooks-7536990m0)描述支付事件。下述后台 UI、JWT 和 webhook 签名形状来自 2026-09-07 的单次 stg 实测，接入时仍要对照当前后台和真实样本，不能把旧观察当所有环境的保证。该实测的支付链接跳往 Stripe 托管结账页。

## 接入顺序

1. 申请商户并完成审核，核对目标地区、币种与支付方式。
2. 在 stg 后台建商品和支付链接，记录项目侧配置。`create-product.mjs` 提交表单会创建商品，先核对参数；生产切换另作发布。
3. 建立 webhook 端点：先运行 `create-webhook.mjs` dry-run 查看表单，实际创建时再传 `--commit`。
4. 在 Worker 接入 [`anyway-verify.ts`](../scripts/anyway/worker/anyway-verify.ts)：checkout-return 的 `sig` 按 EdDSA JWT 验签并检查 `iss/aud/sub/exp/status`；webhook 用原始 body 与 Ed25519 JWKS 验签；发货前通过 Merchant API 读取订单复核状态、商品、金额和币种。签名公钥按环境隔离缓存，失败时刷新一次。
5. 用 stg 测试卡跑支付链接 → 回跳 → webhook → Merchant API 订单复核。将订单、回调和交付证据留在项目侧。
6. 生产环境使用独立 API key、后台商品、支付链接和 webhook；完成真实目标流程后才切换用户入口。

跳转式结账若页面有必须保留的本地数据（例如用户上传的照片），付款前暂存 IndexedDB；返回后根据已核实的订单恢复使用，并在完成后删除。该模式由项目决定具体存储期限和清理时机。

## 脚本

路径均相对 rankup Skill 根目录。`--env stg|prod` 优先于 `ANYWAY_ENV`，默认 stg。推荐将 `ANYWAY_STG_API_KEY` / `ANYWAY_API_KEY` 配在 Skill 根目录 `.env`（已被 `.gitignore` 忽略），配置一次后所有项目都无需传 `--env-file`。API key 查找顺序：进程环境变量 → Skill 根目录 `.env` → `--env-file <项目侧路径>`；环境之间不互借 key。OpenCLI 会话默认 `anyway-dashboard` 或 `anyway-paytest`，调用后关闭会话。

```bash
node scripts/anyway/anyway.mjs --env stg me
node scripts/anyway/anyway.mjs --env stg products list
node scripts/anyway/scripts/create-product.mjs --env stg --name <商品名> --description <描述> --price <金额> --currency USD --success-url <返回地址>
node scripts/anyway/scripts/create-webhook.mjs --env stg --url https://example.com/hook
node scripts/anyway/scripts/create-webhook.mjs --env stg --url <端点> --events "订单已付款" --commit
node scripts/anyway/scripts/stg/webhook-capture.mjs --evidence-dir <项目侧证据目录>
node scripts/anyway/scripts/stg/pay-test.mjs --env stg --link <stg支付链接> --ref <项目侧引用> --email <测试邮箱> --evidence-dir <项目侧证据目录>
```

`anyway.mjs help` 列出只读查询和 webhook 验签命令。`create-product.mjs`、`create-webhook.mjs` 可用 `--env prod` 指向生产后台；前者支持 `--dry-run` 只预览参数、`--type subscription` 创建月付订阅（默认一次性），不传 `--dry-run` 会实际创建商品，后者只有 `--commit` 才提交。`pay-test.mjs` 在 stg 自动提交测试卡；`--env prod` 指向生产支付链接，卡号、有效期和 CVC 只从进程环境变量 `ANYWAY_CARD_NUMBER`、`ANYWAY_CARD_EXPIRY`、`ANYWAY_CARD_CVC` 读取。生产付款会产生真实交易，须由项目发布流程决定是否执行；本次只验证 stg 的只读命令和 dry-run。

## 已知坑（2026-09-07 stg 单次实测）

- 商品表单没有 cancel URL 字段；提交会创建并发布商品及支付链接。支付链接是跳转式，不在原页面内嵌卡表单。
- webhook 创建/编辑 UI 不展示 signing secret；实测使用组织级 Ed25519 JWKS。stg 公钥地址已写入环境表；验签必须使用捕获的原始请求体。
- 一次测试付款仅观察到 `order.paid` 投递；未见中间态事件。这是观察结果，不能据此排除其他事件在别的流程出现。
- 临时隧道在部分网络里默认 QUIC 会卡住；实测 `cloudflared tunnel --protocol http2 --url http://127.0.0.1:<port>` 可注册。若本机代理拦截 trycloudflare 的 TLS，不能只凭本机请求失败断定 webhook 不可达，应以项目侧 evidence 文件和端点接收记录判定。
- Merchant API 订单响应的商品字段为平铺 `productId`，不能按 webhook payload 的嵌套 `product.id` 解析。结账页的字段和币种切换可能改变，运行前核对当前页面。
