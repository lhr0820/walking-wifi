/** 把界面摆到「查到 7 个候选并展开第一个」的状态，供截图取证 */
const automator = require('miniprogram-automator');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
  // 回首页
  await mp.evaluate(() => {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: pages.length - 1 });
    return true;
  });
  await sleep(1500);
  // 查询并展开第一个
  await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    p.setData({ ssid: 'MIXUE-WANDA-5G' });
    p.query();
    return true;
  });
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const st = await mp.evaluate(() => getCurrentPages().slice(-1)[0].data.state);
    if (st === 'ok') break;
  }
  await mp.evaluate(() => {
    getCurrentPages().slice(-1)[0].onCandTap({ currentTarget: { dataset: { idx: 0 } } });
    return true;
  });
  await sleep(1500);
  const d = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return { state: p.data.state, count: (p.data.candidates || []).length, expandedIdx: p.data.expandedIdx };
  });
  console.log('界面状态:', JSON.stringify(d));
  await mp.disconnect();
})();
