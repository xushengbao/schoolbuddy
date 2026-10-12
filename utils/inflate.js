/**
 * 纯 JS 的 DEFLATE 解压器（RFC 1951）
 *
 * 为什么需要它：.xlsx 本质是 ZIP，而 ZIP 里的条目用的是 DEFLATE 压缩。
 * 微信小程序没有 zlib / pako / fflate，只能自己解。
 *
 * 算法采用 Douglas Crock 的 puff 参考实现思路：
 *   - 不建完整查表，而是按码长逐位读并与 count[] 比较（canonical Huffman）
 *   - 对本项目 20~50KB 的课表文件，性能完全够用，且代码量小不易出错
 *
 * 只支持 raw DEFLATE（ZIP method=8），不支持 zlib 头（method 里已经区分）。
 */

/* 固定 Huffman 表：字面量/长度码 */
var LBASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258,
]
var LEXT = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0,
]
var DBASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
var DEXT = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
/* 码长表的传输顺序 */
var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/**
 * @param {Uint8Array} src 压缩数据
 * @returns {Uint8Array} 解压后的数据
 */
function inflateRaw(src) {
  var pos = 0
  var bitBuf = 0
  var bitCnt = 0
  var out = new Uint8Array(Math.max(1024, src.length * 4))
  var outLen = 0

  function grow(need) {
    if (outLen + need <= out.length) return
    var cap = out.length
    while (cap < outLen + need) cap *= 2
    var nb = new Uint8Array(cap)
    nb.set(out.subarray(0, outLen))
    out = nb
  }

  function bits(need) {
    var val = bitBuf
    while (bitCnt < need) {
      if (pos >= src.length) throw new Error('压缩数据意外结束')
      val |= src[pos++] << bitCnt
      bitCnt += 8
    }
    bitBuf = val >>> need
    bitCnt -= need
    return val & ((1 << need) - 1)
  }

  function emit(b) {
    grow(1)
    out[outLen++] = b
  }

  /** canonical Huffman：逐位读码，与 count[] 比较后返回符号 */
  function decode(h) {
    var code = 0
    var first = 0
    var index = 0
    for (var len = 1; len <= 15; len++) {
      code |= bits(1)
      var count = h.count[len]
      if (code - count < first) return h.symbol[index + (code - first)]
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error('无效的 Huffman 编码')
  }

  function buildHuffman(lengths, n) {
    var count = new Int32Array(16)
    for (var i = 0; i < n; i++) count[lengths[i]]++
    count[0] = 0
    var offs = new Int32Array(16)
    for (var len = 1; len < 16; len++) offs[len] = offs[len - 1] + count[len - 1]
    var symbol = new Int32Array(n)
    for (var s = 0; s < n; s++) {
      if (lengths[s]) symbol[offs[lengths[s]]++] = s
    }
    return { count: count, symbol: symbol }
  }

  function stored() {
    // 丢弃不足一字节的位
    bitBuf = 0
    bitCnt = 0
    if (pos + 4 > src.length) throw new Error('压缩数据意外结束')
    var len = src[pos] | (src[pos + 1] << 8)
    pos += 4 // 跳过 LEN 和 NLEN
    if (pos + len > src.length) throw new Error('压缩数据意外结束')
    grow(len)
    out.set(src.subarray(pos, pos + len), outLen)
    outLen += len
    pos += len
  }

  function codes(lencode, distcode) {
    for (;;) {
      var sym = decode(lencode)
      if (sym < 256) {
        emit(sym)
      } else if (sym === 256) {
        break
      } else {
        sym -= 257
        if (sym >= 29) throw new Error('无效的长度码')
        var len = LBASE[sym] + bits(LEXT[sym])
        var dsym = decode(distcode)
        if (dsym >= 30) throw new Error('无效的距离码')
        var dist = DBASE[dsym] + bits(DEXT[dsym])
        if (dist > outLen) throw new Error('距离超出已解压数据')
        grow(len)
        var from = outLen - dist
        for (var i = 0; i < len; i++) out[outLen++] = out[from + i]
      }
    }
  }

  function fixedTables() {
    var lit = new Uint8Array(288)
    var i = 0
    for (; i < 144; i++) lit[i] = 8
    for (; i < 256; i++) lit[i] = 9
    for (; i < 280; i++) lit[i] = 7
    for (; i < 288; i++) lit[i] = 8
    var dist = new Uint8Array(30)
    for (i = 0; i < 30; i++) dist[i] = 5
    return {
      lencode: buildHuffman(lit, 288),
      distcode: buildHuffman(dist, 30),
    }
  }

  function dynamicTables() {
    var nlen = bits(5) + 257
    var ndist = bits(5) + 1
    var ncode = bits(4) + 4
    if (nlen > 286 || ndist > 30) throw new Error('码表长度非法')

    var lengths = new Uint8Array(320)
    var i = 0
    for (; i < ncode; i++) lengths[CLORDER[i]] = bits(3)
    var clcode = buildHuffman(lengths, 19)

    var index = 0
    while (index < nlen + ndist) {
      var sym = decode(clcode)
      var len
      if (sym < 16) {
        lengths[index++] = sym
      } else {
        len = 0
        if (sym === 16) {
          if (index === 0) throw new Error('重复码无前导')
          len = lengths[index - 1]
          sym = 3 + bits(2)
        } else if (sym === 17) {
          sym = 3 + bits(3)
        } else {
          sym = 11 + bits(7)
        }
        if (index + sym > nlen + ndist) throw new Error('码表溢出')
        while (sym--) lengths[index++] = len
      }
    }
    if (lengths[256] === 0) throw new Error('缺少块结束码')

    return {
      lencode: buildHuffman(lengths.subarray(0, nlen), nlen),
      distcode: buildHuffman(lengths.subarray(nlen, nlen + ndist), ndist),
    }
  }

  var fixed = null
  for (;;) {
    var last = bits(1)
    var type = bits(2)
    if (type === 0) {
      stored()
    } else if (type === 1) {
      if (!fixed) fixed = fixedTables()
      codes(fixed.lencode, fixed.distcode)
    } else if (type === 2) {
      var t = dynamicTables()
      codes(t.lencode, t.distcode)
    } else {
      throw new Error('保留的压缩块类型')
    }
    if (last) break
  }

  return out.subarray(0, outLen)
}

module.exports = { inflateRaw: inflateRaw }
