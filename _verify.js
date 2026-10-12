// 全量静态校验：语法 / 事件处理函数 / 跨模块导入 / exports 匹配 / 页面注册
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = process.cwd()
let fail = 0
const problems = []

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const all = walk(ROOT)
const jsFiles = all.filter(f => f.endsWith('.js') && !path.basename(f).startsWith('_'))

// 1) 语法检查：一次 node 进程内批量校验，避免大量 spawn 触发 EBUSY
{
  const checks = jsFiles.map(f => ({
    file: path.relative(ROOT, f),
    code: 'new Function(require("fs").readFileSync(process.argv[1],"utf8"))',
    target: f,
  }))
  // 用 vm 编译而非执行，仅验证语法
  const vm = require('vm')
  for (const f of jsFiles) {
    const code = fs.readFileSync(f, 'utf8')
    try {
      new vm.Script(code, { filename: f })
    } catch (e) {
      problems.push('SYNTAX ' + path.relative(ROOT, f) + ': ' + e.message)
      fail++
    }
  }
}
console.log('1) 语法检查：' + jsFiles.length + ' 个 JS 文件')

// 2) JSON 合法性
for (const f of all.filter(f => f.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    problems.push('JSON ' + f + ': ' + e.message)
    fail++
  }
}

// 3) WXML 事件处理函数是否在对应 JS 中定义
let handlerCount = 0
for (const wxml of all.filter(f => f.endsWith('.wxml'))) {
  const js = wxml.replace(/\.wxml$/, '.js')
  if (!fs.existsSync(js)) continue
  const src = fs.readFileSync(wxml, 'utf8')
  const code = fs.readFileSync(js, 'utf8')
  const re = /(?:bind|catch)[a-zA-Z:]*\s*=\s*"([A-Za-z_$][\w$]*)"/g
  let m
  const missing = new Set()
  while ((m = re.exec(src))) {
    handlerCount++
    const fn = m[1]
    const defined = new RegExp('(^|[\\s,{])' + fn + '\\s*(\\(|:)').test(code)
    if (!defined) missing.add(fn)
  }
  if (missing.size) {
    problems.push('HANDLER ' + wxml + ' 缺少: ' + [...missing].join(', '))
    fail++
  }
}
console.log('2) 事件处理函数：共检查 ' + handlerCount + ' 处绑定')

// 4) 跨模块 require 的导出名是否真实存在
function exportsOf(file) {
  const code = fs.readFileSync(file, 'utf8')
  const names = new Set()
  // 必须取最后一个 module.exports = { ... }，
  // 非贪婪匹配会命中文件中间的对象字面量
  const re = /module\.exports\s*=\s*\{([\s\S]*?)\n\}/g
  let m
  let last = null
  while ((m = re.exec(code))) last = m
  if (last) {
    // 去掉对象内的行注释，否则「// 学校与权限」会被当成一个导出名
    const body = last[1]
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n')
    body.split(',').forEach(s => {
      const t = s.trim()
      if (!t) return
      const as = /^(\w+)\s+as\s+(\w+)$/.exec(t)
      if (as) names.add(as[2])
      else names.add(t.split(':')[0].trim())
    })
    return names
  }
  if (/module\.exports\s*=\s*\w/.test(code)) {
    const mm = /module\.exports\s*=\s*\{?\s*([A-Za-z_$][\w$]*)/.exec(code)
    if (mm) names.add(mm[1])
  }
  return names
}

let reqCount = 0
for (const f of jsFiles) {
  const code = fs.readFileSync(f, 'utf8')
  const re = /const\s*\{([^}]+)\}\s*=\s*require\(['"](\.[^'"]+)['"]\)/g
  let m
  while ((m = re.exec(code))) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean)
    const rel = m[2]
    const target = path.resolve(path.dirname(f), rel) + '.js'
    reqCount++
    if (!fs.existsSync(target)) {
      problems.push('REQUIRE ' + path.relative(ROOT, f) + ' 找不到模块 ' + rel)
      fail++
      continue
    }
    if (rel.includes('/utils/')) {
      const exp = exportsOf(target)
      names.forEach(n => {
        if (!exp.has(n)) {
          problems.push('EXPORT ' + path.relative(ROOT, f) + ' 引用了 ' + rel + ' 中不存在的 ' + n)
          fail++
        }
      })
    }
  }
}
console.log('3) 跨模块导入：共检查 ' + reqCount + ' 处 require')

// 5) utils/school.js 是否导出了 admin-import 等页面用到的新函数
const schoolSrc = fs.readFileSync(path.join(ROOT, 'utils/school.js'), 'utf8')
const schoolExports = exportsOf(path.join(ROOT, 'utils/school.js'))
const needFromSchool = ['importSchedules', 'importStudents', 'importTeachers', 'importClassAccounts',
  'listSchools', 'listClasses', 'importSchools', 'importSchoolAdmins', 'ensureSchool']
needFromSchool.forEach(n => {
  if (!schoolExports.has(n)) {
    problems.push('SCHOOL-EXPORT 缺少 ' + n)
    fail++
  }
})

// 6) app.json 页面注册 vs 实际目录
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
appJson.pages.forEach(p => {
  ;['.js', '.wxml', '.json'].forEach(ext => {
    const f = path.join(ROOT, p + ext)
    if (!fs.existsSync(f)) {
      problems.push('PAGE app.json 注册了 ' + p + ' 但缺少 ' + ext)
      fail++
    }
  })
})
const pageDirs = new Set(
  all.filter(f => f.endsWith('.wxml'))
    .map(f => path.relative(ROOT, f).replace(/\\/g, '/').replace(/\.wxml$/, ''))
)
pageDirs.forEach(p => {
  if (!appJson.pages.includes(p)) {
    problems.push('PAGE 目录 ' + p + ' 未在 app.json 注册')
    fail++
  }
})
console.log('4) 页面注册：app.json ' + appJson.pages.length + ' 页，目录 ' + pageDirs.size + ' 个')

// 7) 登录页不得出现初始管理员账号
const loginWxml = fs.readFileSync(path.join(ROOT, 'pages/login/login.wxml'), 'utf8')
if (/admin123|初始管理员账号/.test(loginWxml)) {
  problems.push('LOGIN 登录页仍显示初始管理员账号')
  fail++
}

// 8) 旧API 不得残留（isAdmin 语义已扩展，检查是否仍引用已删除的函数）
// 只扫生产代码 —— 测试里可能故意引用它们做「已下线」断言
const removed = ['getTeacherStatusOfDay', 'shortTeacher', 'adminMoveSchedule', 'notifyScheduleAdjusted']
for (const f of jsFiles) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  if (rel.startsWith('test/') || rel.startsWith('.')) continue
  const code = fs.readFileSync(f, 'utf8')
  removed.forEach(n => {
    if (code.includes(n)) {
      problems.push('STALE ' + rel + ' 仍引用 ' + n)
      fail++
    }
  })
}

// 9) 自由函数调用必须真的被 import 过
//
// 这条检查是被真实事故逼出来的：`pages/schedule/schedule.js` 里调用了
// `shortClassName()` 却漏了 destructure，运行时直接 TypeError 白屏，
// 而上面的语法检查、事件检查、exports 检查全都通过了 —— 它们只验"有没有写"，
// 不验"引用的东西在不在作用域里"。
//
// 做法：扫出文件里所有 `标识符(` 形式的调用（排除关键字/本地定义/成员调用），
// 凡是 utils 导出的函数名，就必须在本文件的 import 语句里出现过。
{
  const utilExports = exportsOf(path.join(ROOT, 'utils/util.js'))
  const schoolExports = exportsOf(path.join(ROOT, 'utils/school.js'))
  const known = new Set([...utilExports, ...schoolExports])
  // 常见的本地/全局名，避免误报
  const skip = new Set(['require', 'if', 'for', 'while', 'switch', 'catch', 'function', 'return',
    'typeof', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'console', 'JSON',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'Promise', 'Map', 'Set',
    'RegExp', 'Error', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
    'wx', 'Page', 'App', 'getApp', 'Component', 'getCurrentPages'])

  // 只查 pages/ 与 app.js —— 这些是会被真机执行的生产代码；
  // test/ 里的 mock 有一堆同名方法，检查它们只会制造噪音
  const targets = jsFiles.filter(f => {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    return rel.startsWith('pages/') || rel === 'app.js'
  })

  let callCount = 0
  for (const f of targets) {
    let code = fs.readFileSync(f, 'utf8')
    // 去掉注释
    code = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    // 去掉对象字面量里的方法 shorthand（`foo() {}`）与属性赋值（`foo: function(){}`），
    // 否则 wx.showToast() / 各种 handler 会被当成"未 import 的自由函数"
    code = code.replace(/(^|[{,]\s*)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g, '$1__METHOD__(')
    code = code.replace(/(^|[{,]\s*)[A-Za-z_$][\w$]*\s*:\s*function\s*\([^)]*\)\s*\{/g, '$1__METHOD__(')

    const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g
    let m
    const used = new Set()
    while ((m = re.exec(code))) {
      const name = m[2]
      if (known.has(name)) used.add(name)
    }
    if (!used.size) continue

    // 收集本文件所有 import 进来的名字
    const imported = new Set()
    const impRe = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(/g
    let im
    while ((im = impRe.exec(code))) {
      im[1].split(',').forEach(s => {
        const t = s.trim()
        if (!t) return
        imported.add(t.split(':').pop().trim())
      })
    }
    // 同文件内自己定义（function 声明 / const 赋值）也算已定义
    const definedHere = new Set()
    const defRe = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/g
    let sm
    while ((sm = defRe.exec(code))) {
      definedHere.add(sm[1] || sm[2])
    }

    used.forEach(name => {
      callCount++
      if (imported.has(name) || definedHere.has(name) || skip.has(name)) return
      problems.push('UNIMPORTED ' + path.relative(ROOT, f) + ' 调用了 ' + name + '() 但没有 import')
      fail++
    })
  }
  console.log('5) 自由函数作用域：共检查 ' + callCount + ' 处 utils/school 调用')
}

console.log('')
if (fail === 0) {
  console.log('ALL CHECKS PASSED')
} else {
  console.log('发现 ' + fail + ' 个问题：')
  problems.forEach(p => console.log('  - ' + p))
}
process.exit(fail === 0 ? 0 : 1)