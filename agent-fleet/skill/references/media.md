# Kollab 模型与多模态

先运行 `fleet media list`：它读取 `kollab tool list`，列出当前开放的 tool、模型 id 和必填字段。能力清单以实时输出为准，下表只列已在 TEST 验证的例子，不固定价格或完整模型表。

| 能力 | 已验证的例子 |
|---|---|
| 图片 `generate_image` / `edit_image` | `google/gemini-3.1-flash-image`（Nano Banana 2）、`gemini-nano-banana-2.1`（Nano Banana 2.1）、`google/gemini-3-pro-image`（Nano Banana Pro）、`google/gemini-2.5-flash-image`（Nano Banana）、`x-ai/grok-imagine-image-quality`（Grok Image）、`gpt-image-2` |
| 视频 | Seedance 2 / 2.5、Veo 3、Kling、Hailuo 3、Grok 视频 |
| 3D / 音频 | Tripo 3D、Grok TTS / STT |
| 文字 | `fleet media models` 查目录，`kollab model run` 一次性调用 |

```bash
fleet media list
fleet media models --source openrouter --search <词>
fleet media run generate_image --model google/gemini-3.1-flash-image --prompt "一只猫"
fleet media run edit_image --model google/gemini-3.1-flash-image --prompt "改成蓝色背景" --input-json '{"image_refs":[{"artifact_id":"<生成回执中的 UUID>"}]}'
kollab model run --model google/gemini-3.1-flash-image --prompt "一只猫" --output-dir ./media
```

`generate_image` 的 `kollab tool run` 回执中，每张图有 UUID `artifact_id`，可直接放进 `edit_image` 的 `image_refs` 链式编辑，无需手动上传。`kollab model run` 的回执在 `images[]` 中给出 `artifact_id` / `download_url`，CLI 也会打印落盘路径。用同一 request id 和相同参数重放不会重复扣费；同一 id 配不同参数返回 409 冲突。

`--input-json` 补充各工具的必填字段；`--model`、`--prompt` 覆盖 JSON 中同名字段。视频、3D、音频的具体 tool、模型 id 与参数均从 `fleet media list` 读取。`fleet media run` 通过 `kollab tool run` 下载媒体到 `--out`（默认 `./fleet-media/`）；无媒体文件的文字或结构化回执写到 `result.json`，终端只显示路径与状态、费用摘要。

认证优先用 `KOLLAB_API_KEY` 或 `KOLLAB_STANDALONE_API_KEY`（可用 `kollab api-key create` 创建），其次用进程级 `KOLLAB_API_TOKEN` 或已有 `kollab login` 会话。TEST 必须显式设置 `KOLLAB_API_URL`，不要复用生产 profile。文字 Agent 可继续按现有 `kollab-gateway*` 配置走 `/api/llm`。普通配图也可用 imagegen；从 Agent 调用 Kollab 图片模型用 `fleet media run generate_image`。

## 暂未开放

Happy Horse、豆包语音（TTS / ASR）、MiniMax 音乐尚未放行：网关侧供应商凭据待配置，或受上游账户限制。以 `fleet media list` 的实时结果判断是否已开放。
