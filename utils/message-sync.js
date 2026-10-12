/**
 * 班级消息的「近实时」同步
 * ---------------------------------------------------------------
 * 小程序没有 WebSocket 能力可用（云开发 SDK 也不提供推送），所以班级端要看到
 * 教师刚发的消息，只能靠轮询。这里把轮询封装成一个可复用的小工具：
 *
 *   const poller = createPoller({ interval: 5000, immediate: true, task: () => this.refresh() })
 *   poller.start()   // onShow 里调
 *   poller.stop()    // onHide / onUnload 里调
 *
 * 关键点：
 * 1. **页面隐藏时必须停**。后台页面继续轮询会白耗电、也会被系统杀掉；
 * 2. **切回前台立即拉一次**，避免用户在后台期间错过了新消息；
 * 3. **请求不重叠**。上一次还没回来就不发起下一次，否则弱网下会堆积；
 * 4. **失败静默**。轮询失败不该打扰用户，下次成功就自然恢复。
 */

const { findAll } = require('./db')

/** 一次拉取某个班级的最新消息，按时间倒序 */
async function fetchClassMessages(classId, limit) {
  if (!classId) return []
  const rows = await findAll(
    'class_messages',
    { class_id: classId },
    { column: 'created_at', ascending: false },
    limit || 12
  )
  return rows || []
}

/** 把 created_at 格式化成「10-12 08:30」 */
function formatMessageTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 只在内容真正变化时才返回 true，用来避免无意义的 setData */
function sameMessages(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Number(a[i].id) !== Number(b[i].id)) return false
    if (a[i].content !== b[i].content) return false
    if (a[i].mode !== b[i].mode) return false
  }
  return true
}

/**
 * 创建轮询器。
 *
 * @param {object} options
 * @param {Function} options.task     每轮要跑的异步任务
 * @param {number}  [options.interval=5000]  轮询间隔（毫秒）
 * @param {boolean} [options.immediate=true] start() 时是否立即跑一轮
 * @param {Function}[options.onError] 任务出错时的回调（默认静默）
 */
function createPoller(options) {
  const task = options.task
  const interval = options.interval || 5000
  const immediate = options.immediate !== false
  const onError = options.onError

  let timer = null
  let running = false

  async function tick() {
    // 上一轮还没结束就跳过本轮，避免请求堆积
    if (running) return
    running = true
    try {
      await task()
    } catch (e) {
      if (typeof onError === 'function') onError(e)
      // 轮询失败静默：下一次成功即恢复
    } finally {
      running = false
    }
  }

  return {
    start() {
      this.stop()
      if (immediate) tick()
      timer = setInterval(tick, interval)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    /** 切回前台时用：立刻补一次，然后重新计时 */
    refresh() {
      tick()
    },
    isRunning() {
      return !!timer
    },
  }
}

module.exports = {
  fetchClassMessages,
  formatMessageTime,
  sameMessages,
  createPoller,
}
