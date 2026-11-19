/**
 * 把最新的 brand_rules.json（107 品牌）发布到 D1 的 rules_pack 表。
 *
 * 为什么必须单独发布：
 *   wifi 表存的是「密码」，rules_pack 存的是「品牌别名规则」。
 *   后端做模糊匹配时读的是 rules_pack——
 *   不更新它，扫到「德克士腿」也匹配不到德克士品牌，
 *   即使 wifi 表里德克士的密码一条不少。
 *
 * 版本号：取现有最大 version + 1
 */
const fs = require('fs');

const RULES = 'K:\\WIFI\\walking-wifi\\app\\src\\main\\assets\\brand_rules.json';
const OUT = 'K:\\WIFI\\walking-wifi\\backend\\rules_pack_v3.sql';
const NEXT_VERSION = 3;

const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));
const blob = JSON.stringify(rules);
const ts = Math.floor(Date.now() / 1000);

// SQL 单引号转义
const esc = (s) => String(s).replace(/'/g, "''");

const brands = rules.brands.length;
const totalPsk = rules.brands.reduce((s, b) => s + (b.psks || []).length, 0);

const note = `v${NEXT_VERSION}：${brands} 品牌 ${totalPsk} 条密码；`
  + '新增茶饮/咖啡/快餐/火锅/便利店/超市/酒店/美妆/健身品类的别名规则，'
  + '支持 SSID 片段模糊匹配（如 MIXUE-WANDA → 蜜雪冰城）';

const sql = [
  `-- 发布规则包 v${NEXT_VERSION}：${brands} 品牌 / ${totalPsk} 条密码`,
  `-- 生成时间：${new Date().toISOString()}`,
  '',
  `INSERT INTO rules_pack (version, blob, note, updated_at)`,
  `VALUES (${NEXT_VERSION}, '${esc(blob)}', '${esc(note)}', ${ts});`,
  '',
].join('\n');

fs.writeFileSync(OUT, sql, 'utf8');

console.log(`规则包 v${NEXT_VERSION}`);
console.log(`品牌: ${brands}`);
console.log(`密码: ${totalPsk}`);
console.log(`blob 大小: ${(blob.length / 1024).toFixed(1)} KB`);
console.log(`SQL 文件: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
console.log(`输出: ${OUT}`);