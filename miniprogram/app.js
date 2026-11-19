/**
 * Walking WiFi 小程序
 *
 * 数据通道（按优先级）：
 *   ① 微信云函数 wifiLookup —— 正式版走这条
 *      为什么不用直接请求 api.lilcandi.xyz：
 *      小程序正式版强制校验 request 合法域名，该域名必须 ICP 备案。
 *      我们的 API 跑在 Cloudflare 上（境外注册 + 境外托管），拿不到备案，
 *      加不进白名单，正式版请求会被直接拦掉
 *      （实测报错：request:fail url not in domain list）。
 *      云开发调用不走域名校验，官方明确「不需要域名、也不需要域名备案」。
 *   ② 本地种子库（utils/store.js + data/seed.js）—— 离线兜底
 *
 * 为什么保留本地库：用户正是在「连不上网」的时候才来查口令。
 * 云端万一挂了、或者用户没信号，本地库至少给出常见连锁店的候选。
 *
 * 定位上一直避免「破解 / 万能 / 蹭网」这类词——这是能不能过审的关键。
 */

const store = require('./utils/store.js');

App({
  globalData: {
    // 保留给开发期直接调试后端用；正式版查询不走这里
    baseUrl: 'https://api.lilcandi.xyz',
    lastSsid: '',
    cloudReady: false,
  },

  onLaunch() {
    // ① 本地种子库初始化（add/detail 页依赖它）
    try {
      store.init();
    } catch (e) {
      console.warn('本地库初始化失败', e);
    }

    // ② 云开发暂不初始化（后台还没开通，init 会在线上抛错）。
    //    当前版本只用本地库，开关在 utils/api.js 的 USE_CLOUD。
    //    开通云开发后，把那边改成 true，并在这里恢复 wx.cloud.init 即可。

    const last = wx.getStorageSync('lastSsid');
    if (last) this.globalData.lastSsid = last;
  },
});