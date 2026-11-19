import urllib.request, urllib.parse, re, json, html as hm
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

def get(url, timeout=20):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        for enc in ("utf-8","gbk","gb18030"):
            try: return r.status, raw.decode(enc)
            except UnicodeDecodeError: continue
        return r.status, raw.decode("utf-8","ignore")

urls = {
  "tina.chat 密码速查": "https://tina.chat/share/share_1a779f71443920ada950c532",
  "kuku.baidu 蜜雪": "https://kuku.baidu.com/landing/tscp_doc/ad18b00987579ba8e9c4a4e7b74cb82c",
  "新浪 WiFi大全": "https://www.sina.cn/news/detail/5327205119823740.html",
}
for name, u in urls.items():
    print("=" * 60)
    print(name)
    print("=" * 60)
    try:
        st, body = get(u)
        print(f"HTTP {st}  len={len(body)}")
        # 提取纯文本
        t = re.sub(r"<script[\s\S]*?</script>| <style[\s\S]*?</style>", " ", body)
        t = re.sub(r"<[^>]+>", "\n", t)
        t = hm.unescape(t)
        lines = [x.strip() for x in t.split("\n") if x.strip()]
        # 找含密码特征的行
        hits = [l for l in lines if re.search(r"[A-Za-z0-9]{6,}.*|.*密码", l) and len(l) < 80]
        print(f"  行数={len(lines)}  可疑行={len(hits)}")
        for h in hits[:25]:
            print("   ", h[:90])
    except Exception as e:
        print(f"  ERR {type(e).__name__}: {str(e)[:100]}")
