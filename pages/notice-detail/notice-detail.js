const { findOne } = require('../../utils/db')
const { markNoticeRead } = require('../../utils/school')

Page({
  data: {
    notice: null,
  },

  async onLoad(options) {
    const notice = await findOne('notices', { id: Number(options.id) })
    if (!notice) return
    if (!notice.is_read) {
      markNoticeRead(notice.id).catch(() => {})
    }
    this.setData({
      notice: { ...notice, timeText: formatTime(notice.created_at) },
    })
  },

  goSwapList() {
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },
})

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}