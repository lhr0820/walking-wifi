/** 调试：为什么点行不展开 */
const automator = require('miniprogram-automator');

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });

  const r = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    const fake = [
      { ssid: 'A-PSK', signal: -60, level: 3, secure: true, hasPsk: true, top: 'psk12345', count: 2, brand: '蜜雪冰城', match: 'brand' },
      { ssid: 'B-NOPSK', signal: -40, level: 4, secure: true, hasPsk: false, top: '', count: 0, brand: '', match: '' },
    ];
    p.finishSort(fake, 0);

    const before = { len: p.data.nets.length, first: p.data.nets[0] && p.data.nets[0].ssid, expanded: p.data.expandedIdx };

    // 手动模拟点击
    p.onNetTap({ currentTarget: { dataset: { idx: 0 } } });
    const after = { expanded: p.data.expandedIdx };

    // 再等一下读一次（排除 setData 异步）
    return { before, after, fnType: typeof p.onNetTap };
  });

  console.log(JSON.stringify(r, null, 2));

  // 等 1 秒再读
  await new Promise((res) => setTimeout(res, 1200));
  const later = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return { expanded: p.data.expandedIdx, nets: p.data.nets.length };
  });
  console.log('1 秒后:', JSON.stringify(later));

  await mp.disconnect();
  process.exit(0);
})();