/**
 * 语音播报（Text-to-Speech）适配层
 * ---------------------------------------------------------------
 * 背景：微信小程序的语音播报只有一条官方通道 —— `WechatSI`（微信同声传译）
 * 插件。它有两个硬性前提，**缺一不可**：
 *   1. app.json 里声明了 plugins.WechatSI；
 *   2. 小程序后台「设置 → 第三方设置 → 插件管理」里已获批该插件。
 *
 * ⚠️ 只有前提 2 满足时才能加前提 1。如果后台还没给这个小程序开通该插件，
 * 却在 app.json 里声明了它，**代码上传阶段就会直接失败**：
 *     upload failed: Error: {"errCode":-1,
 *     "errmsg":"inner upload fail with errcode: 80082, errmsg: get plugin ..."
 * （80082 = 插件无权限/不存在）
 *
 * 所以本模块默认「不开插件」，通过下面的 PLUGIN_ENABLED 常量控制。
 * 确认后台已开通该插件后，把它改成 true 并在 app.json 补上声明即可启用，
 * 无需改动任何页面代码。
 *
 * 另外微信还有一条硬限制：**音频自动播放必须先有用户手势**。所以「大屏一进页面
 * 就自动开口」在任何情况下都做不到，必须先让用户点一下。
 *
 * 本模块把这两件事都封起来，对上层只暴露几个能力：
 *   - isSupported()  播报是否可用（用于决定要不要显示引导文案）
 *   - unlock()       在用户手势里调用一次，之后才允许自动播放
 *   - speak(text)    播报一段文字，返回 Promise，播完 resolve
 *
 * 播报不可用时不抛错、不弹窗打断，而是 resolve 成 { ok:false }，由页面决定
 * 降级表现（把文字放大高亮即可，通知本身不会丢）。
 */

/**
 * 是否启用 WechatSI 插件。
 *
 * 改为 true 之前请先确认两件事都做到了：
 *   1. 微信公众平台 → 管理 → 设置 → 第三方设置 → 插件管理 → 已获批「微信同声传译」
 *   2. app.json 里已加上：
 *        "plugins": { "WechatSI": { "version": "0.3.5", "provider": "wx069ba97219f66d99" } }
 *
 * 只满足第 1 条就打开会导致上传失败（80082），请务必两条都确认后再改。
 */
const PLUGIN_ENABLED = false

/** 插件实例，只探测一次 */
let pluginCache
let pluginProbed = false

/** 是否已经点过「开启播报」，未点过之前不允许自动出声 */
let unlocked = false

/** 当前正在播放的音频上下文，全局复用一个 */
let audioCtx = null

/** 同一个 audio 上下文连续复用的兜底计数（部分机型 play 事件偶发不触发） */
const MAX_SAFE_REUSE = 40
let playCount = 0

/** 本次会话是否已经提示过「插件不可用」，避免反复弹窗骚扰 */
let warned = false

/** 仅测试用：强制把插件视为「已启用」，用于覆盖正常播报链路 */
let testOverride = false

/**
 * 探测 WechatSI 插件是否真的可用。
 * 必须在 app.json 声明 + 后台获批都满足时才会返回 true。
 */
function probePlugin() {
  // 开关关闭时直接判定不可用，连 requirePlugin 都不调用 ——
  // 未声明插件时调用它会在真机上抛错，探测一次就够，没必要反复试。
  if (!isPluginEnabled()) return null
  if (pluginProbed) return pluginCache
  pluginProbed = true
  try {
    const plugin = requirePlugin('WechatSI')
    // 插件对象存在但没有 textToSpeech，说明版本不兼容，同样视为不可用
    pluginCache = plugin && typeof plugin.textToSpeech === 'function' ? plugin : null
  } catch (e) {
    pluginCache = null
  }
  return pluginCache
}

/** 插件总开关 = 配置常量 || 测试注入 */
function isPluginEnabled() {
  return testOverride || PLUGIN_ENABLED
}

/** 播报是否可用（插件已声明且已获批） */
function isSupported() {
  return !!probePlugin()
}

/**
 * 解锁音频自动播放。必须在用户点击等手势回调里调用。
 * 微信要求音频的第一次播放由用户手势触发，之后才允许程序化 play()。
 */
function unlock() {
  unlocked = true
  // 静音键/勿扰模式下也允许出声，否则教室里关静音就听不到通知
  try {
    wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: true })
  } catch (e) {
    // 老基础库没有这个 API，忽略即可
  }
}

/** 是否已解锁（页面据此决定要不要显示引导层） */
function isUnlocked() {
  return unlocked
}

/** 把插件产出的临时音频文件播完；text 用于估算兜底超时时长 */
function playFile(filename, text) {
  return new Promise(resolve => {
    // 长时间复用同一个 audio 上下文在部分机型上会静默失败，
    // 用够了就换一个新的，稳妥。
    if (!audioCtx || playCount >= MAX_SAFE_REUSE) {
      if (audioCtx) {
        try { audioCtx.destroy() } catch (e) { /* 已销毁则忽略 */ }
      }
      audioCtx = wx.createInnerAudioContext()
      audioCtx.obeyMuteSwitch = false
      playCount = 0
    }
    const ctx = audioCtx

    let settled = false
    const finish = ok => {
      if (settled) return
      settled = true
      if (typeof ctx.offPlay === 'function') ctx.offPlay()
      if (typeof ctx.offStop === 'function') ctx.offStop()
      if (typeof ctx.offEnded === 'function') ctx.offEnded()
      if (typeof ctx.offError === 'function') ctx.offError()
      resolve(ok)
    }

    // 理论上 InnerAudioContext 一定有这些方法，但真机偶发返回残缺对象的
    // 情况见过，缺一个就直接抛会连带整条播报链断掉，所以全部做存在性判断。
    if (typeof ctx.onPlay === 'function') ctx.onPlay(() => { playCount++ })
    if (typeof ctx.onStop === 'function') ctx.onStop(() => finish(true))
    if (typeof ctx.onEnded === 'function') ctx.onEnded(() => finish(true))
    if (typeof ctx.onError === 'function') ctx.onError(() => finish(false))

    ctx.src = filename
    ctx.play()

    // 兜底：音频很短（几字提示）时 onEnded 可能不触发，按文本长度估算上限收尾
    const limit = 4000 + Math.min(25000, String(text || '').length * 260)
    setTimeout(() => finish(false), limit)
  })
}

/**
 * 播报一段文字。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 *   ok=true  播报完成；ok=false 时 reason 说明原因，调用方应静默降级
 */
function speak(text, opts) {
  const content = String(text || '').trim()
  const options = opts || {}

  if (!content) return Promise.resolve({ ok: false, reason: 'empty' })

  const plugin = probePlugin()
  if (!plugin) {
    if (!warned) {
      warned = true
      if (options.silent !== true) {
        wx.showToast({
          title: '语音插件未开通，已用文字提醒',
          icon: 'none',
          duration: 2500,
        })
      }
    }
    return Promise.resolve({ ok: false, reason: 'no-plugin' })
  }

  // 没解锁时只做一次「不打扰」的解锁请求，交给用户手势去真正解锁
  if (!unlocked && !options.force) {
    return Promise.resolve({ ok: false, reason: 'locked' })
  }

  return new Promise(resolve => {
    let settled = false
    const done = r => {
      if (settled) return
      settled = true
      resolve(r)
    }

    plugin.textToSpeech({
      lang: 'zh_CN',
      tts: true,
      content,
      success: res => {
        if (!res || !res.filename) {
          done({ ok: false, reason: 'no-file' })
          return
        }
        playFile(res.filename, content).then(ok => {
          done(ok ? { ok: true } : { ok: false, reason: 'play-failed' })
        })
      },
      fail: () => done({ ok: false, reason: 'tts-failed' }),
    })
  })
}

/** 停止当前播报（例如页面卸载、或用户手动关掉） */
function stop() {
  if (!audioCtx) return
  try {
    audioCtx.stop()
  } catch (e) {
    // ignore
  }
}

/** 重置探测缓存（仅测试用） */
function _reset() {
  pluginCache = undefined
  pluginProbed = false
  unlocked = false
  warned = false
  testOverride = false
  if (audioCtx) {
    try { audioCtx.destroy() } catch (e) { /* ignore */ }
    audioCtx = null
    playCount = 0
  }
}

/**
 * 当前是否处于「插件已关闭」状态。
 * 页面据此给出更准确的引导文案（区别于「插件不可用的异常」）。
 */
function isDisabled() {
  return !isPluginEnabled()
}

module.exports = {
  isSupported,
  isUnlocked,
  isDisabled,
  unlock,
  speak,
  stop,
  _reset,
  // 供测试注入假插件，覆盖正常播报链路
  _enableForTest(impl) {
    testOverride = true
    pluginCache = impl && typeof impl.textToSpeech === 'function' ? impl : null
    pluginProbed = true
  },
}
