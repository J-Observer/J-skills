#!/usr/bin/env python3
"""Sitemap 上游监控 v1（2026-09-30）。

每天抓取大站 sitemap，与昨日快照 diff，输出新增 URL -> 关键词候选。
来源：数据目录中的 sitemap_sources.json（名称到 sitemap URL 的对象）。

用法：python3 sitemap_diff.py [--baseline]
  --baseline：只建快照，不输出 diff（首日用）
"""
import gzip, json, os, re, sys, urllib.request
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

args = sys.argv[1:]
DATA_DIR = os.environ.get("RANKUP_TRENDS_DIR") or os.path.join(os.getcwd(), ".rankup", "trends")
if "--data-dir" in args:
    i = args.index("--data-dir")
    DATA_DIR = args[i + 1]
    del args[i:i + 2]
sys.argv = [sys.argv[0]] + args
DATA_DIR = os.path.abspath(DATA_DIR)
BASE = os.path.join(DATA_DIR, "sitemap-monitor")
SNAP = os.path.join(BASE, "snapshots")
REPO = os.path.join(BASE, "reports")
UA = {"User-Agent": "Mozilla/5.0 (compatible; trends-monitor/1.0)"}
with open(os.path.join(DATA_DIR, "sitemap_sources.json"), encoding="utf-8") as f:
    SOURCES = json.load(f)

NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    if url.endswith(".gz"):
        data = gzip.decompress(data)
    return data


def parse_urls(xml_bytes):
    """返回 [(loc, lastmod or None)]；自动展开 sitemapindex。"""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []
    tag = root.tag
    out = []
    if tag.endswith("sitemapindex"):
        for sm in root.findall("sm:sitemap", NS):
            loc = (sm.findtext("sm:loc", "", NS) or "").strip()
            lastmod = (sm.findtext("sm:lastmod", "", NS) or "").strip() or None
            if loc:
                out.append(("__index__" + loc, lastmod))
    elif tag.endswith("urlset"):
        for u in root.findall("sm:url", NS):
            loc = (u.findtext("sm:loc", "", NS) or "").strip()
            lastmod = (u.findtext("sm:lastmod", "", NS) or "").strip() or None
            if loc:
                out.append((loc, lastmod))
    return out


def collect(site, index_url, since):
    """抓取站点全部 URL（含 lastmod >= since 的子 sitemap 才展开）。"""
    urls = {}
    try:
        entries = parse_urls(fetch(index_url))
    except Exception as e:
        return urls, f"fetch index failed: {e}"
    children = [loc for loc, _ in entries if loc.startswith("__index__")]
    if children:
        for child in children:
            loc = child[len("__index__"):]
            lm = next((m for l, m in entries if l == child), None)
            if lm:
                try:
                    lmd = datetime.fromisoformat(lm.replace("Z", "+00:00"))
                    if lmd < since - timedelta(days=2):
                        continue  # 子 sitemap 两天未更新，跳过
                except ValueError:
                    pass
                except Exception:
                    pass
            try:
                for u, m in parse_urls(fetch(loc)):
                    if not u.startswith("__index__"):
                        urls[u] = m
            except Exception:
                continue
    else:
        for u, m in entries:
            urls[u] = m
    return urls, None


def slug_words(url):
    slug = url.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    slug = re.sub(r"\.(html?|php|aspx?)$", "", slug)
    words = re.sub(r"[-_+]+", " ", slug).strip()
    words = re.sub(r"\s+", " ", words)
    return words


HOT_PATTERNS = re.compile(r"codes|wiki|tier[\s_-]?list|guide|walkthrough|secret", re.I)


def main():
    baseline = "--baseline" in sys.argv
    os.makedirs(SNAP, exist_ok=True)
    os.makedirs(REPO, exist_ok=True)
    today = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d")
    since = datetime.now(timezone.utc) - timedelta(days=1)

    report_lines = [f"# Sitemap 新增监控 {today}", ""]
    total_new = 0

    for site, index_url in SOURCES.items():
        snap_path = os.path.join(SNAP, f"{site}.json")
        old = json.load(open(snap_path)) if os.path.exists(snap_path) else {}
        urls, err = collect(site, index_url, since)
        if err:
            report_lines.append(f"## {site}\n- 抓取失败：{err}\n")
            continue
        json.dump(urls, open(snap_path, "w"), ensure_ascii=False)
        if baseline or not old:
            report_lines.append(f"## {site}\n- 基线已建立，共 {len(urls)} 个 URL（首日不 diff）\n")
            continue
        new_urls = [u for u in urls if u not in old]
        total_new += len(new_urls)
        report_lines.append(f"## {site}\n- 新增 {len(new_urls)} 个 URL（基线 {len(old)} → {len(urls)}）")
        hot = []
        shown = 0
        for u in sorted(new_urls):
            w = slug_words(u)
            if not w or len(w) < 3:
                continue
            star = " ★" if HOT_PATTERNS.search(w) else ""
            if star:
                hot.append(f"  - {w}{star}\n    {u}")
            elif shown < 15:
                report_lines.append(f"  - {w}\n    {u}")
                shown += 1
        if hot:
            report_lines.append("- 高价值模式（codes/wiki/tier list/guide）：")
            report_lines.extend(hot[:20])
        if len(new_urls) > shown + len(hot):
            report_lines.append(f"- （另有 {len(new_urls) - shown - len(hot)} 条未列出，见快照）")
        report_lines.append("")

    report_lines.insert(2, f"**本日新增合计 {total_new}**\n")
    out = os.path.join(REPO, f"sitemap-diff-{today}.md")
    open(out, "w").write("\n".join(report_lines) + "\n")
    print(f"report: {out}")
    print(f"total_new: {total_new}")
    # 控制台输出高价值候选，方便 cron worker 转述
    for line in report_lines:
        if "★" in line or line.startswith("##") or "新增" in line:
            print(line[:160])


if __name__ == "__main__":
    main()
