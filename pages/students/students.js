const { getSession, isAdmin } = require('../../utils/auth')
const {
  loadPeriods,
  listClasses,
  listStudents,
  summarizeStudentStatus,
  teacherClasses,
} = require('../../utils/school')
const { today, formatDay } = require('../../utils/util')

const STATUS_STYLE = {
  病假: { bg: '#fee2e2', color: '#b91c1c' },
  事假: { bg: '#fef3c7', color: '#b45309' },
  医务室: { bg: '#dbeafe', color: '#1d4ed8' },
  其他: { bg: '#ede9fe', color: '#6d28d9' },
}

Page({
  data: {
    isAdmin: false,
    classes: [],
    classId: null,
    className: '',
    students: [],
    totalStats: [],
    periodStats: [],
    day: '',
    dayText: '',
  },

  onLoad() {
    const session = getSession()
    if (!session) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ isAdmin: isAdmin(), session })
  },

  async onShow() {
    const day = today()
    this.setData({ day, dayText: formatDay(day) })
    const classes = await this.visibleClasses()
    let classId = this.data.classId
    if (!classId && classes.length) {
      classId = sessionRoleClass() ? sessionRoleClass().classId : classes[0].id
    }
    if (!classId) {
      this.setData({ classes, classId: null, students: [], totalStats: [], periodStats: [] })
      return
    }
    this.setData({ classes, classId }, () => this.loadClass(classId, day))
  },

  async loadClass(classId, day) {
    const periods = await loadPeriods()
    const students = await listStudents(classId)
    const { rows, summary } = await summarizeStudentStatus(classId, day)

    const byStudent = {}
    rows.forEach(r => {
      if (!byStudent[r.student_id]) byStudent[r.student_id] = []
      byStudent[r.student_id].push(r)
    })

    const studentView = students.map(s => {
      const list = byStudent[s.id] || []
      const dayRow = list.find(r => Number(r.period_no) === 0)
      const periodRows = list.filter(r => Number(r.period_no) > 0)
      return {
        ...s,
        dayStatus: dayRow && dayRow.status !== '正常'
          ? { status: dayRow.status, ...(STATUS_STYLE[dayRow.status] || STATUS_STYLE['其他']) }
          : null,
        periodStatus: periodRows
          .filter(r => r.status !== '正常')
          .map(r => ({ period: r.period_no, status: r.status, ...(STATUS_STYLE[r.status] || STATUS_STYLE['其他']) })),
      }
    })

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

    const klass = this.data.classes.find(c => c.id === classId)
    this.setData({
      students: studentView,
      totalStats,
      periodStats,
      className: klass ? klass.name : '',
    })
  },

  async visibleClasses() {
    const session = sessionRole()
    if (!session) return []
    if (session.role === 'class') return (await listClasses()).filter(c => c.id === session.classId)
    if (session.role === 'teacher') return teacherClasses(session.teacherId)
    return listClasses()
  },

  pickClass(e) {
    const id = Number(e.currentTarget.dataset.id)
    this.setData({ classId: id }, () => this.loadClass(id, this.data.day))
  },

  openStudent(e) {
    wx.navigateTo({ url: '/pages/student-detail/student-detail?id=' + e.currentTarget.dataset.id + '&classId=' + this.data.classId })
  },

  goImport() {
    wx.navigateTo({ url: '/pages/admin-import/admin-import?type=students' })
  },
})

function sessionRole() {
  return getSession()
}
function sessionRoleClass() {
  const s = getSession()
  return s && s.role === 'class' ? s : null
}