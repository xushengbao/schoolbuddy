const { isSuper, getSession, canImportSchoolData } = require('../../utils/auth')
const {
  listClasses,
  listSchools,
  importClassSchedules,
  importTeacherSchedules,
  importStudents,
  importTeachers,
  importClassAccounts,
} = require('../../utils/school')
const { hashPassword, toast } = require('../../utils/util')
const excel = require('../../utils/excel')

/**
 * 五种导入类型，与学校实际使用的模版一一对应：
 *   class-schedule → 班级课表模版（.xlsx/.xls，每表一个班级，第二行是教师姓名）
 *   teacher-schedule → 教师课表模版（.xls，每表一位教师，第二行是班级名）
 *   students → 学生模版（每表一个班级，学校 / 班级 / 姓名 / 学号）
 *   teachers → 教师账号模版（学校 / 教师姓名 / 组别 / 账号 / 密码）
 *   accounts → 班级账号模版（学校 / 班级 / 账号 / 密码 / 班主任账号）
 */
const CONFIG = {
  'class-schedule': {
    title: '导入班级课表',
    needClass: false,
    tip: '使用「班级课表模版」：每个工作表代表一个班级（也可用表格左上角的班级名），列依次为星期一至星期五，科目行与「时间+教师」行成对出现。',
  },
  'teacher-schedule': {
    title: '导入教师课表',
    needClass: false,
    tip: '使用「教师课表模版」：每个工作表代表一位教师（工作表名即教师姓名），列依次为星期一至星期五，科目行与「时间+班级」行成对出现。需先导入教师账号。',
  },
  students: {
    title: '导入学生名单',
    needClass: false,
    tip: '使用「学生模版」：每个工作表代表一个班级，表头需含 学校 / 班级 / 姓名 / 学号。班级不存在时会自动创建。',
  },
  teachers: {
    title: '导入教师账号',
    needClass: false,
    tip: '使用「教师账号模版」：表头需含 学校 / 教师姓名 / 组别 / 账号 / 密码。密码留空时默认为 123456。',
  },
  accounts: {
    title: '导入班级账号',
    needClass: false,
    tip: '使用「班级账号和密码模版」：表头需含 学校 / 班级 / 账号 / 密码 / 班主任账号。班主任账号填教师账号，用于绑定班主任。',
  },
}

Page({
  data: {
    type: 'schedule',
    title: '',
    tip: '',
    classes: [],
    schools: [],
    schoolId: null,
    isSuper: false,
    fileName: '',
    sheets: null,
    preview: [],
    sheetNames: [],
    busy: false,
    result: null,
  },

  onLoad(options) {
    const type = CONFIG[options.type] ? options.type : 'class-schedule'
    const cfg = CONFIG[type]
    const session = getSession()
    this.setData({
      type,
      title: cfg.title,
      tip: cfg.tip,
      isSuper: isSuper(),
      schoolId: session && session.schoolId ? session.schoolId : null,
    })
  },

  async onShow() {
    // 导入学生 / 班级 / 课表等学校数据，仅学校管理员（或超级管理员）可操作
    if (!canImportSchoolData()) {
      wx.showModal({
        title: '无权限',
        content: '导入学生、班级、课表等数据仅学校管理员可操作',
        showCancel: false,
        success: () => wx.navigateBack(),
      })
      return
    }
    const [classes, schools] = await Promise.all([listClasses(), isSuper() ? listSchools() : Promise.resolve([])])
    this.setData({ classes, schools })
  },

  pickClass(e) {
    this.setData({ classId: Number(e.currentTarget.dataset.id) })
  },

  pickSchool(e) {
    this.setData({ schoolId: Number(e.currentTarget.dataset.id) })
  },

  /**
   * 选择文件：支持 .xls / .xlsx / .csv，三者都交给 utils/excel 统一解析。
   */
  pickFile() {
    const self = this
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xls', 'xlsx', 'csv', 'txt'],
      success(res) {
        const file = res.tempFiles[0]
        const fs = wx.getFileSystemManager()
        fs.readFile({
          filePath: file.path,
          success(out) {
            const buf = out.data
            let sheets = null
            try {
              // xls/xlsx 直接解析；文本类走 utf-8 兜底
              sheets = excel.parse(buf, excel.decodeUtf8(buf))
            } catch (e) {
              toast(e.message || '无法解析该文件')
              return
            }
            self.applySheets(sheets, file.name)
          },
          fail() {
            toast('文件读取失败')
          },
        })
      },
    })
  },

  applySheets(sheets, fileName) {
    if (!sheets || !sheets.length) {
      toast('文件中没有可用的工作表')
      return
    }
    // 过滤空表（模版常带 Sheet2/Sheet3 空白页），但课表类必须全部保留
    const usable = sheets.filter(s => s.rows && s.rows.length)
    if (!usable.length) {
      toast('文件中没有数据行')
      return
    }
    const first = usable[0]
    const preview = (first.rows || []).slice(0, 5)
    const sheetNames = usable.map(s => s.name)
    // 从模版的「学校」列自动带出学校
    let schoolId = this.data.schoolId
    if (first.rows && first.rows.length > 1) {
      const header = (first.rows[0] || []).map(v => String(v || '').trim())
      const si = header.findIndex(h => h === '学校' || h === '学校名称')
      if (si >= 0) {
        const name = String(first.rows[1][si] || '').trim()
        const matched = this.data.schools.find(s => s.name === name)
        if (matched) schoolId = matched.id
      }
    }
    this.setData({ sheets: usable, fileName, preview, sheetNames, schoolId, result: null })
    wx.showToast({ title: '已读取，点击下方开始导入', icon: 'none' })
  },

  async submit() {
    if (this.data.busy) return
    if (!this.data.sheets) {
      toast('请先选择文件')
      return
    }
    const schoolId = this.data.schoolId
    if (this.data.isSuper && !schoolId) {
      toast('请先选择学校')
      return
    }

    this.setData({ busy: true, result: null })
    wx.showLoading({ title: '导入中', mask: true })
    try {
      const sheets = this.data.sheets
      const type = this.data.type
      let result
      if (type === 'class-schedule') {
        result = await importClassSchedules(schoolId, sheets)
      } else if (type === 'teacher-schedule') {
        result = await importTeacherSchedules(schoolId, sheets)
      } else if (type === 'students') {
        result = await importStudents(schoolId, this.data.classId, sheets)
      } else if (type === 'teachers') {
        result = await importTeachers(schoolId, sheets, hashPassword)
      } else {
        result = await importClassAccounts(schoolId, sheets, hashPassword)
      }
      wx.hideLoading()
      this.setData({ result, busy: false })
      toast(result.message)
      if (result.errors && result.errors.length) {
        wx.showModal({
          title: '导入完成，有提示',
          content: result.message + '\n\n' + result.errors.slice(0, 5).join('\n'),
          showCancel: false,
        })
      }
      const classes = await listClasses()
      this.setData({ classes })
    } catch (e) {
      wx.hideLoading()
      this.setData({ busy: false })
      toast(e.message || '导入失败')
    }
  },
})