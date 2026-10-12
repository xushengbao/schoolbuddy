const { isAdmin } = require('../../utils/auth')
const {
  listMakeupDays,
  saveMakeupDay,
  removeMakeupDay,
  loadPeriods,
  listSchedules,
} = require('../../utils/school')
const {
  WEEK_NAMES,
  weekdayOfStr,
  weekdayName,
  shortDay,
  today,
  shiftDay,
  toast,
} = require('../../utils/util')

const WEEK_NAMES_5 = ['一', '二', '三', '四', '五']

Page({
  data: {
    items: [],
    // 新增表单
    formOpen: false,
    date: '',
    dateLabel: '',
    weekday: 1,
    weekdayOptions: [],
    weekdayIndex: 0,
    weekdayText: '周一',
    note: '',
    editingId: 0,
    // 该日是周末吗（决定要不要提示）
    isWeekend: false,
    periods: [],
    // 当天对应的课表预览（节次 + 科目）
    preview: [],
  },

  onLoad() {
    if (!isAdmin()) {
      wx.showModal({
        title: '无权限',
        content: '调休设置仅管理员可使用',
        showCancel: false,
        success: () => wx.navigateBack(),
      })
      return
    }
    this.setData({
      weekdayOptions: WEEK_NAMES_5.map((n, i) => ({
        w: i + 1,
        text: '周' + n,
      })),
      periods: [],
    })
    this.load()
    // 默认把下一个周末预填上，省一次点选
    this.setData(this.pickDate(shiftDay(today(), 1)))
  },

  onShow() {
    if (this.data.items.length) this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    const rows = await listMakeupDays({ force: true })
    const periods = await loadPeriods()
    const items = rows
      .map(r => {
        const date = String(r.makeup_date || '').slice(0, 10)
        const real = weekdayOfStr(date)
        return {
          id: r.id,
          date,
          realWeekday: real,
          weekday: Number(r.weekday) || 1,
          note: r.note || '',
          dateLabel: shortDay(date),
          realName: WEEK_NAMES[real % 7],
          weekdayName: weekdayName(Number(r.weekday) || 1),
          text: `${shortDay(date)} 按${weekdayName(Number(r.weekday) || 1)}课表上课`,
        }
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    this.setData({ items, periods })
  },

  /* ==================== 新增 / 编辑 ==================== */

  openForm() {
    const base = this.pickDate(shiftDay(today(), 1))
    this.setData({ ...base, formOpen: true })
  },

  closeForm() {
    this.setData({ formOpen: false })
  },

  noop() {},

  /** 取「最近一个周末」作为默认日期，减少点击 */
  pickDate(date) {
    let d = date
    let w = weekdayOfStr(d)
    // 往后推到最近的周六或周日
    let guard = 0
    while (w < 6 && guard < 7) {
      d = shiftDay(d, 1)
      w = weekdayOfStr(d)
      guard++
    }
    const weekday = this.data.weekday || 1
    const idx = Math.max(0, WEEK_NAMES_5.indexOf(WEEK_NAMES[weekday % 7]))
    return {
      date: d,
      dateLabel: shortDay(d),
      isWeekend: w >= 6,
      weekday,
      weekdayIndex: idx,
      weekdayText: weekdayName(weekday),
      preview: [],
    }
  },

  onDateChange(e) {
    const d = String(e.detail.value || '').slice(0, 10)
    if (!d) return
    const w = weekdayOfStr(d)
    const keep = this.data.weekday
    const idx = Math.max(0, WEEK_NAMES_5.indexOf(WEEK_NAMES[keep % 7]))
    this.setData({
      date: d,
      dateLabel: shortDay(d),
      isWeekend: w >= 6,
      weekdayIndex: idx,
      weekdayText: weekdayName(keep),
      preview: [],
    })
    this.loadPreview()
  },

  onWeekdayChange(e) {
    const idx = Number(e.detail.value)
    const opt = this.data.weekdayOptions[idx]
    if (!opt) return
    this.setData({ weekdayIndex: idx, weekday: opt.w, weekdayText: opt.text })
    this.loadPreview()
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  /** 预览：这一天按所选星期几上课时，各节次是什么课 */
  async loadPreview() {
    const date = this.data.date
    const weekday = this.data.weekday
    if (!date) {
      this.setData({ preview: [] })
      return
    }
    if (!this.data.isWeekend) {
      // 周一到周五本来就按当天星期上课，没必要预览
      this.setData({ preview: [] })
      return
    }
    try {
      const rows = await listSchedules()
      const byPeriod = {}
      rows.forEach(r => {
        if (Number(r.weekday) !== Number(weekday)) return
        byPeriod[r.period_no] = r.subject || ''
      })
      const preview = this.data.periods
        .filter(p => byPeriod[p.period])
        .map(p => ({ period: p.period, label: p.label, subject: byPeriod[p.period], time: p.start + '-' + p.end }))
      this.setData({ preview })
    } catch (e) {
      this.setData({ preview: [] })
    }
  },

  async save() {
    if (!this.data.date) {
      toast('请选择日期')
      return
    }
    if (!this.data.isWeekend) {
      toast('只能对周六或周日设置调休')
      return
    }
    wx.showLoading({ title: '保存中', mask: true })
    try {
      await saveMakeupDay({
        makeupDate: this.data.date,
        weekday: this.data.weekday,
        note: this.data.note,
      })
      wx.hideLoading()
      this.setData({ formOpen: false, note: '', preview: [], editingId: 0 })
      await this.load()
      toast('已保存，全校课表同步生效')
    } catch (e) {
      wx.hideLoading()
      toast(e.message || '保存失败')
    }
  },

  edit(e) {
    const id = Number(e.currentTarget.dataset.id)
    const it = this.data.items.find(x => Number(x.id) === id)
    if (!it) return
    const idx = Math.max(0, WEEK_NAMES_5.indexOf(WEEK_NAMES[it.weekday % 7]))
    this.setData({
      formOpen: true,
      date: it.date,
      dateLabel: it.dateLabel,
      isWeekend: it.realWeekday >= 6,
      weekday: it.weekday,
      weekdayIndex: idx,
      weekdayText: it.weekdayName,
      note: it.note,
      preview: [],
      editingId: it.id,
    })
    this.loadPreview()
  },

  del(e) {
    const id = Number(e.currentTarget.dataset.id)
    const it = this.data.items.find(x => Number(x.id) === id)
    wx.showModal({
      title: '取消调休',
      content: `确定取消「${it ? it.text : ''}」吗？取消后当天恢复为不上课。`,
      confirmColor: '#ef4444',
      success: async r => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        try {
          await removeMakeupDay(id)
          wx.hideLoading()
          await this.load()
          toast('已取消')
        } catch (e) {
          wx.hideLoading()
          toast(e.message || '操作失败')
        }
      },
    })
  },
})