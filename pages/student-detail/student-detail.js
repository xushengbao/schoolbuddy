const { getSession } = require('../../utils/auth')
const { loadPeriods, loadStudentStatusOptions, setStudentStatus, clearStudentStatus } = require('../../utils/school')
const { findOne, findAll } = require('../../utils/db')
const { today, toast } = require('../../utils/util')

Page({
  data: {
    studentId: null,
    classId: null,
    student: null,
    className: '',
    options: [],
    periods: [],
    dayStatus: '',
    statusMap: {},
    note: '',
  },

  async onLoad(options) {
    this.setData({ studentId: Number(options.id), classId: Number(options.classId) })
    await this.load()
  },

  async load() {
    const { studentId, classId } = this.data
    const student = await findOne('students', { id: studentId })
    if (!student) {
      toast('学生不存在')
      return
    }
    const options = await loadStudentStatusOptions()
    const periods = await loadPeriods()
    const rows = await findAll('student_status', { student_id: studentId, day: today() })

    const dayStatus = (rows.find(r => Number(r.period_no) === 0) || {}).status || ''
    const statusMap = {}
    let note = ''
    rows.forEach(r => {
      if (Number(r.period_no) > 0) statusMap[r.period_no] = r.status
      if (r.note) note = r.note
    })

    const classes = await findAll('classes', { id: classId })
    this.setData({
      student,
      options,
      periods,
      dayStatus: dayStatus === '正常' ? '' : dayStatus,
      statusMap,
      note,
      className: classes.length ? classes[0].name : '',
    })
  },

  async setDayStatus(e) {
    const value = e.currentTarget.dataset.v
    const day = today()
    if (value === '正常') {
      await clearStudentStatus(this.data.studentId, day, 0)
    } else {
      await setStudentStatus({
        student_id: this.data.studentId,
        student_name: this.data.student.name,
        class_id: this.data.classId,
        day,
        period_no: 0,
        status: value,
        note: this.data.note,
        operator: (getSession() || {}).name || '',
      })
    }
    toast('已设置')
    this.load()
  },

  async setPeriodStatus(e) {
    const period = Number(e.currentTarget.dataset.p)
    const value = e.currentTarget.dataset.v
    const day = today()
    if (value === '正常') {
      await clearStudentStatus(this.data.studentId, day, period)
    } else {
      await setStudentStatus({
        student_id: this.data.studentId,
        student_name: this.data.student.name,
        class_id: this.data.classId,
        day,
        period_no: period,
        status: value,
        note: this.data.note,
        operator: (getSession() || {}).name || '',
      })
    }
    toast('已设置')
    this.load()
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  async saveNote() {
    const rows = await findAll('student_status', { student_id: this.data.studentId, day: today() })
    for (const r of rows) {
      await setStudentStatus({
        student_id: this.data.studentId,
        student_name: this.data.student.name,
        class_id: this.data.classId,
        day: today(),
        period_no: r.period_no,
        status: r.status,
        note: this.data.note,
        operator: (getSession() || {}).name || '',
      })
    }
    toast('备注已保存')
  },
})