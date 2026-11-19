/**
 * 验证本地种子库的模糊匹配能力。
 *
 * 用户需求：「不需要名字完全相同，比如只要有 MIXUE 等字样的就是蜜雪冰城的 wifi」
 * 所以测试要覆盖：中文名、拼音、英文名、缩写、片段。
 */
const path = 'K:\\WIFI\\walking-wifi\\miniprogram\\data\\seed.js';
const { SEED } = require(path);

/** 复刻 store.js 的匹配逻辑：关键词 + SSID 模式双向包含 */
function search(kw) {
  const k = String(kw || '').toLowerCase().trim();
  if (!k) return [];
  const out = [];
  for (const item of SEED) {
    let hit = false;
    for (const x of (item.keywords || [])) {
      const v = String(x).toLowerCase();
      if (v.includes(k) || k.includes(v)) { hit = true; break; }
    }
    if (!hit) {
      for (const p of (item.ssidPatterns || [])) {
        const v = String(p).toLowerCase();
        if (v.includes(k) || k.includes(v)) { hit = true; break; }
      }
    }
    // 品牌名本身也算
    if (!hit && String(item.name).toLowerCase().includes(k)) hit = true;
    if (hit) out.push(item);
  }
  return out;
}

const CASES = [
  // [搜索词, 期望命中, 说明]
  ['蜜雪', '蜜雪冰城', '中文片段'],
  ['MIXUE', '蜜雪冰城', '英文别名'],
  ['mxbc', '蜜雪冰城', '拼音缩写'],
  ['瑞幸', '瑞幸咖啡', '中文名'],
  ['luckin', '瑞幸咖啡', '英文名'],
  ['星巴克', '星巴克', '中文全名'],
  ['starbucks', '星巴克', '英文别名'],
  ['肯德基', '肯德基', '中文名'],
  ['KFC', '肯德基', '英文缩写'],
  ['麦当劳', '麦当劳', '中文名'],
  ['海底捞', '海底捞', '中文名'],
  ['喜茶', '喜茶', '中文名'],
  ['霸王茶姬', '霸王茶姬', '中文名'],
  ['chagee', '霸王茶姬', '英文名'],
  ['华莱士', '华莱士', '中文名'],
  ['汉堡王', '汉堡王', '中文名'],
  ['德克士', '德克士', '新增品牌'],
  ['dicos', '德克士', '新增英文'],
  ['如家', '如家酒店', '酒店'],
  ['汉庭', '汉庭酒店', '酒店'],
  ['全季', '全季酒店', '酒店'],
  ['亚朵', '亚朵酒店', '酒店'],
  ['大润发', '大润发', '超市'],
  ['rtmart', '大润发', '超市英文'],
  ['屈臣氏', '屈臣氏', '美妆'],
  ['泡泡玛特', '泡泡玛特', '零售'],
  ['乐刻', '乐刻健身', '健身'],
  ['Manner', 'Manner', '咖啡'],
  ['mstand', 'M Stand', '咖啡'],
  ['茶颜', '茶颜悦色', '茶饮'],
  ['胖东来', '胖东来', '超市'],
  ['甜啦啦', '甜啦啦', '新增茶饮'],
  ['德克士腿', '德克士', '含多余字也能中'],
];

let pass = 0, fail = 0;
console.log('=== 本地库模糊匹配验证 ===\n');

for (const [kw, expect, kind] of CASES) {
  const hits = search(kw);
  const names = hits.map((x) => x.name);
  const found = names.includes(expect);
  const pskCount = found ? (hits.find((x) => x.name === expect).passwords || []).length : 0;

  if (found) {
    pass++;
    console.log(`✓ ${kw.padEnd(16)} → ${expect}（${pskCount} 个密码）  [${kind}]`);
  } else {
    fail++;
    console.log(`✗ ${kw.padEnd(16)} → 期望 ${expect}，实际命中: ${names.slice(0, 4).join('/') || '无'}  [${kind}]`);
  }
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);

// 统计
console.log(`\n本地库规模: ${SEED.length} 条`);
const totalPsks = SEED.reduce((s, x) => s + (x.passwords || []).length, 0);
console.log(`密码总数: ${totalPsks}`);
const withPsk = SEED.filter((x) => (x.passwords || []).length > 0).length;
console.log(`有条目的密码: ${withPsk} / ${SEED.length}`);

process.exit(fail > 0 ? 1 : 0);
