import urllib.request, urllib.parse, re, json, html as hm
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
def get(url, timeout=20, extra=None):
    h = {"User-Agent": UA, "Accept-Language":"zh-CN,zh;q=0.9"}
    if extra: h.update(extra)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8","ignore")

print("="*60)
print("tina.chat 真实内容页")
print("="*60)
st, body = get("https://asserts.tina.chat/share/files/c7V8OFLCvGQUDdoCslOwPx.html")
print(f"HTTP {st} len={len(body)}")
t = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", body)
t = re.sub(r"<[^>]+>", "\n", t)
t = hm.unescape(t)
lines = [x.strip() for x in t.split("\n") if x.strip()]
print(f"行数={len(lines)}\n")
for l in lines:
    print("  ", l[:110])
