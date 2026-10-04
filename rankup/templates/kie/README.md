# Kie Worker 复制包

复制这些文件到产品后端，按产品已有用户表、账本表、邮件通道对接。使用 Worker 原生 fetch/Web Crypto，D1 和 R2 类型来自项目的 Cloudflare 类型生成。每个文件只实现一个职责；架构和边界的唯一说明见 [分支入口](../../references/integrations/kie.md)。这不是可直接发布的完整站点。

| 文件 | 用途 |
|---|---|
| [kie-client.ts](kie-client.ts) | 上传、创建、查询、余额、HMAC |
| [migration.sql](migration.sql) | 示例表、唯一账本键、预算累计触发器 |
| [budget.ts](budget.ts) | D1 原子每日/总预算预留、产品积分退款 |
| [ops.ts](ops.ts) | 余额阈值、迟滞、每日告警去重 |
| [lifecycle.ts](lifecycle.ts) | webhook/cron 共用结算、R2、通知与照片清理 |
| [local-verify.mjs](local-verify.mjs) | Miniflare D1/R2 零花费验证脚手架 |

接线顺序：用户请求携带稳定幂等 job id → reserve 成功 → 原照片放私有 PHOTOS，并更新 photo_keys → Kie upload → create 一次 → 持久化 task_id/status=pending → webhook/cron 调用 settle。重复 job id 返回已有任务；reserve=false 时不调用供应商。上传已明确失败可 refund；create 连接中断或响应缺 taskId 属于提交不确定，保留 submitting，人工/供应商对账后处理，不自动退款并重发。

源图签名 URL 若使用自有 R2：只允许未过 source_expires_at 的受控下载；任务结束立刻删除。Kie file-upload 是供应商暂存，不能以本地删除宣称供应商同步物理删除。输出保留期与账号删除由产品现有机制接入；R2 下载重试可能产生孤儿对象，按 job 前缀对账清理。cron 先 monitor 再 cron；pause 仅拦新提交，已有任务继续结算。

本地验证不安装依赖：指定已安装 Wrangler 的项目 --deps-project，使用其 Miniflare/esbuild；假服务地址通过 env 注入，测试凭据仅内存里的固定假值；不改项目文件。生产 secrets 由部署通道注入，不放 vars。

```sh
node templates/kie/local-verify.mjs --deps-project /path/to/web --out /path/to/evidence.json
```

复制到产品后最小接线示例：`new KieClient(env.KIE_API_KEY)`；callback URL 是产品地址。budget/ops/HMAC 模块经过本地假服务验证；lifecycle 模块只经过打包与独立静态复核，尚未执行终态下载/通知/删除的假出站验收。生产 webhook 实际送达、具体模型字段与照片删除时限仍需项目验收。

## CLI 假服务复刻

环境需要 Node、curl、ffmpeg/ffprobe；在临时证据目录准备任意授权PNG、prompt.txt、params.json。先运行下面的本地服务（第二个终端运行CLI，结束Ctrl-C关闭）。假服务媒体可用 ffmpeg 的 color 生成，既不访问模型也不花费。

```sh
ffmpeg -v error -y -f lavfi -i color=c=orange:s=320x180:d=2 -c:v libx264 -pix_fmt yuv420p /path/to/fixture.mp4
node scripts/kie-fake-server.mjs --port 8789 --balance 1000 --cost 82 --media-file /path/to/fixture.mp4
# 默认dry-run，不读取key或发网络请求：
node scripts/kie-generate.mjs --model bytedance/seedance-2-mini --prompt-file /path/to/prompt.txt --params-file /path/to/params.json --image /path/to/input.png --image-field reference_image_urls --expected-credits 82 --budget-credits 100 --out /path/to/dry-run
# 仅本地假服务端到端：
KIE_API_KEY=local-fixture node scripts/kie-generate.mjs --model bytedance/seedance-2-mini --prompt-file /path/to/prompt.txt --params-file /path/to/params.json --image /path/to/input.png --image-field reference_image_urls --expected-credits 82 --budget-credits 100 --base-url http://localhost:8789 --upload-base-url http://localhost:8789 --poll-ms 50 --timeout-ms 5000 --out /path/to/completed --yes-spend
curl -fsS http://localhost:8789/__stats
```

params.json 示例：`{"duration":2,"resolution":"720p","aspect_ratio":"16:9"}`，仅假媒体测试；真实模型最短时长与报价见模型表，不拿这个2秒fixture请求真实Mini。`--yes-spend` 是显式提交开关，不能单凭有key就触发；真实请求前需明确授权预算。假余额/失败状态用 `POST /__control` 的 `{balance:40}` 或 `{states:["waiting","fail"]}` 注入（JSON键用双引号），计数证明新任务是否被阻断。
