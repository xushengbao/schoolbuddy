/**
 * 给本地化的 SDK（utils/vendor-workbuddy-cloud-sdk.js）注入 URL / URLSearchParams 实现。
 *
 * 为什么要改 SDK 内部，而不是只注入全局：
 *   报错 `endpoint must be an absolute URL` 来自 SDK 的 normalizeHttpUrl()——
 *   它执行 `new URL(trimmed)`，而微信小程序基础库没有全局 URL 构造函数。
 *   之前只尝试给 globalThis 赋 URL，但小程序把每个模块包在函数里，
 *   顶层 this 指向模块自身而非全局对象，赋值落在了模块 exports 上，SDK 取不到。
 *
 * 改法：在 SDK 模块作用域顶部声明 `var URL = ...`。
 *   JS 的作用域链保证模块内的 `new URL()` 优先命中这个模块级声明，
 *   不依赖任何全局对象注入，因此在任何环境下都稳定生效。
 *   若运行环境本来就自带 URL，则沿用原生实现（下方有探测）。
 *
 * 该补丁幂等：重复执行不会重复注入。
 */

const fs = require('fs')
const path = require('path')

// 本脚本位于 utils/ 下，SDK 与之同级
const ROOT = __dirname
const SDK = path.join(ROOT, 'vendor-workbuddy-cloud-sdk.js')
const MARK = '/* ---- URL polyfill (injected by patch-sdk-url.js) ---- */'
const END = '/* ---- end URL polyfill ---- */'

const src = fs.readFileSync(SDK, 'utf8')

if (src.indexOf(MARK) >= 0) {
  console.log('已注入过，跳过（幂等）')
  process.exit(0)
}

// 插入点：esbuild 的 __toCommonJS 之后、第一个 src/ 段之前
const anchor = '// src/types.ts'
const idx = src.indexOf(anchor)
if (idx < 0) {
  console.error('未找到插入锚点 ' + anchor)
  process.exit(1)
}

const patch = `// @ts-nocheck
${MARK}
// 说明：微信小程序基础库不提供全局 URL / URLSearchParams，
// 而下方 normalizeHttpUrl() 用 new URL(trimmed) 校验 endpoint，
// 缺对象时会被误判成「must be an absolute URL」。
// 这里在模块作用域声明 URL：JS 作用域链会让模块内所有 new URL() 优先命中它，
// 不依赖全局注入（小程序里模块被函数包裹，改globalThis 不可靠）。
var __hasNativeURL = typeof URL !== "undefined" && typeof URLSearchParams !== "undefined";
var __wbURL = __hasNativeURL ? URL : null;
var __wbUSP = __hasNativeURL ? URLSearchParams : null;

if (!__wbURL) {
  var __wbUSPFactory = function () {
    function URLSearchParamsPolyfill(init) {
      var pairs = [];
      if (typeof init === "string") {
        var s = init.charAt(0) === "?" ? init.slice(1) : init;
        if (s) {
          s.split("&").forEach(function (kv) {
            if (!kv) return;
            var i = kv.indexOf("=");
            var k = i < 0 ? kv : kv.slice(0, i);
            var v = i < 0 ? "" : kv.slice(i + 1);
            try { k = decodeURIComponent(k.replace(/\\+/g, " ")); } catch {}
            try { v = decodeURIComponent(v.replace(/\\+/g, " ")); } catch {}
            pairs.push([k, v]);
          });
        }
      } else if (init && typeof init === "object") {
        Object.keys(init).forEach(function (k) { pairs.push([k, String(init[k])]); });
      }
      this._pairs = pairs;
    }
    URLSearchParamsPolyfill.prototype.append = function (k, v) { this._pairs.push([String(k), String(v)]); };
    URLSearchParamsPolyfill.prototype.get = function (k) {
      for (var i = 0; i < this._pairs.length; i++) if (this._pairs[i][0] === String(k)) return this._pairs[i][1];
      return null;
    };
    URLSearchParamsPolyfill.prototype.getAll = function (k) {
      var out = [];
      for (var i = 0; i < this._pairs.length; i++) if (this._pairs[i][0] === String(k)) out.push(this._pairs[i][1]);
      return out;
    };
    URLSearchParamsPolyfill.prototype.has = function (k) { return this.get(k) !== null; };
    URLSearchParamsPolyfill.prototype.set = function (k, v) {
      var found = false;
      for (var i = this._pairs.length - 1; i >= 0; i--) {
        if (this._pairs[i][0] === String(k)) {
          if (found) this._pairs.splice(i, 1);
          else { this._pairs[i][1] = String(v); found = true; }
        }
      }
      if (!found) this._pairs.push([String(k), String(v)]);
    };
    URLSearchParamsPolyfill.prototype["delete"] = function (k) {
      this._pairs = this._pairs.filter(function (p) { return p[0] !== String(k); });
    };
    URLSearchParamsPolyfill.prototype.forEach = function (fn, self) {
      var arr = this._pairs.slice();
      for (var i = 0; i < arr.length; i++) fn.call(self, arr[i][1], arr[i][0], this);
    };
    URLSearchParamsPolyfill.prototype.keys = function () {
      var a = this._pairs.map(function (p) { return p[0]; }), i = 0;
      return { next: function () { return i < a.length ? { value: a[i++], done: false } : { value: undefined, done: true }; } };
    };
    URLSearchParamsPolyfill.prototype.values = function () {
      var a = this._pairs.map(function (p) { return p[1]; }), i = 0;
      return { next: function () { return i < a.length ? { value: a[i++], done: false } : { value: undefined, done: true }; } };
    };
    URLSearchParamsPolyfill.prototype.entries = function () {
      var a = this._pairs.map(function (p) { return [p[0], p[1]]; }), i = 0;
      return { next: function () { return i < a.length ? { value: a[i++], done: false } : { value: undefined, done: true }; } };
    };
    URLSearchParamsPolyfill.prototype.toString = function () {
      return this._pairs.map(function (p) {
        return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]);
      }).join("&");
    };
    return URLSearchParamsPolyfill;
  };

  var __wbURLJoin = function (base, rel) {
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(base);
    if (!m) return rel;
    var origin = m[1], bpath = m[2] || "/", search = m[3] || "", hash = m[4] || "";
    if (rel.charAt(0) === "/") return origin + rel;
    if (rel.charAt(0) === "?") return origin + bpath + rel + hash;
    if (rel.charAt(0) === "#") return origin + bpath + search + rel;
    var dir = bpath.slice(0, bpath.lastIndexOf("/") + 1) || "/";
    var parts = (dir + rel).split("/"), out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === ".") continue;
      if (seg === "..") { if (out.length > 1) out.pop(); continue; }
      out.push(seg);
    }
    return origin + out.join("/") + hash;
  };

  __wbURL = function URL(input, base) {
    var href = String(input === undefined ? "about:blank" : input).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
      if (!base) throw new TypeError("Invalid URL: " + href);
      href = __wbURLJoin(String(base), href);
    }
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\\/\\/)?([^/?#]*)?([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(href);
    if (!m) throw new TypeError("Invalid URL: " + href);
    var protocol = m[1], hasAuthority = !!m[2];
    var authority = m[3] || "", path = m[4] || "", search = m[5] || "", hash = m[6] || "";
    var user = "", password = "", hostname = "", port = "";
    if (hasAuthority) {
      var at = authority.lastIndexOf("@");
      var userinfo = at >= 0 ? authority.slice(0, at) : "";
      var hostport = at >= 0 ? authority.slice(at + 1) : authority;
      var uc = userinfo.indexOf(":");
      if (uc >= 0) { user = userinfo.slice(0, uc); password = userinfo.slice(uc + 1); }
      else { user = userinfo; }
      var colon = hostport.lastIndexOf(":");
      var brk = hostport.indexOf("]");
      if (colon > brk && brk >= 0) { hostname = hostport.slice(0, colon); port = hostport.slice(colon + 1); }
      else if (colon >= 0 && brk < 0) { hostname = hostport.slice(0, colon); port = hostport.slice(colon + 1); }
      else { hostname = hostport; }
      if (brk >= 0) hostname = hostport.slice(0, brk + 1);
    }
    this.protocol = protocol;
    this.username = user;
    this.password = password;
    this.hostname = hostname;
    this.port = port;
    this.host = port ? hostname + ":" + port : hostname;
    this.origin = hasAuthority ? protocol + "//" + this.host : "null";
    this.pathname = path || "/";
    this.search = search;
    this.hash = hash;
    this.searchParams = new (__wbUSPFactory())(search);
    this.href = (hasAuthority ? protocol + "//" + (user ? user + (password ? ":" + password : "") + "@" : "") + this.host + (path || "/") : href) + search + hash;
  };
  __wbURL.prototype.toString = function () { return this.href; };
  __wbURL.prototype.toJSON = function () { return this.href; };
  __wbUSP = __wbUSPFactory();
}
// 模块级声明：遮蔽缺失的全局 URL，让下方SDK 内部的 new URL() 稳定可用
var URL = __wbURL;
var URLSearchParams = __wbUSP;
${END}
`

const out = src.slice(0, idx) + patch + '\n' + src.slice(idx)
fs.writeFileSync(SDK, out, 'utf8')
console.log('已注入 URL polyfill 到 vendor SDK，新大小 ' + out.length + ' 字节')