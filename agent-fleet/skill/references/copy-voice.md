# 文案语气规范：温暖、准确的营销话术

## Paste-ready block

```text
COPY VOICE — apply to all customer-facing website and product copy.
Use the practical principles distilled from marketing-psychology, marketing-ideas, and write below; no access to those skills is required.
Sound warm, confident, and helpful, like a knowledgeable friend inviting the reader to start.
Lead with the user's benefit and a clear next step. Avoid cold, bureaucratic, defensive, or apologetic language.
Use concrete, observable details from the brief; never substitute enthusiasm for evidence.
Frame the same verified facts positively, without changing their meaning, conditions, or scope.
Reduce starting friction with one small, optional step and clear expectations.
Use reciprocity and try-before-paying only when a real free preview or trial exists; distinguish a static preview from a generated video.
Build commitment through small voluntary steps, never pressure, hidden obligations, or forced choices.
Use anchoring only with genuine approved prices. Show unit prices only when the brief permits calculations; keep pack price, units, and conditions visible.
Use urgency only for a verified deadline, with the exact date, timezone, and post-deadline terms; never reset or invent a countdown.
Never invent social proof, reviews, user counts, ratings, rankings, authors, test results, success rates, scarcity, or competitor facts.
Never use fear-based comparisons, disparage competitors, or introduce artist names.
Choose CTA verbs that describe the actual next action, such as Choose photos, Preview your scene, or Create your video.
Keep button labels concise. Supporting microcopy should resolve the immediate question, not push an unrelated upsell.
For empty states, offer a welcoming first action. For waiting states, acknowledge progress without inventing timings, progress percentages, or completion notifications.
For errors, explain what happened kindly, preserve the practical facts, and offer only a supported recovery step.
Write short sentences with one idea each, concrete nouns, and active verbs. Keep paragraphs focused and varied in length.
Avoid empty adjectives, unsupported superlatives, stock introductions, corporate jargon, ornamental metaphors, and template filler.
Avoid reversal constructions such as "not X but Y"; say the useful positive idea directly.
Tone must never change facts or imply a capability, guarantee, policy, refund, or deletion scope that is not established.
Present routine quality caveats as friendly advice rather than opening with inability.
For lyrics, prefer "After your video is ready, take a moment to check that the visuals and lyrics match what you had in mind."
That advice must not imply accurate singing is guaranteed. Disclose any material purchasing or safety condition clearly where relevant.
Privacy copy must be warm AND precise: check the supplied data flow and /privacy before making access, storage, retention, or exclusivity claims.
Do not add "safely", "securely", "protected", or similar data-security assurances without supplied evidence. Keep every supplied input type visible, including both lyrics and prompts when both are processed.
Name every relevant intermediary when needed for clarity. Do not collapse website -> kie.ai -> underlying model into only two recipients.
Use "Your lyrics are shared only with our platform and the AI model" only if that exclusive scope is verified for all relevant recipients and processing.
For a verified rendering-only route, describe the studio, routing partner, and AI video model accurately; do not imply that the partner is absent.
When other retention is unknown, say "from our storage" rather than promising deletion everywhere. Do not invent training or confidentiality policies.
If the brief conflicts with its data flow or /privacy, preserve the supported narrow facts and omit the unsupported absolute; explain the conflict only if the output format allows notes.
Avoid these cold terms in customer-facing helper copy: provider, vendor, third-party service. Prefer AI video model or our rendering partner only when accurate; retain named recipients when required.
Avoid caveat-led phrasing: may not, cannot guarantee, not verified, unverified, limitation, disclaimer, unfortunately, we are unable, please note that.
This wording rule is not permission to hide material facts. Keep legally required terms and obligations exact in legal text.
Use a warm voice for legal-page titles, introductions, buttons, and helper text; never turn consent or irreversible deletion confirmation into a sales pitch.
Follow the brief's verified fact list, prohibited claims, lengths, language, and exact JSON/output schema. Return no extra notes or fields when forbidden.
Before returning, check warmth, factual scope, unsupported absolutes, cold wording, and the requested output format.
```

## 为什么这样写

用户在 2026-10-04 明确要求：全部页面和流程文案交给 Gemini，写作必须使用 `/marketing-psychology`、`/marketing-ideas`、`/write` 的原则。Gemini 看不到 Claude Skill，这里的英文块就是三份 Skill 的可用原则摘要，`fleet copy` 每次从本文件读取并原样前置，不另存一份提示词。

营销话术从用户想得到什么、现在能做什么出发。懂行的朋友会说明下一步，也会说清价格和数据去向；不会开场就摆出一串「我们做不到」。框架效应改变表达角度，事实和条件保持不变。

- **行为心理**：好处优先、具体细节、小步承诺、降低开始阻力、真实试用的互惠、真实价格锚定与单位价格、明确截止日期。仅使用 brief 已确认且允许表达的事实；免费静态预览不能写成免费生成视频。
- **营销思路**：从 marketing-ideas 的免费工具、产品驱动和 onboarding 思路提炼「先看到价值，再选择下一步」。CTA、空状态和等待微文案是这些原则的界面化应用，并非该 Skill 原文自带的 UI 规范。按钮写实际动作，辅助说明回答眼前的问题，等待时提供安心的预期，不编造进度。
- **写作节奏**：从 write 提炼一句一个意思、短句、具体动词、段落有推进、直说、不写模板翻案句。保留事实和数字；英文无需照搬中文字数、标点或长文比喻规则。

友好建议用于普通质量核对。会影响付款、同意、不可逆删除或安全的条件仍要明确披露，不能靠语气把重要信息藏起来。不编造评价、用户数、评分、排名、竞品事实、作者名；页面声称与后端能力一致，正面表述，不出现艺人名。

## 好／坏对照例句

每组暖版都以「适用事实」成立为前提，不能直接当成任何项目的现行政策。

| 场景与适用事实 | 冷腔版 | 暖版 |
|---|---|---|
| prompt／歌词隐私：已核实网站 → kie.ai → 底层模型，仅用于本次渲染，未发给分析工具 | 我们会把用户的 prompt 发送给视频生成服务商。 | 你的歌词和提示词会从我们的工作室，经 kie.ai 交给负责渲染的 AI 视频模型，不会发送给分析工具。 |
| 隐私只有两处接触：仅当全链路核实无其他接收、处理主体 | 我们向第三方服务提供你的歌词。 | 你的歌词仅在我们的平台和负责生成的 AI 模型之间传递。 |
| 歌词输入框：允许输入歌词，准确演唱无保证 | 歌词不能被准确地唱出来，所以没验证过。 | 视频生成后，建议你再核对一遍画面和歌词是否都如你所愿。 |
| 失败退积分：本次生成已失败，本次扣除的积分已实际退回，无自动重试 | 生成失败，服务不可用，积分已退款。 | 这次视频没能完成，本次扣除的积分已退回，你可以重新开始。 |
| 照片检查未通过：确实检测出整张照片较暗，支持重新上传，未做人脸识别 | 照片验证失败，不符合要求。 | 换一张光线更亮的照片，再继续准备你的视频。 |
| 余额不足：需 10 积分，账户有 6 积分，支持购买积分包 | 余额不足，无法执行请求。 | 这次视频需要 10 积分，你现在有 6 积分。选一个积分包就能继续。 |
| 内容被拒绝：已被内容规则拒绝，允许修改重提，不承诺修改必通过 | 请求被拒绝，违反内容政策。 | 这段内容未通过内容规则检查。调整后可以重新提交。 |
| 生成等待中：任务确在生成，可在账户视频页取回，无已验完成时长 | 服务商正在处理，请等待，耗时未知。 | 你的视频正在制作。你可以稍后回到视频记录页查看结果。 |
| 促销倒计时：10 积分优惠截至 2026-10-07 00:00 UTC，之后 12 积分 | 警告：优惠即将失效，错过损失巨大。 | 现在用 10 积分开始制作。优惠截至 2026 年 10 月 7 日 00:00 UTC，之后每次 12 积分。 |
| 删除数据确认：确实只删照片、视频与历史，保留账户和积分，不可恢复 | 确认执行永久数据清除操作？ | 要删除你的照片、视频和生成记录吗？删除后无法恢复，账户和积分会保留。按钮：删除这些数据／暂时保留。 |
| 照片清理：仅已确认本平台存储会在上传后 1 小时内删除，合作方留存按其政策 | 第三方存储的保留期限不受我们控制。 | 你的原始照片会在上传后 1 小时内从我们的存储中清除；渲染合作方的留存按其隐私政策执行。 |

用户给的隐私方向「你的歌词仅会在我们平台和大模型平台这两个地方接触到，不会在任何其他第三方平台出现」表达亲切，但只能在真实数据流支持时使用。存在 kie.ai 中转时不能说只有两个接收方，也不能把「不发给分析工具」扩大成「不会在任何其他地方出现」。同样，照片「1 小时内删除」须核实计时起点、删除范围和合作方留存，不能省略事实边界。

## 哪些场景不要用营销腔

法律条款正文、隐私接收方与保留期限、付款义务、授权同意、退款资格、不可逆删除确认都优先精确、完整、平实。必要法律术语与否定句可以保留；标题、导语、按钮和辅助说明仍可温暖。不得淡化代价、默认同意或用恐惧催促。

故障和内容拒绝可以体贴，但必须交代实际状态；不能写已退积分而实际还在处理。未知政策、未实现功能和未经核验的承诺不应靠润色变成已具备能力。

## 使用方式与禁用词

日常文案用 `fleet copy brief.md`，或 `fleet run --model kollab-gateway-copy --prompt "..."`。brief 仍须给事实清单、禁止项、目标页面和输出格式。文件缺失、块缺失或超过 60 行会明确报错，不静默跳过。

`--no-voice` 仅用于纯机械改写，例如逐字符转换、固定词替换；它只跳过语气块，保留原 brief 和行动范围。不能为了绕开诚实要求而使用。

冷腔清单：`provider`、`vendor`、`third-party service`；以及以 `may not`、`cannot guarantee`、`not verified`、`unverified`、`limitation`、`disclaimer`、`unfortunately`、`we are unable`、`please note that` 开场。优先用准确的 `AI video model`、`our rendering partner` 或实际接收方名称；不能只换名词就隐去中转方。
