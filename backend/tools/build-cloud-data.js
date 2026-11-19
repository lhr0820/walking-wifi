/**
 * 生成云函数用的数据包：把 107 品牌 / 792 条密码打包成 JSON。
 *
 * 为什么要打包进云函数，而不是用云数据库：
 *   1. 数据量很小（792 条 ≈ 90KB），打包进函数代码最简单
 *   2. 省掉「创建集合 + 导入数据 + 建索引」一整套流程
 *   3. 云函数冷启动时一次载入，后续常驻内存，比每次查库快
 *
 * 导出两个文件：
 *   data.json  —— 品牌规则（原名 + 别名 + 密码）
 *   index.js 里的匹配逻辑读它
 */
const fs = require('fs');

const RULES = 'K:\\WIFI\\walking-wifi\\app\\src\\main\\assets\\brand_rules.json';
const OUT_DIR = 'K:\\WIFI\\walking-wifi\\miniprogram\\cloudfunctions\\wifiLookup';

const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));

// 精简字段，减小体积：只保留匹配和返回需要的
const compact = rules.brands.map((b) => ({
  b: b.brand,                                    // brand
  a: (b.aliases || []).filter(Boolean),          // aliases
  p: (b.psks || []).filter((x) => x && x.length >= 8 && x.length <= 63),  // psks
  c: b.harvest_confidence === 2 ? 2 : 1,         // confidence
}));

const payload = {
  v: rules._updated || '2026-11-19',
  brands: compact,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = `${OUT_DIR}\\data.json`;
fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');

const size = fs.statSync(outPath).size;
const totalPsk = compact.reduce((s, b) => s + b.p.length, 0);

console.log(`品牌: ${compact.length}`);
console.log(`密码: ${totalPsk}`);
console.log(`data.json: ${(size / 1024).toFixed(1)} KB`);
console.log(`输出: ${outPath}`);
