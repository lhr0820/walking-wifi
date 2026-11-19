/**
 * 快速健康检查：带超时保护，只确认"能不能连上并读到页面"。
 * 卡死时 20 秒内明确报错，不拖 280 秒。
 */
const automator = require('miniprogram-automator');

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);

(async () => {
  let mp;
  const t0 = Date.now();
  try {
    mp = await withTimeout(
      automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' }),
      20000,
      'connect',
    );
    console.log(`✓ connect 成功（${Date.now() - t0}ms）`);

    const info = await withTimeout(
      mp.evaluate(() => {
        const pages = getCurrentPages();
        const p = pages[pages.length - 1];
        return {
          stack: pages.map((x) => x.route),
          route: p ? p.route : null,
          localStats: p ? p.data.localStats : null,
          hasWifiList: typeof wx.getWifiList === 'function',
        };
      }),
      15000,
      'evaluate',
    );
    console.log(`✓ evaluate 成功（${Date.now() - t0}ms）`);
    console.log(JSON.stringify(info, null, 2));

    // 后端连通性（在模拟器里发真实请求）
    const api = await withTimeout(
      mp.evaluate(
        () =>
          new Promise((resolve) => {
            wx.request({
              url: 'https://api.lilcandi.xyz/v1/lookup?ssid=MIXUE-WANDA-5G',
              timeout: 12000,
              success: (r) => resolve({ ok: true, status: r.statusCode, n: ((r.data || {}).candidates || []).length }),
              fail: (e) => resolve({ ok: false, errMsg: e && e.errMsg }),
            });
          }),
      ),
      20000,
      'request',
    );
    console.log('✓ 后端请求:', JSON.stringify(api));
  } catch (e) {
    console.error(`✗ 失败（${Date.now() - t0}ms）:`, (e && e.message) || e);
  } finally {
    if (mp) { try { await withTimeout(mp.disconnect(), 5000, 'disconnect').catch(() => {}); } catch (_) {} }
    process.exit(0);
  }
})();
