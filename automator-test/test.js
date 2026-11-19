/**
 * 真实 UI 测试（evaluate 通道版）
 *
 * 踩过的坑：
 *   ✗ automator.launch()   spawn 跑 .bat 没加 shell:true，Windows 必失败
 *   ✗ cli auto --port      那是 IDE HTTP 端口，不是自动化端口
 *   ✗ page.data()          这个版本会挂起（300 秒无返回）
 *   ✓ cli auto --auto-port 9421 --trust-project + connect + evaluate
 *
 * evaluate 直接在小程序上下文执行代码，绕过 automator 的高层封装，最可靠。
 */
const automator = require('miniprogram-automator');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let mp;
  try {
    console.log('连接 ws://127.0.0.1:9421 …');
    mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
    console.log('✓ 已连接');

    // ── 1. 当前页面与数据 ──
    const info = await mp.evaluate(() => {
      const pages = getCurrentPages();
      const p = pages[pages.length - 1];
      return {
        route: p.route,
        ssid: p.data.ssid,
        autoSsidNote: p.data.autoSsidNote,
        state: p.data.state,
        localStats: p.data.localStats,
        localCount: (p.data.localList || []).length,
        canDirectConnect: p.data.canDirectConnect,
        hasGetWifiList: typeof wx.getWifiList === 'function',
        hasConnectWifi: typeof wx.connectWifi === 'function',
      };
    });
    console.log('\n=== 首页 ===');
    Object.entries(info).forEach(([k, v]) => console.log(`  ${k}: ${JSON.stringify(v)}`));

    // ── 2. 触发查询（直接调页面方法，等价于点「查密码」）──
    console.log('\n=== 输入 MIXUE-WANDA-5G 并查询 ===');
    await mp.evaluate(() => {
      const pages = getCurrentPages();
      const p = pages[pages.length - 1];
      p.setData({ ssid: 'MIXUE-WANDA-5G' });
      p.query();
      return true;
    });

    // 轮询等结果，最多 15 秒
    let result = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      result = await mp.evaluate(() => {
        const pages = getCurrentPages();
        const p = pages[pages.length - 1];
        return {
          state: p.data.state,
          stateText: p.data.stateText,
          count: (p.data.candidates || []).length,
          top: (p.data.candidates || []).slice(0, 3).map((c) => ({ psk: c.psk, note: c.note })),
          showContribute: p.data.showContribute,
        };
      });
      if (result.state !== 'loading') break;
    }
    console.log('  state     :', JSON.stringify(result.state));
    console.log('  stateText :', JSON.stringify(result.stateText));
    console.log('  候选数    :', result.count);
    if (result.top.length) {
      result.top.forEach((c, i) => console.log(`    [${i}] psk=${JSON.stringify(c.psk)} note=${JSON.stringify(c.note)}`));
    }

    // ── 3. 测复制逻辑（等价于点第一个候选）──
    if (result.count > 0) {
      console.log('\n=== 点第一个候选（复制+展开）===');
      const copied = await mp.evaluate(async () => {
        const pages = getCurrentPages();
        const p = pages[pages.length - 1];
        p.onCandTap({ currentTarget: { dataset: { idx: 0 } } });
        return true;
      });
      await sleep(1500);
      const d = await mp.evaluate(() => {
        const pages = getCurrentPages();
        const p = pages[pages.length - 1];
        return { copiedIdx: p.data.copiedIdx, expandedIdx: p.data.expandedIdx };
      });
      console.log('  copiedIdx :', d.copiedIdx);
      console.log('  expandedIdx:', d.expandedIdx);
    }

    // ── 4. 扫网能力探测 ──
    console.log('\n=== 扫描页 ===');
    await mp.navigateTo('/pages/scan/scan');
    await sleep(9000);
    const scan = await mp.evaluate(() => {
      const pages = getCurrentPages();
      const p = pages[pages.length - 1];
      return {
        route: p.route,
        stage: p.data.stage,
        stageText: p.data.stageText,
        count: (p.data.nets || []).length,
        sample: (p.data.nets || []).slice(0, 10).map((n) => ({
          ssid: n.ssid, signal: n.signal, secure: n.secure, hasPsk: n.hasPsk, count: n.count,
        })),
      };
    });
    console.log('  route     :', scan.route);
    console.log('  stage     :', JSON.stringify(scan.stage));
    console.log('  stageText :', JSON.stringify(scan.stageText));
    console.log('  nets 条数 :', scan.count);
    scan.sample.forEach((n) =>
      console.log(`    ${n.ssid}  ${n.signal}dBm  secure=${n.secure} hasPsk=${n.hasPsk} count=${n.count}`));
    if (!scan.count) console.log('    （没扫到网络）');
  } catch (e) {
    console.error('失败:', (e && e.message) || e);
  } finally {
    if (mp) { try { await mp.disconnect(); } catch (_) {} }
  }
})();
