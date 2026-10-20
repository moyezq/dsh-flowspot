/**
 * dsh-flowspot host entry.
 *
 * Composes once per process: the MITM proxy, the certificate authority, the
 * Windows system-proxy controller and the flow store all live in one runtime,
 * so two sessions (or a panel plus a tool call) share the same capture buffer
 * and cannot fight over the listening port.
 *
 * The runtime is created lazily on first use: a profile that never touches the
 * plugin pays nothing, and a missing Windows tool only fails the call that needs
 * it instead of the whole plugin load.
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

export function apply(ctx, config) {
  const log = makeLogger(ctx)
  let runtime = null
  let runtimeError = null

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
      log.info('[dsh-flowspot] 已注册 9 个 webcap_* 工具')
      return dispose
    }, 'dsh-flowspot: agent tools')
  })

  // Teardown must restore the system proxy: leaving it pointing at a dead port
  // would break the machine's networking after the plugin unloads.
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
