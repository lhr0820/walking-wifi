import urllib.request, re, json
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"
req = urllib.request.Request("https://asserts.tina.chat/share/files/c7V8OFLCvGQUDdoCslOwPx.html",
    headers={"User-Agent": UA})
body = urllib.request.urlopen(req, timeout=20).read().decode("utf-8","ignore")

# 找所有 JS 里的对象/数组字面量：包含 name/password/wifi 字段的
print("=== 含关键词的 script 片段 ===")
for m in re.finditer(r"<script[^>]*>([\s\S]*?)</script>", body):
    js = m.group(1)
    if any(k in js for k in ["password","passwd","wifi","密码","stores","shops"]):
        print(f"--- script len={len(js)} ---")
        print(js[:2500])
        print("...\n")
