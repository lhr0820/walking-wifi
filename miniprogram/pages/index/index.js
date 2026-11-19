/**
 * Walking WiFi 小程序 · 首页（扫描优先版）
 *
 * 2026-11-18 真机验证 `wx.getWifiList` 可用后定稿的交互：
 *   **打开小程序即自动扫描 → 列出周围所有 WiFi → 有密码的排最前 → 点一下复制**
 *
 * 为什么改成"自动扫描"而不是"手动输名字"：
 *   真机实测证明能扫出列表，那让用户手打 SSID 就是多余动作。
 *   用户站在店里，最想要的是「我现在能连哪个」——列表直接回答这个问题。
 *
 * 为什么"有密码的排最前"：
 *   信号强的网络不一定有密码。把已知密码的顶上去，
 *   用户第一屏就能看到「这个能连」，不用往下翻。
 *
 * 模糊匹配由后端做：扫到 "MIXUE-WANDA-5G" 会命中蜜雪冰城整品牌密码。
 */

const app = getApp();
const store = require('../../utils/store.js');
const api = require('../../utils/api.js');

const CN = {
  scanning: '正在扫描周围的 WiFi…',
};

Page({
  data: {
    // idle | scanning | done | unsupported | empty
    stage: 'idle',
    stageText: '',
    // [{ ssid, signal, level, secure, hasPsk, top, count, brand, match, expanded }]
    nets: [],
    expandedIdx: -1,
    canDirectConnect: false,
    withPskCount: 0,

    // 手动搜索（扫不到时的退路，也支持店名模糊匹配）
    searchText: '',
    searching: false,
    searchState: '',      // '' | ok | empty | error
    searchText2: '',
    searchCandidates: [],

    // 贡献密码
    showContribute: false,
    contribSsid: '',
    contribPsk: '',
    contribBusy: false,
  },

  onLoad() {
    this.checkDirectSupport();
    this.startScan();
  },

  onShow() {
    // 从别的页面回来时如果还没扫到东西，再试一次
    if (this.data.stage === 'idle' || this.data.stage === 'unsupported') {
      this.startScan();
    }
  },

  onPullDownRefresh() {
    this.startScan(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    if (wx.offGetWifiList) wx.offGetWifiList();
    if (this._timeout) clearTimeout(this._timeout);
  },

  // ────────────────────────────────────────────────────────
  //  扫描
  // ────────────────────────────────────────────────────────

  checkDirectSupport() {
    if (!wx.startWifi || !wx.connectWifi) return;
    wx.startWifi({
      success: () => this.setData({ canDirectConnect: true }),
      fail: () => this.setData({ canDirectConnect: false }),
    });
  },

  startScan(done) {
    const finish = typeof done === 'function' ? done : () => {};

    if (!wx.startWifi || !wx.getWifiList) {
      this.setData({
        stage: 'unsupported',
        stageText: '这个版本的微信没有开放 WiFi 列表能力，用下面的搜索框也能查密码',
      });
      return finish();
    }

    this.setData({
      stage: 'scanning',
      stageText: CN.scanning,
      nets: [],
      expandedIdx: -1,
      withPskCount: 0,
    });

    this.bindWifiListCallback();

    wx.startWifi({
      success: () => {
        wx.getSetting({
          success: (r) => {
            const granted = r.authSetting && r.authSetting['scope.userLocation'];
            if (granted === false) {
              this.setData({
                stage: 'unsupported',
                stageText: '需要位置权限才能扫描 WiFi（安卓系统规定）。点「重新扫描」可以再授权一次。',
              });
              return finish();
            }
            if (granted === undefined) {
              wx.authorize({
                scope: 'scope.userLocation',
                success: () => this.requestList(finish),
                fail: () => {
                  this.setData({
                    stage: 'unsupported',
                    stageText: '没给位置权限就扫不了 WiFi。这是安卓系统的规定，不是我们在收集你的位置。',
                  });
                  finish();
                },
              });
            } else {
              this.requestList(finish);
            }
          },
          fail: () => this.requestList(finish),
        });
      },
      fail: (e) => {
        const msg = (e && e.errMsg) || '';
        const code = e && e.errCode;
        console.info('startWifi 失败', code, msg);

        // 开发者工具里这两个 API 不实现，官方 errMsg 明说「请使用真机进行开发」。
        // 这不是产品坏了，是模拟器测不了——必须说清楚，别让人以为接口下架了。
        const isDevtools = msg.indexOf('开发者工具') >= 0 || msg.indexOf('devtools') >= 0;

        this.setData({
          stage: 'unsupported',
          stageText: isDevtools
            ? '开发者工具不支持 WiFi 扫描，请用真机预览测试'
            : code === 12001
              ? '这台手机的微信不支持扫描 WiFi，用下面的搜索框也能查密码'
              : `WiFi 模块没启动起来${msg ? '：' + msg : ''}`,
        });
        finish();
      },
    });
  },

  requestList(done) {
    const finish = typeof done === 'function' ? done : () => {};
    wx.getWifiList({
      success: () => {
        this.setData({ stageText: '系统正在扫描，稍等几秒…' });
        // 8 秒兜底：拿不到就明说，不让用户干等
        this._timeout = setTimeout(() => {
          if (this.data.stage === 'scanning') {
            this.setData({
              stage: 'empty',
              stageText: '没拿到网络列表。可能是系统限制，或周围确实没有 WiFi。',
            });
            finish();
          }
        }, 8000);
      },
      fail: (e) => {
        console.info('getWifiList 失败', e && e.errCode);
        if (this._timeout) clearTimeout(this._timeout);
        this.setData({
          stage: 'unsupported',
          stageText: 'iOS 需要你先去系统「设置 → 无线局域网」看一眼，回来点「重新扫描」才有列表',
        });
        finish();
      },
    });
  },

  bindWifiListCallback() {
    if (wx.offGetWifiList) wx.offGetWifiList();
    wx.onGetWifiList((res) => {
      const list = (res && res.wifiList) || [];
      console.info('onGetWifiList 收到', list.length, '个网络');
      if (this._timeout) clearTimeout(this._timeout);

      const nets = list
        .filter((w) => w.SSID && String(w.SSID).trim())
        .map((w) => ({
          ssid: w.SSID,
          bssid: w.BSSID || '',
          signal: typeof w.signalStrength === 'number' ? w.signalStrength : -100,
          level: this.levelOf(w.signalStrength),
          secure: w.secure !== false,
          hasPsk: null,
          top: '',
          count: 0,
          brand: '',
          match: '',
          expanded: false,
        }))
        .sort((a, b) => b.signal - a.signal);

      if (nets.length === 0) {
        this.setData({ stage: 'empty', stageText: '周围没扫到 WiFi' });
        return;
      }

      this.setData({ stage: 'done', stageText: '正在查这些网络有没有已知密码…', nets });
      this.batchLookup(nets);
    });
  },

  levelOf(dbm) {
    if (typeof dbm !== 'number') return 2;
    if (dbm >= -55) return 4;
    if (dbm >= -67) return 3;
    if (dbm >= -78) return 2;
    if (dbm >= -88) return 1;
    return 0;
  },

  // ────────────────────────────────────────────────────────
  //  批量查密码
  // ────────────────────────────────────────────────────────

  batchLookup(nets) {
    const need = nets.filter((n) => n.secure).map((n) => n.ssid).slice(0, 30);
    if (need.length === 0) {
      this.finishSort(nets, 0);
      return;
    }

    // 走 utils/api.js：云函数优先，失败自动降级本地库。
    // 为什么不用 wx.request：上架后请求受域名白名单限制，
    // 而我们的 API 域名（Cloudflare）拿不到 ICP 备案、加不进白名单。
    api.lookupBatch(need).then((res) => {
      const results = (res && res.results) || {};
      const updated = nets.map((n) => {
        const r = results[n.ssid];
        if (!r) return n;
        return {
          ...n,
          hasPsk: r.count > 0,
          top: r.top || '',
          count: r.count || 0,
          brand: r.brand || '',
          match: r.match || '',
        };
      });
      this.finishSort(updated, res.source === 'none' ? -1 : 0);
    }).catch(() => {
      this.finishSort(nets, -1);
    });
  },

  /**
   * 排序：**有密码的排最前**，同组内按信号强度降序。
   *
   * 这是本页最重要的产品决策：
   * 用户打开小程序只想知道「我现在能连哪个」。
   * 信号强但没密码的网络对他没价值，不该占第一屏。
   */
  finishSort(nets, errFlag) {
    const sorted = [...nets].sort((a, b) => {
      const pa = a.hasPsk === true ? 1 : 0;
      const pb = b.hasPsk === true ? 1 : 0;
      if (pa !== pb) return pb - pa;        // 有密码的在上
      return b.signal - a.signal;           // 再按信号强弱
    });

    const withPsk = sorted.filter((n) => n.hasPsk === true).length;

    let stageText;
    if (errFlag === -1) {
      stageText = `周围 ${sorted.length} 个网络（密码库连不上，只显示名字）`;
    } else if (withPsk > 0) {
      stageText = `周围 ${sorted.length} 个网络，其中 ${withPsk} 个知道密码`;
    } else {
      stageText = `周围 ${sorted.length} 个网络，密码库里暂时没有`;
    }

    this.setData({
      nets: sorted,
      withPskCount: withPsk,
      stageText,
    });
  },

  onRescanTap() {
    this.startScan();
  },

  // ────────────────────────────────────────────────────────
  //  点一行 = 复制密码 + 展开
  // ────────────────────────────────────────────────────────

  onNetTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const net = this.data.nets[idx];
    if (!net) return;

    if (!net.secure) {
      wx.showModal({
        title: net.ssid,
        content: '这是开放网络，不需要密码。\n\n去「设置 → WLAN」点一下就能连。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }

    if (!net.hasPsk) {
      wx.showModal({
        title: net.ssid,
        content: '这个网络的密码我还没有。\n\n如果你看到店里墙上贴的密码，可以点下面的「我知道密码」提交，帮下一个人。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }

    // 有密码：先展开大字（界面立刻有反馈），再异步复制。
    // 顺序很重要：setClipboardData 是异步的，如果等它回调才展开，
    // 复制慢或被系统拦下时用户会以为点了没反应。
    this.setData({ expandedIdx: idx });

    wx.setClipboardData({
      data: net.top,
      success: () => {
        wx.showToast({ title: '密码已复制，去设置里粘贴', icon: 'none', duration: 2500 });
      },
      fail: () => {
        wx.showToast({ title: '长按密码手动复制', icon: 'none' });
      },
    });
  },

  onCollapseTap() {
    this.setData({ expandedIdx: -1 });
  },

  onCopyAgain(e) {
    const psk = e.currentTarget.dataset.psk;
    wx.setClipboardData({
      data: psk,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
    });
  },

  /**
   * 「帮我直接连」——加分项，不是主路径。
   *
   * 官方文档明确说 Android 10+ 的 connectWifi 无法生效，
   * 所以这个按钮只在 canDirectConnect 为真时才渲染（真机可能可用）。
   * 就算失败也不影响用户：密码已经复制好了，他随时能去系统里手动连。
   */
  onDirectConnectTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const net = this.data.nets[idx];
    if (!net || !net.top) return;

    wx.showLoading({ title: '正在连接…', mask: true });
    wx.connectWifi({
      SSID: net.ssid,
      password: net.top,
      success: () => {
        wx.hideLoading();
        wx.showToast({ title: '连上了', icon: 'success' });
      },
      fail: (err) => {
        wx.hideLoading();
        console.info('connectWifi 失败', err && err.errMsg);
        wx.showToast({ title: '自动连不成，用上面的密码手动连', icon: 'none', duration: 2600 });
      },
    });
  },

  // ────────────────────────────────────────────────────────
  //  手动搜索（模糊匹配：输「蜜雪」就能查到蜜雪冰城）
  // ────────────────────────────────────────────────────────

  onSearchInput(e) {
    this.setData({ searchText: e.detail.value });
  },

  onSearchTap() {
    const kw = String(this.data.searchText || '').trim();
    if (!kw) return;

    this.setData({ searching: true, searchState: '', searchText2: '', searchCandidates: [] });

    // 走 utils/api.js：云函数优先，失败自动降级本地库。
    // 不用 wx.request 的原因同上——正式版域名白名单会拦掉 Cloudflare 域名。
    api.lookup(kw).then((d) => {
      const list = (d.candidates || []).map((c) => ({
        psk: c.psk,
        source: c.source,
        confidence: c.confidence,
      }));

      if (list.length > 0) {
        const brandNote = d.matched_brand
          ? (d.match_type === 'brand'
            ? `按「${d.matched_brand}」匹配到的密码，不一定对`
            : `按「${d.matched_brand}」查到的密码`)
          : '按这个网络名查到的密码';
        this.setData({
          searching: false,
          searchState: 'ok',
          searchText2: d.source === 'local' ? `${brandNote}（本地库）` : brandNote,
          searchCandidates: list,
        });
      } else {
        this.setData({
          searching: false,
          searchState: 'empty',
          searchText2: d.matched_brand
            ? `识别到「${d.matched_brand}」，但库里还没有它的密码`
            : '这个名字还没收录',
          searchCandidates: [],
          showContribute: true,
          contribSsid: kw,
        });
      }
    }).catch(() => {
      this.setData({
        searching: false,
        searchState: 'error',
        searchText2: '查询没成功，稍后再试',
        searchCandidates: [],
      });
    });
  },

  onSearchCandTap(e) {
    const psk = e.currentTarget.dataset.psk;
    wx.setClipboardData({
      data: psk,
      success: () => wx.showToast({ title: '密码已复制，去设置里粘贴', icon: 'none', duration: 2500 }),
    });
  },

  // ────────────────────────────────────────────────────────
  //  贡献密码
  // ────────────────────────────────────────────────────────

  onShowContribute() {
    this.setData({ showContribute: true });
  },

  onContribSsid(e) {
    this.setData({ contribSsid: e.detail.value });
  },

  onContribPsk(e) {
    this.setData({ contribPsk: e.detail.value });
  },

  onSubmitContribute() {
    const ssid = String(this.data.contribSsid || '').trim();
    const psk = String(this.data.contribPsk || '').trim();
    if (!ssid) return wx.showToast({ title: '先填网络名字', icon: 'none' });
    if (!psk) return wx.showToast({ title: '先填密码', icon: 'none' });

    this.setData({ contribBusy: true });
    api.contribute(ssid, psk).then((r) => {
      this.setData({ contribBusy: false, contribPsk: '', showContribute: false });
      wx.showToast({
        title: r.stored ? '收下了，谢谢你' : '已存到本地，你先能用',
        icon: 'none',
        duration: 2200,
      });
    }).catch(() => {
      this.setData({ contribBusy: false });
      wx.showToast({ title: '没提交成功，稍后再试', icon: 'none' });
    });
  },
});