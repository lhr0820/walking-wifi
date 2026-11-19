/**
 * 查询入口：统一封装「云函数 → 本地库」的降级链。
 *
 * 为什么要这一层：
 *   1. 上架后请求受域名白名单限制，Cloudflare 域名进不了白名单
 *      （实测 request:fail url not in domain list），
 *      所以正式版必须走微信云开发（不走域名校验）。
 *   2. 但云开发需要在小程序后台开通，且可能因环境未配置而失败。
 *   3. 本地种子库（126 条 / 836 条口令）永远可用。
 *
 * 所以顺序是：**云函数 → 本地库**，任一环节失败都不让用户看到白屏。
 */
const store = require('./store.js');

/**
 * 云开发开关。
 *
 * 现在设为 false。原因：
 *   云开发尚未在小程序后台开通（cli cloud env list 返回 ret:1000），
 *   此时调 wx.cloud.init / callFunction 会在线上抛错。
 *   虽然已用 try-catch 兜住，但正式版里控制台堆错误日志不好看，
 *   审核员看到也可能多想。
 *
 * 所以当前版本**只用本地库**（126 条 / 836 个口令，覆盖 107 个品牌），
 * 完全不发网络请求 —— 也就天然绕开了「request 合法域名白名单」那道坎。
 *
 * 将来开通云开发后，把这里改成 true 即可，其余代码不用动。
 */
const USE_CLOUD = false;

let cloudReady = null;   // null=未探测 / true / false

/** 探测云开发是否可用（只探一次） */
function canUseCloud() {
  if (!USE_CLOUD) return false;
  if (cloudReady !== null) return cloudReady;
  try {
    if (typeof wx === 'undefined' || !wx.cloud) {
      cloudReady = false;
      return false;
    }
    cloudReady = true;
    return true;
  } catch (_) {
    cloudReady = false;
    return false;
  }
}

/** 初始化云开发（幂等） */
let inited = false;
function ensureInit() {
  if (inited) return true;
  try {
    if (!wx.cloud) return false;
    wx.cloud.init({
      // DYNAMIC_CURRENT_ENV 表示用当前所处环境，不用硬编码 env id
      env: wx.cloud.DYNAMIC_CURRENT_ENV,
      traceUser: false,
    });
    inited = true;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 查单个网络名/店名。
 * @returns {Promise<{source:'cloud'|'local'|'none', count, match_type, matched_brand, candidates}>}
 */
function lookup(ssid) {
  const kw = String(ssid || '').trim();
  if (!kw) return Promise.resolve({ source: 'none', count: 0, candidates: [] });

  // ① 云函数
  if (canUseCloud() && ensureInit()) {
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'wifiLookup',
        data: { action: 'lookup', ssid: kw },
        success: (res) => {
          const d = (res && res.result) || {};
          if (d.ok && d.count > 0) {
            resolve({
              source: 'cloud',
              count: d.count,
              match_type: d.match_type,
              matched_brand: d.matched_brand,
              candidates: d.candidates || [],
            });
          } else {
            // 云端没结果，再试本地（可能本地有云端没有的条目）
            const local = localLookup(kw);
            resolve(local.count > 0 ? local : {
              source: 'none', count: 0, match_type: null,
              matched_brand: d.matched_brand || null, candidates: [],
            });
          }
        },
        fail: () => resolve(localLookup(kw)),
      });
    });
  }

  // ② 本地
  return Promise.resolve(localLookup(kw));
}

/** 批量查（扫描页用）。返回 {ssid: {count, top, match, brand}} */
function lookupBatch(ssids) {
  const list = (Array.isArray(ssids) ? ssids : []).filter(Boolean).slice(0, 30);
  if (!list.length) return Promise.resolve({ source: 'none', results: {} });

  if (canUseCloud() && ensureInit()) {
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'wifiLookup',
        data: { action: 'lookupBatch', ssids: list },
        success: (res) => {
          const d = (res && res.result) || {};
          if (d.ok) {
            // 云端为 0 的补一次本地
            const results = d.results || {};
            for (const s of list) {
              if (!results[s] || !results[s].count) {
                const l = localLookup(s);
                if (l.count > 0) {
                  results[s] = {
                    count: l.count,
                    top: l.candidates[0] ? l.candidates[0].psk : '',
                    match: l.match_type,
                    brand: l.matched_brand,
                    source: 'local',
                  };
                }
              }
            }
            resolve({ source: 'cloud', results });
          } else {
            resolve(localBatch(list));
          }
        },
        fail: () => resolve(localBatch(list)),
      });
    });
  }

  return Promise.resolve(localBatch(list));
}

/** 本地库查询（复用 store.js 的 search） */
function localLookup(kw) {
  try {
    const hits = store.search ? store.search(kw) : [];
    if (!hits.length) return { source: 'none', count: 0, match_type: null, matched_brand: null, candidates: [] };

    // 取命中最具体的一条（密码最多的）
    const best = hits.slice().sort(
      (a, b) => (b.passwords || []).length - (a.passwords || []).length,
    )[0];

    return {
      source: 'local',
      count: (best.passwords || []).length,
      match_type: 'local',
      matched_brand: best.name,
      candidates: (best.passwords || []).map((psk) => ({ psk, source: 'local', confidence: best.confidence || 1 })),
    };
  } catch (_) {
    return { source: 'none', count: 0, match_type: null, matched_brand: null, candidates: [] };
  }
}

function localBatch(list) {
  const results = {};
  for (const s of list) {
    const l = localLookup(s);
    results[s] = {
      count: l.count,
      top: l.candidates[0] ? l.candidates[0].psk : '',
      match: l.match_type || '',
      brand: l.matched_brand || '',
      source: 'local',
    };
  }
  return { source: 'local', results };
}

/**
 * 匿名贡献一条。
 * 逻辑：本地库先存（用户自己立刻能用），再试着上报云函数（帮到别人）。
 * 上报失败不影响用户 —— 他填完就能查到。
 */
function contribute(ssid, psk) {
  const s = String(ssid || '').trim();
  const p = String(psk || '').trim();

  // ① 本地先落，保证用户立刻能用
  try {
    if (store.upsert) {
      store.upsert({
        id: `contrib-${Date.now()}`,
        name: s,
        keywords: [s],
        ssidPatterns: [s.toUpperCase(), s],
        passwords: [p],
        portal: false,
        confidence: 1,
        note: '你自己贡献的',
      });
    }
  } catch (_) { /* 本地存不进去不影响上报 */ }

  // ② 再上报云端
  if (canUseCloud() && ensureInit()) {
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'wifiLookup',
        data: { action: 'contribute', ssid: s, psk: p },
        success: (res) => resolve({ ok: true, source: 'cloud', stored: !!(res && res.result && res.result.stored) }),
        fail: () => resolve({ ok: true, source: 'local', stored: false }),
      });
    });
  }
  return Promise.resolve({ ok: true, source: 'local', stored: false });
}

module.exports = { lookup, lookupBatch, contribute, canUseCloud };