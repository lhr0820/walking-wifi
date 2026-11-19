/**
 * 把 brand_rules.json（107 品牌）同步进小程序本地种子库 seed.js。
 *
 * 为什么要这一步：
 *   云端 D1 需要 Cloudflare token（现在过期了），
 *   但小程序本来就有离线本地库。
 *   把数据灌进本地库，功能立刻可用，不等云端。
 *
 * 做法：读现有 seed.js（保留手工写的 64 条），
 * 再把 brand_rules 里有、seed 里没有的品牌补进去。
 */
const fs = require('fs');
const path = require('path');

const SEED_PATH = 'K:\\WIFI\\walking-wifi\\miniprogram\\data\\seed.js';
const RULES_PATH = 'K:\\WIFI\\walking-wifi\\app\\src\\main\\assets\\brand_rules.json';

// 读现有 seed（65 条，含手工注释和 note）
delete require.cache[require.resolve(SEED_PATH)];
const { SEED: OLD } = require(SEED_PATH);
const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));

// 建立「已覆盖的品牌」索引
const byName = new Map(OLD.map((x) => [String(x.name), x]));
const coveredKeys = new Set();
for (const x of OLD) {
  for (const k of (x.keywords || [])) coveredKeys.add(String(k).toLowerCase());
  for (const p of (x.ssidPatterns || [])) coveredKeys.add(String(p).toLowerCase());
}

// id 生成：优先用英文别名，退化用序号
function makeId(b, i) {
  const en = (b.aliases || []).find((a) => /^[a-z0-9\-]+$/i.test(a));
  const base = en ? String(en).toLowerCase().replace(/[^a-z0-9]/g, '') : `b${i}`;
  return `brand-${base || 'x' + i}`;
}

const usedIds = new Set(OLD.map((x) => x.id));
const ADD = [];
let merged = 0;

rules.brands.forEach((b, i) => {
  const psks = (b.psks || []).filter(Boolean);
  if (!psks.length) return;

  const aliases = (b.aliases || []).filter(Boolean);
  const existing = byName.get(b.brand);

  // ── 情况 A：本地已有这个品牌 → 补齐别名和密码，不跳过 ──
  //
  // 之前的写法是「已有就跳过」，结果 mxbc 这种别名没补进去，
  // 用户搜 mxbc 查不到蜜雪冰城——这是真 bug，实测发现。
  if (existing) {
    const oldKw = new Set((existing.keywords || []).map((x) => String(x).toLowerCase()));
    const oldSsid = new Set((existing.ssidPatterns || []).map((x) => String(x).toLowerCase()));
    const oldPsk = new Set(existing.passwords || []);
    let changed = false;

    for (const a of [b.brand, ...aliases]) {
      if (!oldKw.has(String(a).toLowerCase())) {
        existing.keywords.push(String(a));
        oldKw.add(String(a).toLowerCase());
        changed = true;
      }
      // SSID 形态：大写 & 原样
      for (const form of [String(a).toUpperCase(), String(a)]) {
        if (!oldSsid.has(form.toLowerCase())) {
          existing.ssidPatterns.push(form);
          oldSsid.add(form.toLowerCase());
          changed = true;
        }
      }
    }
    for (const p of psks) {
      if (!oldPsk.has(p)) { existing.passwords.push(p); oldPsk.add(p); changed = true; }
    }
    if (changed) {
      merged++;
      existing.confidence = Math.max(existing.confidence || 1, b.harvest_confidence === 2 ? 2 : 1);
    }
    return;
  }

  // ── 情况 B：本地没有 → 新增 ──
  if (aliases.some((k) => coveredKeys.has(String(k).toLowerCase()))) return;

  let id = makeId(b, i);
  let n = 1;
  while (usedIds.has(id)) id = `${makeId(b, i)}-${n++}`;
  usedIds.add(id);

  const keywords = [b.brand, ...aliases].filter(Boolean);
  const ssidPatterns = [];
  for (const a of aliases) {
    ssidPatterns.push(String(a).toUpperCase());
    ssidPatterns.push(String(a));
  }
  ssidPatterns.push(b.brand);

  const conf = b.harvest_confidence === 2 ? 2 : 1;
  const note = b.venue
    ? '这类场所的通用密码，不分品牌'
    : b.calculated
      ? '按品牌命名规律推算，不一定对'
      : b.harvest_confidence === 2
        ? '多源交叉验证过的常见密码'
        : '公开经验值，不一定对';

  ADD.push({
    id,
    name: b.brand,
    keywords: [...new Set(keywords)],
    ssidPatterns: [...new Set(ssidPatterns)].slice(0, 10),
    passwords: psks.slice(0, 12),
    portal: false,
    confidence: conf,
    note,
  });
});

const ALL = [...OLD, ...ADD];

// ── 生成新 seed.js ────────────────────────────────────────────
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const fmtArr = (arr) => '[' + arr.map((x) => `'${esc(x)}'`).join(', ') + ']';

const lines = [
  '/**',
  ' * 种子数据：常见连锁品牌/公共场所的 WiFi 公开信息',
  ' *',
  ' * 字段说明：',
  ' *   name          店名',
  ' *   keywords      搜索关键词（用户输入什么能命中）',
  ' *   ssidPatterns  可能的 SSID 名称（含部分匹配）',
  ' *   passwords     可能的密码；空字符串表示「开放网络，无需密码」',
  ' *   portal        是否需要网页/短信认证',
  ' *   confidence    1=不确定 2=常见 3=公开常识级',
  ' *   note          给用户的说明',
  ' *',
  ' * 数据来源（2026-11-18 扩充）：',
  ' *   新浪/微博/X/tina.chat 多源交叉验证的真实密码',
  ' *   + 按品牌命名规律计算的候选（note 会标明「推算」）',
  ' *',
  ' * 重要：所有密码都是「公开可查的经验值」，不保证准确。',
  ' * 用户实测连上后点「我连上了」，才会被标记为已验证。',
  ' */',
  'const SEED = [',
];

for (const x of ALL) {
  lines.push(
    `  { id: '${esc(x.id)}', name: '${esc(x.name)}', keywords: ${fmtArr(x.keywords || [])},`,
  );
  lines.push(
    `    ssidPatterns: ${fmtArr(x.ssidPatterns || [])}, passwords: ${fmtArr(x.passwords || [])},` +
    ` portal: ${x.portal ? 'true' : 'false'}, confidence: ${x.confidence || 1}, note: '${esc(x.note || '')}' },`,
  );
}

lines.push(']');
lines.push('');
lines.push('module.exports = { SEED }');
lines.push('');

fs.writeFileSync(SEED_PATH, lines.join('\n'), 'utf8');

console.log(`原有条目: ${OLD.length}`);
console.log(`新增品牌: ${ADD.length}`);
console.log(`合计: ${ALL.length}`);
console.log(`文件大小: ${fs.statSync(SEED_PATH).size} 字节`);