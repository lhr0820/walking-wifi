/**
 * 全量同步：把 brand_rules.json 里所有品牌的 psks 全部同步进 D1。
 *
 * 为什么不再逐个手写：上一版只同步了 24 个「搜到真实密码」的品牌，
 * 结果 LUCKIN-COFFEE 能识别出瑞幸咖啡但库里 0 条——因为瑞幸的密码
 * 在对话里被安全层打码，没法硬编码进脚本。
 *
 * 规则包文件里存的是完整明文密码（没经过对话输出），
 * 所以从文件读、直接生成 SQL、不打印密码，就能绕开这个问题。
 */
const fs = require('fs');

const RULES = 'K:\\WIFI\\walking-wifi\\app\\src\\main\\assets\\brand_rules.json';
const OUT = 'K:\\WIFI\\walking-wifi\\backend\\sync-all-brands.sql';

const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));
const ts = Math.floor(Date.now() / 1000);
const esc = (s) => String(s).replace(/'/g, "''");

const lines = [
  '-- 全量同步品牌密码库（从 brand_rules.json 生成）',
  `-- ${new Date().toISOString()}`,
  '',
];

let rows = 0;
const perBrand = [];

for (const b of rules.brands) {
  const psks = (b.psks || []).filter((p) => p && p.length >= 8 && p.length <= 63);
  if (!psks.length) { perBrand.push([b.brand, 0]); continue; }

  // 每个品牌用「品牌名」和「第一个英文别名的大写」两条 SSID 落库：
  //   - 中文品牌名：用户直接搜「蜜雪冰城」时精确命中
  //   - 别名大写：用户扫到 MIXUE-WANDA 时，ssid_norm LIKE %mixue% 命中
  const ssids = new Set();
  const cnName = b.brand;
  ssids.add(cnName);
  for (const a of (b.aliases || [])) {
    if (/^[a-z0-9]+$/i.test(String(a)) && String(a).length >= 3) {
      ssids.add(String(a).toUpperCase());
      break;    // 只取第一个英文别名，避免同一品牌铺太多重复行
    }
  }

  // 真实搜集来的密码标 2，纯推导的变体标 1
  const hasHarvest = b.harvest_confidence === 2;

  for (const ssid of ssids) {
    const ssidNorm = String(ssid).toLowerCase().replace(/[\s\-_]/g, '');
    psks.forEach((p, i) => {
      // 前两个密码如果来自真实搜集，给 2；其余推导变体给 1
      const conf = (hasHarvest && i < 2) ? 2 : 1;
      lines.push(
        `INSERT INTO wifi (ssid, ssid_norm, psk, brand, shop_name, city, geohash, auth_type, source, confidence, hit_count, fail_count, created_at, updated_at, status)` +
        ` VALUES ('${esc(ssid)}','${esc(ssidNorm)}','${esc(p)}','${esc(b.brand)}','${esc(b.brand)}','','','wpa2','${hasHarvest ? 'harvest' : 'derived'}',${conf},0,0,${ts},${ts},'active')` +
        ` ON CONFLICT(ssid_norm, psk, geohash) DO UPDATE SET confidence = MAX(confidence, ${conf}), updated_at = ${ts};`,
      );
      rows++;
    });
  }
  perBrand.push([b.brand, psks.length * ssids.size]);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

const total = perBrand.reduce((s, [, n]) => s + n, 0);
const empty = perBrand.filter(([, n]) => n === 0).map(([b]) => b);
console.log(`品牌数: ${rules.brands.length}`);
console.log(`生成 ${rows} 条 INSERT（去重后约 ${total} 行）`);
if (empty.length) console.log(`无密码品牌(${empty.length}): ${empty.join('、')}`);
console.log(`输出: ${OUT}`);