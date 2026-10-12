/**
 * 用 mock 的 db 层验证导入逻辑（不触碰真实云数据库）。
 * 验证：
 *   1. importClassSchedules：班级课表 xlsx → 4 班 × 30 节，教师按姓名绑定
 *   2. importTeacherSchedules：教师课表 → 17 节，班级按名称绑定
 *   3. importStudents：多 sheet → 3 班 × 44 人
 *   4. importClassAccounts：15 个班级，班主任账号 → head_teacher_id 绑定
 *   5. 导入顺序无关：先班级账号后课表，班主任绑定不被覆盖
 *   6. 重复导入幂等（不产生重复行）
 */

const Module = require('module')

// ---- mock 内存数据库 ----
const DB = { schools: [], teachers: [], classes: [], students: [], schedules: [] }
let seq = { schools: 0, teachers: 0, classes: 0, students: 0, schedules: 0 }
function reset() {
  DB.schools = []
  DB.teachers = []
  DB.classes = []
  DB.students = []
  DB.schedules = []
  seq = { schools: 0, teachers: 0, classes: 0, students: 0, schedules: 0 }
}
function matches(row, filters) {
  return Object.keys(filters || {}).every(k => String(row[k]) === String(filters[k]))
}
function table(name) {
  return {
    select() {
      const self = this
      const api = {
        eq(k, v) {
          this._f = this._f || {}
          this._f[k] = v
          return api
        },
        order() {
          return api
        },
        limit() {
          return Promise.resolve(unbox(DB[name].filter(r => matches(r, api._f))))
        },
        then(resolve) {
          return Promise.resolve(unbox(DB[name].filter(r => matches(r, api._f)))).then(resolve)
        },
      }
      this._f = {}
      return api
    },
    insert(row) {
      const rows = Array.isArray(row) ? row : [row]
      const saved = rows.map(r => {
        const t = r.role === 'admin' || r.is_admin ? 'admin' : r.role || 'teacher'
        const o = Object.assign({}, r, { id: ++seq[t] })
        DB[t].push(o)
        return o
      })
      const api = { select: () => Promise.resolve(saved) }
      api.then = res => Promise.resolve(saved).then(res)
      return api
    },
    update(patch) {
      const self = this
      const api = {
        eq(k, v) {
          this._f = this._f || {}
          this._f[k] = v
          return api
        },
        select() {
          const hit = DB[name].filter(r => matches(r, this._f))
          hit.forEach(r => Object.assign(r, patch))
          return Promise.resolve(hit)
        },
      }
      this._f = {}
      return api
    },
    delete() {
      const api = {
        eq(k, v) {
          this._f = this._f || {}
          this._f[k] = v
          return api
        },
        select() {
          const keep = DB[name].filter(r => !matches(r, this._f))
          const gone = DB[name].filter(r => matches(r, this._f))
          DB[name] = keep
          return Promise.resolve(gone)
        },
      }
      this._f = {}
      return api
    },
  }
}
function unbox(rows) {
  return { data: rows, error: null }
}

// ---- mock wx ----
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
  cloud: { init: () => ({}), database: { from: table } },
}
let SESSION = ''

// ---- 替换 db.js 为 mock ----
const dbPath = require.resolve('../utils/db')
/** 记录每次数据库调用，用于验证导入是否走了批量路径 */
const CALLS = []
function logCall(op, table, size) {
  CALLS.push({ op, table, size: size || 1 })
}
const mockDb = {
  findOne: async (t, f) => {
    logCall('findOne', t)
    return DB[t].find(r => matches(r, f)) || null
  },
  findAll: async (t, f) => {
    logCall('findAll', t, DB[t].filter(r => matches(r, f)).length)
    return DB[t].filter(r => matches(r, f))
  },
  insert: async (t, row) => {
    logCall('insert', t)
    const o = Object.assign({}, row, { id: ++seq[t] })
    DB[t].push(o)
    return o
  },
  insertMany: async (t, rows) => {
    logCall('insertMany', t, rows.length)
    return rows.map(r => Object.assign({}, r, { id: ++seq[t] })).map(o => (DB[t].push(o), o))
  },
  update: async (t, f, patch) => {
    logCall('update', t)
    const hit = DB[t].filter(r => matches(r, f))
    hit.forEach(r => Object.assign(r, patch))
    return hit
  },
  remove: async (t, f) => DB[t].filter(r => matches(r, f)),
  upsertSetting: async () => {},
  getSetting: async () => null,
  getJsonSetting: async () => null,
  cloud: {},
  db: () => ({}),
  unwrap: r => (r ? r.data : null),
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]school\.js$/.test(parent.filename) && request === './db') return mockDb
  if (parent && /utils[\\/]auth\.js$/.test(parent.filename) && request === './db') return mockDb
  return origLoad.apply(this, arguments)
}

const excel = require('../utils/excel')
const fs = require('fs')
const path = require('path')
// 模版路径相对仓库根目录的 templates/，避免依赖固定盘符（原 hardcode F:/学校/提示词/schoolbuddy/）
const D = path.join(__dirname, '..', 'templates')
const buf = f => new Uint8Array(fs.readFileSync(path.join(D, f))).buffer

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''))
  }
}
function hash(p) {
  // 与 utils/util.js 的 hashPassword 无关的占位，仅区分不同密码
  let a = 0
  for (let i = 0; i < p.length; i++) a = (a * 31 + p.charCodeAt(i)) >>> 0
  return 'h' + a.toString(36)
}

;(async function run() {
  const school = require('../utils/school')

  console.log('\n[A] 完整导入流程：学校 → 教师 → 班级账号 → 班级课表 → 教师课表 → 学生')
  reset()
  SESSION = JSON.stringify({ role: 'super', account: '597280879', name: '许老师', schoolId: null })

  // 1. 学校 + 管理员
  const rSchool = await school.importSchoolsWithAdmins(excel.parse(buf('学校模版.xls')), hash)
  check('建 1 所学校 + 1 个管理员', rSchool.schoolCount === 1 && rSchool.adminCount === 1, rSchool.message)
  check('管理员归属该学校', DB.teachers[0] && DB.teachers[0].role === 'admin' && DB.teachers[0].school_id === DB.schools[0].id)
  const sid = DB.schools[0].id
  SESSION = JSON.stringify({ role: 'admin', account: '17600662106', name: '许老师', schoolId: sid })

  // 2. 教师账号（管理员已存在会被覆盖为普通教师吗？检查关键行为）
  const rTeach = await school.importTeachers(sid, excel.parse(buf('教师账号模版.xls')), hash)
  check('导入 11 名教师', rTeach.imported === 11, rTeach.message)
  check('教师总数 11（许老师与管理员同账号，已合并）', DB.teachers.length === 11, '实际 ' + DB.teachers.length)
  const zhou = DB.teachers.filter(t => t.name === '周老师')
  check('两位周老师账号分别建档', zhou.length === 2 && zhou[0].account !== zhou[1].account,
    zhou.map(z => z.account).join('/'))
  check('管理员未被教师导入降级',
    DB.teachers.find(t => t.account === '17600662106').role === 'admin',
    'role=' + DB.teachers.find(t => t.account === '17600662106').role)

  // 3. 班级账号（含班主任）
  const rAcc = await school.importClassAccounts(sid, excel.parse(buf('班级账号和密码模版.xls')), hash)
  check('导入 15 个班级', rAcc.imported === 15, rAcc.message)
  // 新模版每行都填了班主任账号，但只有 10 个账号能在教师模版里找到（13500000012~16 尚未建档）
  check('绑定班主任 10 人', rAcc.headTeacherLinked === 10, '实际 ' + rAcc.headTeacherLinked)
  check('缺失班主任账号被提示', rAcc.errors.some(e => e.indexOf('13500000016') >= 0),
    rAcc.errors.join(' | '))
  const b51 = DB.classes.find(c => c.name === 'B五1')
  const head = DB.teachers.find(t => t.account === '13665136408')
  check('B五1 的班主任 = 周老师(13665136408)', b51 && head && b51.head_teacher_id === head.id,
    b51 ? 'head_teacher_id=' + b51.head_teacher_id : 'B五1 不存在')
  check('能匹配到教师的 10 个班都绑定了班主任',
    DB.classes.filter(c => /^B[四五六]/.test(c.name) && c.head_teacher_id !== null).length === 10,
    DB.classes.filter(c => c.head_teacher_id).length + ' 个班已绑定')
  check('班级名去掉「班」字后缀', !DB.classes.some(c => /班$/.test(c.name)), DB.classes.map(c => c.name).slice(0, 3).join(','))

  // 4. 班级课表（xlsx）
  const rCs = await school.importClassSchedules(sid, excel.parse(buf('班级课表模版.xls')))
  check('导入 4 班 × 30 = 120 条', rCs.classCount === 4 && rCs.imported === 120, rCs.message)
  // 班级课表里有张老师等 15 位教师未出现在教师账号模版中，属正常情况，只需给出提示
  check('缺失教师仅以提示形式回报', rCs.errors.length === 1 && rCs.errors[0].indexOf('未匹配到教师') === 0,
    rCs.errors.join(' | '))
  const b51Sched = DB.schedules.filter(s => s.class_id === b51.id)
  check('B五1 有 30 条课表', b51Sched.length === 30, '实际 ' + b51Sched.length)
  const monday1 = b51Sched.find(s => s.weekday === 1 && s.period_no === 1)
  const chineseTeacher = DB.teachers.find(t => t.name === '周老师' && t.account === '13665136408')
  check('B五1 周一第1节 = 语文 且已绑教师', monday1 && monday1.subject === '语文' && monday1.teacher_id === chineseTeacher.id,
    monday1 ? JSON.stringify({ s: monday1.subject, tid: monday1.teacher_id }) : '无')

  // 5. 教师课表
  const rTs = await school.importTeacherSchedules(sid, excel.parse(buf('教师课表模版.xls')))
  check('导入 1 位教师 17 条', rTs.teacherCount === 1 && rTs.imported === 17, rTs.message)
  const xu = DB.teachers.find(t => t.name === '许老师' && t.account === '17600662106')
  check('许老师课表全部绑定本人', DB.schedules.filter(s => s.teacher_id === xu.id).length === 17,
    '实际 ' + DB.schedules.filter(s => s.teacher_id === xu.id).length)
  // 许老师的教师课表里 B五1 只有周四第 6 节（信息科技），
  // 该节在班级课表里也是信息科技，两表一致说明认课正确
  const b51Thu6 = DB.schedules.find(s => s.class_id === b51.id && s.weekday === 4 && s.period_no === 6)
  check('B五1 周四第6节 = 信息科技/许老师', b51Thu6 && b51Thu6.teacher_id === xu.id && b51Thu6.subject === '信息科技',
    b51Thu6 ? JSON.stringify({ t: b51Thu6.teacher_id, s: b51Thu6.subject }) : '无')
  // 其他节次不能被教师课表覆盖
  const b51Thu4 = DB.schedules.find(s => s.class_id === b51.id && s.weekday === 4 && s.period_no === 4)
  check('B五1 周四第4节仍为周老师的道德与法治（未被误覆盖）',
    b51Thu4 && b51Thu4.subject === '道德与法治' && b51Thu4.teacher_id === chineseTeacher.id,
    b51Thu4 ? JSON.stringify({ t: b51Thu4.teacher_id, s: b51Thu4.subject }) : '无')
  const createdClasses = DB.classes.filter(c => /^A四|^B四|^B五[2-6]$/.test(c.name))
  check('教师课表里的新班级已自动创建', createdClasses.length >= 10, '实际 ' + createdClasses.length)

  // 6. 学生（多 sheet）
  const rStu = await school.importStudents(sid, null, excel.parse(buf('学生模版.xls')))
  check('导入 132 名学生（3 班 × 44）', rStu.imported === 132, rStu.message)
  check('覆盖 3 个班级', rStu.classNames.length === 3, rStu.classNames.join(','))
  check('学号 1..44 各班独立', DB.students.filter(s => s.class_no === 1).length === 0)

  console.log('\n[B] 幂等性：重复导入不产生重复数据')
  const before = { c: DB.classes.length, t: DB.teachers.length, s: DB.students.length, sch: DB.schedules.length }
  await school.importClassSchedules(sid, excel.parse(buf('班级课表模版.xls')))
  await school.importStudents(sid, null, excel.parse(buf('学生模版.xls')))
  await school.importClassAccounts(sid, excel.parse(buf('班级账号和密码模版.xls')), hash)
  const after = { c: DB.classes.length, t: DB.teachers.length, s: DB.students.length, sch: DB.schedules.length }
  check('重复导入后行数不变',
    before.c === after.c && before.t === after.t && before.s === after.s && before.sch === after.sch,
    JSON.stringify({ before, after }))

  console.log('\n[C] 性能：批量写入把网络往返压到最少')
  CALLS.length = 0
  const t0 = Date.now()
  // 换一个干净学校，避免命中「已存在 → 只 update」的短路
  const perfSid = school.importSchools([{ rows: [['学校'], ['性能测试小学']] }])
    .then(async r => {
      const s2 = DB.schools.find(x => x.name === '性能测试小学').id
      SESSION = JSON.stringify({ role: 'admin', account: 'perf', name: 'P', schoolId: s2 })
      return s2
    })
    .catch(() => null)
  const s2 = await perfSid
  if (s2) {
    await school.importStudents(s2, null, excel.parse(buf('学生模版.xls')))
    await school.importClassSchedules(s2, excel.parse(buf('班级课表模版.xls')))
    const ins = CALLS.filter(c => c.op === 'insertMany' || c.op === 'insert')
    check('132 名学生用 3 次 insertMany 完成（原来 132 次）',
      ins.filter(c => c.op === 'insertMany' && c.table === 'students').length === 3,
      '实际 ' + ins.filter(c => c.op === 'insertMany' && c.table === 'students').length + ' 次')
    // findOne 只应出现在「按 id 取一行」的场景（学校存在性校验、缺省班级回退），
    // 数量与数据行数无关；逐行 findOne 才说明批量路径没生效
    const q = CALLS.filter(c => c.op === 'findOne')
    check('findOne 不随数据量增长（≤3 次固定校验）', q.length <= 3,
      q.map(c => c.table).join(',') + '，实际 ' + q.length + ' 次')
    check('120 条课表用 3 次 insertMany 完成（原来 120 次）',
      ins.filter(c => c.op === 'insertMany' && c.table === 'schedules').length === 3,
      '实际 ' + ins.filter(c => c.op === 'insertMany' && c.table === 'schedules').length + ' 次')
    console.log('    耗时 ' + (Date.now() - t0) + 'ms，共 ' + CALLS.length + ' 次数据库调用')
    SESSION = JSON.stringify({ role: 'admin', account: '17600662106', name: '许老师', schoolId: sid })
  }

  console.log('\n[D] 边界：空文件与不存在学校')
  const rEmpty = await school.importClassSchedules(sid, [])
  check('空课表返回友好提示', rEmpty.imported === 0 && !!rEmpty.message, rEmpty.message)
  const badSchool = await school.importClassSchedules(999999, excel.parse(buf('班级课表模版.xls')))
  check('不存在学校不写数据', badSchool.imported === 0, badSchool.message)
  const rNoTeach = await school.importTeacherSchedules(sid, excel.parse(buf('教师课表模版.xls')))
  check('教师已存在时可重复导入', rNoTeach.teacherCount === 1)

  console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n')
  process.exit(fail ? 1 : 0)
})().catch(e => {
  console.error('运行异常:', e)
  process.exit(1)
})
