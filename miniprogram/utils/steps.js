/**
 * 连接步骤生成：把一条记录变成「照着做就能连上」的分步指引。
 * 抽成独立模块，详情页和自检页共用，避免逻辑两处不一致。
 */

/**
 * @param {object} rec 记录：{ name, ssidPatterns, passwords, portal, note }
 * @returns {string[]} 步骤数组
 */
function buildSteps(rec) {
  if (!rec) return []

  const ssid = (rec.ssidPatterns && rec.ssidPatterns[0]) || rec.name || ''
  const psk = (rec.passwords && rec.passwords[0]) || ''
  const open = psk === ''
  const steps = []

  steps.push('打开手机「设置 → WLAN / WiFi」')

  if (open) {
    steps.push(`在列表里找到「${ssid}」（可能有多个同名，选信号最强的）`)
    if (rec.portal) {
      steps.push('连上后会自动弹出认证页；没弹就打开浏览器访问任意网站')
      steps.push('按页面提示输手机号 / 点「接受」，认证通过才能上网')
    } else {
      steps.push('直接连，不需要密码')
    }
  } else {
    steps.push(`点「${ssid}」，输入密码（点上面密码框可一键复制）`)
    if (rec.portal) {
      steps.push('连上后可能还要过一次网页认证，按提示操作')
    }
  }

  if (rec.note) steps.push(rec.note)
  return steps
}

/**
 * 一句话摘要：这类网络到底该怎么连。
 */
function summarize(rec) {
  if (!rec) return ''
  const psk = (rec.passwords && rec.passwords[0]) || ''
  if (psk === '') {
    return rec.portal ? '开放网络 + 需网页认证' : '开放网络，直接连'
  }
  if (psk === '房间号') return '密码是房间号（酒店常见）'
  return rec.portal ? '需要密码 + 网页认证' : '需要密码'
}

module.exports = { buildSteps, summarize }
