import json, re, locale

# 复刻 Android CredStore 的匹配算法
rules = json.load(open("../app/src/main/assets/brand_rules.json", encoding="utf-8"))["brands"]

def normalize(ssid):
    s = ssid.strip().strip('"').lower()
    s = re.sub(r"[-_ ]?(5g|2\.4g|2g|6g)$", "", s)
    return re.sub(r"[\s\-_]", "", s)

def brand_of(ssid):
    n = normalize(ssid)
    for b in rules:
        for a in b["aliases"]:
            an = re.sub(r"[\s\-_]", "", a.lower())
            if an and an in n:
                return b["brand"], b
    return None, None

print("=" * 62)
print("品牌匹配验证（模拟 App 的 brandOf()）")
print("=" * 62)
tests = [
    ("蜜雪冰城", "蜜雪冰城"),
    ("MIXUE-WANDA", "蜜雪冰城"),
    ("mxbc-wifi", "蜜雪冰城"),
    ("MIXUE_5G", "蜜雪冰城"),
    ("Haidilao_Guest", "海底捞"),
    ("haidilao-5G", "海底捞"),
    ("luckin coffee", "瑞幸咖啡"),
    ("Luckin-5G", "瑞幸咖啡"),
    ("KFC_WIFI", "肯德基"),
    ("STARBUCKS", "星巴克"),
    (" familymart ", "全家便利店"),
    ("lawson_wifi", "罗森"),
    ("711-5G", "7-11便利店"),
    ("MINISO", "名创优品"),
    ("UNIQLO", "优衣库"),
    ("ZARA_GUEST", "ZARA"),
    ("gu-ming-5g", "古茗"),
    ("cotti coffee", "库迪咖啡"),
    # 应该匹配不到
    ("ZTE-BE5100", None),
    ("ChinaNet-46206A", None),
    ("CU_E2Kb_5G", None),
    ("TP-LINK_8A2C", None),
    ("", None),
]
ok = fail = 0
for ssid, expect in tests:
    got, rule = brand_of(ssid)
    mark = "✅" if got == expect else "❌"
    if got == expect: ok += 1
    else: fail += 1
    psks = rule["psks"][:2] if rule else []
    print(f"  {mark} {ssid!r:24} → {str(got):10} {psks}")
print(f"\n通过 {ok}/{ok+fail}")

print("\n" + "=" * 62)
print("覆盖统计")
print("=" * 62)
total_psks = sum(len(b["psks"]) for b in rules)
total_suf = sum(len(b.get("suffixes", [])) for b in rules)
print(f"  品牌数: {len(rules)}")
print(f"  已知密码: {total_psks} 条")
print(f"  后缀模板: {total_suf} 个（用于生成 品牌名+后缀 变体）")
print(f"  别名总数: {sum(len(b['aliases']) for b in rules)} 个")
