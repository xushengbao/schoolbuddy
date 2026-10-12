const { getSession, logout } = require('../../utils/auth')
const { findOne, update } = require('../../utils/db')
const { hashPassword, toast } = require('../../utils/util')

const ROLE_TEXT = {
  super: '超级管理员',
  admin: '学校管理员',
  teacher: '教师',
  class: '班级账号',
}

Page({
  data: {
    session: {},
    schoolName: '',
    initial: '',
    roleText: '',
    oldPwd: '',
    newPwd: '',
    confirmPwd: '',
    showOldPwd: false,
    showNewPwd: false,
    showConfirmPwd: false,
  },

  onShow() {
    const session = getSession()
    if (!session) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const roleText = ROLE_TEXT[session.role] || '教师'
    this.setData({
      session,
      schoolName: session.schoolName || '',
      initial: (session.name || '?').charAt(0),
      roleText,
    })
  },

  onOldInput(e) {
    this.setData({ oldPwd: e.detail.value })
  },
  onNewInput(e) {
    this.setData({ newPwd: e.detail.value })
  },
  onConfirmInput(e) {
    this.setData({ confirmPwd: e.detail.value })
  },

  toggleOldPwd() {
    this.setData({ showOldPwd: !this.data.showOldPwd })
  },
  toggleNewPwd() {
    this.setData({ showNewPwd: !this.data.showNewPwd })
  },
  toggleConfirmPwd() {
    this.setData({ showConfirmPwd: !this.data.showConfirmPwd })
  },

  async changePassword() {
    const { oldPwd, newPwd, confirmPwd, session } = this.data
    if (!oldPwd || !newPwd) {
      toast('请填写完整')
      return
    }
    if (newPwd !== confirmPwd) {
      toast('两次输入的新密码不一致')
      return
    }
    if (newPwd.length < 6) {
      toast('新密码至少 6 位')
      return
    }

    const table = session.role === 'class' ? 'classes' : 'teachers'
    const row = await findOne(table, { id: session.role === 'class' ? session.classId : session.teacherId })
    if (!row) {
      toast('账号不存在')
      return
    }
    if (row.password_hash !== hashPassword(oldPwd)) {
      toast('原密码不正确')
      return
    }

    try {
      await update(table, { id: row.id }, { password_hash: hashPassword(newPwd) })
      toast('密码已修改')
      this.setData({ oldPwd: '', newPwd: '', confirmPwd: '' })
    } catch (e) {
      toast(e.message || '修改失败')
    }
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' })
  },
  goSchoolAdmin() {
    wx.navigateTo({ url: '/pages/school-admin/school-admin' })
  },
  goPeriods() {
    wx.navigateTo({ url: '/pages/periods/periods' })
  },
  goStatusOptions() {
    wx.navigateTo({ url: '/pages/admin-options/admin-options' })
  },
  goTeachers() {
    wx.navigateTo({ url: '/pages/teachers/teachers' })
  },
  goMessage() {
    wx.navigateTo({ url: '/pages/class-message/class-message' })
  },
  goDisplay() {
    wx.navigateTo({ url: '/pages/message-display/message-display' })
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: r => {
        if (r.confirm) {
          logout()
          wx.reLaunch({ url: '/pages/login/login' })
        }
      },
    })
  },
})