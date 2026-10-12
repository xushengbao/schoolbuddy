const { getSession, isAdmin } = require('../../utils/auth')
const { listTeachers } = require('../../utils/school')
const { update } = require('../../utils/db')
const { toast } = require('../../utils/util')

const STATUS_STYLE = {
  在位中: { bg: '#dcfce7', color: '#15803d' },
  请假中: { bg: '#fee2e2', color: '#b91c1c' },
  公出中: { bg: '#dbeafe', color: '#1d4ed8' },
  开会中: { bg: '#fef3c7', color: '#b45309' },
}

const STATUS_OPTIONS = ['在位中', '请假中', '公出中', '开会中']

Page({
  data: {
    isAdmin: false,
    teachers: [],
    groups: [],
    group: '',
    stats: [],
    statusOptions: STATUS_OPTIONS,
    myStatus: '在位中',
    myGroup: '',
  },

  onLoad() {
    const session = getSession()
    if (!session || session.role === 'class') {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ isAdmin: isAdmin() })
  },

  async onShow() {
    await this.load()
  },

  async load() {
    const all = await listTeachers()
    const session = getSession()
    const me = all.find(t => t.id === session.teacherId)

    const groups = []
    all.forEach(t => {
      const g = t.subject_group || '未分组'
      if (!groups.includes(g)) groups.push(g)
    })

    const stats = STATUS_OPTIONS.map(status => ({
      status,
      count: all.filter(t => t.status === status).length,
      color: STATUS_STYLE[status].color,
    }))

    const filtered = this.data.group ? all.filter(t => (t.subject_group || '未分组') === this.data.group) : all
    const teachers = filtered.map(t => ({
      ...t,
      bg: (STATUS_STYLE[t.status] || STATUS_STYLE['在位中']).bg,
      color: (STATUS_STYLE[t.status] || STATUS_STYLE['在位中']).color,
    }))

    this.setData({
      teachers,
      groups,
      stats,
      myStatus: me ? me.status : '在位中',
      myGroup: me ? me.subject_group || '未分组' : '',
    })
  },

  pickGroup(e) {
    this.setData({ group: e.currentTarget.dataset.g }, () => this.load())
  },

  async setMyStatus(e) {
    const value = e.currentTarget.dataset.v
    const session = getSession()
    try {
      await update('teachers', { id: session.teacherId }, { status: value })
      toast('状态已更新：' + value)
      this.setData({ myStatus: value })
      this.load()
    } catch (err) {
      toast(err.message || '更新失败')
    }
  },

  openTeacher(e) {
    wx.navigateTo({ url: '/pages/teacher-detail/teacher-detail?id=' + e.currentTarget.dataset.id })
  },

  goImport() {
    wx.navigateTo({ url: '/pages/admin-import/admin-import?type=teachers' })
  },
})