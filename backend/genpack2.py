import json, time
rules = open("../app/src/main/assets/brand_rules.json", encoding="utf-8").read()
blob = rules.replace("'", "''")
now = int(time.time())
sql = ("INSERT INTO rules_pack (version, blob, note, updated_at) VALUES "
  f"(2, '{blob}', 'v2：52 品牌 142 条密码；沙县/兰州拉面改为仅识别不猜密码', {now}) "
  "ON CONFLICT(version) DO UPDATE SET blob=excluded.blob, updated_at=excluded.updated_at;")
open("rules_pack.sql","w",encoding="utf-8").write(sql)
print("v2 规则包 SQL 已生成")
