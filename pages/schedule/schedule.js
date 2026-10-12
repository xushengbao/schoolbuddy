const { getSession, isAdmin } = require('../../utils/auth')
const {
  loadPeriods,
  listClasses,
  listTeachers,
  listSchedules,
  teacherClasses,
  getTeacherDaySchedule,
  listSwapRequests,
  createSwapRequest,
  updateSwapRequest,
  buildSwapOverlay,
  scheduleCellKey,
  teacherNameMap,
  describeSwap,
  buildSwapCandidates,
  checkSwapConflict,
  resolveDay,
  notifySwap,
  pushNotice,
} = require('../../utils/school')
const { findAll } = require('../../utils/db')
const { today, shiftDay, formatDay, weekdayName, weekdayOfStr, weekdayOf, shortSubject, shortClassName, upcomingDays, toast } = require('../../utils/util')

const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日']

const STATUS_VIEW = {
  pending: { text: '待处理', bg: '#fef3c7', color: '#b45309' },
  approved: { text: '已同意', bg: '#dcfce7', color: '#15803d' },
  rejected: { text: '已拒绝', bg: '#fee2e2', color: '#b91c1c' },
  cancelled: { text: '已撤销', bg: '#e5e7eb', color: '#4b5563' },
}

Page({
  data: {
    tab: 'mine',
    isAdmin: false,
    session: {},
    dayOffset: 0,
    dayText: '',
    lessons: [],
    myClasses: [],
    classes: [],
    teachers: [],
    allClasses: true,
    pickedClassId: null,
    weekday: 1,
    // 单班视图用的一周网格
    todayWeekday: 1,
    weekdays: WEEK_NAMES.slice(0, 5).map((n, i) => ({ w: i + 1, name: '周' + n, short: n })),
    classRows: [],
    classTotal: 0,
    schoolMatrix: [],
    mySwaps: [],
    inboxSwaps: [],
    // 换课弹层
    swapPanel: false,
    swapStep: 1,
    swapDays: [],
    swapDayIndex: 0,
    allSwapLessons: [],
    swapLessons: [],
    swapForm: { first: null, second: null, targetId: null, targetName: '', reason: '' },
    teacherPicker: false,
    teacherKeyword: '',
    teacherCandidates: [],
  },

  onLoad() {
    const session = getSession()
    if (!session) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ session, isAdmin: isAdmin(), todayWeekday: weekdayOf(new Date()) })
  },

  onShow() {
    this.loadAll()
  },

  async loadAll() {
    const day = today()
    await this.loadMine(day)
    await this.loadSchool()
    await this.loadSwaps()
  },

  async loadMine(day) {
    const session = this.data.session
    const periods = await loadPeriods()
    // 调休日要让老师知道自己上的是哪个工作日的课，否则「周六怎么有课」会很困惑
    const dayInfo = await resolveDay(day)
    const label = dayInfo.isMakeup
      ? `${formatDay(day)}（调休，按${weekdayName(dayInfo.weekday)}课表）`
      : formatDay(day)
    if (session.role === 'class') {
      this.setData({ lessons: [], dayText: label, myClasses: [], isMakeup: dayInfo.isMakeup })
      return
    }
    const raw = await getTeacherDaySchedule(session.teacherId, day)
    const lessons = raw.map((r, index) => {
      const p = periods.find(x => x.period === r.period)
      return {
        ...r,
        key: r.id + '_' + index,
        weekday: r.weekday || dayInfo.weekday,
        shortLabel: p ? p.start : `第${r.period}节`,
        timeText: p ? p.start + '-' + p.end : '',
      }
    })
    const classes = await teacherClasses(session.teacherId)
    this.setData({ lessons, myClasses: classes, dayText: label, isMakeup: dayInfo.isMakeup })
  },

  async loadSchool() {
    const periods = await loadPeriods()
    const classes = await listClasses()
    const teachers = await listTeachers()
    const teacherMap = {}
    teachers.forEach(t => {
      teacherMap[t.id] = t.name
    })

    const schedules = await listSchedules()
    const swaps = await findAll('swap_requests', { status: 'approved' })
    const overlay = buildSwapOverlay(schedules, swaps, teacherMap)

    const cellAt = (classId, weekday, periodNo) => {
      const hit = overlay[scheduleCellKey(classId, weekday, periodNo)]
      const subject = hit ? hit.subject : ''
      return {
        subject,
        shortName: shortSubject(subject),
        teacherName: hit ? hit.teacherName : '',
        swapped: hit ? hit.swapped : false,
        swapText: hit ? hit.swapText : '',
      }
    }

    // 全部班级视图：节次 × 班级（只看当前选中的星期）
    const matrix = periods.map(p => {
      const cells = classes.map(c => {
        const info = cellAt(c.id, this.data.weekday, p.period)
        return { classId: c.id, className: c.name, ...info }
      })
      return { period: p.period, cells }
    })

    // 单班视图：一周（行=节次，列=周一至周五），与班级详情页同一套网格
    let classRows = []
    if (!this.data.allClasses && this.data.pickedClassId) {
      const cid = this.data.pickedClassId
      classRows = periods.map(p => ({
        period: p.period,
        label: p.label,
        timeText: p.start + '-' + p.end,
        cells: this.data.weekdays.map(w => {
          const info = cellAt(cid, w.w, p.period)
          return {
            key: w.w + '|' + p.period,
            weekday: w.w,
            period: p.period,
            isToday: w.w === this.data.todayWeekday,
            ...info,
          }
        }),
      }))
      classRows.forEach(r => {
        r.count = r.cells.filter(c => c.subject).length
      })
    }

    this.setData({
      classes: classes.map(c => ({ ...c, shortName: shortClassName(c.name) })),
      teachers,
      schoolMatrix: matrix,
      classRows,
      classTotal: classRows.reduce((sum, r) => sum + r.count, 0),
    })
  },

  async loadSwaps() {
    const session = this.data.session
    if (session.role === 'class') {
      this.setData({ mySwaps: [], inboxSwaps: [] })
      return
    }
    const [all, classes] = await Promise.all([listSwapRequests(), listClasses()])
    const classMap = {}
    classes.forEach(c => {
      classMap[c.id] = c.name
    })
    const decorate = r => ({
      ...r,
      summary: describeSwap(r, classMap[r.class_id]),
      statusText: (STATUS_VIEW[r.status] || {}).text || r.status,
      statusBg: (STATUS_VIEW[r.status] || {}).bg || '#f1f5f9',
      statusColor: (STATUS_VIEW[r.status] || {}).color || '#4b5563',
    })
    const mine = all
      .filter(r => Number(r.requester_id) === Number(session.teacherId))
      .map(decorate)
    // 对方发来的：待处理的 + 已同意但还没撤销的（已同意后双方都能撤）
    const inbox = all
      .filter(
        r =>
          Number(r.target_id) === Number(session.teacherId) &&
          (r.status === 'pending' || r.status === 'approved')
      )
      .map(decorate)
    this.setData({ mySwaps: mine, inboxSwaps: inbox })
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ tab }, () => {
      if (tab === 'school') this.loadSchool()
      if (tab === 'swap') this.loadSwaps()
    })
  },

  changeDay(e) {
    const offset = Number(e.currentTarget.dataset.offset)
    this.setData({ dayOffset: offset })
    this.loadMine(shiftDay(today(), offset))
  },

  pickAnyDay() {
    const self = this
    wx.showActionSheet({
      itemList: ['今天', '明天', '后天'],
      success(res) {
        self.setData({ dayOffset: res.tapIndex })
        self.loadMine(shiftDay(today(), res.tapIndex))
      },
    })
  },

  toggleAllClasses() {
    this.setData({ allClasses: !this.data.allClasses }, () => this.loadSchool())
  },

  pickClass(e) {
    const id = Number(e.currentTarget.dataset.id)
    this.setData({ allClasses: false, pickedClassId: id }, () => this.loadSchool())
  },

  pickWeekday(e) {
    const w = Number(e.currentTarget.dataset.w)
    this.setData({ weekday: w }, () => this.loadSchool())
  },

  viewClassSchedule(e) {
    wx.navigateTo({ url: '/pages/schedule-teacher/schedule-teacher?classId=' + e.currentTarget.dataset.id })
  },

  /** 单班课表里点格子：看全称科目与教师（格子里只显示两字简称） */
  tapClassCell(e) {
    const { subject, teacherName, swapText, weekday, period, timeText } = e.currentTarget.dataset
    if (!subject) return
    const lines = ['周' + WEEK_NAMES[(weekday || 1) - 1] + ' 第' + period + '节' + (timeText ? '（' + timeText + '）' : ''), subject]
    if (teacherName) lines.push('任课教师：' + teacherName)
    if (swapText) lines.push(swapText)
    wx.showModal({ title: '课程详情', content: lines.join('\n'), showCancel: false })
  },

  importSchedule() {
    if (!this.data.isAdmin) {
      toast('仅管理员可导入课表')
      return
    }
    wx.navigateTo({ url: '/pages/admin-import/admin-import?type=class-schedule' })
  },

  /* ================= 换课：两步选课（按日期，未来两周内） ================= */

  /**
   * 第 1 步入口：列出未来两周（10 个上课日）里「我」的课。
   * 课表本身是按「星期几」录的，所以同一天的课在两周内会各出现一次，
   * 这里用 date 区分（weekday 决定查哪天的课表，date 决定落在未来哪一天）。
   */
  async startSwap() {
    const days = upcomingDays(10)
    const lessons = await this.lessonsOfDays(days)
    if (!lessons.length) {
      toast('未来两周内没有你的课，无法发起换课')
      return
    }
    this.setData({
      swapPanel: true,
      swapStep: 1,
      swapDays: days,
      swapDayIndex: 0,
      allSwapLessons: lessons,
      swapLessons: lessons.filter(l => l.date === days[0].date),
      swapForm: { first: null, second: null, targetId: null, targetName: '', reason: '' },
    })
  },

  /**
   * 展开未来 n 天里「我」的所有课，按日期分组。
   * @param {Array} days upcomingDays 的结果
   */
  async lessonsOfDays(days) {
    const session = this.data.session
    const periods = await loadPeriods()
    const out = []
    for (let i = 0; i < days.length; i++) {
      const d = days[i]
      const raw = await getTeacherDaySchedule(session.teacherId, d.date)
      raw.forEach((r, idx) => {
        const p = periods.find(x => x.period === r.period)
        out.push({
          ...r,
          key: 'a_' + d.date + '_' + idx,
          weekday: d.weekday,
          weekdayName: weekdayName(d.weekday),
          date: d.date,
          dateLabel: d.label + ' ' + d.sub,
          timeText: p ? p.start + '-' + p.end : '',
        })
      })
      days[i].count = raw.length
    }
    return out
  },

  /** 切换第 1 步里查看的日期 */
  pickSwapDay(e) {
    const i = Number(e.currentTarget.dataset.index)
    const day = this.data.swapDays[i]
    if (!day) return
    this.setData({
      swapDayIndex: i,
      swapLessons: this.data.allSwapLessons.filter(l => l.date === day.date),
    })
  },

  /**
   * 第 2 步：列出候选老师的课，供发起方挑一节「换回来」的课。
   * 这节课必须属于被选中的接收老师。
   */
  async pickFirst(e) {
    const index = Number(e.currentTarget.dataset.index)
    const first = this.data.swapLessons[index]
    if (!first) return
    const candidates = this.data.teachers.filter(t => Number(t.id) !== Number(this.data.session.teacherId))
    if (!candidates.length) {
      toast('没有其他老师可选')
      return
    }
    this.setData({ 'swapForm.first': first, teacherPicker: true, teacherKeyword: '' })
    await this.refreshCandidates('')
  },

  closeTeacherPicker() {
    this.setData({ teacherPicker: false, 'swapForm.first': null })
  },

  onKeywordInput(e) {
    const keyword = e.detail.value
    this.setData({ teacherKeyword: keyword })
    this.refreshCandidates(keyword)
  },

  async refreshCandidates(keyword) {
    const first = this.data.swapForm.first
    if (!first) return
    const [all, schedules, swaps] = await Promise.all([
      listTeachers(),
      listSchedules(),
      findAll('swap_requests', { status: 'approved' }),
    ])
    const teacherMap = await teacherNameMap()
    const classMap = {}
    this.data.classes.forEach(c => {
      classMap[c.id] = c.name
    })

    // 候选生成交给 utils/school 的 buildSwapCandidates ——
    // 它统一用 overlay 判断任课归属，保证候选里不会出现发起方自己的课
    const list = buildSwapCandidates({
      requesterId: this.data.session.teacherId,
      days: this.data.swapDays || [],
      teachers: all,
      schedules,
      swaps,
      teacherMap,
      classMap,
      keyword,
      first,
    })
    this.setData({ teacherCandidates: list })
  },

  /** 选中接收老师，进入第 3 步挑他的哪一节课 */
  pickCandidate(e) {
    const id = Number(e.currentTarget.dataset.id)
    const name = e.currentTarget.dataset.name
    const idx = Number(e.currentTarget.dataset.index)
    const t = this.data.teacherCandidates.find(x => x.id === id)
    if (!t || !t.lessons[idx]) return
    // 被申请的老师在我选中的那节课上已经有课 → 不允许发起
    if (t.blocked) {
      toast(t.blocked)
      return
    }
    this.setData({
      teacherPicker: false,
      swapStep: 2,
      'swapForm.targetId': id,
      'swapForm.targetName': name,
      'swapForm.second': t.lessons[idx],
    })
  },

  backToStep1() {
    this.setData({
      swapStep: 1,
      'swapForm.first': null,
      'swapForm.second': null,
      'swapForm.targetId': null,
      'swapForm.targetName': '',
    })
  },

  closeSwap() {
    this.setData({ swapPanel: false, teacherPicker: false })
  },

  onReasonInput(e) {
    this.setData({ 'swapForm.reason': e.detail.value })
  },

  async submitSwap() {
    const { first, second, targetId, targetName, reason } = this.data.swapForm
    if (!first || !second) {
      toast('请选择两节课')
      return
    }
    if (!targetId) {
      toast('请选择接收老师')
      return
    }
    // 换课是「我 ⇄ 别的老师」，绝不能选到自己
    if (Number(targetId) === Number(this.data.session.teacherId)) {
      toast('不能和自己换课，请选择其他老师')
      return
    }
    if (Number(second.teacherId || targetId) === Number(this.data.session.teacherId)) {
      toast('所选的这节课已经是你的课了，请选择其他老师的课')
      return
    }
    if (first.classId && second.classId && Number(first.classId) === Number(second.classId) &&
      Number(first.weekday) === Number(second.weekday) && Number(first.period) === Number(second.period)) {
      toast('两节课是同一格，请重新选择')
      return
    }
    // 冲突校验：被申请的老师在第一节课的节次上已有课 / 我在第二节课的节次上已有课，
    // 对调后都会变成同一节上两节课。服务端还会再拦一次，这里先给出可读提示。
    wx.showLoading({ title: '校验中', mask: true })
    try {
      const [allSchedules, approved] = await Promise.all([
        listSchedules(),
        findAll('swap_requests', { status: 'approved' }),
      ])
      const classMap = {}
      this.data.classes.forEach(c => { classMap[c.id] = c.name })
      const check = checkSwapConflict({
        requesterId: this.data.session.teacherId,
        targetId,
        targetName,
        first: { weekday: first.weekday, period: first.period },
        second: { weekday: second.weekday, period: second.period },
        schedules: allSchedules,
        swaps: approved,
        teacherMap: await teacherNameMap(),
        classMap,
      })
      if (!check.ok) {
        wx.hideLoading()
        toast(check.reason)
        return
      }
    } catch (e) {
      // 校验失败不阻断提交，服务端还有一道闸
    }

    const session = this.data.session
    wx.showLoading({ title: '提交中', mask: true })
    try {
      const created = await createSwapRequest({
        requester_id: session.teacherId,
        requester_name: session.name,
        target_id: targetId,
        target_name: targetName,
        class_id: first.classId,
        weekday: first.weekday,
        period_no: first.period,
        subject: first.subject,
        lesson_date: first.date || null,
        swap_weekday: second.weekday,
        swap_period_no: second.period,
        swap_subject: second.subject,
        swap_date: second.date || null,
        swap_teacher_id: targetId,
        swap_teacher_name: targetName,
        swap_class_id: second.classId || first.classId,
        reason,
        original_teacher_id: session.teacherId,
        original_teacher_name: session.name,
        original_subject: first.subject,
        school_id: session.schoolId,
      })
      // 发起方与接收方都收到「申请已发出」的通知，班主任在同意/撤销时才发
      await notifySwap(created || this.data.swapForm, 'apply', { note: reason })
      wx.hideLoading()
      toast('已发送换课申请')
      this.setData({ swapPanel: false, teacherPicker: false, tab: 'swap' })
      this.loadSwaps()
    } catch (e) {
      wx.hideLoading()
      toast(e.message || '提交失败')
    }
  },

  openSwap(e) {
    wx.navigateTo({ url: '/pages/swap-detail/swap-detail?id=' + e.currentTarget.dataset.id })
  },

  /** 列表上直接撤销（待处理 / 已同意都可以），省得再进详情页 */
  async quickCancel(e) {
    const id = Number(e.currentTarget.dataset.id)
    // 我发起的和对方发来的都要能撤
    const row = this.data.mySwaps.concat(this.data.inboxSwaps).find(r => Number(r.id) === id)
    if (!row) return
    const wasApproved = row.status === 'approved'
    const who = Number(row.requester_id) === Number(this.data.session.teacherId)
      ? row.target_name
      : row.requester_name
    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: wasApproved ? '撤销已同意的换课' : '撤销换课申请',
        content: wasApproved
          ? `撤销后课表会恢复原样，与 ${who} 都会收到通知。确定撤销吗？`
          : `${who} 将不再收到该申请。确定撤销吗？`,
        confirmColor: '#ef4444',
        success: r => resolve(r.confirm),
      })
    })
    if (!confirm) return
    wx.showLoading({ title: '处理中', mask: true })
    try {
      await updateSwapRequest(id, {
        status: 'cancelled',
        resolved_at: new Date().toISOString(),
      })
      await notifySwap(row, 'cancel', { wasApproved })
      wx.hideLoading()
      toast(wasApproved ? '已撤销，课表已恢复' : '已撤销')
      this.loadSwaps()
    } catch (err) {
      wx.hideLoading()
      toast(err.message || '操作失败')
    }
  },
})