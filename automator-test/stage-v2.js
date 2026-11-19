/** 摆位：让首页显示一个「有密码优先」的真实感列表，供截图取证 */
const automator = require('miniprogram-automator');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });

  // 用模拟数据渲染，因为开发者工具扫不到真实 WiFi
  await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    const demo = [
      { ssid: 'MIXUE-WANDA-5G', signal: -52, level: 4, secure: true, hasPsk: true, top: 'example-psk-a', count: 7, brand: '蜜雪冰城', match: 'brand' },
      { ssid: 'STARBUCKS-GUEST', signal: -68, level: 3, secure: true, hasPsk: true, top: 'example-psk-h', count: 3, brand: '星巴克', match: 'brand' },
      { ssid: 'KFC-WIFI-FREE', signal: -75, level: 2, secure: true, hasPsk: true, top: 'example-psk-b', count: 3, brand: '肯德基', match: 'brand' },
      { ssid: 'CMCC-Office-5G', signal: -45, level: 4, secure: true, hasPsk: false, top: '', count: 0, brand: '', match: '' },
      { ssid: 'ChinaNet-8f3a', signal: -62, level: 3, secure: true, hasPsk: false, top: '', count: 0, brand: '', match: '' },
      { ssid: 'TP-LINK_5G_AC', signal: -80, level: 1, secure: true, hasPsk: false, top: '', count: 0, brand: '', match: '' },
    ];
    p.finishSort(demo, 0);
    p.setData({ stage: 'done' });
  });

  await sleep(1500);

  // 展开第一个，展示密码面板
  await mp.evaluate(() => {
    getCurrentPages().slice(-1)[0].onNetTap({ currentTarget: { dataset: { idx: 0 } } });
  });
  await sleep(1500);

  const d = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return {
      count: p.data.nets.length,
      withPsk: p.data.withPskCount,
      expanded: p.data.expandedIdx,
      order: p.data.nets.map((n) => `${n.ssid}:${n.hasPsk ? '有' : '无'}`),
    };
  });
  console.log(JSON.stringify(d, null, 2));

  await mp.disconnect();
})();