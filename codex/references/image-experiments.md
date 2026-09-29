# 生图操作与历史实验记录

当前生图流程以 [`imagegen/SKILL.md`](../../imagegen/SKILL.md) 为准。以下保留原有操作与实验事实，避免把一次观察当作通则。

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

