const store = require('../../utils/store.js')
const { SEED } = require('../../data/seed.js')
const { buildSteps, summarize } = require('../../utils/steps.js')

/**
 * 自检页：把所有运行时诊断结果直接渲染到界面上。
 * 目的是不依赖开发者工具的控制台面板，在手机/模拟器上就能看到问题。
 */
Page({
  data: {
    checks: [],
    summary: '',
    overall: 'ok',
    raw: '',
    stage: 'running',        // running | done
    live: null,              // 实时探针结果
  },

  onLoad() {
    this.run()
  },

  run() {
    const checks = []
    const add = (name, ok, detail, level) =>
      checks.push({ name, ok: !!ok, detail: detail || '', level: level || (ok ? 'ok' : 'err') })

    // 1. 存储可用
    try {
      const list = store.all()
      add('本地存储可读写', list.length >= 0, `读出 ${list.length} 条记录`)
    } catch (e) {
      add('本地存储可读写', false, String(e))
    }

    // 2. 种子数据已注入
    try {
      const st = store.stats()
      add('种子数据已注入', st.total >= SEED.length, `共 ${st.total} 条（内置 ${SEED.length} 条）`)
    } catch (e) {
      add('种子数据已注入', false, String(e))
    }

    // 3. 搜索有结果
    try {
      const r1 = store.search('星巴克')
      add('精确搜索「星巴克」命中', r1.length > 0, `命中 ${r1.length} 条`)
      const r2 = store.search('奶茶')
      add('模糊搜索「奶茶」命中', r2.length > 0, `命中 ${r2.length} 条`)
      const r3 = store.search('火锅')
      add('模糊搜索「火锅」命中', r3.length > 0, `命中 ${r3.length} 条`)
      const r4 = store.search('不存在的店xyz')
      add('无匹配时返回空', r4.length === 0, `命中 ${r4.length} 条`)
    } catch (e) {
      add('搜索功能', false, String(e))
    }

    // 4. SSID 反查
    try {
      const m = store.matchBySsid('Starbucks')
      add('SSID 反查', m !== null, m ? `Starbucks → ${m.name}` : '未命中')
      const m2 = store.matchBySsid('某个不存在的网络名')
      add('SSID 反查（无匹配）返回 null', m2 === null, m2 === null ? '正确返回 null' : '错误')
    } catch (e) {
      add('SSID 反查', false, String(e))
    }

    // 5. 写入 + 删除 + 验证标记
    try {
      const id = store.upsert({ id: '__selftest__', name: '__自检__', ssidPatterns: ['x'], passwords: ['12345678'] })
      const okAdd = !!store.byId(id)
      store.markVerified(id)
      const okVer = (store.byId(id) || {}).verified === 1
      store.remove(id)
      const okDel = !store.byId(id)
      add('新增/标记/删除记录', okAdd && okVer && okDel,
        `写入 ${okAdd ? 'OK' : '失败'}，标记 ${okVer ? 'OK' : '失败'}，删除 ${okDel ? 'OK' : '失败'}`)
    } catch (e) {
      add('新增/标记/删除记录', false, String(e))
    }

    // 6. 当前 WiFi 能力探测（真实调用一次）
    const hasApi = typeof wx.getConnectedWifi === 'function'
    if (!hasApi) {
      add('getConnectedWifi API', true, '当前平台不提供（iOS 常见），UI 已降级为直接搜店名', 'warn')
    } else {
      wx.getConnectedWifi({
        success: (res) => {
          const w = (res && res.wifi) || {}
          add('getConnectedWifi 调用', true, `SSID=${w.SSID || '(空)'}  信号=${w.signalStrength ?? '?'}`)
          this.finish()
        },
        fail: (err) => {
          add('getConnectedWifi 调用', true, `未授权或不支持（${(err && err.errMsg || '').slice(0, 40)}），UI 已降级`, 'warn')
          this.finish()
        },
      })
      // 兜底：3 秒没回调也要收尾
      setTimeout(() => this.finish(), 3000)
      return
    }

    // 7. 剪贴板
    add('剪贴板 API 存在', typeof wx.setClipboardData === 'function',
      typeof wx.setClipboardData === 'function' ? '可用' : '不可用')

    // 8. 运行期未捕获异常
    const errs = (getApp().globalData && getApp().globalData.errors) || []
    add('运行期未捕获异常', errs.length === 0,
      errs.length ? errs.slice(0, 3).join(' | ') : '无')

    // 9. 三个页面脚本存在
    const pages = ['index/index', 'detail/detail', 'add/add']
    const missing = []
    for (const p of pages) {
      try {
        require(`../../pages/${p}.js`)
      } catch (e) {
        const msg = String(e && e.message)
        if (/Cannot find module|Module not found/i.test(msg)) {
          missing.push(p + ' → ' + msg.slice(0, 50))
        }
      }
    }
    add('三个页面脚本存在', missing.length === 0,
      missing.length ? '缺失: ' + missing.join(' | ') : 'index / detail / add 三个脚本均在位')

    // 10. 记录字段结构完整性
    try {
      const anyRec = store.all()[0]
      const need = ['name', 'ssidPatterns', 'passwords', 'portal']
      const lack = need.filter((k) => anyRec[k] === undefined)
      add('记录字段结构完整', lack.length === 0,
        lack.length ? '缺字段: ' + lack.join(',') : `name/ssidPatterns/passwords/portal 齐备（样例：${anyRec.name}）`)
    } catch (e) {
      add('记录字段结构完整', false, String(e))
    }

    // 11. 详情页步骤生成（三种网络类型）
    try {
      const kinds = [
        { rec: { name: 't1', ssidPatterns: ['OpenNet'], passwords: [''], portal: false }, want: '开放' },
        { rec: { name: 't2', ssidPatterns: ['PassNet'], passwords: ['12345678'], portal: false }, want: '需密碼' },
        { rec: { name: 't3', ssidPatterns: ['PortalNet'], passwords: [''], portal: true }, want: '需认证' },
      ]
      const results = []
      let bad = 0
      for (const k of kinds) {
        const steps = buildSteps(k.rec)
        const sum = summarize(k.rec)
        if (!steps.length || !sum) bad++
        results.push(`${k.want}=${steps.length}步`)
      }
      add('详情页步骤生成', bad === 0, results.join('　'))
    } catch (e) {
      add('详情页步骤生成', false, String(e))
    }

    // 12. 摘要分类正确性
    try {
      const cases = [
        [{ passwords: [''], portal: false }, '开放网络，直接连'],
        [{ passwords: [''], portal: true }, '开放网络 + 需网页认证'],
        [{ passwords: ['abcdefgh'], portal: false }, '需要密码'],
        [{ passwords: ['房间号'], portal: false }, '密码是房间号（酒店常见）'],
      ]
      const wrong = []
      for (const [rec, want] of cases) {
        const got = summarize(rec)
        if (got !== want) wrong.push(`${want} → 实得「${got}」`)
      }
      add('网络类型摘要分类', wrong.length === 0,
        wrong.length ? wrong.join(' | ') : '4 种类型分类正确')
    } catch (e) {
      add('网络类型摘要分类', false, String(e))
    }

    this.finish()
  },

  finish() {
    if (this.data.stage === 'done') return
    const checks = this.data.checks
    const errCount = checks.filter((c) => !c.ok).length
    const warnCount = checks.filter((c) => c.level === 'warn').length
    const errs = (getApp().globalData && getApp().globalData.errors) || []
    this.setData({
      stage: 'done',
      checks,
      summary: errCount === 0
        ? `全部通过（${checks.length} 项${warnCount ? `，${warnCount} 项提示` : ''}）`
        : `${errCount} 项失败 / ${warnCount} 项提示 / 共 ${checks.length} 项`,
      overall: errCount === 0 ? 'ok' : 'err',
      raw: errs.length ? errs.join('\n') : '（无异常堆栈）',
    })
  },

  goDetail() {
    const rec = store.all().find((r) => r.id === 'starbucks') || store.all()[0]
    wx.navigateTo({ url: `/pages/detail/detail?id=${rec.id}` })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/add/add' })
  },

  copy() {
    const text = this.data.checks
      .map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`)
      .join('\n')
    wx.setClipboardData({ data: text })
  },
})
