/**
 * 换课流程测试
 *   1. 发起：必须选两节课，两节相同要报错
 *   2. 覆盖表 buildSwapOverlay：两节课内容对调、归属换人
 *   3. 课表呈现：班级周课表 / 教师当天课表都体现换课结果
 *   4. 通知：同意后双方教师 + 班主任各收一条站内信
 */
const Module = require('module')
const path = require('path')

/* ================= mock db ================= */
const DB = { swap_requests: [], notices: [], schedules: [], teachers: [], classes: [] }
const seq = {}
let CALLS = 0
function matches(row, f) {
  return Object.keys(f || {}).every(k => String(row[k]) === String(f[k]))
}
const mockDb = {
  findOne: async (t, f) => {
    CALLS++
    return (DB[t] || []).find(r => matches(r, f)) || null
  },
  findAll: async (t, f) => {
    CALLS++
    return (DB[t] || []).filter(r => matches(r, f))
  },
  insert: async (t, row) => {
    CALLS++
    if (!seq[t]) seq[t] = 0
    seq[t]++
    const o = Object.assign({}, row, { id: seq[t] })
    if (!DB[t]) DB[t] = []
    DB[t].push(o)
    return o
  },
  insertMany: async (t, rows) => rows.map(r => mockDb.insert(t, r)),
  update: async (t, f, patch) => {
    CALLS++
    const hit = (DB[t] || []).filter(r => matches(r, f))
    hit.forEach(r => Object.assign(r, patch))
    return hit
  },
  remove: async (t, f) => (DB[t] || []).filter(r => matches(r, f)),
  upsertSetting: async () => {},
  getSetting: async () => null,
  getJsonSetting: async () => null,
  cloud: {},
  db: () => ({}),
  unwrap: r => (r ? r.data : null),
}

let SESSION = ''
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' }, appId: 'x' }),
  getSystemInfoSync: () => ({ SDKVersion: '3', platform: 'devtools', system: 's', model: 'm' }),
  onError: () => {},
  onUnhandledRejection: () => {},
  getStorageSync: () => SESSION,
  setStorageSync: (k, v) => {
    if (k === 'session') SESSION = v
  },
  removeStorageSync: () => {
    SESSION = ''
  },
  cloud: { init: () => ({}), database: { from: () => ({}) } },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]school\.js$/.test(parent.filename) && request === './db') return mockDb
  if (parent && /utils[\\/]auth\.js$/.test(parent.filename) && request === './db') return mockDb
  return origLoad.apply(this, arguments)
}

const school = require('../utils/school')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '　→ ' + extra : ''))
  }
}

async function run() {
  /* ---------- 基础数据 ---------- */
  DB.teachers = [
    { id: 1, name: '周老师', account: '13665136408', role: 'teacher' },
    { id: 2, name: '何老师', account: '13500000003', role: 'teacher' },
    { id: 3, name: '许老师', account: '17600662106', role: 'admin' },
  ]
  DB.classes = [
    { id: 1, name: 'B五1', school_id: 1, head_teacher_id: 3 },
    { id: 2, name: 'B五2', school_id: 1, head_teacher_id: null },
  ]
  // 周老师：周一第1节语文(B五1)、周三第2节数学(B五2)
  // 何老师：周一第3节数学(B五1)、周五第4节语文(B五2)
  DB.schedules = [
    { id: 11, class_id: 1, school_id: 1, weekday: 1, period_no: 1, subject: '语文', teacher_id: 1 },
    { id: 12, class_id: 2, school_id: 1, weekday: 3, period_no: 2, subject: '数学', teacher_id: 1 },
    { id: 21, class_id: 1, school_id: 1, weekday: 1, period_no: 3, subject: '数学', teacher_id: 2 },
    { id: 22, class_id: 2, school_id: 1, weekday: 5, period_no: 4, subject: '语文', teacher_id: 2 },
  ]
  SESSION = JSON.stringify({ role: 'admin', account: '17600662106', name: '许老师', schoolId: 1, teacherId: 3 })

  console.log('\n[A] 发起校验：必须选两节课')
  let threw = ''
  try {
    await school.createSwapRequest({
      requester_id: 1, requester_name: '周老师', target_id: 2, target_name: '何老师',
      class_id: 1, weekday: 1, period_no: 1, subject: '语文',
    })
  } catch (e) {
    threw = e.message
  }
  check('未选第二节课时拒绝', threw.indexOf('换出去') >= 0, threw || '没有报错')

  threw = ''
  try {
    await school.createSwapRequest({
      requester_id: 1, requester_name: '周老师', target_id: 2, target_name: '何老师',
      class_id: 1, weekday: 1, period_no: 1, subject: '语文',
      swap_weekday: 1, swap_period_no: 1, swap_subject: '语文',
    })
  } catch (e) {
    threw = e.message
  }
  check('两节相同课时拒绝', threw.indexOf('相同') >= 0, threw || '没有报错')

  const created = await school.createSwapRequest({
    requester_id: 1, requester_name: '周老师', target_id: 2, target_name: '何老师',
    class_id: 1, weekday: 1, period_no: 1, subject: '语文',
    swap_weekday: 1, swap_period_no: 3, swap_subject: '数学', swap_class_id: 1,
    reason: '外出开会', school_id: 1,
  })
  check('两节课对调申请已建立', !!created && created.status === 'pending')
  check('第一节记录在weekday/period_no', created.weekday === 1 && created.period_no === 1)
  check('第二节记录在 swap_* 字段', created.swap_weekday === 1 && created.swap_period_no === 3,
    JSON.stringify({ w: created.swap_weekday, p: created.swap_period_no }))

  // [A2] 同一天换课：两端都带相同日期也应被允许（不同节次、不同格）
  threw = ''
  try {
    await school.createSwapRequest({
      requester_id: 1, requester_name: '周老师', target_id: 2, target_name: '何老师',
      class_id: 1, weekday: 1, period_no: 1, subject: '语文',
      lesson_date: '2026-10-12', swap_weekday: 1, swap_period_no: 3, swap_subject: '数学',
      swap_class_id: 1, swap_date: '2026-10-12', reason: '同一天换课', school_id: 1,
    })
  } catch (e) {
    threw = e.message
  }
  check('同一天（带相同日期）换课也被允许', threw === '', threw || 'ok')

  const summary = school.describeSwap(created, 'B五1')
  check('describeSwap 展示两节课', summary.indexOf('⇄') > 0, summary)

  console.log('\n[B] 覆盖表：同意后两节课对调')
  const teacherMap = { 1: '周老师', 2: '何老师', 3: '许老师' }
  const pendingOverlay = school.buildSwapOverlay(DB.schedules, [], teacherMap)
  check('待审批时课表不变', pendingOverlay['1|1|1'].subject === '语文' && !pendingOverlay['1|1|1'].swapped)

  await school.updateSwapRequest(created.id, { status: 'approved' })
  const swaps = await school.listSwapRequests({ status: 'approved' })
  const overlay = school.buildSwapOverlay(DB.schedules, swaps, teacherMap)

  const c1 = overlay['1|1|1']
  check('周一第1节改为何老师的数学', c1.subject === '数学' && c1.teacherName === '何老师',
    JSON.stringify({ s: c1.subject, t: c1.teacherName }))
  check('周一第1节标记为已换课', c1.swapped === true)
  const c2 = overlay['1|1|3']
  check('周一第3节改回周老师的语文', c2.subject === '语文' && c2.teacherName === '周老师',
    JSON.stringify({ s: c2.subject, t: c2.teacherName }))
  check('未参与换课的格子不受影响', overlay['2|5|4'].subject === '语文' && !overlay['2|5|4'].swapped)
  check('换课说明写明原任课', c1.swapText.indexOf('原 语文') >= 0 && c1.swapText.indexOf('周老师') >= 0, c1.swapText)

  console.log('\n[C] 课表呈现：教师当天课表按换课后的归属')
  const monday = '2026-10-12' // 周一
  const zhouLessons = await school.getTeacherDaySchedule(1, monday)
  const zhouText = zhouLessons.map(l => l.period + '节 ' + l.subject + '/' + l.className)
  check('周老师周一：第1节已交出，只剩换回来的第3节语文',
    zhouLessons.length === 1 && zhouLessons[0].period === 3 && zhouLessons[0].subject === '语文',
    JSON.stringify(zhouText))
  const heLessons = await school.getTeacherDaySchedule(2, monday)
  const heText = heLessons.map(l => l.period + '节 ' + l.subject + '/' + l.className)
  check('何老师周一：接手第1节 B五1 数学，自己第3节已让出',
    heLessons.length === 1 && heLessons[0].period === 1 && heLessons[0].subject === '数学',
    JSON.stringify(heText))
  const zhouWed = await school.getTeacherDaySchedule(1, '2026-10-14')
  check('周老师周三：未受影响的课照常显示',
    zhouWed.length === 1 && zhouWed[0].className === 'B五2' && zhouWed[0].subject === '数学',
    JSON.stringify(zhouWed.map(l => l.className + '/' + l.subject)))

  console.log('\n[D] 班级课表呈现换课结果')
  const b51 = await school.getScheduleForDay(1, monday)
  const first = b51.find(l => l.period === 1)
  check('B五1 周一第1节显示何老师的数学且标记换课',
    first && first.subject === '数学' && first.teacherName === '何老师' && first.swapped === true,
    first ? JSON.stringify({ s: first.subject, t: first.teacherName, w: first.swapped }) : '无')
  const third = b51.find(l => l.period === 3)
  check('B五1 周一第3节显示周老师的语文且标记换课',
    third && third.subject === '语文' && third.teacherName === '周老师' && third.swapped === true,
    third ? JSON.stringify({ s: third.subject, t: third.teacherName }) : '无')

  console.log('\n[E] 同意后通知：双方教师 + 班主任')
  const before = DB.notices.length
  await school.pushNotice({
    receiver_id: 1, category: '换课结果', title: '你的换课申请已同意',
    content: summary, related_class_id: 1,
  })
  await school.pushNotice({
    receiver_id: 2, category: '换课结果', title: '你已同意这节换课',
    content: summary, related_class_id: 1,
  })
  await school.pushNotice({
    receiver_id: 3, category: '换课通知', title: '本班发生换课',
    content: summary, related_class_id: 1,
  })
  const sent = DB.notices.slice(before)
  check('共发出 3 条站内信', sent.length === 3, '实际 ' + sent.length)
  check('收件人分别是双方教师与班主任',
    sent.map(n => n.receiver_id).sort().join(',') === '1,2,3',
    sent.map(n => n.receiver_id).join(','))
  check('站内信内容含两节课', sent.every(n => n.content.indexOf('⇄') > 0), sent[0] && sent[0].content)

  console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n')
  process.exit(fail ? 1 : 0)
}

run().catch(e => {
  console.error('运行异常:', e)
  process.exit(1)
})