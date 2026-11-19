const store = require('../../utils/store.js')

Page({
  data: {
    id: '',
    name: '',
    ssid: '',
    psk: '',
    portal: false,
    note: '',
    isEdit: false,
  },

  onLoad(q) {
    if (q && q.id) {
      const rec = store.byId(q.id)
      if (rec) {
        this.setData({
          id: rec.id,
          name: rec.name || '',
          ssid: (rec.ssidPatterns && rec.ssidPatterns[0]) || '',
          psk: (rec.passwords && rec.passwords[0]) || '',
          portal: !!rec.portal,
          note: rec.note || '',
          isEdit: true,
        })
        wx.setNavigationBarTitle({ title: '编辑记录' })
      }
    }
  },

  onName(e) {
    const name = e.detail.value
    // 新建时，SSID 默认跟随店名
    const patch = { name }
    if (!this.data.isEdit && !this.data.ssid) patch.ssid = name
    this.setData(patch)
  },
  onSsid(e) { this.setData({ ssid: e.detail.value }) },
  onPsk(e) { this.setData({ psk: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },
  onPortal(e) { this.setData({ portal: e.detail.value }) },

  async paste() {
    try {
      const res = await wx.getClipboardData()
      if (res.data) this.setData({ psk: res.data.trim().slice(0, 63) })
    } catch (e) {}
  },

  save() {
    const { name, ssid, psk, portal, note, id, isEdit } = this.data
    if (!name.trim()) {
      wx.showToast({ title: '填一下店名', icon: 'none' })
      return
    }
    if (!ssid.trim()) {
      wx.showToast({ title: '填一下 SSID', icon: 'none' })
      return
    }
    if (psk && (psk.length < 8 || psk.length > 63)) {
      wx.showToast({ title: '密码通常 8-63 位', icon: 'none' })
      return
    }

    const recId = id || `custom_${Date.now()}`
    store.upsert({
      id: recId,
      name: name.trim(),
      keywords: [name.trim()],
      ssidPatterns: [ssid.trim()],
      passwords: [psk.trim()],
      portal: !!portal,
      note: note.trim(),
      confidence: 2,
      custom: true,
    })

    wx.showToast({ title: isEdit ? '已保存' : '已添加', icon: 'success' })
    setTimeout(() => {
      if (isEdit) wx.navigateBack()
      else wx.switchTab({ url: '/pages/index/index' })
    }, 600)
  },

  reset() {
    this.setData({ name: '', ssid: '', psk: '', portal: false, note: '' })
  },
})
