/**
 * 纯 JS 的 Excel 97-2003（.xls / BIFF8）解析器
 *
 * 为什么需要它：微信小程序只能拿到 ArrayBuffer，.xls 是 OLE2 复合文档二进制，
 * 不能按 utf-8 文本读取。本模块不依赖任何第三方库，只用 ArrayBuffer / DataView。
 *
 * 支持范围（覆盖课表 / 学生 / 教师 / 班级账号模版所需的全部单元格类型）：
 *   OLE2：头解析、DIFAT、FAT 链、目录项、mini-FAT、小流
 *   BIFF8：BOUNDSHEET、SST（含 CONTINUE 跨记录续读）、LABELSST、NUMBER、
 *           RK、MULRK、MULBLANK、BLANK、FORMULA(数值)、LABEL、STRING、RSTRING、
 *           BOOLERR、EOF
 *
 * 对外只暴露 parse(arrayBuffer) -> [{ name, rows }]，rows 是二维数组。
 */

/* ============================ OLE2 复合文档 ============================ */

var SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
var ENDOFCHAIN = 0xfffffffe
var FREESECT = 0xffffffff

function Reader(buffer) {
  this.view = new DataView(buffer)
  this.u8 = new Uint8Array(buffer)
  this.bytes = buffer.byteLength
}

Reader.prototype.u8At = function (off) {
  return this.u8[off]
}
Reader.prototype.u16 = function (off) {
  return this.view.getUint16(off, true)
}
Reader.prototype.u32 = function (off) {
  return this.view.getUint32(off, true)
}
Reader.prototype.i32 = function (off) {
  return this.view.getInt32(off, true)
}
Reader.prototype.f64 = function (off) {
  return this.view.getFloat64(off, true)
}

function checkSignature(r) {
  for (var i = 0; i < 8; i++) {
    if (r.u8[i] !== SIG[i]) return false
  }
  return true
}

/**
 * UTF-16LE 解码。
 * 注意：必须逐字符用 String.fromCharCode 累加；
 * 若把码点 push 进数组再 join('')，会得到 "87111110" 这样的十进制字符串。
 */
function utf16leToString(r, off, byteLen) {
  var s = ''
  for (var i = 0; i + 1 < byteLen; i += 2) s += String.fromCharCode(r.u16(off + i))
  return s
}

/** 目录项名字：UTF-16LE，nLen 含结尾的 0x0000，调用时已减去 2 */
function utf16leFromBytes(bytes, base, byteLen) {
  var s = ''
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (var i = 0; i + 1 < byteLen; i += 2) s += String.fromCharCode(dv.getUint16(base + i, true))
  return s
}

/** 沿 FAT 链取出所有 sector 并拼成一个 Uint8Array */
function chainToBytes(r, fat, startSector, sectorSize) {
  var parts = []
  var total = 0
  var s = startSector
  var guard = 0
  while (s !== ENDOFCHAIN && s !== FREESECT && s < fat.length) {
    var off = 512 + s * sectorSize
    var part = r.u8.subarray(off, off + sectorSize)
    parts.push(part)
    total += part.length
    s = fat[s]
    guard++
    if (guard > 1000000) break
  }
  var out = new Uint8Array(total)
  var pos = 0
  for (var i = 0; i < parts.length; i++) {
    out.set(parts[i], pos)
    pos += parts[i].length
  }
  return out
}

/**
 * 读取某个目录项的完整流内容。
 * BIFF8 的 Workbook 流通常远大于 4096 字节，走大流路径；
 * 小流分支是为兼容只有目录信息的极小文件。
 */
function readStream(r, entry, sectorSize, miniSectorSize, fat, miniFat, miniStreamBytes) {
  if (entry.size < 4096) {
    // 小流：按 mini-FAT 链在 mini stream 中寻址
    var parts = []
    var total = 0
    var s = entry.start
    var guard = 0
    while (s !== ENDOFCHAIN && s !== FREESECT && s < miniFat.length) {
      var off = s * miniSectorSize
      var part = miniStreamBytes.subarray(off, off + miniSectorSize)
      parts.push(part)
      total += part.length
      s = miniFat[s]
      guard++
      if (guard > 1000000) break
    }
    var outMini = new Uint8Array(Math.min(total, entry.size))
    var p = 0
    for (var i = 0; i < parts.length; i++) {
      if (p >= outMini.length) break
      var take = Math.min(parts[i].length, outMini.length - p)
      outMini.set(parts[i].subarray(0, take), p)
      p += take
    }
    return outMini
  }
  var big = chainToBytes(r, fat, entry.start, sectorSize)
  if (big.length <= entry.size) return big
  return big.subarray(0, entry.size)
}

function extractOleStreams(r) {
  var sectorShift = r.u16(0x1e)
  var miniSectorShift = r.u16(0x20)
  var sectorSize = 1 << sectorShift
  var miniSectorSize = 1 << miniSectorShift

  var numFatSectors = r.u32(0x2c)

  // DIFAT：头里 109 个 + 后续 DIFAT sector 链
  var fatSectorIds = []
  for (var i = 0; i < 109 && fatSectorIds.length < numFatSectors; i++) {
    var id = r.u32(0x4c + i * 4)
    if (id === FREESECT || id === ENDOFCHAIN) break
    fatSectorIds.push(id)
  }
  var difatSector = r.u32(0x44)
  var entriesPerSector = sectorSize / 4
  var difatGuard = 0
  while (difatSector !== ENDOFCHAIN && difatSector !== FREESECT && difatGuard < 10000 && fatSectorIds.length < numFatSectors) {
    var base = 512 + difatSector * sectorSize
    for (var j = 0; j < entriesPerSector - 1 && fatSectorIds.length < numFatSectors; j++) {
      var sid = r.u32(base + j * 4)
      if (sid === FREESECT || sid === ENDOFCHAIN) continue
      fatSectorIds.push(sid)
    }
    difatSector = r.u32(base + (entriesPerSector - 1) * 4)
    difatGuard++
  }

  // 组装 FAT。用 Uint32Array：0xFFFFFFFE 等标记值必须保持无符号语义，
  // 若用 Int32Array 会被截断成负数，链遍历会读到垃圾数据。
  var fat = new Uint32Array(fatSectorIds.length * entriesPerSector)
  for (var f = 0; f < fatSectorIds.length; f++) {
    var foff = 512 + fatSectorIds[f] * sectorSize
    for (var k = 0; k < entriesPerSector; k++) {
      fat[f * entriesPerSector + k] = r.u32(foff + k * 4)
    }
  }

  // mini-FAT
  var numMiniFatSectors = r.u32(0x40)
  var miniFat = new Uint32Array(0)
  if (numMiniFatSectors > 0) {
    var mfBytes = chainToBytes(r, fat, r.u32(0x3c), sectorSize)
    var mfv = new DataView(mfBytes.buffer, mfBytes.byteOffset, mfBytes.byteLength)
    var mCount = Math.floor(mfBytes.byteLength / 4)
    miniFat = new Uint32Array(mCount)
    for (var m = 0; m < mCount; m++) miniFat[m] = mfv.getUint32(m * 4, true)
  }

  // 目录项
  var dirBytes = chainToBytes(r, fat, r.u32(0x30), sectorSize)
  var dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength)
  var entries = []
  var entryCount = Math.floor(dirBytes.byteLength / 128)
  for (var e = 0; e < entryCount; e++) {
    var b = e * 128
    var nLen = dv.getUint16(b + 64, true)
    var name = nLen >= 2 ? utf16leFromBytes(dirBytes, b, nLen - 2) : ''
    entries.push({
      name: name,
      type: dirBytes[b + 66],
      start: dv.getUint32(b + 116, true),
      size: dv.getUint32(b + 120, true),
    })
  }

  // 根目录条目即 mini stream 容器
  var root = null
  for (var z = 0; z < entries.length; z++) {
    if (entries[z].type === 5) {
      root = entries[z]
      break
    }
  }
  var miniStreamBytes = new Uint8Array(0)
  if (root && root.size > 0) {
    var ms = chainToBytes(r, fat, root.start, sectorSize)
    miniStreamBytes = ms.length > root.size ? ms.subarray(0, root.size) : ms
  }

  var streams = {}
  for (var q = 0; q < entries.length; q++) {
    var en = entries[q]
    if (en.type !== 2) continue
    if (!en.size) continue
    streams[en.name] = readStream(r, en, sectorSize, miniSectorSize, fat, miniFat, miniStreamBytes)
  }
  return streams
}

/* ============================ BIFF8 记录解析 ============================ */

var REC = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d5,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BLANK: 0x0201,
  MULBLANK: 0x00be,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
}

function recordsOf(bytes) {
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  var out = []
  var pos = 0
  while (pos + 4 <= bytes.byteLength) {
    var op = dv.getUint16(pos, true)
    var len = dv.getUint16(pos + 2, true)
    var start = pos + 4
    if (start + len > bytes.byteLength) len = bytes.byteLength - start
    out.push({ op: op, start: start, len: len })
    pos = start + len
    if (op === REC.EOF) break
  }
  return out
}

function rkToNumber(rk) {
  var isMul100 = rk & 1
  var isInt = rk & 2
  var value
  if (isInt) {
    value = rk >> 2
  } else {
    var buf = new ArrayBuffer(8)
    var v = new DataView(buf)
    v.setUint32(0, 0, true)
    v.setInt32(4, rk & 0xfffffffc, true)
    value = v.getFloat64(0, true)
  }
  if (isMul100) value = value / 100
  return value
}

/** 跨 CONTINUE 记录的分段读取器 */
function SegmentReader(segments) {
  this.segs = segments
  this.si = 0
  this.pos = 0
}
SegmentReader.prototype.nextSegment = function () {
  if (this.si + 1 >= this.segs.length) return false
  this.si++
  this.pos = 0
  return true
}
SegmentReader.prototype.remaining = function () {
  var s = this.segs[this.si]
  return s ? s.byteLength - this.pos : 0
}
SegmentReader.prototype.byte = function () {
  var s = this.segs[this.si]
  if (!s || this.pos >= s.byteLength) return 0
  return s[this.pos++]
}
SegmentReader.prototype.u16 = function () {
  var s = this.segs[this.si]
  if (!s || this.pos + 2 > s.byteLength) {
    this.nextSegment()
    return this.u16()
  }
  var v = (s[this.pos] | (s[this.pos + 1] << 8)) & 0xffff
  this.pos += 2
  return v
}
SegmentReader.prototype.u32 = function () {
  var lo = this.u16()
  var hi = this.u16()
  return (hi << 16) | lo
}
SegmentReader.prototype.skip = function (n) {
  var left = n
  while (left > 0) {
    var rem = this.remaining()
    if (rem <= 0) {
      if (!this.nextSegment()) break
      continue
    }
    var take = Math.min(rem, left)
    this.pos += take
    left -= take
  }
}

/**
 * 读取 SST 中的一个 XLUnicodeRichExtendedString。
 * 关键点：字符串跨 CONTINUE 边界时，新记录首字节是新的 grbit（压缩标志可能变化）。
 */
SegmentReader.prototype.readRichString = function () {
  var cch = this.u16()
  var grbit = this.byte()
  var highByte = grbit & 0x01
  var fExtSt = grbit & 0x04
  var fRichSt = grbit & 0x08
  var cRun = 0
  var cbExt = 0
  if (fRichSt) cRun = this.u16()
  if (fExtSt) cbExt = this.u32()

  var chars = []
  var read = 0
  var guard = 0
  while (read < cch && guard < 1000000) {
    guard++
    if (this.remaining() <= 0) {
      if (!this.nextSegment()) break
      highByte = this.byte() & 0x01
      continue
    }
    var s = this.segs[this.si]
    if (highByte) {
      while (read < cch && this.pos + 2 <= s.byteLength) {
        chars.push(String.fromCharCode(s[this.pos] | (s[this.pos + 1] << 8)))
        this.pos += 2
        read++
      }
    } else {
      while (read < cch && this.pos < s.byteLength) {
        chars.push(String.fromCharCode(s[this.pos]))
        this.pos++
        read++
      }
    }
  }
  if (cRun > 0) this.skip(cRun * 4)
  if (cbExt > 0) this.skip(cbExt)
  return chars.join('')
}

function parseSst(workbookBytes, firstRecord) {
  var segs = []
  var start = firstRecord.start
  var len = Math.min(firstRecord.len, workbookBytes.byteLength - start)
  segs.push(workbookBytes.subarray(start, start + len))

  // 向后收集 CONTINUE
  var recs = recordsOf(workbookBytes)
  var idx = recs.indexOf(firstRecord)
  for (var i = idx + 1; i < recs.length; i++) {
    if (recs[i].op !== REC.CONTINUE) break
    var s = recs[i].start
    var l = Math.min(recs[i].len, workbookBytes.byteLength - s)
    segs.push(workbookBytes.subarray(s, s + l))
  }

  var r = new SegmentReader(segs)
  r.u32() // cstTotal
  var cstUnique = r.u32()
  var out = []
  for (var k = 0; k < cstUnique; k++) {
    if (r.si >= r.segs.length && r.remaining() <= 0) break
    out.push(r.readRichString())
  }
  return out
}

function parseSheet(bytes, sst) {
  var recs = recordsOf(bytes)
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  var cells = {}
  var maxRow = 0
  var maxCol = 0
  var pendingFormula = null

  function put(row, col, val) {
    if (row > maxRow) maxRow = row
    if (col > maxCol) maxCol = col
    cells[row + ':' + col] = val
  }

  for (var i = 0; i < recs.length; i++) {
    var rec = recs[i]
    var p = rec.start
    var len = rec.len
    switch (rec.op) {
      case REC.LABELSST: {
        var row = dv.getUint16(p, true)
        var col = dv.getUint16(p + 2, true)
        var isst = dv.getUint32(p + 6, true)
        put(row, col, sst[isst] === undefined ? '' : sst[isst])
        break
      }
      case REC.RSTRING: {
        var rrow = dv.getUint16(p, true)
        var rcol = dv.getUint16(p + 2, true)
        put(rrow, rcol, readLongString(bytes, p + 6))
        break
      }
      case REC.LABEL: {
        var lrow = dv.getUint16(p, true)
        var lcol = dv.getUint16(p + 2, true)
        put(lrow, lcol, readLongString(bytes, p + 6))
        break
      }
      case REC.NUMBER: {
        var nrow = dv.getUint16(p, true)
        var ncol = dv.getUint16(p + 2, true)
        put(nrow, ncol, dv.getFloat64(p + 6, true))
        break
      }
      case REC.RK: {
        var krow = dv.getUint16(p, true)
        var kcol = dv.getUint16(p + 2, true)
        put(krow, kcol, rkToNumber(dv.getInt32(p + 6, true)))
        break
      }
      case REC.MULRK: {
        var mrow = dv.getUint16(p, true)
        var colFirst = dv.getUint16(p + 2, true)
        var count = Math.floor((len - 6) / 6)
        for (var c = 0; c < count; c++) {
          put(mrow, colFirst + c, rkToNumber(dv.getInt32(p + 4 + c * 6 + 2, true)))
        }
        break
      }
      case REC.BOOLERR: {
        var brow = dv.getUint16(p, true)
        var bcol = dv.getUint16(p + 2, true)
        var isError = dv.getUint8(p + 6)
        var bval = dv.getUint8(p + 7)
        put(brow, bcol, isError ? '#ERR' : bval === 1)
        break
      }
      case REC.BLANK:
      case REC.MULBLANK:
        break
      case REC.FORMULA: {
        var frow = dv.getUint16(p, true)
        var fcol = dv.getUint16(p + 2, true)
        var b1 = dv.getUint8(p + 6)
        var b2 = dv.getUint8(p + 7)
        var b3 = dv.getUint8(p + 8)
        if (b1 === 0xff && b2 === 0xff && b3 === 0xff) {
          // 字符串结果：真正的值在紧随其后的 STRING 记录
          pendingFormula = { row: frow, col: fcol }
        } else {
          put(frow, fcol, dv.getFloat64(p + 6, true))
        }
        break
      }
      case REC.STRING: {
        if (pendingFormula) {
          put(pendingFormula.row, pendingFormula.col, readPlainString(bytes, p, len))
          pendingFormula = null
        }
        break
      }
      case REC.EOF:
        i = recs.length
        break
      default:
        break
    }
  }

  var rows = []
  for (var rr = 0; rr <= maxRow; rr++) {
    var line = []
    for (var cc = 0; cc <= maxCol; cc++) {
      var v = cells[rr + ':' + cc]
      line.push(v === undefined ? '' : v)
    }
    rows.push(line)
  }
  return rows
}

/**
 * 读 BIFF8 的 ShortXLUnicodeString：cch(1) + grbit(1) + rgb。
 * 字符区从 off+2 开始（不是 off+3）。
 * 用于 BOUNDSHEET 的表名。
 */
function readPlainString(bytes, off, len) {
  if (len <= 0) return ''
  var cch = bytes[off]
  var grbit = bytes[off + 1]
  var highByte = grbit & 0x01
  var p = off + 2
  var s = ''
  for (var i = 0; i < cch && p < bytes.byteLength; i++) {
    if (highByte) {
      s += String.fromCharCode(bytes[p] | (bytes[p + 1] << 8))
      p += 2
    } else {
      s += String.fromCharCode(bytes[p])
      p += 1
    }
  }
  return s
}

/**
 * 读 XLUnicodeString（cch 为 2 字节）：用于旧版 LABEL / RSTRING 记录。
 */
function readLongString(bytes, off) {
  if (off + 3 > bytes.byteLength) return ''
  var cch = bytes[off] | (bytes[off + 1] << 8)
  var grbit = bytes[off + 2]
  var highByte = grbit & 0x01
  var p = off + 3
  var s = ''
  for (var i = 0; i < cch && p < bytes.byteLength; i++) {
    if (highByte) {
      s += String.fromCharCode(bytes[p] | (bytes[p + 1] << 8))
      p += 2
    } else {
      s += String.fromCharCode(bytes[p])
      p += 1
    }
  }
  return s
}

/**
 * 解析 Workbook 流，返回 [{name, rows}]
 */
function parseWorkbook(bytes) {
  var recs = recordsOf(bytes)
  var sst = []
  var bounds = []
  var sstRec = null

  for (var i = 0; i < recs.length; i++) {
    if (recs[i].op === REC.SST) {
      sstRec = recs[i]
      break
    }
  }
  if (sstRec) {
    try {
      sst = parseSst(bytes, sstRec)
    } catch (e) {
      sst = []
    }
  }

  for (var j = 0; j < recs.length; j++) {
    if (recs[j].op !== REC.BOUNDSHEET) continue
    var p = recs[j].start
    var lbPlyPos = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(p, true)
    var name = readPlainString(bytes, p + 6, recs[j].len - 6)
    bounds.push({ pos: lbPlyPos, name: name })
  }

  if (!bounds.length) {
    return [{ name: 'Sheet1', rows: parseSheet(bytes, sst) }]
  }

  var out = []
  for (var b = 0; b < bounds.length; b++) {
    var pos = bounds[b].pos
    if (pos + 4 > bytes.byteLength) continue
    // 每个 sheet 从自己的 BOF 开始，截取到下一个 sheet 起点
    var nextPos = b + 1 < bounds.length ? bounds[b + 1].pos : bytes.byteLength
    var slice = bytes.subarray(pos, nextPos)
    out.push({ name: bounds[b].name, rows: parseSheet(slice, sst) })
  }
  return out
}

/* ============================ 对外入口 ============================ */

/** 判断 ArrayBuffer 是否为 OLE2 复合文档 */
function isOle2(buffer) {
  if (!buffer || buffer.byteLength < 8) return false
  for (var i = 0; i < 8; i++) {
    if (new Uint8Array(buffer)[i] !== SIG[i]) return false
  }
  return true
}

/** 判断是否 zip（.xlsx / .csv.gz 等） */
function isZip(buffer) {
  if (!buffer || buffer.byteLength < 4) return false
  var u = new Uint8Array(buffer)
  return u[0] === 0x50 && u[1] === 0x4b && u[2] === 0x03 && u[3] === 0x04
}

/**
 * 解析 Excel 97-2003 二进制内容
 * @param {ArrayBuffer} buffer
 * @returns {Array<{name:string, rows:Array<Array>}>}
 */
function parseArrayBuffer(buffer) {
  var r = new Reader(buffer)
  if (!checkSignature(r)) throw new Error('不是 Excel 97-2003 (.xls) 文件')
  var streams = extractOleStreams(r)
  var wb = streams['Workbook'] || streams['Book']
  if (!wb) throw new Error('文件中找不到工作簿数据')
  return parseWorkbook(wb)
}

module.exports = {
  parse: parseArrayBuffer,
  isOle2: isOle2,
  isZip: isZip,
}