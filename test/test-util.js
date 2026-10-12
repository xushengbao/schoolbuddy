/**
 * 工具函数测试：科目简称、未来两周日期展开、两节课描述
 */
const util = require('../utils/util')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '　→ ' + extra : ''))
  }
}

console.log('\n[A] 科目简称：长科目压成两字')
check('体育与健康 → 体育', util.shortSubject('体育与健康') === '体育', util.shortSubject('体育与健康'))
check('道德与法治 → 道法', util.shortSubject('道德与法治') === '道法', util.shortSubject('道德与法治'))
check('信息科技 → 信科', util.shortSubject('信息科技') === '信科', util.shortSubject('信息科技'))
check('综合实践活动 → 综合', util.shortSubject('综合实践活动') === '综合', util.shortSubject('综合实践活动'))
check('两字科目原样保留（语文）', util.shortSubject('语文') === '语文', util.shortSubject('语文'))
check('三字科目保留（科学/美术/音乐）', util.shortSubject('科学') === '科学' && util.shortSubject('音乐') === '音乐')
check('简称不超过两个字', ['体育与健康', '道德与法治', '信息科技', '综合实践活动', '语文', '科学']
  .every(s => util.shortSubject(s).length <= 2))
check('空值安全', util.shortSubject('') === '' && util.shortSubject(null) === '')

console.log('\n[B] 未来两周日期展开')
const base = '2026-10-09' // 周五
const days = util.upcomingDays(10, base)
check('生成 10 个日期', days.length === 10, String(days.length))
check('首个是今天', days[0].date === base && days[0].label === '今天')
check('第 2 个是明天', days[1].date === '2026-10-10' && days[1].label === '明天', days[1].date + '/' + days[1].label)
check('第 3 个是后天', days[2].date === '2026-10-11' && days[2].label === '后天')
check('第 4 个起按星期命名', days[3].label === '周一', days[3].label)
check('weekday 与日期一致（2026-10-12 是周一）',
  days.filter(d => d.date === '2026-10-12').every(d => d.weekday === 1),
  JSON.stringify(days.filter(d => d.date === '2026-10-12')))
check('跨周连续（10-09 周五 → 10-10 周六 → 10-11 周日 → 10-12 周一）',
  days[0].weekday === 5 && days[1].weekday === 6 && days[2].weekday === 7 && days[3].weekday === 1,
  days.slice(0, 4).map(d => d.weekday).join(','))
// 课表按 weekday 排课，同一星期在两周内会出现两次（同一天那格课的重复行）
check('同一星期出现两次（周五在 10-09 与 10-16）',
  days.filter(d => d.weekday === 5).length === 2 && days.filter(d => d.weekday === 6).length === 2,
  '周五' + days.filter(d => d.weekday === 5).length + '次 周六' + days.filter(d => d.weekday === 6).length + '次')
check('窗口末日不越出 10 天', days[9].date === '2026-10-18', days[9].date)
check('sub 含月日与星期', days[3].sub === '10月12日 周一', days[3].sub)

console.log('\n[C] 短日期')
check('shortDay 格式', util.shortDay('2026-10-12') === '10月12日 周一', util.shortDay('2026-10-12'))
check('非法输入原样返回', util.shortDay('abc') === 'abc')

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n')
process.exit(fail ? 1 : 0)