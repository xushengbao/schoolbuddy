const { getSession, isAdmin, isSuper } = require('../../utils/auth')
const {
  listClasses,
  listTeachers,
  listStudents,
  listSchedules,
  loadPeriods,
  loadStudentStatusOptions,
  listMakeupDays,
} = require('../../utils/school')
const { remove, insert, findOne, update } = require('../../utils/db')
const { hashPassword, toast } = require('../../utils/util')

Page({
  data: {
    counts: { classes: 0, teachers: 0, students: 0, schedules: 0 },
    classes: [],
    teachers: [],
    periods: [],
    statusOptions: [],
    makeupCount: 0,
    pickedClassId: null,
    isSuper: false,
    schoolName: '',
  },

  onShow() {
    if (!isAdmin()) {
      wx.showModal({
        title: '无权限',
        content: '配置中心仅管理员可访问',
        showCancel: false,
        success: () => wx.navigateBack(),
      })
      return
    }
    this.load()
  },

  async load() {
    const classes = await listClasses()
    const teachers = await listTeachers()
    const schedules = await listSchedules()
    const students = await listStudents()
    const periods = await loadPeriods()
    const statusOptions = await loadStudentStatusOptions()
    const makeup = await listMakeupDays()

    const withCounts = []
    for (const c of classes) {
      const list = students.filter(s => s.class_id === c.id)
      withCounts.push({ ...c, studentCount: list.length })
    }

    const session = getSession()
    this.setData({
      classes: withCounts,
      teachers,
      periods,
      statusOptions,
      makeupCount: makeup.length,
      isSuper: isSuper(),
      schoolName: (session && session.schoolName) || '',
      counts: {
        classes: classes.length,
        teachers: teachers.length,
        students: students.length,
        schedules: schedules.length,
      },
    })
  },

  goImportSchedule() {
    wx.navigateTo({ url: '/pages/admin-import/admin-import?type=class-schedule' })
  },
  goImportTeacherSchedule() {
    wx.navigateTo({ url: '/pages/admin-import/admin-import?type=teacher-schedule' })
  },
  goImportStudents() {
    wx.navigateTo({ url: '/pages/admin-import/admin-import?type=students' })
  },
  goImportTeachers() {
    wx.navigateTo({ url: '/pages/admin-import/admin-import?type=teachers' })
  },
  goImportAccounts() {
    wx.navigateTo({ url: '/pages/admin-import/admin-import?type=accounts' })
  },
  goSchoolAdmin() {
    wx.navigateTo({ url: '/pages/school-admin/school-admin' })
  },
  goStatusOptions() {
    wx.navigateTo({ url: '/pages/admin-options/admin-options' })
  },
  goPeriods() {
    wx.navigateTo({ url: '/pages/periods/periods' })
  },
  goMakeup() {
    wx.navigateTo({ url: '/pages/makeup/makeup' })
  },

  newClass() {
    wx.showModal({
      title: '新建班级',
      editable: true,
      placeholderText: '班级名称，如 三年2班',
      success: async r => {
        if (!r.confirm || !r.content) return
        const name = r.content.trim()
        const exists = await findOne('classes', { name })
        if (exists) {
          toast('该班级已存在')
          return
        }
        const account = name
        await insert('classes', {
          name,
          grade: '',
          account,
          password_hash: hashPassword('123456'),
        })
        toast('已创建，初始密码 123456')
        this.load()
      },
    })
  },

  pickClass(e) {
    this.setData({ pickedClassId: Number(e.currentTarget.dataset.id) })
  },

  delTeacher(e) {
    const id = Number(e.currentTarget.dataset.id)
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '删除教师',
      content: `确定删除「${name}」吗？该操作不可撤销。`,
      confirmColor: '#ef4444',
      success: async r => {
        if (!r.confirm) return
        await remove('teachers', { id })
        toast('已删除')
        this.load()
      },
    })
  },

  delClass(e) {
    const id = Number(e.currentTarget.dataset.id)
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '删除班级',
      content: `确定删除「${name}」及其课表、学生名单吗？该操作不可撤销。`,
      confirmColor: '#ef4444',
      success: async r => {
        if (!r.confirm) return
        await remove('classes', { id })
        toast('已删除班级')
        this.load()
      },
    })
  },

  clearSchedule() {
    const id = this.data.pickedClassId
    if (!id) {
      toast('请先选择班级')
      return
    }
    const klass = this.data.classes.find(c => c.id === id)
    wx.showModal({
      title: '清空课表',
      content: `确定清空「${klass ? klass.name : ''}」的全部课表吗？`,
      confirmColor: '#ef4444',
      success: async r => {
        if (!r.confirm) return
        await remove('schedules', { class_id: id })
        toast('已清空')
        this.load()
      },
    })
  },
})