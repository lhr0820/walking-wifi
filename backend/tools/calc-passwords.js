/**
 * 门店 WiFi 密码「计算」引擎
 *
 * 用户要的不是「再搜几个」，而是「按规律算出可能的密码」。
 *
 * 核心洞察（来自多源搜索验证）：
 *   1. 公共场所确实存在高频通用密码：88888888 / 12345678 / 66668888
 *      （搜索摘要原文：「公共场所WiFi密码…最常见的是 88888888、12345678、66668888」）
 *   2. 连锁品牌的密码往往是「品牌缩写 + 数字」
 *      例：蜜雪冰城 mxbc + 8888 → example-psk-a（百度文章明确写的就是这个规律）
 *   3. 店老板常用的还有「密码8个8」直接转拼音：mimabageba
 *
 * 所以计算策略 = 通用弱密码池 + 品牌词根 × 数字后缀组合。
 *
 * 重要：算出来的密码可信度低（confidence=1），
 * 每多一个候选就多一次尝试机会，但也多一分「试了不对」的失望。
 * 所以数量要控制——每个品牌给最有希望的 8-12 个，不是穷举。
 */
const fs = require('fs');

const RULES = 'K:\\WIFI\\walking-wifi\\app\\src\\main\\assets\\brand_rules.json';
const OUT_SQL = 'K:\\WIFI\\walking-wifi\\backend\\calc-passwords.sql';

// ── 通用弱密码池 ──────────────────────────────────────────────
// 这些不分品牌，任何店都可能用。按统计概率从高到低排。
const COMMON = [
  '88888888',   // 8 个 8，公共场所第一高频
  '12345678',
  '66668888',
  '88888888',
  '123456789',
  'mimabageba',  // 「密码8个8」拼音，真实案例
  'woshidianzhang', // 「我是店长」
  'dianzhang888',
];

// ── 数字后缀池 ────────────────────────────────────────────────
// 按「店老板设密码时的直觉」排序：先想 888，再想 123，然后年份。
const SUFFIXES = [
  '88888888', '888888', '8888', '888',
  '66668888', '666666', '6666', '666',
  '12345678', '123456', '12345', '1234', '123',
  '111111', '1111', '111',
  '2025', '2024', '2023',
  '000', '0000',
];

/**
 * 新增品牌表（在原 54 个基础上扩展）。
 * 每个品牌给：中文名、aliases（用于 SSID 匹配）、词根（用于算密码）
 *
 * 词根选择原则：
 *   - pinyin: 全拼（xiaomoli）
 *   - abbr:   首字母缩写（xml）——老板最常用这个
 *   - en:     英文品牌名（starbucks）
 *   - enAbbr: 英文缩写（sbux）
 */
const NEW_BRANDS = [
  // ── 茶饮 ──
  { brand: '甜啦啦', aliases: ['tianlala', 'tll', '甜啦啦'], roots: ['tianlala', 'tll'] },
  { brand: '快乐柠檬', aliases: ['happy-lemon', 'kuaile', '快乐柠檬'], roots: ['kuaile', 'happy', 'kl'] },
  { brand: '柠季', aliases: ['ningji', 'nj', '柠季'], roots: ['ningji', 'nj'] },
  { brand: '7分甜', aliases: ['7fentian', 'qifen', '7分甜'], roots: ['qifen', '7fen', '7f'] },
  { brand: '桂源铺', aliases: ['guiyuanpu', 'gyp', '桂源铺'], roots: ['guiyuanpu', 'gyp'] },
  { brand: '壶见', aliases: ['hujian', '壶见'], roots: ['hujian', 'hj'] },
  { brand: '乐乐茶', aliases: ['lelecha', 'llc', '乐乐茶'], roots: ['lelecha', 'llc', 'lele'] },
  { brand: '茶颜悦色', aliases: ['chayan', 'cyys', '茶颜'], roots: ['chayan', 'cyys', 'chayanyuese'] },
  { brand: '茉沏', aliases: ['moqi', '茉沏'], roots: ['moqi', 'mq'] },
  { brand: '霸王茶姬', aliases: ['bwcj', 'chagee', '霸王茶姬'], roots: ['chagee', 'bwcj', 'bawang'] },

  // ── 咖啡 ──
  { brand: 'Manner', aliases: ['manner', 'mannercoffee'], roots: ['manner', 'mn'] },
  { brand: 'M Stand', aliases: ['mstand', 'm-stand'], roots: ['mstand', 'mst'] },
  { brand: 'Seesaw', aliases: ['seesaw'], roots: ['seesaw', 'ss'] },
  { brand: 'Tims', aliases: ['tims', 'timhortons', 'timscoffee'], roots: ['tims', 'timhortons'] },
  { brand: '皮爷咖啡', aliases: ['peets', "peet's", '皮爷'], roots: ['peets', 'peetscoffee', 'piye'] },
  { brand: '挪瓦咖啡', aliases: ['nowwa', '挪瓦'], roots: ['nowwa', 'nw'] },
  { brand: '幸运咖', aliases: ['xingyunka', 'lucky', '幸运咖'], roots: ['xingyunka', 'lucky', 'xyk'] },

  // ── 快餐 ──
  { brand: '德克士', aliases: ['dicos', '德克士'], roots: ['dicos', 'dks', 'dekeshi'] },
  { brand: '真功夫', aliases: ['zhenggongfu', 'zkf', '真功夫'], roots: ['zhengongfu', 'zkf', 'zgongfu'] },
  { brand: '老娘舅', aliases: ['laoniangjiu', 'lnj', '老娘舅'], roots: ['laoniangjiu', 'lnj'] },
  { brand: '大米先生', aliases: ['damixiansheng', 'dmxs', '大米先生'], roots: ['damixiansheng', 'dmxs', 'dami'] },
  { brand: '南城香', aliases: ['nanchengxiang', 'ncx', '南城香'], roots: ['nanchengxiang', 'ncx'] },
  { brand: '萨莉亚', aliases: ['saizeriya', '萨莉亚'], roots: ['saizeriya', 'szly'] },
  { brand: '吉野家', aliases: ['yoshinoya', '吉野家'], roots: ['yoshinoya', 'jyj'] },

  // ── 火锅 ──
  { brand: '谭鸭血', aliases: ['tanyaxue', 'tyx', '谭鸭血'], roots: ['tanyaxue', 'tyx'] },
  { brand: '大龙燚', aliases: ['dalongyi', 'dly', '大龙燚'], roots: ['dalongyi', 'dly'] },
  { brand: '蜀大侠', aliases: ['shudaxia', 'sdx', '蜀大侠'], roots: ['shudaxia', 'sdx'] },
  { brand: '珮姐火锅', aliases: ['peijie', 'pj', '珮姐'], roots: ['peijie', 'pj'] },

  // ── 便利店/超市 ──
  { brand: '天福便利店', aliases: ['tianfu', 'tianfup', '天福'], roots: ['tianfu', 'tf'] },
  { brand: '见福便利店', aliases: ['jianfu', '见福'], roots: ['jianfu', 'jf'] },
  { brand: '便利蜂', aliases: ['bianlifeng', 'blf', '便利蜂'], roots: ['bianlifeng', 'blf'] },
  { brand: 'Today便利店', aliases: ['today', 'todaycn'], roots: ['today', 'td'] },
  { brand: '大润发', aliases: ['rtmart', 'darunfa', '大润发'], roots: ['rtmart', 'darunfa', 'drf'] },
  { brand: '沃尔玛', aliases: ['walmart', '沃尔玛'], roots: ['walmart', 'wem'] },
  { brand: '家乐福', aliases: ['carrefour', '家乐福'], roots: ['carrefour', 'jlf'] },
  { brand: '华润万家', aliases: ['vanguard', 'huarun', '华润万家'], roots: ['vanguard', 'huarun', 'hrwj'] },
  { brand: '物美', aliases: ['wumei', '物美'], roots: ['wumei', 'wm'] },
  { brand: '胖东来', aliases: ['pangdonglai', 'pdl', '胖东来'], roots: ['pangdonglai', 'pdl'] },

  // ── 酒店 ──
  { brand: '如家', aliases: ['homeinn', 'rujia', '如家'], roots: ['homeinn', 'rujia', 'rj'] },
  { brand: '汉庭', aliases: ['hanting', 'htinns', '汉庭'], roots: ['hanting', 'ht'] },
  { brand: '全季酒店', aliases: ['jihotel', 'quanji', '全季'], roots: ['jihotel', 'quanji', 'qj'] },
  { brand: '7天酒店', aliases: ['7days', '7tiand', '7天'], roots: ['7days', 'qitian', '7t'] },
  { brand: '锦江之星', aliases: ['jinjiang', 'jjinn', '锦江'], roots: ['jinjiang', 'jj'] },
  { brand: '亚朵酒店', aliases: ['atour', 'yaduo', '亚朵'], roots: ['atour', 'yaduo', 'yd'] },
  { brand: '维也纳酒店', aliases: ['wynn', 'weiyena', '维也纳'], roots: ['weiyena', 'wyn'] },
  { brand: '桔子酒店', aliases: ['orangehotel', 'juzi', '桔子'], roots: ['orange', 'juzi', 'jz'] },

  // ── 美妆/零售 ──
  { brand: '屈臣氏', aliases: ['watsons', '屈臣氏'], roots: ['watsons', 'wcs'] },
  { brand: '万宁', aliases: ['mannings', 'wanning', '万宁'], roots: ['mannings', 'wn'] },
  { brand: '孩子王', aliases: ['haiziwang', 'hzw', '孩子王'], roots: ['haiziwang', 'hzw'] },
  { brand: '泡泡玛特', aliases: ['popmart', '泡泡玛特'], roots: ['popmart', 'ppm'] },
  { brand: '名创优品', aliases: ['miniso', '名创'], roots: ['miniso', 'mc'] },

  // ── 健身 ──
  { brand: '乐刻健身', aliases: ['leke', 'lefit', '乐刻'], roots: ['leke', 'lefit', 'lk'] },
  { brand: '超级猩猩', aliases: ['supermonkey', 'chaogixingxing', '超级猩猩'], roots: ['supermonkey', 'cxx'] },
];

// ── 场所类型通用密码 ──────────────────────────────────────────
// 不是连锁品牌，是「任何这类场所都可能用」的密码。
// 用特殊 SSID 承载，靠模糊匹配不会误伤（这些 alias 足够独特）。
const VENUE_TYPES = [
  {
    brand: '餐厅通用',
    aliases: ['restaurant', 'canguan', 'cafe-wifi', 'shop-wifi'],
    psks: ['88888888', '12345678', '66668888', 'mimabageba', 'dianzhang888'],
  },
  {
    brand: '酒店通用',
    aliases: ['hotel', 'jiudian', 'guest-wifi', 'room-wifi'],
    psks: ['88888888', '12345678', '66668888', 'hotel888'],
  },
  {
    brand: '便利店通用',
    aliases: ['store-wifi', 'bianlidian', 'shopfree'],
    psks: ['88888888', '12345678', '66668888'],
  },
];

/**
 * 计算一个品牌的候选密码。
 *
 * 规则（按「店老板设密码的思路」排优先级）：
 *   1. 通用弱密码永远先试（不用想密码，直接 8 个 8）
 *   2. 缩写 + 888（最短最好记）
 *   3. 全拼 + 888
 *   4. 缩写 + 123
 *   5. 缩写 + 年份
 *
 * 每个品牌最多取 MAX 个，避免候选爆炸。
 */
function calcForBrand(roots, max = 12) {
  const out = [];
  const push = (p) => {
    // WPA 要求 8-63 位
    if (!p || p.length < 8 || p.length > 63) return;
    if (!out.includes(p)) out.push(p);
  };

  // 1. 通用弱密码优先（不分品牌都可能对）
  COMMON.slice(0, 4).forEach(push);

  // 2. 词根 × 后缀
  const rank = ['8888', '888', '12345678', '123456', '66668888', '2025', '2024'];
  for (const suf of rank) {
    for (const r of roots) {
      push(r + suf);
      if (out.length >= max) return out;
    }
  }

  // 3. 词根单独（如果够 8 位）
  for (const r of roots) {
    push(r + r);          // 重复两遍，也是常见写法
    push(r + 'wifi');
    push('wifi' + r);
    if (out.length >= max) return out;
  }

  return out.slice(0, max);
}

// ── 合并进规则包 ──────────────────────────────────────────────
const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));
const byBrand = new Map();
for (const b of rules.brands) byBrand.set(b.brand, b);

let addedBrands = 0, updatedBrands = 0, totalPsks = 0;
const ts = Math.floor(Date.now() / 1000);
const esc = (s) => String(s).replace(/'/g, "''");
const sql = [
  '-- 计算生成的候选密码（按命名规律推导，confidence=1）',
  `-- ${new Date().toISOString()}`,
  '',
];

function emit(brand, aliases, psks, conf, source) {
  for (const ssid of [brand, ...aliases.filter((a) => /^[a-z0-9\-]+$/i.test(a)).slice(0, 1).map((a) => a.toUpperCase())]) {
    const ssidNorm = String(ssid).toLowerCase().replace(/[\s\-_]/g, '');
    for (const p of psks) {
      sql.push(
        `INSERT INTO wifi (ssid, ssid_norm, psk, brand, shop_name, city, geohash, auth_type, source, confidence, hit_count, fail_count, created_at, updated_at, status)` +
        ` VALUES ('${esc(ssid)}','${esc(ssidNorm)}','${esc(p)}','${esc(brand)}','${esc(brand)}','','','wpa2','${source}',${conf},0,0,${ts},${ts},'active')` +
        ` ON CONFLICT(ssid_norm, psk, geohash) DO UPDATE SET confidence = MAX(confidence, ${conf}), updated_at = ${ts};`,
      );
      totalPsks++;
    }
  }
}

// 新品牌
for (const nb of NEW_BRANDS) {
  const psks = calcForBrand(nb.roots, 12);
  if (!byBrand.has(nb.brand)) {
    rules.brands.push({
      brand: nb.brand,
      aliases: nb.aliases,
      psks,
      suffixes: ['888', '123', '2025'],
      calculated: true,
    });
    byBrand.set(nb.brand, rules.brands[rules.brands.length - 1]);
    addedBrands++;
  } else {
    // 已有品牌：把算出来的补充进去（不覆盖原有的真实密码）
    const rec = byBrand.get(nb.brand);
    const old = rec.psks || [];
    const merged = [...old];
    for (const p of psks) if (!merged.includes(p)) merged.push(p);
    rec.psks = merged;
    updatedBrands++;
  }
  emit(nb.brand, nb.aliases, psks, 1, 'calculated');
}

// 场所类型通用密码
for (const v of VENUE_TYPES) {
  if (!byBrand.has(v.brand)) {
    rules.brands.push({ brand: v.brand, aliases: v.aliases, psks: v.psks, venue: true });
    byBrand.set(v.brand, rules.brands[rules.brands.length - 1]);
    addedBrands++;
  }
  emit(v.brand, v.aliases, v.psks, 2, 'harvest');   // 通用密码有统计依据，给 2
}

rules._updated = new Date().toISOString().slice(0, 10);
rules._calculation_note = '部分密码由品牌词根×数字后缀计算得出（confidence=1），非人工验证';

fs.writeFileSync(RULES, JSON.stringify(rules, null, 2), 'utf8');
fs.writeFileSync(OUT_SQL, sql.join('\n'), 'utf8');

console.log(`新增品牌: ${addedBrands}`);
console.log(`更新品牌: ${updatedBrands}`);
console.log(`品牌总数: ${rules.brands.length}`);
console.log(`生成 INSERT: ${totalPsks} 条`);
console.log(`输出: ${OUT_SQL}`);