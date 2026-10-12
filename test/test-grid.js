/**
 * 第十一轮测试：课表格子（跨班换课显示修复 + 窄列简称 + 重新上传覆盖）
 *
 * [A] buildSwapOverlay 跨班换课（本轮核心 bug）
 * [B] shortTeacher / shortClassName
 * [C] 重新上传课表能删掉旧课程（调课下线后的替代路径）
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
  settings: [],
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
  setStorageSync: (k, v) => { if (k === 'sb_session') SESSION = v },
  removeStorageSync: () => { SESSION = null },
  showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
  cloud: { init: () => ({}), database: { from: () => ({}) } },
}

const origLoad = Module._load
Module._load = function (request, parent) {
  if (parent && /utils[\\/]school\.js$/.test(parent.filename) && request === './db') return mockDb
  if (parent && /utils[\\/]auth\.js$/.test(parent.filename) && request === './db') return mockDb
  return origLoad.apply(this, arguments)
}

const school = require('../utils/school')
const util = require('../utils/util')

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

const teacherMap = { 1: '周老师', 2: '何老师', 3: '王老师' }
const KEY = school.scheduleCellKey

/* 1班周五1=语文(周老师)；2班周五6=数学(何老师) */
function seedSchedules() {
  DB.classes = [
    { id: 1, name: '三年1班', school_id: 1, head_teacher_id: 9 },
    { id: 2, name: '三年2班', school_id: 1, head_teacher_id: 8 },
  ]
  DB.teachers = [
    { id: 1, name: '周老师', school_id: 1 },
    { id: 2, name: '何老师', school_id: 1 },
    { id: 3, name: '王老师', school_id: 1 },
  ]
  DB.schedules = [
    { id: 11, class_id: 1, weekday: 5, period_no: 1, subject: '语文', teacher_id: 1 },
    { id: 12, class_id: 2, weekday: 5, period_no: 6, subject: '数学', teacher_id: 2 },
  ]
  DB.swap_requests = [{
    id: 100, status: 'approved',
    requester_id: 1, requester_name: '周老师',
    target_id: 2, target_name: '何老师',
    class_id: 1, weekday: 5, period_no: 1, subject: '语文', lesson_date: '2026-10-16',
    swap_class_id: 2, swap_weekday: 5, swap_period_no: 6, swap_subject: '数学', swap_date: '2026-10-16',
    reason: '教研', school_id: 1,
  }]
}

async function run() {
  console.log('[A] buildSwapOverlay 跨班换课（本轮核心 bug）')

  seedSchedules()

  // 传全校行 —— 这才是页面修复后的正确用法
  let overlay = school.buildSwapOverlay(DB.schedules, DB.swap_requests, teacherMap, 1)
  let c = overlay[KEY(1, 5, 1)]
  check('1班周五1 科目=对方让出的数学', c.subject === '数学', '实得' + JSON.stringify(c.subject))
  check('1班周五1 老师=何老师', c.teacherName === '何老师', '实得' + c.teacherName)
  check('1班周五1 teacherId=2', Number(c.teacherId) === 2, '实得' + c.teacherId)
  check('1班周五1 swapped=true', c.swapped === true)
  check('1班周五1 swapText 记录原任课', c.swapText.indexOf('周老师') >= 0, c.swapText)

  overlay = school.buildSwapOverlay(DB.schedules, DB.swap_requests, teacherMap, 2)
  c = overlay[KEY(2, 5, 6)]
  check('2班周五6 科目=周老师的语文', c.subject === '语文', '实得' + JSON.stringify(c.subject))
  check('2班周五6 老师=周老师', c.teacherName === '周老师', '实得' + c.teacherName)
  check('2班周五6 teacherId=1', Number(c.teacherId) === 1, '实得' + c.teacherId)

  // classId 过滤：不能带出别的班的格子
  check('classId=1 的结果里没有 2 班的格子', overlay[KEY(1, 5, 1)] === undefined)
  overlay = school.buildSwapOverlay(DB.schedules, DB.swap_requests, teacherMap, 1)
  const keys1 = Object.keys(overlay)
  check('classId=1 只返回 1 班的 1 个格子', keys1.length === 1 && keys1[0] === KEY(1, 5, 1), JSON.stringify(keys1))

  // 不传 classId → 两个班都在
  overlay = school.buildSwapOverlay(DB.schedules, DB.swap_requests, teacherMap)
  check('不传 classId 返回全部格子', Object.keys(overlay).length === 2, '实得' + Object.keys(overlay).length)

  // 回归：同班换课
  DB.schedules = [
    { id: 21, class_id: 1, weekday: 1, period_no: 1, subject: '语文', teacher_id: 1 },
    { id: 22, class_id: 1, weekday: 3, period_no: 2, subject: '数学', teacher_id: 2 },
  ]
  DB.swap_requests = [{
    id: 200, status: 'approved',
    requester_id: 1, requester_name: '周老师', target_id: 2, target_name: '何老师',
    class_id: 1, weekday: 1, period_no: 1, subject: '语文', lesson_date: '2026-10-12',
    swap_class_id: 1, swap_weekday: 3, swap_period_no: 2, swap_subject: '数学', swap_date: '2026-10-14',
    reason: '', school_id: 1,
  }]
  overlay = school.buildSwapOverlay(DB.schedules, DB.swap_requests, teacherMap, 1)
  check('同班换课：周一1=数学', overlay[KEY(1, 1, 1)].subject === '数学', overlay[KEY(1, 1, 1)].subject)
  check('同班换课：周三2=语文', overlay[KEY(1, 3, 2)].subject === '语文', overlay[KEY(1, 3, 2)].subject)

  // 回归：旧的单节课换课单（没有 swap_weekday）—— 保留原科目，只换人
  DB.swap_requests = [{
    id: 300, status: 'approved',
    requester_id: 1, requester_name: '周老师', target_id: 2, target_name: '何老师',
    class_id: 1, weekday: 1, period_no: 1, subject: '语文',
    reason: '', school_id: 1,
  }]
  overlay = school.buildSwapOverlay(DB.schedules, DB.swap_requests, teacherMap, 1)
  check('旧格式换课单：科目保持不变', overlay[KEY(1, 1, 1)].subject === '语文', overlay[KEY(1, 1, 1)].subject)
  check('旧格式换课单：老师换成对方', overlay[KEY(1, 1, 1)].teacherName === '何老师', overlay[KEY(1, 1, 1)].teacherName)

  console.log('\n[B] 简称函数')

  // 注意：教师名不再简称，格子里直接显示全名（~125rpx 列能放 6 个汉字）
  // shortTeacher 已在上一轮需求中下线，这里只验证它确实不存在，防止误用
  check('shortTeacher 已下线（防误用）', util.shortTeacher === undefined)

  check('三年1班→1班', util.shortClassName('三年1班') === '1班', util.shortClassName('三年1班'))
  check('六(3)班→(3)班', util.shortClassName('六(3)班') === '(3)班', util.shortClassName('六(3)班'))
  check('一年级甲班→甲班', util.shortClassName('一年级甲班') === '甲班', util.shortClassName('一年级甲班'))
  check('一班（2字）原样', util.shortClassName('一班') === '一班', util.shortClassName('一班'))
  check('空值安全', util.shortClassName('') === '' && util.shortClassName(undefined) === '')

  // 宽度校验：格子内可用 ~117rpx，19rpx 字号的中文约 19rpx/字
  const COL = 117
  const FS = 19
  // 班级简称（教师名不再简称）
  const classSamples = ['三年1班', '六(3)班', '一年级甲班', '五年级二班']
  const overflowClass = classSamples.filter(s => util.shortClassName(s).length * FS > COL)
  check('班级简称在列内放得下', overflowClass.length === 0, JSON.stringify(overflowClass))

  // 格子里的教师名是全名，同样要能放下
  const names = ['周老师', '许晓峰', '欧阳修', '司马光', '王芳', '李老师', '欧阳明月']
  const overflowName = names.filter(n => n.length * FS > COL)
  check('教师全名在列内放得下（≤6 字）', overflowName.length === 0, JSON.stringify(overflowName))
  check('真实数据里的老师名都不超 6 字', DB.teachers.every(t => t.name.length <= 6),
    JSON.stringify(DB.teachers.map(t => t.name)))

  console.log('\n[C] 重新上传课表能删掉旧课程')

  // 调课已下线，重新上传是唯一的改课表路径 —— 必须支持「删除」语义
  DB.schools = [{ id: 1, name: '测试小学', is_active: true }]
  DB.classes = [{ id: 1, name: '三年1班', school_id: 1, head_teacher_id: null }]
  DB.teachers = [
    { id: 1, name: '周老师', school_id: 1 },
    { id: 2, name: '何老师', school_id: 1 },
  ]
  DB.schedules = [
    { id: 41, class_id: 1, school_id: 1, weekday: 1, period_no: 1, subject: '语文', teacher_id: 1, is_active: true },
    { id: 42, class_id: 1, school_id: 1, weekday: 1, period_no: 2, subject: '数学', teacher_id: 2, is_active: true },
    { id: 43, class_id: 1, school_id: 1, weekday: 2, period_no: 1, subject: '英语', teacher_id: 1, is_active: true },
  ]
  DB.swap_requests = []

  // 新文件只有周一1（第二节被删掉了）
  // 矩阵结构：表头=星期，然后每节两行 —— 科目行 + 「时间段 + 教师」行
  const sheets = [{
    name: '三年1班',
    rows: [
      ['节次', '周一', '周二', '周三'],
      ['第一节', '语文', '数学', ''],
      ['08:20-09:00', '周老师', '何老师', ''],
      ['第二节', '', '', ''],
      ['09:15-09:55', '', '', ''],
    ],
  }]

  const res = await school.importClassSchedules(1, sheets)
  check('导入成功', res.imported === 2, 'imported=' + res.imported)
  check('删掉了 1 条旧课程', res.removed === 1, 'removed=' + res.removed)
  check('库里剩 2 条', DB.schedules.length === 2, '实得' + DB.schedules.length)
  const left = DB.schedules.map(s => s.subject).sort().join(',')
  check('留下的正是新文件里的两节', left === '数学,语文', left)

  // 重复导入同一份文件：不该再删任何东西（幂等）
  const res2 = await school.importClassSchedules(1, sheets)
  check('重复导入幂等（removed=0）', res2.removed === 0, 'removed=' + res2.removed)
  check('重复导入后仍是 2 条', DB.schedules.length === 2, '实得' + DB.schedules.length)

  // 别的班不能被误删
  DB.classes.push({ id: 2, name: '三年2班', school_id: 1, head_teacher_id: null })
  DB.schedules.push({
    id: 51, class_id: 2, school_id: 1, weekday: 1, period_no: 1,
    subject: '物理', teacher_id: 1, is_active: true,
  })
  await school.importClassSchedules(1, sheets)
  const other = DB.schedules.find(s => s.class_id === 2)
  check('未参与本次导入的班级不受影响', !!other && other.subject === '物理',
    JSON.stringify(other))

  console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————')
  process.exit(fail ? 1 : 0)
}

run().catch(e => {
  console.error('测试异常：', e && e.stack ? e.stack : e)
  process.exit(1)
})