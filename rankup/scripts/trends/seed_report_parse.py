#!/usr/bin/env python3
"""解析种子词监控的浏览器任务报告,做去重,输出新增高涨幅词.

输入: 文本文件,每行格式 `种子词 | 查询词 | 涨幅`
涨幅示例: Breakout / +4,950% / +1,000%
只有 Breakout 或 >=1000% 的才算命中;命中过一次的词不再重复告警.

用法: python3 seed_report_parse.py <报告文本文件>
输出 JSON: {"new": [...], "stats": {...}}
"""
import json
import os
import re
import sys
from datetime import date

args = sys.argv[1:]
DATA_DIR = os.environ.get("RANKUP_TRENDS_DIR") or os.path.join(os.getcwd(), ".rankup", "trends")
if "--data-dir" in args:
    i = args.index("--data-dir")
    DATA_DIR = args[i + 1]
    del args[i:i + 2]
sys.argv = [sys.argv[0]] + args
DATA_DIR = os.path.abspath(DATA_DIR)
DEFAULT_SEEN = os.path.join(DATA_DIR, "seed_seen.json")
# 第二个可选参数: 去重文件路径(多地区隔离,如 seed_seen_jp.json;默认 seed_seen.json 即美国区)
SEEN_FILE = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_SEEN


def qualifies(growth):
    g = (growth or "").strip()
    if g.lower() == "breakout":
        return True
    m = re.search(r"([\d,]+)\s*%", g)
    if m:
        return int(m.group(1).replace(",", "")) >= 1000
    return False


def main():
    report_path = sys.argv[1]
    seen = {}
    if os.path.exists(SEEN_FILE):
        with open(SEEN_FILE, encoding="utf-8") as f:
            seen = json.load(f)

    today = date.today().isoformat()
    new_hits = []
    observed = 0
    with open(report_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 3:
                continue
            seed, query, growth = parts[0], parts[1], parts[2]
            if not qualifies(growth):
                continue
            observed += 1
            seed_seen = seen.setdefault(seed, {})
            if query not in seed_seen:
                seed_seen[query] = today
                new_hits.append({"seed": seed, "query": query, "growth": growth})

    with open(SEEN_FILE, "w", encoding="utf-8") as f:
        json.dump(seen, f, ensure_ascii=False, indent=1)

    print(json.dumps({"new": new_hits,
                      "stats": {"observed_hot": observed,
                                "new_count": len(new_hits),
                                "seeds_tracked": len(seen)}},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
