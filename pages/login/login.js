const { loginWithPassword, getSession } = require('../../utils/auth')

Page({
  data: {
    account: '',
    password: '',
    showPwd: false,
    loading: false,
  },

  onLoad() {
    // 已登录直接进入对应首页
    const session = getSession()
    if (session) {
      this.redirect(session)
    }
  },

  onAccountInput(e) {
    this.setData({ account: e.detail.value })
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },

  /** 显示 / 隐藏密码 */
  togglePwd() {
    this.setData({ showPwd: !this.data.showPwd })
  },

  async onLogin() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const session = await loginWithPassword(this.data.account, this.data.password)
      if (session) this.redirect(session)
    } catch (e) {
      wx.showToast({ title: e.message || '登录失败，请重试', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  redirect(session) {
    let url = '/pages/index/index'
    if (session.role === 'class') {
      url = '/pages/class-home/class-home'
    } else if (session.role === 'super') {
      // 超级管理员不属于任何学校，直接进入平台管理页
      url = '/pages/school-admin/school-admin'
    }
    wx.reLaunch({ url })
  },
})