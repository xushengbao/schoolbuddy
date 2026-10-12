const { isAdmin } = require('../../utils/auth')
const { loadStudentStatusOptions, saveStudentStatusOptions } = require('../../utils/school')
const { toast } = require('../../utils/util')

Page({
  data: {
    options: [],
    draft: '',
  },

  onShow() {
    if (!isAdmin()) {
      wx.showModal({
        title: '无权限',
        content: '该功能仅管理员可访问',
        showCancel: false,
        success: () => wx.navigateBack(),
      })
      return
    }
    this.load()
  },

  async load() {
    const options = await loadStudentStatusOptions()
    if (!options.includes('正常')) options.unshift('正常')
    this.setData({ options })
  },

  onInput(e) {
    this.setData({ draft: e.detail.value })
  },

  add() {
    const v = String(this.data.draft || '').trim()
    if (!v) {
      toast('请输入状态名称')
      return
    }
    if (this.data.options.includes(v)) {
      toast('该选项已存在')
      return
    }
    this.setData({ options: this.data.options.concat(v), draft: '' })
  },

  del(e) {
    const v = e.currentTarget.dataset.v
    this.setData({ options: this.data.options.filter(o => o !== v) })
  },

  async save() {
    try {
      await saveStudentStatusOptions(this.data.options)
      toast('已保存')
    } catch (e) {
      toast(e.message || '保存失败')
    }
  },
})