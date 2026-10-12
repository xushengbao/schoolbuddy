const { cloud } = require('./cloud')
const { hashPassword, toast } = require('./util')

const SESSION_KEY = 'sb_session'

let current = null

/** 读取本地会话（教师 / 学校管理员 / 超级管理员 / 班级） */
function getSession() {
  if (current) return current
  const stored = wx.getStorageSync(SESSION_KEY)
  if (stored && stored.role) current = stored
  return current
}

function setSession(session) {
  current = session
  wx.setStorageSync(SESSION_KEY, session)
}

function clearSession() {
  current = null
  wx.removeStorageSync(SESSION_KEY)
}

/** 超级管理员：平台级，可管理所有学校 */
function isSuper() {
  const s = getSession()
  return !!(s && s.role === 'super')
}

/** 学校管理员：可管理本校配置数据 */
function isSchoolAdmin() {
  const s = getSession()
  return !!(s && s.role === 'admin')
}

/** 任一种管理员（含超级管理员） */
function isAdmin() {
  const s = getSession()
  return !!(s && (s.role === 'admin' || s.role === 'super'))
}

/**
 * 能否导入学校数据（学生 / 班级 / 课表 / 教师 / 班级账号）。
 * 学校管理员是数据导入的主体角色；普通教师与班级账号一律不可。
 */
function canImportSchoolData() {
  const s = getSession()
  return !!(s && (s.role === 'admin' || s.role === 'super'))
}

/** 能否配置学校本身（仅超级管理员） */
function canManageSchools() {
  const s = getSession()
  return !!(s && s.role === 'super')
}

function isTeacher() {
  const s = getSession()
  return !!(s && (s.role === 'teacher' || s.role === 'admin' || s.role === 'super'))
}

/** 当前会话所属学校 ID；超级管理员为 null（不限学校） */
function sessionSchoolId() {
  const s = getSession()
  if (!s || s.role === 'super') return null
  return s.schoolId === undefined ? null : s.schoolId
}

function sessionSchoolName() {
  const s = getSession()
  return s && s.schoolName ? s.schoolName : ''
}

/** 依据 teachers.role 推导会话角色 */
function roleOf(teacher) {
  if (teacher.role === 'super') return 'super'
  if (teacher.role === 'admin' || teacher.is_admin) return 'admin'
  return 'teacher'
}

/** 补齐会话里的学校名称，登录后展示用 */
async function attachSchoolName(session) {
  if (!session) return session
  if (session.role === 'super') {
    session.schoolName = '平台超级管理员'
    return session
  }
  if (!session.schoolId) {
    session.schoolName = ''
    return session
  }
  try {
    const res = await cloud.database.from('schools').select('*').eq('id', session.schoolId).limit(1)
    const row = res.data && res.data.length ? res.data[0] : null
    session.schoolName = row ? row.name : ''
    if (row) {
      session.school = row
      setSession(session)
    }
  } catch (e) {
    session.schoolName = ''
  }
  return session
}

/** 账号登录：教师表与班级表都支持，密码散列后比对 */
async function loginWithPassword(account, password) {
  const acc = String(account || '').trim()
  if (!acc || !password) {
    toast('请输入账号和密码')
    return null
  }
  const hash = hashPassword(password)

  const { data, error } = await cloud.database
    .from('teachers')
    .select('*')
    .eq('account', acc)
    .limit(1)

  if (error) {
    toast('网络异常，请稍后重试')
    return null
  }

  const teacher = data && data.length ? data[0] : null
  if (teacher) {
    if (teacher.password_hash !== hash) {
      toast('密码不正确')
      return null
    }
    const session = {
      role: roleOf(teacher),
      isAdmin: teacher.role === 'admin' || teacher.role === 'super' || !!teacher.is_admin,
      teacherId: teacher.id,
      schoolId: teacher.school_id === undefined ? null : teacher.school_id,
      schoolName: '',
      account: teacher.account,
      name: teacher.name,
      subjectGroup: teacher.subject_group || '',
    }
    await attachSchoolName(session)
    setSession(session)
    return session
  }

  const classRes = await cloud.database.from('classes').select('*').eq('account', acc).limit(1)
  if (classRes.error) {
    toast('网络异常，请稍后重试')
    return null
  }
  const klass = classRes.data && classRes.data.length ? classRes.data[0] : null
  if (klass) {
    if (klass.password_hash !== hash) {
      toast('密码不正确')
      return null
    }
    const session = {
      role: 'class',
      isAdmin: false,
      classId: klass.id,
      schoolId: klass.school_id === undefined ? null : klass.school_id,
      schoolName: '',
      account: klass.account,
      name: klass.name,
      subjectGroup: '',
    }
    await attachSchoolName(session)
    setSession(session)
    return session
  }

  toast('账号不存在')
  return null
}

function logout() {
  clearSession()
}

module.exports = {
  SESSION_KEY,
  getSession,
  setSession,
  clearSession,
  isSuper,
  isSchoolAdmin,
  isAdmin,
  canImportSchoolData,
  canManageSchools,
  isTeacher,
  sessionSchoolId,
  sessionSchoolName,
  attachSchoolName,
  roleOf,
  loginWithPassword,
  logout,
}