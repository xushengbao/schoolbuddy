const { loadPeriods, listClasses, listSchedules, buildSwapOverlay, scheduleCellKey, teacherNameMap } = require('../../utils/school')
const { findAll } = require('../../utils/db')
const { weekdayOf, shortSubject } = require('../../utils/util')

const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 班级课表：一周视图。
 * 结构是 period-first（行=节次，列=星期），符合纸质课表的习惯，
 * 也方便一眼看出某位老师一周上几节。
 */
Page({
  data: {
    classId: null,
    className: '',
    todayWeekday: 1,
    weekdays: WEEK_NAMES.slice(0, 5).map((n, i) => ({ w: i + 1, name: '周' + n, short: n })),
    periods: [],
    rows: [],
    totalLessons: 0,
  },

  async onLoad(options) {
    const classId = Number(options.classId)
    const classes = await listClasses()
    const klass = classes.find(c => c.id === classId)
    const periods = await loadPeriods()
    this.setData({
      classId,
      className: klass ? klass.name : '班级',
      periods: periods || [],
      todayWeekday: weekdayOf(new Date()),
    })
    this.load()
  },

  onShow() {
    // 换课审批通过后回到本页，需要看到最新结果
    if (this.data.classId) this.load()
  },

  async load() {
    const { classId, periods, weekdays } = this.data
    if (!classId || !periods || !periods.length) return

    // 必须取全校课表：换课常跨班（这个班第一节 ⇄ 另一个班第一节），
    // 只取本班行的话 overlay 里对方那格是空的，换过的格子会显示成原科目。
    const [schedules, swaps] = await Promise.all([
      listSchedules(),
      findAll('swap_requests', { status: 'approved' }),
    ])
    const teacherMap = await teacherNameMap()
    const overlay = buildSwapOverlay(schedules, swaps, teacherMap, classId)

    const rows = periods.map(p => {
      const cells = weekdays.map(w => {
        const hit = overlay[scheduleCellKey(classId, w.w, p.period)]
        const subject = hit ? hit.subject : ''
        return {
          key: w.w + '|' + p.period,
          weekday: w.w,
          period: p.period,
          subject,
          // 格子里只放两字简称，详情弹窗里显示全称
          shortName: shortSubject(subject),
          teacherName: hit ? hit.teacherName : '',
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

    const totalLessons = rows.reduce((sum, r) => sum + r.count, 0)
    this.setData({ rows, totalLessons })
  },

  /** 点某一格：查看该节课详情（教师、换课说明） */
  tapCell(e) {
    const { subject, teacherName, swapText, weekday, period, timeText } = e.currentTarget.dataset
    if (!subject) return
    const lines = ['周' + WEEK_NAMES[(weekday || 1) - 1] + ' 第' + period + '节' + (timeText ? '（' + timeText + '）' : ''), subject]
    if (teacherName) lines.push('任课教师：' + teacherName)
    if (swapText) lines.push(swapText)
    wx.showModal({ title: '课程详情', content: lines.join('\n'), showCancel: false })
  },
})