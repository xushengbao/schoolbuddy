/**
 * 微信小程序基础库没有全局 URL / URLSearchParams 构造函数，
 * 而 WorkBuddy 云服务 SDK 用 `new URL(endpoint)` 校验配置地址，
 * 缺全局对象时会把合法的 https 地址误判成「must be an absolute URL」。
 *
 * 这里补一个只覆盖 SDK 实际用到的能力的最小实现，在 require SDK 之前注入。
 * 若运行环境本已自带（较新的开发者工具 / 浏览器），直接跳过，不覆盖原生实现。
 */

// ---- URLSearchParams ----
function PolyfillURLSearchParams(init) {
  var pairs = []
  if (typeof init === 'string') {
    var s = init.charAt(0) === '?' ? init.slice(1) : init
    if (s) {
      s.split('&').forEach(function (kv) {
        if (!kv) return
        var i = kv.indexOf('=')
        var k = i < 0 ? kv : kv.slice(0, i)
        var v = i < 0 ? '' : kv.slice(i + 1)
        pairs.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))])
      })
    }
  } else if (init && typeof init === 'object') {
    Object.keys(init).forEach(function (k) { pairs.push([k, String(init[k])]) })
  }
  this._pairs = pairs
}

PolyfillURLSearchParams.prototype.append = function (k, v) {
  this._pairs.push([String(k), String(v)])
}
PolyfillURLSearchParams.prototype.get = function (k) {
  for (var i = 0; i < this._pairs.length; i++) {
    if (this._pairs[i][0] === String(k)) return this._pairs[i][1]
  }
  return null
}
PolyfillURLSearchParams.prototype.getAll = function (k) {
  var out = []
  for (var i = 0; i < this._pairs.length; i++) {
    if (this._pairs[i][0] === String(k)) out.push(this._pairs[i][1])
  }
  return out
}
PolyfillURLSearchParams.prototype.has = function (k) {
  return this.get(k) !== null
}
PolyfillURLSearchParams.prototype.set = function (k, v) {
  var found = false
  for (var i = 0; i < this._pairs.length; i++) {
    if (this._pairs[i][0] === String(k)) {
      if (found) this._pairs.splice(i, 1)
      else { this._pairs[i][1] = String(v); found = true }
    }
  }
  if (!found) this._pairs.push([String(k), String(v)])
}
PolyfillURLSearchParams.prototype.delete = function (k) {
  this._pairs = this._pairs.filter(function (p) { return p[0] !== String(k) })
}
PolyfillURLSearchParams.prototype.forEach = function (fn, thisArg) {
  this._pairs.slice().forEach(function (p) {
    fn.call(thisArg, p[1], p[0], this)
  }, this)
}
PolyfillURLSearchParams.prototype.keys = function () {
  return this._pairs.map(function (p) { return p[0] })[Symbol.iterator]()
}
PolyfillURLSearchParams.prototype.values = function () {
  return this._pairs.map(function (p) { return p[1] })[Symbol.iterator]()
}
PolyfillURLSearchParams.prototype.entries = function () {
  return this._pairs.map(function (p) { return [p[0], p[1]] })[Symbol.iterator]()
}
PolyfillURLSearchParams.prototype[Symbol.iterator] = PolyfillURLSearchParams.prototype.entries
PolyfillURLSearchParams.prototype.toString = function () {
  return this._pairs.map(function (p) {
    return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1])
  }).join('&')
}

// ---- URL ----
// 按 WHATWG 规范：没有 scheme 或不是 http(s) 一律抛 TypeError，
// 这样 SDK 的 try/catch 才能正确区分「合法地址」与「非法地址」。
var ABSOLUTE_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function PolyfillURL(input, base) {
  var href = String(input === undefined ? 'about:blank' : input).trim()

  // 相对路径：以 base 补全
  if (!ABSOLUTE_RE.test(href)) {
    if (!base) throw new TypeError("Invalid URL: " + href)
    href = joinUrl(String(base), href)
  }

  var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/)?([^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href)
  if (!m) throw new TypeError("Invalid URL: " + href)

  var protocol = m[1]
  var hasAuthority = !!m[2]
  var authority = m[3] || ''
  var path = m[4] || ''
  var search = m[5] || ''
  var hash = m[6] || ''

  if (!hasAuthority) {
    // 非 // 形式，如 data:、mailto:、about:
    this.protocol = protocol
    this.host = ''
    this.hostname = ''
    this.port = ''
    this.origin = 'null'
    this.pathname = path
    this.search = search
    this.hash = hash
    this.searchParams = new PolyfillURLSearchParams(search)
    this.username = ''
    this.password = ''
    this.href = href
    return
  }

  var at = authority.lastIndexOf('@')
  var userinfo = at >= 0 ? authority.slice(0, at) : ''
  var hostport = at >= 0 ? authority.slice(at + 1) : authority
  var colon = hostport.lastIndexOf(':')
  var hostname = ''
  var port = ''
  if (colon > hostport.lastIndexOf(']')) {
    hostname = hostport.slice(0, colon)
    port = hostport.slice(colon + 1)
  } else {
    hostname = hostport
  }
  var c = hostport.indexOf(']')
  if (c >= 0) hostname = hostport.slice(0, c + 1)

  var user = ''
  var password = ''
  if (userinfo) {
    var uc = userinfo.indexOf(':')
    if (uc >= 0) {
      user = userinfo.slice(0, uc)
      password = userinfo.slice(uc + 1)
    } else {
      user = userinfo
    }
  }

  this.protocol = protocol
  this.username = user
  this.password = password
  this.hostname = hostname
  this.port = port
  this.host = port ? hostname + ':' + port : hostname
  this.origin = protocol + '//' + this.host
  // 无路径时 pathname 补 '/'，href 同步补 '/'——与原生 URL 行为一致：
  // new URL('https://x.com').href === 'https://x.com/'
  this.pathname = path || '/'
  this.search = search
  this.hash = hash
  this.searchParams = new PolyfillURLSearchParams(search)
  this.href = protocol + '//' + (userinfo ? userinfo + '@' : '') + this.host +
    (path || '/') + search + hash
}

function joinUrl(base, rel) {
  var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(base)
  if (!m) return rel
  var origin = m[1]
  var bpath = m[2] || '/'
  var search = m[3] || ''
  var hash = m[4] || ''

  if (rel.charAt(0) === '/') {
    return origin + rel
  }
  if (rel.charAt(0) === '?') {
    return origin + bpath + rel + hash
  }
  if (rel.charAt(0) === '#') {
    return origin + bpath + search + rel
  }
  var dir = bpath.slice(0, bpath.lastIndexOf('/') + 1) || '/'
  var merged = dir + rel
  // 归一化 . 与 ..（第一个片段是空串，对应 origin 后的 '/',保留）
  var parts = merged.split('/')
  var out = []
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i]
    if (seg === '.') continue
    if (seg === '..') {
      // 不能越过根：out[0] 恒为空串（开头的 /）
      if (out.length > 1) out.pop()
      continue
    }
    out.push(seg)
  }
  return origin + out.join('/') + hash
}

PolyfillURL.prototype.toString = function () { return this.href }
PolyfillURL.prototype.toJSON = function () { return this.href }

/**
 * 注入缺失的全局对象。已存在则不动，避免覆盖原生实现。
 * @returns {{url:boolean, searchParams:boolean}} 实际补上了哪些
 */
function ensureUrlPolyfill() {
  var g = typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : this)
  var added = { url: false, searchParams: false }

  if (typeof g.URL !== 'function') {
    g.URL = PolyfillURL
    added.url = true
  }
  if (typeof g.URLSearchParams !== 'function') {
    g.URLSearchParams = PolyfillURLSearchParams
    added.searchParams = true
  }
  return added
}

module.exports = {
  ensureUrlPolyfill: ensureUrlPolyfill,
  PolyfillURL: PolyfillURL,
  PolyfillURLSearchParams: PolyfillURLSearchParams,
}