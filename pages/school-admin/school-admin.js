const { isSuper, getSession, logout } = require('../../utils/auth')
const {
  listSchools,
  listSchoolsWithAdmins,
  listSchoolAdmins,
  importSchoolsWithAdmins,
  ensureSchool,
  importSchoolAdmins,
} = require('../../utils/school')
const { hashPassword, toast } = require('../../utils/util')
const excel = require('../../utils/excel')

Page({
  data: {
    session: {},
    schools: [],
    admins: [],
    loading: false,
    busy: false,
    // 学校 + 管理员 一体化导入
    fileName: '',
    sheets: null,
    preview: [],
    sheetNames: [],
    result: null,
    // 手动新建学校
    newName: '',
    // 指定已有教师为管理员
    selectedSchoolId: null,
    selectedIndex: -1,
    selectedSchoolName: '',
    adminAccounts: '',
  },

  async onShow() {
    if (!isSuper()) {
      wx.showModal({
        title: '无权限',
        content: '学校配置仅超级管理员可操作',
        showCancel: false,
        success: () => wx.reLaunch({ url: '/pages/index/index' }),
      })
      return
    }
    const session = getSession()
    if (session) this.setData({ session })
    await this.loadSchools()
    await this.loadAdmins()
  },

  async loadSchools() {
    this.setData({ loading: true })
    try {
      // 一次拿到学校与各校管理员，学校名与管理员账号始终一致
      const rows = await listSchoolsWithAdmins()
      let selected = this.data.selectedSchoolId
      if (selected && !rows.some(s => s.id === selected)) selected = null
      if (!selected && rows.length) selected = rows[0].id
      const idx = selected ? rows.findIndex(s => s.id === selected) : -1
      this.setData({
        schools: rows,
        selectedSchoolId: selected,
        selectedIndex: idx,
        selectedSchoolName: idx >= 0 ? rows[idx].name : '',
        admins: idx >= 0 ? rows[idx].admins : [],
        loading: false,
      })
    } catch (e) {
      this.setData({ loading: false })
      toast(e.message || '读取学校列表失败')
    }
  },

  /** 刷新所选学校的管理员账号 */
  async loadAdmins() {
    const sid = this.data.selectedSchoolId
    if (!sid) {
      this.setData({ admins: [] })
      return
    }
    const school = this.data.schools.find(s => s.id === sid)
    if (school && Array.isArray(school.admins)) {
      this.setData({ admins: school.admins })
      return
    }
    try {
      const admins = await listSchoolAdmins(sid)
      this.setData({ admins })
    } catch (e) {
      this.setData({ admins: [] })
      toast(e.message || '读取管理员账号失败')
    }
  },

  pickSchool(e) {
    this.setData({ selectedSchoolId: Number(e.currentTarget.dataset.id) })
    this.loadAdmins()
  },

  onNameInput(e) {
    this.setData({ newName: e.detail.value })
  },

  onAdminsInput(e) {
    this.setData({ adminAccounts: e.detail.value })
  },

  /**
   * 选择「学校模版」：一行同时给出 学校 / 管理员 / 组别 / 账号 / 密码，
   * 读取后先预览再由用户确认导入。支持 .xls / .xlsx / .csv。
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
              sheets = excel.parse(buf, excel.decodeUtf8(buf))
            } catch (err) {
              toast(err.message || '无法解析该文件')
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
    // 跳过空工作表，找到第一个有表头的工作表
    const usable = sheets.filter(s => s.rows && s.rows.length > 1)
    if (!usable.length) {
      toast('文件中没有数据行')
      return
    }
    this.setData({
      sheets: usable,
      fileName,
      preview: usable[0].rows.slice(0, 6),
      sheetNames: usable.map(s => s.name),
      result: null,
    })
  },

  /** 确认导入学校与学校管理员 */
  async onSubmit() {
    if (this.data.busy) return
    if (!this.data.sheets) {
      toast('请先选择学校模版文件')
      return
    }
    this.setData({ busy: true })
    wx.showLoading({ title: '导入中', mask: true })
    try {
      const res = await importSchoolsWithAdmins(this.data.sheets, hashPassword)
      wx.hideLoading()
      this.setData({ busy: false, result: res })
      toast(res.message)
      if (res.imported) {
        this.setData({ sheets: null, fileName: '', preview: [], sheetNames: [], adminAccounts: '' })
      }
      await this.loadSchools()
      await this.loadAdmins()
    } catch (e) {
      wx.hideLoading()
      this.setData({ busy: false })
      toast(e.message || '导入失败')
    }
  },

  /** 只建学校，不建管理员 */
  async onCreateSchool() {
    if (this.data.busy) return
    const name = String(this.data.newName || '').trim()
    if (!name) {
      toast('请输入学校名称')
      return
    }
    this.setData({ busy: true })
    try {
      const list = await listSchools()
      if (list.some(s => s.name === name)) {
        toast('该学校已存在')
      } else {
        await ensureSchool(name)
        this.setData({ newName: '' })
        await this.loadSchools()
        toast('学校已创建')
      }
    } catch (e) {
      toast(e.message || '创建失败')
    } finally {
      this.setData({ busy: false })
    }
  },

  /** 把选中学校内的已有教师账号设为学校管理员 */
  async onGrantAdmin() {
    if (this.data.busy) return
    const sid = this.data.selectedSchoolId
    if (!sid) {
      toast('请先选择学校')
      return
    }
    const accounts = String(this.data.adminAccounts || '')
      .split(/[\s,，、;；]+/)
      .map(s => s.trim())
      .filter(Boolean)
    if (!accounts.length) {
      toast('请填写教师账号，多个用换行或逗号分隔')
      return
    }
    this.setData({ busy: true })
    try {
      const res = await importSchoolAdmins(sid, accounts, hashPassword)
      toast(res.message)
      if (res.imported) this.setData({ adminAccounts: '' })
      await this.loadAdmins()
    } catch (e) {
      toast(e.message || '设置失败')
    } finally {
      this.setData({ busy: false })
    }
  },

  /** 复制管理员账号，便于传达给学校 */
  copyAccount(e) {
    const account = e.currentTarget.dataset.account
    if (!account) return
    wx.setClipboardData({
      data: account,
      success: () => toast('已复制账号 ' + account),
    })
  },

  goProfile() {
    const session = this.data.session
    wx.showModal({
      title: (session && session.name) + '（超级管理员）',
      content: '账号：' + (session && session.account),
      showCancel: false,
    })
  },

  /** 超级管理员退出登录 */
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出超级管理员账号吗？',
      success: r => {
        if (!r.confirm) return
        logout()
        wx.reLaunch({ url: '/pages/login/login' })
      },
    })
  },
})