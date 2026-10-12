/**
 * 纯 JS 的 Excel 2007+（.xlsx）解析器
 *
 * 为什么需要它：学校常用的「班级课表模版」是 .xlsx，本地已有 utils/xls.js
 * 只能处理 .xls（OLE2 复合文档）。.xlsx 是 ZIP 包，里面是 XML。
 *
 * 依赖：仅 utils/inflate.js（自带的 DEFLATE 解压器），无第三方库。
 *
 * 支持范围（覆盖课表 / 名单类模版）：
 *   ZIP：中央目录（EOCD）、中央目录条目、本地文件头、method 0/8
 *   XML：workbook.xml（sheet 名与 rId）、workbook.xml.rels（rId -> 路径）
 *   sharedStrings.xml（si/t、rPh 注音跳过）、worksheets/sheetN.xml
 *   单元格类型：共享字符串 t="s"、内联字符串 t="inlineStr"、
 *               布尔 t="b"、错误 t="e"、公式字符串 t="str"、数字（缺省 t="n"）
 *
 * 对外暴露 parse(arrayBuffer) -> [{ name, rows }]，与 xls.js 保持一致。
 */

var inflate = require('./inflate')

/* ============================ 通用工具 ============================ */

function Reader(buffer) {
  this.view = new DataView(buffer)
  this.u8 = new Uint8Array(buffer)
  this.bytes = buffer.byteLength
}
Reader.prototype.u16 = function (off) {
  return this.view.getUint16(off, true)
}
Reader.prototype.u32 = function (off) {
  return this.view.getUint32(off, true)
}

/** 字节数组转 utf-8 字符串 */
function utf8ToString(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('utf-8').decode(bytes)
    } catch (e) {
      /* 落到下面手写实现 */
    }
  }
  var s = ''
  var i = 0
  while (i < bytes.length) {
    var b = bytes[i]
    if (b < 0x80) {
      s += String.fromCharCode(b)
      i++
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f))
      i += 3
    } else if (b >= 0xf0 && i + 3 < bytes.length) {
      var cp =
        ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      cp -= 0x10000
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      i += 4
    } else {
      s += String.fromCharCode(b)
      i++
    }
  }
  return s
}

/** XML 实体反转义 */
function xmlUnescape(text) {
  if (!text) return ''
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return safeFromCodePoint(parseInt(h, 16))
    })
    .replace(/&#(\d+);/g, function (_, d) {
      return safeFromCodePoint(parseInt(d, 10))
    })
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(cp) {
  if (!cp || cp < 0 || cp > 0x10ffff) return ''
  try {
    return String.fromCodePoint ? String.fromCodePoint(cp) : String.fromCharCode(cp)
  } catch (e) {
    return ''
  }
}

/** 判断是否 zip 包（.xlsx） */
function isZip(buffer) {
  if (!buffer || buffer.byteLength < 4) return false
  var u = new Uint8Array(buffer)
  return u[0] === 0x50 && u[1] === 0x4b && u[2] === 0x03 && u[3] === 0x04
}

/* ============================ ZIP ============================ */

/**
 * 读取 ZIP 中央目录，返回 { 文件名 -> Uint8Array }。
 * 只按中央目录取偏移，再回到本地文件头读真实数据，兼容性最好。
 */
function readZipEntries(buffer) {
  var r = new Reader(buffer)

  // 找 EOCD：从尾部往前搜签名 0x06054b50，最多回溯 65557+22 字节
  var eocd = -1
  var min = Math.max(0, r.bytes - 66000)
  for (var i = r.bytes - 22; i >= min; i--) {
    if (r.u32(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 .xlsx（ZIP）文件')

  var count = r.u16(eocd + 10)
  var cdOffset = r.u32(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 .xlsx')
  }

  var files = {}
  var off = cdOffset
  for (var n = 0; n < count; n++) {
    if (off + 46 > r.bytes || r.u32(off) !== 0x02014b50) break

    var method = r.u16(off + 10)
    var csize = r.u32(off + 20)
    var nameLen = r.u16(off + 28)
    var extraLen = r.u16(off + 30)
    var commentLen = r.u16(off + 32)
    var localOff = r.u32(off + 42)
    var name = utf8ToString(r.u8.subarray(off + 46, off + 46 + nameLen))

    // 目录项里的 csize 在带数据描述符（bit 3）时可能为 0，此时用本地头为准
    if (csize === 0 && localOff + 30 <= r.bytes && r.u32(localOff) === 0x04034b50) {
      csize = r.u32(localOff + 18)
    }

    files[name] = { method: method, csize: csize, localOff: localOff }
    off += 46 + nameLen + extraLen + commentLen
  }
  return files
}

/** 按中央目录记录解压出某个条目的字节 */
function readZipData(buffer, entry) {
  var r = new Reader(buffer)
  var lo = entry.localOff
  if (lo + 30 > r.bytes || r.u32(lo) !== 0x04034b50) {
    throw new Error('ZIP 局部文件头损坏：' + entry.localOff)
  }
  var nameLen = r.u16(lo + 26)
  var extraLen = r.u16(lo + 28)
  var start = lo + 30 + nameLen + extraLen
  var end = start + entry.csize
  if (end > r.bytes) throw new Error('ZIP 条目数据越界')

  var raw = r.u8.subarray(start, end)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflate.inflateRaw(raw)
  throw new Error('不支持的 ZIP 压缩方式：' + entry.method)
}

/* ============================ XML ============================ */

/** 简易 XML 元素扫描：返回 [{name, attrs, inner, selfClosed}] */
function scanElements(xml) {
  var out = []
  var re = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  var m
  while ((m = re.exec(xml))) {
    var attrs = {}
    var attrRe = /([\w.:-]+)\s*=\s*"([^"]*)"/g
    var a
    while ((a = attrRe.exec(m[2]))) attrs[a[1]] = xmlUnescape(a[2])
    var selfClosed = m[3] === '/'
    if (selfClosed) {
      out.push({ name: m[1], attrs: attrs, inner: '', selfClosed: true, start: m.index })
      continue
    }
    // 找配对的结束标签（XML 由 Excel 生成，嵌套同名前缀可靠）
    var closeTag = '</' + m[1] + '>'
    var end = xml.indexOf(closeTag, re.lastIndex)
    if (end < 0) {
      out.push({ name: m[1], attrs: attrs, inner: '', selfClosed: false, start: m.index })
      continue
    }
    out.push({
      name: m[1],
      attrs: attrs,
      inner: xml.slice(re.lastIndex, end),
      selfClosed: false,
      start: m.index,
    })
    re.lastIndex = end + closeTag.length
  }
  return out
}

/** 解析 sharedStrings.xml，返回字符串数组 */
function parseSharedStrings(xml) {
  if (!xml) return []
  var list = []
  var siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
  var m
  while ((m = siRe.exec(xml))) {
    var inner = m[1]
    // 注音 rPh 里的 <t> 是拼音标注，要跳过
    inner = inner.replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<rPh[^>]*\/>/g, '')
    var texts = []
    var tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
    var t
    while ((t = tRe.exec(inner))) texts.push(xmlUnescape(t[1]))
    list.push(texts.join(''))
  }
  return list
}

/** "BC12" -> 54（0 基列号） */
function refToCol(ref) {
  var col = 0
  for (var i = 0; i < ref.length; i++) {
    var ch = ref.charCodeAt(i)
    if (ch < 65 || ch > 90) break
    col = col * 26 + (ch - 64)
  }
  return col - 1
}

/** 解析工作表 XML 为二维数组 */
function parseSheetXml(xml, sst) {
  var rows = []
  var rowRe = /<row(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g
  var rm
  while ((rm = rowRe.exec(xml))) {
    var inner = rm[1] || ''
    var cells = []
    var cRe = /<c([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g
    var cm
    while ((cm = cRe.exec(inner))) {
      var attrs = cm[1] || ''
      var body = cm[3] || ''
      var ref = /r="([A-Z]+\d+)"/.exec(attrs)
      var col = ref ? refToCol(ref[1]) : cells.length
      var t = /t="([^"]+)"/.exec(attrs)
      var type = t ? t[1] : 'n'
      var value = readCellValue(type, body, sst)
      // 补齐中间跳过的空单元格
      while (cells.length < col) cells.push('')
      cells[col] = value
    }
    rows.push(cells)
  }
  return rows
}

function readCellValue(type, body, sst) {
  if (type === 'inlineStr') {
    var texts = []
    var tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
    var t
    while ((t = tRe.exec(body))) texts.push(xmlUnescape(t[1]))
    return texts.join('')
  }
  var vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)
  if (!vm) {
    // 公式单元格若无缓存值，尝试 <f> 之后的文本（一般不用）
    return ''
  }
  var raw = xmlUnescape(vm[1])
  if (type === 's') {
    var idx = parseInt(raw, 10)
    return isNaN(idx) ? '' : sst[idx] === undefined ? '' : sst[idx]
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  return raw
}

/* ============================ 对外接口 ============================ */

/**
 * 解析 .xlsx（ZIP + XML）
 * @param {ArrayBuffer} buffer
 * @returns {Array<{name:string, rows:Array<Array>}>}
 */
function parseArrayBuffer(buffer) {
  var entries = readZipEntries(buffer)

  function text(name) {
    var e = entries[name]
    if (!e) return null
    var data = readZipData(buffer, e)
    return data ? utf8ToString(data) : null
  }

  // sharedStrings 可选（内联字符串时可能没有）
  var sst = parseSharedStrings(text('xl/sharedStrings.xml'))

  // rId -> 工作表路径
  var relXml = text('xl/_rels/workbook.xml.rels') || ''
  var relMap = {}
  var relRe = /<Relationship\b([^>]*)\/>/g
  var rel
  while ((rel = relRe.exec(relXml))) {
    var id = /Id="([^"]*)"/.exec(rel[1])
    var target = /Target="([^"]*)"/.exec(rel[1])
    if (id && target) relMap[id[1]] = target[1].replace(/^\/?xl\//, '').replace(/^\.\//, '')
  }

  var wbXml = text('xl/workbook.xml')
  if (!wbXml) throw new Error('xlsx 中找不到工作簿信息')

  var sheets = []
  var sheetRe = /<sheet\b([^>]*)\/>/g
  var sm
  while ((sm = sheetRe.exec(wbXml))) {
    var nameAttr = /name="([^"]*)"/.exec(sm[1])
    var ridAttr = /r:id="([^"]*)"/.exec(sm[1])
    var sheetName = nameAttr ? xmlUnescape(nameAttr[1]) : 'Sheet' + (sheets.length + 1)
    var path = ridAttr ? relMap[ridAttr[1]] : null
    if (!path) {
      // 关系缺失时按顺序兜底
      path = 'worksheets/sheet' + (sheets.length + 1) + '.xml'
    }
    var sheetXml = text('xl/' + path)
    sheets.push({ name: sheetName, rows: sheetXml ? parseSheetXml(sheetXml, sst) : [] })
  }

  if (!sheets.length) throw new Error('xlsx 中没有工作表')
  return sheets
}

module.exports = {
  parse: parseArrayBuffer,
  isZip: isZip,
  readZipEntries: readZipEntries,
  readZipData: readZipData,
  utf8ToString: utf8ToString,
  xmlUnescape: xmlUnescape,
}
