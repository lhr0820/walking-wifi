/**
 * 示例种子数据（仓库内仅此示例）。
 *
 * 真实数据不进仓库：门店公用网络的口令属于敏感内容，
 * 公开后会引来投诉下架，也违背「只收录商家自己公开的公用网络」这个定位。
 *
 * 用真实数据构建：
 *   1. 把本文件复制为 seed.js
 *   2. 按下面结构填入自己的数据
 *   或运行 scripts/use-local-data.ps1 从本地数据目录拉取
 *
 * 字段说明：
 *   id            唯一标识
 *   name          店名（展示用）
 *   keywords      搜索关键词（用户输入什么能命中）
 *   ssidPatterns  网络名可能出现的形态（用于模糊匹配）
 *   passwords     候选口令；空数组表示开放网络
 *   portal        是否需要网页/短信认证
 *   confidence    1=推算 2=多源验证
 *   note          给用户的说明
 */
const SEED = [
  {
    id: 'example-cafe',
    name: '示例咖啡店',
    keywords: ['示例', 'example', '咖啡'],
    ssidPatterns: ['EXAMPLE-CAFE', 'examplecafe'],
    passwords: ['example-psk-1', 'example-psk-2'],
    portal: false,
    confidence: 1,
    note: '示例数据，非真实口令',
  },
  {
    id: 'example-store',
    name: '示例便利店',
    keywords: ['示例', 'example', '便利店'],
    ssidPatterns: ['EXAMPLE-STORE', 'examplestore'],
    passwords: ['example-psk-3'],
    portal: false,
    confidence: 1,
    note: '示例数据，非真实口令',
  },
];

module.exports = { SEED };