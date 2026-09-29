# 模型与委派约定

路由与执行纪律的权威来源是 `~/.claude/CLAUDE.md` §2、§3 和 `agent-fleet` Skill；本文件只保留 autopilot 需要的要点，不再自带路由表，避免与全局规则产生第二份口径。

## Skill 与 brief

先查项目已有脚本、工具和专用 Skill；需要时再按阶段加载。缺少 Skill 时直接使用已有代码、标准工具或平台能力，不因找不到 Skill 停工。任务模板见 [`phase-library.md`](phase-library.md)。

只在多个子任务真正独立、可以清楚划分文件或资源，且委派能减少总耗时时使用子 Agent。每个 brief 写清目标、输入、归属文件、禁止触碰的范围、验收标准与输出语言。读任务可并行；共享工作树保持一个写入负责人，提交、推送和发布由一个落地负责人串行处理。子 Agent 的“完成”声明须由主代理用实际结果复核。并发和归属细节见 [`concurrency-and-landing.md`](concurrency-and-landing.md)。

## 往哪派

- 按 `agent-fleet` Skill 与全局 §2 路由：编码类默认 `fleet code`（本机 Codex `gpt-6-sol`），文案与翻译走 `fleet copy`（Gemini），Grok 分担其他调研与备选，判断节点（分类、路由、是非、打分、成败判定）走 `fleet judge`（JEV，置信度低时交回主线程）。
- Claude 只做全局路由表明确归它的事：建站设计与视觉交互、3D/游戏、复杂脚手架、深度架构、不可逆或安全敏感的改动。**Haiku 档位与 `executor-haiku` 已停用**。
- 模型档位是运行时配置，不在 Skill 里断言本机当前模型或某个版本的表现；具体模型名、命令与回退顺序以 `agent-fleet` 当前文档为准。

## 第三方失败与执行纪律

- 第三方模型返回 402、登录失效、模型被拒，或产物为空、含裸 tool-call 控制 token、verdict 为 `suspect`/`fail`（退出码 0 也不算成功）：先诊断，**最多重试一次**；仍失败就**停下并如实告知用户**，由用户决定充值或改派。**不许静默改派 Claude subagent。**
- Claude subagent **不得再派 Claude subagent**；子步骤只能分发给第三方模型或脚本。
- **不设轮数、上下文、时长或预算上限**，任务做到验收终态；用户明确设置的上限始终有效，不得自行抬高。省成本靠路由和不嵌套，不靠截断。
- 等待不轮询：第三方任务用后台启动并等完成通知；必须等待时用带退出条件和硬超时的 Monitor。
- 产出由派单方自己核验，不能因成本低省掉必要核验；若项目提供 `executor-*` 子代理，使用前核实其当前 frontmatter 与平台支持。
