/**
 * 验证 utils/url-polyfill.js：
 *   1. 缺失全局时能补上 URL / URLSearchParams
 *   2. 已存在原生实现时不覆盖
 *   3. URL 解析结果与标准一致（对照 Node 原生 URL）
 *   4. 非法输入要抛 TypeError，让 SDK 的 try/catch 能正确识别
 *   5. 补齐后 SDK 能通过 endpoint 校验（真实回归：修复小程序端误报）
 *   6. SDK 常用派生属性可用（origin/search/pathname/protocol 等）
 */

const path = require('path')

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

const poly = require('../utils/url-polyfill')

console.log('\n[1] 缺失全局时补齐')
// 先把原生实现取出来存好，后面删掉全局时仍用它作对照基准。
const savedURL = globalThis.URL
const savedUSP = globalThis.URLSearchParams
// 提前采集所有原生基准，避免 delete 之后原生 URL 行为受宿主 require shim 影响。
const NATIVE_PROTOCOL = {}
;['ftp://x.com', 'data:text/plain,hi', 'mailto:a@b.com', 'file:///c:/x',
  'about:blank', 'javascript:alert(1)', 'https://ok.com', 'http://x.com']
  .forEach(raw => {
    try { NATIVE_PROTOCOL[raw] = new savedURL(raw).protocol } catch (e) { NATIVE_PROTOCOL[raw] = 'THROW' }
  })
// 相对 URL 的原生基准也提前采集
const NATIVE_HREF = {
  bare: new savedURL('https://mp-api.app.workbuddy.host').href,
  queryOnly: new savedURL('https://x.com?a=1').href,
  hashOnly: new savedURL('https://x.com#h').href,
}
const NATIVE_REL = {
  r3: new savedURL('../up', 'https://example.com/api/v1/x/').href,
  r4: new savedURL('../../up', 'https://example.com/api/v1/x/').href,
  r5: new savedURL('../../../up', 'https://example.com/a/').href,
  r6: new savedURL('../../../../..', 'https://example.com/a/b/').href,
  users: new savedURL('users', 'https://example.com/api/v1/').href,
  root: new savedURL('/root', 'https://example.com/api/v1/').href,
}
delete globalThis.URL
delete globalThis.URLSearchParams
check('补齐前 URL 不存在', typeof globalThis.URL === 'undefined')
const added = poly.ensureUrlPolyfill()
check('ensureUrlPolyfill 报告补上了 URL', added.url === true, JSON.stringify(added))
check('ensureUrlPolyfill 报告补上了 URLSearchParams', added.searchParams === true)
check('URL 已是函数', typeof globalThis.URL === 'function')
check('URLSearchParams 已是函数', typeof globalThis.URLSearchParams === 'function')

console.log('\n[1b] 无路径地址的 href 与原生保持一致（SDK 会直接拼进请求 URL）')
// 原生：new URL('https://x.com').href === 'https://x.com/'，pathname 也是 '/'
check('纯域名 href 与原生一致',
  new globalThis.URL('https://mp-api.app.workbuddy.host').href === NATIVE_HREF.bare,
  new globalThis.URL('https://mp-api.app.workbuddy.host').href)
check('纯域名 pathname 为 /',
  new globalThis.URL('https://mp-api.app.workbuddy.host').pathname === '/')
check('带查询串 href 与原生一致',
  new globalThis.URL('https://x.com?a=1').href === NATIVE_HREF.queryOnly,
  new globalThis.URL('https://x.com?a=1').href)
check('带锚点 href 与原生一致',
  new globalThis.URL('https://x.com#h').href === NATIVE_HREF.hashOnly,
  new globalThis.URL('https://x.com#h').href)

console.log('\n[2] 已存在原生实现时不覆盖')
globalThis.URL = savedURL
globalThis.URLSearchParams = savedUSP
const added2 = poly.ensureUrlPolyfill()
check('不覆盖原生 URL', globalThis.URL === savedURL)
check('不覆盖原生 URLSearchParams', globalThis.URLSearchParams === savedUSP)
check('报告未补任何东西', added2.url === false && added2.searchParams === false, JSON.stringify(added2))

console.log('\n[3] 解析结果与 Node 原生 URL 对照')
// 再次移除，强制走 polyfill
delete globalThis.URL
delete globalThis.URLSearchParams
poly.ensureUrlPolyfill()

const cases = [
  'https://mp-api.app.workbuddy.host',
  'https://example.com',
  'https://example.com/path/to/x?a=1&b=2',
  'https://example.com:8443/base/path?q=hello%20world',
  'https://user:pass@example.com/private',
  'http://127.0.0.1:8080/x?y=1',
]
// 原生基准同样提前采集（delete 之后 savedURL 不可靠）
const NATIVE_PARSE = {}
cases.forEach(raw => {
  const u = new savedURL(raw)
  NATIVE_PARSE[raw] = {
    protocol: u.protocol, host: u.host, hostname: u.hostname,
    port: u.port, pathname: u.pathname, search: u.search, origin: u.origin, href: u.href,
  }
})
cases.forEach(raw => {
  const mine = new globalThis.URL(raw)
  const std = NATIVE_PARSE[raw]
  const same =
    mine.protocol === std.protocol &&
    mine.host === std.host &&
    mine.hostname === std.hostname &&
    mine.port === std.port &&
    mine.pathname === std.pathname &&
    mine.search === std.search &&
    mine.origin === std.origin
  check('解析一致 ' + raw, same,
    same ? '' : JSON.stringify({
      mine: { p: mine.protocol, h: mine.host, path: mine.pathname, s: mine.search, o: mine.origin },
      std: std,
    }))
})
// href 必须与原生逐字一致（SDK 会把 endpoint 直接拼进请求 URL）
cases.forEach(raw => {
  check('href 与原生逐字一致 ' + raw, new globalThis.URL(raw).href === NATIVE_PARSE[raw].href,
    new globalThis.URL(raw).href + ' vs ' + NATIVE_PARSE[raw].href)
})

console.log('\n[4] 非法输入抛 TypeError（让 SDK try/catch 能识别）')
const bad = ['not-a-url', 'mp-api.app.workbuddy.host', 'example.com/path', '/relative/only', '']
bad.forEach(raw => {
  let threwType = false
  try { new globalThis.URL(raw) } catch (e) { threwType = e instanceof TypeError }
  check('应抛错: "' + raw + '"', threwType)
})

console.log('\n[5] URLSearchParams 行为')
const p = new globalThis.URLSearchParams('a=1&b=2&a=3')
check('get 取首个', p.get('a') === '1', String(p.get('a')))
check('getAll 取全部', p.getAll('a').join(',') === '1,3', p.getAll('a').join(','))
check('has 正确', p.has('b') === true && p.has('z') === false)
p.append('c', '4')
check('append 生效', p.get('c') === '4')
p.set('a', '9')
check('set 覆盖首个并去重', p.getAll('a').join(',') === '9', p.getAll('a').join(','))
p.delete('b')
check('delete 生效', p.has('b') === false)
check('toString 编码', p.toString().indexOf('a=9') >= 0, p.toString())
const parsed = new globalThis.URLSearchParams('?x=%E4%B8%AD%E6%96%87')
check('解码中文值', parsed.get('x') === '中文', String(parsed.get('x')))

console.log('\n[6] 相对 URL 以 base 补全')
const base = 'https://example.com/api/v1/'
const rel1 = new globalThis.URL('users', base)
const rel2 = new globalThis.URL('/root', base)
const rel3 = new globalThis.URL('../up', 'https://example.com/api/v1/x/')
const rel4 = new globalThis.URL('../../up', 'https://example.com/api/v1/x/')
const relStd3 = NATIVE_REL.r3
const relStd4 = NATIVE_REL.r4
const relStd5 = NATIVE_REL.r5
const relStd6 = NATIVE_REL.r6
check('相对路径补全', rel1.href === NATIVE_REL.users, rel1.href)
check('根相对补全', rel2.href === NATIVE_REL.root, rel2.href)
check('.. 归一化（与原生一致）', rel3.href === relStd3, rel3.href + ' vs ' + relStd3)
check('../../ 归一化（与原生一致）', rel4.href === relStd4, rel4.href + ' vs ' + relStd4)
check('多级 .. 归一化（与原生一致）',
  new globalThis.URL('../../../up', 'https://example.com/a/').href === relStd5,
  new globalThis.URL('../../../up', 'https://example.com/a/').href + ' vs ' + relStd5)
check('不越出协议之外（与原生一致）',
  new globalThis.URL('../../../../..', 'https://example.com/a/b/').href === relStd6,
  new globalThis.URL('../../../../..', 'https://example.com/a/b/').href + ' vs ' + relStd6)

console.log('\n[7] 说明：小程序端「无 URL 全局」的启动回归由 test-cloud-boot.js 在独立子进程中验证')
console.log('    （本进程 delete globalThis.URL 会连带弄坏宿主工具链里依赖 URL 的 require shim，')
console.log('      与小程序运行时不符，故不在此模拟。）')
check('polyfill 导出函数齐全', typeof poly.ensureUrlPolyfill === 'function' &&
  typeof poly.PolyfillURL === 'function' && typeof poly.PolyfillURLSearchParams === 'function')

console.log('\n[8] SDK 校验逻辑：只有非 http(s) 才应被拒')
// 补齐后对照 SDK 的判断依据：protocol 必须是 http: 或 https:
delete globalThis.URL
delete globalThis.URLSearchParams
poly.ensureUrlPolyfill()
const parsedOk = (function () {
  try {
    const u = new globalThis.URL('https://mp-api.app.workbuddy.host')
    return u.origin === 'https://mp-api.app.workbuddy.host'
  } catch (e) { return false }
})()
check('endpoint 可被 new URL 正确解析（对应原报错点）', parsedOk)
check('http 地址 protocol=http:', new globalThis.URL('http://x.com').protocol === 'http:')
check('https 地址 protocol=https:', new globalThis.URL('https://x.com').protocol === 'https:')
// 注意：原生 URL 对 ftp:/data: 等非 http(s) 协议并不抛错，而是正常解析出 protocol，
// 由 SDK 用 `parsed.protocol` 自行判断是否 http(s)。polyfill 需与原生保持一致，
// 否则 SDK 会把「非法协议」和「合法 http(s)」搞反。
Object.keys(NATIVE_PROTOCOL).forEach(raw => {
  let mineP = ''
  try { mineP = new globalThis.URL(raw).protocol } catch (e) { mineP = 'THROW' }
  check('协议解析与原生一致 ' + raw, mineP === NATIVE_PROTOCOL[raw],
    mineP + ' vs ' + NATIVE_PROTOCOL[raw])
})

// 还原全局
globalThis.URL = savedURL
globalThis.URLSearchParams = savedUSP

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n')
process.exit(fail ? 1 : 0)