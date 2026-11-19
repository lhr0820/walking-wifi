#!/usr/bin/env python3
"""
Walking WiFi 采集器 v2 —— 把公开的「门店 WiFi 密码」数据灌进后端密码库。

━━━ 为什么数据源从「搜索引擎」改成了「GitHub」━━━

原计划是「搜『{门店} wifi 密码』，从搜索结果里提取密码」。实测结论是这条路没有数据：

    查询                                        结果
    ─────────────────────────────────────────  ──────────────────────────
    蜜雪冰城 wifi 密码                           🔴 返回「蜜」字释义（百度百科/汉典）
    "蜜雪冰城" "wifi密码"                        🔴 同上
    蜜雪冰城 无线网 密码                          🔴 同上
    蜜雪冰城店里wifi密码是多少                     🔴 同上
    site:xiaohongshu.com 蜜雪冰城 wifi 密码      🔴 同上
    全国 连锁店 免费wifi 密码 大全                 🔴 0 条相关
    常见商铺 wifi 密码 汇总 知乎                  🔴 0 条相关
    商场 wifi 密码 收集 列表 github               🔴 0 条相关
    奶茶店 wifi 密码 默认 规律                    🔴 0 条相关

（同时验证 Bing 本身是好的：「苹果公司 官网」「上海天气」「Python 教程」都返回正确结果，
  所以不是抓取坏了，是**中文索引里没有这类内容**。）

原因：门店 WiFi 密码主要活在**封闭生态**里——小红书、抖音、大众点评的图文/评论，
这些平台不对搜索引擎开放。真正被索引到的公开内容，是 GitHub 上的项目。

GitHub 上确实有，且格式可解析：

    Pi-face/austin-coffee-shop-wifi        →  README 里就是「店名 - 密码」列表
    FreeZeroDays/Coffee-Shop-WiFi-Wordlist →  coffee-passwords.txt 纯密码列表
    conwnet/wpa-dictionary (★3.9k)         →  中文 WPA 弱口令字典

所以本采集器采两样东西：
  ① 门店→密码（GitHub 项目里的结构化列表）→ 进后端 wifi 表，按门店/SSID 可查
  ② 通用弱口令（字典文件）              → 进本地 Layer 1，试密码时的第一批候选

⚠️ 诚实的边界：
  · ① 的数据量在公开网络上非常小（几十条量级，且多为海外店铺）。
    国内连锁店的门店级密码，公开网络上基本不存在，只能靠 App 内众包和商家认领积累。
  · 搜索引擎层在本产品里只做「兜底」——给用户一个可点的搜索链接，不试图自动提取。

用法：
  python harvest.py probe                     自检：Bing 可达性 + GitHub 可达性 + 正则
  python harvest.py github --sql out.sql      采 GitHub 上的门店密码，生成 D1 导入 SQL
  python harvest.py github --api URL          采完直接回传后端
  python harvest.py weaklist --out weak.txt   导出通用弱口令，供 App 内置
  python harvest.py bing --limit 5            复现「搜索引擎没数据」的结论
"""

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
GH_UA = "walking-wifi-harvester/2.0"

# ── 已知的 GitHub 数据源（实测存在且格式可解析）────────────────────
GH_SOURCES = [
    {
        "repo": "Pi-face/austin-coffee-shop-wifi",
        "branch": "master",
        "path": "README.md",
        # README 里是「1. Barley Bean - barleybean2017」这种列表
        "kind": "shop_list",
        "city": "Austin",
        "region": "US",
    },
    {
        "repo": "FreeZeroDays/Coffee-Shop-WiFi-Wordlist",
        "branch": "main",
        "path": "coffee-passwords.txt",
        "kind": "wordlist",
    },
]

# 弱口令来源（纯密码列表，用于 Layer 1）
WEAK_SOURCES = [
    {"repo": "FreeZeroDays/Coffee-Shop-WiFi-Wordlist", "branch": "main",
     "path": "coffee-passwords.txt", "kind": "wordlist"},
]

# ── HTTP ────────────────────────────────────────────────────────

def http_get(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": GH_UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        for enc in ("utf-8", "gb18030", "latin-1"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", "ignore")


def gh_raw(repo, branch, path):
    return http_get(f"https://raw.githubusercontent.com/{repo}/{branch}/{path}")


def gh_api(path):
    return json.loads(http_get("https://api.github.com" + path,
                               {"User-Agent": GH_UA, "Accept": "application/vnd.github+json"}))


# ── 解析 ────────────────────────────────────────────────────────

def parse_shop_list(text):
    """
    从「店名 - 密码」形式的列表里提取。
    实测样本（Pi-face/austin-coffee-shop-wifi）：
        1. Barley Bean - barleybean2017
        2. Epoch - epochcoffee
    也兼容：店名：密码 / 店名 | 密码 / 店名,密码
    """
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("##"):
            continue
        # 去掉行首编号「1. 」「- 」「* 」
        s = re.sub(r"^\s*(?:\d+[\.\)]|[-*])\s*", "", s)
        m = re.match(r"^(.{2,60}?)\s*[-–—:：|,]\s*([A-Za-z0-9@#\$%^&*._\-]{6,63})\s*$", s)
        if not m:
            continue
        shop, psk = m.group(1).strip(), m.group(2).strip()
        if psk.lower() in {"password", "wifi", "changeme"}:
            continue
        out.append({"shop_name": shop, "psk": psk})
    return out


def parse_wordlist(text):
    """纯密码列表：一行一个，8–63 位，去重。"""
    seen, out = set(), []
    for line in text.splitlines():
        p = line.strip()
        if not p or p.startswith("#"):
            continue
        if 4 <= len(p) <= 63 and p not in seen:
            seen.add(p)
            out.append(p)
    return out


# ── SSID 猜测 ───────────────────────────────────────────────────

def guess_ssid(shop_name):
    """
    门店名 → 可能的 SSID。
    现实是：SSID 往往是店名拼音、英文、或加上后缀。这里只做保守推断，
    并明确标记为低置信度——真正准确的 SSID 只能靠用户扫描时匹配。
    """
    base = shop_name.strip()
    cands = set()
    # 原样（有些店直接用中文 SSID）
    cands.add(base)
    # 去空格/标点
    tight = re.sub(r"[\s\-_\.]", "", base)
    if tight != base:
        cands.add(tight)
    # 英文名加常见后缀
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9 ]*", base):
        low = base.lower().replace(" ", "")
        cands.add(low)
        for suf in ("-wifi", "wifi", "-guest", "_wifi"):
            cands.add(low + suf)
    return [c for c in cands if 2 <= len(c) <= 32]


def norm_ssid(s):
    t = s.strip().lower()
    t = re.sub(r"[-_ ]?(5g|2\.4g|2g|6g)$", "", t)
    return re.sub(r"[\s\-_]", "", t)


def sql_escape(s):
    return (s or "").replace("'", "''")


def sql_upsert(ssid, psk, brand, shop, city, source="harvest", conf=1):
    now = int(datetime.now(timezone.utc).timestamp())
    return (
        "INSERT INTO wifi (ssid,ssid_norm,psk,brand,shop_name,city,geohash,"
        "source,confidence,created_at,updated_at) VALUES "
        f"('{sql_escape(ssid)}','{sql_escape(norm_ssid(ssid))}','{sql_escape(psk)}',"
        f"'{sql_escape(brand)}','{sql_escape(shop)}','{sql_escape(city)}','',"
        f"'{source}',{conf},{now},{now}) "
        "ON CONFLICT(ssid_norm,psk,geohash) DO UPDATE SET "
        "confidence=MIN(3,confidence+1),updated_at=excluded.updated_at;"
    )


# ── 子命令 ──────────────────────────────────────────────────────

def cmd_probe(args):
    print("=" * 64)
    print("采集器自检")
    print("=" * 64)

    # 1. Bing 可达性
    print("\n[1] Bing 可达性")
    try:
        html = http_get("https://www.bing.com/search?" + urllib.parse.urlencode(
            {"q": "苹果公司 官网", "setlang": "zh-CN"}),
            {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
        blocks = re.findall(r'<li class="b_algo"[\s\S]*?</li>', html)
        first = re.sub(r"<[^>]+>", " ", blocks[0]) if blocks else ""
        print(f"    ✅ HTTP 200，结果块 {len(blocks)}，首条: {re.sub(r'  +',' ',first)[:60]}")
    except Exception as e:
        print(f"    ❌ {type(e).__name__}: {e}")

    # 2. GitHub 可达性
    print("\n[2] GitHub 可达性")
    try:
        r = gh_api("/rate_limit")
        core = r["resources"]["core"]
        print(f"    ✅ API 正常，配额 {core['remaining']}/{core['limit']}")
    except Exception as e:
        print(f"    ❌ {type(e).__name__}: {e}")

    # 3. 已知数据源
    print("\n[3] 已知数据源抓取")
    for src in GH_SOURCES:
        try:
            txt = gh_raw(src["repo"], src["branch"], src["path"])
            if src["kind"] == "shop_list":
                rows = parse_shop_list(txt)
                print(f"    ✅ {src['repo']}/{src['path']} → {len(rows)} 条门店密码"
                      f"（例: {rows[0] if rows else '无'}）")
            else:
                rows = parse_wordlist(txt)
                print(f"    ✅ {src['repo']}/{src['path']} → {len(rows)} 条弱口令"
                      f"（例: {rows[:3]}）")
        except Exception as e:
            print(f"    ❌ {src['repo']}: {type(e).__name__}: {e}")

    # 4. 解析器单元验证
    print("\n[4] 解析器单元验证")
    demo = "1. Barley Bean - barleybean2017\n2. Epoch - epochcoffee\n3. 蜜雪冰城：mixue2024"
    rows = parse_shop_list(demo)
    print(f"    人造样本 → {len(rows)} 条: {rows}")
    ok = len(rows) == 3 and rows[0]["psk"] == "barleybean2017"
    print(f"    {'✅ 解析器正常' if ok else '❌ 解析器有 bug'}")
    return 0 if ok else 1


def cmd_bing(args):
    """复现「搜索引擎搜不到门店密码」这个结论。"""
    queries = [
        "蜜雪冰城 wifi 密码", "蜜雪冰城 无线网 密码",
        "全国 连锁店 免费wifi 密码 大全", "商场 wifi 密码 收集 列表",
    ]
    print("=" * 64)
    print("搜索引擎数据验证（预期：全部 0 相关）")
    print("=" * 64)
    total_rel = 0
    for q in queries[: args.limit or len(queries)]:
        try:
            html = http_get("https://www.bing.com/search?" + urllib.parse.urlencode(
                {"q": q, "setlang": "zh-CN", "count": "20"}),
                {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
            blocks = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", b))
                      for b in re.findall(r'<li class="b_algo"[\s\S]*?</li>', html)]
            rel = [b for b in blocks
                   if ("wifi" in b.lower() or "密码" in b)
                   and any(k in b for k in ["大全", "汇总", "列表", "字典", "门店", "店"])]
            total_rel += len(rel)
            print(f"\n[{q}] 块={len(blocks)} 相关={len(rel)}")
            print("   首条:", (blocks[0][:100] if blocks else "无"))
        except Exception as e:
            print(f"\n[{q}] ERR {type(e).__name__}: {e}")
        time.sleep(1.5)
    print("\n" + "=" * 64)
    print(f"合计相关结果: {total_rel}")
    print("结论: 搜索引擎层面无可用数据，" if total_rel == 0 else "有少量数据，",
          "门店密码应改由 App 众包 + GitHub 项目采集 + 商家认领获得。")
    return 0


def cmd_github(args):
    print("=" * 64)
    print("从 GitHub 采集门店 WiFi 密码")
    print("=" * 64)

    all_rows = []
    sql_lines = []
    weak = []

    for src in GH_SOURCES:
        try:
            txt = gh_raw(src["repo"], src["branch"], src["path"])
        except Exception as e:
            print(f"❌ {src['repo']}: {type(e).__name__}: {e}")
            continue

        if src["kind"] == "shop_list":
            rows = parse_shop_list(txt)
            city = src.get("city", "")
            print(f"\n✅ {src['repo']} → {len(rows)} 条门店密码")
            for r in rows:
                # 每条生成：门店名本身作为 SSID 候选（低置信），以及 SSID 猜测
                for ssid in guess_ssid(r["shop_name"])[:2]:
                    sql_lines.append(sql_upsert(
                        ssid, r["psk"], r["shop_name"], r["shop_name"], city,
                        source="harvest", conf=1,
                    ))
                all_rows.append({
                    "ssid": r["shop_name"], "psk": r["psk"],
                    "brand": r["shop_name"], "shop_name": r["shop_name"], "city": city,
                    "_source": src["repo"],
                })
                print(f"   {r['shop_name']:28} → {r['psk']}")
        else:
            weak = parse_wordlist(txt)
            print(f"\n✅ {src['repo']} → {len(weak)} 条弱口令 {weak[:5]}")

    print("\n" + "=" * 64)
    print(f"门店密码 {len(all_rows)} 条，SQL 语句 {len(sql_lines)} 条，弱口令 {len(weak)} 条")
    print("=" * 64)

    if args.sql:
        with open(args.sql, "w", encoding="utf-8") as f:
            f.write("\n".join(sql_lines))
        print(f"SQL → {args.sql}")

    if args.weaklist:
        with open(args.weaklist, "w", encoding="utf-8") as f:
            f.write("\n".join(weak))
        print(f"弱口令 → {args.weaklist}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(all_rows, f, ensure_ascii=False, indent=2)
        print(f"JSON → {args.json}")

    if args.api:
        ok = post_batch(args.api, all_rows)
        print(f"回传后端: {'成功' if ok else '失败'}")
    return 0


def cmd_weaklist(args):
    weak = []
    for src in WEAK_SOURCES:
        try:
            txt = gh_raw(src["repo"], src["branch"], src["path"])
            weak += parse_wordlist(txt)
        except Exception as e:
            print(f"❌ {src['repo']}: {e}")
    # 去重保序
    seen, out = set(), []
    for p in weak:
        if p not in seen:
            seen.add(p)
            out.append(p)
    print(f"共 {len(out)} 条弱口令")
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write("\n".join(out))
        print(f"→ {args.out}")
    else:
        print("\n".join(out[:30]))
    return 0


def post_batch(api, rows):
    body = json.dumps({
        "query": "github-harvest", "engine": "github",
        "raw_url": "https://github.com", "hits": rows, "mark_done": True,
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        api.rstrip("/") + "/v1/harvest/result",
        data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            print("  →", r.read().decode()[:200])
            return True
    except Exception as e:
        print(f"  → {type(e).__name__}: {e}")
        return False


def main():
    ap = argparse.ArgumentParser(description="Walking WiFi 数据采集器 v2")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe", help="自检")

    p_b = sub.add_parser("bing", help="复现搜索引擎无数据的结论")
    p_b.add_argument("--limit", type=int, default=4)

    p_g = sub.add_parser("github", help="从 GitHub 采集门店密码")
    p_g.add_argument("--sql", help="输出 D1 导入 SQL")
    p_g.add_argument("--weaklist", help="同时输出弱口令文件")
    p_g.add_argument("--json", help="输出 JSON")
    p_g.add_argument("--api", help="回传后端地址")

    p_w = sub.add_parser("weaklist", help="导出通用弱口令")
    p_w.add_argument("--out", help="输出文件")

    args = ap.parse_args()
    return {
        "probe": cmd_probe, "bing": cmd_bing,
        "github": cmd_github, "weaklist": cmd_weaklist,
    }[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())