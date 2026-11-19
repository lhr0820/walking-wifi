/**
 * 扫描周围 WiFi 页面
 *
 * 产品定位（2026-11-18 定）：
 *   核心是**列出网络 + 给出密码 + 一键复制**，用户自己去系统里连。
 *   不依赖「能否直接连」这个不确定的能力。
 *
 * 为什么这样更稳：
 *   微信的 wx.connectWifi 在 Android 10+ 官方明说「无法生效」。
 *   与其赌它能不能用，不如把「复制」这条路做到极致——
 *   反正用户粘一下也就两秒，比点了没反应强。
 *
 * 但如果平台支持直连，我们也不浪费：会多给一个「帮我连」按钮。
 * 主路径永远是复制，直连是加分项。
 *
 * 官方对 wx.getWifiList 的说明（中文文档）：
 *   「Android 调用前需要用户授权 scope.userLocation。
 *    iOS 将跳转到系统的 Wi-Fi 界面，Android 不会。」
 * 指南页又标「该系列接口已下架」，文档自相矛盾 → 拿不到就明确告知，不假装扫描中。
 */

const app = getApp();

Page({
  data: {
    stage: 'idle',        // idle | scanning | done | unsupported | ios_redirect | empty
    stageText: '',
    // [{ ssid, bssid, level, secure, signal, hasPsk, top, count, expanded }]
    nets: [],
    expandedIdx: -1,      // 当前展开的那一行，-1 表示都收起
    connectedSsid: '',    // 仅当用户点了「帮我连」且成功
    connectText: '',
    // 平台是否支持直连。false 时完全不显示那个按钮
    canDirectConnect: false,
  },

  onLoad() {
    this.checkDirectSupport();
    this.startScan();
  },

  onUnload() {
    if (wx.offGetWifiList) wx.offGetWifiList();
    if (this._timeout) clearTimeout(this._timeout);
  },

  /** 探一下这台机器能不能直连（决定要不要显示「帮我连」按钮） */
  checkDirectSupport() {
    if (!wx.startWifi || !wx.connectWifi) return;
    wx.startWifi({
      success: () => this.setData({ canDirectConnect: true }),
      fail: () => this.setData({ canDirectConnect: false }),
    });
  },

  // ────────────────────────────────────────────────────────
  //  扫描
  // ────────────────────────────────────────────────────────

  startScan() {
    if (!wx.startWifi || !wx.getWifiList) {
      this.setData({
        stage: 'unsupported',
        stageText: '这个版本的微信没有开放 WiFi 列表能力，请用下面的手动查询',
      });
      return;
    }

    this.setData({ stage: 'scanning', stageText: '正在扫描周围的 WiFi…', nets: [], expandedIdx: -1 });

    this.bindWifiListCallback();

    wx.startWifi({
      success: () => {
        wx.getSetting({
          success: (r) => {
            const granted = r.authSetting && r.authSetting['scope.userLocation'];
            if (granted === false) {
              this.setData({
                stage: 'unsupported',
                stageText: '需要位置权限才能扫描 WiFi（安卓系统要求）。点下面「再试一次」可以重新授权。',
              });
              return;
            }
            if (granted === undefined) {
              wx.authorize({
                scope: 'scope.userLocation',
                success: () => this.requestList(),
                fail: () => this.setData({
                  stage: 'unsupported',
                  stageText: '没给位置权限，扫不了 WiFi。这是安卓系统的规定，不是我们在收集位置。',
                }),
              });
            } else {
              this.requestList();
            }
          },
          fail: () => this.requestList(),
        });
      },
      fail: (e) => {
        const code = e && e.errCode;
        const msg = (e && e.errMsg) || '';
        console.info('startWifi 失败', code, msg);

        // 开发者工具里这两个 API 根本不实现，官方 errMsg 就是
        // 「开发者工具暂时不支持此 API 调试，请使用真机进行开发」。
        // 这不是产品坏了，是模拟器测不了——必须说清楚，
        // 否则开发者会以为接口被下架了（我之前就误判过）。
        const isDevtools = msg.indexOf('开发者工具') >= 0 || msg.indexOf('devtools') >= 0;

        this.setData({
          stage: 'unsupported',
          stageText: isDevtools
            ? '开发者工具不支持 WiFi 扫描，请用真机预览测试（点右上角「预览」扫码）'
            : code === 12001
              ? '这台手机的微信不支持扫描 WiFi。可以用下面的手动查询。'
              : `无法初始化 WiFi 模块${msg ? '：' + msg : ''}`,
        });
      },
    });
  },

  requestList() {
    wx.getWifiList({
      success: () => {
        this.setData({ stageText: '系统正在扫描，稍等几秒…' });
        // 8 秒兜底：拿不到就明说，不让用户一直等
        this._timeout = setTimeout(() => {
          if (this.data.stage === 'scanning') {
            this.setData({
              stage: 'empty',
              stageText: '没拿到网络列表。可能是系统限制，或周围确实没有 WiFi。',
            });
          }
        }, 8000);
      },
      fail: (e) => {
        console.info('getWifiList 失败', e && e.errCode);
        if (this._timeout) clearTimeout(this._timeout);
        this.setData({
          stage: 'ios_redirect',
          stageText: 'iOS 需要你先去系统「设置 → 无线局域网」看一眼，回来点「重扫」才有列表',
        });
      },
    });
  },

  bindWifiListCallback() {
    if (wx.offGetWifiList) wx.offGetWifiList();
    wx.onGetWifiList((res) => {
      const list = (res && res.wifiList) || [];
      console.info('onGetWifiList', list.length, '个网络');
      if (this._timeout) clearTimeout(this._timeout);

      if (list.length === 0) {
        this.setData({ stage: 'empty', stageText: '周围没扫到 WiFi' });
        return;
      }

      const nets = list
        .filter((w) => w.SSID && w.SSID.trim())
        .map((w) => ({
          ssid: w.SSID,
          bssid: w.BSSID || '',
          signal: typeof w.signalStrength === 'number' ? w.signalStrength : -100,
          level: this.levelOf(w.signalStrength),
          secure: w.secure !== false,
          hasPsk: null,
          top: '',
          count: 0,
        }))
        .sort((a, b) => b.signal - a.signal);

      this.setData({ stage: 'done', stageText: '', nets });
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
    if (need.length === 0) return;

    wx.request({
      url: `${app.globalData.baseUrl}/v1/lookup/batch`,
      method: 'POST',
      timeout: 15000,
      header: { 'content-type': 'application/json' },
      data: { ssids: need },
      success: (res) => {
        const results = (res.data && res.data.results) || {};
        const updated = this.data.nets.map((n) => {
          const r = results[n.ssid];
          if (!r) return n;
          return { ...n, hasPsk: r.count > 0, top: r.top || '', count: r.count || 0 };
        });
        const found = updated.filter((n) => n.hasPsk).length;
        this.setData({
          nets: updated,
          stageText: found > 0
            ? `周围 ${updated.length} 个网络，其中 ${found} 个我知道密码`
            : `周围 ${updated.length} 个网络，密码库里还没有`,
        });
      },
      fail: () => {
        this.setData({ stageText: '密码库连不上，只显示网络名字' });
      },
    });
  },

  // ────────────────────────────────────────────────────────
  //  点一行 = 复制密码 + 展开显示
  // ────────────────────────────────────────────────────────

  /**
   * 一次点击完成核心任务。
   *
   * 为什么点了就直接复制、不等用户再点一次「复制」：
   * 用户站在店里，一只手拿手机，多一次点击就多一分烦躁。
   * 复制完立刻在下面展开大字密码 + 下一步提示，一目了然。
   */
  onNetTap(e) {
    const idx = e.currentTarget.dataset.idx;
    const net = this.data.nets[idx];
    if (!net) return;

    // 开放网络：没密码可复制
    if (!net.secure) {
      wx.showModal({
        title: net.ssid,
        content: '这是开放网络，不需要密码。\n\n去「设置 → WLAN」点一下就能连。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }

    // 库里没有
    if (!net.hasPsk) {
      wx.showModal({
        title: net.ssid,
        content: '这个网络的密码我还没有。\n\n如果你在店里看到密码贴在墙上，回主页可以提交给我们，帮下一个人。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }

    // 有密码：直接复制 + 展开
    wx.setClipboardData({
      data: net.top,
      success: () => {
        this.setData({ expandedIdx: idx, connectText: '' });
        wx.showToast({
          title: '密码已复制，去设置里粘贴',
          icon: 'none',
          duration: 2500,
        });
      },
      fail: () => {
        // 复制失败也要展开，让用户能手动看/记
        this.setData({ expandedIdx: idx });
        wx.showToast({ title: '长按上面的密码手动复制', icon: 'none' });
      },
    });
  },

  /** 再点一次收起 */
  onCollapseTap() {
    this.setData({ expandedIdx: -1, connectText: '' });
  },

  /** 单独再复制一次（防止用户手滑） */
  onCopyAgain(e) {
    const psk = e.currentTarget.dataset.psk;
    wx.setClipboardData({
      data: psk,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
    });
  },

  /**
   * 加分项：平台支持时，帮用户直接连。
   *
   * 故意做得不起眼（小字按钮），因为：
   *   1. Android 10+ 大概率失败
   *   2. 主路径已经是「复制」了，这个只是顺带
   * 用户不清楚状况时不会误点，清楚的人会去找它。
   */
  onDirectConnectTap(e) {
    const idx = e.currentTarget.dataset.idx;
    const net = this.data.nets[idx];
    if (!net || !net.top) return;

    this.setData({ connectText: `正在尝试连接 ${net.ssid}…` });

    wx.connectWifi({
      SSID: net.ssid,
      password: net.top,
      success: () => {
        this.setData({ connectedSsid: net.ssid, connectText: '' });
        wx.vibrateShort && wx.vibrateShort({ type: 'light' });
        wx.showToast({ title: '连上了', icon: 'success' });
        this.reportWorked(net.ssid, net.top);
      },
      fail: (err) => {
        const code = err && err.errCode;
        console.info('connectWifi 失败', net.ssid, code);
        if (code === 12001) {
          this.setData({
            canDirectConnect: false,
            connectText: '这台手机的微信不能直接连（安卓限制）。密码已复制，去设置里粘贴即可。',
          });
        } else if (code === 12002) {
          this.setData({ connectText: `${net.ssid} 的密码可能换过了，这个不对` });
        } else {
          this.setData({ connectText: '没连上。密码已复制，去设置里粘贴即可。' });
        }
      },
    });
  },

  reportWorked(ssid, psk) {
    wx.request({
      url: `${app.globalData.baseUrl}/v1/report`,
      method: 'POST',
      timeout: 12000,
      header: { 'content-type': 'application/json' },
      data: { ssid, psk, kind: 'worked' },
      fail: () => {},
    });
  },

  onRescan() {
    this.setData({ connectedSsid: '', connectText: '', expandedIdx: -1 });
    this.startScan();
  },

  /** 扫不了就退回主页手动查 */
  onManualTap() {
    wx.navigateBack();
  },
});