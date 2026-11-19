import urllib.request, re, json
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"
req = urllib.request.Request("https://asserts.tina.chat/share/files/c7V8OFLCvGQUDdoCslOwPx.html", headers={"User-Agent": UA})
body = urllib.request.urlopen(req, timeout=20).read().decode("utf-8","ignore")

# 抠出 DATA = [ ... ]; 里的所有 {n:"..", w:"..", note:".."}
items = []
for m in re.finditer(r'\{n:"([^"]+)",\s*w:"([^"]+)"(?:\s*,\s*note:"([^"]*)")?\}', body):
    name, pwd, note = m.group(1), m.group(2), m.group(3) or ""
    # 一条可能有多个密码，用 / 分隔
    for p in re.split(r"\s*/\s*", pwd):
        p = p.strip()
        if p:
            items.append({"brand": name, "psk": p, "note": note})

print(f"解析出 {len(items)} 条密码，{len(set(i['brand'] for i in items))} 个品牌")
json.dump(items, open("tina_raw.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)

# 按品牌聚合
by = {}
for it in items:
    by.setdefault(it["brand"], {"psks": [], "note": ""})
    if it["psk"] not in by[it["brand"]]["psks"]:
        by[it["brand"]]["psks"].append(it["psk"])
    if it["note"]:
        by[it["brand"]]["note"] = it["note"]

print(f"\n{'品牌':<14} 密码")
print("-"*60)
for b, v in by.items():
    print(f"{b:<14} {' / '.join(v['psks'])}")
json.dump(by, open("tina_by_brand.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
