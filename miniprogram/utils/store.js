/**
 * 本地存储层（无后端）
 * 数据结构：records 数组，每条是一条「店的 WiFi 信息」
 */
const { SEED } = require('../data/seed.js')

const KEY = 'ww_records_v1'
const META_KEY = 'ww_meta_v1'
// 种子数据版本号：改 seed.js 时 +1，会触发重新注入
const SEED_VERSION = 2

function now() {
  return Date.now()
}

function init() {
  const meta = wx.getStorageSync(META_KEY)
  const current = wx.getStorageSync(KEY) || []
  // 版本号一致且记录数不落后 → 不重复注入（用户自录的数据不能被冲掉）
  if (meta && meta.version === SEED_VERSION && current.length >= SEED.length) return

  const userRecords = current.filter((r) => r.custom)
  const seeded = SEED.map((s, i) => ({
    ...s,
    custom: false,
    verified: 0,      // 0=未验证 1=用户验证过
    createdAt: now(),
    order: i,
  }))
  // 用户自己录的记录保留在前面
  const records = [...userRecords, ...seeded]
  wx.setStorageSync(KEY, records)
  wx.setStorageSync(META_KEY, { version: SEED_VERSION, seededAt: now() })
}

function all() {
  return wx.getStorageSync(KEY) || []
}

function save(list) {
  wx.setStorageSync(KEY, list)
}

function byId(id) {
  return all().find((r) => r.id === id) || null
}

/**
 * 按关键词搜索。
 * 命中顺序：店名完全匹配 > 店名包含 > 关键词命中 > SSID 命中
 */
function search(kw) {
  const q = (kw || '').trim().toLowerCase()
  const list = all()
  if (!q) {
    // 无关键词时：自定义的 + 高可信度的排前面
    return list.slice().sort((a, b) => {
      if (a.custom !== b.custom) return a.custom ? -1 : 1
      if (a.verified !== b.verified) return b.verified - a.verified
      return (b.confidence || 0) - (a.confidence || 0)
    })
  }

  const scored = []
  for (const r of list) {
    const name = (r.name || '').toLowerCase()
    let score = 0
    if (name === q) score = 100
    else if (name.includes(q)) score = 80
    else if ((r.keywords || []).some((k) => k.toLowerCase().includes(q))) score = 60
    else if ((r.ssidPatterns || []).some((s) => s.toLowerCase().includes(q))) score = 50
    else if ((r.note || '').toLowerCase().includes(q)) score = 20
    if (score > 0) {
      if (r.verified) score += 15
      if (r.custom) score += 10
      scored.push({ r, score })
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.r)
}

/** 用当前连接的 SSID 反查库里的记录 */
function matchBySsid(ssid) {
  if (!ssid) return null
  const s = ssid.toLowerCase()
  for (const r of all()) {
    for (const p of r.ssidPatterns || []) {
      const pl = p.toLowerCase()
      if (s === pl || s.includes(pl) || pl.includes(s)) return r
    }
  }
  return null
}

function upsert(rec) {
  const list = all()
  const idx = list.findIndex((r) => r.id === rec.id)
  const merged = {
    verified: 0,
    confidence: 2,
    portal: false,
    passwords: [],
    ssidPatterns: [],
    keywords: [],
    custom: true,
    createdAt: now(),
    ...rec,
  }
  if (idx >= 0) list[idx] = { ...list[idx], ...merged, updatedAt: now() }
  else list.unshift({ ...merged, order: -1 })
  save(list)
  return merged.id
}

function remove(id) {
  save(all().filter((r) => r.id !== id))
}

function markVerified(id) {
  const list = all()
  const r = list.find((x) => x.id === id)
  if (r) {
    r.verified = 1
    r.verifiedAt = now()
    save(list)
  }
}

function stats() {
  const list = all()
  return {
    total: list.length,
    verified: list.filter((r) => r.verified).length,
    custom: list.filter((r) => r.custom).length,
  }
}

module.exports = { init, all, search, byId, upsert, remove, markVerified, matchBySsid, stats }
