#!/usr/bin/env python3
"""种子词健康度与词库自调整(多地区: US/JP/KR).

状态行格式:
  种子状态 | <种子词> | <地区码> | ok | Rising N条
  种子状态 | <种子词> | <地区码> | empty | Rising为空/无数据
  种子状态 | <种子词> | <地区码> | fail | 原因简述
(兼容老格式: 种子状态 | <种子词> | ok | ...,地区默认为 US)

台账数据目录中的 seed_health.json:
  {"streaks": {"US:<种子词>": {"empty_streak": n, "fail_streak": n}, ...},
   "dormant": {"US": [...], "JP": [...], "KR": [...]}}

任一种子在某地区连续 3 轮 empty/fail -> 加入该地区 dormant 列表,
后续轮次跳过扫描. dormant 只增不自动减,恢复需人工.

用法:
  python3 seed_health.py --region JP /tmp/seed_report_jp.txt  # 更新某地区健康度
  python3 seed_health.py --active-seeds JP                    # 输出某地区 active 种子 JSON [{seed, vertical}]
"""
import json
import os
import sys

args = sys.argv[1:]
DATA_DIR = os.environ.get("RANKUP_TRENDS_DIR") or os.path.join(os.getcwd(), ".rankup", "trends")
if "--data-dir" in args:
    i = args.index("--data-dir")
    DATA_DIR = args[i + 1]
    del args[i:i + 2]
sys.argv = [sys.argv[0]] + args
DATA_DIR = os.path.abspath(DATA_DIR)
SEEDS_FILE = os.path.join(DATA_DIR, "seeds.json")
HEALTH_FILE = os.path.join(DATA_DIR, "seed_health.json")
DORMANT_AFTER = 3
REGIONS = ("US", "JP", "KR")


def load_health():
    if not os.path.exists(HEALTH_FILE):
        return {"streaks": {}, "dormant": {r: [] for r in REGIONS}}
    with open(HEALTH_FILE, encoding="utf-8") as f:
        data = json.load(f)
    # 兼容老格式: {seed: {streaks}} -> {"streaks": {"US:seed": ...}}
    if "streaks" not in data:
        data = {"streaks": {"US:" + k: v for k, v in data.items()
                            if isinstance(v, dict)},
                "dormant": {r: [] for r in REGIONS}}
    data.setdefault("streaks", {})
    data.setdefault("dormant", {})
    for r in REGIONS:
        data["dormant"].setdefault(r, [])
    return data


def save_health(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(HEALTH_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def parse_args(argv):
    region = "US"
    active_only = False
    report = None
    i = 0
    while i < len(argv):
        if argv[i] == "--region" and i + 1 < len(argv):
            region = argv[i + 1].upper()
            i += 2
        elif argv[i] == "--active-seeds" and i + 1 < len(argv):
            active_only = True
            region = argv[i + 1].upper()
            i += 2
        elif not argv[i].startswith("--"):
            report = argv[i]
            i += 1
        else:
            i += 1
    return region, active_only, report


def cmd_active_seeds(region):
    with open(SEEDS_FILE, encoding="utf-8") as f:
        seeds = json.load(f)["seeds"]
    health = load_health()
    dormant = set(health["dormant"].get(region, []))
    active = [{"seed": s["seed"], "vertical": s.get("vertical", "")}
              for s in seeds if s["seed"] not in dormant]
    print(json.dumps(active, ensure_ascii=False))


def cmd_update(region, report_path):
    status_lines = []
    with open(report_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("种子状态"):
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 4 and parts[1] and parts[2].upper() in REGIONS \
                    and parts[3] in ("ok", "empty", "fail"):
                status_lines.append((parts[1], parts[2].upper(), parts[3]))
            elif len(parts) >= 3 and parts[1] and parts[2] in ("ok", "empty", "fail"):
                status_lines.append((parts[1], "US", parts[2]))  # 老格式默认 US

    health = load_health()
    for seed, reg, st in status_lines:
        if reg != region:
            continue
        key = "{}:{}".format(reg, seed)
        h = health["streaks"].setdefault(
            key, {"empty_streak": 0, "fail_streak": 0})
        if st == "ok":
            h["empty_streak"] = 0
            h["fail_streak"] = 0
        elif st == "empty":
            h["empty_streak"] += 1
            h["fail_streak"] = 0
        else:  # fail
            h["fail_streak"] += 1
            h["empty_streak"] = 0

    dormant = health["dormant"].setdefault(region, [])
    newly_dormant = []
    for key, h in health["streaks"].items():
        reg, seed = key.split(":", 1)
        if reg != region or seed in dormant:
            continue
        if h.get("empty_streak", 0) >= DORMANT_AFTER:
            dormant.append(seed)
            newly_dormant.append({"seed": seed,
                                  "reason": "连续{}轮Rising为空".format(h["empty_streak"])})
        elif h.get("fail_streak", 0) >= DORMANT_AFTER:
            dormant.append(seed)
            newly_dormant.append({"seed": seed,
                                  "reason": "连续{}轮采集失败".format(h["fail_streak"])})
    save_health(health)

    with open(SEEDS_FILE, encoding="utf-8") as f:
        total = len(json.load(f)["seeds"])
    print(json.dumps({
        "region": region,
        "newly_dormant": newly_dormant,
        "dormant_total": len(dormant),
        "scanned": len([s for s in status_lines if s[1] == region]),
        "active": total - len(dormant),
    }, ensure_ascii=False, indent=2))


def main():
    region, active_only, report = parse_args(sys.argv[1:])
    if region not in REGIONS:
        print(json.dumps({"error": "未知地区: " + region}, ensure_ascii=False))
        sys.exit(1)
    if active_only:
        cmd_active_seeds(region)
    else:
        cmd_update(region, report or "/tmp/seed_report.txt")


if __name__ == "__main__":
    main()
