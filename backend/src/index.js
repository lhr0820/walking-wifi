/**
 * Walking WiFi API — Cloudflare Worker + D1
 *
 * 服务的四层取密降级链里，第 2 层（后端库）和第 3 层（搜索）落在这里：
 *
 *   Layer 1  本地弱口令        → App 内完成，不经过这里
 *   Layer 2  后端密码库        → GET  /v1/lookup
 *   Layer 3  搜索引擎采集      → GET  /v1/harvest/targets  +  POST /v1/harvest/result
 *                                  （采集器在本地跑，这里只做队列和入库）
 *
 * 另外两条合规主线：
 *   POST /v1/report            用户上报「这个密码能用/不能用」
 *   POST /v1/merchant/claim    商家认领自己的店，发布自家的 WiFi
 */

// ── 工具 ────────────────────────────────────────────────────────

/** SSID 归一化：小写、去引号、去空格横线、去频段后缀 */
function normSsid(s) {
  if (!s) return '';
  let t = String(s).trim().replace(/^"|"$/g, '').toLowerCase();
  t = t.replace(/[-_ ]?(5g|2\.4g|2g|6g)$/i, '');
  t = t.replace(/[\s\-_]/g, '');
  return t;
}

// ── 品牌模糊匹配 ────────────────────────────────────────────────
//
// 用户扫到的是「MIXUE-WANDA-5G」「MIXUE-2F」这类门店自己起的名，
// 精准匹配 ssid_norm 永远对不上。真正的价值在于：只要名字里有
// 「mixue / mxbc / 蜜雪」，就认成蜜雪冰城，把该品牌所有已知密码给出去。
//
// 这就是「不需要名字完全相同」的落地方式。

/**
 * 读取最新规则包。失败返回空数组，不影响查询主流程。
 *
 * **有意不做内存缓存**（2026-11-19 改）。
 *
 * 原来缓存 5 分钟，结果踩了个坑：Cloudflare Workers 是多实例的，
 * 每个实例独立缓存。发布新版规则包后，有的实例立刻用新版，
 * 有的还在用旧版 —— 同一个 SSID 连续查三次，
 * 出现 0 / 20 / 0 这样前后不一致的结果。用户刷新两次看到不同答案，
 * 这是比「慢几十毫秒」严重得多的问题。
 *
 * 规则包只有 22KB，D1 读一次约 10-30ms，换来全局一致，值得。
 * 批量查询接口已做到「整批只读一次」，不存在 N 倍放大。
 */
async function loadBrandRules(env) {
  try {
    const pack = await env.DB.prepare(
      `SELECT blob FROM rules_pack ORDER BY version DESC LIMIT 1`,
    ).first();
    if (pack && pack.blob) {
      return JSON.parse(pack.blob).brands || [];
    }
  } catch (_) { /* 读不到就降级成「只做精准匹配」 */ }
  return [];
}

/** 品牌名 / 别名归一化：小写、去分隔符 */
function aliasNorm(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_·.]/g, '');
}

/**
 * 从一个 SSID 反推它可能属于哪些品牌。
 * 返回 [{ brand, hitAlias }]，按别名长度降序（长别名更可信）。
 *
 * 为什么按长度排：别名 "mxbc" 比 "mc" 更具体，
 * 短别名容易误伤（"kfc" 匹配到无关网络），长别名优先能降误判。
 */
function brandsFromSsid(rules, ssid) {
  const n = normSsid(ssid);
  if (!n || !rules.length) return [];
  const hits = [];
  for (const b of rules) {
    const aliases = (b.aliases && b.aliases.length) ? b.aliases : [b.brand];
    let best = null;
    for (const a of aliases) {
      const an = aliasNorm(a);
      // 别名太短（<3）容易误伤，跳过；中文别名按 1 字也算有意义，单独放行
      const isCjk = /[\u4e00-\u9fa5]/.test(a);
      if (an.length < (isCjk ? 1 : 3)) continue;
      if (n.includes(an)) {
        if (!best || an.length > best.length) best = an;
      }
    }
    if (best) hits.push({ brand: b.brand, hitAlias: best });
  }
  return hits.sort((a, b) => b.hitAlias.length - a.hitAlias.length);
}

/** 极简 geohash（精度 6 ≈ 1.2km）。够用来做区域聚合，不追求严格实现。 */
function geohash(lat, lon, precision = 6) {
  if (lat == null || lon == null) return null;
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = '', bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { ch = ch * 2 + 1; lonMin = mid; } else { ch *= 2; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = ch * 2 + 1; latMin = mid; } else { ch *= 2; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

const now = () => Math.floor(Date.now() / 1000);

/** 密码合法性：WPA-PSK 是 8–63 位；开放网络是空串 */
function validPsk(p) {
  if (p === '' || p == null) return true;
  const s = String(p);
  return s.length >= 8 && s.length <= 63;
}

// ── 路由 ────────────────────────────────────────────────────────

async function handleLookup(url, env) {
  const ssid = url.searchParams.get('ssid');
  if (!ssid) return json({ error: 'missing ssid' }, 400);

  const ssidNorm = normSsid(ssid);
  const gh = url.searchParams.get('gh');
  const city = url.searchParams.get('city');
  const limit = Math.min(parseInt(env.MAX_CANDIDATES || '20', 10), 50);

  // 排序权重：能连通的次数为主，近邻位置加成，失败次数惩罚
  // 同一地理网格的排前面；没网格时按全局热度
  //
  // 注意 score 必须在外层算：SQLite 不允许在同级 SELECT 的表达式里
  // 引用刚定义的别名（geo_hit），否则报 "no such column: geo_hit"。
  // 这个 bug 一直存在，直到绑了域名、接口真正被调用才暴露。
  const sql = `
    SELECT psk, auth_type, confidence, hit_count, fail_count, source, brand, city, geo_hit,
           (hit_count * 10) - (fail_count * 6) + (confidence * 3) + (geo_hit * 8) AS score
    FROM (
      SELECT psk, auth_type, confidence, hit_count, fail_count, source, brand, city, updated_at,
             CASE WHEN geohash IS NOT NULL AND geohash = ?1 THEN 1 ELSE 0 END AS geo_hit
      FROM wifi
      WHERE ssid_norm = ?2
        AND status = 'active'
        AND fail_count < 3
    )
    ORDER BY score DESC, updated_at DESC
    LIMIT ?3
  `;

  let rows;
  try {
    const stmt = env.DB.prepare(sql).bind(gh || '', ssidNorm, limit);
    const res = await stmt.all();
    rows = res.results || [];
  } catch (e) {
    return json({ error: 'db_error', detail: String(e) }, 500);
  }

  // ── 精准没命中，走品牌模糊匹配 ─────────────────────────────
  //
  // 这是「不需要名字完全相同」的核心：
  // 扫到 "MIXUE-WANDA-5G"，库里可能只有 "MIXUE" 或 "蜜雪冰城" 的记录。
  // 只要 SSID 里含品牌别名，就认为这家店属于该品牌，
  // 把该品牌所有已知密码按可信度给出去。
  //
  // 有意只做「品牌级」不做「门店级」：门店名千变万化，猜不准；
  // 但同一个连锁品牌的 WiFi 密码全国通用率很高，这是产品的价值所在。
  let matchType = rows.length > 0 ? 'exact' : null;
  let matchedBrand = null;
  let matchedAlias = null;

  if (rows.length === 0) {
    const rules = await loadBrandRules(env);
    const brandHits = brandsFromSsid(rules, ssid);

    if (brandHits.length) {
      matchedBrand = brandHits[0].brand;
      matchedAlias = brandHits[0].hitAlias;

      // 按品牌查：brand 字段精确等于品牌名
      // 也顺带匹配 ssid_norm 含该品牌别名的记录（防止 brand 字段为空的旧数据漏掉）
      const brandSql = `
        SELECT psk, auth_type, confidence, hit_count, fail_count, source, brand, city,
               0 AS geo_hit,
               (hit_count * 10) - (fail_count * 6) + (confidence * 3) AS score
        FROM wifi
        WHERE status = 'active'
          AND fail_count < 3
          AND (brand = ?1 OR ssid_norm LIKE ?2)
        ORDER BY score DESC, updated_at DESC
        LIMIT ?3
      `;
      try {
        const r = await env.DB.prepare(brandSql)
          .bind(matchedBrand, `%${matchedAlias}%`, limit)
          .all();
        rows = r.results || [];
        if (rows.length) matchType = 'brand';
      } catch (_) { /* 模糊匹配失败就当没命中 */ }
    }
  }

  // ── 查不到就排进采集队列 ──────────────────────────────────
  //
  // 这是「后端一直更新和搜集密码」的核心机制：
  // 用户每遇到一个库里没有的 SSID，就等于替我们标出了一个采集目标。
  // 排队后由 harvester（或定时任务）去各处找，找到了入库，
  // 下次同一个 SSID 的查询就能命中。
  //
  // 有意做成「不影响响应」：插入失败也不能让 lookup 报错。
  let queued = false;
  if (rows.length === 0) {
    const t = Date.now();
    // 表里 shop_name 是 NOT NULL（原设计面向「店名」采集）。
    // 用户遇到的只有 SSID，所以这里拿 SSID 当 shop_name 用——
    // 采集器拿到后可以用它做关键词。
    try {
      await env.DB.prepare(
        `INSERT INTO harvest_target
           (shop_name, ssid, ssid_norm, city, status, priority, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 1, 0, ?, ?)
         ON CONFLICT(ssid_norm) DO UPDATE SET
           priority = priority + 1,
           updated_at = excluded.updated_at`,
      ).bind(ssid, ssid, ssidNorm, city || null, t, t).run();
      queued = true;
    } catch (_) {
      try {
        await env.DB.prepare(
          `INSERT INTO harvest_target
             (shop_name, ssid, ssid_norm, city, status, priority, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 1, 0, ?, ?)`,
        ).bind(ssid, ssid, ssidNorm, city || null, t, t).run();
        queued = true;
      } catch (_) { /* 静默：排队失败不能影响查询响应 */ }
    }
  }

  return json({
    ssid,
    ssid_norm: ssidNorm,
    geohash: gh,
    count: rows.length,
    // exact   = SSID 一模一样，最可信
    // brand   = 按品牌模糊匹配（如 MIXUE-WANDA → 蜜雪冰城），可信度低一档
    // null    = 完全没找到
    match_type: matchType,
    matched_brand: matchedBrand,
    matched_alias: matchedAlias,
    // App 的 Layer 3 就是把这个数组喂给试密码流程
    candidates: rows.map((r) => ({
      psk: r.psk,
      auth: r.auth_type,
      confidence: r.confidence,
      hits: r.hit_count,
      fails: r.fail_count,
      source: r.source,
      same_area: !!r.geo_hit,
    })),
    // 'queued' = 已排进采集队列，后端会持续搜集
    // null     = 有候选，直接用
    fallback: rows.length === 0 ? (queued ? 'queued' : 'none') : null,
  });
}

async function handleReport(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const { ssid, psk, kind, device, lat, lon } = body || {};
  if (!ssid || !kind) return json({ error: 'missing ssid/kind' }, 400);

  const ssidNorm = normSsid(ssid);
  const gh = geohash(lat, lon);
  // 设备标识只存短哈希，不落原始值
  const reporter = device ? await sha256Short(String(device)) : null;
  const t = now();

  await env.DB.prepare(
    `INSERT INTO report (ssid_norm, psk, kind, reporter, geohash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(ssidNorm, psk || null, kind, reporter, gh, t).run();

  // 根据上报类型调整对应密码的计数
  if (psk) {
    if (kind === 'worked') {
      // 命中 +1；如果这条密码还不存在，顺手入库（这是最有价值的数据）
      const hit = await env.DB.prepare(
        `UPDATE wifi SET hit_count = hit_count + 1, updated_at = ?,
           confidence = MIN(3, confidence + 1)
         WHERE ssid_norm = ? AND psk = ?`,
      ).bind(t, ssidNorm, psk).run();

      if (!hit.meta || hit.meta.changes === 0) {
        await env.DB.prepare(
          `INSERT INTO wifi (ssid, ssid_norm, psk, geohash, source, confidence,
             hit_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'report', 2, 1, ?, ?)`,
        ).bind(ssid, ssidNorm, psk, gh, t, t).run();
      }
    } else if (kind === 'failed') {
      await env.DB.prepare(
        `UPDATE wifi SET fail_count = fail_count + 1, updated_at = ?
         WHERE ssid_norm = ? AND psk = ?`,
      ).bind(t, ssidNorm, psk).run();
      // 失败太多次自动隐藏，防止过期密码长期占位
      await env.DB.prepare(
        `UPDATE wifi SET status = 'hidden'
         WHERE ssid_norm = ? AND psk = ? AND fail_count >= 3`,
      ).bind(ssidNorm, psk).run();
    }
  }

  return json({ ok: true });
}

async function sha256Short(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleHarvestTargets(url, env) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
  const res = await env.DB.prepare(
    `SELECT id, shop_name, city, ssid, attempts
     FROM harvest_target
     WHERE status IN ('pending', 'failed') AND attempts < 3
     ORDER BY priority DESC, id ASC
     LIMIT ?`,
  ).bind(limit).all();
  return json({ count: (res.results || []).length, targets: res.results || [] });
}

/**
 * 采集器解析完一个目标后回传。这里是 Layer 3 真正的"入库口"。
 * body: { target_id, query, engine, raw_url, hits: [{ssid, psk, brand, shop_name, city}] }
 */
async function handleHarvestResult(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const { target_id, query, engine, raw_url, hits, note, mark_done } = body || {};
  let notes = note || '';
  const t = now();

  let accepted = 0;
  for (const h of hits || []) {
    if (!h || !h.ssid) continue;
    const ssidNorm = normSsid(h.ssid);
    if (!ssidNorm) continue;
    if (!validPsk(h.psk)) continue;

    try {
      // 已存在就只更新 confidence（多个来源一致 = 更可信）
      const r = await env.DB.prepare(
        `INSERT INTO wifi (ssid, ssid_norm, psk, brand, shop_name, city,
            source, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'harvest', 1, ?, ?)
         ON CONFLICT(ssid_norm, psk, geohash) DO UPDATE SET
           confidence = MIN(3, confidence + 1),
           updated_at = excluded.updated_at`,
      ).bind(
        h.ssid, ssidNorm, h.psk || '', h.brand || null, h.shop_name || null,
        h.city || null, t, t,
      ).run();
      if (r.meta && r.meta.changes > 0) accepted++;
    } catch (e) {
      // 单条失败不影响整批
      notes += ' | insert_fail: ' + String(e).slice(0, 80);
    }
  }

  await env.DB.prepare(
    `INSERT INTO harvest_log (target_id, query, engine, hits, accepted, raw_url, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    target_id || null, query || '', engine || null, (hits || []).length,
    accepted, raw_url || null, notes || null, t,
  ).run();

  if (target_id) {
    await env.DB.prepare(
      `UPDATE harvest_target
       SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      mark_done ? 'done' : (accepted > 0 ? 'done' : 'failed'),
      accepted > 0 ? null : (notes || 'no hits'),
      t, target_id,
    ).run();
  }

  return json({ ok: true, accepted });
}

async function handleMerchantClaim(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { shop_name, brand, city, address, lat, lon, owner, ssid, psk, auth_type } = body || {};
  if (!shop_name) return json({ error: 'missing shop_name' }, 400);

  const t = now();
  const gh = geohash(lat, lon);

  const m = await env.DB.prepare(
    `INSERT INTO merchant (brand, shop_name, city, address, geohash, claimed_by,
        verified_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).bind(brand || null, shop_name, city || null, address || null, gh,
    owner || null, owner ? t : null, t).run();

  const merchantId = m.meta ? m.meta.last_row_id : null;

  // 商家自己填的 WiFi 直接给最高置信度
  if (ssid) {
    await env.DB.prepare(
      `INSERT INTO wifi (ssid, ssid_norm, psk, brand, shop_name, city, geohash,
          auth_type, source, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'merchant', 3, ?, ?)
       ON CONFLICT(ssid_norm, psk, geohash) DO UPDATE SET
         confidence = 3, source = 'merchant', updated_at = excluded.updated_at`,
    ).bind(ssid, normSsid(ssid), psk || '', brand || null, shop_name,
      city || null, gh || '', auth_type || 'wpa2', t, t).run();
  }

  return json({ ok: true, merchant_id: merchantId });
}

/**
 * 测速用的定长数据端点。方案 A（到店网络体检）的核心依赖。
 *
 * App 拉 size 字节，用计时算 Mbps。为什么不用公共测速源：
 *   1. 第三方节点不稳定，测出来的是"到那台服务器的速度"
 *   2. 我们自己的 Worker 在全球边缘节点，更接近用户真实出口质量
 *   3. 可控，不会被别人的限流干扰
 *
 * size 上限 4 MB（够测 100 Mbps 以内的链路，也不至于烧掉 Worker 免费额度）。
 */
function handleSpeedtestPayload(url) {
  const raw = parseInt(url.searchParams.get('size') || '1048576', 10);
  const size = Math.max(1024, Math.min(4 * 1024 * 1024, Number.isFinite(raw) ? raw : 1048576));

  // 不可压缩的伪随机内容，避免中间层 gzip 把 1 MB 压成几 KB 导致测速虚高
  const buf = new Uint8Array(size);
  let x = 0x9e3779b9 >>> 0;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  return new Response(buf, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      // 关键：明确声明不压缩，否则压缩后字节数变了，测速就废了
      'cache-control': 'no-store, no-cache, must-revalidate',
      'content-encoding': 'identity',
      'access-control-allow-origin': '*',
    },
  });
}

/** 体检结果上报：方案 A 的数据资产，B 端商家要买的就是这个 */
async function handleCheckupReport(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const {
    ssid, bssid, score, download_mbps, ttfb_ms,
    security, needs_portal, reachable, geohash, brand,
  } = body || {};
  if (!ssid) return json({ error: 'missing ssid' }, 400);

  const t = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO checkup
         (ssid, ssid_norm, bssid, score, download_mbps, ttfb_ms,
          security, needs_portal, reachable, geohash, brand, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ssid, normSsid(ssid), bssid || null,
      Math.round(Number(score) || 0),
      Number(download_mbps) || 0,
      Math.round(Number(ttfb_ms) || 0),
      security || null,
      needs_portal ? 1 : 0,
      reachable ? 1 : 0,
      geohash || '', brand || null, t,
    ).run();
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: 'db_error', detail: String(e) }, 500);
  }
}

/**
 * 某商圈的体检排行 —— 这是要卖给商家的东西。
 * 「你家 WiFi 在同商圈排第 38 名，平均下载 2.1 Mbps，隔壁 18.7 Mbps」
 */
async function handleCheckupRank(url, env) {
  const gh = (url.searchParams.get('gh') || '').trim();
  if (!gh) return json({ error: 'missing gh' }, 400);
  const prefix = gh.slice(0, 4); // 前 4 位约 20 km，够聚出一个商圈
  try {
    const rows = await env.DB.prepare(
      `SELECT ssid, brand,
              COUNT(*) AS samples,
              ROUND(AVG(score), 1) AS avg_score,
              ROUND(AVG(download_mbps), 2) AS avg_mbps,
              ROUND(AVG(ttfb_ms)) AS avg_ttfb,
              ROUND(100.0 * SUM(needs_portal) / COUNT(*), 1) AS portal_pct
         FROM checkup
        WHERE geohash LIKE ? AND created_at > ?
        GROUP BY ssid
       HAVING samples >= 2
        ORDER BY avg_score DESC
        LIMIT 50`,
    ).bind(prefix + '%', Date.now() - 90 * 86400_000).all();

    const list = (rows.results || []).map((r, i) => ({ rank: i + 1, ...r }));
    return json({ area: prefix, total: list.length, list });
  } catch (e) {
    return json({ error: 'db_error', detail: String(e) }, 500);
  }
}

/** 采集器拉待办：按 priority 和新鲜度排，优先采用户真实遇到过但库里没有的 */
async function handleCollectNext(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!env.COLLECT_TOKEN || token !== env.COLLECT_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
  try {
    const res = await env.DB.prepare(
      `SELECT id, ssid, ssid_norm, city, priority, created_at
         FROM harvest_target
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at DESC
        LIMIT ?`,
    ).bind(limit).all();
    return json({ count: (res.results || []).length, targets: res.results || [] });
  } catch (e) {
    return json({ error: 'db_error', detail: String(e) }, 500);
  }
}

/** 采集器回报结果：found 的密码进 wifi 表，target 置 done */
async function handleCollectDone(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const token = req.headers.get('x-collect-token') || '';
  if (!env.COLLECT_TOKEN || token !== env.COLLECT_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  const { target_id, ssid, found } = body || {};
  if (!ssid) return json({ error: 'missing ssid' }, 400);
  const t = Date.now();
  let inserted = 0;

  // 采到的密码写进主库，source 标成 harvest，confidence 从 1 起步
  for (const psk of (Array.isArray(found) ? found : [])) {
    if (!validPsk(psk)) continue;
    try {
      await env.DB.prepare(
        `INSERT INTO wifi (ssid, ssid_norm, psk, source, confidence, hit_count, fail_count,
                           status, geohash, created_at, updated_at)
         VALUES (?, ?, ?, 'harvest', 1, 0, 0, 'active', '', ?, ?)
         ON CONFLICT(ssid_norm, psk, geohash) DO UPDATE SET
           confidence = confidence + 1,
           updated_at = excluded.updated_at`,
      ).bind(ssid, normSsid(ssid), psk, t, t).run();
      inserted++;
    } catch (_) { /* 单条失败不影响其他 */ }
  }

  if (target_id) {
    try {
      // 注意：harvest_target 表没有 completed_at 列（只有 created_at / updated_at）。
      // 之前写 completed_at 导致 UPDATE 静默失败，target 永远留在待办队列里。
      await env.DB.prepare(
        `UPDATE harvest_target SET status = 'done', updated_at = ? WHERE id = ?`,
      ).bind(t, target_id).run();
    } catch (e) {
      // 不再全静默：至少让调用方知道更新失败，否则队列会一直卡住
      return json({ ok: true, inserted, warning: 'target_update_failed', detail: String(e) });
    }
  }

  return json({ ok: true, inserted });
}

// ── 后端内置采集 ─────────────────────────────────────────────
//
// 目标：让后端「自己持续更新密码库」，不依赖本地跑脚本。
//
// 逻辑：
//   1. 取待办队列（用户查过、但库里没有的 SSID）
//   2. 用最新的规则包（rules_pack）做品牌匹配
//   3. 命中的品牌 → 把该品牌已知密码 + 「品牌名+后缀」变体写入 wifi 表
//   4. 未命中的 → 标记 failed，等更完整的规则包或人工补
//
// 这样用户每查一个门店，这个门店的密码就有机会被自动补进库；
// 规则包一更新（加新品牌），下一轮 Cron 就会把之前失败的重新试一遍。

/** 归一化 SSID，和后端 normSsid 保持一致 */
function ssidNormForMatch(s) {
  return normSsid(s || '');
}

/** 品牌名归一化，用于拼「品牌名+后缀」 */
function brandNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\-_·]/g, '')
    .replace(/[（）()【】]/g, '');
}

/** 在规则包里找匹配的品牌 */
function matchBrandRule(rules, ssidNorm) {
  for (const b of rules) {
    const aliases = (b.aliases && b.aliases.length) ? b.aliases : [b.brand];
    for (const a of aliases) {
      const an = String(a).toLowerCase().replace(/[\s\-_]/g, '');
      if (an && ssidNorm.includes(an)) return b;
    }
  }
  return null;
}

/**
 * 跑一轮自动采集。返回处理统计。
 * @param {number} limit 本轮最多处理多少个 target
 */
async function autoCollect(env, limit = 20) {
  const stats = { scanned: 0, matched: 0, inserted: 0, unmatched: 0, failed: 0 };

  // 1) 取待办
  let targets = [];
  try {
    const r = await env.DB.prepare(
      `SELECT id, ssid, ssid_norm FROM harvest_target
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT ?`,
    ).bind(limit).all();
    targets = r.results || [];
  } catch (e) {
    return { ...stats, error: 'query_targets_failed', detail: String(e) };
  }
  if (targets.length === 0) return stats;
  stats.scanned = targets.length;

  // 2) 读规则包
  let rules = [];
  try {
    const pack = await env.DB.prepare(
      `SELECT blob FROM rules_pack ORDER BY version DESC LIMIT 1`,
    ).first();
    if (pack && pack.blob) rules = JSON.parse(pack.blob).brands || [];
  } catch (e) {
    return { ...stats, error: 'rules_load_failed', detail: String(e) };
  }

  const t = Date.now();

  // 3) 逐个匹配
  for (const tg of targets) {
    const norm = tg.ssid_norm || sentinelNorm(tg.ssid);
    const rule = matchBrandRule(rules, norm);

    if (!rule) {
      stats.unmatched++;
      // 标记 failed，避免同一个 target 每轮都被扫一遍。
      // 规则包更新后，可以人工把 failed 改回 pending 重试。
      try {
        await env.DB.prepare(
          `UPDATE harvest_target
              SET status = 'failed', attempts = attempts + 1,
                  last_error = 'no_brand_match', updated_at = ?
            WHERE id = ?`,
        ).bind(t, tg.id).run();
      } catch (_) { stats.failed++; }
      continue;
    }

    stats.matched++;

    // 候选：品牌已知密码 + 「别名+后缀」变体
    const cands = [];
    for (const p of (rule.psks || [])) {
      if (p && p.length >= 8 && p.length <= 63) cands.push(p);
    }

    // 关键：只用**拼音/英文别名**拼后缀，绝不用中文品牌名。
    //
    // 踩过的坑：一开始用 brandNorm(rule.brand) + 后缀，
    // 结果生成了「蜜雪冰城8888」「蜜雪冰城123456」这种候选并入库。
    // 门店几乎不会把 WiFi 密码设成中文（手机输入法切起来太麻烦），
    // 这类数据进库只会污染排序、拉低可信度。
    const suffixes = rule.suffixes || [];
    const aliasBases = [];
    for (const a of (rule.aliases || [])) {
      const an = String(a).toLowerCase().replace(/[\s\-_]/g, '');
      // 只收 ASCII 的（拼音 / 英文），且至少 3 个字符
      if (an.length >= 3 && /^[a-z0-9]+$/.test(an)) aliasBases.push(an);
    }
    // 品牌名本身若是纯拼音/英文，也可以当基底
    const bn = brandNorm(rule.brand);
    if (/^[a-z0-9]+$/.test(bn) && bn.length >= 3) aliasBases.push(bn);

    for (const base of [...new Set(aliasBases)]) {
      for (const suf of suffixes) {
        const v = base + suf;
        if (v.length >= 8 && v.length <= 63) cands.push(v);
      }
    }

    // 去重、限量（避免一个 target 灌几十条没验证过的密码）
    const uniq = [...new Set(cands)].slice(0, 8);

    if (uniq.length === 0) {
      stats.unmatched++;
      try {
        await env.DB.prepare(
          `UPDATE harvest_target
              SET status = 'failed', attempts = attempts + 1,
                  last_error = 'no_candidate', updated_at = ?
            WHERE id = ?`,
        ).bind(t, tg.id).run();
      } catch (_) { stats.failed++; }
      continue;
    }

    // 批量写 wifi（source=derived：规则推导，不是实测也不是外部采集）
    for (const psk of uniq) {
      try {
        await env.DB.prepare(
          `INSERT INTO wifi
             (ssid, ssid_norm, psk, brand, source, confidence, hit_count, fail_count,
              status, geohash, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'derived', 1, 0, 0, 'active', '', ?, ?)
           ON CONFLICT(ssid_norm, psk, geohash) DO UPDATE SET
             confidence = confidence + 1,
             updated_at = excluded.updated_at`,
        ).bind(tg.ssid, norm, psk, rule.brand, t, t).run();
        stats.inserted++;
      } catch (_) { stats.failed++; }
    }

    try {
      await env.DB.prepare(
        `UPDATE harvest_target SET status = 'done', updated_at = ? WHERE id = ?`,
      ).bind(t, tg.id).run();
    } catch (_) { stats.failed++; }
  }

  return stats;
}

/** normSsid 对空串的保护 */
function sentinelNorm(s) {
  try { return normSsid(s || ''); } catch { return ''; }
}

/** 手动触发一轮自动采集（带 token） */
async function handleAutoCollect(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!env.COLLECT_TOKEN || token !== env.COLLECT_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
  const stats = await autoCollect(env, limit);
  return json({ ok: true, ...stats });
}

/**
 * 用户匿名贡献密码：三层都没试出来时，鼓励用户看一眼墙上的密码贴上来。
 *
 * 设计取舍：
 *   - confidence 给 2（不是 3）—— 用户「看到」不等于「验证过」，
 *     但它比规则推导（derived=1）可信，因为它来自真实场景的目视。
 *     如果之后有别的用户用它连上了，hit_count 会把它推上去。
 *   - source='crowd'，和 harvest / derived / report 分开，
 *     这样以后能单独统计「众包贡献」这条渠道的效果。
 *   - 不做账号绑定，不存任何设备标识，只收 ssid + psk。
 *     匿名是这个功能能成立的前提——用户是在帮忙，不该留痕。
 *
 * 防滥用只做最低限度：长度校验 + 重复提交合并 + 明显垃圾字符过滤。
 * 早期用户量小，过度设限的代价（挡住真心帮忙的人）比收益大。
 */
async function handleContribute(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const ssid = String(body.ssid || '').trim();
  const psk = String(body.psk || '').trim();
  if (!ssid) return json({ error: 'missing ssid' }, 400);
  if (!validPsk(psk)) {
    return json({ error: 'bad psk', hint: '密码长度需在 8-63 之间' }, 400);
  }

  // 明显垃圾：全同一个字符（88888888 这种其实是真密码，所以要排除常见弱口令再判）
  const COMMON = new Set(['88888888', '12345678', '66666666', '00000000', '123456789', '11111111', '12341234']);
  if (!COMMON.has(psk) && new Set(psk).size === 1) {
    return json({ error: 'bad psk', hint: '看起来不是有效密码' }, 400);
  }
  // 含控制字符或超长重复
  if (/[\x00-\x1f]/.test(psk)) {
    return json({ error: 'bad psk' }, 400);
  }

  const norm = normSsid(ssid);
  const t = Date.now();

  // 同一个 SSID 的众包密码，先查有没有重复
  let existed = false;
  try {
    const r = await env.DB.prepare(
      `SELECT id FROM wifi WHERE ssid_norm = ? AND psk = ? LIMIT 1`,
    ).bind(norm, psk).first();
    existed = !!r;
  } catch (_) { /* 查不到就当新的 */ }

  try {
    await env.DB.prepare(
      `INSERT INTO wifi
         (ssid, ssid_norm, psk, source, confidence, hit_count, fail_count,
          status, geohash, created_at, updated_at)
       VALUES (?, ?, ?, 'crowd', 2, 0, 0, 'active', '', ?, ?)
       ON CONFLICT(ssid_norm, psk, geohash) DO UPDATE SET
         confidence = MAX(confidence, 2),
         updated_at = excluded.updated_at`,
    ).bind(ssid, norm, psk, t, t).run();
  } catch (e) {
    return json({ error: 'db_error', detail: String(e) }, 500);
  }

  // 记一笔，便于统计众包贡献的量。
  // 注意 report 表**只有 ssid_norm，没有 ssid**（当初建表时就这么定的），
  // 这里写 ssid 会直接报 no such column。
  try {
    await env.DB.prepare(
      `INSERT INTO report (ssid_norm, psk, kind, reporter, geohash, created_at)
       VALUES (?, ?, 'contribute', NULL, '', ?)`,
    ).bind(norm, psk, t).run();
  } catch (_) { /* 流水失败不影响主流程 */ }

  return json({
    ok: true,
    accepted: true,
    duplicate: existed,
    // 给 App 显示的话术，让用户知道帮到了什么
    message: existed
      ? '这条密码库里已经有了，还是谢谢你看了一眼'
      : '已收下，下一个人在这家店会省几分钟',
  });
}

/**
 * 批量查询：一次问多个 SSID 有没有密码。
 *
 * 为什么需要它：小程序扫到周围可能有 10-20 个网络，
 * 一个个查要发 20 个请求，手机流量和等待时间都不划算。
 * 一次批量查完，前端可以立刻标出「哪些能连」。
 *
 * 有意限制最多 30 个：再多就是滥用，正常一次扫描不会超过这个数。
 */
async function handleLookupBatch(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const list = Array.isArray(body.ssids) ? body.ssids : [];
  if (list.length === 0) return json({ error: 'missing ssids' }, 400);
  if (list.length > 30) return json({ error: 'too many', max: 30 }, 400);

  const limit = Math.min(parseInt(env.MAX_CANDIDATES || '20', 10), 50);
  const out = {};

  // 规则包只读一次，供整批 SSID 复用（否则 30 个 SSID 要读 30 次库）
  const rules = await loadBrandRules(env);

  for (const raw of list) {
    const ssid = String(raw || '').trim();
    if (!ssid) continue;
    const ssidNorm = normSsid(ssid);
    if (!ssidNorm) continue;

    try {
      const r = await env.DB.prepare(
        `SELECT psk, source, confidence, hit_count
           FROM wifi
          WHERE ssid_norm = ?1 AND status = 'active' AND fail_count < 3
          ORDER BY (hit_count * 10) + (confidence * 3) DESC
          LIMIT ?2`,
      ).bind(ssidNorm, limit).all();

      let rows = r.results || [];
      let matchType = rows.length > 0 ? 'exact' : null;
      let matchedBrand = null;

      // 精准没中 → 品牌模糊匹配（和单个查询保持同一套规则）
      if (rows.length === 0) {
        const hits = brandsFromSsid(rules, ssid);
        if (hits.length) {
          matchedBrand = hits[0].brand;
          const alias = hits[0].hitAlias;
          const br = await env.DB.prepare(
            `SELECT psk, source, confidence, hit_count
               FROM wifi
              WHERE status = 'active' AND fail_count < 3
                AND (brand = ?1 OR ssid_norm LIKE ?2)
              ORDER BY (hit_count * 10) + (confidence * 3) DESC
              LIMIT ?3`,
          ).bind(matchedBrand, `%${alias}%`, limit).all();
          rows = br.results || [];
          if (rows.length) matchType = 'brand';
        }
      }

      if (rows.length > 0) {
        out[ssid] = {
          count: rows.length,
          // 只回第一个密码就够了（扫列表页只需要知道"有没有、能不能自动试"）
          top: rows[0].psk,
          source: rows[0].source,
          hits: rows[0].hit_count,
          match: matchType,
          brand: matchedBrand,
        };
      } else {
        out[ssid] = { count: 0 };
      }
    } catch (_) {
      out[ssid] = { count: 0, error: true };
    }
  }

  return json({ ok: true, results: out, checked: Object.keys(out).length });
}

async function handleStats(env) {
  const q = async (sql) => {
    try {
      const r = await env.DB.prepare(sql).first();
      return r ? Object.values(r)[0] : 0;
    } catch { return 0; }
  };
  // 按 source 分组，口径必须和 wifi_total 一致（都只算 active）。
  //
  // 之前这里是硬编码三个 source（harvest / report / merchant），
  // 漏了 derived，导致 wifi_total=36 但分项加起来只有 27，
  // 看起来像数据错乱。改成动态 GROUP BY，以后加新 source 不用改代码。
  let bySource = {};
  try {
    const r = await env.DB.prepare(
      `SELECT source, COUNT(*) AS n FROM wifi WHERE status='active' GROUP BY source`,
    ).all();
    for (const row of (r.results || [])) {
      bySource[row.source || 'unknown'] = row.n;
    }
  } catch (_) { /* 统计失败不影响主流程 */ }

  return json({
    wifi_total: await q(`SELECT COUNT(*) FROM wifi WHERE status='active'`),
    wifi_by_source: bySource,
    targets_pending: await q(`SELECT COUNT(*) FROM harvest_target WHERE status='pending'`),
    targets_failed: await q(`SELECT COUNT(*) FROM harvest_target WHERE status='failed'`),
    reports: await q(`SELECT COUNT(*) FROM report`),
    checkups: await q(`SELECT COUNT(*) FROM checkup`),
  });
}

// ── 规则包热更新 ─────────────────────────────────────────────────
//
// 「广泛使用、点击即用」的前提是：改了密码库不用重新发版。
// App 启动时先问一句「现在规则包是第几版」，不同就下载覆盖。
//
// 规则包 = brand_rules.json（品牌别名 + 密码 + 后缀模板）
// 存 D1，附带版本号；App 端拿到后存 filesDir，优先于 APK 里的 assets。

async function handleRulesVersion(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT version, updated_at, note FROM rules_pack
       ORDER BY version DESC LIMIT 1`,
    ).first();
    if (!row) {
      return json({ version: 0, updated_at: null, note: 'no pack', brand_count: 0 });
    }
    const cnt = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM wifi WHERE status='active'`,
    ).first();
    return json({
      version: row.version,
      updated_at: row.updated_at,
      note: row.note,
      db_entries: cnt ? cnt.n : 0,
    });
  } catch (e) {
    return json({ version: 0, error: String(e) }, 500);
  }
}

async function handleRulesBlob(url, env) {
  try {
    const row = await env.DB.prepare(
      `SELECT version, blob, updated_at FROM rules_pack
       ORDER BY version DESC LIMIT 1`,
    ).first();
    if (!row) return json({ error: 'no pack' }, 404);
    // 直接返回 JSON 文本，App 端原样存盘
    return new Response(row.blob, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-rules-version': String(row.version),
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return json({ error: 'db_error', detail: String(e) }, 500);
  }
}

/** 上传新规则包（部署时用，需要 token） */
async function handleRulesPublish(req, env) {
  const token = req.headers.get('x-admin-token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { blob, note } = body || {};
  if (!blob) return json({ error: 'missing blob' }, 400);

  try {
    // 校验是一次合法 JSON
    JSON.parse(typeof blob === 'string' ? blob : JSON.stringify(blob));
  } catch {
    return json({ error: 'blob is not valid json' }, 400);
  }

  const t = now();
  const prev = await env.DB.prepare(
    `SELECT version FROM rules_pack ORDER BY version DESC LIMIT 1`,
  ).first();
  const nextVer = (prev ? prev.version : 0) + 1;

  await env.DB.prepare(
    `INSERT INTO rules_pack (version, blob, note, updated_at) VALUES (?, ?, ?, ?)`,
  ).bind(nextVer, typeof blob === 'string' ? blob : JSON.stringify(blob),
    note || null, t).run();

  return json({ ok: true, version: nextVer });
}

// ── 入口 ────────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === 'OPTIONS') return json({ ok: true });

    try {
      if (p === '/v1/lookup' && req.method === 'GET') return handleLookup(url, env);
      if (p === '/v1/lookup/batch' && req.method === 'POST') return handleLookupBatch(req, env);
      if (p === '/v1/report' && req.method === 'POST') return handleReport(req, env);
      if (p === '/v1/harvest/targets' && req.method === 'GET') return handleHarvestTargets(url, env);
      if (p === '/v1/harvest/result' && req.method === 'POST') return handleHarvestResult(req, env);
      if (p === '/v1/merchant/claim' && req.method === 'POST') return handleMerchantClaim(req, env);
      if (p === '/v1/stats' && req.method === 'GET') return handleStats(env);
      if (p === '/v1/rules/version' && req.method === 'GET') return handleRulesVersion(env);
      if (p === '/v1/rules/blob' && req.method === 'GET') return handleRulesBlob(url, env);
      if (p === '/v1/rules/publish' && req.method === 'POST') return handleRulesPublish(req, env);
      if (p === '/v1/speedtest/payload' && req.method === 'GET') return handleSpeedtestPayload(url);
      if (p === '/v1/checkup/report' && req.method === 'POST') return handleCheckupReport(req, env);
      if (p === '/v1/checkup/rank' && req.method === 'GET') return handleCheckupRank(url, env);
      if (p === '/v1/collect/next' && req.method === 'GET') return handleCollectNext(url, env);
      if (p === '/v1/collect/done' && req.method === 'POST') return handleCollectDone(req, env);
      if (p === '/v1/collect/auto' && req.method === 'POST') return handleAutoCollect(url, env);
      if (p === '/v1/contribute' && req.method === 'POST') return handleContribute(req, env);
      if (p === '/' || p === '/health') {
        return json({ ok: true, service: 'walking-wifi-api', version: '0.1.0' });
      }
      return json({ error: 'not found', path: p }, 404);
    } catch (e) {
      return json({ error: 'internal', detail: String(e) }, 500);
    }
  },

  /**
   * Cloudflare Cron 触发：让后端自己「一直更新密码库」。
   *
   * 每轮做的事：取待办 SSID → 用最新规则包做品牌匹配 →
   * 命中的把密码写进 wifi 表 → 未命中的标记 failed 等规则包更新。
   *
   * 为什么要靠 Cron 而不是靠 App：App 只在上线时跑，
   * 用户查完一个 SSID 就走，没机会等结果。后端自己跑才能补上。
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const stats = await autoCollect(env, 20);
          console.log('cron autoCollect', JSON.stringify(stats));
        } catch (e) {
          console.log('cron autoCollect failed', String(e));
        }
      })(),
    );
  },
};
