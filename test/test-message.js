/**
 * 第七轮测试：班级消息同步 + 语音播报降级
 * 运行：node test/test-message.js
 */
const assert = require('assert')

// ---------- mock wx ----------
// 用 bad 标记的音频 src 模拟「音频损坏/播放失败」
// 注意：InnerAudioContext 的事件注册方法是 onPlay/onStop/onEnded/onError 四个独立方法，
// 不是通用 on()，mock 必须如实还原，否则测不到真实链路。
global.wx = {
  showToast() {},
  showModal() {},
  showLoading() {},
  hideLoading() {},
  setInnerAudioOption() {},
  createInnerAudioContext() {
    const h = {}
    const fire = (key, arg) => { if (h[key]) h[key](arg) }
    return {
      src: '',
      obeyMuteSwitch: true,
      onPlay: fn => { h.onPlay = fn },
      onStop: fn => { h.onStop = fn },
      onEnded: fn => { h.onEnded = fn },
      onError: fn => { h.onError = fn },
      offPlay: () => { delete h.onPlay },
      offStop: () => { delete h.onStop },
      offEnded: () => { delete h.onEnded },
      offError: () => { delete h.onError },
      play() {
        setTimeout(() => fire('onPlay'), 0)
        setTimeout(() => {
          if (String(this.src).indexOf('bad') !== -1) fire('onError', { errMsg: 'play fail' })
          else fire('onEnded')
        }, 1)
      },
      stop() { fire('onStop') },
      destroy() {},
    }
  },
}

// ---------- mock requirePlugin ----------
let pluginImpl = null
global.requirePlugin = name => {
  if (name !== 'WechatSI') throw new Error('未知插件 ' + name)
  if (!pluginImpl) throw new Error('plugin not found')
  return pluginImpl
}

const { sameMessages, formatMessageTime, createPoller, fetchClassMessages } = require('../utils/message-sync')
const tts = require('../utils/tts')

// ---------- 迷你异步测试框架 ----------
const queue = []
function test(group, name, fn) {
  queue.push({ group, name, fn })
}
const delay = ms => new Promise(r => setTimeout(r, ms))

// =======================================================================
// [A] sameMessages —— 决定要不要 setData，必须严格
// =======================================================================
test('[A] sameMessages', '两条相同内容判定为相同（不重复 setData）', () => {
  assert.strictEqual(
    sameMessages([{ id: 1, content: 'x', mode: 'voice' }], [{ id: 1, content: 'x', mode: 'voice' }]),
    true
  )
})

test('[A] sameMessages', 'id 不同判定为不同（有新消息）', () => {
  assert.strictEqual(
    sameMessages([{ id: 1, content: 'x' }], [{ id: 2, content: 'x' }]),
    false
  )
})

test('[A] sameMessages', '条数不同判定为不同', () => {
  assert.strictEqual(sameMessages([{ id: 1 }], [{ id: 1 }, { id: 2 }]), false)
})

test('[A] sameMessages', '内容变化判定为不同', () => {
  assert.strictEqual(sameMessages([{ id: 1, content: 'a' }], [{ id: 1, content: 'b' }]), false)
})

test('[A] sameMessages', '模式变化（文字↔语音）判定为不同', () => {
  assert.strictEqual(
    sameMessages([{ id: 1, content: 'a', mode: 'text' }], [{ id: 1, content: 'a', mode: 'voice' }]),
    false
  )
})

test('[A] sameMessages', '顺序不同（id 顺序变）判定为不同', () => {
  assert.strictEqual(sameMessages([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]), false)
})

test('[A] sameMessages', '空数组与 undefined 判定为不同', () => {
  assert.strictEqual(sameMessages([], undefined), false)
  assert.strictEqual(sameMessages(null, []), false)
})

test('[A] sameMessages', '两个空数组判定为相同', () => {
  assert.strictEqual(sameMessages([], []), true)
})

// =======================================================================
// [B] formatMessageTime
// =======================================================================
test('[B] formatMessageTime', '合法时间格式化为「月-日 时:分」', () => {
  assert.ok(/^\d{1,2}-\d{2} \d{2}:\d{2}$/.test(formatMessageTime('2026-10-12T08:30:00')))
})

test('[B] formatMessageTime', '个位数月/日/时/分补零', () => {
  assert.strictEqual(formatMessageTime('2026-01-02T03:04:00'), '1-02 03:04')
})

test('[B] formatMessageTime', '空值返回空串', () => {
  assert.strictEqual(formatMessageTime(''), '')
  assert.strictEqual(formatMessageTime(null), '')
  assert.strictEqual(formatMessageTime(undefined), '')
})

test('[B] formatMessageTime', '非法时间返回空串而不是 NaN', () => {
  assert.strictEqual(formatMessageTime('not-a-date'), '')
})

// =======================================================================
// [C] createPoller —— 请求不重叠 / 停止后不再执行 / 失败静默
// =======================================================================
test('[C] createPoller', 'start() 会立即执行一轮（immediate 默认 true）', async () => {
  let count = 0
  const p = createPoller({ interval: 50, task: async () => { count++ } })
  p.start()
  await delay(20)
  p.stop()
  assert.strictEqual(count, 1, '立即执行了 ' + count + ' 次')
})

test('[C] createPoller', '按 interval 周期重复执行', async () => {
  let count = 0
  const p = createPoller({ interval: 30, task: async () => { count++ } })
  p.start()
  await delay(110)
  p.stop()
  assert.ok(count >= 3, '110ms/30ms 期望至少 3 轮，实际 ' + count)
})

test('[C] createPoller', 'immediate=false 时 start 不立即执行', async () => {
  let count = 0
  const p = createPoller({ interval: 30, immediate: false, task: async () => { count++ } })
  p.start()
  assert.strictEqual(count, 0, '立即执行了 ' + count + ' 次')
  await delay(60)
  p.stop()
  assert.ok(count >= 1)
})

test('[C] createPoller', 'stop() 之后不再执行', async () => {
  let count = 0
  const p = createPoller({ interval: 20, task: async () => { count++ } })
  p.start()
  await delay(60)
  p.stop()
  const after = count
  await delay(80)
  assert.strictEqual(count, after, 'stop 后仍在执行：' + after + ' -> ' + count)
})

test('[C] createPoller', '重复 start 不会叠加定时器', async () => {
  let count = 0
  const p = createPoller({ interval: 30, task: async () => { count++ } })
  p.start()
  await delay(40)
  p.start()
  await delay(70)
  p.stop()
  assert.ok(count <= 6, '疑似叠加定时器，实际 ' + count)
})

test('[C] createPoller', '慢任务不重叠执行（弱网保护）', async () => {
  let running = 0
  let maxRunning = 0
  const p = createPoller({
    interval: 20,
    task: async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await delay(80)
      running--
    },
  })
  p.start()
  await delay(200)
  p.stop()
  assert.strictEqual(maxRunning, 1, '最大并发 ' + maxRunning + '，说明请求重叠了')
})

test('[C] createPoller', '任务抛错不影响后续轮询', async () => {
  let count = 0
  let errors = 0
  const p = createPoller({
    interval: 25,
    onError: () => { errors++ },
    task: async () => {
      count++
      if (count % 2 === 1) throw new Error('网络抖动')
    },
  })
  p.start()
  await delay(140)
  p.stop()
  assert.ok(count >= 3, '出错后停摆了，实际只跑了 ' + count + ' 轮')
  assert.strictEqual(errors, Math.ceil(count / 2))
})

test('[C] createPoller', '不传 onError 时静默吞掉异常', async () => {
  let count = 0
  const p = createPoller({ interval: 25, task: async () => { count++; throw new Error('boom') } })
  p.start()
  await delay(90)
  p.stop()
  assert.ok(count >= 2, '实际 ' + count)
})

test('[C] createPoller', 'isRunning 反映启动状态', () => {
  const p = createPoller({ interval: 50, task: async () => {} })
  assert.strictEqual(p.isRunning(), false)
  p.start()
  assert.strictEqual(p.isRunning(), true)
  p.stop()
  assert.strictEqual(p.isRunning(), false)
})

test('[C] createPoller', 'refresh() 立刻补一次而不改变计时', async () => {
  let count = 0
  const p = createPoller({ interval: 10000, immediate: false, task: async () => { count++ } })
  p.start()
  await delay(10)
  assert.strictEqual(count, 0)
  p.refresh()
  await delay(20)
  assert.strictEqual(count, 1)
  p.stop()
})

// =======================================================================
// [D] fetchClassMessages —— classId 为空时短路
// =======================================================================
test('[D] fetchClassMessages', 'classId 为空直接返回空数组，不打数据库', async () => {
  assert.deepStrictEqual(await fetchClassMessages(null), [])
  assert.deepStrictEqual(await fetchClassMessages(0), [])
  assert.deepStrictEqual(await fetchClassMessages(undefined), [])
})

// =======================================================================
// [E] tts 默认关闭状态 —— 当前线上配置下播报必须优雅降级
// =======================================================================
test('[E] tts 默认关闭', '默认配置为未启用插件（保证能上传成功）', () => {
  tts._reset()
  assert.strictEqual(tts.isDisabled(), true, 'PLUGIN_ENABLED 应为 false，否则上传会报 80082')
  assert.strictEqual(tts.isSupported(), false)
})

test('[E] tts 默认关闭', '未启用时完全不调用 requirePlugin', () => {
  tts._reset()
  let called = false
  const bak = global.requirePlugin
  global.requirePlugin = () => { called = true; throw new Error('plugin not found') }
  tts.isSupported()
  global.requirePlugin = bak
  assert.strictEqual(called, false, '未启用时不该探测插件')
})

test('[E] tts 默认关闭', 'speak 降级为 no-plugin 而不是抛错', async () => {
  tts._reset()
  pluginImpl = null
  const res = await tts.speak('测试文本')
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'no-plugin')
})

test('[E] tts 默认关闭', '空文本直接返回 empty，不触发插件', async () => {
  tts._reset()
  let called = false
  pluginImpl = { textToSpeech: () => { called = true } }
  const res = await tts.speak('   ')
  assert.strictEqual(res.reason, 'empty')
  assert.strictEqual(called, false, '空文本不该调插件')
})

test('[E] tts 默认关闭', 'unlock() 仍可安全调用（供页面无脑解锁）', () => {
  tts._reset()
  assert.strictEqual(tts.isUnlocked(), false)
  tts.unlock()
  assert.strictEqual(tts.isUnlocked(), true)
})

test('[E] tts 默认关闭', '探测与 stop 都不外泄异常', () => {
  tts._reset()
  pluginImpl = null
  assert.doesNotThrow(() => tts.isSupported())
  assert.doesNotThrow(() => tts.stop())
})

test('[E] tts 默认关闭', 'silent=true 时不弹 toast', async () => {
  tts._reset()
  let toastCount = 0
  const bak = wx.showToast
  wx.showToast = () => { toastCount++ }
  await tts.speak('测试', { silent: true })
  wx.showToast = bak
  assert.strictEqual(toastCount, 0)
})

test('[E] tts 默认关闭', '未静音时插件缺失只提示一次（不刷屏）', async () => {
  tts._reset()
  let toastCount = 0
  const bak = wx.showToast
  wx.showToast = () => { toastCount++ }
  await tts.speak('一')
  await tts.speak('二')
  await tts.speak('三')
  wx.showToast = bak
  assert.strictEqual(toastCount, 1, '弹了 ' + toastCount + ' 次，应只弹 1 次')
})

// =======================================================================
// [F] tts 已启用时的正常链路（用 _enableForTest 注入假插件）
//     —— 保证将来把 PLUGIN_ENABLED 打开后功能确实是通的
// =======================================================================
test('[F] tts 正常链路', '启用后 isDisabled 变 false、isSupported 变 true', () => {
  tts._reset()
  tts._enableForTest({ textToSpeech: () => {} })
  assert.strictEqual(tts.isDisabled(), false)
  assert.strictEqual(tts.isSupported(), true)
})

test('[F] tts 正常链路', '启用 + 已解锁 → 播报成功且参数正确', async () => {
  tts._reset()
  let ttsArgs = null
  tts._enableForTest({
    textToSpeech(args) {
      ttsArgs = args
      args.success({ filename: 'wxfile://tmp/tts.mp3' })
    },
  })
  tts.unlock()
  const res = await tts.speak('请同学们按时到校', { silent: true })
  assert.strictEqual(res.ok, true, '实际 ' + JSON.stringify(res))
  assert.strictEqual(ttsArgs.lang, 'zh_CN')
  assert.strictEqual(ttsArgs.tts, true)
  assert.strictEqual(ttsArgs.content, '请同学们按时到校')
})

test('[F] tts 正常链路', '启用但未解锁时返回 locked（微信要求手势解锁）', async () => {
  tts._reset()
  let called = false
  tts._enableForTest({ textToSpeech: () => { called = true } })
  const res = await tts.speak('测试')
  assert.strictEqual(res.reason, 'locked')
  assert.strictEqual(called, false, '未解锁不该调插件')
})

test('[F] tts 正常链路', 'force=true 可绕过解锁检查', async () => {
  tts._reset()
  let called = false
  tts._enableForTest({
    textToSpeech(args) { called = true; args.success({ filename: 'wxfile://tmp/a.mp3' }) },
  })
  const res = await tts.speak('强制播报', { force: true, silent: true })
  assert.strictEqual(called, true)
  assert.strictEqual(res.ok, true)
})

test('[F] tts 正常链路', '插件 success 未给 filename → no-file', async () => {
  tts._reset()
  tts._enableForTest({ textToSpeech: args => args.success({}) })
  tts.unlock()
  const res = await tts.speak('测试', { silent: true })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'no-file')
})

test('[F] tts 正常链路', '插件 fail → tts-failed', async () => {
  tts._reset()
  tts._enableForTest({ textToSpeech: args => args.fail({ errMsg: 'fail' }) })
  tts.unlock()
  const res = await tts.speak('测试', { silent: true })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'tts-failed')
})

test('[F] tts 正常链路', '音频播放出错 → play-failed', async () => {
  tts._reset()
  tts._enableForTest({ textToSpeech: args => args.success({ filename: 'wxfile://tmp/bad.mp3' }) })
  tts.unlock()
  const res = await tts.speak('测试', { silent: true })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'play-failed')
})

test('[F] tts 正常链路', '_reset 后回到未启用状态（用例之间不串味）', () => {
  tts._reset()
  assert.strictEqual(tts.isDisabled(), true)
  assert.strictEqual(tts.isSupported(), false)
})

// ---------- 执行 ----------
;(async () => {
  const failures = []
  let passed = 0
  for (const t of queue) {
    try {
      await t.fn()
      passed++
    } catch (e) {
      failures.push(t)
      console.log('  ✗ [' + t.group + '] ' + t.name + '\n    ' + e.message)
    }
  }
  console.log('')
  if (failures.length) {
    console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
    process.exit(1)
  }
  console.log('全部通过：' + passed + ' 项断言')
})()
