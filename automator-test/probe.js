/**
 * 探测微信开发者工具的自动化 ws 端口，并连上后做一轮真实点击测试。
 *
 * 为什么用 automator 而不是截图点坐标：
 *   1. 本机 agent-desktop 是 headless 模式，物理点击被策略禁止
 *   2. 小程序渲染在 webview 里，无障碍树拿不到里面的元素
 *   3. automator 是官方通道，能真正驱动模拟器、读页面数据
 */
const automator = require('miniprogram-automator');

const CANDIDATES = [9420, 17841, 29245, 32123, 45075, 46000, 65250];

async function tryConnect(port) {
  try {
    const miniProgram = await automator.connect({
      wsEndpoint: `ws://127.0.0.1:${port}`,
    });
    // 能拿到 page 才算真连上
    const page = await miniProgram.currentPage();
    return { ok: true, port, miniProgram, page };
  } catch (e) {
    return { ok: false, port, err: (e && e.message) || String(e) };
  }
}

(async () => {
  let conn = null;
  for (const p of CANDIDATES) {
    const r = await tryConnect(p);
    if (r.ok) {
      conn = r;
      console.log(`✓ 连上自动化端口 ${p}，当前页：${r.page && r.page.path}`);
      break;
    } else {
      // 只打前 80 字符，避免刷屏
      console.log(`✗ ${p}: ${String(r.err).slice(0, 80)}`);
    }
  }

  if (!conn) {
    console.error('没有可用的自动化端口。IDE 可能没开自动化，或需要用 cli auto --auto-port 指定端口。');
    process.exit(2);
  }

  const { miniProgram, page } = conn;

  try {
    // 先看页面数据，确认渲染正常
    const data = await page.data();
    console.log('\n=== 页面 data 快照 ===');
    console.log('ssid:', JSON.stringify(data.ssid));
    console.log('autoSsidNote:', JSON.stringify(data.autoSsidNote));
    console.log('localStats:', JSON.stringify(data.localStats));
    console.log('localList 条数:', Array.isArray(data.localList) ? data.localList.length : '不是数组');
    console.log('canDirectConnect:', data.canDirectConnect);

    // 找到 SSID 输入框并输入
    const input = await page.$('.input');
    if (!input) {
      console.error('没找到输入框 .input');
    } else {
      console.log('\n=== 输入 MIXUE-WANDA-5G ===');
      await input.input('MIXUE-WANDA-5G');
      await page.waitFor(300);
      const after = await page.data();
      console.log('输入后 ssid:', JSON.stringify(after.ssid));
    }

    // 点「查密码」
    const btn = await page.$('.btn-primary');
    if (!btn) {
      console.error('没找到按钮 .btn-primary');
    } else {
      console.log('\n=== 点击查密码 ===');
      await btn.tap();
      // 等网络返回。后端实测 1-2 秒足够，给 8 秒余量
      await page.waitFor(8000);

      const d2 = await page.data();
      console.log('state:', JSON.stringify(d2.state));
      console.log('stateText:', JSON.stringify(d2.stateText));
      console.log('候选数:', Array.isArray(d2.candidates) ? d2.candidates.length : '不是数组');
      if (Array.isArray(d2.candidates) && d2.candidates.length) {
        console.log('前三个候选:');
        d2.candidates.slice(0, 3).forEach((c, i) => {
          console.log(`  [${i}] psk=${JSON.stringify(c.psk)}  note=${JSON.stringify(c.note)}`);
        });
      }
    }

    // 再测扫描页
    console.log('\n=== 跳到扫描页 ===');
    await miniProgram.navigateTo('/pages/scan/scan');
    await page.waitFor(6000);
    const scanPage = await miniProgram.currentPage();
    console.log('当前页:', scanPage.path);
    const sd = await scanPage.data();
    console.log('stage:', JSON.stringify(sd.stage));
    console.log('stageText:', JSON.stringify(sd.stageText));
    console.log('nets 条数:', Array.isArray(sd.nets) ? sd.nets.length : '不是数组');
    if (Array.isArray(sd.nets) && sd.nets.length) {
      sd.nets.slice(0, 8).forEach((n) => {
        console.log(`  ${n.ssid}  ${n.signal}dBm  secure=${n.secure}  hasPsk=${n.hasPsk}  count=${n.count}`);
      });
    }
  } finally {
    await miniProgram.disconnect();
  }
})();
