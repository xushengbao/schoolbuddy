const { isAdmin } = require('../../utils/auth')
const { loadPeriods, savePeriods } = require('../../utils/school')
const { toast } = require('../../utils/util')

Page({
  data: {
    periods: [],
  },

  onShow() {
    if (!isAdmin()) {
      wx.showModal({
        title: '无权限',
        content: '该功能仅管理员可访问',
        showCancel: false,
        success: () => wx.navigateBack(),
      })
      return
    }
    this.load()
  },

  async load() {
    const periods = await loadPeriods()
    this.setData({ periods })
  },

  onEdit(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const key = e.currentTarget.dataset.k
    const list = this.data.periods.slice()
    list[idx] = { ...list[idx], [key]: e.detail.value }
    this.setData({ periods: list })
  },

  onTime(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const key = e.currentTarget.dataset.k
    const list = this.data.periods.slice()
    list[idx] = { ...list[idx], [key]: e.detail.value }
    this.setData({ periods: list })
  },

  remove(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const list = this.data.periods.slice()
    list.splice(idx, 1)
    this.setData({ periods: list })
  },

  addPeriod() {
    const list = this.data.periods.slice()
    const next = list.length + 1
    list.push({ period: next, label: '第' + next + '节', start: '18:30', end: '19:15' })
    this.setData({ periods: list })
  },

  async save() {
    const periods = this.data.periods
      .slice()
      .sort((a, b) => a.period - b.period)
      .map((p, i) => ({ ...p, period: i + 1 }))
    for (const p of periods) {
      if (!p.label) p.label = '第' + p.period + '节'
      if (!/^\d{2}:\d{2}$/.test(p.start) || !/^\d{2}:\d{2}$/.test(p.end)) {
        toast('时间格式不正确')
        return
      }
    }
    try {
      await savePeriods(periods)
      this.setData({ periods })
      toast('已保存')
    } catch (e) {
      toast(e.message || '保存失败')
    }
  },
})