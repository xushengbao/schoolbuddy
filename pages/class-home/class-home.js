const { getSession } = require('../../utils/auth')
const {
  loadPeriods,
  getScheduleForDay,
  summarizeStudentStatus,
  currentPeriod,
  minutesToNextPeriod,
  resolveDay,
} = require('../../utils/school')
const { findAll } = require('../../utils/db')
const { fetchClassMessages, formatMessageTime, sameMessages, createPoller } = require('../../utils/message-sync')
const tts = require('../../utils/tts')
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
    dateText: '',
    clockText: '',
    nextPeriod: null,
    lessons: [],
    messages: [],
    totalStats: [],
    periodStats: [],
    memos: [],
    ttsSupported: false,
    speakingId: 0,
    isMakeup: false,
    makeupText: '',
  },

  onLoad() {
    const session = getSession()
    if (!session || session.role !== 'class') {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ session, ttsSupported: tts.isSupported() })
    this.timer = setInterval(() => this.refreshClock(), 1000)
    this.refreshClock()

    // 已播报过的语音，避免轮询重复朗读
    this.spokenIds = {}
    // 首页只同步消息（课表/状态变化不频繁），10 秒一次足够且省流量
    this.msgPoller = createPoller({
      interval: 10000,
      task: () => this.loadMessages({ silent: true }),
    })
  },

  onShow() {
    this.refreshClock()
    this.loadAll()
    if (this.msgPoller) this.msgPoller.start()
  },

  onHide() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.msgPoller) this.msgPoller.stop()
    tts.stop()
    this.setData({ speakingId: 0 })
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer)
    if (this.msgPoller) this.msgPoller.stop()
    tts.stop()
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh())
  },

  refreshClock() {
    const d = new Date()
    const pad = n => (n < 10 ? '0' + n : '' + n)
    this.setData({
      clockText: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
      dateText: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_NAMES[d.getDay()],
    })
  },

  async loadAll() {
    const session = this.data.session
    if (!session || !session.classId) return
    const day = today()
    const periods = await loadPeriods()
    const now = currentPeriod(periods)

    const dayInfo = await resolveDay(day)
    const raw = await getScheduleForDay(session.classId, day)
    const lessons = raw.map(r => {
      const p = periods.find(x => x.period === r.period)
      return {
        ...r,
        shortLabel: p ? p.start : `第${r.period}节`,
        periodLabel: p ? `${p.label} ${p.start}-${p.end}` : `第${r.period}节`,
        isNow: now === r.period,
      }
    })

    const { summary } = await summarizeStudentStatus(session.classId, day)
    const totalStats = Object.keys(summary.total).map(status => ({
      status,
      count: summary.total[status] || 0,
      color: (STATUS_STYLE[status] || STATUS_STYLE['其他']).color,
    }))

    const periodStats = periods
      .map(p => {
        const data = summary.byPeriod[p.period] || {}
        const chips = Object.keys(data)
          .filter(s => (data[s] || 0) > 0)
          .map(status => ({ status, count: data[status], ...(STATUS_STYLE[status] || STATUS_STYLE['其他']) }))
        return { period: p.period, label: p.label, chips }
      })
      .filter(x => x.chips.length > 0)

    const memos = await findAll('memos', { owner_id: -session.classId, done: false }, { column: 'id', ascending: true })

    this.setData({
      lessons,
      totalStats,
      periodStats,
      memos,
      nextPeriod: minutesToNextPeriod(periods),
      isMakeup: dayInfo.isMakeup,
      makeupText: dayInfo.isMakeup
        ? `调休日，按${weekdayName(dayInfo.weekday)}课表上课`
        : '',
    })

    // 消息单独抽出来，便于轮询时只刷这一块
    this.applyMessages(
      (await fetchClassMessages(session.classId, 10)).map(m => ({
        ...m,
        timeText: formatMessageTime(m.created_at),
      })),
      { silent: true, first: true }
    )
  },

  /** 应用消息列表；内容未变则不 setData */
  applyMessages(msgView, options) {
    const opts = options || {}
    const known = this.data.messages.map(m => Number(m.id))
    const fresh = msgView.filter(m => m.mode === 'voice' && known.indexOf(Number(m.id)) === -1)

    this.setData({ messages: msgView })

    if (opts.first) {
      // 首次加载不自动播，历史消息不该全读一遍
      msgView.forEach(m => this.markSpoken(m.id))
      return
    }
    // 首页不做自动播报（会自动出声的场景不该发生在学生自己手机上），
    // 只标记已读，语音要播请进大屏页
    fresh.forEach(m => this.markSpoken(m.id))
  },

  markSpoken(id) {
    if (!this.spokenIds) this.spokenIds = {}
    this.spokenIds[Number(id)] = true
  },

  /** 首页点单条语音也允许播（手动手势） */
  playMessage(e) {
    const text = e.currentTarget.dataset.text
    const id = Number(e.currentTarget.dataset.id)
    if (!text) return
    tts.unlock()
    if (!tts.isSupported()) {
      wx.showModal({
        title: tts.isDisabled() ? '语音播报未启用' : '语音插件未开通',
        content: tts.isDisabled()
          ? '当前版本没有启用「微信同声传译」插件。如需语音播报，请先在微信公众平台「设置 → 第三方设置 → 插件管理」申请开通，获批后再由管理员在代码中开启。文字通知不受影响。'
          : '请在微信公众平台「设置 → 第三方设置 → 插件管理」中添加「微信同声传译」插件后即可语音播报。文字通知不受影响。',
        showCancel: false,
      })
      return
    }
    if (this.data.speakingId === id) return
    this.setData({ speakingId: id })
    this.markSpoken(id)
    tts.speak(text, { force: true }).then(res => {
      if (this.data.speakingId === id) this.setData({ speakingId: 0 })
      if (!res.ok && res.reason !== 'no-plugin') {
        wx.showToast({ title: '播报失败，请重试', icon: 'none' })
      }
    })
  },

  /** 只刷新消息（供轮询调用） */
  async loadMessages() {
    const session = this.data.session
    if (!session || !session.classId) return
    const rows = await fetchClassMessages(session.classId, 10)
    const msgView = rows.map(m => ({
      ...m,
      timeText: formatMessageTime(m.created_at),
    }))
    if (sameMessages(this.data.messages, msgView)) return
    this.applyMessages(msgView)
  },
  goDisplay() {
    wx.navigateTo({ url: '/pages/message-display/message-display' })
  },
  goStudents() {
    wx.switchTab({ url: '/pages/students/students' })
  },
  goMemo() {
    wx.navigateTo({ url: '/pages/memo/memo' })
  },
})