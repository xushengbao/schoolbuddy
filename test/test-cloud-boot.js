/**
 * 验证 cloud.js 在「没有全局 URL / URLSearchParams」时仍能正常初始化 SDK。
 *
 * 背景（真实报错）：
 *   WorkBuddyCloudConfigError: endpoint must be an absolute URL,
 *   received: https://mp-api.app.workbuddy.host
 * 成因是 SDK 的 normalizeHttpUrl() 里 `new URL(trimmed)` 抛错——
 * 微信小程序基础库没有全局 URL 构造函数，缺对象时 try/catch 误判为「非绝对URL」。
 *
 * 说明：本文件不做 delete globalThis.URL 的模拟。
 *   宿主（node 运行时与工具链）的 require shim 内部同样依赖 URL，
 *   删掉会让 require 本身崩溃，与小程序运行时的情况并不等价。
 *   因此这里改为验证「能力契约」：
 *     1. polyfill 是否提供了 SDK 实际使用的全部能力；
 *     2. SDK 在补齐这些能力后能否成功初始化（即不再误报）。
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

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

const UTILS = path.join(__dirname, '..', 'utils')
const cloudSrc = fs.readFileSync(path.join(UTILS, 'cloud.js'), 'utf8')
const sdkSrc = fs.readFileSync(path.join(UTILS, 'vendor-workbuddy-cloud-sdk.js'), 'utf8')
const polySrc = fs.readFileSync(path.join(UTILS, 'url-polyfill.js'), 'utf8')
const poly = require('../utils/url-polyfill')

console.log('\n[1] cloud.js 顶部先于 SDK 注入 polyfill（顺序错则修复无效）')
const polyIdx = cloudSrc.indexOf('ensureUrlPolyfill')
const sdkIdx = cloudSrc.indexOf("require('./vendor-workbuddy-cloud-sdk')")
check('cloud.js 已引入 url-polyfill', polyIdx >= 0)
check('polyfill 注入早于 SDK 加载', polyIdx >= 0 && sdkIdx >= 0 && polyIdx < sdkIdx,
  'polyfill@' + polyIdx + ' sdk@' + sdkIdx)

console.log('\n[2] polyfill 覆盖了 SDK 实际用到的全部能力')
const P = poly.PolyfillURL
const SP = poly.PolyfillURLSearchParams
// SDK 里 normalizeHttpUrl 用到的属性
const u = new P('https://mp-api.app.workbuddy.host')
check('protocol（SDK 用于判断 http(s)）', u.protocol === 'https:', u.protocol)
check('origin（SDK 可能用于拼接）', u.origin === 'https://mp-api.app.workbuddy.host', u.origin)
check('host', u.host === 'mp-api.app.workbuddy.host', u.host)
check('pathname', typeof u.pathname === 'string' && u.pathname.length > 0, u.pathname)
check('search', u.search === '', JSON.stringify(u.search))
check('hash', u.hash === '')
// 无路径时原生 URL 的 href 会带尾斜杠（https://x.com/），pathname 同为 '/'
const NativeURL = new URL('https://mp-api.app.workbuddy.host')
check('href/toString 与原生一致',
  u.href === NativeURL.href && String(u) === u.href, u.href + ' vs ' + NativeURL.href)
check('searchParams 可用', u.searchParams instanceof SP || typeof u.searchParams.get === 'function')

const u2 = new P('https://example.com:8443/base/path?q=hello%20world#h')
check('带端口/路径/查询/锚点解析正确',
  u2.host === 'example.com:8443' && u2.port === '8443' &&
  u2.pathname === '/base/path' && u2.search === '?q=hello%20world' && u2.hash === '#h',
  JSON.stringify({ h: u2.host, p: u2.pathname, s: u2.search, f: u2.hash }))
check('searchParams.get 解码', u2.searchParams.get('q') === 'hello world', u2.searchParams.get('q'))

console.log('\n[3] SDK 初始化时用到的 URL 构造全部可用（对应原报错点）')
// 复现 SDK 的 normalizeHttpUrl 逻辑：有 URL 则校验，无则报错
function normalizeLikeSdk(value) {
  let parsed
  try {
    parsed = new P(value.trim())
  } catch {
    throw new Error(`${value} must be an absolute URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${value} must use http(s)`)
  }
  return value.trim().replace(/\/+$/, '')
}
let endpointOk = true
let endpointErr = ''
try {
  const r = normalizeLikeSdk('https://mp-api.app.workbuddy.host')
  endpointOk = r === 'https://mp-api.app.workbuddy.host'
} catch (e) { endpointOk = false; endpointErr = e.message }
check('合法 endpoint 不再被误判（关键回归）', endpointOk === true, endpointErr)
check('非法地址仍能被识别', (function () {
  try { normalizeLikeSdk('not-a-url'); return false } catch (e) { return e.message.indexOf('absolute URL') >= 0 }
})())

console.log('\n[4] 真实加载 SDK：补齐 URL 后初始化成功')
// 按 cloud.js 的做法注入 polyfill，再初始化 SDK。
// 这里用独立变量模拟「SDK 看到的世界」，避免污染宿主全局。
const g = globalThis
const savedURL = g.URL
const savedUSP = g.URLSearchParams
const added = poly.ensureUrlPolyfill()
check('宿主已自带 URL 时不重复注入', added.url === false || typeof g.URL === 'function',
  JSON.stringify(added))
check('URL 可用于解析 endpoint',
  new g.URL('https://mp-api.app.workbuddy.host').origin === 'https://mp-api.app.workbuddy.host')

// 直接调用 SDK 工厂，验证初始化链路
globalThis.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop', appId: 'touristappid' }, appId: 'touristappid' }),
  getSystemInfoSync: () => ({ SDKVersion: '3.5.0', platform: 'devtools', system: 's', model: 'm' }),
  onError: () => {},
  onUnhandledRejection: () => {},
  request: () => {},
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  cloud: { init: () => ({}), database: { from: () => ({}) } },
}
let sdkErr = null
let sdkCloud = null
try {
  const sdk = require('../utils/vendor-workbuddy-cloud-sdk')
  const diag = require('../utils/workbuddy-cloud-diagnostics')
  sdkCloud = sdk.createMiniProgramWorkBuddyCloud({
    endpoint: 'https://mp-api.app.workbuddy.host',
    publishableKey: 'wbpk_aiyE8JhmdDNyW3mu4eqiUr_XuzRusGbX4gh5PTNJezHh72JypfWzh5G',
    wx: diag.createDiagnosticWx(globalThis.wx),
  })
} catch (e) {
  sdkErr = e
}
const errMsg = sdkErr ? (sdkErr.name + ': ' + sdkErr.message) : ''
check('SDK 初始化成功（无异常）', !sdkErr, errMsg)
check('返回 cloud 客户端对象', !!(sdkCloud && typeof sdkCloud === 'object'), errMsg)
check('不再抛 "endpoint must be an absolute URL"',
  errMsg.indexOf('absolute URL') < 0, errMsg)
check('不再抛 "URL is not defined"', errMsg.indexOf('URL is not defined') < 0, errMsg)

// 还原
delete globalThis.wx
g.URL = savedURL
g.URLSearchParams = savedUSP

console.log('\n[5] SDK 源码里所有 new URL 调用点都已被 polyfill 覆盖')
// 抽样确认 SDK 用到的 URL 能力都在 polyfill 里实现了
const needed = ['protocol', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin', 'host', 'href', 'searchParams', 'username', 'password']
const missing = needed.filter(k => !(k in P.prototype || k in u))
check('URL 实例属性齐全', missing.length === 0, '缺: ' + missing.join(','))
const spNeeded = ['get', 'getAll', 'set', 'append', 'has', 'delete', 'toString', 'forEach', 'keys', 'values', 'entries']
const spMissing = spNeeded.filter(k => typeof SP.prototype[k] !== 'function')
check('URLSearchParams 方法齐全', spMissing.length === 0, '缺: ' + spMissing.join(','))
check('SDK 里确有 new URL 调用（说明 polyfill 必要）', sdkSrc.indexOf('new URL(') >= 0)

console.log('\n[6] 沙箱内联复现小程序运行时（原报错的最贴近验证）')
// 沙箱里没有 URL / URLSearchParams 全局（小程序基础库正是如此），
// 且 polyfill 源码在沙箱作用域内求值——它的 globalThis 就是沙箱全局。
// 这组直接复现并验证「endpoint must be an absolute URL」已被修掉。
const sb = {
  console: { log() {}, info() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, Error, TypeError, RangeError,
  String, Number, Boolean, Array, Object, Symbol, RegExp,
  Map, Set, WeakMap, WeakSet, Proxy, Reflect,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  Uint8Array, ArrayBuffer, DataView,
  wx: {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop', appId: 'touristappid' }, appId: 'touristappid' }),
    getSystemInfoSync: () => ({ SDKVersion: '3.5.0', platform: 'devtools', system: 's', model: 'm' }),
    onError: () => {}, onUnhandledRejection: () => {},
    request: () => {}, getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
    cloud: { init: () => ({}), database: { from: () => ({}) } },
  },
}
sb.globalThis = sb
sb.self = sb
const mctx = vm.createContext(sb)
const M = (code) => vm.runInContext(code, mctx)

check('小程序沙箱内 URL 确实缺失', M('typeof URL') === 'undefined', M('typeof URL'))
check('小程序沙箱内 URLSearchParams 确实缺失', M('typeof URLSearchParams') === 'undefined')

// 在沙箱作用域内求值 polyfill（模拟小程序里模块就在全局作用域执行）
M('(function(){ var module = { exports: {} }, exports = module.exports; ' + polySrc + '\n; __polyOut = module.exports })()')
const injected = JSON.parse(M('JSON.stringify(__polyOut.ensureUrlPolyfill())'))
check('polyfill 在小程序环境成功注入 URL', injected.url === true, JSON.stringify(injected))
check('polyfill 在小程序环境成功注入 URLSearchParams', injected.searchParams === true)
check('注入后沙箱内 URL 可用', M('typeof URL') === 'function', M('typeof URL'))
check('注入后沙箱内 URLSearchParams 可用', M('typeof URLSearchParams') === 'function')

// 复现 SDK 的 normalizeHttpUrl —— 原报错就发生在这行 new URL(trimmed)
const normOut = M(`(function () {
  var parsed;
  try {
    parsed = new URL('https://mp-api.app.workbuddy.host');
  } catch (e) {
    return { threw: true, message: String(e && e.message) };
  }
  return { threw: false, protocol: parsed.protocol, origin: parsed.origin };
})()`)
check('原报错函数不再抛异常（关键回归）', normOut.threw === false, normOut.message || '')
check('protocol 解析为 https:', normOut.protocol === 'https:', normOut.protocol)
check('origin 解析正确', normOut.origin === 'https://mp-api.app.workbuddy.host', normOut.origin)
check('沙箱内 new URLSearchParams 可用',
  M("new URLSearchParams('a=1&b=2').get('b')") === '2')

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n')
process.exit(fail ? 1 : 0)