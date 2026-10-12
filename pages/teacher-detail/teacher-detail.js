const { getSession } = require('../../utils/auth')
const { listSchedules, loadPeriods, buildSwapOverlay, scheduleCellKey, teacherNameMap } = require('../../utils/school')
const { findOne, update, findAll } = require('../../utils/db')
const { toast, weekdayOf, shortSubject, shortClassName } = require('../../utils/util')

const STATUS_STYLE = {
  在位中: { bg: '#dcfce7', color: '#15803d' },
  请假中: { bg: '#fee2e2', color: '#b91c1c' },
  公出中: { bg: '#dbeafe', color: '#1d4ed8' },
  开会中: { bg: '#fef3c7', color: '#b45309' },
}

const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 教师详情：一周总课表。
 * 结构是 行=节次 × 列=星期一至星期五，与班级课表一致，便于横向对比。
 */
Page({
  data: {
    teacherId: null,
    teacher: null,
    isSelf: false,
    todayWeekday: 1,
    weekdays: [],
    periods: [],
    rows: [],
    totalLessons: 0,
    statusOptions: ['在位中', '请假中', '公出中', '开会中'],
  },

  async onLoad(options) {
    this.setData({ teacherId: Number(options.id) })
    const session = getSession()
    const isSelf = session && Number(session.teacherId) === Number(options.id)
    const w = weekdayOf(new Date())
    this.setData({
      isSelf,
      todayWeekday: w,
      weekdays: WEEK_NAMES.slice(0, 5).map((n, i) => ({ w: i + 1, name: '周' + n, short: n })),
    })
    await this.load()
  },

  onShow() {
    if (this.data.teacherId) this.load()
  },

  async load() {
    const teacher = await findOne('teachers', { id: this.data.teacherId })
    if (!teacher) {
      toast('教师不存在')
      return
    }
    const periods = await loadPeriods()
    const schedules = await listSchedules()
    const swaps = await findAll('swap_requests', { status: 'approved' })
    const teacherMap = await teacherNameMap()
    const classes = await findAll('classes', {})
    const classMap = {}
    classes.forEach(c => {
      classMap[c.id] = c.name
    })
    const overlay = buildSwapOverlay(schedules, swaps, teacherMap)

    // 该教师一周内真正要上的课（换课后的归属）
    const mine = []
    schedules.forEach(s => {
      const cell = overlay[scheduleCellKey(s.class_id, s.weekday, s.period_no)]
      if (!cell || Number(cell.teacherId || 0) !== Number(teacher.id)) return
      mine.push({
        classId: s.class_id,
        weekday: Number(s.weekday),
        period: Number(s.period_no),
        className: classMap[s.class_id] || '',
        subject: cell.subject,
        swapped: cell.swapped,
        swapText: cell.swapText,
      })
    })

    const rows = (periods || []).map(p => {
      const cells = this.data.weekdays.map(w => {
        const hit = mine.find(m => m.weekday === w.w && m.period === p.period)
        return {
          key: w.w + '|' + p.period,
          weekday: w.w,
          period: p.period,
          className: hit ? hit.className : '',
          // 班级名可能有「三年1班」这种 5 字，窄列里只放后半段
          shortClass: hit ? shortClassName(hit.className) : '',
          subject: hit ? hit.subject : '',
          shortName: shortSubject(hit ? hit.subject : ''),
          swapped: hit ? hit.swapped : false,
          swapText: hit ? hit.swapText : '',
          isToday: w.w === this.data.todayWeekday,
        }
      })
      return {
        period: p.period,
        label: p.label,
        timeText: p.start + '-' + p.end,
        cells,
        count: cells.filter(c => c.subject).length,
      }
    })

    const style = STATUS_STYLE[teacher.status] || STATUS_STYLE['在位中']
    this.setData({
      teacher: { ...teacher, bg: style.bg, color: style.color },
      periods: periods || [],
      rows,
      totalLessons: mine.length,
    })
  },

  tapCell(e) {
    const { subject, className, swapText, weekday, period, timeText } = e.currentTarget.dataset
    if (!subject) return
    const lines = ['周' + WEEK_NAMES[(weekday || 1) - 1] + ' 第' + period + '节　' + subject, timeText || '']
    if (className) lines.push('班级：' + className)
    if (swapText) lines.push(swapText)
    wx.showModal({ title: '课程详情', content: lines.filter(Boolean).join('\n'), showCancel: false })
  },

  async setStatus(e) {
    const value = e.currentTarget.dataset.v
    try {
      await update('teachers', { id: this.data.teacherId }, { status: value })
      toast('状态已更新')
      this.load()
    } catch (err) {
      toast(err.message || '更新失败')
    }
  },
})