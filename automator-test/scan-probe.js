/** 专门查扫描页为什么报 Uncaught [object Object] */
const automator = require('miniprogram-automator');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let mp;
  try {
    mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
    console.log('✓ 已连接');

    // 用 wx.navigateTo 的回调形式，把真实 errMsg 抓出来
    console.log('\n=== navigateTo 的真实错误 ===');
    const nav = await mp.evaluate(() => {
      return new Promise((resolve) => {
        wx.navigateTo({
          url: '/pages/scan/scan',
          success: () => resolve({ ok: true }),
          fail: (e) => resolve({ ok: false, errMsg: e && e.errMsg, raw: JSON.stringify(e) }),
        });
      });
    });
    console.log(JSON.stringify(nav, null, 2));

    await sleep(9000);

    // 看现在在哪一页
    const cur = await mp.evaluate(() => {
      const pages = getCurrentPages();
      return {
        stack: pages.map((p) => p.route),
        last: pages[pages.length - 1].route,
      };
    });
    console.log('\n页面栈:', JSON.stringify(cur));

    // 如果到了 scan 页，读它的数据
    const sd = await mp.evaluate(() => {
      const pages = getCurrentPages();
      const p = pages[pages.length - 1];
      if (p.route !== 'pages/scan/scan') return { notScan: true, route: p.route };
      return {
        stage: p.data.stage,
        stageText: p.data.stageText,
        count: (p.data.nets || []).length,
        sample: (p.data.nets || []).slice(0, 10).map((n) => ({
          ssid: n.ssid, signal: n.signal, secure: n.secure, hasPsk: n.hasPsk,
        })),
        canDirectConnect: p.data.canDirectConnect,
      };
    });
    console.log('\n=== scan 页数据 ===');
    console.log(JSON.stringify(sd, null, 2));

    // 探一下 wx.startWifi 在模拟器里到底返回什么
    console.log('\n=== startWifi 真实返回 ===');
    const sw = await mp.evaluate(() => {
      return new Promise((resolve) => {
        wx.startWifi({
          success: () => resolve({ ok: true }),
          fail: (e) => resolve({ ok: false, errCode: e && e.errCode, errMsg: e && e.errMsg }),
        });
      });
    });
    console.log(JSON.stringify(sw, null, 2));

    // 探 getWifiList
    console.log('\n=== getWifiList 真实返回 ===');
    const gw = await mp.evaluate(() => {
      return new Promise((resolve) => {
        wx.getWifiList({
          success: () => resolve({ ok: true, note: '请求成功，等 onGetWifiList' }),
          fail: (e) => resolve({ ok: false, errCode: e && e.errCode, errMsg: e && e.errMsg }),
        });
      });
    });
    console.log(JSON.stringify(gw, null, 2));
  } catch (e) {
    console.error('脚本失败:', (e && e.message) || e);
    if (e && typeof e === 'object') console.error('对象内容:', JSON.stringify(e));
  } finally {
    if (mp) { try { await mp.disconnect(); } catch (_) {} }
  }
})();
