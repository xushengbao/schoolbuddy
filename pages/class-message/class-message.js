const { getSession } = require('../../utils/auth')
const { teacherClasses, listClasses } = require('../../utils/school')
const { insert, findAll } = require('../../utils/db')
const { toast } = require('../../utils/util')
const { formatMessageTime } = require('../../utils/message-sync')
const tts = require('../../utils/tts')

Page({
  data: {
    classes: [],
    classId: null,
    mode: 'text',
    content: '',
    history: [],
    ttsSupported: false,
    quickTexts: [
      '请同学们按时到校，注意交通安全',
      '明天上午进行体检，请带好水杯',
      '请各位同学于课后留在教室收作业',
      '下午放学后各班干部留下开会',
    ],
  },

  onLoad() {
    const session = getSession()
    if (!session || session.role === 'class') {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({ session, ttsSupported: tts.isSupported() })
  },

  async onShow() {
    await this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    const session = this.data.session
    const mine = await teacherClasses(session.teacherId)
    const all = await listClasses()
    const options = session.isAdmin ? all : mine
    let classId = this.data.classId
    if (!classId && options.length) classId = options[0].id

    const history = await findAll('class_messages', {}, { column: 'created_at', ascending: false }, 20)
    const historyView = history.map(m => ({
      ...m,
      className: (all.find(c => c.id === m.class_id) || {}).name || '',
      timeText: formatMessageTime(m.created_at),
    }))

    this.setData({ classes: options, classId, history: historyView })
  },

  pickClass(e) {
    this.setData({ classId: Number(e.currentTarget.dataset.id) })
  },

  setMode(e) {
    this.setData({ mode: e.currentTarget.dataset.m })
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value })
  },

  useQuick(e) {
    this.setData({ content: e.currentTarget.dataset.t })
  },

  async send() {
    const session = this.data.session
    if (!this.data.classId) {
      toast('请选择班级')
      return
    }
    const content = String(this.data.content || '').trim()
    if (!content) {
      toast('请输入消息内容')
      return
    }
    wx.showLoading({ title: '发送中', mask: true })
    try {
      await insert('class_messages', {
        class_id: this.data.classId,
        teacher_id: session.teacherId,
        teacher_name: session.name,
        mode: this.data.mode,
        content,
      })
      wx.hideLoading()
      toast('已发送')
      this.setData({ content: '' })
      this.load()
    } catch (e) {
      wx.hideLoading()
      toast(e.message || '发送失败')
    }
  },

  /** 预览播报效果：在发送前先听听效果，确认插件是否可用 */
  async previewVoice() {
    const content = String(this.data.content || '').trim()
    if (!content) {
      toast('请先输入要预览的内容')
      return
    }
    tts.unlock()
    if (!tts.isSupported()) {
      wx.showModal({
        title: tts.isDisabled() ? '语音播报未启用' : '语音插件未开通',
        content: tts.isDisabled()
          ? '当前版本没有启用「微信同声传译」插件，语音播报暂不可用。\n\n如需启用：先在微信公众平台「设置 → 第三方设置 → 插件管理」申请开通「微信同声传译」，获批后再由管理员在代码中开启。\n\n现在建议改用「静默文字」，文字通知在班级端会立即显示。'
          : '小程序后台尚未开通「微信同声传译」插件，语音播报无法使用。\n\n开通方式：微信公众平台 → 管理 → 设置 → 第三方设置 → 插件管理 → 添加「微信同声传译」。\n\n也可以改用「静默文字」，文字通知在班级端会立即显示。',
        confirmText: '知道了',
        showCancel: false,
      })
      return
    }
    wx.showLoading({ title: '生成中', mask: true })
    const res = await tts.speak(content, { force: true })
    wx.hideLoading()
    if (!res.ok && res.reason !== 'no-plugin') {
      toast('播报失败，请重试')
    }
  },
})