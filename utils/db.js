const { cloud } = require('./cloud')

/** 把 {data,error} 信封转成结果，失败时抛出可读错误 */
function unwrap(res, fallbackMessage) {
  if (res && res.error) {
    const err = new Error(res.error.message || fallbackMessage || '数据操作失败')
    err.code = res.error.code
    throw err
  }
  return res ? res.data : null
}

function db() {
  return cloud.database
}

async function findOne(table, filters) {
  let q = db().from(table).select('*')
  Object.keys(filters || {}).forEach(k => {
    q = q.eq(k, filters[k])
  })
  const rows = unwrap(await q.limit(1), '查询失败')
  return rows && rows.length ? rows[0] : null
}

/** order: {column, ascending}；limit: 只取前 N 条（用于轮询最新消息这类轻量查询） */
async function findAll(table, filters, order, limit) {
  let q = db().from(table).select('*')
  Object.keys(filters || {}).forEach(k => {
    q = q.eq(k, filters[k])
  })
  if (order) q = q.order(order.column, { ascending: order.ascending !== false })
  if (limit) q = q.limit(limit)
  return unwrap(await q, '查询失败') || []
}

async function insert(table, row) {
  const rows = unwrap(await db().from(table).insert(row).select(), '保存失败')
  return rows && rows.length ? rows[0] : null
}

async function insertMany(table, rows) {
  if (!rows || !rows.length) return []
  return unwrap(await db().from(table).insert(rows).select(), '批量保存失败') || []
}

async function update(table, filters, patch) {
  let q = db().from(table).update(patch)
  Object.keys(filters).forEach(k => {
    q = q.eq(k, filters[k])
  })
  const rows = unwrap(await q.select(), '更新失败')
  return rows && rows.length ? rows : []
}

async function remove(table, filters) {
  let q = db().from(table).delete()
  Object.keys(filters).forEach(k => {
    q = q.eq(k, filters[k])
  })
  const rows = unwrap(await q.select(), '删除失败')
  return rows && rows.length ? rows : []
}

async function upsertSetting(key, value) {
  const existing = await findOne('settings', { key })
  if (existing) {
    await update('settings', { key }, { value })
    return
  }
  await insert('settings', { key, value })
}

async function getSetting(key, fallback) {
  const row = await findOne('settings', { key })
  if (!row || row.value === undefined || row.value === null) return fallback
  return row.value
}

async function getJsonSetting(key, fallback) {
  const raw = await getSetting(key, null)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw)
  } catch (e) {
    return fallback
  }
}

module.exports = {
  cloud,
  db,
  unwrap,
  findOne,
  findAll,
  insert,
  insertMany,
  update,
  remove,
  upsertSetting,
  getSetting,
  getJsonSetting,
}