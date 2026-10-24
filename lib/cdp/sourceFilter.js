/**
 * 哪些请求值得为它落盘源码。
 *
 * 目标只有一个：**业务接口**。源码落盘要花磁盘和一次 `getScriptSource` 往返，
 * 不能给埋点、风控探针、页面文档也各存一份。实测某内容站首页这一条链上，
 * 旧规则（任何带调用栈的请求）会先落下 `as/v2/fp/*.js`（风控指纹，396KB）、
 * 内联脚本（288KB）和 polyfill，而真正要看的业务大包反而在后面才轮到。
 *
 * 规则（改这里就是改行为）：
 *  - 只认 XHR / Fetch：文档、脚本、图片、字体、preflight 一律不触发；
 *  - URL 必须是 http(s)：内联脚本（url 为空）与 data:/blob: 不落，因为没法命名、
 *    也没法在查看器里指出是哪个文件；
 *  - host / path 命中噪声表的不算业务（埋点、APM、风控探针、验证码）。
 *
 * 边界：这是启发式，站点把业务接口放在 `/api/` 之外也没关系（只看类型与噪声表），
 * 但如果某站把埋点伪装成普通业务路径，需要往 `NOISE_PATHS` 里补一条。
 */

const BUSINESS_TYPES = new Set(['XHR', 'Fetch'])

/** 上报/探针类 host：这些站点的请求不触发落盘。 */
const NOISE_HOSTS = [
  /^apm[-.]/i,
  /^as\./i,
  /^t2\./i,
  /analytics/i,
  /sentry/i,
  /telemetry/i,
  /monitor/i,
]

/** 上报/探针类路径：命中就跳。 */
const NOISE_PATHS = [
  /\/api\/sec\//i,
  // 验证码/风控探针（站点各异，按路径名过滤）
  /\/redcaptcha\//i,
  /\/fp\//i,
  /\/collect\b/i,
  /\/api\/data\b/i,
  /\/beacon\b/i,
  /\/track\b/i,
  /\/perf\b/i,
  /\/report\b/i,
]

/**
 * 这条请求是不是「业务接口」，决定要不要为它落盘源码。
 * @param {{resourceType?: string, url?: string}} input
 * @returns {boolean}
 */
export function isBusinessRequest({ resourceType = '', url = '' } = {}) {
  if (!BUSINESS_TYPES.has(String(resourceType))) return false
  const raw = String(url || '')
  if (!/^https?:\/\//i.test(raw)) return false
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (NOISE_HOSTS.some((pattern) => pattern.test(parsed.hostname))) return false
  if (NOISE_PATHS.some((pattern) => pattern.test(parsed.pathname))) return false
  return true
}
