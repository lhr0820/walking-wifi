import json, sqlite3, time, os
rules = open("../app/src/main/assets/brand_rules.json", encoding="utf-8").read()
blob = rules.replace("'", "''")   # SQL 转义
now = int(time.time())
sql = (
  "INSERT INTO rules_pack (version, blob, note, updated_at) VALUES "
  f"(1, '{blob}', 'v1 内置版：52 品牌 142 条密码（含小红书@不是momo 的 37 家）', {now}) "
  "ON CONFLICT(version) DO UPDATE SET blob=excluded.blob, updated_at=excluded.updated_at;"
)
open("rules_pack.sql", "w", encoding="utf-8").write(sql)
print(f"规则包 SQL 已生成，blob 长度 {len(rules)} 字节")
print(f"品牌数: {len(json.loads(rules)['brands'])}")
