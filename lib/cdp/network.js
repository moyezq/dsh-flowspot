/**
 * dsh-flowspot: browser-side network requests, kept only long enough to answer
 * "which call made this flow?".
 *
 * The proxy and CDP see the same request from two sides with no shared id, so
 * matching is by method + exact URL + a time window. Polling endpoints produce
 * many identical entries; pairing is FIFO within the window so the 3rd poll
 * cannot borrow the call chain of the 2nd.
 *
 * Entries are capped: the channel is long-lived and must stay cheap.
 */

import { flattenFrames, topFrame } from './initiator.js'

const MAX_ENTRIES = 2000
/** A request reaches the proxy after the browser sent it; allow for DNS/TLS. */
const WINDOW_BEFORE_MS = 5000
/** Clock slop in the other direction (proxy first, browser timestamp later). */
const WINDOW_AFTER_MS = 500

/** One line for tools and the panel. */
function initiatorTopFrame(entry) {
  const initiator = entry.initiator || {}
  // 同步段常常全是壳（XHR 只有 send 那一两帧），业务方法在异步段里，所以先摊平再挑。
  const frames = flattenFrames(initiator.stack)
  const frame = topFrame(frames) || frames[0] || null
  if (frame) {
    return {
      functionName: frame.functionName || '(anonymous)',
      url: frame.url || '',
      lineNumber: Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null,
      columnNumber: Number.isInteger(frame.columnNumber) ? frame.columnNumber + 1 : null,
      scriptId: frame.scriptId ? String(frame.scriptId) : null,
      asyncLevel: frame.asyncLevel,
    }
  }
  // XHR/fetch 没有 async stack 时常常只给 initiator.url，没有 callFrames。
  if (initiator.url) {
    return {
      functionName: initiator.type || '(anonymous)',
      url: initiator.url,
      lineNumber: Number.isInteger(initiator.lineNumber) ? initiator.lineNumber + 1 : null,
      columnNumber: Number.isInteger(initiator.columnNumber) ? initiator.columnNumber + 1 : null,
      scriptId: null,
    }
  }
  return null
}

/** Compact view of one CDP request. */
export function summaryOf(entry) {
  return {
    id: entry.id,
    at: entry.at,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    type: entry.resourceType || '',
    mime: entry.mime || '',
    documentURL: entry.documentURL || '',
    targetId: entry.targetId,
    flowId: entry.matchedFlowId || null,
    fromCache: Boolean(entry.fromCache),
    initiator: initiatorTopFrame(entry),
  }
}

export class CdpNetworkIndex {
  /** @param {{maxEntries?: number}} [options] */
  constructor({ maxEntries = MAX_ENTRIES } = {}) {
    this.maxEntries = Math.max(100, maxEntries)
    this.entries = []
    this.byKey = new Map()
    this.byRequest = new Map()
    this.seq = 0
  }

  get size() {
    return this.entries.length
  }

  /**
   * Record one `Network.requestWillBeSent`.
   *
   * Redirects reuse `requestId` and arrive as another event with
   * `redirectResponse`; each hop is kept as its own entry because the proxy
   * records each hop as a flow too.
   * @param {{sessionId: string, targetId?: string, params: object, at?: number}} input
   * @returns {object} the stored entry
   */
  add({ sessionId, targetId = '', params, at }) {
    const request = params.request || {}
    const wallTime = Number.isFinite(Number(params.wallTime)) ? Number(params.wallTime) * 1000 : null
    const time = at || (wallTime ? Math.round(wallTime) : Date.now())
    const id = `${sessionId}:${params.requestId}:${++this.seq}`
    const entry = {
      id,
      seq: this.seq,
      sessionId,
      targetId,
      requestId: String(params.requestId),
      method: String(request.method || 'GET').toUpperCase(),
      url: String(request.url || ''),
      at: time,
      initiator: params.initiator || null,
      resourceType: params.type || '',
      documentURL: params.documentURL || '',
      frameId: params.frameId || '',
      loaderId: params.loaderId || '',
      status: null,
      mime: '',
      matchedFlowId: null,
      redirected: Boolean(params.redirectResponse),
      // 标签页模式要能脱离代理看请求：头、POST 体、缓存标记都留一份。
      requestHeaders: request.headers || null,
      postData: typeof request.postData === 'string' ? request.postData : null,
      responseHeaders: null,
      fromCache: false,
      finished: false,
    }
    this.entries.push(entry)
    const key = `${entry.method} ${entry.url}`
    if (!this.byKey.has(key)) this.byKey.set(key, [])
    this.byKey.get(key).push(entry)
    this.byRequest.set(`${sessionId}:${entry.requestId}`, entry)
    while (this.entries.length > this.maxEntries) this._evictOldest()
    return entry
  }

  /** `Network.responseReceived`: keep status/mime for the list. */
  noteResponse({ sessionId, params }) {
    const entry = this.byRequest.get(`${sessionId}:${params.requestId}`)
    if (!entry) return
    const response = params.response || {}
    if (Number.isInteger(response.status)) entry.status = response.status
    entry.mime = String(response.mimeType || entry.mime || '')
    entry.responseHeaders = response.headers || null
    entry.fromCache = Boolean(response.fromDiskCache || response.fromServiceWorker)
  }

  /** `Network.loadingFinished`: 标签页模式下用它判断请求是否已完整。 */
  noteFinished({ sessionId, params }) {
    const entry = this.byRequest.get(`${sessionId}:${params.requestId}`)
    if (!entry) return
    entry.finished = true
  }

  /** One entry by its synthetic id (for the tab-mode detail view). */
  get(id) {
    return this.entries.find((entry) => entry.id === id) || null
  }

  /**
   * Pair a finished flow with the browser-side request.
   *
   * The same window is used for every flow; the first unmatched entry in
   * arrival order wins, which keeps polling endpoints aligned by sequence.
   * @param {object} flow stored flow
   * @returns {object|null} matched entry
   */
  match(flow) {
    const key = `${String(flow.method || 'GET').toUpperCase()} ${flow.url}`
    const list = this.byKey.get(key)
    if (!list || !list.length) return null
    const startedAt = Number(flow.startedAt) || Number(flow.ts) || Date.now()
    // Re-reading the same flow must return the entry it was already paired with:
    // otherwise the next unmatched poll entry would be attached to it.
    for (const entry of list) {
      if (entry.matchedFlowId === flow.id) return entry
    }
    // Prefer the entry in the window that actually has a call stack. Redirects,
    // retries and service-worker copies of the same URL can produce several
    // entries; the earliest one may have no initiator at all. Frame count is the
    // flattened one (sync + async sections), so a deeper async chain wins over a
    // bare 3-frame XHR. Depth ties keep arrival order, so polling endpoints still
    // pair in sequence.
    let chosen = null
    let bestDepth = -1
    for (const entry of list) {
      if (entry.matchedFlowId) continue
      if (entry.at > startedAt + WINDOW_AFTER_MS) break
      if (entry.at < startedAt - WINDOW_BEFORE_MS) continue
      const frames = flattenFrames(entry.initiator ? entry.initiator.stack : null)
      const depth = frames.length + (entry.initiator && entry.initiator.url ? 1 : 0)
      if (depth > bestDepth) {
        chosen = entry
        bestDepth = depth
      }
    }
    if (chosen) chosen.matchedFlowId = flow.id
    return chosen
  }

  /** Entry matched to a flow id, if this index already paired one. */
  forFlow(flow) {
    return this.match(flow)
  }

  /**
   * Newest-first list, for the agent's continuous polling.
   * @param {{since?: number, host?: string, matched?: boolean, limit?: number}} [options]
   */
  requests({ since, host, matched, limit = 50 } = {}) {
    const needle = host ? String(host).toLowerCase() : null
    const max = Math.min(200, Math.max(1, Number(limit) || 50))
    const out = []
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]
      if (since && entry.at <= Number(since)) continue
      if (needle && !entry.url.toLowerCase().includes(needle)) continue
      if (matched === true && !entry.matchedFlowId) continue
      if (matched === false && entry.matchedFlowId) continue
      out.push(summaryOf(entry))
      if (out.length >= max) break
    }
    return out
  }

  /** Forget everything: detaching makes old browser requests meaningless. */
  clear() {
    this.entries = []
    this.byKey.clear()
    this.byRequest.clear()
  }

  /** Remove one target's entries when its session detaches. */
  clearSession(sessionId) {
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId)
    this.byKey.clear()
    this.byRequest.clear()
    for (const entry of this.entries) {
      const key = `${entry.method} ${entry.url}`
      if (!this.byKey.has(key)) this.byKey.set(key, [])
      this.byKey.get(key).push(entry)
      this.byRequest.set(`${entry.sessionId}:${entry.requestId}`, entry)
    }
  }

  _evictOldest() {
    const entry = this.entries.shift()
    if (!entry) return
    const key = `${entry.method} ${entry.url}`
    const list = this.byKey.get(key)
    if (list) {
      const index = list.indexOf(entry)
      if (index >= 0) list.splice(index, 1)
      if (!list.length) this.byKey.delete(key)
    }
    const requestKey = `${entry.sessionId}:${entry.requestId}`
    if (this.byRequest.get(requestKey) === entry) this.byRequest.delete(requestKey)
  }
}

export { initiatorTopFrame }
