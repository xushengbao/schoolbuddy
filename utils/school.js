const { findAll, findOne, insert, insertMany, update, remove, getJsonSetting, upsertSetting } = require('./db')
const { getSession } = require('./auth')
const { today, weekdayOfStr, nowTime, parseTable, pick, weekdayName, shortDay, shortSubject } = require('./util')

/**
 * 默认作息：一天六节课，时间与课表模版完全一致
 * 第一节 8:20-9:00 / 第二节 9:15-9:55 / 第三节 10:25-11:05
 * 第四节 11:20-12:00 / 第五节 13:20-14:00 / 第六节 14:15-14:55
 */
const DEFAULT_PERIODS = [
  { period: 1, label: '第1节', start: '08:20', end: '09:00' },
  { period: 2, label: '第2节', start: '09:15', end: '09:55' },
  { period: 3, label: '第3节', start: '10:25', end: '11:05' },
  { period: 4, label: '第4节', start: '11:20', end: '12:00' },
  { period: 5, label: '第5节', start: '13:20', end: '14:00' },
  { period: 6, label: '第6节', start: '14:15', end: '14:55' },
]

const DEFAULT_STUDENT_STATUS = ['正常', '病假', '事假', '医务室']

/**
 * 旧版默认作息（一天 8 节 08:00 起），用于识别并迁移到新的 6 节默认。
 * 只在「用户从未手动改过」时才替换：一旦是 8 节但时间与旧默认不同，
 * 说明管理员自定义过，必须保留。
 */
const LEGACY_PERIODS = [
  { period: 1, label: '第1节', start: '08:00', end: '08:45' },
  { period: 2, label: '第2节', start: '08:55', end: '09:40' },
  { period: 3, label: '第3节', start: '10:00', end: '10:45' },
  { period: 4, label: '第4节', start: '10:55', end: '11:40' },
  { period: 5, label: '第5节', start: '14:00', end: '14:45' },
  { period: 6, label: '第6节', start: '14:55', end: '15:40' },
  { period: 7, label: '第7节', start: '15:50', end: '16:35' },
  { period: 8, label: '第8节', start: '16:45', end: '17:30' },
]

/** 判断一份作息是否就是旧版默认值（逐字段比对） */
function isLegacyDefault(rows) {
  if (!Array.isArray(rows) || rows.length !== LEGACY_PERIODS.length) return false
  return rows.every(
    (p, i) =>
      Number(p.period) === LEGACY_PERIODS[i].period &&
      String(p.start || '') === LEGACY_PERIODS[i].start &&
      String(p.end || '') === LEGACY_PERIODS[i].end
  )
}

/**
 * 读取作息时间。
 * 未设置过、或还停留在旧版 8 节默认值时，都返回新的 6 节默认，
 * 并顺手把旧值改写成新默认，避免下次再判断。
 */
async function loadPeriods() {
  const rows = await getJsonSetting('periods', null)
  if (Array.isArray(rows) && rows.length) {
    if (isLegacyDefault(rows)) {
      await savePeriods(DEFAULT_PERIODS)
      return DEFAULT_PERIODS
    }
    return rows
  }
  return DEFAULT_PERIODS
}

async function savePeriods(list) {
  await upsertSetting('periods', JSON.stringify(list))
}

async function loadStudentStatusOptions() {
  const rows = await getJsonSetting('student_status_options', null)
  if (Array.isArray(rows) && rows.length) return rows
  return DEFAULT_STUDENT_STATUS
}

async function saveStudentStatusOptions(list) {
  await upsertSetting('student_status_options', JSON.stringify(list))
}

/** 当前节次：依据作息时间判断现在正在第几节课，不在课表区间内返回 0 */
function currentPeriod(periods) {
  const now = nowTime()
  for (const p of periods) {
    if (now >= p.start && now <= p.end) return p.period
  }
  return 0
}

/** 距离下一节课开始还有多少分钟，无课返回 null */
function minutesToNextPeriod(periods) {
  const now = nowTime()
  for (const p of periods) {
    const diff = toMinutes(p.start) - toMinutes(now)
    if (diff > 0) return { period: p.period, label: p.label, start: p.start, minutes: diff }
  }
  return null
}

function toMinutes(hhmm) {
  const parts = String(hhmm || '').split(':')
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (isNaN(h) || isNaN(m)) return 0
  return h * 60 + m
}

/* ===================== 学校与权限 ===================== */

/**
 * 当前登录者所属学校 ID。
 * 超级管理员（role='super'）不属于任何学校，返回 null，表示可见全部学校。
 */
function currentSchoolId() {
  try {
    const session = getSession()
    if (!session) return null
    if (session.role === 'super') return null
    return session.schoolId === undefined ? null : session.schoolId
  } catch (e) {
    return null
  }
}

function isSuperAdmin() {
  const session = getSession()
  return !!(session && session.role === 'super')
}

function isSchoolAdmin() {
  const session = getSession()
  return !!(session && (session.role === 'admin' || session.role === 'super'))
}

/** 超级管理员需要显式选择学校；学校管理员固定为自己学校 */
/**
 * 取目标学校 ID。
 * - 超级管理员可显式指定；指定值必须真实存在，避免写入脏数据
 * - 其余角色一律取会话中的学校
 */
async function requireSchoolId(explicit) {
  if (explicit) {
    const found = await findOne('schools', { id: explicit })
    return found ? found.id : null
  }
  return currentSchoolId()
}

async function listSchools() {
  return findAll('schools', {}, { column: 'id', ascending: true })
}

async function findSchoolByName(name) {
  const n = String(name || '').trim()
  if (!n) return null
  return findOne('schools', { name: n })
}

/** 按名称查找学校，找不到则创建 */
async function ensureSchool(name) {
  const n = String(name || '').trim()
  if (!n) return null
  const exist = await findSchoolByName(n)
  if (exist) return exist
  return insert('schools', { name: n, is_active: true })
}

async function listClasses(schoolId) {
  const sid = schoolId === undefined ? currentSchoolId() : schoolId
  const filter = sid ? { school_id: sid } : {}
  return findAll('classes', filter, { column: 'id', ascending: true })
}

async function listTeachers(schoolId) {
  const sid = schoolId === undefined ? currentSchoolId() : schoolId
  const filter = sid ? { school_id: sid } : {}
  return findAll('teachers', filter, { column: 'id', ascending: true })
}

async function listStudents(classId) {
  return findAll('students', classId ? { class_id: classId } : {}, { column: 'student_no', ascending: true })
}

async function listSchedules(classId) {
  return findAll('schedules', classId ? { class_id: classId } : {})
}

/* ===================== 调休（周末补某个工作日的课） ===================== */

/**
 * 调休：把某个周六 / 周日设为「按某个工作日的课表上课」。
 *
 * 场景：某个周六本来不上课，但因调休/补课，那天要上周一的课。
 * 落库只记一条「哪一天 → 顶哪个星期几」，不复制课表数据，
 * 所以调休日看到的课表永远跟着基准课表走，基准一改，调休日自动跟着变。
 *
 * 数据极小（一学期十几条），每次整表取回后缓存在模块级，
 * 避免首页/课表/班级大屏每渲染一次就打一次数据库。
 */
let makeupCache = { schoolId: undefined, list: null, at: 0 }
const MAKEUP_CACHE_TTL = 60 * 1000

/** 读取本校调休列表（带 60 秒缓存）；force=true 时强制回源 */
async function listMakeupDays(options) {
  const opts = options || {}
  const sid = opts.schoolId === undefined ? currentSchoolId() : opts.schoolId
  const now = Date.now()
  if (
    !opts.force &&
    makeupCache.list &&
    makeupCache.schoolId === sid &&
    now - makeupCache.at < MAKEUP_CACHE_TTL
  ) {
    return makeupCache.list
  }
  const filter = sid ? { school_id: sid } : {}
  let rows = []
  try {
    rows = await findAll('makeup_days', filter, { column: 'makeup_date', ascending: true })
  } catch (e) {
    // 表尚未建好时不能让整个课表页面挂掉
    rows = []
  }
  makeupCache = { schoolId: sid, list: rows, at: now }
  return rows
}

/** 调休改动后手动失效缓存（同一进程内立刻生效） */
function invalidateMakeupCache() {
  makeupCache = { schoolId: undefined, list: null, at: 0 }
}

/**
 * 某一天**实际上的是哪个星期几的课**。
 *
 * 这是全应用唯一入口：凡是「按天查课表」的地方都必须走这里，
 * 否则调休日会显示成空课 —— 课表是按 weekday 存的，周六根本查不到行。
 *
 * @param {string} day YYYY-MM-DD
 * @returns {Promise<{weekday:number, isMakeup:boolean, fromWeekday:number, note:string}>}
 *   weekday：0 表示当天不上课（普通周末且未设置调休）
 */
async function resolveDay(day) {
  const real = weekdayOfStr(day)
  const rows = await listMakeupDays()
  const hit = rows.find(r => String(r.makeup_date || '').slice(0, 10) === String(day || '').slice(0, 10))
  if (!hit) return { weekday: real, isMakeup: false, fromWeekday: 0, note: '', realWeekday: real }
  const w = Number(hit.weekday)
  if (!w || w < 1 || w > 5) return { weekday: real, isMakeup: false, fromWeekday: 0, note: '', realWeekday: real }
  return {
    weekday: w,
    isMakeup: true,
    fromWeekday: real,
    note: hit.note || '',
    realWeekday: real,
  }
}

/** 新增/更新一条调休（同一天覆盖） */
async function saveMakeupDay(payload) {
  const sid = payload.schoolId === undefined ? currentSchoolId() : payload.schoolId
  const date = String(payload.makeupDate || payload.date || '').slice(0, 10)
  const weekday = Number(payload.weekday)
  const note = String(payload.note || '').trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请选择要调休的日期')
  if (!weekday || weekday < 1 || weekday > 5) throw new Error('请选择这一天按周几的课表上课')

  // 只能给周末调休：周一到周五本来就上课，调休没有意义
  const w = weekdayOfStr(date)
  if (w < 6) throw new Error('只能对周六或周日设置调休')

  const exist = await findOne('makeup_days', sid ? { school_id: sid, makeup_date: date } : { makeup_date: date })
  let row
  if (exist) {
    await update('makeup_days', { id: exist.id }, { weekday, note })
    row = { ...exist, weekday, note }
  } else {
    row = await insert('makeup_days', {
      school_id: sid === undefined ? null : sid,
      makeup_date: date,
      weekday,
      note,
    })
  }
  invalidateMakeupCache()
  return row
}

/** 删除一条调休 */
async function removeMakeupDay(id) {
  const rows = await remove('makeup_days', { id })
  invalidateMakeupCache()
  return rows
}

/* ===================== 课表与换课 ===================== */

/**
 * 换课结算：把已通过的换课单叠加到课表上。
 *
 * 换课是「两节课对调」——第一节（发起方的课）改由对方上，第二节（对方让出来的课）
 * 改回给发起方。这里统一返回一张覆盖表：
 *   key = classId|weekday|period  →  { subject, teacherName, swapped, swapId }
 * 各页面直接查这张表即可，不必各写一遍。
 *
 * ⚠️ 关于 classId 过滤：换课经常**跨班**（A班第一节 ⇄ B班第一节）。
 * 如果只加载本班的schedules，对方那格不在原始 cells 里，
 * ensure() 会造出一个空格子，于是 before.s2 取到空字符串，
 * c1.subject = before.s2 || before.s1 就退化成「原科目不变」——
 * 表现就是：换过的格子只打个「换」标记，科目和老师都不对。
 *
 * 所以过滤只作用于「最终返回哪些格子」，**不作用于计算过程**。
 *
 * @param {Array} schedules 课表原始行（若传了 classId，调用方仍需传入全校行）
 * @param {Array} swaps 已通过的 swap_requests 行
 * @param {object} teacherMap teacherId → 姓名
 * @param {number} [classId] 只返回这个班的格子（不传则全返回）
 * @returns {object} 覆盖表
 */
function buildSwapOverlay(schedules, swaps, teacherMap, classId) {
  // 原始格子：先全量建好，计算过程不看 classId
  const cells = {}
  schedules.forEach(s => {
    const key = Number(s.class_id) + '|' + Number(s.weekday) + '|' + Number(s.period_no)
    cells[key] = {
      classId: Number(s.class_id),
      subject: s.subject || '',
      teacherId: s.teacher_id || null,
      teacherName: teacherMap[s.teacher_id] || '',
      swapped: false,
      swapId: null,
      swapText: '',
    }
  })

  const ensure = (key, classIdOfKey) => {
    if (!cells[key]) {
      cells[key] = {
        classId: Number(classIdOfKey),
        subject: '',
        teacherId: null,
        teacherName: '',
        swapped: false,
        swapId: null,
        swapText: '',
      }
    }
    return cells[key]
  }

  swaps.forEach(sw => {
    const c1Id = Number(sw.class_id)
    const c2Id = Number(sw.swap_class_id || sw.class_id)
    const k1 = c1Id + '|' + Number(sw.weekday) + '|' + Number(sw.period_no)
    const k2 = sw.swap_weekday ? c2Id + '|' + Number(sw.swap_weekday) + '|' + Number(sw.swap_period_no) : null

    const c1 = ensure(k1, c1Id)
    const c2 = k2 ? ensure(k2, c2Id) : null

    // 抓取对调前的两人两科
    const before = {
      s1: c1.subject,
      t1: c1.teacherName,
      id1: c1.teacherId,
      s2: c2 ? c2.subject : '',
      t2: c2 ? c2.teacherName : '',
      id2: c2 ? c2.teacherId : null,
    }
    const note = '换课' + (sw.reason ? '：' + sw.reason : '')

    // 注意：这里必须显式区分「对方那格本来就空」和「取值为空」。
    // 用 `before.s2 || before.s1` 会在对方那格为空时悄悄保留原科目，
    // 表面看没报错，实际显示的是错的课。空就是空。
    c1.subject = c2 ? before.s2 : before.s1
    c1.teacherName = c2 ? (before.t2 || sw.target_name || '') : (sw.target_name || before.t1)
    c1.teacherId = c2 ? (sw.target_id || null) : (sw.target_id || before.id1 || null)
    c1.swapped = true
    c1.swapId = sw.id
    c1.swapText = note + '（原 ' + before.s1 + '，' + (before.t1 || '无') + '）'

    if (c2) {
      c2.subject = before.s1
      c2.teacherName = before.t1 || sw.requester_name || ''
      c2.teacherId = sw.requester_id || null
      c2.swapped = true
      c2.swapId = sw.id
      c2.swapText = note + '（原 ' + before.s2 + '，' + (before.t2 || '无') + '）'
    }
  })

  // classId 只在最后过滤「返回哪些格子」，不影响上面的计算
  if (!classId) return cells
  const out = {}
  Object.keys(cells).forEach(k => {
    if (Number(cells[k].classId) === Number(classId)) out[k] = cells[k]
  })
  return out
}

/** 换课表的格子 key */
function scheduleCellKey(classId, weekday, periodNo) {
  return Number(classId) + '|' + Number(weekday) + '|' + Number(periodNo)
}

/** 一次拉取教师姓名表，供课表页面复用 */
async function teacherNameMap() {
  const map = {}
  ;(await listTeachers()).forEach(t => {
    map[t.id] = t.name
  })
  return map
}

/** 一次拉取班级名称表，换课/通知文案里要显示班级名 */
async function classNameMap() {
  const map = {}
  ;(await listClasses()).forEach(c => {
    map[c.id] = c.name
  })
  return map
}

/**
 * 某一天的课表，已合并换课后的实际任课老师。
 * 走 resolveDay 解析调休：调休日按指定工作日的课表返回，并标记 isMakeup。
 */
async function getScheduleForDay(classId, day) {
  const info = await resolveDay(day)
  const weekday = info.weekday
  // overlay 必须是全校数据：换课常跨班，只喂本班行取不到对方那格的真实科目
  const allRows = await listSchedules()
  const swaps = await findAll('swap_requests', { status: 'approved' })
  const teacherMap = await teacherNameMap()
  const overlay = buildSwapOverlay(allRows, swaps, teacherMap, classId)

  return allRows
    .filter(r => Number(r.class_id) === Number(classId) && Number(r.weekday) === weekday)
    .map(r => {
      const cell = overlay[scheduleCellKey(r.class_id, r.weekday, r.period_no)] || {}
      return {
        id: r.id,
        period: r.period_no,
        subject: cell.subject || r.subject,
        teacherName: cell.teacherName || '',
        swapped: !!cell.swapped,
        swapText: cell.swapText || '',
        isMakeup: info.isMakeup,
        makeupFrom: info.isMakeup ? info.realWeekday : 0,
      }
    })
    .sort((a, b) => a.period - b.period)
}

async function getTeacherDaySchedule(teacherId, day) {
  const info = await resolveDay(day)
  const weekday = info.weekday
  const schedules = await listSchedules()
  const swaps = await findAll('swap_requests', { status: 'approved' })
  const teacherMap = await teacherNameMap()
  const classes = await listClasses()
  const classMap = {}
  classes.forEach(c => {
    classMap[c.id] = c.name
  })
  const overlay = buildSwapOverlay(schedules, swaps, teacherMap)

  const rows = schedules
    .filter(s => Number(s.weekday) === weekday)
    .map(s => {
      const cell = overlay[scheduleCellKey(s.class_id, s.weekday, s.period_no)]
      if (!cell) return null
      // 换课后归属可能已变，任课人按覆盖表判断
      if (Number(cell.teacherId || 0) !== Number(teacherId)) return null
      return {
        id: s.id,
        classId: s.class_id,
        className: classMap[s.class_id] || '',
        period: s.period_no,
        weekday: weekday,
        subject: cell.subject,
        teacherName: cell.teacherName || teacherMap[teacherId] || '',
        swapped: !!cell.swapped,
        swapText: cell.swapText || '',
        isMakeup: info.isMakeup,
        makeupFrom: info.isMakeup ? info.realWeekday : 0,
      }
    })
    .filter(Boolean)

  return rows.sort((a, b) => a.period - b.period)
}

async function teacherClasses(teacherId) {
  const schedules = await listSchedules()
  const swaps = await findAll('swap_requests', { status: 'approved' })
  const ids = {}
  schedules.forEach(s => {
    if (Number(s.teacher_id) === Number(teacherId)) ids[s.class_id] = true
  })
  swaps.forEach(s => {
    if (Number(s.target_id) === Number(teacherId)) ids[s.class_id] = true
  })
  const classes = await listClasses()
  return classes.filter(c => ids[c.id])
}

/* ===================== 学生状态 ===================== */

async function getStudentStatusOfDay(classId, day) {
  return findAll('student_status', { class_id: classId, day })
}

/** 汇总某班某天的状态：总状态 +每节课的单节状态 */
async function summarizeStudentStatus(classId, day) {
  const rows = await getStudentStatusOfDay(classId, day)
  const periods = await loadPeriods()
  const summary = {
    total: { 病假: 0, 事假: 0, 医务室: 0, 其他: 0 },
    byPeriod: {},
    students: {},
  }

  rows.forEach(r => {
    if (Number(r.period_no) === 0) {
      if (r.status && r.status !== '正常') summary.total[r.status] = (summary.total[r.status] || 0) + 1
    } else {
      if (!summary.byPeriod[r.period_no]) {
        summary.byPeriod[r.period_no] = { 病假: 0, 事假: 0, 医务室: 0, 其他: 0 }
      }
      if (r.status && r.status !== '正常') summary.byPeriod[r.period_no][r.status] = (summary.byPeriod[r.period_no][r.status] || 0) + 1
    }
    if (!summary.students[r.student_id]) summary.students[r.student_id] = []
    summary.students[r.student_id].push(r)
  })

  periods.forEach(p => {
    if (!summary.byPeriod[p.period]) summary.byPeriod[p.period] = { 病假: 0, 事假: 0, 医务室: 0, 其他: 0 }
  })

  return { rows, summary }
}

/** 给单个学生设置某天（全天 period_no=0）或某节课的状态 */
async function setStudentStatus(record) {
  const existing = await findOne('student_status', {
    student_id: record.student_id,
    day: record.day,
    period_no: record.period_no || 0,
  })
  if (existing) {
    await update('student_status', { id: existing.id }, {
      status: record.status,
      note: record.note || '',
      operator: record.operator || '',
      student_name: record.student_name || '',
      class_id: record.class_id,
    })
    return existing
  }
  return insert('student_status', {
    student_id: record.student_id,
    student_name: record.student_name || '',
    class_id: record.class_id,
    day: record.day,
    period_no: record.period_no || 0,
    status: record.status,
    note: record.note || '',
    operator: record.operator || '',
  })
}

async function clearStudentStatus(studentId, day, periodNo) {
  return remove('student_status', { student_id: studentId, day, period_no: periodNo })
}

/* ===================== 站内信与换课 ===================== */

/** 发送站内信 */
async function pushNotice(notice) {
  return insert('notices', {
    receiver_id: notice.receiver_id,
    category: notice.category || '通知',
    title: notice.title || '',
    content: notice.content || '',
    is_read: false,
    related_class_id: notice.related_class_id || null,
    related_day: notice.related_day || null,
    related_period: notice.related_period || null,
  })
}

async function listNotices(receiverId, onlyUnread) {
  const filters = { receiver_id: receiverId }
  if (onlyUnread) filters.is_read = false
  return findAll('notices', filters, { column: 'created_at', ascending: false })
}

async function markNoticeRead(id) {
  return update('notices', { id }, { is_read: true })
}

/**
 * 列出「可以和谁换课、可以换他的哪一节课」。
 *
 * 为什么不能直接按 schedules.teacher_id 过滤？
 * ------------------------------------------------
 * 课表上的任课归属会被已通过的换课改写（见 buildSwapOverlay）。
 * 如果发起方的课用 overlay 判断归属（getTeacherDaySchedule 就是这么做的），
 * 而候选老师的课用原始 teacher_id 判断，两边口径不一致 ——
 * 换过一次之后，发起方自己的课会出现在别的老师的候选列表里，
 * 选下去就成了「自己跟自己换课」。这正是之前的逻辑错误。
 *
 * 所以这里统一：**任何时候判断「这节课是谁的」都走 overlay**，
 * 保证发起方看到的候选里绝不会出现自己的课。
 *
 * @param {object} params
 * @param {number} params.requesterId  发起方教师 id
 * @param {Array}  params.days        upcomingDays(n) 的结果（含 date/ weekday）
 * @param {Array}  params.teachers    全部教师（listTeachers 的结果）
 * @param {Array}  params.schedules   全部课表（listSchedules 的结果）
 * @param {Array}  params.swaps       已通过的换课单
 * @param {object} params.teacherMap   teacherId → teacherName
 * @param {object} params.classMap    classId → className
 * @param {string} [params.keyword]    教师姓名搜索词
 * @param {object} [params.first]     发起方已选的第一节课，用于排除同一格
 * @returns {Array} 每个候选老师：{ id, name, group, lessons }
 */
/**
 * 某位老师在指定「星期 + 节次」是否已经有课（跨班级算）。
 *
 * 换课之后课表的真实归属只能从 overlay 读，所以这里必须走 overlay，
 * 否则换过课的老师会被算成「有空」，导致同一节排两节课。
 *
 * @returns {?object} 有课则返回 { classId, subject }，没课返回 null
 */
function teacherBusyAtSlot(teacherId, weekday, period, schedules, overlay) {
  if (!teacherId || !weekday || !period) return null
  const list = schedules || []
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (Number(s.weekday) !== Number(weekday)) continue
    if (Number(s.period_no) !== Number(period)) continue
    const cell = overlay[scheduleCellKey(s.class_id, s.weekday, s.period_no)]
    if (!cell) continue
    if (Number(cell.teacherId || 0) === Number(teacherId)) {
      return { classId: s.class_id, subject: cell.subject || s.subject || '' }
    }
  }
  return null
}

/**
 * 换课冲突检查。候选生成与提交申请共用这一份判断，避免两处口径不一致。
 *
 * 对调是「两节课互换格子」，所以要查两个方向的冲突：
 *   1. 被申请的老师在**第一节课的节次**上是否已有课
 *      —— 有的话换完他同一节要上两节课，这是用户明确要求拦截的情况
 *   2. 发起方在**第二节课的节次**上是否已有课
 *      —— 同理，否则发起方自己会撞车
 *
 * @param {object} params
 * @param {number} params.requesterId
 * @param {number} params.targetId
 * @param {object} [params.first]  第一节课 { weekday, period }
 * @param {object} [params.second] 第二节课 { weekday, period }
 * @param {Array}  params.schedules
 * @param {Array}  params.swaps
 * @param {object} params.teacherMap
 * @param {object} [params.classMap]
 * @param {string} [params.targetName]
 * @returns {{ok:boolean, code?:string, reason?:string}}
 */
function checkSwapConflict(params) {
  const requesterId = Number(params.requesterId || 0)
  const targetId = Number(params.targetId || 0)
  const first = params.first || null
  const second = params.second || null
  const teacherMap = params.teacherMap || {}
  const classMap = params.classMap || {}
  const targetName = params.targetName || ''

  if (!targetId) return { ok: true }
  if (targetId === requesterId) {
    return { ok: false, code: 'self', reason: '不能和自己换课，请选择其他老师' }
  }
  if (!first) return { ok: true }

  const schedules = params.schedules || []
  const overlay = buildSwapOverlay(schedules, params.swaps || [], teacherMap)

  const busy = teacherBusyAtSlot(targetId, first.weekday, first.period, schedules, overlay)
  if (busy) {
    const cls = classMap[busy.classId] || ''
    return {
      ok: false,
      code: 'target_busy',
      reason:
        `${targetName || '该老师'}${weekdayName(Number(first.weekday))}第${first.period}节已有` +
        `${cls ? cls + ' ' : ''}${shortSubject(busy.subject)}，不能再接这节课`,
    }
  }

  if (second) {
    const mine = teacherBusyAtSlot(requesterId, second.weekday, second.period, schedules, overlay)
    if (mine) {
      const cls = classMap[mine.classId] || ''
      return {
        ok: false,
        code: 'requester_busy',
        reason:
          `你${weekdayName(Number(second.weekday))}第${second.period}节已有` +
          `${cls ? cls + ' ' : ''}${shortSubject(mine.subject)}，不能再接这节课`,
      }
    }
  }

  return { ok: true }
}

function buildSwapCandidates(params) {
  const requesterId = Number(params.requesterId || 0)
  const days = params.days || []
  const teacherMap = params.teacherMap || {}
  const classMap = params.classMap || {}
  const first = params.first || null
  const keyword = String(params.keyword || '').trim()

  // 换过课之后，课表的真实归属只能从 overlay 读
  const overlay = buildSwapOverlay(params.schedules || [], params.swaps || [], teacherMap)

  const out = []

  ;(params.teachers || []).forEach(t => {
    const tid = Number(t.id)
    // 排除自己和未开通的账号
    if (tid === requesterId) return
    if (t.status === 'disabled') return
    if (keyword && String(t.name || '').indexOf(keyword) < 0) return

    const lessons = []

    days.forEach(d => {
      ;(params.schedules || []).forEach(s => {
        if (Number(s.weekday) !== Number(d.weekday)) return

        const cell = overlay[scheduleCellKey(s.class_id, s.weekday, s.period_no)]
        if (!cell) return
        // 归属以 overlay 为准 —— 这正是原来会把自己算成候选的那一处
        if (Number(cell.teacherId || 0) !== tid) return
        // 已经在有效换课单里的格子不再重复发起
        if (cell.swapped) return

        lessons.push({
          classId: s.class_id,
          className: classMap[s.class_id] || '',
          weekday: Number(s.weekday),
          weekdayName: weekdayName(Number(s.weekday)),
          period: Number(s.period_no),
          subject: cell.subject || s.subject || '',
          teacherId: tid,
          teacherName: cell.teacherName || t.name || '',
          date: d.date,
          dateLabel: d.label + ' ' + d.sub,
          // 与第一节课落在同一格（同星期同节次）的不能选，否则换了个寂寞
          sameSlot: !!(
            first &&
            Number(first.weekday) === Number(s.weekday) &&
            Number(first.period) === Number(s.period_no)
          ),
        })
      })
    })

    if (!lessons.length) return
    lessons.sort((a, b) => {
      if (a.date < b.date) return -1
      if (a.date > b.date) return 1
      return a.period - b.period
    })

    const open = lessons.filter(l => !l.sameSlot)

    // 老师级冲突：被申请的老师在第一节课的节次上已经有课 —— 整位老师都不可选。
    // 先留着记录再过滤，页面能提示「为什么这个人今天不能选」，
    // 直接 return 掉的话用户会以为系统漏了这个人。
    let blocked = ''
    if (first) {
      const hit = teacherBusyAtSlot(tid, first.weekday, first.period, params.schedules || [], overlay)
      if (hit) {
        const cls = classMap[hit.classId] || ''
        blocked =
          `${weekdayName(Number(first.weekday))}第${first.period}节已有` +
          `${cls ? cls + ' ' : ''}${shortSubject(hit.subject)}，不能再接这节课`
      }
    }

    // 全被同格过滤掉的人不必展示
    if (!open.length && !blocked) return

    out.push({
      id: t.id,
      name: t.name,
      group: t.subject_group || '',
      lessons: open,
      blocked,
    })
  })

  return out
}

/**
 * 换课申请：发起。
 * 语义是「两节课对调」：
 *   - 第一节课 = 发起方自己的课（weekday / period_no / subject / class_id）
 *   - 第二节课 = 接收方要让出来的那节课（swap_weekday / swap_period_no / swap_subject / swap_class_id）
 * 两节课必须来自不同日期，否则等价于没换。
 */
async function createSwapRequest(payload) {
  // 换课必须是「我 ⇄ 别的老师」。这三条是防止「自己跟自己换」的最后一道闸 ——
  // 页面已过滤过，但申请是能被构造的，服务端也要拦。
  if (!payload.requester_id) {
    throw new Error('请先登录后再发起换课')
  }
  if (!payload.target_id) {
    throw new Error('请选择要和你换课的老师')
  }
  if (Number(payload.target_id) === Number(payload.requester_id)) {
    throw new Error('不能和自己换课，请选择其他老师')
  }
  if (!payload.swap_weekday || !payload.swap_period_no) {
    throw new Error('请选择要换出去的那一节课')
  }
  if (Number(payload.swap_weekday) === Number(payload.weekday) && Number(payload.swap_period_no) === Number(payload.period_no)) {
    throw new Error('两节课相同，无需换课')
  }
  // 冲突校验也放在服务端：页面已经拦过，但申请是可以被构造的。
  // 被申请的老师在第一节课的节次上已有课时，对调后他要同一节上两节课，必须拒绝。
  const check = await checkSwapConflict({
    requesterId: payload.requester_id,
    targetId: payload.target_id,
    targetName: payload.target_name,
    first: { weekday: payload.weekday, period: payload.period_no },
    second: { weekday: payload.swap_weekday, period: payload.swap_period_no },
    schedules: await listSchedules(),
    swaps: await findAll('swap_requests', { status: 'approved' }),
    teacherMap: await teacherNameMap(),
    classMap: await classNameMap(),
  })
  if (!check.ok) throw new Error(check.reason)

  return insert('swap_requests', {
    requester_id: payload.requester_id,
    requester_name: payload.requester_name,
    target_id: payload.target_id,
    target_name: payload.target_name,
    // 第一节（发起方的课）
    class_id: payload.class_id,
    weekday: payload.weekday,
    period_no: payload.period_no,
    subject: payload.subject,
    lesson_date: payload.lesson_date || null,
    // 第二节（对方让出来的课），未指定班级时沿用同一班级
    swap_weekday: payload.swap_weekday,
    swap_period_no: payload.swap_period_no,
    swap_subject: payload.swap_subject || '',
    swap_teacher_id: payload.swap_teacher_id || null,
    swap_teacher_name: payload.swap_teacher_name || payload.target_name || '',
    swap_class_id: payload.swap_class_id || payload.class_id,
    swap_date: payload.swap_date || null,
    reason: payload.reason || '',
    status: 'pending',
    original_teacher_id: payload.original_teacher_id || null,
    original_teacher_name: payload.original_teacher_name || '',
    original_subject: payload.subject || '',
    school_id: payload.school_id || null,
  })
}

async function updateSwapRequest(id, patch) {
  return update('swap_requests', { id }, patch)
}

async function listSwapRequests(filter) {
  return findAll('swap_requests', filter || {}, { column: 'created_at', ascending: false })
}

/**
 * 把两节课的描述拼成一句人话，用于站内信与列表展示。
 * 带日期时写成「10月13日 周一第1节」，否则只写「周一第1节」。
 * @param {object} row swap_requests 行
 * @param {string} className 班级名
 */
function describeSwap(row, className) {
  const one = (date, weekday, period, subject) => {
    const p = period ? '第' + period + '节' : ''
    const s = subject ? ' ' + subject : ''
    return (date ? shortDay(date) : weekdayName(weekday)) + p + s
  }
  const first = one(row.lesson_date, row.weekday, row.period_no, row.subject).trim()
  const second = row.swap_weekday
    ? one(row.swap_date, row.swap_weekday, row.swap_period_no, row.swap_subject).trim()
    : ''
  const head = className ? `【${className}】` : ''
  return second ? `${head}${first} ⇄ ${second}` : `${head}${first}`
}

/**
 * 换课站内信：把「一次换课事件」通知到所有该知道的人。
 *
 * 事件与收件人的对应关系（这是需求约定的规则，集中在这里避免各处写漏）：
 *
 *   | 事件            | 发起方 | 接收方 | 班主任 |
 *   |-----------------|--------|--------|--------|
 *   | apply（收到申请）|   ✓    |   ✓    |   ✗    |
 *   | approve（已同意）|   ✓    |   ✓    |   ✓    |
 *   | cancel（撤销）   |   ✓    |   ✓    | 仅当被撤销的是已生效的换课 |
 *
 * 换课通常跨两个班级（第一节在A班、第二节在B班），两班的班主任都要通知。
 * 同一个人只发一条 —— 班主任恰好是换课双方之一时不重复打扰。
 *
 * @param {object} row   swap_requests 行
 * @param {string} event 'apply' | 'approve' | 'cancel'
 * @param {object} options
 * @param {string} [options.note]      备注 / 撤销原因
 * @param {boolean} [options.wasApproved] 撤销时原状态是否已是 approved
 * @returns {Promise<number>} 实际发出的条数
 */
async function notifySwap(row, event, options) {
  if (!row) return 0
  const opts = options || {}
  const classes = await listClasses()
  const classMap = {}
  classes.forEach(c => {
    classMap[c.id] = c.name
  })
  const summary = describeSwap(row, classMap[row.class_id] || '')
  const session = getSession()
  const actor = (session && session.name) || '对方'
  const isRequester = Number(row.requester_id) === Number(session && session.teacherId)
  const first = oneLessonText(row.lesson_date, row.weekday, row.period_no, row.subject)
  const second = row.swap_weekday
    ? oneLessonText(row.swap_date, row.swap_weekday, row.swap_period_no, row.swap_subject)
    : ''
  const after = first && second ? `同意后：${row.target_name} 上「${first}」，${row.requester_name} 上「${second}」` : ''

  // 收件人：双方固定；班主任按事件决定
  const partyIds = []
  const push = v => {
    const id = Number(v || 0)
    if (id && partyIds.indexOf(id) === -1) partyIds.push(id)
  }
  push(row.requester_id)
  push(row.target_id)

  // 拒绝是「操作人刚做的决定」，给他自己再发一条「被拒绝」纯属噪音。
  // 只有发起方需要知道结果，所以这里把操作人剔掉。
  if (event === 'reject') {
    const i = partyIds.indexOf(Number(session && session.teacherId))
    if (i >= 0) partyIds.splice(i, 1)
  }

  const headIds = []
  const pushHead = classId => {
    const klass = classes.find(c => Number(c.id) === Number(classId))
    const head = Number((klass && klass.head_teacher_id) || 0)
    if (head && headIds.indexOf(head) === -1) headIds.push(head)
  }
  const needHead = event === 'approve' || (event === 'cancel' && opts.wasApproved)
  if (needHead) {
    pushHead(row.class_id)
    pushHead(row.swap_class_id)
  }

  let text = ''
  let title = ''
  let category = '换课申请'
  if (event === 'apply') {
    title = isRequester ? '换课申请已发出' : row.requester_name + ' 向你发起换课申请'
    text = `换课内容：${summary}。`
    if (!isRequester && opts.note) text += `原因：${opts.note}`
  } else if (event === 'reject') {
    category = '换课结果'
    title = '换课申请被拒绝'
    text = `${actor} 拒绝了换课申请（${summary}）。`
    if (opts.note) text += `备注：${opts.note}`
  } else if (event === 'approve') {
    category = '换课结果'
    title = isRequester ? '你的换课申请已同意' : '你已同意这节换课'
    text = `${summary}。${after}。`
    if (opts.note) text += `备注：${opts.note}`
  } else {
    category = '换课结果'
    title = '换课已撤销'
    text = opts.wasApproved
      ? `${actor} 撤销了已生效的换课（${summary}），课表已恢复原样。`
      : `${actor} 撤销了换课申请（${summary}）。`
    if (opts.note) text += `原因：${opts.note}`
  }

  let sent = 0
  for (const rid of partyIds) {
    try {
      await pushNotice({
        receiver_id: rid,
        category,
        title,
        content: text,
        related_class_id: row.class_id,
        related_day: row.lesson_date || null,
        related_period: row.period_no || null,
      })
      sent++
    } catch (e) {
      // 单条失败不影响其他收件人，也不影响换课本身
    }
  }

  // 班主任另发一条（换课双方的人已经收到上面那条，不重复）
  for (const hid of headIds) {
    if (partyIds.indexOf(hid) >= 0) continue
    try {
      await pushNotice({
        receiver_id: hid,
        category: '换课通知',
        title: event === 'cancel' ? '本班换课已撤销' : '本班发生换课',
        content: text,
        related_class_id: row.swap_class_id || row.class_id,
        related_day: row.lesson_date || null,
        related_period: row.period_no || null,
      })
      sent++
    } catch (e) {
      // 同上
    }
  }
  return sent
}

/** 单节课的一句话描述，供通知文案拼装 */
function oneLessonText(date, weekday, periodNo, subject) {
  const when = date ? shortDay(date) : weekdayName(weekday)
  const p = periodNo ? ' 第' + periodNo + '节' : ''
  return (when + p + (subject ? ' ' + subject : '')).trim()
}

/* ===================== 导入：通用工具 ===================== */

/** 单元格取值：数字型的账号/学号会变成 1.0，统一转成去尾零的字符串 */
function cell(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v)
    return String(v)
  }
  return String(v).trim()
}

/**
 * 把 xls 解析出的二维数组转成「表头 -> 对象」的记录数组。
 * 表头容错：与 candidates 任一匹配即可。
 */
function rowsToRecords(rows, columns) {
  if (!rows || !rows.length) return []
  const header = rows[0].map(cell)
  const idx = {}
  const used = {}
  columns.forEach(col => {
    for (let i = 0; i < header.length; i++) {
      if (used[i]) continue
      if (col.candidates.some(c => header[i] === c)) {
        idx[col.key] = i
        used[i] = true
        return
      }
    }
  })
  const list = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || !row.length) continue
    const rec = {}
    let hasValue = false
    columns.forEach(col => {
      const raw = idx[col.key] === undefined ? '' : cell(row[idx[col.key]])
      rec[col.key] = raw
      if (raw) hasValue = true
    })
    if (hasValue) list.push(rec)
  }
  return list
}

function parseWeekday(text) {
  const t = String(text || '').trim()
  if (!t) return 0
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
  const chinese = t.match(/[一二三四五六日天]/)
  if (chinese) return map[chinese[0]] || 0
  const num = parseInt(t.replace(/[^0-9]/g, ''), 10)
  return num >= 1 && num <= 7 ? num : 0
}

/** 从 "8:20-9:00" 解析出起止时间 */
function parseTimeRange(text) {
  const t = String(text || '').trim()
  if (!t) return null
  const m = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*[-~—至]\s*(\d{1,2})\s*[:：]\s*(\d{2})/)
  if (!m) return null
  const pad2 = v => String(v).padStart(2, '0')
  return { start: pad2(m[1]) + ':' + m[2], end: pad2(m[3]) + ':' + m[4] }
}

const COL_SCHOOL = { key: 'school', candidates: ['学校', '学校名称', 'school'] }
const COL_CLASS = { key: 'className', candidates: ['班级', '班级名称', 'class'] }

/* ===================== 导入：课表（矩阵结构） ===================== */

/**
 * 班级名归一化。
 * 「班级课表模版」的 A1 写成「B五1班」，而班级账号模版、学生模版、
 * 教师课表里都写「B五1」。这里统一去掉尾部的「班」字，保证能对上。
 */
function normalizeClassName(text) {
  return String(text || '')
    .trim()
    .replace(/[（(]?\s*班\s*[)）]?\s*$/, '')
    .trim()
}

/**
 * 解析矩阵式课表 sheet（班级课表与教师课表共用同一结构）。
 *
 * 模版结构（两种文件完全一样，只是每格含义不同）：
 *   第 0 行：[名称, 星期一, 星期二, ...]
 *   第 1 行：['第一节', 科目, 科目, ...]
 *   第 2 行：['8:20-9:00', 教师或班级, 教师或班级, ...]
 *   第 3/4 行：第二节 + 时间，...成对交替
 *
 * mode='class'   时第 2 行每格是「教师姓名」，返回 teacherName
 * mode='teacher' 时第 2 行每格是「班级名」，返回 className
 *
 * 返回 [{ weekday, period, subject, teacherName, className, start, end }]
 */
function parseMatrixSheet(sheet, mode) {
  const rows = sheet.rows || []
  if (rows.length < 3) return []
  const isTeacherSheet = mode === 'teacher'

  const header = rows[0].map(cell)
  // 表头里除第 0 列外都当作星期；首列若不是星期则跳过
  const weekdays = []
  for (let c = 1; c < header.length; c++) {
    const wd = parseWeekday(header[c])
    weekdays.push({ col: c, weekday: wd })
  }
  const valid = weekdays.filter(w => w.weekday > 0)
  if (!valid.length) return []

  const out = []
  let periodNo = 0
  let pendingSubjectRow = null

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const first = cell(row[0])

    // 节次标签行：'第一节' / '第1节' / '1' 等
    if (/第\s*[0-9一二三四五六七八九十]+\s*节/.test(first) || /^\s*[0-9]+\s*$/.test(first)) {
      periodNo = parseInt(first.replace(/[^0-9]/g, ''), 10)
      if (isNaN(periodNo) || periodNo <= 0) {
        const cn = first.match(/[一二三四五六七八九十]/)
        const cnMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
        periodNo = cn ? cnMap[cn[0]] || 0 : 0
      }
      pendingSubjectRow = { row, period: periodNo }
      continue
    }

    // 时间/第二行：首列是时间段，且上一行是科目行
    const time = parseTimeRange(first)
    if (time && pendingSubjectRow) {
      const subjectRow = pendingSubjectRow.row
      valid.forEach(w => {
        const subject = cell(subjectRow[w.col])
        const who = cell(row[w.col])
        if (!subject && !who) return
        out.push({
          weekday: w.weekday,
          period: pendingSubjectRow.period,
          subject,
          teacherName: isTeacherSheet ? '' : who,
          className: isTeacherSheet ? normalizeClassName(who) : '',
          start: time.start,
          end: time.end,
        })
      })
      pendingSubjectRow = null
    }
  }

  return out
}

/** 名称列（A1 或 sheet 名）：剔除「星期X」这类表头残留 */
function sheetTitle(sheet) {
  const a1 = cell((sheet.rows[0] || [])[0])
  if (a1 && parseWeekday(a1) === 0) return a1
  return sheet.name || ''
}

/** 在学校范围内确保班级存在，返回班级行 */
async function ensureClass(sid, name, classByName) {
  const className = normalizeClassName(name)
  if (!className) return null
  if (classByName[className]) return classByName[className]
  const created = await insert('classes', { name: className, school_id: sid })
  if (created) classByName[className] = created
  return created
}

/** 课表唯一键：同一班级同一星期同一节只有一条 */
function scheduleKey(classId, weekday, periodNo) {
  return classId + '|' + weekday + '|' + periodNo
}

/**
 * 批量写入器：把导入过程里新增的行先攒起来，最后分片批量插入。
 *
 * 为什么需要：导入一份全校课表会产生上千行。逐条 insert 意味着上千次网络往返，
 * 在手机弱网下非常慢。这里改成
 *   「一次查询已有数据 → 内存比对 → 只对新增的行批量 insert」
 * 网络往返从 O(n) 降到 O(n / batchSize)。
 *
 * @param {string} table
 * @param {number} [batchSize] 每片行数，太大可能被服务端拒绝，默认 50
 */
function createBatchWriter(table, batchSize) {
  const size = batchSize || 50
  let pending = []
  let inserted = 0

  async function flush() {
    while (pending.length) {
      const chunk = pending.splice(0, size)
      const rows = chunk.map(item => item.row)
      const result = await insertMany(table, rows)
      inserted += rows.length
      // 返回行里带自增 id，回填给调用方（用于后续关联）
      if (result && result.length) {
        chunk.forEach((item, i) => {
          if (result[i] && item.onInserted) item.onInserted(result[i])
        })
      }
    }
    return inserted
  }

  return {
    /**
     * @param {object} row 待插入的数据库行
     * @param {(row:object)=>void} [onInserted] 插入后回填自增 id
     */
    push(row, onInserted) {
      pending.push({ row, onInserted })
    },
    get size() {
      return pending.length
    },
    flush,
  }
}

/** 两个行对象在给定字段上是否完全一致（用于跳过无意义的 update） */
function rowEquals(a, b, fields) {
  if (!a || !b) return false
  return fields.every(f => {
    const va = a[f]
    const vb = b[f]
    if (va === vb) return true
    if (va === null || va === undefined) return vb === null || vb === undefined
    return String(va) === String(vb)
  })
}

/**
 * 并发受限地执行一组异步任务，避免一次导入几百个请求把弱网打爆。
 * @param {Array<Function>} tasks 返回 Promise 的任务数组
 * @param {number} [limit] 并发数
 */
async function runWithLimit(tasks, limit) {
  const width = Math.max(1, limit || 8)
  let cursor = 0
  const workers = []
  const total = tasks.length
  for (let i = 0; i < width; i++) workers.push(i)
  await Promise.all(
    workers.map(async () => {
      while (cursor < total) {
        const index = cursor++
        await tasks[index]()
      }
    })
  )
}

/**
 * 导入班级课表（模版：班级课表模版.xlsx / 旧课表模版.xls）。
 * 每个 sheet 代表一个班级（sheet 名或 A1），第 2 行每格是教师姓名。
 */
async function importClassSchedules(schoolId, sheets) {
  if (!sheets || !sheets.length) return { imported: 0, message: '没有解析到有效数据' }
  const sid = await requireSchoolId(schoolId)
  if (!sid) return { imported: 0, message: '请先选择学校' }

  const teacherByName = {}
  ;(await listTeachers(sid)).forEach(t => {
    if (!teacherByName[t.name]) teacherByName[t.name] = t
  })
  const classByName = {}
  ;(await listClasses(sid)).forEach(c => {
    classByName[normalizeClassName(c.name)] = c
  })

  const errors = []
  const missing = {}

  // 第一步：先把所有工作表解析成扁平条目，并确保班级存在（班级数量少，逐个插入即可）
  const plans = []
  for (const sheet of sheets) {
    const entries = parseMatrixSheet(sheet, 'class')
    if (!entries.length) continue

    const klass = await ensureClass(sid, sheetTitle(sheet), classByName)
    if (!klass) {
      errors.push(`工作表「${sheet.name}」：无法确定班级名`)
      continue
    }
    entries.forEach(e => plans.push({ klass, e }))
  }

  // 第二步：一次拉取全校课表，在内存里建索引，避免逐条 findOne
  const existing = await findAll('schedules', { school_id: sid })
  const index = {}
  existing.forEach(row => {
    index[scheduleKey(row.class_id, row.weekday, row.period_no)] = row
  })

  const writer = createBatchWriter('schedules')
  const updateTasks = []
  let imported = 0
  const classIds = new Set()

  // 记录每个班在**本次文件**里出现的格子。
  // 导入是 upsert：只补/改，不会删。所以必须显式算出「旧表里有、新文件里没有」的格子
  // 并删掉，否则用户删掉一节课再传同一份文件，那节课会永远留着。
  // （不修这个，「重新上传更新后的课表」就只是摆设）
  const seenKeys = {}

  plans.forEach(({ klass, e }) => {
    const teacher = teacherByName[e.teacherName]
    if (e.teacherName && !teacher) missing[e.teacherName] = true

    const payload = {
      class_id: klass.id,
      school_id: sid,
      weekday: e.weekday,
      period_no: e.period,
      subject: e.subject,
      teacher_id: teacher ? teacher.id : null,
      is_active: true,
    }
    const key = scheduleKey(klass.id, e.weekday, e.period)
    if (!seenKeys[klass.id]) seenKeys[klass.id] = {}
    seenKeys[klass.id][key] = true
    const hit = index[key]
    if (hit) {
      // 内容没变就跳过 update，重复导入同一份文件时几乎零请求
      if (!rowEquals(hit, payload, ['subject', 'teacher_id', 'is_active'])) {
        updateTasks.push(() => update('schedules', { id: hit.id }, payload))
      }
    } else {
      writer.push(payload, row => {
        index[key] = row
      })
    }
    imported++
    classIds.add(klass.id)
  })

  await Promise.all([writer.flush(), runWithLimit(updateTasks)])

  // 删掉本次涉及的班里、新文件里已经不存在的格子
  let removed = 0
  for (const cid of classIds) {
    const keep = seenKeys[cid] || {}
    const stale = existing.filter(
      row => Number(row.class_id) === Number(cid) && !keep[scheduleKey(row.class_id, row.weekday, row.period_no)]
    )
    for (let i = 0; i < stale.length; i++) {
      try {
        await remove('schedules', { id: stale[i].id })
        removed++
      } catch (e) {
        errors.push(`清理旧课程失败（${stale[i].class_id} 周${stale[i].weekday}第${stale[i].period_no}节）`)
      }
    }
  }

  const classCount = classIds.size
  const missingNames = Object.keys(missing)
  if (missingNames.length) errors.push('未匹配到教师（课表已导入，认课需重新导入）：' + missingNames.join('、'))

  let message = `成功导入 ${classCount} 个班级共 ${imported} 条课程`
  if (removed) message += `，清理了 ${removed} 条旧课程`
  if (classCount === 0) message = '没有解析到课表数据，请确认文件是矩阵结构的课表模版'
  return { imported, classCount, removed, errors, message: message }
}

/**
 * 导入教师课表（模版：教师课表模版.xls）。
 * 每个 sheet 代表一位教师（sheet 名 = 教师姓名），第 2 行每格是班级名。
 * 与班级课表互为补充：两边都导入，任课关系最完整。
 */
async function importTeacherSchedules(schoolId, sheets) {
  if (!sheets || !sheets.length) return { imported: 0, message: '没有解析到有效数据' }
  const sid = await requireSchoolId(schoolId)
  if (!sid) return { imported: 0, message: '请先选择学校' }

  const teacherByName = {}
  ;(await listTeachers(sid)).forEach(t => {
    if (!teacherByName[t.name]) teacherByName[t.name] = t
  })
  const classByName = {}
  ;(await listClasses(sid)).forEach(c => {
    classByName[normalizeClassName(c.name)] = c
  })

  const errors = []
  const missing = {}
  let teacherCount = 0

  // 第一步：解析并定位教师与班级
  const plans = []
  for (const sheet of sheets) {
    const entries = parseMatrixSheet(sheet, 'teacher')
    if (!entries.length) continue

    const teacherName = sheetTitle(sheet)
    const teacher = teacherByName[teacherName]
    if (!teacher) {
      missing[teacherName] = true
      errors.push(`未找到教师「${teacherName}」，请先导入教师账号后再导入教师课表`)
      continue
    }
    teacherCount++

    for (const e of entries) {
      if (!e.className) continue
      plans.push({ teacher, e })
    }
  }

  // 涉及的班级一次性补齐（教师课表里可能出现班级课表没有的班级）
  for (const { e } of plans) {
    await ensureClass(sid, e.className, classByName)
  }

  // 第二步：一次拉取全校课表，内存比对
  const existing = await findAll('schedules', { school_id: sid })
  const index = {}
  existing.forEach(row => {
    index[scheduleKey(row.class_id, row.weekday, row.period_no)] = row
  })

  const writer = createBatchWriter('schedules')
  const updateTasks = []
  let imported = 0

  plans.forEach(({ teacher, e }) => {
    const klass = classByName[normalizeClassName(e.className)]
    if (!klass) return

    const payload = {
      class_id: klass.id,
      school_id: sid,
      weekday: e.weekday,
      period_no: e.period,
      subject: e.subject,
      teacher_id: teacher.id,
      is_active: true,
    }
    const key = scheduleKey(klass.id, e.weekday, e.period)
    const hit = index[key]
    if (hit) {
      if (!rowEquals(hit, payload, ['subject', 'teacher_id', 'is_active'])) {
        updateTasks.push(() => update('schedules', { id: hit.id }, payload))
      }
    } else {
      writer.push(payload, row => {
        index[key] = row
      })
    }
    imported++
  })

  await Promise.all([writer.flush(), runWithLimit(updateTasks)])

  let message = `成功导入 ${teacherCount} 位教师共 ${imported} 条课程`
  if (teacherCount === 0) message = '没有解析到教师课表，请确认每个工作表名是教师姓名'
  return { imported, teacherCount, errors, message: message }
}

/** 兼容旧调用：课表导入默认按班级课表处理 */
async function importSchedules(schoolId, sheets) {
  return importClassSchedules(schoolId, sheets)
}

/** 兼容旧的行式课表导入（保留给粘贴文本用） */
async function importClassSchedule(classId, text) {
  const rows = parseTable(text)
  if (!rows.length) return { imported: 0, skipped: 0, message: '没有解析到有效数据' }

  const klass = await findOne('classes', { id: classId })
  const teachers = await listTeachers(klass ? klass.school_id : undefined)
  const teacherByName = {}
  teachers.forEach(t => {
    teacherByName[t.name] = t
  })

  let imported = 0
  let skipped = 0
  const errors = []

  for (const row of rows) {
    const weekdayText = pick(row, ['星期', '周次', 'weekday', '星期几'])
    const periodText = pick(row, ['节次', '第几节', 'period', '课次'])
    const subject = pick(row, ['科目', '课程', 'subject', '课程名称'])
    const teacherName = pick(row, ['教师', '教师姓名', '任课教师', 'teacher', '老师'])

    if (!periodText || !subject) {
      skipped++
      continue
    }

    const weekday = parseWeekday(weekdayText)
    const periodNo = parseInt(String(periodText).replace(/[^0-9]/g, ''), 10)
    if (!weekday || !periodNo) {
      skipped++
      errors.push('星期或节次格式无法识别：' + JSON.stringify(row))
      continue
    }

    const teacher = teacherByName[teacherName]
    const existing = await findOne('schedules', { class_id: classId, weekday, period_no: periodNo })
    const payload = {
      class_id: classId,
      school_id: klass ? klass.school_id : null,
      weekday,
      period_no: periodNo,
      subject,
      teacher_id: teacher ? teacher.id : null,
      is_active: true,
    }
    if (existing) {
      await update('schedules', { id: existing.id }, payload)
    } else {
      await insert('schedules', payload)
    }
    imported++
  }

  return { imported, skipped, errors, message: '成功导入 ' + imported + ' 条' + (skipped ? '，跳过 ' + skipped + ' 条' : '') }
}

/* ===================== 导入：学生 ===================== */

/**
 * 导入学生名单。
 * 模版：每个工作表一个班级，表头 学校 / 班级 / 姓名 / 学号。
 * 「班级」列缺失时回落到工作表名；都拿不到则用 targetClassId。
 */
async function importStudents(schoolId, targetClassId, sheets) {
  if (!sheets || !sheets.length) return { imported: 0, message: '没有解析到有效数据' }

  // 多工作表：逐表解析，班级优先取表内「班级」列，其次取工作表名
  const records = []
  for (const sheet of sheets) {
    const list = rowsToRecords(sheet.rows, [
      COL_SCHOOL,
      COL_CLASS,
      { key: 'name', candidates: ['姓名', '学生姓名', 'name'] },
      { key: 'studentNo', candidates: ['学号', '考号', 'student_no', '编号'] },
    ])
    list.forEach(rec => {
      if (!rec.className) rec.className = normalizeClassName(sheet.name)
      records.push(rec)
    })
  }
  if (!records.length) return { imported: 0, message: '没有解析到有效数据' }

  // 学校：显式指定 > 记录里的「学校」列自动匹配
  let sid = await requireSchoolId(schoolId)
  if (!sid) {
    const schoolName = records.map(r => r.school).filter(Boolean)[0]
    const found = schoolName ? await findSchoolByName(schoolName) : null
    if (found) sid = found.id
  }
  if (!sid && !targetClassId) return { imported: 0, message: '请先选择学校' }

  const classByName = {}
  if (sid) {
    ;(await listClasses(sid)).forEach(c => {
      classByName[normalizeClassName(c.name)] = c
    })
  }

  let imported = 0
  let skipped = 0
  const errors = []
  const touched = new Set()

  // 第一步：先把所有记录定位到具体班级（班级数量少，可逐个确保存在）
  let fallbackClass = null
  const located = []
  for (const rec of records) {
    if (!rec.name || !rec.studentNo) {
      skipped++
      continue
    }
    let klass = sid ? await ensureClass(sid, rec.className, classByName) : null
    if (!klass && targetClassId) {
      if (!fallbackClass) fallbackClass = await findOne('classes', { id: targetClassId })
      klass = fallbackClass
    }
    if (!klass) {
      skipped++
      errors.push(`${rec.name}：未找到或未指定班级`)
      continue
    }
    located.push({ rec, klass })
  }

  // 第二步：一次拉取全校学生，内存比对（学号在同一班级内唯一）
  const existing = sid ? await findAll('students', { school_id: sid }) : []
  const index = {}
  existing.forEach(row => {
    index[row.class_id + '|' + row.student_no] = row
  })

  const writer = createBatchWriter('students')
  const updateTasks = []

  located.forEach(({ rec, klass }) => {
    const key = klass.id + '|' + rec.studentNo
    const hit = index[key]
    const payload = { name: rec.name, school_id: sid }
    if (hit) {
      if (!rowEquals(hit, payload, ['name', 'school_id'])) {
        updateTasks.push(() => update('students', { id: hit.id }, payload))
      }
    } else {
      const row = {
        student_no: rec.studentNo,
        name: rec.name,
        class_id: klass.id,
        school_id: sid,
      }
      writer.push(row, inserted => {
        index[key] = inserted
      })
    }
    imported++
    touched.add(klass.name)
  })

  await Promise.all([writer.flush(), runWithLimit(updateTasks)])

  return {
    imported,
    skipped,
    classNames: Array.from(touched),
    errors,
    message: `成功导入 ${imported} 名学生` + (skipped ? `，跳过 ${skipped} 条` : ''),
  }
}

/* ===================== 导入：教师 ===================== */

/**
 * 导入教师账号。模版表头：学校 / 教师姓名 / 组别 / 账号 / 密码
 * 账号在 Excel 里是数字型（13500000001.0），统一转字符串。
 */
async function importTeachers(schoolId, sheets, hashPassword) {
  const first = sheets && sheets[0]
  if (!first || !first.rows) return { imported: 0, message: '没有解析到有效数据' }
  const records = rowsToRecords(first.rows, [
    COL_SCHOOL,
    { key: 'name', candidates: ['教师姓名', '姓名', 'name', '老师姓名'] },
    { key: 'group', candidates: ['组别', '学科组', '教研组', 'group'] },
    { key: 'account', candidates: ['账号', '登录账号', '工号', 'account', '用户名'] },
    { key: 'password', candidates: ['密码', 'password', '初始密码'] },
  ])
  if (!records.length) return { imported: 0, message: '没有解析到有效数据' }

  const sid = await requireSchoolId(schoolId || (records[0] && records[0].school))
  if (!sid) return { imported: 0, message: '请先选择学校' }

  const existing = await listTeachers(sid)
  const byAccount = {}
  existing.forEach(t => {
    byAccount[t.account] = t
  })

  let imported = 0
  let skipped = 0
  const errors = []

  const writer = createBatchWriter('teachers')
  const updateTasks = []

  records.forEach(rec => {
    if (!rec.account || !rec.name) {
      skipped++
      return
    }
    const existing = byAccount[rec.account]
    const payload = {
      account: rec.account,
      name: rec.name,
      subject_group: rec.group || '未分组',
      status: '在位中',
      role: 'teacher',
      school_id: sid,
      password_hash: hashPassword(rec.password || '123456'),
    }
    if (existing) {
      // 已存在的账号保留其管理员角色，避免导入教师名单把管理员降级
      if (existing.role === 'admin' || existing.role === 'super' || existing.is_admin) {
        payload.role = existing.role === 'super' ? 'super' : 'admin'
        payload.is_admin = true
      }
      updateTasks.push(() => update('teachers', { id: existing.id }, payload))
    } else {
      writer.push(payload, row => {
        byAccount[rec.account] = row
      })
    }
    imported++
  })

  await Promise.all([writer.flush(), runWithLimit(updateTasks)])

  return {
    imported,
    skipped,
    errors,
    message: `成功导入 ${imported} 名教师` + (skipped ? `，跳过 ${skipped} 条` : ''),
  }
}

/* ===================== 导入：班级账号 ===================== */

/**
 * 导入班级账号密码。模版表头：学校 / 班级 / 账号 / 密码 / 班主任账号
 * - 班级不存在时自动创建
 * - 「班主任账号」是该班班主任的教师账号，填了就反查教师写入 head_teacher_id，
 *   班主任就能收到本班的换课通知与学生状态提醒。
 */
async function importClassAccounts(schoolId, sheets, hashPassword) {
  if (!sheets || !sheets.length) return { imported: 0, message: '没有解析到有效数据' }

  // 逐表解析，只保留有数据的表（模版里常有 Sheet2/Sheet3 空白页）
  const records = []
  for (const sheet of sheets) {
    rowsToRecords(sheet.rows, [
      COL_SCHOOL,
      COL_CLASS,
      { key: 'account', candidates: ['账号', '登录账号', 'account', '用户名'] },
      { key: 'password', candidates: ['密码', 'password', '初始密码'] },
      { key: 'headTeacherAccount', candidates: ['班主任账号', '班主任', '班主任登录账号', 'head_teacher'] },
    ]).forEach(rec => {
      if (!rec.className) rec.className = normalizeClassName(sheet.name)
      records.push(rec)
    })
  }
  if (!records.length) return { imported: 0, message: '没有解析到有效数据' }

  let sid = await requireSchoolId(schoolId)
  if (!sid) {
    const schoolName = records.map(r => r.school).filter(Boolean)[0]
    const found = schoolName ? await findSchoolByName(schoolName) : null
    if (found) sid = found.id
  }
  if (!sid) return { imported: 0, message: '请先选择学校' }

  const classByName = {}
  ;(await listClasses(sid)).forEach(c => {
    classByName[normalizeClassName(c.name)] = c
  })

  const teacherByAccount = {}
  ;(await listTeachers(sid)).forEach(t => {
    if (t.account) teacherByAccount[t.account] = t
  })

  let imported = 0
  let skipped = 0
  let headTeacherLinked = 0
  const errors = []
  const missingHeads = {}

  // 班级数量有限，但新增班级统一批量插入更快
  const writer = createBatchWriter('classes')
  const updateTasks = []

  records.forEach(rec => {
    if (!rec.className || !rec.account) {
      skipped++
      return
    }

    const headTeacher = rec.headTeacherAccount ? teacherByAccount[rec.headTeacherAccount] : null
    if (rec.headTeacherAccount && !headTeacher) missingHeads[rec.headTeacherAccount] = true

    const payload = {
      name: normalizeClassName(rec.className),
      school_id: sid,
      account: rec.account,
      password_hash: hashPassword(rec.password || '123456'),
      head_teacher_id: headTeacher ? headTeacher.id : null,
    }

    const klass = classByName[normalizeClassName(rec.className)]
    if (klass) {
      // 班主任留空时不要覆盖已有绑定
      if (!headTeacher) delete payload.head_teacher_id
      updateTasks.push(() => update('classes', { id: klass.id }, payload))
    } else {
      writer.push(payload, created => {
        classByName[normalizeClassName(rec.className)] = created
      })
    }
    if (headTeacher) headTeacherLinked++
    imported++
  })

  await Promise.all([writer.flush(), runWithLimit(updateTasks)])

  const missingList = Object.keys(missingHeads)
  if (missingList.length) {
    errors.push('未找到的班主任账号（请先导入教师账号）：' + missingList.join('、'))
  }

  let message = `成功导入 ${imported} 个班级账号` + (skipped ? `，跳过 ${skipped} 条` : '')
  if (headTeacherLinked) message += `，绑定班主任 ${headTeacherLinked} 人`
  return { imported, skipped, headTeacherLinked, errors, message: message }
}

/* ===================== 导入：学校与学校管理员（仅超级管理员） ===================== */

const COL_SCHOOL_ADMIN = [
  { key: 'school', candidates: ['学校', '学校名称', 'school'] },
  { key: 'adminName', candidates: ['管理员', '管理员姓名', '姓名', '教师姓名', 'name'] },
  { key: 'account', candidates: ['账号', '登录账号', '工号', 'account', '用户名'] },
  { key: 'password', candidates: ['密码', 'password', '初始密码'] },
]

/** 只导入学校，不建管理员 */
async function importSchools(sheets, manual) {
  let records = []
  if (manual && manual.name) {
    records = [{ name: manual.name, code: manual.code || '', remark: manual.remark || '' }]
  } else if (sheets && sheets[0] && sheets[0].rows) {
    records = rowsToRecords(sheets[0].rows, [
      { key: 'name', candidates: ['学校', '学校名称', 'name'] },
      { key: 'code', candidates: ['编码', '代码', 'code'] },
      { key: 'remark', candidates: ['备注', 'remark'] },
    ])
  }
  if (!records.length) return { imported: 0, message: '没有解析到有效数据' }

  let imported = 0
  let skipped = 0
  for (const rec of records) {
    if (!rec.name) {
      skipped++
      continue
    }
    const exist = await findSchoolByName(rec.name)
    if (exist) {
      await update('schools', { id: exist.id }, { code: rec.code || exist.code || '', is_active: true })
    } else {
      await insert('schools', { name: rec.name, code: rec.code || '', remark: rec.remark || '', is_active: true })
    }
    imported++
  }
  return { imported, skipped, message: `成功导入 ${imported} 所学校` + (skipped ? `，跳过 ${skipped} 条` : '') }
}

/**
 * 导入学校 + 学校管理员（模版：学校 / 管理员 / 账号 / 密码）。
 *
 * 这是超级管理员的主入口：一条记录同时完成
 *   1. 不存在则创建 schools 行；
 *   2. 在 teachers 中创建该管理员账号（role='admin'），已存在则更新密码与角色。
 * 管理员记录归属到新建的 school，因此登录后即拥有该校全部配置权限。
 */
async function importSchoolsWithAdmins(sheets, hashPassword) {
  const first = sheets && sheets[0]
  if (!first || !first.rows) return { imported: 0, message: '没有解析到有效数据' }
  const records = rowsToRecords(first.rows, COL_SCHOOL_ADMIN)
  if (!records.length) return { imported: 0, message: '没有解析到有效数据' }

  let schoolCount = 0
  let adminCount = 0
  let skipped = 0
  const errors = []
  const createdSchools = []
  const adminAccounts = []

  // 同一份文件里可能有多个学校，先把学校全部建好，再挂管理员
  const schoolCache = {}
  for (const rec of records) {
    if (!rec.school) {
      skipped++
      continue
    }
    if (schoolCache[rec.school]) continue
    const exist = await findSchoolByName(rec.school)
    if (exist) {
      schoolCache[rec.school] = exist
    } else {
      const created = await insert('schools', { name: rec.school, is_active: true })
      schoolCache[rec.school] = created
      createdSchools.push(rec.school)
    }
    schoolCount++
  }

  // 再建管理员账号
  const doneAdmins = {}
  for (const rec of records) {
    if (!rec.school || !rec.account || !rec.adminName) {
      if (rec.account && !rec.adminName) errors.push(`账号 ${rec.account}：缺少管理员姓名`)
      continue
    }
    // 同一账号在文件里重复出现时只处理一次，避免重复计数
    const dedupKey = rec.school + '::' + rec.account
    if (doneAdmins[dedupKey]) continue
    doneAdmins[dedupKey] = true

    const school = schoolCache[rec.school]
    if (!school) {
      errors.push(`${rec.school}：学校创建失败`)
      continue
    }

    const exist = await findOne('teachers', { account: rec.account })
    const payload = {
      account: rec.account,
      name: rec.adminName,
      school_id: school.id,
      role: 'admin',
      is_admin: true,
      status: '在位中',
      subject_group: '信息组',
      password_hash: hashPassword(rec.password || '123456'),
    }
    if (exist) {
      // 已存在的账号不改归属，避免误改其他学校的人
      if (Number(exist.school_id) !== Number(school.id)) {
        errors.push(`账号 ${rec.account} 已存在于其他学校，未改动`)
        continue
      }
      await update('teachers', { id: exist.id }, payload)
    } else {
      await insert('teachers', payload)
    }
    adminCount++
    if (adminAccounts.indexOf(rec.account) < 0) adminAccounts.push(rec.account)
  }

  let message = `成功导入 ${schoolCount} 所学校、${adminCount} 个学校管理员`
  if (createdSchools.length) message += `（新建：${createdSchools.join('、')}）`
  if (skipped) message += `，跳过 ${skipped} 条`
  return { imported: adminCount, schoolCount, adminCount, createdSchools, adminAccounts, errors, message }
}

/**
 * 列出某学校的学校管理员（超级管理员在「学校配置」里查看）。
 * 返回 [{ id, name, account, subject_group, status, schoolId, schoolName }]
 */
async function listSchoolAdmins(schoolId) {
  const filters = {}
  if (schoolId) filters.school_id = schoolId
  const rows = await findAll('teachers', filters, { column: 'id', ascending: true })
  return rows
    .filter(t => t.role === 'admin' || t.is_admin)
    .map(t => ({
      id: t.id,
      name: t.name,
      account: t.account,
      subject_group: t.subject_group || '',
      status: t.status || '在位中',
      schoolId: t.school_id,
      schoolName: '',
    }))
}

/**
 * 列出全部学校并附带该校的学校管理员（超级管理员总览用）。
 * 一次查询完成，学校列表与管理员数量不会不一致。
 */
async function listSchoolsWithAdmins() {
  const schools = await listSchools()
  const admins = await listSchoolAdmins()
  const bySchool = {}
  admins.forEach(a => {
    const key = a.schoolId == null ? 'none' : String(a.schoolId)
    if (!bySchool[key]) bySchool[key] = []
    bySchool[key].push(a)
  })
  return schools.map(s => ({
    id: s.id,
    name: s.name,
    code: s.code || '',
    remark: s.remark || '',
    is_active: s.is_active !== false,
    admins: (bySchool[String(s.id)] || []).map(a => ({
      id: a.id,
      name: a.name,
      account: a.account,
      subject_group: a.subject_group,
      status: a.status,
    })),
  }))
}

/** 导入学校管理员：把指定教师账号提升为该校管理员 */
async function importSchoolAdmins(schoolId, accounts, hashPassword) {
  const sid = await requireSchoolId(schoolId)
  if (!sid) return { imported: 0, message: '请先选择学校' }
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : []
  if (!list.length) return { imported: 0, message: '请填写管理员账号' }

  const teachers = await listTeachers(sid)
  const byAccount = {}
  teachers.forEach(t => {
    byAccount[t.account] = t
  })

  let imported = 0
  for (const acc of list) {
    const t = byAccount[acc]
    if (!t) continue
    await update('teachers', { id: t.id }, { role: 'admin', is_admin: true })
    imported++
  }
  return { imported, message: `已将 ${imported} 个账号设为学校管理员` }
}

module.exports = {
  DEFAULT_PERIODS,
  DEFAULT_STUDENT_STATUS,
  loadPeriods,
  savePeriods,
  loadStudentStatusOptions,
  saveStudentStatusOptions,
  currentPeriod,
  minutesToNextPeriod,
  toMinutes,
  // 学校与权限
  currentSchoolId,
  isSuperAdmin,
  isSchoolAdmin,
  requireSchoolId,
  listSchools,
  findSchoolByName,
  ensureSchool,
  // 基础查询
  listClasses,
  listTeachers,
  listStudents,
  listSchedules,
  classNameMap,
  // 调休
  listMakeupDays,
  invalidateMakeupCache,
  resolveDay,
  saveMakeupDay,
  removeMakeupDay,
  // 课表
  getScheduleForDay,
  getTeacherDaySchedule,
  teacherClasses,
  buildSwapOverlay,
  scheduleCellKey,
  teacherNameMap,
  // 学生状态
  getStudentStatusOfDay,
  summarizeStudentStatus,
  setStudentStatus,
  clearStudentStatus,
  // 站内信与换课
  pushNotice,
  listNotices,
  markNoticeRead,
  createSwapRequest,
  updateSwapRequest,
  listSwapRequests,
  describeSwap,
  notifySwap,
  buildSwapCandidates,
  checkSwapConflict,
  teacherBusyAtSlot,
  // 导入
  cell,
  rowsToRecords,
  normalizeClassName,
  parseMatrixSheet,
  parseTimeRange,
  importClassSchedules,
  importTeacherSchedules,
  importSchedules,
  importClassSchedule,
  importStudents,
  importTeachers,
  importClassAccounts,
  importSchools,
  importSchoolsWithAdmins,
  importSchoolAdmins,
  listSchoolAdmins,
  listSchoolsWithAdmins,
  parseWeekday,
}
