const { getSession } = require('../../utils/auth')
const {
  loadPeriods,
  getTeacherDaySchedule,
  teacherClasses,
  summarizeStudentStatus,
  currentPeriod,
  minutesToNextPeriod,
  resolveDay,
} = require('../../utils/school')
const { findAll } = require('../../utils/db')
const { today, weekdayOf, weekdayName, WEEK_NAMES } = require('../../utils/util')

const STATUS_STYLE = {
  病假: { bg: '#fee2e2', color: '#b91c1c' },
  事假: { bg: '#fef3c7', color: '#b45309' },
  医务室: { bg: '#dbeafe', color: '#1d4ed8' },
  其他: { bg: '#ede9fe', color: '#6d28d9' },
}

Page({
  data: {
    session: {},
    schoolName: '',
    dateText: '',
    clockText: '',
    greeting: '',
    nextPeriod: null,
    lessons: [],
    liveClasses: [],
    currentPeriodNo: 0,
    memos: [],
    loading: true,
    isMakeup: false,
    makeupText: '',
  },

  onLoad() {
    const session = getSession()
    if (!session || session.role === 'class') {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ session, schoolName: session.schoolName || '' })
    this.timer = setInterval(() => this.refreshClock(), 1000)
    this.refreshClock()
  },

  onShow() {
    this.refreshClock()
    this.loadAll()
  },

  onHide() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer)
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh())
  },

  refreshClock() {
    const d = new Date()
    const hh = d.getHours()
    const mm = d.getMinutes()
    const ss = d.getSeconds()
    const pad = n => (n < 10 ? '0' + n : '' + n)
    const clock = pad(hh) + ':' + pad(mm) + ':' + pad(ss)
    const weekday = weekdayOf(d)
    const dateText = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_NAMES[d.getDay()]
    const greeting = hh < 6 ? '凌晨好' : hh < 12 ? '早上好' : hh < 14 ? '中午好' : hh < 18 ? '下午好' : '晚上好'
    this.setData({ clockText: clock, dateText, greeting })
  },

  async loadAll() {
    const session = this.data.session
    if (!session || !session.teacherId) return
    this.setData({ loading: true })
    const day = today()
    const periods = await loadPeriods()
    const now = currentPeriod(periods)

    // 调休日要显示「今天按周几的课表上课」，否则周六看到空课会以为系统坏了
    const dayInfo = await resolveDay(day)

    const raw = await getTeacherDaySchedule(session.teacherId, day)
    const lessons = raw.map(r => {
      const p = periods.find(x => x.period === r.period)
      return {
        ...r,
        periodLabel: p ? `${p.label} ${p.start}-${p.end}` : `第${r.period}节`,
        isNow: now === r.period,
      }
    })

    const myClasses = await teacherClasses(session.teacherId)
    const liveClasses = []
    for (const c of myClasses) {
      const { summary } = await summarizeStudentStatus(c.id, day)
      const chips = []
      let total = 0
      Object.keys(summary.total).forEach(status => {
        const count = summary.total[status] || 0
        if (count > 0) {
          total += count
          chips.push({ status, count, ...(STATUS_STYLE[status] || STATUS_STYLE['其他']) })
        }
      })
      // 当前节次单列状态
      if (now > 0 && summary.byPeriod[now]) {
        Object.keys(summary.byPeriod[now]).forEach(status => {
          const count = summary.byPeriod[now][status] || 0
          if (count > 0 && !chips.some(x => x.status === status)) {
            chips.push({ status: `${status}(第${now}节)`, count, ...(STATUS_STYLE[status] || STATUS_STYLE['其他']) })
          }
        })
      }
      if (total > 0) {
        liveClasses.push({
          classId: c.id,
          className: c.name,
          chips,
          summaryText: `${total} 人不在位`,
        })
      }
    }

    const memos = await findAll('memos', { owner_id: session.teacherId, done: false }, { column: 'id', ascending: true })

    this.setData({
      lessons,
      liveClasses,
      memos,
      currentPeriodNo: now,
      nextPeriod: minutesToNextPeriod(periods),
      isMakeup: dayInfo.isMakeup,
      makeupText: dayInfo.isMakeup
        ? `调休日，按${weekdayName(dayInfo.weekday)}课表上课`
        : '',
      loading: false,
    })
  },

  goSchedule() {
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },
  goStudents() {
    wx.switchTab({ url: '/pages/students/students' })
  },
  goTeachers() {
    wx.navigateTo({ url: '/pages/teachers/teachers' })
  },
  goMessage() {
    wx.navigateTo({ url: '/pages/class-message/class-message' })
  },
  goMemo() {
    wx.navigateTo({ url: '/pages/memo/memo' })
  },
  goSwap() {
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },
})