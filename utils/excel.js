/**
 * 导入用的统一表格读取入口。
 *
 * 三种来源统一成 [{ name, rows }]，rows 是二维数组：
 *   .xls   → OLE2 + BIFF8（utils/xls.js）
 *   .xlsx  → ZIP + XML（utils/xlsx.js）
 *   .csv/.txt → 分隔文本
 *
 * 调用方不必再关心用户到底存的哪种格式。
 */

var xls = require('./xls')
var xlsx = require('./xlsx')

/** 判断是不是 zip（.xlsx） */
function isZip(buffer) {
  return xlsx.isZip(buffer)
}

/** 判断是不是 OLE2（.xls） */
function isOle2(buffer) {
  return xls.isOle2(buffer)
}

/**
 * 读取 ArrayBuffer，自动识别格式。
 * .xls / .xlsx 走二进制解析；其余按 UTF-8 文本（CSV / TSV）处理。
 * @param {ArrayBuffer} buffer
 * @param {string=} textFallback 二进制无法识别时优先尝试的文本内容
 * @returns {Array<{name,rows}>}
 */
function parseBuffer(buffer, textFallback) {
  if (buffer && xls.isOle2(buffer)) return xls.parse(buffer)
  if (buffer && xlsx.isZip(buffer)) return xlsx.parse(buffer)
  if (typeof textFallback === 'string') {
    const sheets = textToSheets(textFallback)
    if (sheets.length) return sheets
  }
  if (buffer && buffer.byteLength) {
    const sheets = textToSheets(decodeUtf8(buffer))
    if (sheets.length) return sheets
  }
  throw new Error('不支持的文件格式，请使用 .xls / .xlsx / .csv')
}

/**
 * 从 ArrayBuffer 解码 UTF-8 文本（用于 CSV）。
 * 小程序运行环境不一定有 TextDecoder，所以自带解码器，按需走原生实现。
 */
function decodeUtf8(buffer) {
  var u8 = new Uint8Array(buffer)
  if (typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('utf-8').decode(u8)
    } catch (e) {
      /* 落到手写实现 */
    }
  }
  var s = ''
  var i = 0
  while (i < u8.length) {
    var b = u8[i]
    if (b < 0x80) {
      s += String.fromCharCode(b)
      i++
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < u8.length) {
      s += String.fromCharCode(((b & 0x1f) << 6) | (u8[i + 1] & 0x3f))
      i += 2
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < u8.length) {
      s += String.fromCharCode(((b & 0x0f) << 12) | ((u8[i + 1] & 0x3f) << 6) | (u8[i + 2] & 0x3f))
      i += 3
    } else if (b >= 0xf0 && i + 3 < u8.length) {
      var cp =
        ((b & 0x07) << 18) | ((u8[i + 1] & 0x3f) << 12) | ((u8[i + 2] & 0x3f) << 6) | (u8[i + 3] & 0x3f)
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

/** CSV / TSV 文本转成与 xls/xlsx 解析器一致的 [{name, rows}] 结构 */
function textToSheets(text) {
  var raw = String(text || '').replace(/^\uFEFF/, '')
  if (!raw.trim()) return []
  var lines = raw.split(/\r\n|\n|\r/).filter(function (l) {
    return l.length
  })
  if (!lines.length) return []
  // 优先制表符，其次逗号；都没有就整行当一列
  var delim = lines[0].indexOf('\t') >= 0 ? '\t' : lines[0].indexOf(',') >= 0 ? ',' : ''
  var rows = lines.map(function (line) {
    return delim ? splitCsvLine(line, delim) : [line]
  })
  return [{ name: 'Sheet1', rows: rows }]
}

/** 支持引号包裹的 CSV 字段 */
function splitCsvLine(line, delim) {
  var out = []
  var cur = ''
  var inQuote = false
  for (var i = 0; i < line.length; i++) {
    var ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuote = true
    } else if (ch === delim) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

module.exports = {
  parse: parseBuffer,
  isOle2: isOle2,
  isZip: isZip,
  textToSheets: textToSheets,
  splitCsvLine: splitCsvLine,
  decodeUtf8: decodeUtf8,
}
