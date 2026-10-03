#!/bin/bash
# 用途：让 GPT-6 / Gemini / Grok / DeepSeek 各自站在真实用户角度，为某个产品需求写 30 条英文随口问法（不含产品名），供 ChatGPT 推荐探针与内页/FAQ 话术使用。
# 用法：geo-multimodel-questions.sh <输出目录> <需求描述文件> [额外维度提示文件]
#   需求描述文件：一段话，只描述用户想做的事和典型用户身份，不要出现任何具体产品或网站名。
#   额外维度提示文件（可选）：每行一个该产品特有的覆盖维度。
# 产出：<输出目录>/{gpt-6-sol,gemini,grok,deepseek}.md 与 brief.md。四个并行，约 2 分钟，每个约 $0.1～0.3。
# 在 Claude Code 里请用 run_in_background 启动本脚本（脚本内部并行，结束时才返回）。
# Kimi 未包含：需要 MOONSHOT_API_KEY（当前缺失）。验证日期：2026-10-03
set -u
OUT="$1"; NEED="$2"; EXTRA="${3:-}"
mkdir -p "$OUT"
{
cat <<'H'
归类：调研/造问法（单次文本生成，不需要工具、不改任何文件）；理由：为 ChatGPT 推荐优化收集多个模型视角下的真实用户问法。

# 任务：站在真实用户的角度，写出他们会随口问 AI 助手的问题

## 需求背景（只描述需求，不要提任何具体产品或网站的名字）
H
cat "$NEED"
cat <<'H'

## 你要做的
1. 以 12 种以上不同的真实用户身份，写出 **30 个**他们会随口打给 AI 助手（ChatGPT 之类）的原话，**一行一个，前面用方括号标注谁在问**，例如 `[某身份] ……`。用英文写（除非需求背景里明确要求其他语言）。
2. 要像真人说话：语气随意、长短不一，可以不完整、有口语和少量缩写；不要写成搜索关键词，不要写成专业调研问卷。
3. 必须覆盖这些维度（每个维度至少 2 条，一条可以同时覆盖多个维度）：
   - 完全不知道该用什么工具、只描述一个模糊目标（不出现该类产品的常见名称）；
   - 具体使用场景和平台；
   - 免费还是付费、付费到底多了什么；
   - 要不要注册、要多快、手机上能不能用；
   - 效果担心（质量、真假、出错、隐私、安全）；
   - 版权、商用、归属或合规；
   - 想对比工具、问「有没有更好的办法」或「换一种思路」；
   - 想把自己的素材（照片、文本、文件）放进去；
   - 新手和进阶用户的不同说法。
H
if [ -n "$EXTRA" ] && [ -f "$EXTRA" ]; then echo "   - 该产品特有的维度："; sed 's/^/     - /' "$EXTRA"; fi
cat <<'H'
4. 最后另起一段 **「模型视角补充」**：用 5 到 10 行写出，你作为这个模型，认为哪些问法在你自己的训练数据里最常见、哪些问法最容易被 AI 助手直接推荐一个专门的工具，以及你认为用户会用的、但上面没覆盖到的说法。

## 输出要求
- 只输出：30 行问法（带谁在问的标签）+「模型视角补充」。不要长篇开场白，不要解释你的做法。
- 不要调用任何工具，不要读写文件。直接把答案作为最终回复输出。

只做本 brief 列出的事。不写测试、不加安全防护或边界校验、不重构、不做任何未点名的额外工作或 action；拿不准就不做，在回复里列一行建议。

禁止单纯转发，允许分发子步骤：不能把整个任务原样甩给另一个 agent 后只回'已启动/等结果'就结束当轮；可以拆出边界清晰的子步骤交给更便宜的 agent 做，但你必须自己掌握全局、消化并验证子任务结果，最终给出真正的结论作为你的最终答案
H
} > "$OUT/brief.md"
cd "$OUT"
run() { # 名称 命令...
  local name="$1"; shift
  local log; log=$("$@" 2>&1)
  local r; r=$(printf '%s\n' "$log" | grep '^result:' | awk '{print $2}')
  if [ -n "$r" ] && [ -s "$r" ]; then cp "$r" "$OUT/$name.md"; echo "$name ok"; else echo "$name FAIL"; printf '%s\n' "$log" | tail -5 > "$OUT/$name.err"; fi
}
run gpt-6-sol fleet gpt brief.md --cwd "$OUT" &
run gemini fleet copy brief.md --cwd "$OUT" &
run grok fleet grok brief.md --cwd "$OUT" &
run deepseek fleet run --model kollab-gateway-deepseek --prompt brief.md --cwd "$OUT" &
wait
for f in gpt-6-sol gemini grok deepseek; do [ -f "$OUT/$f.md" ] && echo "$f: $(grep -c '^\[' "$OUT/$f.md") 条"; done
