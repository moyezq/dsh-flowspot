/**
 * dsh-flowspot 宿主侧入口。
 *
 * 每个进程只组装一次：MITM 代理、证书颁发机构、Windows 系统代理控制器与 flow
 * 存储都放在同一个 runtime 里，所以两个会话（或者面板加一次工具调用）共用同一份
 * 抓包缓冲，也不会互相抢监听端口。
 *
 * runtime 是懒建的：从没碰过本插件的 profile 不付任何代价；Windows 工具缺失时
 * 也只让真正用到它的那次调用失败，而不是整个插件加载失败。
 */

import { mountRoutes } from './lib/routes.js'
import { createRuntime } from './lib/runtime.js'
import { registerTools } from './lib/tools.js'

export const name = 'dsh-flowspot'

function makeLogger(ctx) {
  const raw = ctx && ctx.logger
  const noop = () => {}
  const has = (level) => raw && typeof raw[level] === 'function'
  const level = (name, fallback) => (has(name) ? raw[name].bind(raw) : has(fallback) ? raw[fallback].bind(raw) : noop)
  return {
    debug: level('debug', 'info'),
    info: level('info', 'log'),
    warn: level('warn', 'info'),
    error: level('error', 'warn'),
  }
}

/**
 * 插件入口，做三件事：接线日志、注册 HTTP 路由、注册 agent 工具，最后挂上
 * 卸载时的收尾 effect。
 * @param {object} ctx 宿主上下文
 * @param {object} [config] 插件配置，含义见 lib/runtime.js 的 DEFAULTS
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx)
  let runtime = null
  let runtimeError = null

  // 懒建 runtime：建好就复用；建失败也把错误记住，后面每次调用直接抛同一个错，
  // 不会反复重试初始化（尤其 Windows 工具缺失时）。
  const getRuntime = () => {
    if (runtime) return runtime
    if (runtimeError) throw runtimeError
    try {
      runtime = createRuntime(config, { log })
      log.info(`[dsh-flowspot] 已初始化，数据目录 ${runtime.dir}`)
      return runtime
    } catch (err) {
      runtimeError = err
      log.error(`[dsh-flowspot] 初始化失败：${err.message}`)
      throw err
    }
  }

  // ctx.inject 的回调可能在依赖晚到时就再触发一次，所以资源一律登记进 effect，
  // 由 effect 的清理函数负责撤掉：重复挂载不会多留一份路由或工具。
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const rt = getRuntime()
      const dispose = mountRoutes(hostCtx, rt)
      log.info('[dsh-flowspot] 已挂载 /dsh-flowspot/* 路由')
      return () => {
        dispose()
        log.info('[dsh-flowspot] 路由已卸载')
      }
    }, 'dsh-flowspot: http routes')
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const rt = getRuntime()
      const dispose = registerTools(toolCtx, rt)
      log.info('[dsh-flowspot] 已注册 14 个 webcap_* 工具')
      return dispose
    }, 'dsh-flowspot: agent tools')
  })

  // 卸载必须先停代理、把系统代理恢复回去：留它指着一个已经没人监听的端口，插件
  // 卸载后整台机器就上不了网了。runtime 从没建过的话就什么都不碰。
  ctx.effect(() => async () => {
    if (!runtime) return
    try {
      await runtime.dispose()
      log.info('[dsh-flowspot] 已停止代理并恢复系统代理')
    } catch (err) {
      log.warn(`[dsh-flowspot] 卸载时出错：${err.message}`)
    }
  }, 'dsh-flowspot: teardown')
}
