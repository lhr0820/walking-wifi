-- Walking WiFi 后端 schema（Cloudflare D1）
-- 设计原则：
--   1. 一个 (ssid_norm, geohash) 组合代表"某个区域的某个网络"
--   2. 密码按 hit_count 排序，被真实连通过越多次排越前
--   3. fail_count 达到阈值自动降权，避免过期密码长期占位

-- ── WiFi 密码库 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wifi (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ssid         TEXT    NOT NULL,              -- 原始 SSID
  ssid_norm    TEXT    NOT NULL,              -- 归一化：小写、去空格/横线、去 -5G 后缀
  psk          TEXT    NOT NULL,              -- 密码（当前版本明文；生产建议用 env.SECRET 加密）
  brand        TEXT,                          -- 品牌：「蜜雪冰城」
  shop_name    TEXT,                          -- 门店：「蜜雪冰城（万达店）」
  city         TEXT,
  geohash      TEXT    DEFAULT '',             -- 位置网格，6 位 ≈ 1.2km（空串=不知道位置）
  auth_type    TEXT    DEFAULT 'wpa2',        -- open / wpa2 / wpa3 / portal
  source       TEXT    NOT NULL,              -- seed|report|harvest|merchant
  confidence   INTEGER DEFAULT 1,             -- 1=网友 / 2=多处一致 / 3=商家认领
  hit_count    INTEGER DEFAULT 0,             -- 真实连接成功次数
  fail_count   INTEGER DEFAULT 0,             -- 「连不上」上报次数
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  status       TEXT    DEFAULT 'active'       -- active|hidden|removed
);

CREATE INDEX IF NOT EXISTS idx_wifi_ssid ON wifi(ssid_norm);
CREATE INDEX IF NOT EXISTS idx_wifi_geo  ON wifi(ssid_norm, geohash);
CREATE INDEX IF NOT EXISTS idx_wifi_brand ON wifi(brand);
-- 同一 SSID + 同一密码 + 同一区域只存一条（geohash 用空串而非 NULL，
-- 这样唯一索引是普通的列索引，ON CONFLICT 能正常匹配）
CREATE UNIQUE INDEX IF NOT EXISTS uq_wifi ON wifi(ssid_norm, psk, geohash);

-- ── 上报（用户说"这个密码能用 / 不能用"）──────────────────────────
CREATE TABLE IF NOT EXISTS report (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ssid_norm  TEXT NOT NULL,
  psk        TEXT,
  kind       TEXT NOT NULL,                   -- worked | failed | portal | closed | new
  reporter   TEXT,                            -- 匿名标识（设备哈希，不存原值）
  geohash    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_ssid ON report(ssid_norm, created_at);

-- ── 商家认领（合规主线：商家自己发布自己的 WiFi）───────────────────
CREATE TABLE IF NOT EXISTS merchant (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brand       TEXT,
  shop_name   TEXT NOT NULL,
  city        TEXT,
  address     TEXT,
  geohash     TEXT,
  claimed_by  TEXT,                           -- 认领人标识，NULL=未认领
  verified_at INTEGER,
  status      TEXT DEFAULT 'pending',         -- pending|active|suspended
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchant_name ON merchant(shop_name);

-- ── 采集队列：待去搜索引擎查的目标 ────────────────────────────────
CREATE TABLE IF NOT EXISTS harvest_target (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_name   TEXT NOT NULL,                  -- 「蜜雪冰城 万达广场店」
  city        TEXT,
  ssid        TEXT,                           -- 已知 SSID（可选）
  priority    INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',         -- pending|running|done|failed
  attempts    INTEGER DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_target_status ON harvest_target(status, priority DESC);

-- ── 采集日志：每个目标搜了什么、命中几条、原始 URL ────────────────
CREATE TABLE IF NOT EXISTS harvest_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id  INTEGER,
  query      TEXT NOT NULL,
  engine     TEXT,                            -- bing|baidu|sogou|duckduckgo
  hits       INTEGER DEFAULT 0,               -- 解析出多少条候选
  accepted   INTEGER DEFAULT 0,               -- 入库多少条
  raw_url    TEXT,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_target ON harvest_log(target_id);