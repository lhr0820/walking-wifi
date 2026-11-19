import urllib.request, urllib.parse, re, json, html as hm
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
def get(url, timeout=20, extra=None):
    h = {"User-Agent": UA, "Accept-Language":"zh-CN,zh;q=0.9"}
    if extra: h.update(extra)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8","ignore")

print("=== 1. tina.chat iframe / API ===")
st, body = get("https://tina.chat/share/share_1a779f71443920ada950c532")
for m in re.findall(r'<iframe[^>]*>', body): print("  iframe:", m[:200])
for m in re.findall(r'(?:src|href|url)\s*=\s*["\']([^"\']*share[^"\']*)["\']', body)[:8]:
    print("  url:", m[:160])
# 找 api 路径
for m in set(re.findall(r'["\'](/[a-z0-9_/\-]*(?:api|share|content)[a-z0-9_/\-]*)["\']', body))[:10]:
    print("  api候选:", m)

print("\n=== 2. B站精准搜索 ===")
def bili(kw, n=8):
    k = urllib.parse.quote(kw)
    u = f"https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={k}&page=1"
    st, b = get(u, extra={"Referer":"https://www.bilibili.com/"})
    j = json.loads(b)
    if j.get("code") != 0: return f"code={j.get('code')} {j.get('message')}"
    res = (j.get("data") or {}).get("result") or []
    out = []
    for r in res[:n]:
        t = re.sub(r'<[^>]+>','', r.get("title",""))
        out.append(t)
    return out

for kw in ["蜜雪冰城 wifi 密码", "奶茶店 wifi 密码", "连锁店 wifi 密码大全", "星巴克 wifi 密码", "瑞幸 wifi 密码"]:
    r = bili(kw)
    print(f"\n[{kw}]")
    if isinstance(r, str): print("  ", r)
    else:
        for t in r: print("   ·", t[:75])
