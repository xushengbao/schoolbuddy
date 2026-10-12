// 小程序基础库没有全局 URL / URLSearchParams，SDK 内部 new URL(endpoint) 会误报
// 「endpoint must be an absolute URL」。
// 主修复：vendor-workbuddy-cloud-sdk.js 内已由 patch-sdk-url.js 注入模块级 URL 声明
// （模块作用域遮蔽全局，不依赖全局注入，在小程序里才真正可靠）。
// 这里再补一次全局，仅作为浏览器 / 新基础库场景的双保险。
require('./url-polyfill').ensureUrlPolyfill()

const { createMiniProgramWorkBuddyCloud } = require('./vendor-workbuddy-cloud-sdk')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

// publicConfig 由云服务开通后返回，属于该应用的公开配置。
const publicConfig = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_aiyE8JhmdDNyW3mu4eqiUr_XuzRusGbX4gh5PTNJezHh72JypfWzh5G',
}

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  wx: createDiagnosticWx(wx),
})

module.exports = { cloud, publicConfig }