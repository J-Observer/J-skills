# Kollab 模型与多模态

`fleet media list` 读取 `kollab tool list`，按 image、video、audio、vision 列出当前 tool、模型 id 和必填字段。不要记住固定 id；运行前看清单。

```bash
fleet media list
fleet media models --source openrouter --search <词>
fleet media run generate_image --model <清单中的 id> --prompt "图片描述"
fleet media run generate_video --model <清单中的 id> --prompt "视频描述" --out ./media
fleet media run vision --model <清单中的 id> --prompt "描述这张图" --input-json '{"image_refs":[{"artifact_id":"<id>"}]}'
```

`--input-json` 补充各工具的必填字段；`--model`、`--prompt` 覆盖 JSON 中同名字段。媒体文件由 `kollab tool run` 下载到 `--out`（默认 `./fleet-media/`）；无媒体文件的文字/结构化回执写到 `result.json`。终端只显示路径与状态/费用摘要。

文字 Agent 使用现有 `kollab-gateway*` 条目走 `/api/llm`，需按该条目配置的环境变量提供 standalone key。一次性文字调用用 `kollab model run --model <fleet media models 中的 id> --prompt "..."`。`KOLLAB_API_KEY` 或 `KOLLAB_STANDALONE_API_KEY` 可供 Kollab CLI 使用，已有 `kollab login` 会话也可用于 `tool run`；创建 key 用 `kollab api-key create`。需要测试环境时设置 `KOLLAB_API_URL`。普通图片生成也可用 imagegen；从 Agent 调用 Kollab 图片模型的规范入口是 `fleet media run generate_image`。
