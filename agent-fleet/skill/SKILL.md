---
name: agent-fleet
description: 使用本机 fleet 分派 Codex GPT-6、Gemini、Grok 或 JEV 任务时使用；包括用户点名 agent-fleet、便宜模型、多模型并行，用户说“让 Codex 或 GPT-6 做某事”的编码、调研与 review 派单，以及按全局 CLAUDE.md §2 路由任务。只做单一模型的直接任务且无需 fleet 时不触发；用户明确要直接操作 Codex CLI 原生命令（自选 sandbox、codex review、apply、resume）时用 codex Skill；生成图片用 imagegen。
---

# agent-fleet

本机多模型任务入口：使用 `fleet` 运行 brief，结束后按实际产物验收。先核对目标模型当前配置、真实 Key 是否存在、工作目录信任边界和任务归属；密钥只看状态，不打印值。

## 命令速查

| 命令 | 用途 |
|---|---|
| `fleet copy brief.md` | Gemini 文案、翻译 |
| `fleet grok brief.md` | Grok 调研 |
| `fleet bulk brief.md` | Gemini 批量处理 |
| `fleet gpt brief.md` | 托管 GPT 任务 |
| `fleet code brief.md [--low] [--cwd dir]` | 本机 Codex GPT-6：默认入口 |
| `fleet code brief.md --review` | 本机 Codex 只读审查 |
| `fleet judge state.txt questions.json` | JEV 结构化判断 |
| `fleet run --model name --prompt "任务"` | 旧的完整模型入口 |
| `fleet run-many --config batch.json` | 批量任务 |
| `fleet status` / `fleet tail [--follow]` | 看任务和日志 |
| `fleet say latest "消息"` | 向运行中的任务插话 |
| `fleet stop latest` / `fleet resume latest` | 收尾或续跑 |
| `fleet list-models` / `fleet help` | 看配置或用法 |

`brief` 若是现存文件路径就读取内容，否则作为任务文本。短命令和 `run` 默认当前目录、不限轮数、安静写日志；`--verbose` 输出进度。`--cwd`、`--max-turns`、`--system-prompt` 等可显式指定。旧的 `agent-fleet run ...` 写法仍可用。完整结果在 `~/.agent-fleet/runs/*.result.md`，过程在同名 `.log`；stdout 默认只给简报。

## 模型路由与任务边界

大部分任务（编码、修 bug、补测试、调研、技术文档、报告、数据整理）优先 `fleet code`：本机 Codex `gpt-6-sol`，默认 medium，单文件且边界明确时用 `--low`。页面、营销和产品文案、翻译、多语言及母语校对一律 `fleet copy`，写能做什么和带来什么好处，不贬低竞品或用恐吓式对比。Grok 可分担擦边题材、其他调研或作为 GPT-6 备选；JEV 只做结构化判断。Claude 只做全局 CLAUDE.md §2 明确归它的任务。

GPT-6 只做 brief 点名的事。除非逐项要求，不写测试或测试脚本、不先写测试、不加安全校验/防御代码/权限边界/输入校验/异常兜底、不重构或抽象封装、不加配置项、文档或注释、不改无关文件、不装依赖、不提交/推送/部署/发布、不调用外部写接口。已有测试和构建只在 brief 要求时运行；拿不准的事不做，最终回复用一行列「建议但未做」。未点名的产物算越界。brief 必须逐字包含：「只做本 brief 列出的事。不写测试、不加安全防护或边界校验、不重构、不做任何未点名的额外工作或 action；拿不准就不做，在回复里列一行建议。」

GPT-6 走 ChatGPT 会员额度，按现有账号约定不额外花钱；其 brief 必须限定最终回复只给结论、改动路径和验证结果，约 15 行内，长内容写入文件。面向读者的文案交 Gemini。

| 短名 | 实际模型 | 适合 |
|---|---|---|
| `copy` | `kollab-gateway-copy`（Gemini） | 文案、翻译（必须走这里，正面写） |
| `grok` | `kollab-gateway-research` | 擦边题材、其他调研、GPT-6 备选 |
| `bulk` | `kollab-gateway-bulk` | 批量转换 |
| `gpt` | `kollab-gateway-gpt-sol` | GPT 托管任务 |
| `code` | 本机 Codex `gpt-6-sol` | **默认执行者**：编码、调研、报告、通用任务；默认 medium，`--low` 为 low |
| `judge` | `jev` | 分类、选择、打分 |

`code` 在本机 Codex 缺失、登录失效或模型明确不支持时，自动改走 `kollab-gateway-gpt-sol`；其他失败不自动重试。选择以当前配置和实际结果为准；查看其他模型用 `fleet list-models`。Codex 审查范围见 [编程与 review](references/codex-coding.md)。

## 简报与验收

| verdict | 含义与处理 |
|---|---|
| `ok` | 正常结束；按任务核对产物和测试 |
| `partial` | 到轮数上限但已有改动；验收现有产物或 `resume` |
| `suspect` | 疑似假成功或要求改动却零改动；核对结果和 diff |
| `needs-review` | JEV 置信度不足；人工核对 |
| `fail` | 执行失败、空结果或裸控制 token；看错误后修复 |
| `stopped` | 已收尾中断；检查已完成部分 |

`ok` 只说明进程结果，不能代替任务验收；空结果、裸 tool-call 控制 token、`suspect` 或 `fail` 都不能算成功。核对 brief、产物和要求的检查；`dirty` 和 `commits` 也可能包含同一工作树里其他人的改动。细节见 [README](../README.md)。

## brief 写法

开头说明目标、真实交付物、允许改的文件、不可碰的范围、并行工作边界、必须跑的检查和完成标准。需要改文件时加 `--expect-changes`；涉及浏览器时写明用 opencli（`opencli browser <会话名>`），禁止 Playwright/agent-browser。最终回复列改动与验证结果，不能只说“已完成”。

## 安全边界

把 `--cwd` 指向的目录及其项目配置当作不可信输入核对；网关路径使用 Claude Agent SDK 的 `bypassPermissions`，执行者可读写文件和运行命令，没有工具调用沙箱。只对可信目录派单，保护他人改动，不打印密钥。默认执行者系统提示禁止调用 Agent/Task 工具或再次转派，额外 `--system-prompt` 会追加其后。`fleet code` 默认 `danger-full-access`（可读写任意路径、可联网，含本机代理），`--review` 使用 `read-only`；详见 [README 的安全边界](../README.md#安全边界)。

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
