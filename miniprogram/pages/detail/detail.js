const store = require('../../utils/store.js')
const { buildSteps } = require('../../utils/steps.js')

Page({
  data: {
    id: '',
    rec: null,
    showPsk: false,
    steps: [],
    copied: false,
  },

  onLoad(q) {
    const id = q && q.id
    let rec = id ? store.byId(id) : null

    // 没带 id（直接打开本页 / 冷启动）→ 回退到库里第一条可用记录，
    // 而不是空白页。用户从列表点进来时走正常路径，不受影响。
    if (!rec) {
      const all = store.all()
      rec = all.find((r) => r.id === 'starbucks') || all[0] || null
    }

    if (!rec) {
      this.setData({ empty: true })
      wx.showToast({ title: '还没有任何记录', icon: 'none' })
      return
    }

    this.setData({ id: rec.id, rec, steps: buildSteps(rec) })
    wx.setNavigationBarTitle({ title: rec.name || 'WiFi 详情' })
  },

  togglePsk() {
    this.setData({ showPsk: !this.data.showPsk })
  },

  copyPsk() {
    const psk = (this.data.rec.passwords || [])[0]
    if (!psk) {
      wx.showToast({ title: '开放网络，无需密码', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: psk,
      success: () => {
        this.setData({ copied: true })
        wx.showToast({ title: '已复制', icon: 'none' })
        setTimeout(() => this.setData({ copied: false }), 2000)
      },
    })
  },

  markDone() {
    wx.showModal({
      title: '确认已连上？',
      content: '标记后这条记录会显示「已验证」，下次优先推荐。',
      confirmText: '已连上',
      success: (res) => {
        if (!res.confirm) return
        store.markVerified(this.data.id)
        this.setData({ rec: store.byId(this.data.id) })
        wx.showToast({ title: '已标记', icon: 'success' })
      },
    })
  },

  edit() {
    wx.navigateTo({ url: `/pages/add/add?id=${this.data.id}` })
  },

  removeRec() {
    wx.showModal({
      title: '删除这条记录？',
      content: '删掉后需要重新录入。',
      confirmColor: '#F87171',
      success: (res) => {
        if (!res.confirm) return
        store.remove(this.data.id)
        wx.showToast({ title: '已删除', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
      },
    })
  },

  copySsid() {
    const ssid = (this.data.rec.ssidPatterns || [])[0]
    if (!ssid) return
    wx.setClipboardData({
      data: ssid,
      success: () => wx.showToast({ title: '已复制 SSID', icon: 'none' }),
    })
  },
})
