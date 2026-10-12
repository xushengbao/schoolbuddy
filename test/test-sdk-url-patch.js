/**
 * 决定性验证：在「完全没有全局 URL」的沙箱里加载**注入后的** SDK，
 * 确认 normalizeHttpUrl 不再误报、SDK 能成功初始化。
 *
 * 这是对真实报错
 *   WorkBuddyCloudConfigError: endpoint must be an absolute URL,
 *   received: https://mp-api.app.workbuddy.host
 * 的直接复现与回归。
 *
 * 关键点：SDK 源码必须在**沙箱作用域内**求值，才能模拟小程序把模块包在函数里的行为。
 * 用 new Function 会在宿主作用域执行，模拟不出小程序（上一轮踩过这个坑）。
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const UTILS = path.join(__dirname, '..', 'utils')
const sdkSrc = fs.readFileSync(path.join(UTILS, 'vendor-workbuddy-cloud-sdk.js'), 'utf8')
const diagSrc = fs.readFileSync(path.join(UTILS, 'workbuddy-cloud-diagnostics.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')) }
}

// 构造小程序沙箱：wx 桩件齐全，但故意不提供 URL / URLSearchParams / Headers / ReadableStream
function makeSandbox() {
  const sb = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, Error, TypeError, RangeError, ReferenceError,
    String, Number, Boolean, Array, Object, Symbol, RegExp,
    Map, Set, WeakMap, WeakSet, Proxy, Reflect,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    Uint8Array, Int8Array, Uint16Array, Uint32Array, Float32Array, Float64Array,
    ArrayBuffer, DataView,
    wx: {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop', appId: 'touristappid' }, appId: 'touristappid' }),
      getSystemInfoSync: () => ({ SDKVersion: '3.5.0', platform: 'devtools', system: 'win', model: 'pc' }),
      onError: () => {}, onUnhandledRejection: () => {},
      request: () => {}, getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
      cloud: { init: () => ({}), database: { from: () => ({}) } },
    },
  }
  sb.globalThis = sb
  sb.self = sb
  return sb
}

const sb = makeSandbox()
sb.__SDK_SRC__ = sdkSrc
sb.__DIAG_SRC__ = diagSrc
// SDK 顶层用 module.exports，需要沙箱全局提供 CommonJS 变量。
// 直接 eval 会让 SDK 的顶层 var（URL 等）落在 eval 作用域，
// 因此这里把 module/exports 也挂到全局，再整体eval SDK。
sb.module = { exports: {} }
sb.exports = sb.module.exports
const ctx = vm.createContext(sb)
const M = (code) => vm.runInContext(code, ctx)

console.log('\n[1] 沙箱前置条件：确认小程序缺失的全局对象都不存在')
check('沙箱内无全局 URL', M('typeof URL') === 'undefined', M('typeof URL'))
check('沙箱内无全局 URLSearchParams', M('typeof URLSearchParams') === 'undefined', M('typeof URLSearchParams'))

console.log('\n[2] vendor SDK 已注入模块级 URL 声明')
check('注入标记存在', sdkSrc.indexOf('injected by patch-sdk-url.js') >= 0)
check('存在模块级 var URL = __wbURL', /var URL = __wbURL;/.test(sdkSrc))
check('存在模块级 var URLSearchParams = __wbUSP', /var URLSearchParams = __wbUSP;/.test(sdkSrc))
check('SDK 内部仍有 new URL 调用（说明必须修）', sdkSrc.indexOf('new URL(') >= 0)

console.log('\n[3] 在沙箱作用域内执行 SDK（模拟小程序加载模块）')
const load = M(`(function () {
  try {
    (0, eval)(__SDK_SRC__);
    return { ok: true, keys: Object.keys(module.exports || {}) };
  } catch (e) {
    return { ok: false, name: e && e.name, message: String(e && e.message) };
  }
})()`)
check('SDK 在沙箱内加载成功', load.ok === true, load.message || '')
check('SDK 导出 createMiniProgramWorkBuddyCloud',
  M('typeof module.exports.createMiniProgramWorkBuddyCloud') === 'function')

console.log('\n[4] 原报错点：normalizeHttpUrl 不再误报')
const norm = M(`(function () {
  var parsed;
  try {
    parsed = new URL('https://mp-api.app.workbuddy.host');
  } catch (e) {
    return { threw: true, message: String(e && e.message) };
  }
  return { threw: false, protocol: parsed.protocol, origin: parsed.origin, href: parsed.href };
})()`)
check('new URL() 可正常构造（不再 ReferenceError）', norm.threw === false, norm.message || '')
check('protocol = https:', norm.protocol === 'https:', norm.protocol)
check('origin 正确', norm.origin === 'https://mp-api.app.workbuddy.host', norm.origin)
check('URLSearchParams 可用', M("typeof URLSearchParams === 'function'"))

console.log('\n[5] 真实初始化 SDK（对应报错栈顶的 createMiniProgramWorkBuddyCloud）')
const init = M(`(function () {
  try {
    var sdk = module.exports;
    var cloud = sdk.createMiniProgramWorkBuddyCloud({
      endpoint: 'https://mp-api.app.workbuddy.host',
      publishableKey: 'wbpk_aiyE8JhmdDNyW3mu4eqiUr_XuzRusGbX4gh5PTNJezHh72JypfWzh5G',
      wx: wx
    });
    return { ok: true, hasCloud: !!cloud };
  } catch (e) {
    return { ok: false, name: e && e.name, message: String(e && e.message) };
  }
})()`)
const msg = init.message || ''
check('SDK 初始化成功（无异常）', init.ok === true, init.name + ': ' + msg)
check('返回 cloud 客户端', init.hasCloud === true)
check('不再抛 "endpoint must be an absolute URL"', msg.indexOf('absolute URL') < 0, msg)
check('不再抛 "URL is not defined"', msg.indexOf('URL is not defined') < 0, msg)

console.log('\n[6] 注入后 SDK 自带的其它 polyfill 也应可用（Headers/ReadableStream）')
const ensured = M(`(function () {
  try {
    module.exports.ensureMiniProgramPolyfills();
    return { headers: typeof Headers, readable: typeof ReadableStream };
  } catch (e) {
    return { err: String(e && e.message) };
  }
})()`)
check('ensureMiniProgramPolyfills 补齐 Headers', ensured.headers === 'function', JSON.stringify(ensured))
check('ensureMiniProgramPolyfills 补齐 ReadableStream', ensured.readable === 'function', JSON.stringify(ensured))

console.log('\n[7] 幂等性：补丁可重复执行而不重复注入')
const patchSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'patch-sdk-url.js'), 'utf8')
check('patch 脚本含幂等判断（已注入则跳过）',
  patchSrc.indexOf('已注入过，跳过') >= 0)

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n')
process.exit(fail ? 1 : 0)