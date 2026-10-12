/**
 * 第十轮测试：换课通知矩阵 + 双方撤销
 *
 * [A] notifySwap 收件人矩阵（核心需求）
 * [B] 撤销已同意的换课 → 课表恢复原样
 * [C] 撤销权限判定
 * [D] 通知文案
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
function matches(row, f) {
  return Object.keys(f || {}).every(k => String(row[k]) === String(f[k]))
}
const mockDb = {
  findOne: async (t, f) => (DB[t] || []).find(r => matches(r, f)) || null,
  findAll: async (t, f) => (DB[t] || []).filter(r => matches(r, f)),
  insert: async (t, row) => {
    if (!seq[t]) seq[t] = 0
    seq[t]++
    const o = Object.assign({}, row, { id: seq[t] })
    if (!DB[t]) DB[t] = []
    DB[t].push(o)
    return o
  },
  insertMany: async (t, rows) => rows.map(r => mockDb.insert(t, r)),
  update: async (t, f, patch) => {
    const hit = (DB[t] || []).filter(r => matches(r, f))
    hit.forEach(r => Object.assign(r, patch))
    return hit
  },
  remove: async (t, f) => {
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
Module._load = function (request, parent) {
  if (parent && /utils[\\/]school\.js$/.test(parent.filename) && request === './db') return mockDb
  if (parent && /utils[\\/]auth\.js$/.test(parent.filename) && request === './db') return mockDb
  return origLoad.apply(this, arguments)
}

const school = require('../utils/school')
const auth = require('../utils/auth')

/**
 * 切换登录身份。
 * 注意：auth.js 里有模块级 `current` 缓存，直接改 SESSION 变量没用
 * （getSession 会一直返回第一次缓存的对象），必须走 setSession。
 */
function login(teacherId, name) {
  auth.setSession({ role: 'teacher', teacherId, schoolId: 1, name })
}

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

/* ================= 数据 ================= */
// 1班班主任=9，2班班主任=8；8/9 都不是换课双方
DB.classes = [
  { id: 1, name: '三年1班', school_id: 1, head_teacher_id: 9 },
  { id: 2, name: '三年2班', school_id: 1, head_teacher_id: 8 },
]
DB.teachers = [
  { id: 1, name: '周老师', school_id: 1, subject_group: '语文' },
  { id: 2, name: '何老师', school_id: 1, subject_group: '数学' },
  { id: 8, name: '二班班主任', school_id: 1 },
  { id: 9, name: '一班班主任', school_id: 1 },
]
DB.schedules = [
  { id: 11, class_id: 1, weekday: 1, period_no: 1, subject: '语文', teacher_id: 1 },
  { id: 12, class_id: 2, weekday: 3, period_no: 2, subject: '数学', teacher_id: 2 },
]

function makeSwap(over) {
  return Object.assign(
    {
      id: 100,
      status: 'pending',
      requester_id: 1,
      requester_name: '周老师',
      target_id: 2,
      target_name: '何老师',
      class_id: 1,
      weekday: 1,
      period_no: 1,
      subject: '语文',
      lesson_date: '2026-10-12',
      swap_class_id: 2,
      swap_weekday: 3,
      swap_period_no: 2,
      swap_subject: '数学',
      swap_date: '2026-10-14',
      reason: '教研',
      school_id: 1,
    },
    over || {}
  )
}

function resetNotices() {
  DB.notices = []
}
function receivers() {
  return DB.notices.map(n => Number(n.receiver_id)).sort((a, b) => a - b)
}
function noticeTo(id) {
  return DB.notices.filter(n => Number(n.receiver_id) === Number(id))
}

async function run() {
  console.log('[A] notifySwap 收件人矩阵')

  const row = makeSwap()

  // 场景1：发起申请 → 双方都收到，班主任不收
  resetNotices()
  login(1, '周老师')
  let sent = await school.notifySwap(row, 'apply', { note: '教研' })
  check('apply 发出 2 条（双方）', sent === 2 && DB.notices.length === 2, 'sent=' + sent + ' 实际' + DB.notices.length)
  check('apply 双方都收到', receivers().join(',') === '1,2', receivers().join(','))
  check('apply 班主任未收到', noticeTo(8).length === 0 && noticeTo(9).length === 0)

  // 场景2：同意 → 双方 + 两班班主任
  resetNotices()
  login(2, '何老师')
  sent = await school.notifySwap(row, 'approve', { note: '可以' })
  check('approve 发出 4 条（双方+两班班主任）', sent === 4 && DB.notices.length === 4, 'sent=' + sent + ' 实际' + DB.notices.length)
  check('approve 双方都收到', noticeTo(1).length === 1 && noticeTo(2).length === 1)
  check('approve 1班班主任收到', noticeTo(9).length === 1)
  check('approve 2班班主任收到', noticeTo(8).length === 1)

  // 场景3：撤销未处理的申请 → 双方，班主任不收
  resetNotices()
  sent = await school.notifySwap(row, 'cancel', { wasApproved: false })
  check('撤销未生效：只发双方 2 条', sent === 2 && DB.notices.length === 2, 'sent=' + sent)
  check('撤销未生效：班主任未收到', noticeTo(8).length === 0 && noticeTo(9).length === 0)

  // 场景4：撤销已生效的换课 → 双方 + 班主任
  resetNotices()
  sent = await school.notifySwap(row, 'cancel', { wasApproved: true })
  check('撤销已生效：发出 4 条', sent === 4 && DB.notices.length === 4, 'sent=' + sent + ' 实际' + DB.notices.length)
  check('撤销已生效：双方都收到', noticeTo(1).length === 1 && noticeTo(2).length === 1)
  check('撤销已生效：两班班主任都收到', noticeTo(8).length === 1 && noticeTo(9).length === 1)

  // 场景5：1班班主任恰好是换课接收方 → 他不重复收「班主任那条」，
  //       但作为换课双方仍要收一条；2班班主任不是双方，照收 → 共 3 条
  resetNotices()
  const sameHead = makeSwap({ target_id: 9, target_name: '一班班主任', swap_teacher_id: 9 })
  sent = await school.notifySwap(sameHead, 'approve', {})
  check('班主任是换课双方时不重复收（2班班主任那条仍发）', sent === 3 && DB.notices.length === 3, 'sent=' + sent + ' 实际' + DB.notices.length)
  check('身为双方的班主任只收到 1 条', noticeTo(9).length === 1, '实得' + noticeTo(9).length)
  check('2班班主任正常收到 1 条', noticeTo(8).length === 1)

  // 场景6：拒绝 → 只通知发起方（操作人自己不收）
  resetNotices()
  login(2, '何老师')
  sent = await school.notifySwap(row, 'reject', { note: '有课' })
  check('reject 只发 1 条（发起方，操作人自己不发）', sent === 1 && DB.notices.length === 1, 'sent=' + sent + ' 实际' + DB.notices.length)
  check('reject 收件人是发起方', Number(DB.notices[0].receiver_id) === 1)

  // 场景7：单边班级（swap_class_id 缺失时回落到 class_id）
  resetNotices()
  const single = makeSwap({ swap_class_id: null })
  sent = await school.notifySwap(single, 'approve', {})
  check('单班级时班主任去重不重复', sent === 3, 'sent=' + sent + '（双方 + 1班班主任）')

  console.log('\n[B] 撤销已生效的换课 → 课表恢复')

  const teacherMap = { 1: '周老师', 2: '何老师', 8: '二班班主任', 9: '一班班主任' }
  const approved = [makeSwap({ status: 'approved' })]
  let overlay = school.buildSwapOverlay(DB.schedules, approved, teacherMap)
  check(
    '已同意：1班周一1归何老师',
    Number(overlay[school.scheduleCellKey(1, 1, 1)].teacherId) === 2,
    '实得' + overlay[school.scheduleCellKey(1, 1, 1)].teacherId
  )
  check(
    '已同意：2班周三2归周老师',
    Number(overlay[school.scheduleCellKey(2, 3, 2)].teacherId) === 1,
    '实得' + overlay[school.scheduleCellKey(2, 3, 2)].teacherId
  )

  // 撤销 = status 改成 cancelled，approved 集合里就没有它了
  await school.updateSwapRequest(100, { status: 'cancelled' })
  const after = DB.swap_requests.filter(r => r.status === 'approved')
  overlay = school.buildSwapOverlay(DB.schedules, after, teacherMap)
  check('撤销后不再是 approved 集合成员', after.length === 0)
  check(
    '撤销后 1班周一1恢复给周老师',
    Number(overlay[school.scheduleCellKey(1, 1, 1)].teacherId) === 1,
    '实得' + overlay[school.scheduleCellKey(1, 1, 1)].teacherId
  )
  check(
    '撤销后 2班周三2恢复为何老师',
    Number(overlay[school.scheduleCellKey(2, 3, 2)].teacherId) === 2,
    '实得' + overlay[school.scheduleCellKey(2, 3, 2)].teacherId
  )
  check('撤销后 swapped 标记清除', !overlay[school.scheduleCellKey(1, 1, 1)].swapped)

  console.log('\n[C] 通知文案')

  resetNotices()
  login(1, '周老师')
  await school.notifySwap(row, 'apply', { note: '教研' })
  check('发起方看到「已发出」', DB.notices[0].title.indexOf('已发出') >= 0, DB.notices[0].title)

  resetNotices()
  login(2, '何老师')
  await school.notifySwap(row, 'apply', { note: '教研' })
  check('接收方看到对方姓名', DB.notices[0].title.indexOf('周老师') >= 0, DB.notices[0].title)
  check('接收方文案含原因', DB.notices[0].content.indexOf('教研') >= 0, DB.notices[0].content)

  resetNotices()
  login(2, '何老师')
  await school.notifySwap(row, 'approve', {})
  check(
    '同意文案说明换后谁上哪节',
    DB.notices[0].content.indexOf('何老师 上') >= 0 && DB.notices[0].content.indexOf('周老师 上') >= 0,
    DB.notices[0].content
  )

  resetNotices()
  login(1, '周老师')
  await school.notifySwap(row, 'cancel', { wasApproved: true })
  check('撤销已生效文案含「恢复原样」', DB.notices[0].content.indexOf('恢复原样') >= 0, DB.notices[0].content)
  check('撤销已生效文案含操作人', DB.notices[0].content.indexOf('周老师') >= 0, DB.notices[0].content)

  resetNotices()
  login(1, '周老师')
  await school.notifySwap(row, 'cancel', { wasApproved: false })
  check('撤销未生效文案不含「恢复原样」', DB.notices[0].content.indexOf('恢复原样') < 0, DB.notices[0].content)

  console.log('\n[D] 通知容错')

  resetNotices()
  auth.clearSession()
  const n = await school.notifySwap(row, 'apply', {})
  check('未登录也能发通知（不依赖 session 才不崩）', n === 2, 'sent=' + n)

  resetNotices()
  const n2 = await school.notifySwap(null, 'apply', {})
  check('row 为空时安全返回 0', n2 === 0)

  resetNotices()
  login(2, '何老师')
  const orphan = makeSwap({ class_id: 999, swap_class_id: 888 })
  const n3 = await school.notifySwap(orphan, 'approve', {})
  check('班级不存在时只发双方不崩', n3 === 2, 'sent=' + n3)

  console.log('\n[E] 撤销权限判定（与 swap-detail 的 canCancel 同一套逻辑）')

  // 这两个判定必须与 pages/swap-detail/swap-detail.js 保持一致，改一处要改两处
  const canCancelOf = (r, myId) => {
    const isParty = myId === Number(r.requester_id) || myId === Number(r.target_id)
    return isParty && (r.status === 'pending' || r.status === 'approved')
  }
  const canHandleOf = (r, myId) => r.status === 'pending' && Number(r.target_id) === myId

  check('发起方：待处理可撤', canCancelOf(makeSwap(), 1) === true)
  check('接收方：待处理可撤', canCancelOf(makeSwap(), 2) === true)
  check('发起方：已同意仍可撤', canCancelOf(makeSwap({ status: 'approved' }), 1) === true)
  check('接收方：已同意仍可撤（需求核心）', canCancelOf(makeSwap({ status: 'approved' }), 2) === true)
  check('发起方：已拒绝不可撤', canCancelOf(makeSwap({ status: 'rejected' }), 1) === false)
  check('发起方：已撤销不可撤', canCancelOf(makeSwap({ status: 'cancelled' }), 1) === false)
  check('无关老师不可撤', canCancelOf(makeSwap({ status: 'approved' }), 8) === false)

  check('已同意后不能再「同意」', canHandleOf(makeSwap({ status: 'approved' }), 2) === false)
  check('已同意后发起方不能「处理」', canHandleOf(makeSwap({ status: 'approved' }), 1) === false)
  check('待处理时接收方能「同意」', canHandleOf(makeSwap(), 2) === true)
  check('待处理时发起方不能「同意」', canHandleOf(makeSwap(), 1) === false)

  console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————')
  process.exit(fail ? 1 : 0)
}

run().catch(e => {
  console.error('测试异常：', e && e.stack ? e.stack : e)
  process.exit(1)
})