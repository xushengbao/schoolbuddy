/**
 * 用 F:/学校/提示词/schoolbuddy 下的六个新模版做端到端校验。
 * 校验内容：
 *   1. 三种格式（.xls / .xlsx / .csv）都能读出 [{name,rows}]
 *   2. 班级课表：sheet 名与 A1 归一化后能得到正确班级名，条目数正确
 *   3. 教师课表：sheet 名 = 教师姓名，第二行每格是班级名
 *   4. 学生模版：多 sheet，每个 sheet 45 行
 *   5. 班级账号模版：能读到 班主任账号 列
 *   6. 学校模版：能读到 组别 列
 *   7. CSV 模版（templates/）能正常导入
 */
const fs = require('fs')
const path = require('path')

// school.js -> db.js -> cloud.js 会在模块加载时访问 wx，这里给最小 stub，
// 便于在 Node 下直接跑纯解析逻辑（不触达云服务）
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' }, appId: 'wxstub' }),
  getSystemInfoSync: () => ({
    SDKVersion: '3.0.0',
    platform: 'devtools',
    system: 'stub 22.2.2',
    model: 'stub',
    environment: 'stub',
  }),
  getSystemInfo: () => ({}),
  onError: () => {},
  onUnhandledRejection: () => {},
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  getStorage: opts => opts && opts.fail && opts.fail({}),
  cloud: {
    init: () => ({}),
    database: {},
  },
}

const excel = require('../utils/excel')
const school = require('../utils/school')

// 模版路径相对仓库根目录的 templates/，避免依赖固定盘符（原 hardcode F:/学校/提示词/schoolbuddy/）
const DIR = path.join(__dirname, '..', 'templates') + path.sep
const TPL = DIR

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
function readBuf(f) {
  return new Uint8Array(fs.readFileSync(f)).buffer
}
function toBuf(text) {
  return new Uint8Array(Buffer.from(text, 'utf8')).buffer
}

console.log('\n[1] 班级课表模版.xls（矩阵式，A1=班级名、第二行=教师姓名）')
const classSheets = excel.parse(readBuf(DIR + '班级课表模版.xls'))
check('4 个工作表', classSheets.length === 4, '实际 ' + classSheets.length)
check('每表 13 行', classSheets.every(s => s.rows.length === 13))
check('工作表名为班级', classSheets.map(s => s.name).join(',') === 'B五1,B五3,B五5,B六8', classSheets.map(s => s.name).join(','))
const clsEntries = school.parseMatrixSheet(classSheets[0], 'class')
check('B五1 解析出 30 条课程', clsEntries.length === 30, '实际 ' + clsEntries.length)
check('B五1 第1节周一 = 语文/周老师',
  clsEntries[0].subject === '语文' && clsEntries[0].teacherName === '周老师' && clsEntries[0].period === 1 && clsEntries[0].weekday === 1,
  JSON.stringify(clsEntries[0]))
check('归一化：标题「B五1班」→ B五1', school.normalizeClassName(school.sheetTitle ? school.sheetTitle(classSheets[0]) : 'B五1班') === 'B五1')
check('归一化：教师课表里的「B四7」原样保留', school.normalizeClassName('B四7') === 'B四7')

console.log('\n[2] 教师课表模版.xls（sheet 名=教师，第二行=班级）')
const tSheets = excel.parse(readBuf(DIR + '教师课表模版.xls'))
check('工作表名为教师姓名', tSheets[0].name === '许老师', tSheets[0].name)
const tEntries = school.parseMatrixSheet(tSheets[0], 'teacher')
// 模版里许老师只排了第2~6节，其中第2节仅 2 门、第3节 3 门，合计 17
check('许老师 解析出 17 条课程', tEntries.length === 17, '实际 ' + tEntries.length)
check('teacher 模式不产出 teacherName', tEntries.every(e => !e.teacherName))
check('teacher 模式产出 className', tEntries.some(e => e.className === 'B五1'), JSON.stringify(tEntries.filter(e=>e.className==='B五1')[0]))
check('许老师 第4节周四 = 信息科技/B六8',
  tEntries.some(e => e.weekday === 4 && e.period === 4 && e.subject === '信息科技' && e.className === 'B六8'))
check('空格子不产生条目（第一节全空）', !tEntries.some(e => e.period === 1))

console.log('\n[3] 学生模版.xls（多 sheet）')
const sSheets = excel.parse(readBuf(DIR + '学生模版.xls'))
check('3 个班级表', sSheets.length === 3, sSheets.map(s => s.name).join(','))
check('每表 45 行', sSheets.every(s => s.rows.length === 45))
check('表头 学校/班级/姓名/学号', sSheets[0].rows[0].join(',') === '学校,班级,姓名,学号', sSheets[0].rows[0].join(','))
check('多表都能提取记录', school.rowsToRecords(sSheets[0].rows, [
  { key: 'school', candidates: ['学校'] },
  { key: 'className', candidates: ['班级'] },
  { key: 'name', candidates: ['姓名'] },
  { key: 'studentNo', candidates: ['学号'] },
]).length === 44)

console.log('\n[4] 班级账号和密码模版.xls（新列顺序 + 班主任账号列）')
const aSheets = excel.parse(readBuf(DIR + '班级账号和密码模版.xls'))
check('表头 账号/学校/班级/密码/班主任账号',
  aSheets[0].rows[0].join(',') === '账号,学校,班级,密码,班主任账号', aSheets[0].rows[0].join(','))
const aRecs = school.rowsToRecords(aSheets[0].rows, [
  { key: 'className', candidates: ['班级'] },
  { key: 'account', candidates: ['账号'] },
  { key: 'password', candidates: ['密码'] },
  { key: 'headTeacherAccount', candidates: ['班主任账号'] },
])
check('15 条班级记录', aRecs.length === 15, '实际 ' + aRecs.length)
check('首条班主任账号 = 13665136408', aRecs[0].headTeacherAccount === '13665136408', JSON.stringify(aRecs[0]))
check('数字型账号转字符串', aRecs[0].account === 'B93C22B1', JSON.stringify(aRecs[0]))
check('列顺序变化不影响字段识别（账号在前）',
  aRecs[0].account === 'B93C22B1' && aRecs[0].className === 'B五1' && aRecs[0].password === 'schoolbuddy',
  JSON.stringify(aRecs[0]))
check('数字型班主任账号转字符串', aRecs[1].headTeacherAccount === '13500000003', JSON.stringify(aRecs[1]))
check('15 个班都填了班主任账号', aRecs.every(r => !!r.headTeacherAccount),
  aRecs.filter(r => !r.headTeacherAccount).map(r => r.className).join(',') || '全部有值')

console.log('\n[5] 教师账号模版.xls / 学校模版.xls')
const teSheets = excel.parse(readBuf(DIR + '教师账号模版.xls'))
const teRecs = school.rowsToRecords(teSheets[0].rows, [
  { key: 'name', candidates: ['教师姓名'] },
  { key: 'account', candidates: ['账号'] },
])
check('11 名教师', teRecs.length === 11, '实际 ' + teRecs.length)
check('数字型账号 17600662106 完整保留', teRecs[0].account === '17600662106', JSON.stringify(teRecs[0].account))
const scSheets = excel.parse(readBuf(DIR + '学校模版.xls'))
check('学校模版表头含组别', scSheets[0].rows[0].join(',') === '学校,管理员,组别,账号,密码', scSheets[0].rows[0].join(','))
check('学校模版能建 1 校 1 管理员', school.rowsToRecords(scSheets[0].rows, [
  { key: 'school', candidates: ['学校'] },
  { key: 'adminName', candidates: ['管理员'] },
  { key: 'account', candidates: ['账号'] },
  { key: 'password', candidates: ['密码'] },
]).length === 1)

console.log('\n[6] templates/ 下的 CSV 模版（UTF-8 BOM）')
const csvFiles = ['学校模版.csv', '学生模版.csv', '教师账号模版.csv', '班级账号和密码模版.csv']
csvFiles.forEach(f => {
  const sheets = excel.parse(toBuf(fs.readFileSync(TPL + f, 'utf8')))
  check(f + ' 可解析', sheets.length === 1 && sheets[0].rows.length >= 2,
    '行数 ' + (sheets[0] ? sheets[0].rows.length : 0))
  if (sheets[0]) console.log('      表头: ' + sheets[0].rows[0].join(' | '))
})

console.log('\n[7] 边界：非法输入不应崩溃')
let threw = false
try { excel.parse(readBuf(DIR + 'schoolbuddy.docx')) } catch (e) { threw = true }
check('docx 报错而非崩溃', threw)
check('空 buffer 不崩', excel.textToSheets('').length === 0)

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n')
process.exit(fail ? 1 : 0)
