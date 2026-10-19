#!/usr/bin/env python3
"""多语言稿件体检：硬禁项 + 提示项 + 节奏统计 + 字符清理。

用法:
  python3 check.py draft.md           # 输出体检报告
  python3 check.py --clean draft.md   # 输出清理后的文本（不可见字符、异常空格、中文后的半角标点、行尾空白）
  python3 check.py --lang en draft.md # 手动指定；默认按汉字占比自动选择中/英文规则
英文及其他语言 --clean 只清字符与空白，不改标点。
硬禁项必须清零；提示项回到上下文判断；档位只是分诊，不是对作者的判断。
代码块、行内代码、网址、front matter 不检查也不改。
"""
import argparse
import re
import statistics
import sys
import unicodedata

HARD = {
    "翻案腔": r"不是[^。！？\n]{1,25}[，,]\s*(而)?是|而是|并非|不仅[^。！？\n]{0,20}(而且|更是|也是)|与其说|不在于[^。！？\n]{0,20}而在于|表面[^。！？\n]{0,15}实际|看似[^。！？\n]{0,15}实则|你以为[^。！？\n]{0,20}其实|回头才发现|答案恰恰相反|说到底",
    "破折号": r"——|—|–",
    "提示性冒号": r"(总结|核心|关键|结论|重点|答案|原因|一句话|简单来说|总之)[是为]?\s*[：:]",
    "口头路标": r"说白了|说穿了|先说结论|更微妙的是|还有一层|只说对了一半|值得注意的是|需要指出的是|从某种意义上说",
}
SOFT = {
    "黑话与宣传语": r"赋能|助力|打造|深耕|抓手|闭环|底层逻辑|颗粒度|沉淀|链路|生态|愿景|全方位|一站式|无缝|革命性|引领|赛道|矩阵",
    "客服与聊天残留": r"希望(这|以上)?[^。\n]{0,6}(对你|对您)?有帮助|当然可以|好的[，,]以下|作为一个?\s*AI|如有(任何)?疑问|欢迎随时|让我们一起",
    "套话开头收尾": r"在当今[^。\n]{0,10}(时代|社会)|随着[^。\n]{0,20}的(不断)?发展|综上所述|总而言之|总的来说|不可否认|毋庸置疑|未来可期|前景广阔",
    "进行加动词": r"进行(了)?[^\s，。]{1,3}(分析|研究|讨论|优化|处理|改进|调整|检查)",
    "比喻与花腔": r"就像|如同|仿佛|好比|堪比|犹如|宛如|画卷|织就|谱写|扬帆|护航|注入[^。\n]{0,4}活力|点燃|绽放",
    "抽象名词配抒情动词": r"(时间|岁月|焦虑|孤独|记忆|命运)(会|能|总)?(保管|磨平|显出|雕刻|吞没|拥抱)",
    "小结标题": r"^#{1,6}\s*(小结|总结|结语|写在最后)\s*$",
}
# 英文词表也用于其他拉丁字母文本的表层筛查，不代表完整语言校对。
# shortcut: 每个分句最多 160 字符，超长或隐含翻案仍需人工通读。
EN_CLAUSE = r"[^.!?;，,\n]{1,160}?"
EN_JOIN = r"(?:[,;.]\s*|[ \t]*\n\s*)"
EN_REDEFINE = r"(?:(?:it|this|that)(?:[’']s|\s+is)\b|(?:they|we)(?:[’']re|\s+are)\b|instead\b|rather\b)"
EN_TURN = rf"(?:but\b\s*|{EN_REDEFINE})"
EN_HARD = {
    "翻案腔": (
        rf"\bnot\s+(?:just|only|merely|simply)\b{EN_CLAUSE}{EN_JOIN}(?!but\s+also\b)(?:{EN_TURN}|(?!but\b)[^\s.!?])"
        rf"|(?:^|(?<=[.!?\n]))[ \t]*not\b(?!\s+only\b){EN_CLAUSE}(?:{EN_JOIN})?but\b(?!\s+also\b)"
        rf"|\bnot\b{EN_CLAUSE}(?:{EN_JOIN}(?:but\s+)?|[ \t]+but\s+)(?:rather|instead)\b"
        rf"|\b(?:it|this|that)(?:\s+isn[’']t|\s+is\s+not|[’']s\s+not)\s+(?:a|an|the)\s+[\w’'-]+[ \t]*{EN_JOIN}(?:but\s+)?(?:{EN_REDEFINE}|(?:a|an|the)\b)"
        r"|\bmore\s+than\s+just\b"
        rf"|\b(?:isn[’']t|is\s+not|[’']s\s+not)\s+about\b{EN_CLAUSE}{EN_JOIN}{EN_TURN}"
        rf"|\b(?:isn[’']t|is\s+not)\s+the\s+problem\b{EN_JOIN}{EN_CLAUSE}\b(?:is|are)\b"
        rf"|\bno\s+longer\b{EN_CLAUSE}{EN_JOIN}(?:but\s+)?now\b"
    ),
    "破折号": r"—|--",
    "提示性冒号": r"^\s*(?:\#{1,6}\s+|[-*]\s+)?(?:here[’']s\s+)?(?:the\s+)?(?:key|point|takeaway|bottom line|answer|reason|conclusion|summary|in short|in a nutshell)(?:\s+is)?\s*:",
    "口头路标": r"(?:^|(?<=[.!?]))[ \t]*(?:\#{1,6}[ \t]+|[-*][ \t]+)?(?:here[’']s the thing|let[’']s (?:dive in|delve|unpack)|(?:it[’']s|it is) worth noting|importantly|at the end of the day|to put it simply)\b",
}
EN_SOFT = {
    "高频 AI 词": r"\b(?:delv(?:e|es|ed|ing)|tapestr(?:y|ies)|unlock(?:s|ed|ing)?|elevat(?:e|es|ed|ing)|seamless(?:ly)?|game[- ]changer|navigat(?:e|es|ed|ing) (?:the |a )?landscape)\b",
    "套话开头收尾": r"(?:^|(?<=[.!?]))[ \t]*(?:in today[’']s [^.!?\n]{0,80}\b(?:world|landscape)|in conclusion|ultimately|in summary|in an ever[- ]evolving world)\b",
    "泛指开头": r"(?:^|(?<=[.!?]))[ \t]*whether\s+you(?:[’']re|\s+are)\b[^.!?\n]{1,160}\bor\b",
    "疑似翻案（可能是让步句，如是在重新定义主体请改写）": (
        rf"\b(?:not|isn[’']t|aren[’']t|wasn[’']t|weren[’']t|don[’']t|doesn[’']t|didn[’']t)\b"
        rf"{EN_CLAUSE}(?:{EN_JOIN})?{EN_TURN}"
    ),
    "客服与聊天残留": r"\b(?:certainly[!,.]|here is your revised copy|i hope this helps)",
    "比喻与借权威": r"\b(?:a lighthouse in the ocean|weave your dreams|experts agree|marks a new era)\b",
    "空泛正面形容": r"\b(?:innovative|powerful|robust|effortless|cutting-edge|revolutionary|transformative)\b",
    "三段式并列": r"\b[^\W\d_]+(?:[ -][^\W\d_]+){0,2},\s+[^\W\d_]+(?:[ -][^\W\d_]+){0,2},?\s+(?:and|or)\s+[^\W\d_]+(?:[ -][^\W\d_]+){0,2}\b",
}
CJK = r"一-鿿㐀-䶿"
INVISIBLE = re.compile("[​‌‍⁠﻿­‪-‮⁦-⁩]|[\U000e0000-\U000e007f]")
ODD_SPACE = re.compile("[  -   　]")
HALF_AFTER_CJK = re.compile(rf"(?<=[{CJK}”’」』）])([,;:?!])")
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")
CODE = re.compile(r"```.*?```|`[^`\n]+`|https?://\S+", re.S)
FRONT = re.compile(r"\A---\n.*?\n---\n", re.S)


def mask(text):
    """把代码、网址、front matter 换成同长度占位，保持行号不变。"""
    def blank(m):
        return re.sub(r"[^\n]", " ", m.group(0))
    return CODE.sub(blank, FRONT.sub(blank, text))


def mask_en_quotes(text):
    """英文引文和 Markdown 引用不算作者自己的修辞，保留位置。"""
    quoted = (
        r'(?m)^>[ \t]?[^\n]*$|"[^"]*"|“[^”]*”'
        r"|(?<!\w)'(?:[^']|(?<=\w)'(?=\w))*'(?!\w)"
        r"|(?<!\w)‘(?:[^’]|(?<=\w)’(?=\w))*’(?!\w)|~~~.*?~~~"
    )
    return re.sub(quoted, lambda m: re.sub(r"[^\n]", " ", m.group()), text, flags=re.S)


def locate(text, pattern, flags=0):
    for m in re.finditer(pattern, text, flags | re.M):
        line = text.count("\n", 0, m.start()) + 1
        a = max(0, m.start() - 8)
        yield line, text[a:m.end() + 8].replace("\n", " ")


def detect_language(text):
    text = mask(text)
    han = len(re.findall(rf"[{CJK}]", text))
    latin = sum(c.isalpha() and "LATIN" in unicodedata.name(c, "") for c in text)
    return "zh" if han and han / (han + latin) >= 0.5 else "en"


def sentences(text, lang="zh"):
    plain = re.sub(r"^#{1,6}.*$|^\s*[-*]\s", "", text, flags=re.M)
    delimiters = r"[。！？\n]+" if lang == "zh" else r"[.!?。！？\n]+"
    return [s for s in re.split(delimiters, plain) if len(s.strip()) > 1]


def cv(values):
    return statistics.pstdev(values) / statistics.mean(values) if len(values) > 2 and statistics.mean(values) else 1.0


def clean(text, lang="zh"):
    if lang == "en":
        parts = re.split(f"({FRONT.pattern}|{CODE.pattern})", text, flags=re.S)
        for i in range(0, len(parts), 2):
            trailing = r"[ \t]+$" if i == len(parts) - 1 else r"[ \t]+(?=\n)"
            parts[i] = re.sub(trailing, "", ODD_SPACE.sub(" ", INVISIBLE.sub("", parts[i])), flags=re.M)
        return "".join(parts)
    parts, last = [], 0
    for m in list(CODE.finditer(text)) + list(FRONT.finditer(text)):
        parts.append((last, m.start(), True))
        parts.append((m.start(), m.end(), False))
        last = max(last, m.end())
    parts.append((last, len(text), True))
    out = []
    for a, b, prose in sorted(parts):
        seg = text[a:b]
        if prose:
            seg = INVISIBLE.sub("", seg)
            seg = ODD_SPACE.sub(" ", seg)
            seg = HALF_AFTER_CJK.sub(lambda m: dict(zip(",;:?!", "，；：？！"))[m.group(1)], seg)
            seg = re.sub(r"[ \t]+$", "", seg, flags=re.M)
        out.append(seg)
    return "".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", nargs="?")
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--lang", choices=("zh", "en"))
    args = parser.parse_args()
    raw = open(args.file, encoding="utf-8").read() if args.file else sys.stdin.read()
    lang = args.lang or detect_language(raw)
    if args.clean:
        sys.stdout.write(clean(raw, lang))
        return
    text = mask(raw)
    if lang == "en":
        text = mask_en_quotes(text)
    report, hard_total, soft_kinds = [], 0, 0
    for name, pat in (HARD if lang == "zh" else EN_HARD).items():
        hits = list(locate(text, pat, 0 if lang == "zh" else re.I))
        hard_total += len(hits)
        if hits:
            report.append(f"[硬禁] {name} x{len(hits)}")
            report += [f"    L{l}: …{s}…" for l, s in hits[:6]]
    for name, pat in (SOFT if lang == "zh" else EN_SOFT).items():
        hits = list(locate(text, pat, 0 if lang == "zh" else re.I))
        if hits:
            soft_kinds += 1
            report.append(f"[提示] {name} x{len(hits)}")
            report += [f"    L{l}: …{s}…" for l, s in hits[:4]]
    half = list(locate(text, HALF_AFTER_CJK.pattern))
    if lang == "zh" and half:
        report.append(f"[字符] 中文后半角标点 x{len(half)}（--clean 可转全角）")
    inv = len(INVISIBLE.findall(raw)) + len(ODD_SPACE.findall(raw))
    if inv:
        report.append(f"[字符] 不可见或异常空格 x{inv}（--clean 可清除）")
    bold = len(re.findall(r"\*\*[^*\n]+\*\*", text))
    emoji = len(EMOJI.findall(text))
    if bold > 3:
        report.append(f"[提示] 加粗 x{bold}，叙事和论述正文应平铺")
    if emoji:
        report.append(f"[提示] emoji x{emoji}")
    sents = sentences(text, lang)
    length = len if lang == "zh" else lambda s: len(re.findall(r"\b[^\W\d_]+(?:[’'-][^\W\d_]+)*\b", s))
    lens = [length(s) for s in sents]
    limit = 45 if lang == "zh" else 35
    longs = [s for s in sents if length(s) > limit]
    if longs:
        unit = "字" if lang == "zh" else "词"
        report.append(f"[提示] 超过 {limit} {unit}的长句 x{len(longs)}，例：…{longs[0][:30]}…")
    body = re.sub(r"^#{1,6}.*$", "", text, flags=re.M)
    paras = [length(p.strip()) for p in re.split(r"\n\s*\n", body) if p.strip()]
    stats = f"句数 {len(lens)}，句长变异 {cv(lens):.2f}，段数 {len(paras)}，段长变异 {cv(paras):.2f}"
    flat = len(lens) > 8 and cv(lens) < 0.35
    openers = [s.strip()[:2] if lang == "zh" else " ".join(s.lower().split()[:2]) for s in sents]
    rep = any(openers[i] == openers[i + 1] == openers[i + 2] for i in range(len(openers) - 2))
    if lang == "en":
        short_heads = [s.lower().split()[0] if 0 < length(s) <= 12 else None for s in sents]
        rep = rep or any(short_heads[i] is not None and short_heads[i] == short_heads[i + 1] == short_heads[i + 2]
                         for i in range(len(short_heads) - 2))
    if flat:
        report.append("[节奏] 句长变异低于 0.35，读着像节拍器，检查是否被改平")
    if rep:
        report.append("[节奏] 连续三句同一开头")
    score = min(100, hard_total * 12 + soft_kinds * 8 + (10 if flat else 0) + (10 if rep else 0))
    band = "clean" if score <= 20 else "轻度" if score <= 40 else "混合" if score <= 60 else "重度"
    print(f"档位 {band}（{score}）｜硬禁 {hard_total}｜{stats}")
    print("\n".join(report) if report else "无命中")
    sys.exit(1 if hard_total else 0)


if __name__ == "__main__":
    main()
