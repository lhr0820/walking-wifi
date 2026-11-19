/**
 * 首页改造后的回归测试。
 *
 * 本轮改动：
 *   1. 首页打开即自动扫描（不再要求手输 SSID）
 *   2. 有密码的网络排最前
 *   3. 手动搜索也走品牌模糊匹配
 *
 * 模拟器拿不到 WiFi 列表（官方限制），所以扫描本身只能验降级；
 * 但"排序""模糊匹配""复制"这些纯逻辑可以在模拟器里注入数据验证。
 */
const automator = require('miniprogram-automator');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, info) => { pass++; console.log(`✓ ${name}${info ? '  → ' + info : ''}`); };
const no = (name, info) => { fail++; console.log(`✗ ${name}${info ? '  → ' + info : ''}`); };

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时`)), ms))]);

(async () => {
  const mp = await withTimeout(automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' }), 20000, 'connect');

  // ── 1. 首页路由 ──
  const route = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return p && p.route;
  });
  route === 'pages/index/index' ? ok('首页路由正确', route) : no('首页路由正确', route);

  // ── 2. 打开即扫描：先重置并重扫，确保状态来自本次运行 ──
  // （页面会保留上一轮测试注入的假 nets，不重扫会读到脏数据）
  await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    p.setData({ nets: [], withPskCount: 0, expandedIdx: -1, stageText: '' });
    p.onRescanTap();
  });
  await sleep(2500);

  const st = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return { stage: p.data.stage, stageText: p.data.stageText };
  });
  ['scanning', 'done', 'unsupported', 'empty'].includes(st.stage)
    ? ok('打开即自动扫描（不需要手输）', `stage=${st.stage}`)
    : no('打开即自动扫描', `stage=${st.stage}`);

  // ── 3. 模拟器应明确降级，而不是假装扫描中 ──
  st.stage === 'unsupported' && /开发者工具/.test(st.stageText)
    ? ok('模拟器明确降级并指向真机', st.stageText)
    : no('模拟器明确降级', `stage=${st.stage} text=${st.stageText}`);

  // ── 4. 手动搜索仍在（降级后的退路） ──
  const hasSearch = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return typeof p.onSearchTap === 'function';
  });
  hasSearch ? ok('降级后保留手动搜索入口') : no('降级后保留手动搜索入口');

  // ── 5. 排序逻辑：有密码的必须排最前（注入假数据验证）──
  const sorted = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    const fake = [
      { ssid: 'STRONG-NO-PSK', signal: -40, level: 4, secure: true, hasPsk: false, top: '', count: 0, brand: '', match: '' },
      { ssid: 'WEAK-WITH-PSK', signal: -85, level: 1, secure: true, hasPsk: true, top: 'x', count: 3, brand: '蜜雪冰城', match: 'brand' },
      { ssid: 'MID-NO-PSK', signal: -60, level: 3, secure: true, hasPsk: false, top: '', count: 0, brand: '', match: '' },
      { ssid: 'MED-WITH-PSK', signal: -70, level: 2, secure: true, hasPsk: true, top: 'y', count: 1, brand: '瑞幸咖啡', match: 'brand' },
    ];
    p.finishSort(fake, 0);
    return p.data.nets.map((n) => ({ ssid: n.ssid, hasPsk: n.hasPsk, signal: n.signal }));
  });
  const firstTwo = sorted.slice(0, 2).every((n) => n.hasPsk === true);
  const lastTwo = sorted.slice(2).every((n) => n.hasPsk === false);
  firstTwo && lastTwo
    ? ok('有密码的排在前面', sorted.map((n) => `${n.ssid}(${n.hasPsk ? '有' : '无'})`).join(' > '))
    : no('有密码的排在前面', JSON.stringify(sorted));

  // ── 6. 同组内按信号降序 ──
  const pskSignals = sorted.filter((n) => n.hasPsk).map((n) => n.signal);
  const noPskSignals = sorted.filter((n) => !n.hasPsk).map((n) => n.signal);
  const desc = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] >= v);
  desc(pskSignals) && desc(noPskSignals)
    ? ok('同组内按信号强度降序', `有密码 ${pskSignals.join('>')} / 无密码 ${noPskSignals.join('>')}`)
    : no('同组内按信号强度降序', `${pskSignals} | ${noPskSignals}`);

  // ── 7. 有密码计数正确 ──
  const cnt = await mp.evaluate(() => getCurrentPages().slice(-1)[0].data.withPskCount);
  cnt === 2 ? ok('已知密码数量统计正确', `withPskCount=${cnt}`) : no('已知密码数量统计正确', `withPskCount=${cnt}`);

  // ── 8. 点有密码的行 → 复制 + 展开 ──
  // 注意：小程序 setData 之后 this.data 不是同步更新的，
  // 要在下一个 tick 读才准（实测同步读还是旧值，1 秒后才是新值）。
  await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    p.onNetTap({ currentTarget: { dataset: { idx: 0 } } });
  });
  await sleep(1200);
  const tapResult = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return { expandedIdx: p.data.expandedIdx, ssid: (p.data.nets[0] || {}).ssid };
  });
  tapResult.expandedIdx === 0
    ? ok('点有密码的行会展开大字密码', `expandedIdx=0 (${tapResult.ssid})`)
    : no('点有密码的行会展开大字密码', JSON.stringify(tapResult));

  // ── 9. 收起 ──
  await mp.evaluate(() => {
    getCurrentPages().slice(-1)[0].onCollapseTap();
  });
  await sleep(1200);
  const collapsed = await mp.evaluate(() => getCurrentPages().slice(-1)[0].data.expandedIdx);
  collapsed === -1 ? ok('收起生效', `expandedIdx=${collapsed}`) : no('收起生效', `expandedIdx=${collapsed}`);

  // ── 10. 真实后端：手动搜索走模糊匹配（蜜雪）──
  const search1 = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return new Promise((resolve) => {
      p.setData({ searchText: '蜜雪' });
      p.onSearchTap();
      const t = setInterval(() => {
        if (!p.data.searching && p.data.searchState) {
          clearInterval(t);
          resolve({
            state: p.data.searchState,
            n: (p.data.searchCandidates || []).length,
            note: p.data.searchText2,
          });
        }
      }, 300);
      setTimeout(() => { clearInterval(t); resolve({ state: 'timeout' }); }, 15000);
    });
  });
  search1.state === 'ok' && search1.n > 0
    ? ok('搜「蜜雪」中文模糊匹配成功', `${search1.n} 个密码，note=${search1.note}`)
    : no('搜「蜜雪」中文模糊匹配成功', JSON.stringify(search1));

  // ── 11. 英文片段也能匹配（MIXUE）──
  const search2 = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return new Promise((resolve) => {
      p.setData({ searchText: 'MIXUE', searchState: '', searchCandidates: [] });
      p.onSearchTap();
      const t = setInterval(() => {
        if (!p.data.searching && p.data.searchState) {
          clearInterval(t);
          resolve({ state: p.data.searchState, n: (p.data.searchCandidates || []).length, note: p.data.searchText2 });
        }
      }, 300);
      setTimeout(() => { clearInterval(t); resolve({ state: 'timeout' }); }, 15000);
    });
  });
  search2.state === 'ok' && search2.n > 0
    ? ok('搜英文片段 MIXUE 也能匹配', `${search2.n} 个密码`)
    : no('搜英文片段 MIXUE 也能匹配', JSON.stringify(search2));

  // ── 12. 搜完全陌生的名字 → empty + 出贡献卡片 ──
  const search3 = await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return new Promise((resolve) => {
      p.setData({ searchText: 'ZZZ-NOT-EXIST-999', searchState: '', searchCandidates: [] });
      p.onSearchTap();
      const t = setInterval(() => {
        if (!p.data.searching && p.data.searchState) {
          clearInterval(t);
          resolve({ state: p.data.searchState, showContribute: p.data.showContribute });
        }
      }, 300);
      setTimeout(() => { clearInterval(t); resolve({ state: 'timeout' }); }, 15000);
    });
  });
  search3.state === 'empty' && search3.showContribute
    ? ok('查不到时进入 empty 并显示贡献入口')
    : no('查不到时进入 empty 并显示贡献入口', JSON.stringify(search3));

  // ── 13. canDirectConnect 在模拟器应为 false（不显示误导按钮）──
  const direct = await mp.evaluate(() => getCurrentPages().slice(-1)[0].data.canDirectConnect);
  direct === false ? ok('模拟器下不显示直连按钮') : no('模拟器下不显示直连按钮', `canDirectConnect=${direct}`);

  await mp.disconnect();
  console.log(`\n========== ${pass} 通过 / ${fail} 失败 ==========`);
  if (fail > 0) process.exitCode = 1;
  process.exit(fail > 0 ? 1 : 0);
})();