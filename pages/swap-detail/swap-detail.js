const { getSession } = require('../../utils/auth')
const { updateSwapRequest, listClasses, describeSwap, notifySwap } = require('../../utils/school')
const { findOne } = require('../../utils/db')
const { weekdayName, shortDay, today, toast } = require('../../utils/util')

/** 一节课的完整描述：带日期写成「10月13日 周一 第1节 语文」，否则省略日期 */
function lessonText(date, weekday, periodNo, subject) {
  const when = date ? shortDay(date) : weekdayName(weekday)
  return `${when} 第${periodNo}节 ${subject || ''}`.trim()
}

const STATUS_VIEW = {
  pending: { text: '待处理', bg: '#fef3c7', color: '#b45309' },
  approved: { text: '已同意', bg: '#dcfce7', color: '#15803d' },
  rejected: { text: '已拒绝', bg: '#fee2e2', color: '#b91c1c' },
  cancelled: { text: '已撤销', bg: '#e5e7eb', color: '#4b5563' },
}

Page({
  data: {
    id: null,
    detail: null,
    note: '',
    canHandle: false,
    // 待处理时只有发起方能撤；已同意后双方都能撤
    canCancel: false,
    cancelTip: '',
  },

  async onLoad(options) {
    this.setData({ id: options.id })
    await this.load()
  },

  onShow() {
    if (this.data.id) this.load()
  },

  async load() {
    const row = await findOne('swap_requests', { id: Number(this.data.id) })
    if (!row) {
      toast('申请不存在')
      return
    }
    const session = getSession()
    const classes = await listClasses()
    const classMap = {}
    classes.forEach(c => {
      classMap[c.id] = c.name
    })
    const klass = classes.find(c => c.id === row.class_id)
    const status = STATUS_VIEW[row.status] || {}
    const myId = Number(session.teacherId)
    const isParty = myId === Number(row.requester_id) || myId === Number(row.target_id)

    this.setData({
      detail: {
        ...row,
        className: classMap[row.class_id] || '',
        firstClassName: classMap[row.class_id] || '',
        firstText: lessonText(row.lesson_date, row.weekday, row.period_no, row.subject),
        firstTeacher: row.original_teacher_name || row.requester_name || '',
        secondClassName: classMap[row.swap_class_id] || classMap[row.class_id] || '',
        secondText: row.swap_weekday
          ? lessonText(row.swap_date, row.swap_weekday, row.swap_period_no, row.swap_subject)
          : '',
        secondTeacher: row.swap_teacher_name || row.target_name || '',
        summary: describeSwap(row, classMap[row.class_id]),
        statusText: status.text || row.status,
        statusBg: status.bg || '#f1f5f9',
        statusColor: status.color || '#4b5563',
        headTeacherId: klass ? klass.head_teacher_id : null,
      },
      canHandle: row.status === 'pending' && Number(row.target_id) === myId,
      // 双方在「待处理」或「已同意」两个状态下都能撤销
      canCancel: isParty && (row.status === 'pending' || row.status === 'approved'),
      cancelTip:
        row.status === 'approved'
          ? '换课已生效，双方任何一方都可以撤销，撤销后课表恢复原样'
          : '撤销后对方将不再收到该申请',
    })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  async onApprove() {
    const d = this.data.detail
    wx.showLoading({ title: '处理中', mask: true })
    try {
      await updateSwapRequest(d.id, {
        status: 'approved',
        reply_note: this.data.note || '',
        resolved_at: new Date().toISOString(),
      })
      // 双方 + 两班班主任，去重后由 notifySwap 统一发
      await notifySwap(d, 'approve', { note: this.data.note || '' })
      wx.hideLoading()
      toast('已同意')
      this.setData({ note: '' })
      this.load()
    } catch (e) {
      wx.hideLoading()
      toast(e.message || '操作失败')
    }
  },

  async onReject() {
    const d = this.data.detail
    wx.showLoading({ title: '处理中', mask: true })
    try {
      await updateSwapRequest(d.id, {
        status: 'rejected',
        reply_note: this.data.note || '',
        resolved_at: new Date().toISOString(),
      })
      await notifySwap(d, 'reject', { note: this.data.note || '' })
      wx.hideLoading()
      toast('已拒绝')
      this.setData({ note: '' })
      this.load()
    } catch (e) {
      wx.hideLoading()
      toast(e.message || '操作失败')
    }
  },

  async onCancel() {
    const d = this.data.detail
    const wasApproved = d.status === 'approved'
    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: wasApproved ? '撤销已同意的换课' : '撤销换课申请',
        content: wasApproved
          ? '撤销后两节课会恢复原样，双方与班主任都会收到通知。确定撤销吗？'
          : '撤销后对方将不再收到该申请。确定撤销吗？',
        confirmColor: '#ef4444',
        success: r => resolve(r.confirm),
      })
    })
    if (!confirm) return

    wx.showLoading({ title: '处理中', mask: true })
    try {
      await updateSwapRequest(d.id, {
        status: 'cancelled',
        reply_note: this.data.note || '',
        resolved_at: new Date().toISOString(),
      })
      // 双方都通知；撤销的是已生效换课时，班主任也要收到
      await notifySwap(d, 'cancel', {
        note: this.data.note || '',
        wasApproved,
      })
      wx.hideLoading()
      toast(wasApproved ? '已撤销，课表已恢复' : '已撤销')
      this.setData({ note: '' })
      this.load()
    } catch (e) {
      wx.hideLoading()
      toast(e.message || '操作失败')
    }
  },
})