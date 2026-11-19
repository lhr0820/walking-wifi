/**
 * 完整回归测试（真机能力受限时的全部可测项）
 *
 * 已验证的连接方式：
 *   cli auto --project <dir> --auto-port 9421 --trust-project
 *   → automator.connect({wsEndpoint:'ws://127.0.0.1:9421'})
 *   → 用 evaluate 读写页面（page.data() 会挂起，别用）
 */
const automator = require('miniprogram-automator');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pass = [];
const fail = [];
const check = (name, ok, detail) => {
  (ok ? pass : fail).push(name);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
};

(async () => {
  let mp;
  try {
    mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });

    // 回首页（前面测试可能停在 scan）
    await mp.evaluate(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack({ delta: pages.length - 1 });
      return true;
    });
    await sleep(1500);

    // ── T1 首页渲染 ──
    const home = await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      return {
        route: p.route,
        localStats: p.data.localStats,
        localCount: (p.data.localList || []).length,
        hasGetWifiList: typeof wx.getWifiList === 'function',
        hasConnectWifi: typeof wx.connectWifi === 'function',
      };
    });
    check('首页路由正确', home.route === 'pages/index/index', home.route);
    check('本地种子库有数据', home.localCount > 0, `${home.localStats}，渲染 ${home.localCount} 条`);
    check('wx.getWifiList API 存在', home.hasGetWifiList === true);
    check('wx.connectWifi API 存在', home.hasConnectWifi === true);

    // ── T2 后端查询 ──
    await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      p.setData({ ssid: 'MIXUE-WANDA-5G' });
      p.query();
      return true;
    });
    let q = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      q = await mp.evaluate(() => {
        const p = getCurrentPages().slice(-1)[0];
        return {
          state: p.data.state,
          stateText: p.data.stateText,
          count: (p.data.candidates || []).length,
          first: (p.data.candidates || [])[0] || null,
        };
      });
      if (q.state !== 'loading') break;
    }
    check('后端查询成功', q.state === 'ok', `${q.stateText}`);
    check('返回多个候选', q.count > 1, `${q.count} 个`);
    check('候选带来源说明', !!(q.first && q.first.note), q.first && q.first.note);

    // ── T3 点候选 = 复制 + 展开 ──
    await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      p.onCandTap({ currentTarget: { dataset: { idx: 0 } } });
      return true;
    });
    await sleep(1500);
    const c = await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      return { copiedIdx: p.data.copiedIdx, expandedIdx: p.data.expandedIdx };
    });
    check('点击后标记已复制', c.copiedIdx === 0, `copiedIdx=${c.copiedIdx}`);
    check('点击后展开大字密码', c.expandedIdx === 0, `expandedIdx=${c.expandedIdx}`);

    // ── T4 收起 ──
    await mp.evaluate(() => { getCurrentPages().slice(-1)[0].onCollapseTap(); return true; });
    await sleep(600);
    const col = await mp.evaluate(() => getCurrentPages().slice(-1)[0].data.expandedIdx);
    check('收起生效', col === -1, `expandedIdx=${col}`);

    // ── T5 查不到的 SSID → 出贡献卡片 ──
    await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      p.setData({ ssid: 'ZZZ-NO-SUCH-NET-999' });
      p.query();
      return true;
    });
    let e = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      e = await mp.evaluate(() => {
        const p = getCurrentPages().slice(-1)[0];
        return { state: p.data.state, showContribute: p.data.showContribute, stateText: p.data.stateText };
      });
      if (e.state !== 'loading') break;
    }
    check('查不到时进入 empty', e.state === 'empty', e.stateText);
    check('查不到时出贡献卡片', e.showContribute === true);

    // ── T6 本地库搜索 ──
    await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      p.onLocalKeyword({ detail: { value: '奶茶' } });
      return true;
    });
    await sleep(800);
    const s = await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      return { count: (p.data.localList || []).length, names: (p.data.localList || []).map((r) => r.name) };
    });
    check('本地库搜索有结果', s.count > 0, s.names.join(' / '));

    // ── T7 扫描页降级提示（模拟器不支持时应明确说"用真机"）──
    await mp.evaluate(() => {
      wx.navigateTo({ url: '/pages/scan/scan', fail: () => {} });
      return true;
    });
    await sleep(8000);
    const sc = await mp.evaluate(() => {
      const p = getCurrentPages().slice(-1)[0];
      if (p.route !== 'pages/scan/scan') return { route: p.route };
      return { route: p.route, stage: p.data.stage, stageText: p.data.stageText, nets: (p.data.nets || []).length };
    });
    check('扫描页能打开', sc.route === 'pages/scan/scan', sc.route);
    check('模拟器不支持时明确降级', sc.stage === 'unsupported', sc.stageText);
    check('降级文案指向真机测试', !!(sc.stageText && sc.stageText.indexOf('真机') >= 0), sc.stageText);
    check('降级时不假装扫到网络', sc.nets === 0, `${sc.nets} 条`);

    // ── 汇总 ──
    console.log(`\n========== ${pass.length} 通过 / ${fail.length} 失败 ==========`);
    if (fail.length) {
      console.log('失败项：');
      fail.forEach((f) => console.log('  ✗ ' + f));
    }
  } catch (err) {
    console.error('脚本异常:', (err && err.message) || err);
  } finally {
    if (mp) { try { await mp.disconnect(); } catch (_) {} }
  }
})();
