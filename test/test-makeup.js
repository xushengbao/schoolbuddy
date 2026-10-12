/**
 * 第九轮测试：调休设置 + 换课冲突拦截
 *
 * [A] 调休：resolveDay 解析 / 只能调周末 / 同日覆盖
 * [B] 调休：getScheduleForDay 与 getTeacherDaySchedule 走调休
 * [C] 换课冲突：对方那节课有课 → 拦截（用户需求 1）
 * [D] 换课冲突：候选生成标记 blocked
 * [E] 服务端 createSwapRequest 拦截
 * [F] 回归：调休不影响普通工作日
 */
const Module = require('module')
const path = require('path')

/* ================= mock db ================= */
const DB = {
  swap_requests: [],
  notices: [],
  schedules: [],
  teachers: [],
  classes: [],
  makeup_days: [],
  student_status: [],
  memos: [],
}
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
  remove: async (t, f) => {
    CALLS++
    const hit = (DB[t] || []).filter(r => matches(r, f))
    DB[t] = (DB[t] || []).filter(r => !matches(r, f))
    return hit
  },
  upsertSetting: async () => {},
  getSetting: async () => null,
  getJsonSetting: async () => null,
  cloud: {},
  db: () => ({}),
  unwrap: r => (r ? r.data : null),
}

let SESSION = null
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' }, appId: 'x' }),
  getSystemInfoSync: () => ({ SDKVersion: '3', platform: 'devtools', system: 's', model: 'm' }),
  onError: () => {},
  onUnhandledRejection: () => {},
  // getSession() 读的是 wx.getStorageSync('sb_session') 返回的对象本身，不是 JSON 字符串
  getStorageSync: k => (k === 'sb_session' ? SESSION : ''),
  setStorageSync: (k, v) => {
    if (k === 'sb_session') SESSION = v
  },
  removeStorageSync: () => {
    SESSION = null
  },
  showToast: () => {},
  showModal: () => {},
  showLoading: () => {},
  hideLoading: () => {},
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

async function throws(fn) {
  try {
    await fn()
    return ''
  } catch (e) {
    return e.message || String(e)
  }
}

/* ================= 测试数据 ================= */
// 2026-10-12 是周一，10-17 周六，10-18 周日
DB.classes = [
  { id: 1, name: '三年1班', school_id: 1, head_teacher_id: 9 },
  { id: 2, name: '三年2班', school_id: 1, head_teacher_id: 9 },
]
DB.teachers = [
  { id: 1, name: '周老师', school_id: 1, subject_group: '语文' },
  { id: 2, name: '何老师', school_id: 1, subject_group: '数学' },
  { id: 3, name: '王老师', school_id: 1, subject_group: '英语' },
  { id: 9, name: '班主任', school_id: 1, subject_group: '综合' },
]
// 周一：1班 语文(周) 第1节、数学(何) 第3节；2班 英语(王) 第1节
// 周三：2班 数学(何) 第2节
DB.schedules = [
  { id: 11, class_id: 1, weekday: 1, period_no: 1, subject: '语文', teacher_id: 1 },
  { id: 12, class_id: 1, weekday: 1, period_no: 3, subject: '数学', teacher_id: 2 },
  { id: 13, class_id: 2, weekday: 1, period_no: 1, subject: '英语', teacher_id: 3 },
  { id: 21, class_id: 2, weekday: 3, period_no: 2, subject: '数学', teacher_id: 2 },
]
SESSION = { role: 'admin', teacherId: 1, schoolId: 1, name: '周老师', isAdmin: true }

const days = () => [
  { date: '2026-10-12', weekday: 1, label: '周一', sub: '10月12日 周一' },
  { date: '2026-10-13', weekday: 2, label: '周二', sub: '10月13日 周二' },
  { date: '2026-10-14', weekday: 3, label: '周三', sub: '10月14日 周三' },
  { date: '2026-10-17', weekday: 6, label: '周六', sub: '10月17日 周六' },
  { date: '2026-10-18', weekday: 7, label: '周日', sub: '10月18日 周日' },
]

async function run() {
  console.log('[A] 调休：解析与保存')

  school.invalidateMakeupCache()
  DB.makeup_days = []

  let info = await school.resolveDay('2026-10-12')
  check('周一按周一课表', info.weekday === 1 && info.isMakeup === false, JSON.stringify(info))
  info = await school.resolveDay('2026-10-17')
  check('周六未调休时 weekday=6', info.weekday === 6 && info.isMakeup === false)

  const row = await school.saveMakeupDay({ makeupDate: '2026-10-17', weekday: 1, note: '国庆补课' })
  check('保存调休记录', !!row && Number(row.weekday) === 1, JSON.stringify(row))

  info = await school.resolveDay('2026-10-17')
  check(
    '周六解析为周一课表',
    info.weekday === 1 && info.isMakeup === true && info.realWeekday === 6,
    JSON.stringify(info)
  )
  check('调休备注透传', info.note === '国庆补课', info.note)

  let msg = await throws(() => school.saveMakeupDay({ makeupDate: '2026-10-14', weekday: 1 }))
  check('周一不能调休（只对周末生效）', msg.indexOf('周六或周日') >= 0, msg)

  msg = await throws(() => school.saveMakeupDay({ makeupDate: '2026-10-17', weekday: 6 }))
  check('不能把周末指向周末', msg.indexOf('周几') >= 0, msg)

  msg = await throws(() => school.saveMakeupDay({ makeupDate: 'bad-date', weekday: 1 }))
  check('日期格式非法时报错', msg.indexOf('日期') >= 0, msg)

  // 同一天再设置 → 覆盖而不是新增
  await school.saveMakeupDay({ makeupDate: '2026-10-17', weekday: 3, note: '改周三' })
  info = await school.resolveDay('2026-10-17')
  check(
    '同一天重复设置=覆盖',
    info.weekday === 3 && DB.makeup_days.length === 1,
    'weekday=' + info.weekday + '条数=' + DB.makeup_days.length
  )

  console.log('\n[B] 调休：课表读取走调休')

  await school.saveMakeupDay({ makeupDate: '2026-10-17', weekday: 1 })
  let lessons = await school.getScheduleForDay(1, '2026-10-17')
  check('周六按周一的课：1班有2节', lessons.length === 2, '实得' + lessons.length)
  check('周六课表标记 isMakeup', lessons[0].isMakeup === true && lessons[0].makeupFrom === 6)

  let mine = await school.getTeacherDaySchedule(1, '2026-10-17')
  check('周老师周六有课（周一第1节语文）', mine.length === 1 && mine[0].subject === '语文', JSON.stringify(mine))
  check('教师课表也带 isMakeup', mine[0].isMakeup === true && mine[0].weekday === 1)

  mine = await school.getTeacherDaySchedule(2, '2026-10-17')
  check('何老师周六按周一有数学', mine.length === 1 && mine[0].subject === '数学', JSON.stringify(mine))

  await school.removeMakeupDay(DB.makeup_days[0].id)
  lessons = await school.getScheduleForDay(1, '2026-10-17')
  check('取消调休后周六为空课', lessons.length === 0, '实得' + lessons.length)

  console.log('\n[C] 换课冲突：对方那节课有课 → 拦截')

  const teacherMap = { 1: '周老师', 2: '何老师', 3: '王老师', 9: '班主任' }
  const classMap = { 1: '三年1班', 2: '三年2班' }

  // 周一第1节 周老师(1班语文)；王老师 周一第1节 也有课(2班英语) → 不能找王老师换
  let res = school.checkSwapConflict({
    requesterId: 1,
    targetId: 3,
    targetName: '王老师',
    first: { weekday: 1, period: 1 },
    second: { weekday: 3, period: 2 },
    schedules: DB.schedules,
    swaps: [],
    teacherMap,
    classMap,
  })
  check('对方在第一节课上已有课 → 拦截', res.ok === false, JSON.stringify(res))
  check('拦截原因为 target_busy', res.code === 'target_busy', res.code)
  check('提示含老师名与班级', (res.reason || '').indexOf('王老师') >= 0 && (res.reason || '').indexOf('三年2班') >= 0, res.reason)

  // 何老师 周一第1节 没课 → 允许
  res = school.checkSwapConflict({
    requesterId: 1,
    targetId: 2,
    targetName: '何老师',
    first: { weekday: 1, period: 1 },
    second: { weekday: 3, period: 2 },
    schedules: DB.schedules,
    swaps: [],
    teacherMap,
    classMap,
  })
  check('对方第一节课无课 → 放行', res.ok === true, JSON.stringify(res))

  // 发起方自己在第二节课上有课 → 也拦。
  // 临时给周老师加一节周三第2节的音乐（他本来就有），构造 requester_busy。
  DB.schedules.push({ id: 31, class_id: 1, weekday: 3, period_no: 2, subject: '音乐', teacher_id: 1 })
  res = school.checkSwapConflict({
    requesterId: 1,
    targetId: 2,
    targetName: '何老师',
    first: { weekday: 1, period: 1 },
    second: { weekday: 3, period: 2 },
    schedules: DB.schedules,
    swaps: [],
    teacherMap,
    classMap,
  })
  check('发起方在第二节课上有课 → 拦截', res.ok === false && res.code === 'requester_busy', JSON.stringify(res))
  // 复原，后面 [E] 的合法提交还依赖干净的课表
  DB.schedules = DB.schedules.filter(s => s.id !== 31)

  // 跨班同节次也算有课（老师同一节不能上两个班）
  res = school.checkSwapConflict({
    requesterId: 1,
    targetId: 2,
    targetName: '何老师',
    first: { weekday: 1, period: 1 },
    second: { weekday: 1, period: 1 },
    schedules: DB.schedules,
    swaps: [],
    teacherMap,
    classMap,
  })
  check('同节次互换也算冲突（双方都有课）', res.ok === false, JSON.stringify(res))

  // teacherBusyAtSlot 本身
  let busy = school.teacherBusyAtSlot(3, 1, 1, DB.schedules, school.buildSwapOverlay(DB.schedules, [], teacherMap))
  check('teacherBusyAtSlot 命中王老师周一1', !!busy && busy.classId === 2 && busy.subject === '英语', JSON.stringify(busy))
  busy = school.teacherBusyAtSlot(2, 1, 1, DB.schedules, school.buildSwapOverlay(DB.schedules, [], teacherMap))
  check('teacherBusyAtSlot 何老师周一1为空', busy === null, JSON.stringify(busy))

  console.log('\n[D] 换课冲突：候选生成标记 blocked')

  let list = school.buildSwapCandidates({
    requesterId: 1,
    days: days(),
    teachers: DB.teachers,
    schedules: DB.schedules,
    swaps: [],
    teacherMap,
    classMap,
    first: { weekday: 1, period: 1 },
  })
  let wang = list.find(t => t.id === 3)
  let he = list.find(t => t.id === 2)
  check('王老师被标记 blocked', !!wang && !!wang.blocked, JSON.stringify(wang))
  check('blocked 文案说明原因', wang && wang.blocked.indexOf('周一第1节') >= 0, wang && wang.blocked)
  check('何老师未被标记', !!he && !he.blocked, JSON.stringify(he && he.blocked))

  console.log('\n[E] 服务端 createSwapRequest 拦截')

  DB.swap_requests = []
  msg = await throws(() =>
    school.createSwapRequest({
      requester_id: 1,
      requester_name: '周老师',
      target_id: 3,
      target_name: '王老师',
      class_id: 1,
      weekday: 1,
      period_no: 1,
      subject: '语文',
      lesson_date: '2026-10-12',
      swap_weekday: 3,
      swap_period_no: 2,
      swap_subject: '数学',
      swap_teacher_id: 2,
      swap_class_id: 2,
      swap_date: '2026-10-14',
      school_id: 1,
    })
  )
  check('服务端拒绝：对方那节课有课', msg.indexOf('已有') >= 0, msg || '没有报错')
  check('被拦截时不落库', DB.swap_requests.length === 0)

  // 合法的一单应当成功
  const created = await school.createSwapRequest({
    requester_id: 1,
    requester_name: '周老师',
    target_id: 2,
    target_name: '何老师',
    class_id: 1,
    weekday: 1,
    period_no: 1,
    subject: '语文',
    lesson_date: '2026-10-12',
    swap_weekday: 3,
    swap_period_no: 2,
    swap_subject: '数学',
    swap_teacher_id: 2,
    swap_class_id: 2,
    swap_date: '2026-10-14',
    school_id: 1,
  })
  check('合法换课仍可提交', !!created && DB.swap_requests.length === 1)

  console.log('\n[F] 回归：调休不影响普通工作日 / 缓存')

  DB.makeup_days = []
  school.invalidateMakeupCache()
  const before = CALLS
  await school.resolveDay('2026-10-12')
  const c1 = CALLS - before
  await school.resolveDay('2026-10-13')
  const c2 = CALLS - before - c1
  check('第二次读取命中缓存（0 次查询）', c2 === 0, '实际' + c2 + ' 次')

  info = await school.resolveDay('2026-10-12')
  check('无调休时工作日不受影响', info.weekday === 1 && info.isMakeup === false)

  // 改库后 force 生效
  DB.makeup_days.push({ id: 99, school_id: 1, makeup_date: '2026-10-12', weekday: 4, note: '' })
  info = await school.resolveDay('2026-10-12')
  check('缓存期内不立即回源（60秒 TTL）', info.weekday === 1, '实得' + info.weekday)
  const forced = await school.listMakeupDays({ force: true })
  check('force 可强制回源', forced.length === 1, '实得' + forced.length)
  info = await school.resolveDay('2026-10-12')
  check('force 之后缓存已刷新', info.weekday === 4, '实得' + info.weekday)

  console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————')
  process.exit(fail ? 1 : 0)
}

run().catch(e => {
  console.error('测试异常：', e && e.stack ? e.stack : e)
  process.exit(1)
})