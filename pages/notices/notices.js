const { getSession } = require('../../utils/auth')
const { listNotices, markNoticeRead } = require('../../utils/school')

Page({
  data: {
    notices: [],
    onlyUnread: false,
    unreadCount: 0,
  },

  onShow() {
    this.load()
  },

  async load() {
    const session = getSession()
    if (!session || session.role === 'class') {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const all = await listNotices(session.teacherId, false)
    const notices = (this.data.onlyUnread ? all.filter(n => !n.is_read) : all).map(n => ({
      ...n,
      timeText: formatTime(n.created_at),
    }))
    this.setData({
      notices,
      unreadCount: all.filter(n => !n.is_read).length,
    })
  },

  toggleUnread() {
    this.setData({ onlyUnread: !this.data.onlyUnread }, () => this.load())
  },

  openNotice(e) {
    const id = e.currentTarget.dataset.id
    markNoticeRead(id)
    wx.navigateTo({ url: '/pages/notice-detail/notice-detail?id=' + id })
  },

  async markAll() {
    const session = getSession()
    const unread = await listNotices(session.teacherId, true)
    for (const n of unread) {
      await markNoticeRead(n.id)
    }
    wx.showToast({ title: '已全部标记为已读', icon: 'none' })
    this.load()
  },
})

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}