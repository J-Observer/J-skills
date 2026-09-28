---
name: codex
description: "**Generate images** with Codex's built-in OpenAI image-generation tool — route every \"生成图片 / 配图 / 插图 / image gen / 画一张 / 出一套图\" request here; this is the primary use. ALSO runs Codex CLI as a background sub-agent for code analysis, refactoring, review, or an agent team working in parallel. Always runs in background; uses Codex's default model (no `-m` flag) unless the user explicitly overrides."
---

# Codex Sub-Agent Skill

Codex runs as a **background sub-agent**: you launch it, immediately return control to the user, and poll or read output only when needed. This makes it usable both as a standalone background worker and as one member of a multi-agent team.

> **This is the most-used capability of this skill on this machine.** The owner reaches
> for Codex primarily to generate images, so that section comes first. Everything below
> it — background workers, agent teams — is the same launch machinery applied to code.

## Image Generation

**Codex can generate images.** It has a built-in OpenAI image generation tool. This is a capability of the *agent*, not a CLI subcommand — there is no `codex image` / `codex gen-image` command, and `codex exec --image` is for *attaching* images as input, not producing them.

> Do not go looking through `codex --help` for an image flag, conclude "Codex has no image generation," and tell the user so. That conclusion is wrong. **Treat Codex as an agent: describe the images you want in the prompt and let it choose its own method.**

Launch it exactly like any other Codex worker — background, prompt via stdin:

```bash
cat /tmp/codex-prompt-img.md | codex exec --skip-git-repo-check \
  --config model_reasoning_effort="medium" \
  --sandbox danger-full-access \
  -C <outdir> 2>/dev/null
```

- **Sandbox:** needs `danger-full-access` (image generation hits the network). Just run it — see Error Handling; no permission prompt is required on this machine.
- **Effort:** `medium` is plenty; this is not a reasoning-heavy task.

### Writing the image prompt

Put these in the prompt file:

1. **Output directory** — create it yourself first (`mkdir -p`) and give the absolute path.
2. **One numbered item per image**, each with its exact filename and a concrete description.
3. **A shared style block** so a multi-image set stays visually consistent: illustration style, background, an explicit hex palette, and aspect/size.
4. **"No text, no logos, no watermarks"** — generated lettering is almost always garbled, and in a non-English UI it will be wrong.
5. **An explicit escape hatch:** "if you genuinely cannot generate images, say so plainly — do not substitute placeholders, ASCII art, or images downloaded from the web."
6. Ask it to report the absolute path of each file plus the method it actually used.

### After it returns

- **Look at every image with `Read` before wiring it into a deliverable.** Never ship a generated image you have not viewed.
- **Compress before committing.** Raw output runs ~1 MB per PNG. `sips -s format jpeg -s formatOptions 82 in.png --out out.jpg` typically cuts a 4 MB set to well under 1 MB. Prefer JPEG for flat illustrations with solid backgrounds; keep PNG only when transparency is required.
- Note the shell-quoting trap: a bare `for f in *.png; do ... done` loop can fail to parse in this environment — drive the loop from a short `python3` heredoc instead.
- If the images land in a themed page, remember light/dark: illustrations with bright backgrounds need dimming in dark mode, e.g. `filter: brightness(.84) saturate(.92)`.

### 一套图的验收：三道检查，缺一道就会漏掉一类问题

2026-08-22 生成 16 张角色插图时，这三道各自抓到了**不同类别**的缺陷。
只做其中一两道，就会带着问题继续往下做。

**① 接触印相（缩略图并排）** —— 抓构图失衡。

```python
# 全部缩到 120px 横向拼一张。120px 通常就是结果页/分享卡的真实尺寸
subprocess.run(['sips','-Z','120', src, '--out', thumb])
```

第一版有张图输出很漂亮，缩到 120px 只看得见一把金椅子——角色的脸、表情全糊了。
**这个缺陷在全尺寸下完全看不出来**，只有缩略图能暴露。

**② alpha 包围盒占比** —— 把"角色够不够大"从感觉变成数字。

```python
bb = Image.open(f).convert('RGBA').getchannel('A').getbbox()
frac = ((bb[2]-bb[0])*(bb[3]-bb[1])) / (im.width*im.height)
```

实测一组六张：41%、47%、49%、53%、60%、66%——要求是 75–80%，**没有一张达标，
且最大最小差 1.6 倍**。并排看只觉得"有点乱"，量完才知道差在哪、差多少。
提示词里写 "occupy 75-80% of the frame" 是不够的，**还要写明道具不计入这个比例**，
否则一个大道具就把角色挤小了。

**③ 独立盲评** —— 抓风格与规则遵从，而且**这道最容易被省掉，省掉就会出错**。

做法：把成对结果随机打乱成 `pairN-A/B`，对照表写到**项目目录之外**，
派一个没参与生成的 agent 去评，并明确告诉它「看不出差别」是可接受答案。

那天的教训很直接：跑实验的 agent 知道哪张是哪个条件，它的读数指向一个方向；
**盲评三对全部指向相反方向**，而且给出了一致的机制（多出来的道具）。
非盲的判断已经被写进结论并发出去了，是盲评把它纠正回来的。

### 图生图 / 参考图：控制点在输出端，不在输入端

**风格不受版权保护，参考图是常规做法**——设计行业管这叫 mood board。
把他人作品作为参考喂给图生图，用来传达"我要这一类的质感"，是正当且有效的。
最初这条被写成"不要用他人图做种子"，**过于保守，已由项目所有者推翻并订正**。

真正的风险区很窄：**产出与某个具体受保护角色实质相似**。
所以控制放在输出端，而不是在输入端一刀切：

1. **参考图用一组，不用一张。** 10 张以上不同来源拼成 mood board，
   模型抽取的是共性语法而不是某一个设计。单张参考最容易长得像原图。
2. **参考图只传风格，主体由我们指定。** 提示词里角色的物种、道具、姿势、
   配色全部自己写死，参考图只负责线条、上色、头身比这类质感层。
3. **出图后做相似性检查**：把产出和参考组并排看一遍，
   问"这张会被认成某个已有角色吗"。像了就重生成，改主体特征而不是改风格。
4. **提示词里仍然不要点名受版权保护的角色**（"in the style of X"）。
   参考图已经把信息传到了，点名只增加风险不增加效果。

### 描述性形容词见顶时，改用数字

"要更日式一点"这类反馈无法执行，也无法验收。把它翻译成可测量的参数：
头身比、眼径 ÷ 头宽、眼间距 ÷ 头宽、眼睛在头部的纵向位置、
线宽 ÷ 图宽（尺度无关）、描边的实际取色、量化后的独立色数、
HSV 的饱和度与明度区间、面部留白占比。

然后把参考组和自己的产出**用同一段脚本量一遍**，产出「参数 | 参考区间 | 我们的值 | 判定」
的差距表。这张表把"感觉不对"变成一份可以逐条修的清单。

### 提示词语言：一个 n=3 的观察，不是定论

同一组约束、同样的角色，分别用日语和忠实英译生成三对，独立盲评**三对全选日语版**，
机制一致——英语版每次都多加了道具（权杖、头巾、额外装饰），违反"只准一个道具"。
但客观指标里的画面占比反而是英语版更好（71.7% vs 50.5%）。

**3/3 在纯随机下概率为 1/8，达不到显著性门槛。**
候选机制是：目标语言的设计术语把约束压缩得更狠——`引き算のデザイン` 不只是一条指令，
它同时是一个风格坐标，而英语的 "design by subtraction" 只是一句话。

**结论：成本为零，可以默认用目标语言写，但不要当成定律讲。** 真正确定有效的是
把视觉约束写死、写成数字。尚未复现，样本 n=3。

## Core Principle

**Never block the main conversation on a `codex exec` call.** Always launch via `Bash` with `run_in_background: true`. The only exception is a trivial `codex --version` health check.

## Launching a Codex Sub-Agent

1. **Pick reasoning effort + sandbox** from context — do not interrupt the user with `AskUserQuestion` unless they explicitly ask to be prompted. **Do not pass `-m` / `--model`**; let Codex use its default model from `~/.codex/config.toml`. Defaults:
   - Reasoning effort: `medium` (use `high`/`xhigh` for refactors, architecture, deep analysis; `low` for trivial edits)
   - Sandbox: `read-only` unless the task clearly needs edits (`workspace-write`) or network (`danger-full-access`)
2. **Write the prompt to a temp file** when it's non-trivial (multi-line, contains quotes, long context). Pipe it via stdin so quoting never breaks:
   ```bash
   cat /tmp/codex-prompt-<tag>.md | codex exec --skip-git-repo-check \
     --config model_reasoning_effort="medium" \
     --sandbox read-only \
     -C <workdir> 2>/dev/null
   ```
3. **Launch with `run_in_background: true`**. Record the returned shell id and a short tag (e.g. `codex-review`, `codex-refactor-auth`) so you can reference it later.
4. **Report the launch to the user in one line** — e.g. "Launched Codex sub-agent `codex-review` (medium effort, read-only) in background." Then continue with other work or wait for user input. Do NOT sit and poll.
5. **Always append `2>/dev/null`** to suppress thinking tokens on stderr unless the user is debugging Codex itself.
6. **Always pass `--skip-git-repo-check`**. Put all flags between `exec` and `resume` (if resuming).

## Checking Results

- When the background shell finishes, the harness notifies you. Read its output with `BashOutput` (or `Read` on the captured log file) — do not re-run the command.
- If the user asks for status mid-run, read the current buffer once and summarize progress; don't busy-loop.
- Summarize Codex's findings in the main thread in a few sentences. Link file:line references so the user can jump directly.
- After completion, tell the user they can resume with: `codex resume <tag>` → you will run `echo "<new prompt>" | codex exec --skip-git-repo-check resume --last 2>/dev/null` (no other flags on resume; session inherits model/effort/sandbox).

## Agent Teams (Parallel Codex Workers)

Codex sub-agents compose cleanly. To run an agent team:

1. Split the task into **independent** slices (e.g. "review auth layer", "review billing layer", "draft migration", "write tests"). Dependent steps must stay sequential.
2. For each slice, write a prompt file and launch a separate background `Bash` call in the **same message** (parallel tool calls). Give each a distinct tag and, if they write, a distinct `-C` workdir or separate git worktree to avoid edit collisions.
3. Track the set: tag → shell id → one-line goal. Keep this list short in the user-facing update.
4. As workers finish, fold their findings into a single synthesis. If two workers disagree, surface the disagreement explicitly instead of silently picking one.
5. **Edit collisions:** never run two `workspace-write` Codex workers against the same files concurrently. Either serialize them, scope them to disjoint directories, or run each in its own `git worktree`.

### Team composition guidance
- **Reviewer team:** multiple `read-only` workers, each with a different lens (security, perf, API design). Cheap and fully parallel.
- **Builder + reviewer:** one `workspace-write` worker implements, then a `read-only` worker reviews the diff. Sequential, not parallel.
- **Cross-model adversarial:** pair a Codex worker with a Claude sub-agent (`Agent` tool) to challenge each other's output. See `adversarial-review` skill for the pattern.

## Model Selection

**Default behavior: do not pass `-m` / `--model`.** Codex picks the model from `~/.codex/config.toml`, which is where the user manages their preferred default. Only add an explicit `-m` flag when the user asks for a specific model by name in the current request.

**Reasoning effort:** `xhigh` (deep analysis) · `high` (refactor/architecture/security) · `medium` (standard default) · `low` (trivial).

Cached input is 90% off for 24h — reuse the same prompt prefix across workers when possible.

**Do not ration Codex calls on this machine.** The owner's plan is effectively unlimited;
spawning several workers, or regenerating a batch of images because the first pass was
slightly off, costs nothing worth protecting. Optimize for getting the right answer, not
for fewer invocations.

## Error Handling

- If `codex --version` or a launch fails, stop and report. Do not retry blindly.
- **Sandbox flags need no permission prompt on this machine.** The owner has granted
  standing authorization for `--full-auto` and `--sandbox danger-full-access`: it is
  their own single-user machine and they prefer agents to act rather than ask. Pick the
  sandbox the task needs and run. **Still disclose it** — the one-line launch report
  names the sandbox, so "no gate" never becomes "no visibility". Never use
  `AskUserQuestion` for a sandbox flag.
- If a background worker exits non-zero, read its tail output, summarize the failure, and ask the user how to proceed.

## CLI surface worth knowing (verified against codex-cli 0.147.0, 2026-08-22)

The skill used to describe `exec` as if it were the whole CLI. It is not. Commands that
change what you would reach for:

| Command | What it does | When it beats `exec` |
|---|---|---|
| `codex review` | Non-interactive code review of the repo (also `codex exec review`) | A purpose-built reviewer — use it instead of hand-writing a "review this diff" prompt |
| `codex apply` | Applies the agent's latest diff to the working tree via `git apply` | Lets a `read-only` worker propose changes you land separately — safer than `workspace-write` |
| `codex doctor` | Diagnoses install, config, auth, runtime health | First move when a launch fails, before any retry |
| `codex fork` | Forks a past session | Explore a variant without destroying the original thread |
| `codex resume` / `archive` / `delete` / `unarchive` | Session lifecycle | Long-running work across days |
| `codex mcp` / `mcp-server` | Manage MCP servers, or run Codex itself as one | Codex can be a tool *for* another agent |
| `codex cloud` | Browse Codex Cloud tasks, apply locally (experimental) | Work started elsewhere |
| `codex update` · `codex features` | Self-update; inspect feature flags | Check before assuming a capability is missing |

Two `exec` flags the recipes above should use more:

- **`-o <FILE>` / `--output-last-message <FILE>`** — writes the agent's final message to a
  file. **Prefer this over scraping stdout**: stdout carries progress chatter, and parsing
  it is exactly the kind of silently-wrong extraction this workspace has been bitten by.
- **`--output-schema <FILE>`** — a JSON Schema constraining the final response shape. Use it
  whenever you need a structured result back, instead of asking for JSON in prose and hoping.

## CLI Version

Check with `codex --version`. Default model is configured in `~/.codex/config.toml` — do not override it unless the user explicitly requests a different model.

**This skill is not in the `yan-skills` repo** — it was dropped when that repo was slimmed
to `gt` + `autopilot`, and now lives only at `~/.claude/skills/codex` with no version
control. Edits here are local and unbacked; if it matters, move it back into a repo.

## Anti-patterns

- Running `codex exec` in the foreground and making the user wait.
- Calling `AskUserQuestion` before every launch — decide from context.
- **Asking permission for a sandbox flag.** Standing authorization exists on this machine; asking is friction, not safety. Disclose the sandbox in the launch line instead.
- Rationing calls or batch sizes to "save quota" — the plan is effectively unlimited here.
- Spawning parallel `workspace-write` workers on overlapping paths.
- Polling a background shell in a tight loop instead of waiting for the completion notification.
- Forgetting `2>/dev/null` and flooding the main thread with thinking tokens.
- **Grepping `codex --help` for a feature, not finding a flag, and declaring Codex can't do it.** Codex is an agent — capabilities like image generation live inside the agent, not in the CLI surface. Describe the goal and let it work.
- Wiring a Codex-generated image into a deliverable without opening it first, or committing the uncompressed multi-MB original.
