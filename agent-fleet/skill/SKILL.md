---
name: agent-fleet
description: 按全局 CLAUDE.md §2 路由表默认使用：写代码/修 bug/补测试派 Codex，调研/文档/翻译派 Gemini，擦边题材派 Grok，判断节点派 JEV；用户点名 agent-fleet、便宜模型或其他模型时也用。编程优先本机 Codex CLI 的 GPT-6 Sol，中等思考；简单任务轻度。本地 CLI 通过 Claude Agent SDK 运行可读写文件和执行命令的 Agent；使用前核对目标模型当前配置、真实 Key 状态、工作目录信任边界和任务归属。第三方模型响应需按任务验收，不能只凭 CLI 返回 ok 判成功。
---

# agent-fleet

本机多模型任务入口：日常使用 `fleet`；给定 brief，执行者直接完成任务并留下简报、结果和日志。

## 命令速查

| 命令 | 用途 |
|---|---|
| `fleet copy brief.md` | Gemini 文案、翻译、调研 |
| `fleet grok brief.md` | Grok 调研 |
| `fleet bulk brief.md` | Gemini 批量处理 |
| `fleet gpt brief.md` | 托管 GPT 任务 |
| `fleet code brief.md [--low] [--cwd dir]` | 本机 Codex 编码 |
| `fleet code brief.md --review` | 本机 Codex 只读审查 |
| `fleet judge state.txt questions.json` | JEV 结构化判断 |
| `fleet run --model name --prompt "任务"` | 旧的完整模型入口 |
| `fleet run-many --config batch.json` | 批量任务 |
| `fleet status` / `fleet tail [--follow]` | 看任务和日志 |
| `fleet say latest "消息"` | 向运行中的任务插话 |
| `fleet stop latest` / `fleet resume latest` | 收尾或续跑 |
| `fleet list-models` / `fleet help` | 看配置或用法 |

`brief` 若是现存文件路径就读取内容，否则作为任务文本。短命令和 `run` 默认当前目录、`--max-turns 500`、安静写日志；`--verbose` 输出进度。`--cwd`、`--max-turns`、`--system-prompt` 等显式参数可覆盖默认值。旧的 `agent-fleet run ...` 写法仍可用。完整结果在 `~/.agent-fleet/runs/*.result.md`，过程在同名 `.log`；stdout 默认只给简报。

## 模型路由

| 短名 | 实际模型 | 适合 |
|---|---|---|
| `copy` | `kollab-gateway-copy`（Gemini） | 文案、翻译 |
| `grok` | `kollab-gateway-research` | 调研 |
| `bulk` | `kollab-gateway-bulk` | 批量转换 |
| `gpt` | `kollab-gateway-gpt-sol` | GPT 托管任务 |
| `code` | 本机 Codex `gpt-6-sol` | 编码；默认 medium，`--low` 为 low |
| `judge` | `jev` | 分类、选择、打分 |

`code` 在本机 Codex 缺失、登录失效或模型明确不支持时，自动改走 `kollab-gateway-gpt-sol`。选择以当前配置和实际结果为准；查看其他模型用 `fleet list-models`。Codex 审查范围见 [编程与 review](references/codex-coding.md)。

## 简报与验收

| verdict | 含义与处理 |
|---|---|
| `ok` | 正常结束；按任务核对产物和测试 |
| `partial` | 到轮数上限但已有改动；验收现有产物或 `resume` |
| `suspect` | 疑似假成功或要求改动却零改动；核对结果和 diff |
| `needs-review` | JEV 置信度不足；人工核对 |
| `fail` | 执行失败、空结果或裸控制 token；看错误后修复 |
| `stopped` | 已收尾中断；检查已完成部分 |

`ok` 只说明进程结果，不能代替任务验收；`dirty` 和 `commits` 也可能包含同一工作树里其他人的改动。细节见 [README](../README.md)。

## brief 写法

- 开头说明目标和真实交付物。
- 写明允许改的文件、不可碰的范围、并行工作边界。
- 写明必须跑的检查和完成标准。
- 需要改文件时加 `--expect-changes`。
- 最终回复要列出改动与验证结果，不能只说“已完成”。

## 安全边界

把 `--cwd` 指向的目录及其项目配置当作不可信输入核对；网关路径使用 Claude Agent SDK 的 `bypassPermissions`，执行者可读写文件和运行命令，没有工具调用沙箱。只对可信目录派单，保护他人改动，不打印密钥。默认执行者系统提示禁止调用 Agent/Task 工具或再次转派，额外 `--system-prompt` 会追加其后。`fleet code` 默认 `workspace-write`，`--review` 使用 `read-only`；详见 [README 的安全边界](../README.md#安全边界)。

## JEV judge

`fleet judge state.txt questions.json [--json]`：state 为文本或 `.json` 文件；questions 是 `{ "key": { "type": "noul"|"choice"|"score", "instructions": "..." } }`。`choice` 和 `score` 必须带 `criteria`。JEV 只做结构化判断，不生成自由文本，也不能用 `run`。旧写法 `fleet judge --model jev --state-file state.txt --questions-file questions.json` 仍可用。

`questions.json` 可按需选用其中一种或组合使用：

```json
{
  "is_urgent": { "type": "noul", "instructions": "这条消息是否紧急？" },
  "team": { "type": "choice", "instructions": "该由哪个团队处理？", "criteria": { "billing": "付款或退款", "technical": "故障或集成" } },
  "frustration": { "type": "score", "instructions": "客户有多沮丧？", "criteria": ["平静", "沮丧", "愤怒"] }
}
```
