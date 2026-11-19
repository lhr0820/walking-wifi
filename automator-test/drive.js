/**
 * 驱动微信开发者工具做真实 UI 测试。
 *
 * 连接方式（踩过的坑，别再走错路）：
 *   ✗ automator.launch() —— 内部用 spawn 跑 .bat 但没加 shell:true，Windows 必失败
 *   ✗ cli auto --port 9420 —— --port 是 IDE 的 HTTP 端口，不是自动化端口，开了也连不上
 *   ✓ cli auto --auto-port 9421 --trust-project  然后 connect 到 ws://127.0.0.1:9421
 *     （--auto-port 在 cli --help 里不显示，但 Launcher.js 源码里就是用它）
 */
const automator = require('miniprogram-automator');

const CLI = 'G:\\Program Files (x86)\\微信web开发者工具\\cli.bat';
const PROJECT = 'K:\\WIFI\\walking-wifi\\miniprogram';

(async () => {
  let miniProgram;
  try {
    console.log('连接自动化端口 9421…');
    miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
    console.log('✓ 已连接');

    const page = await miniProgram.currentPage();
    console.log('当前页:', page.path);

    // ── 1. 页面渲染检查 ──
    const data = await page.data();
    console.log('\n=== 首页数据 ===');
    console.log('ssid          :', JSON.stringify(data.ssid));
    console.log('autoSsidNote  :', JSON.stringify(data.autoSsidNote));
    console.log('localStats    :', JSON.stringify(data.localStats));
    console.log('localList条数 :', Array.isArray(data.localList) ? data.localList.length : '非数组');
    console.log('canDirectConnect:', data.canDirectConnect);

    // ── 2. 输入 SSID ──
    const input = await page.$('.input');
    if (input) {
      await input.input('MIXUE-WANDA-5G');
      await page.waitFor(400);
      console.log('\n输入后 ssid:', JSON.stringify((await page.data()).ssid));
    } else {
      console.log('\n⚠ 没找到 .input');
    }

    // ── 3. 点查密码 ──
    const btn = await page.$('.btn-primary');
    if (btn) {
      console.log('\n点击「查密码」…');
      await btn.tap();
      await page.waitFor(9000);   // 等后端返回

      const d2 = await page.data();
      console.log('state     :', JSON.stringify(d2.state));
      console.log('stateText :', JSON.stringify(d2.stateText));
      console.log('候选数    :', Array.isArray(d2.candidates) ? d2.candidates.length : '非数组');
      if (Array.isArray(d2.candidates) && d2.candidates.length) {
        d2.candidates.slice(0, 3).forEach((c, i) =>
          console.log(`  [${i}] psk=${JSON.stringify(c.psk)} note=${JSON.stringify(c.note)}`));
        // 点第一个候选，验证复制逻辑
        const firstCand = await page.$('.cand');
        if (firstCand) {
          await firstCand.tap();
          await page.waitFor(1200);
          const d3 = await page.data();
          console.log('点候选后 copiedIdx :', d3.copiedIdx);
          console.log('点候选后 expandedIdx:', d3.expandedIdx);
        }
      }
    } else {
      console.log('\n⚠ 没找到 .btn-primary');
    }

    // ── 4. 扫描页 ──
    console.log('\n=== 跳扫描页 ===');
    await miniProgram.navigateTo('/pages/scan/scan');
    await page.waitFor(8000);
    const sp = await miniProgram.currentPage();
    console.log('当前页:', sp.path);
    const sd = await sp.data();
    console.log('stage     :', JSON.stringify(sd.stage));
    console.log('stageText :', JSON.stringify(sd.stageText));
    console.log('nets 条数 :', Array.isArray(sd.nets) ? sd.nets.length : '非数组');
    if (Array.isArray(sd.nets) && sd.nets.length) {
      sd.nets.slice(0, 10).forEach((n) =>
        console.log(`  ${n.ssid}  ${n.signal}dBm  secure=${n.secure} hasPsk=${n.hasPsk} count=${n.count}`));
    } else {
      console.log('  （没扫到网络）');
    }
  } catch (e) {
    console.error('失败:', (e && e.message) || e);
    if (e && e.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (miniProgram) {
      try { await miniProgram.disconnect(); } catch (_) {}
    }
  }
})();
