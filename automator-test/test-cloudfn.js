/** 直接跑云函数逻辑，验证查询正确性（不依赖微信环境） */
const fn = require('K:\\WIFI\\walking-wifi\\miniprogram\\cloudfunctions\\wifiLookup\\index.js');

const CASES = [
  ['MIXUE-WANDA-5G', '蜜雪冰城'],
  ['德克士腿', '德克士'],
  ['DICOS-WIFI', '德克士'],
  ['如家801', '如家'],
  ['RT-Mart', '大润发'],
  ['Ningji-Tea', '柠季'],
  ['汉庭3F', '汉庭'],
  ['kfc-free', '肯德基'],
  ['luckin-x', '瑞幸咖啡'],
  ['chagee-tea', '霸王茶姬'],
  ['manner-2f', 'Manner'],
  ['完全不存在的网络XYZ', null],
];

(async () => {
  let pass = 0, fail = 0;

  console.log('=== 云函数单查 ===\n');
  for (const [ssid, expectBrand] of CASES) {
    const r = await fn.main({ action: 'lookup', ssid });
    const ok = expectBrand === null
      ? (r.ok && r.count === 0)
      : (r.ok && r.count > 0);
    if (ok) {
      pass++;
      console.log(`✓ ${ssid.padEnd(20)} count=${String(r.count).padEnd(3)} match=${String(r.match_type).padEnd(6)} brand=${r.matched_brand || '-'}`);
    } else {
      fail++;
      console.log(`✗ ${ssid.padEnd(20)} 期望 ${expectBrand}，实际 count=${r.count} brand=${r.matched_brand}`);
    }
  }

  console.log('\n=== 云函数批量 ===\n');
  const b = await fn.main({
    action: 'lookupBatch',
    ssids: ['MIXUE-2F', '德克士-2F', '如家801', '没这个网'],
  });
  console.log('ok:', b.ok, '| checked:', b.checked);
  for (const [k, v] of Object.entries(b.results || {})) {
    console.log(`  ${k.padEnd(16)} count=${String(v.count).padEnd(3)} match=${v.match} brand=${v.brand}`);
    if (k === '德克士-2F' && v.count > 0) pass++; else if (k === '德克士-2F') fail++;
  }

  console.log('\n=== 数据版本 ===');
  console.log(b.dataVersion);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
})();