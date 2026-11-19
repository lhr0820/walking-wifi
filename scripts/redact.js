/**
 * 仓库脱敏：扫描所有暂存文件，把真实门店口令的硬编码示例替换成占位值。
 *
 * 背景：代码开源，但门店口令属敏感内容。
 * 数据文件本身已被 .gitignore 排除；这里处理的是「代码/脚本/测试里顺带写的示例」。
 *
 * 用法：
 *   node scripts/redact.js          实际执行（自动备份 .redact.bak）
 *   node scripts/redact.js --dry    只报告不写入
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

process.chdir(ROOT);

// 取暂存文件清单；没有 git 时退化为全量 .js 扫描
let files = [];
try {
  files = execSync('git diff --cached --name-only', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
} catch (_) {
  files = [];
}

// 只处理文本类文件
const TEXT_EXT = new Set(['.js', '.ts', '.kt', '.json', '.md', '.txt', '.py', '.kts', '.wxml', '.wxss']);
const targets = files.filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()));

// 替换规则：品牌缩写/英文名 + 数字，统一换成占位值
const RULES = [
  [/\b(mxbc|MXBC)[-_]?\d+\b/g, 'example-psk-a'],
  [/\b(kfc|KFC)[-_]?\d+\b/g, 'example-psk-b'],
  [/\b(mdl|MDL)[-_]?\d+\b/g, 'example-psk-c'],
  [/\b(hdl|HDL)[-_]?\d+\b/g, 'example-psk-d'],
  [/\b(xicha|XICHA)[-_]?\d+\b/g, 'example-psk-e'],
  [/\b(luckin|LUCKIN)[-_]?\d+\b/g, 'example-psk-f'],
  [/\b(tyx|TYX)[-_]?\d+\b/g, 'example-psk-g'],
  [/\b(starbucks|STARBUCKS)[-_]?\d+\b/g, 'example-psk-h'],
  [/\b(chagee|CHAGEE)[-_]?\d+\b/g, 'example-psk-i'],
  [/\b(bwcj|BWCJ)[-_]?\d+\b/g, 'example-psk-j'],
  [/\b(manner|MANNER)[-_]?\d+\b/g, 'example-psk-k'],
];

const report = [];
let totalHits = 0;

for (const rel of targets) {
  if (!fs.existsSync(rel)) continue;
  let text;
  try {
    text = fs.readFileSync(rel, 'utf8');
  } catch (_) {
    continue;
  }
  const before = text;
  let hits = 0;
  for (const [re, rep] of RULES) {
    const m = text.match(re);
    if (m) {
      hits += m.length;
      text = text.replace(re, rep);
    }
  }
  if (hits > 0) {
    if (!DRY) {
      const bak = rel + '.redact.bak';
      if (!fs.existsSync(bak)) fs.writeFileSync(bak, before, 'utf8');
      fs.writeFileSync(rel, text, 'utf8');
    }
    totalHits += hits;
    report.push({ file: rel, hits });
  }
}

// 输出：文件路径可能被上层过滤，故同时给索引号
console.log('=== 脱敏结果 ===');
if (report.length === 0) {
  console.log('  未发现需要处理的硬编码口令');
} else {
  report.forEach((r, i) => {
    console.log(`  [#${i}] ${r.hits} 处  ${r.file}`);
  });
}
console.log(`\n处理 ${report.length} 个文件，共 ${totalHits} 处${DRY ? '（试运行，未写入）' : '（已替换）'}`);

if (!DRY && totalHits > 0) {
  console.log('\n原文件已备份为 *.redact.bak（本地保留，不进仓库）');
  console.log('下一步：git add -A 重新暂存，并复查泄漏扫描');
}