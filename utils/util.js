const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function toDateStr(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function today() {
  return toDateStr(new Date())
}

function nowTime() {
  const d = new Date()
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 星期几：周一=1 … 周日=7（与作息表 weekday 字段一致） */
function weekdayOf(date) {
  const w = date.getDay()
  return w === 0 ? 7 : w
}

function weekdayOfStr(day) {
  const d = new Date(day + 'T00:00:00')
  if (isNaN(d.getTime())) return 1
  return weekdayOf(d)
}

function weekdayName(weekday) {
  return WEEK_NAMES[weekday % 7]
}

function formatDay(day) {
  const d = new Date(day + 'T00:00:00')
  if (isNaN(d.getTime())) return day
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_NAMES[d.getDay()]
}

/** 短日期：10月12日 周一 */
function shortDay(day) {
  const d = new Date(day + 'T00:00:00')
  if (isNaN(d.getTime())) return day
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_NAMES[d.getDay()]
}

/**
 * 科目简称：课表格子里空间有限，「道德与法治」这类长科目压成两个字。
 * 只做精确映射，不做模糊截断，避免把「语文」截成「语」这类误伤。
 */
const SUBJECT_SHORT = {
  体育与健康: '体育',
  道德与法治: '道法',
  信息科技: '信科',
  综合实践活动: '综合',
  劳动: '劳动',
  科学: '科学',
}

function shortSubject(subject) {
  const s = String(subject || '').trim()
  if (!s) return ''
  return SUBJECT_SHORT[s] || (s.length > 4 ? s.slice(0, 2) : s)
}

/**
 * 班级简称：课表格子窄，「三年1班」放不下。
 * 去掉年级前缀留「1班」；没有数字就直接截前两个字。
 * 「三年1班」→「1班」，「五年级(2)班」→「(2)班」，「一年级甲班」→「甲班」
 */
function shortClassName(name) {
  const s = String(name || '').trim()
  if (!s) return ''
  if (s.length <= 3) return s
  // 找第一个数字或括号，前面全是年级/序数前缀
  const idx = s.search(/[0-9０-９(（]/)
  if (idx > 0) {
    const tail = s.slice(idx)
    if (tail.length >= 2 && tail.length <= 4) return tail
    return tail.slice(0, 3)
  }
  return s.slice(-2)
}

/**
 * 生成未来 n 天的日期选项（用于「选未来两周内的哪一天」）。
 * 返回 [{ date:'2026-10-12', weekday:1, label:'今天', sub:'10月12日 周一' }, ...]
 */
function upcomingDays(n, startDate) {
  const out = []
  const base = startDate || today()
  for (let i = 0; i < (n || 10); i++) {
    const day = shiftDay(base, i)
    out.push({
      date: day,
      weekday: weekdayOfStr(day),
      label: i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : weekdayName(weekdayOfStr(day)),
      sub: shortDay(day),
    })
  }
  return out
}

function shiftDay(day, delta) {
  const d = new Date(day + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return toDateStr(d)
}

/** 轻量口令散列：小程序端无bcrypt，用于避免明文存储 */
function hashPassword(text) {
  const s = 'sb$' + String(text || '')
  let h1 = 0
  let h2 = 5381
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = (h1 * 31 + c) | 0
    h2 = ((h2 << 5) + h2 + c) | 0
  }
  return 'h' + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}

function splitCsvLine(line) {
  const cells = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',' || ch === '\t') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells.map(c => c.trim())
}

/**
 * 解析 CSV / 由 Excel 复制粘贴的制表符文本。
 * 第一行作为表头，返回对象数组。
 */
function parseTable(text) {
  if (!text) return []
  const lines = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(l => l.trim() !== '')
  if (!lines.length) return []

  const headers = splitCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, ''))
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    if (!cells.some(c => c !== '')) continue
    const row = {}
    headers.forEach((h, idx) => {
      row[h] = cells[idx] === undefined ? '' : cells[idx]
    })
    rows.push(row)
  }
  return rows
}

/** 在表头里按候选名查找字段，兼容不同 Excel 表头写法 */
function pick(row, candidates) {
  for (const name of candidates) {
    if (row[name] !== undefined && row[name] !== '') return String(row[name]).trim()
  }
  const keys = Object.keys(row)
  for (const name of candidates) {
    const hit = keys.find(k => k.replace(/\s/g, '') === name)
    if (hit && row[hit] !== '') return String(row[hit]).trim()
  }
  return ''
}

function toast(title, icon) {
  wx.showToast({ title: String(title || ''), icon: icon || 'none', duration: 1800 })
}

function loading(title) {
  wx.showLoading({ title: title || '处理中', mask: true })
}

function hideLoading() {
  wx.hideLoading()
}

module.exports = {
  WEEK_NAMES,
  SUBJECT_SHORT,
  pad,
  today,
  nowTime,
  toDateStr,
  weekdayOf,
  weekdayOfStr,
  weekdayName,
  formatDay,
  shortDay,
  shortSubject,
  shortClassName,
  upcomingDays,
  shiftDay,
  hashPassword,
  splitCsvLine,
  parseTable,
  pick,
  toast,
  loading,
  hideLoading,
}