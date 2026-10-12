const { getSession } = require('../../utils/auth')
const { fetchClassMessages, formatMessageTime, sameMessages, createPoller } = require('../../utils/message-sync')
const tts = require('../../utils/tts')

/** 轮询间隔：5 秒。班级大屏常驻前台，这个频率既能及时又不会太费流量 */
const POLL_MS = 5000

Page({
  data: {
    classId: null,
    className: '',
    messages: [],
    clockText: '',
    autoPlay: false,
    ttsReady: false,
    ttsSupported: false,
    speakingId: 0,
    latestId: 0,
    lastSyncText: '',
  },

  onLoad() {
    const session = getSession()
    if (!session) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    this.setData({
      classId: session.classId || null,
      className: session.name,
      ttsSupported: tts.isSupported(),
    })
    this.timer = setInterval(() => this.refreshClock(), 1000)
    this.refreshClock()

    // 已播报过的消息 id，避免轮询把同一条语音反复读出来
    this.spokenIds = {}

    this.poller = createPoller({
      interval: POLL_MS,
      task: () => this.load({ silent: true }),
    })
  },

  onShow() {
    if (this.poller) this.poller.start()
  },

  onHide() {
    if (this.poller) this.poller.stop()
    tts.stop()
    this.setData({ speakingId: 0 })
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer)
    if (this.poller) this.poller.stop()
    tts.stop()
  },

  onPullDownRefresh() {
    this.load({ silent: true }).then(() => wx.stopPullDownRefresh())
  },

  refreshClock() {
    const d = new Date()
    const pad = n => (n < 10 ? '0' + n : '' + n)
    this.setData({ clockText: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) })
  },

  /**
   * 拉取班级消息。
   * @param {object} options silent=true 时（轮询/下拉）不弹任何提示
   */
  async load(options) {
    const opts = options || {}
    if (!this.data.classId) return
    const rows = await fetchClassMessages(this.data.classId, 12)
    const messages = rows.map(m => ({
      ...m,
      timeText: formatMessageTime(m.created_at),
      playing: false,
    }))

    // 内容没变就别 setData，避免大屏每秒闪一次
    if (sameMessages(this.data.messages, messages)) {
      this.setData({ lastSyncText: '已同步 ' + stamp() })
      return
    }

    // 找出新出现的语音消息（顶部新增的）
    const knownIds = this.data.messages.map(m => Number(m.id))
    const fresh = messages.filter(m => m.mode === 'voice' && knownIds.indexOf(Number(m.id)) === -1)

    this.setData({
      messages,
      latestId: messages.length ? Number(messages[0].id) : 0,
      lastSyncText: '已同步 ' + stamp(),
    })

    // 首次加载不自动播（用户还没解锁音频，且历史消息不该全读一遍）
    if (!opts.silent && messages.length) {
      // 手动进入页面时只提示最新一条
      this.markSpoken(messages[0].id)
      return
    }

    // 轮询发现新语音 → 若已开启自动播报且已解锁，立刻读出来
    if (fresh.length && this.data.autoPlay && tts.isUnlocked()) {
      this.speakMessage(fresh[0])
    } else {
      fresh.forEach(m => this.markSpoken(m.id))
    }
  },

  markSpoken(id) {
    if (!this.spokenIds) this.spokenIds = {}
    this.spokenIds[Number(id)] = true
  },

  /**
   * 开启自动播报。必须由用户点击触发 —— 微信规定音频首次播放必须来自用户手势，
   * 这是「进页面就自动开口」做不到的根本原因。
   */
  async enableAuto() {
    tts.unlock()

    if (!this.data.ttsSupported) {
      this.setData({ autoPlay: false, ttsReady: false })
      wx.showModal({
        title: '语音播报尚未启用',
        content: tts.isDisabled()
          ? '当前版本没有启用「微信同声传译」插件，通知会以醒目文字展示（内容不会丢）。\n\n如需语音播报：先在微信公众平台「设置 → 第三方设置 → 插件管理」申请开通「微信同声传译」，获批后由管理员在代码中开启该插件即可。'
          : '小程序后台尚未开通「微信同声传译」插件，无法朗读。\n\n开通方式：微信公众平台 → 管理 → 设置 → 第三方设置 → 插件管理 → 添加「微信同声传译」。\n\n在插件开通前，通知会以醒目的文字形式展示，不会丢失。',
        confirmText: '知道了',
        showCancel: false,
      })
      return
    }

    this.setData({ autoPlay: true, ttsReady: true })

    // 把还没读过的语音补读一遍（每次进入页面最多读最新一条，避免刷屏）
    const pending = this.data.messages.filter(
      m => m.mode === 'voice' && !this.spokenIds[Number(m.id)]
    )
    if (pending.length) {
      this.speakMessage(pending[0])
    } else {
      wx.showToast({ title: '已开启自动播报', icon: 'none' })
    }
  },

  disableAuto() {
    tts.stop()
    this.setData({ autoPlay: false, speakingId: 0 })
    this.spokenIds = {}
    wx.showToast({ title: '已关闭自动播报', icon: 'none' })
  },

  toggleAuto() {
    if (this.data.autoPlay) this.disableAuto()
    else this.enableAuto()
  },

  /** 手动点单条播报 */
  play(e) {
    const text = e.currentTarget.dataset.text
    const id = Number(e.currentTarget.dataset.id)
    if (!text) return
    tts.unlock()
    // 手动点击视作手势，直接强制播
    this.speakMessage({ id, content: text, timeText: '' }, true)
  },

  /**
   * 播报一条消息。
   * @param {object} msg 至少含 id / content
   * @param {boolean} force 手动触发时忽略「是否已解锁」检查
   */
  async speakMessage(msg, force) {
    if (!msg || !msg.content) return
    const id = Number(msg.id)

    if (this.speakingId === id) return

    this.setData({ speakingId: id })
    this.markSpoken(id)

    const res = await tts.speak(msg.content, { force: !!force })

    if (this.data.speakingId === id) this.setData({ speakingId: 0 })

    if (!res.ok && res.reason === 'locked') {
      wx.showToast({ title: '请先点「开启自动播报」', icon: 'none' })
      return
    }
    if (!res.ok && res.reason !== 'no-plugin') {
      wx.showToast({ title: '播报失败，请重试', icon: 'none' })
    }
  },
})

function stamp() {
  const d = new Date()
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}
