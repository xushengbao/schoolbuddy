const { getSession } = require('../../utils/auth')
const { insert, update, remove, findAll } = require('../../utils/db')
const { today, toast } = require('../../utils/util')

Page({
  data: {
    draft: '',
    items: [],
  },

  onShow() {
    this.load()
  },

  ownerId() {
    const session = getSession()
    if (!session) return null
    return session.role === 'class' ? -session.classId : session.teacherId
  },

  async load() {
    const owner = this.ownerId()
    if (!owner) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const rows = await findAll('memos', { owner_id: owner }, { column: 'id', ascending: true })
    this.setData({ items: rows })
  },

  onInput(e) {
    this.setData({ draft: e.detail.value })
  },

  async add() {
    const content = String(this.data.draft || '').trim()
    if (!content) {
      toast('请输入备忘内容')
      return
    }
    await insert('memos', {
      owner_id: this.ownerId(),
      day: today(),
      content,
      done: false,
    })
    this.setData({ draft: '' })
    toast('已添加')
    this.load()
  },

  async toggle(e) {
    const id = Number(e.currentTarget.dataset.id)
    const done = !!e.currentTarget.dataset.done
    await update('memos', { id }, { done: !done })
    this.load()
  },

  async del(e) {
    const id = Number(e.currentTarget.dataset.id)
    await remove('memos', { id })
    this.load()
  },

  async clearDone() {
    const doneItems = this.data.items.filter(i => i.done)
    if (!doneItems.length) {
      toast('没有已完成的备忘')
      return
    }
    for (const item of doneItems) {
      await remove('memos', { id: item.id })
    }
    toast('已清除')
    this.load()
  },
})