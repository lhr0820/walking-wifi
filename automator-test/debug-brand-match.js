/** 复现后端品牌匹配逻辑，定位「如家801」为何匹配不到 */
const rules = require('K:\\WIFI\\walking-wifi\\app\\src\\main\\assets\\brand_rules.json').brands;

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

function brandsFromSsid(rules, ssid) {
  const n = normSsid(ssid);
  if (!n) return [];
  const hits = [];
  for (const b of rules) {
    const aliases = (b.aliases && b.aliases.length) ? b.aliases : [b.brand];
    let best = null;
    for (const a of aliases) {
      const an = aliasNorm(a);
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

for (const t of ['如家801', '如家', '汉庭3F', '德克士腿', '大润发店']) {
  const n = normSsid(t);
  const h = brandsFromSsid(rules, t);
  console.log(`${t.padEnd(12)} norm=${n.padEnd(12)} hits=${JSON.stringify(h)}`);
}

// 单独验证如家
const rujia = rules.find((b) => b.brand === '如家');
console.log('\n如家 aliases:', JSON.stringify(rujia.aliases));
for (const a of rujia.aliases) {
  const an = aliasNorm(a);
  const isCjk = /[\u4e00-\u9fa5]/.test(a);
  const threshold = isCjk ? 1 : 3;
  const pass = an.length >= threshold;
  const incl = normSsid('如家801').includes(an);
  console.log(`  alias="${a}" norm="${an}" len=${an.length} 阈值=${threshold} 通过=${pass} 包含=${incl}`);
}