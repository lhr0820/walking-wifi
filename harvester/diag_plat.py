import urllib.request, urllib.parse, json, time
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

def get(url, headers=None):
    h = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, r.read().decode("utf-8", "ignore")

# ── B站：先拿 buvid3 cookie，再搜
print("=" * 55)
print("B站 (api.bilibili.com)")
print("=" * 55)
try:
    st, _ = get("https://www.bilibili.com/")
    print(f"  首页 HTTP {st}")
    kw = urllib.parse.quote("wifi 密码")
    url = f"https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={kw}&page=1"
    st, body = get(url, {"Referer": "https://www.bilibili.com/"})
    print(f"  搜索 HTTP {st} len={len(body)}")
    j = json.loads(body)
    print(f"  code={j.get('code')} message={j.get('message')}")
    data = j.get("data") or {}
    results = data.get("result") or []
    print(f"  结果数={len(results)}")
    for r in results[:5]:
        title = r.get("title","").replace('<em class="keyword">','').replace('</em>','')
        print(f"    · {title[:70]}")
except Exception as e:
    print(f"  ERR {type(e).__name__}: {e}")
