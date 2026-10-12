const { loadPeriods, minutesToNextPeriod, getTeacherDaySchedule, pushNotice } = require('./utils/school')
const { findAll } = require('./utils/db')
const { today } = require('./utils/util')

App({
  globalData: {
    session: null,
  },

  onLaunch() {
    this.restoreSession()
  },

  onShow() {
    this.checkClassReminder()
  },

  restoreSession() {
    try {
      const session = wx.getStorageSync('sb_session')
      if (session && session.role) {
        this.globalData.session = session
      }
    } catch (e) {
      // 忽略本地存储异常，登录页会兜底
    }
  },

  /**
   * 上课前 10 分钟提醒：同一节课只提醒一次（按天+节次记录在本地）。
   */
  async checkClassReminder() {
    const session = this.globalData.session
    if (!session || session.role !== 'teacher' || !session.teacherId) return

    try {
      const periods = await loadPeriods()
      const next = minutesToNextPeriod(periods)
      if (!next || next.minutes > 10) return

      const stamp = today() + '_' + next.period
      if (wx.getStorageSync('sb_reminded_at') === stamp) return
      wx.setStorageSync('sb_reminded_at', stamp)

      const lessons = await getTeacherDaySchedule(session.teacherId, today())
      const mine = lessons.filter(l => l.period === next.period)
      if (!mine.length) return

      const detail = mine.map(l => `${l.className} ${l.subject}`).join('、')
      await pushNotice({
        receiver_id: session.teacherId,
        category: '课程提醒',
        title: next.label + ' 即将开始',
        content: `${next.start} 上课（${next.label}）：${detail}。`,
        related_class_id: mine[0].classId,
        related_day: today(),
        related_period: next.period,
      })
    } catch (e) {
      // 提醒失败不阻断主流程
    }
  },
})