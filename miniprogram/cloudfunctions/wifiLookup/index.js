/**
 * 微信云函数：门店公用网络口令查询
 *
 * 为什么要有这个云函数（而不是继续用 Cloudflare Worker）：
 *   微信小程序正式版强制校验「request 合法域名」，该域名必须完成 ICP 备案。
 *   本项目的 api.lilcandi.xyz 跑在 Cloudflare 上，境外注册 + 境外托管，
 *   拿不到 ICP 备案，因此永远无法加入白名单 —— 正式版请求会被直接拦下
 *   （实测报错：request:fail url not in domain list）。
 *
 *   微信云开发调用不走域名校验，官方明确「不需要域名、也不需要域名备案」，
 *   所以把查询逻辑搬到这里，是当前架构下唯一能上架的路径。
 *
 * 数据来源：data.json（由 backend/tools/build-cloud-data.js 生成，107 品牌）
 */
const DATA = require('./data.json');

// ────────────────────────────────────────────────────────
//  归一化与匹配（与 Cloudflare Worker 版保持同一套规则）
// ────────────────────────────────────────────────────────

/** SSID 归一化：小写、去引号、去频段后缀、去分隔符 */
function normSsid(s) {
  if (!s) return '';
  let t = String(s).trim().replace(/^"|"$/g, '').toLowerCase();
  t = t.replace(/[-_ ]?(5g|2\.4g|2g|6g)$/i, '');
  t = t.replace(/[\s\-_]/g, '');
  return t;
}

function aliasNorm(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_·.]/g, '');
}

/**
 * 从 SSID 反推品牌。
 * 中文别名阈值 1 字符（「如家」两字也有效），英文阈值 3 字符（防「mc」误伤）。
 * 按命中别名长度降序，长别名更可信。
 */
function brandsFromSsid(brands, ssid) {
  const n = normSsid(ssid);
  if (!n) return [];
  const hits = [];
  for (const b of brands) {
    const aliases = (b.a && b.a.length) ? b.a : [b.b];
    let best = null;
    for (const a of aliases) {
      const an = aliasNorm(a);
      const isCjk = /[\u4e00-\u9fa5]/.test(a);
      if (an.length < (isCjk ? 1 : 3)) continue;
      if (n.includes(an)) {
        if (!best || an.length > best.length) best = an;
      }
    }
    if (best) hits.push({ brand: b.b, hitAlias: best, item: b });
  }
  return hits.sort((x, y) => y.hitAlias.length - x.hitAlias.length);
}

/** 单个 SSID 查询 */
function lookupOne(ssid, limit = 20) {
  const n = normSsid(ssid);
  if (!n) return { ssid, count: 0, match_type: null, matched_brand: null, candidates: [] };

  // 1) 精确匹配：品牌名归一化后完全相等，或品牌名就是该 SSID
  let exact = null;
  for (const b of DATA.brands) {
    if (aliasNorm(b.b) === n) { exact = b; break; }
    for (const a of (b.a || [])) {
      if (aliasNorm(a) === n) { exact = b; break; }
    }
    if (exact) break;
  }

  if (exact) {
    return {
      ssid,
      count: Math.min(exact.p.length, limit),
      match_type: 'exact',
      matched_brand: exact.b,
      candidates: exact.p.slice(0, limit).map((psk) => ({
        psk, source: 'builtin', confidence: exact.c || 1,
      })),
    };
  }

  // 2) 品牌模糊匹配
  const hits = brandsFromSsid(DATA.brands, ssid);
  if (hits.length) {
    const h = hits[0];
    return {
      ssid,
      count: Math.min(h.item.p.length, limit),
      match_type: 'brand',
      matched_brand: h.brand,
      candidates: h.item.p.slice(0, limit).map((psk) => ({
        psk, source: 'builtin', confidence: h.item.c || 1,
      })),
    };
  }

  return { ssid, count: 0, match_type: null, matched_brand: null, candidates: [] };
}

/** 批量查询：一次最多 30 个，和小程序扫描数量匹配 */
function lookupBatch(ssids, limit = 20) {
  const out = {};
  const list = Array.isArray(ssids) ? ssids.slice(0, 30) : [];
  for (const raw of list) {
    const ssid = String(raw || '').trim();
    if (!ssid) continue;
    const r = lookupOne(ssid, limit);
    out[ssid] = {
      count: r.count,
      top: r.candidates[0] ? r.candidates[0].psk : '',
      match: r.match_type,
      brand: r.matched_brand,
      source: 'builtin',
    };
  }
  return out;
}

// ────────────────────────────────────────────────────────
//  入口
// ────────────────────────────────────────────────────────

exports.main = async (event) => {
  const action = event && event.action;

  try {
    if (action === 'lookupBatch') {
      const results = lookupBatch(event.ssids);
      return {
        ok: true,
        results,
        checked: Object.keys(results).length,
        dataVersion: DATA.v,
      };
    }

    // 用户匿名贡献：写进云数据库集合 wifi_contrib。
    // 集合没建也不报错，只记录，不影响用户体验。
    if (action === 'contribute') {
      const ssid = String((event && event.ssid) || '').trim();
      const psk = String((event && event.psk) || '').trim();
      if (!ssid || !psk) return { ok: false, error: 'missing field' };
      if (psk.length < 8 || psk.length > 63) return { ok: false, error: 'invalid length' };

      let stored = false;
      try {
        const cloud = require('wx-server-sdk');
        cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
        const db = cloud.database();
        await db.collection('wifi_contrib').add({
          data: {
            ssid,
            ssid_norm: normSsid(ssid),
            psk,
            created_at: Date.now(),
          },
        });
        stored = true;
      } catch (_) {
        // 集合不存在或 wx-server-sdk 未装：静默降级，仍然回 ok，
        // 因为用户端已经把这条存进本地库了，他自己能立刻用上。
      }
      return { ok: true, stored };
    }

    // 默认单查
    const ssid = event && event.ssid;
    if (!ssid) return { ok: false, error: 'missing ssid' };

    const r = lookupOne(ssid, event.limit || 20);
    return {
      ok: true,
      ...r,
      dataVersion: DATA.v,
    };
  } catch (e) {
    return { ok: false, error: 'internal', detail: String(e && e.message) };
  }
};