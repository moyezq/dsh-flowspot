/**
 * dsh-flowspot client module.
 *
 * Registers a first-level panel entry in the sidebar (`sidebar.panellist`) and
 * its page in the centre column (`main`, keyed by the same id) — the same two
 * seats the Skills and Memory panels use, so "抓包工具" sits beside them rather
 * than inside Settings.
 *
 * All data comes from the plugin's own /dsh-flowspot/* routes, so this module
 * never touches host internals.
 *
 * Styling uses only host theme tokens (--dsw-alias-*) that are verified to
 * exist; there are no literal colour fallbacks, so a missing token inherits
 * instead of silently pinning the panel to the dark theme.
 */
window.__ModuleLoader__.load({
  id: 'dsh-flowspot',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    async function api(path, init) {
      try {
        const res = await fetch(path, {
          credentials: 'same-origin',
          headers: init && init.body ? { 'content-type': 'application/json' } : undefined,
          ...init,
        })
        const text = await res.text()
        try {
          return JSON.parse(text)
        } catch {
          return { ok: false, error: text.slice(0, 200) }
        }
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) }
      }
    }

    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })

    function fmtBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '—'
      if (n < 1024) return `${n} B`
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1048576).toFixed(1)} MB`
    }

    function fmtTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString()
      } catch {
        return String(ts)
      }
    }

    function Cell(props) {
      return h('div', { className: 'dshwc-cell' },
        h('div', { className: 'dshwc-cell-label' }, props.label),
        h('div', { className: 'dshwc-cell-value' }, props.value))
    }

    /**
     * One collapsible block of the request detail. Kept as an explicit button +
     * caret instead of <details> so spacing and the caret follow the shell's
     * tokens, and so the open/closed state can outlive a flow switch.
     */
    function Section(props) {
      const open = Boolean(props.open)
      return h('div', { className: 'dshwc-section' },
        h('button', {
          className: 'dshwc-section-head',
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => props.onToggle(props.id),
        },
          h('span', { className: 'dshwc-caret', 'data-open': open ? 'true' : 'false' }, '▸'),
          h('span', { className: 'dshwc-section-title' }, props.title)),
        open ? h('div', { className: 'dshwc-section-body' }, props.children) : null)
    }

    /** Filter tabs, in the order F12's network panel lists them. */
    const TYPE_TABS = [
      ['all', '全部'],
      ['xhr', 'Fetch/XHR'],
      ['doc', '文档'],
      ['css', 'CSS'],
      ['js', 'JS'],
      ['img', '图片'],
      ['media', '媒体'],
      ['font', '字体'],
      ['ws', 'WS'],
      ['wasm', 'Wasm'],
      ['manifest', '清单'],
      ['other', '其他'],
    ]
    /** Second-level tabs, shown only for Fetch/XHR (they are all HTTP requests). */
    const METHOD_TABS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

    /** header map → one line per header, for the <pre> blocks. */
    function headerText(map) {
      return Object.entries(map || {})
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n')
    }

    /**
     * Read a shell service without injecting it. A bare `ctx.name` read throws
     * on a real Cordis context (`cannot get property … without inject`) and that
     * throw is what took the whole GUI down at boot (ADR-0008), so every shell
     * service this module touches goes through `get`.
     * @param {string} name service name
     * @returns {object|undefined} the service, when this deployment provides it
     */
    function getService(name) {
      try {
        const ctx = clientContext
        if (!ctx || typeof ctx.get !== 'function') return undefined
        return ctx.get(name) || undefined
      } catch {
        return undefined
      }
    }

    /** Read a framework observable whichever accessor it exposes. */
    function readObservable(source) {
      if (!source) return undefined
      try {
        if (typeof source.getSnapshot === 'function') return source.getSnapshot()
        if (typeof source.get === 'function') return source.get()
        if (typeof source.value !== 'undefined') return source.value
      } catch {
        /* unreadable source */
      }
      return undefined
    }

    /** One animation frame; the centre column commits the session surface in it. */
    function nextFrame() {
      return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 16)
      })
    }

    /**
     * Open the right-column tab once the session surface is back.
     *
     * The right column's commands act on the session that is on screen and throw
     * while a global main panel (this plugin's own page) replaces the
     * Conversation — the documented failure "没有会话在屏幕上". Handing the
     * centre back and retrying over a few frames is what makes the swap work.
     * @param {object} right `ctx.sidebarRight`
     * @param {number} attempts frames to keep trying
     * @returns {Promise<boolean>} whether the tab opened
     */
    async function openRightTabWhenReady(right, attempts = 24) {
      for (let i = 0; i < attempts; i++) {
        try {
          right.openTab(TAB_KIND)
          return true
        } catch {
          /* the session surface is not mounted yet */
        }
        await nextFrame()
      }
      return false
    }

    /**
     * Move the panel between the centre page (全屏) and the right column, which
     * is what the ⇄ button promises: one placement at a time, not a copy in both.
     *
     * Each shell command is guarded on its own: a deployment without the right
     * column, or with no session on screen (the right-column commands fail
     * loudly there), must leave the current placement alone instead of throwing
     * out of a click handler.
     * @param {boolean} docked true while rendered inside the right column
     * @returns {Promise<'page'|'right'|null>} the placement it managed to reach
     */
    async function togglePlacement(docked) {
      const layout = getService('layout')
      const right = getService('sidebarRight')
      if (docked) {
        // Right column → the centre page, and take our tab down with us.
        if (!layout || typeof layout.selectPanel !== 'function') return null
        try {
          layout.selectPanel(PANEL_ID)
        } catch {
          return null
        }
        const active = right && typeof right.active === 'function' ? right.active() : undefined
        const tabId = active && (active.id || active.tabId)
        if (tabId && right && typeof right.close === 'function') {
          try {
            right.close(tabId)
          } catch {
            /* the column keeps its tab; the page is already selected */
          }
        }
        return 'page'
      }
      // Centre page → the right column. Hand the centre back FIRST: while our
      // page owns it there is no session on screen, and the open throws.
      if (!right || typeof right.openTab !== 'function') return null
      if (layout && typeof layout.selectPanel === 'function') {
        try {
          layout.selectPanel(null)
        } catch {
          /* the open attempt below reports the real failure */
        }
      }
      const opened = await openRightTabWhenReady(right)
      return opened ? 'right' : null
    }

    /** The ⇄ glyph: swap between the full page and the right column. */
    function PlacementIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M3 5.5h8.5' }),
      h('path', { d: 'M9.5 3 12 5.5 9.5 8' }),
      h('path', { d: 'M13 10.5H4.5' }),
      h('path', { d: 'M6.5 8 4 10.5 6.5 13' }))
    }

    /**
     * Same volatile-parameter set as `lib/flows.js`. Duplicated on purpose: the
     * client bundle cannot import host code, and the fallback below must behave
     * identically when the host side is older than this bundle.
     */
    const VOLATILE_QUERY_PARAMS = new Set([
      't', 'ts', 'timestamp', 'time', '_', '_t', 'nonce', 'rnd', 'random',
      'page', 'pagenum', 'pageno', 'pagesize', 'page_size', 'offset', 'limit',
      'cursor', 'since', 'seq', 'count',
    ])

    /** Client-side mirror of `normalizeUrl`. */
    function normalizeEndpoint(url) {
      try {
        const parsed = new URL(url)
        const base = `${parsed.origin}${parsed.pathname}`
        if (!parsed.search) return base
        const kept = [...parsed.searchParams.entries()]
          .filter(([key]) => !VOLATILE_QUERY_PARAMS.has(key.toLowerCase()))
          .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
        if (!kept.length) return base
        const search = new URLSearchParams()
        for (const [key, value] of kept) search.append(key, value)
        return `${base}?${search.toString()}`
      } catch {
        return url
      }
    }

    /**
     * Grouping fallback for a host side that predates `listGroups` (a page
     * reload picks up a new client bundle while the process keeps the host code
     * it booted with). Counts then cover the fetched page, not the whole ring.
     */
    function groupLocal(flows, normalize) {
      const groups = []
      const index = new Map()
      for (const f of flows) {
        const url = normalize ? normalizeEndpoint(f.url) : f.url
        const key = `${String(f.method).toUpperCase()} ${url}`
        let group = index.get(key)
        if (!group) {
          group = {
            key, method: f.method, url, host: f.host, path: f.path, type: f.type,
            count: 0, first: null, latest: f, items: [], statuses: {}, errors: 0,
          }
          index.set(key, group)
          groups.push(group)
        }
        group.count++
        group.first = f
        if (f.error) group.errors++
        const statusKey = f.error ? 'ERR' : String(f.status ?? 'pending')
        group.statuses[statusKey] = (group.statuses[statusKey] || 0) + 1
        group.items.push(f)
      }
      for (const group of groups) group.truncated = group.count > group.items.length
      return groups
    }

    function Panel(props) {
      const docked = Boolean(props && props.docked)
      const [status, setStatus] = useState(null)
      const [flows, setFlows] = useState([])
      const [detail, setDetail] = useState(null)
      const [body, setBody] = useState(null)
      const [reqBodyText, setReqBodyText] = useState(null)
      const [selected, setSelected] = useState(null)
      const [type, setType] = useState('all')
      const [method, setMethod] = useState('')
      const [keyword, setKeyword] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      /** Settings dialog: certificates and the data directory live here now. */
      const [settingsOpen, setSettingsOpen] = useState(false)
      /** Which side of the list owns the split: successes, failures, or 8:2. */
      const [failureView, setFailureView] = useState('split')
      /** When the operator last cleared; failures older than this stay hidden. */
      const [errorsClearedAt, setErrorsClearedAt] = useState(0)
      /** Merge mode: one row per endpoint (method + URL), expandable to its calls. */
      const [mergeOn, setMergeOn] = useState(false)
      const [groups, setGroups] = useState([])
      const [openGroups, setOpenGroups] = useState({})
      /** True when the groups came from this bundle, not from the host. */
      const [localMerge, setLocalMerge] = useState(false)
      /** Detail blocks, each independently collapsible; state survives switching flows. */
      const [openSections, setOpenSections] = useState({ error: true, req: true, reqBody: true, resp: true, respBody: true })
      const mounted = useRef(true)
      /** Latest filters, so the 3s poll reads what the UI shows without re-arming the timer. */
      const filtersRef = useRef({ type: 'all', method: '', keyword: '', merge: false })

      useEffect(() => () => { mounted.current = false }, [])

      const refresh = useCallback(async () => {
        const s = await api('/dsh-flowspot/status')
        if (!mounted.current) return
        if (s.ok) setStatus(s)
        else setMessage({ kind: 'error', text: s.error || '无法读取状态' })
      }, [])

      const loadFlows = useCallback(async (f) => {
        const query = new URLSearchParams()
        query.set('limit', '200')
        if (f.type && f.type !== 'all') query.set('type', f.type)
        if (f.method) query.set('method', f.method)
        if (f.keyword) query.set('q', f.keyword)
        if (f.merge) query.set('group', '1')
        const s = await api(`/dsh-flowspot/flows?${query.toString()}`)
        if (!mounted.current) return
        if (!s.ok) { setMessage({ kind: 'error', text: s.error || '读取请求列表失败' }); return }
        const list = Array.isArray(s.flows) ? s.flows : []
        setFlows(list)
        if (s.grouped) {
          setGroups(Array.isArray(s.groups) ? s.groups : [])
          setLocalMerge(false)
        } else if (f.merge) {
          // Older host side: group here so the button still works.
          setGroups(groupLocal(list, false))
          setLocalMerge(true)
        } else {
          setGroups([])
          setLocalMerge(false)
        }
      }, [])

      useEffect(() => {
        refresh()
        loadFlows(filtersRef.current)
        const timer = setInterval(() => {
          refresh()
          loadFlows(filtersRef.current)
        }, 3000)
        return () => clearInterval(timer)
      }, [refresh, loadFlows])

      // Debounced so typing in the keyword box does not fire one request per key.
      useEffect(() => {
        filtersRef.current = { type, method, keyword, merge: mergeOn }
        const timer = setTimeout(() => { loadFlows(filtersRef.current) }, 150)
        return () => clearTimeout(timer)
      }, [type, method, keyword, mergeOn, loadFlows])

      const act = useCallback(async (fn, okText) => {
        setBusy(true)
        setMessage(null)
        try {
          const result = await fn()
          if (!mounted.current) return
          if (result && result.ok === false) setMessage({ kind: 'error', text: result.error || '操作失败' })
          else if (result && result.warning) setMessage({ kind: 'ok', text: result.warning })
          else if (okText) setMessage({ kind: 'ok', text: okText })
          await refresh()
          await loadFlows(filtersRef.current)
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [refresh, loadFlows])

      /**
       * Clear both lists. An older host only clears the flow ring, so the panel
       * also remembers the moment and hides failures that predate it.
       */
      const clearAll = useCallback(() => {
        setErrorsClearedAt(Date.now())
        return act(async () => {
          const result = await post('/dsh-flowspot/clear', { confirm: true })
          if (result && result.ok !== false && result.errorsCleared !== true) {
            return {
              ...result,
              warning: '请求列表已清空；失败摘要由旧版宿主保留，面板里已隐藏旧条目——重启 DSH 后服务端也会一起清空。',
            }
          }
          return result
        }, '已清空请求列表与失败摘要')
      }, [act])

      /**
       * Ask the host to open a native folder chooser (or reset the stored
       * choice) and apply the result to the data directory.
       */
      const setDataDir = useCallback(async (payload) => {
        setBusy(true)
        setMessage(null)
        try {
          const result = await post('/dsh-flowspot/data-dir', payload)
          if (!mounted.current) return
          if (result.ok === false) {
            setMessage({ kind: 'error', text: result.error || '换数据目录失败' })
          } else if (result.cancelled) {
            setMessage({ kind: 'ok', text: '已取消选择' })
          } else {
            const notes = [result.reset ? `已恢复默认数据目录：${result.dir}` : `数据目录 → ${result.dir}`]
            if (result.copyOnStart) notes.push('现有 CA 会在重启时复制过去，不用重装证书')
            if (result.foreignCa) notes.push('新目录里已有一套 CA，若它没装进受信任根就要重新安装')
            if (result.restartRequired) notes.push('重启 DSH 后生效')
            setMessage({ kind: 'ok', text: notes.join('；') })
          }
          await refresh()
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [refresh])

      const openDetail = useCallback(async (id) => {
        setSelected(id)
        setDetail(null)
        setBody(null)
        setReqBodyText(null)
        const d = await api(`/dsh-flowspot/detail?id=${encodeURIComponent(id)}`)
        if (!mounted.current) return
        if (!d.ok) { setMessage({ kind: 'error', text: d.error || '读取失败' }); return }
        setDetail(d.flow)
        const b = await api(`/dsh-flowspot/body?id=${encodeURIComponent(id)}&side=response&limit=4000`)
        if (mounted.current && b.ok) setBody(b)
        // Request bodies are only fetched when the flow has one, and both sides
        // are shown in their own collapsible block.
        if (d.flow && d.flow.reqBody) {
          const rb = await api(`/dsh-flowspot/body?id=${encodeURIComponent(id)}&side=request&limit=4000`)
          if (mounted.current && rb.ok) setReqBodyText(rb)
        }
      }, [])


      const running = Boolean(status && status.proxy && status.proxy.running)
      const port = status && status.proxy ? status.proxy.port : null
      const portNote = status && status.proxy ? status.proxy.portNote : null
      const caInstalled = Boolean(status && status.ca && status.ca.installed)
      const sysOn = Boolean(status && status.systemProxy && status.systemProxy.enabled)
      const total = status && status.flows ? status.flows.total : 0
      const lastError = status && status.proxy ? status.proxy.lastError : null
      const recentErrors = (status && status.proxy && status.proxy.recentErrors) || []
      // An older host keeps its failure summary after a clear. Hide entries that
      // predate the clear locally, so 「清空」 looks like it worked; failures that
      // happen afterwards still show up.
      const visibleErrors = errorsClearedAt
        ? recentErrors.filter((item) => (item.ts || 0) > errorsClearedAt)
        : recentErrors
      // The panel bundle reloads with the page; the host code only changes when
      // the process restarts. A host that never reports `build` is an old build.
      const hostStale = Boolean(status) && !status.build
      const paths = status && status.paths ? status.paths : null
      const dirText = paths
        ? `数据目录：${paths.dir}${paths.pending ? `（已选择 ${paths.pending}，重启后生效）` : ''}`
        : '数据目录：—'

      // Merge mode only swaps the list when it actually produced groups: an empty
      // group set (host side that predates grouping, or a failed call) must leave
      // the flat list visible instead of blanking the panel.
      const showGroups = mergeOn && groups.length > 0

      const toggleSection = (key) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
      const toggleGroup = (key) => setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }))

      /** One captured request. Failed rows keep the same shape, painted red. */
      const rowOf = (f, nested = false, failed = Boolean(f.error)) => h('div', {
        key: f.id,
        className: `dshwc-item${nested ? ' dshwc-item-nested' : ''}${failed ? ' dshwc-item-failed' : ''}${selected === f.id ? ' dshwc-item-selected' : ''}`,
        title: f.url,
        onClick: () => openDetail(f.id),
      },
        h('span', { className: 'dshwc-method' }, f.method),
        h('span', { className: `dshwc-status${failed ? ' dshwc-status-error' : ''}` }, f.error ? 'ERR' : (f.status || '…')),
        h('span', { className: 'dshwc-item-name' }, `${f.host}${f.path}`),
        h('span', { className: 'dshwc-item-sub' },
          `${fmtTime(f.ts)} · ${fmtBytes(f.respBytes)} · ${f.type || '—'}${f.errorCode ? ` · ${f.errorCode}` : ''}`))

      /**
       * One merged endpoint: the newest call stands in for the group, the count
       * says how many there were, and the chevron lists the occurrences in
       * chronological order. The status mix lives on the sub-line so the URL gets
       * the whole row width.
       */
      const groupOf = (g) => {
        const open = Boolean(openGroups[g.key])
        const latest = g.latest
        const statusText = latest.error ? `ERR${latest.errorCode ? ` ${latest.errorCode}` : ''}` : (latest.status || '…')
        return h('div', { key: g.key, className: 'dshwc-group' },
          h('div', {
            className: `dshwc-item dshwc-group-head${g.errors ? ' dshwc-item-failed' : ''}${selected === latest.id ? ' dshwc-item-selected' : ''}`,
            title: `${g.url}\n共 ${g.count} 次，最新 ${fmtTime(latest.ts)}`,
            onClick: () => openDetail(latest.id),
          },
            h('span', { className: 'dshwc-method' }, g.method),
            h('span', { className: 'dshwc-item-name' }, `${g.host}${g.path}`),
            h('span', { className: 'dshwc-count' }, `×${g.count}`),
            h('button', {
              className: 'dshwc-expand',
              title: open ? '收起这组' : `展开这 ${g.count} 次调用`,
              'aria-expanded': open ? 'true' : 'false',
              onClick: (event) => {
                event.stopPropagation()
                toggleGroup(g.key)
              },
            }, open ? '▾' : '▸')),
          h('div', {
            className: `dshwc-item-sub dshwc-group-sub${g.errors ? ' dshwc-status-error' : ''}`,
            title: g.url,
          },
            `${fmtTime(latest.ts)} · ${statusText} · ${latest.type || '—'}${g.errors ? ` · 失败 ×${g.errors}` : ''}`),
          open
            ? h('div', { className: 'dshwc-children' },
              g.items.slice().reverse().map((f) => rowOf(f, true)),
              g.truncated ? h('div', { className: 'dshwc-note' }, `（只列出最近 ${g.items.length} 次）`) : null)
            : null)
      }

      /** Rows for one slice of the list: everything, only failures, only successes. */
      const listRows = (kind) => {
        if (showGroups) {
          const picked = kind === 'failed' ? groups.filter((g) => g.errors > 0)
            : kind === 'ok' ? groups.filter((g) => !g.errors)
              : groups
          return picked.map(groupOf)
        }
        const picked = kind === 'failed' ? flows.filter((f) => f.error)
          : kind === 'ok' ? flows.filter((f) => !f.error)
            : flows
        if (!picked.length) {
          return h('div', { className: 'dshwc-empty' },
            kind === 'failed' ? '还没有失败的请求。'
              : kind === 'ok' ? '还没有成功的请求。'
                : (total > 0
                  ? `没有匹配的请求。共捕获 ${total} 条，换一个类型或清空关键词试试。`
                  : '还没有请求。点「开始抓包」，然后在浏览器里正常操作，这里会实时出现。'))
        }
        return picked.map((f) => rowOf(f, false, Boolean(f.error)))
      }

      const failedCount = showGroups ? groups.filter((g) => g.errors > 0).length : flows.filter((f) => f.error).length
      const okCount = showGroups ? groups.filter((g) => !g.errors).length : flows.filter((f) => !f.error).length

      return h('div', { className: 'dshwc-root', 'data-docked': docked ? 'true' : 'false' },
        // Panel 1 — 菜单: capture state and every switch.
        h('div', { className: 'dshwc-side dshwc-panel' },
          h('div', { className: 'dshwc-panel-head' },
            h('span', { className: 'dshwc-panel-title' }, '菜单'),
            h('div', { className: 'dshwc-row dshwc-headbtns' },
            h('button', {
              className: 'dshwc-btn dshwc-btn-small',
              title: '证书与数据目录',
              onClick: () => setSettingsOpen(true),
            }, '设置'),
            h('button', {
              className: 'dshwc-iconbtn',
              title: docked ? '切换到整页（全屏）' : '切换到右侧栏',
              'aria-label': docked ? '切换到整页（全屏）' : '切换到右侧栏',
              onClick: async () => {
                setMessage(null)
                const placement = await togglePlacement(docked)
                if (placement === null) {
                  setMessage({
                    kind: 'error',
                    text: '右侧栏打不开：当前屏幕上没有会话。先打开/新建一个会话，再用「+」里的抓包工具，或在这里再点一次。',
                  })
                }
              },
            }, h(PlacementIcon, null)))),
          h('div', { className: 'dshwc-panel-body' },
            h('div', { className: 'dshwc-note' },
              '开启后把 Windows 系统代理指向本机 MITM 代理，并自动签发每个域名的证书。证书与数据目录在「设置」里配置。'),
            h('div', { className: 'dshwc-grid' },
              h(Cell, { label: '代理', value: running ? `运行中 :${port}` : '未运行' }),
              h(Cell, { label: 'CA', value: caInstalled ? '已信任' : '未安装' }),
              h(Cell, { label: '系统代理', value: sysOn ? '已指向本机' : '未开启' }),
              h(Cell, { label: '已捕获', value: `${total} 条` })),
            h('div', { className: 'dshwc-row' },
              h('button', {
                className: 'dshwc-btn dshwc-btn-primary',
                disabled: busy,
                onClick: () => act(() => post('/dsh-flowspot/serve', { action: running ? 'stop' : 'start' }),
                  running ? '已停止代理并恢复系统代理' : '代理已启动，系统代理已指向本机'),
              }, running ? '停止抓包' : '开始抓包'),
              h('button', {
                className: 'dshwc-btn',
                disabled: busy,
                onClick: clearAll,
              }, '清空')),
            message ? h('div', { className: `dshwc-msg ${message.kind === 'error' ? 'dshwc-msg-error' : 'dshwc-msg-ok'}` }, message.text) : null,
            hostStale
              ? h('div', { className: 'dshwc-msg dshwc-msg-error' },
                '面板已更新，但宿主侧还是旧版本（旧宿主不返回 build）。合并只能在本地做、清空清不掉服务端摘要。'
                + '如果确实重装并重启过，请确认 GUI 端口（默认 3080）上的还是不是旧进程：netstat -ano | findstr :3080 找到 PID，'
                + 'Get-Process -Id <PID> | Select-Object StartTime 看启动时间，结束它再重开 DSH（桌面版要连托盘图标一起退出）。')
              : null,
            lastError && !visibleErrors.length
              ? h('div', { className: 'dshwc-msg dshwc-msg-error' }, `最近错误：${lastError}`)
              : null,
            portNote ? h('div', { className: 'dshwc-msg dshwc-msg-note' }, portNote) : null)),
        // Panels 2 and 3 — request list and request detail, each with its own header.
        h('div', { className: 'dshwc-main' },
          h('div', { className: 'dshwc-pane dshwc-pane-left' },
            h('div', { className: 'dshwc-panel-head' },
              h('span', { className: 'dshwc-panel-title' }, showGroups
                ? `请求列表（合并 ${groups.length} 组 · 共 ${total} 条）`
                : `请求列表（${total} 条 · 显示 ${flows.length}）`),
              h('button', {
                className: 'dshwc-btn dshwc-btn-small',
                'data-on': mergeOn ? 'true' : 'false',
                title: mergeOn
                  ? '同「方法 + 完整 URL」的请求合成一行；再点一次恢复平铺'
                  : '把「方法 + 完整 URL」相同的请求合成一行，轮询接口只占一行',
                onClick: () => setMergeOn((value) => !value),
              }, mergeOn ? '合并：开' : '合并')),
            localMerge
              ? h('div', { className: 'dshwc-note dshwc-mergehint' },
                '本地合并：只统计最近拉取的 200 条，重启 DSH 后交给服务端')
              : null,
            h('div', { className: 'dshwc-pane-head' },
                  h('div', { className: 'dshwc-chips' }, TYPE_TABS.map(([value, label]) => h('button', {
                    key: value,
                    className: 'dshwc-chip',
                    'data-active': type === value ? 'true' : 'false',
                    onClick: () => {
                      setType(value)
                      if (value !== 'xhr') setMethod('')
                    },
                  }, label))),
                  type === 'xhr'
                    ? h('div', { className: 'dshwc-chips' }, h('button', {
                      className: 'dshwc-chip',
                      'data-active': method === '' ? 'true' : 'false',
                      onClick: () => setMethod(''),
                    }, '全部方法'), METHOD_TABS.map((value) => h('button', {
                      key: value,
                      className: 'dshwc-chip',
                      'data-active': method === value ? 'true' : 'false',
                      onClick: () => setMethod(value),
                    }, value)))
                    : null,
                  h('input', {
                    className: 'dshwc-input',
                    placeholder: '按 URL / host 关键词筛选',
                    value: keyword,
                    onChange: (e) => setKeyword(e.target.value),
                  })),
            // Split control only exists where the list has room for two panes.
            !docked
              ? h('div', { className: 'dshwc-row dshwc-failmode' },
                [['split', 'Default'], ['success', 'Success'], ['failures', 'Error']].map(([value, label]) => h('button', {
                  key: value,
                  className: 'dshwc-chip',
                  'data-active': failureView === value ? 'true' : 'false',
                  title: value === 'split' ? '成功 8 : 失败 2' : value === 'success' ? '只显示成功请求' : '只显示失败请求',
                  onClick: () => setFailureView(value),
                }, label)))
              : null,
            // Widths only: in the narrow column both lists share one scroll and rows
            // keep their position in time (failed rows are painted red).
            docked
              ? h('div', { className: 'dshwc-scroll' }, listRows('all'))
              : h('div', { className: 'dshwc-split' },
                failureView !== 'failures'
                  ? h('div', { className: 'dshwc-oks' },
                    h('div', { className: 'dshwc-minihead' }, `成功 ${okCount} ${showGroups ? '组' : '条'}`),
                    h('div', { className: 'dshwc-scroll' }, listRows('ok')))
                  : null,
                // Failures sit under the successes; a 20% empty strip would only be
                // noise, so it only appears when there is something to show or the
                // operator asked for it explicitly.
                failureView !== 'success' && (failureView === 'failures' || failedCount > 0)
                  ? h('div', { className: `dshwc-fails${failureView === 'failures' ? ' dshwc-fails-full' : ''}` },
                    h('div', { className: 'dshwc-minihead' }, `失败 ${failedCount} ${showGroups ? '组' : '条'}`),
                    h('div', { className: 'dshwc-scroll' }, listRows('failed')))
                  : null)),
            h('div', { className: 'dshwc-pane dshwc-pane-right' },
              h('div', { className: 'dshwc-panel-head' },
                h('span', { className: 'dshwc-panel-title' }, '请求详情'),
                detail ? h('span', { className: 'dshwc-note' }, `${detail.method} · ${detail.status ?? '—'}`) : null),
              detail
                ? h('div', { className: 'dshwc-detail' },
                    h('div', { className: 'dshwc-detail-head' },
                      h('div', { className: 'dshwc-detail-title' }, `${detail.method} ${detail.url}`),
                      h('div', { className: 'dshwc-note' },
                        `状态 ${detail.status ?? '—'} · ${detail.durationMs ?? '—'}ms · 隧道 ${detail.tunnel ? `${detail.tunnel.host}:${detail.tunnel.port}` : '无'}`)),
                    detail.error
                      ? h('div', { className: 'dshwc-errorcard' },
                        h('div', { className: 'dshwc-errorcard-title' }, `请求失败：${detail.error}`),
                        h('div', { className: 'dshwc-errorcard-meta' },
                          [detail.errorCode, detail.errorPhase ? `阶段 ${detail.errorPhase}` : ''].filter(Boolean).join(' · ') || '没有错误码'),
                        detail.errorHint ? h('div', { className: 'dshwc-note' }, detail.errorHint) : null)
                      : null,
                    h(Section, { id: 'req', title: '请求头', open: openSections.req, onToggle: toggleSection },
                      h('pre', { className: 'dshwc-pre' }, headerText(detail.reqHeaders))),
                    detail.reqBody
                      ? h(Section, { id: 'reqBody', title: '请求体', open: openSections.reqBody, onToggle: toggleSection },
                        reqBodyText && reqBodyText.ok && reqBodyText.text
                          ? h('pre', { className: 'dshwc-pre' }, reqBodyText.text.slice(0, 4000))
                          : h('div', { className: 'dshwc-note' }, `${detail.reqBody.mime || 'unknown'} · ${detail.reqBody.bytes} 字节${detail.reqBody.truncated ? '（已截断）' : ''}`))
                      : null,
                    h(Section, { id: 'resp', title: '响应头', open: openSections.resp, onToggle: toggleSection },
                      detail.respHeaders
                        ? h('pre', { className: 'dshwc-pre' }, headerText(detail.respHeaders))
                        : h('div', { className: 'dshwc-note' }, '（没有响应头）')),
                    h(Section, { id: 'respBody', title: '响应体', open: openSections.respBody, onToggle: toggleSection },
                      body && body.ok && body.text
                        ? h('pre', { className: 'dshwc-pre' }, body.text.slice(0, 4000))
                        : h('div', { className: 'dshwc-note' }, body && body.ok ? '（没有捕获到响应体）' : '（响应体读取中或为空）')))
                  : h('div', { className: 'dshwc-empty' }, '点左侧一条请求，这里显示它的错误原因、请求头、响应头与响应体。'))),
        settingsOpen
          ? h('div', {
            className: 'dshwc-modal',
            onClick: () => setSettingsOpen(false),
          },
            h('div', { className: 'dshwc-modal-card', onClick: (event) => event.stopPropagation() },
              h('div', { className: 'dshwc-modal-head' },
                h('span', { className: 'dshwc-panel-title' }, '设置'),
                h('button', {
                  className: 'dshwc-iconbtn',
                  title: '关闭',
                  onClick: () => setSettingsOpen(false),
                }, '✕')),
              h('div', { className: 'dshwc-modal-body' },
                // The menu body sits behind the overlay, so repeat the last
                // operation result inside the dialog where the user is looking.
                message ? h('div', { className: `dshwc-msg ${message.kind === 'error' ? 'dshwc-msg-error' : 'dshwc-msg-ok'}` }, message.text) : null,
                h('div', { className: 'dshwc-setting' },
                  h('div', { className: 'dshwc-setting-head' }, '证书'),
                  h('div', { className: 'dshwc-note' },
                    caInstalled
                      ? 'CA 已装进「当前用户 → 受信任的根」，HTTPS 解密需要它。'
                      : '未安装 CA：先装，否则 HTTPS 页面会报证书错误。'),
                  h('div', { className: 'dshwc-row' },
                    h('button', {
                      className: 'dshwc-btn',
                      disabled: busy,
                      onClick: () => act(() => post('/dsh-flowspot/ca', { action: caInstalled ? 'uninstall' : 'install' }),
                        caInstalled ? '已从受信任根移除 CA' : 'CA 已安装到「当前用户 → 受信任的根」'),
                    }, caInstalled ? '卸载 CA' : '安装 CA'))),
                h('div', { className: 'dshwc-setting' },
                  h('div', { className: 'dshwc-setting-head' }, '数据目录'),
                  h('div', { className: 'dshwc-note dshwc-dirtext' }, dirText),
                  h('div', { className: 'dshwc-note' },
                    running
                      ? '抓包运行中不能换目录：先停止抓包。'
                      : '切换后要重启 DSH，CA 与 flows 才会落到新目录。'),
                  h('div', { className: 'dshwc-row' },
                    h('button', {
                      className: 'dshwc-btn',
                      disabled: busy || running,
                      title: running ? '先停止抓包再改数据目录' : undefined,
                      onClick: () => setDataDir({ action: 'pick' }),
                    }, '选择数据目录'),
                    h('button', {
                      className: 'dshwc-btn',
                      disabled: busy || running,
                      title: running ? '先停止抓包再改数据目录' : undefined,
                      onClick: () => setDataDir({ action: 'reset' }),
                    }, '恢复默认'))))))
          : null,
        h('style', null, `
.dshwc-page { position:relative; width:100%; height:100%; min-height:360px; margin:0 auto; padding:12px 16px; box-sizing:border-box; display:flex; flex-direction:column; overflow:hidden; }
.dshwc-root { flex:1; min-height:0; display:flex; flex-direction:row; gap:8px; font-size:12px; color:var(--dsw-alias-label-primary); }
.dshwc-panel { display:flex; flex-direction:column; min-width:0; min-height:0; border:1px solid var(--dsw-alias-settings-card-stroke); border-radius:8px; background:var(--dsw-alias-settings-card-fill); overflow:hidden; }
.dshwc-panel-head { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-settings-card-stroke); }
.dshwc-panel-title { font-weight:600; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dshwc-panel-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:8px; padding:8px; }
.dshwc-side { flex:0 0 320px; min-width:0; min-height:0; }
.dshwc-side .dshwc-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
.dshwc-main { flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:row; gap:8px; }
.dshwc-pane-left { flex:0 0 40%; }
.dshwc-pane-right { flex:1 1 auto; }
.dshwc-mergehint { padding:0 8px 4px; }
.dshwc-rightpane { position:relative; height:100%; display:flex; flex-direction:column; box-sizing:border-box; padding:8px; overflow:hidden; }
.dshwc-rightpane .dshwc-root { padding:0; flex-direction:column; }
.dshwc-rightpane .dshwc-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
.dshwc-rightpane .dshwc-side { flex:0 0 auto; max-height:42%; }
.dshwc-rightpane .dshwc-main { flex-direction:column; }
.dshwc-rightpane .dshwc-pane-left { flex:0 0 auto; max-height:46%; }
.dshwc-rightpane .dshwc-pane-right { flex:1 1 auto; }
.dshwc-iconbtn { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:var(--dsw-alias-label-tertiary); cursor:pointer; }
.dshwc-iconbtn:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.dshwc-note { color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:1.6; }
.dshwc-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:8px; }
.dshwc-cell { background:var(--dsw-alias-bg-layer-1); border-radius:6px; padding:6px 8px; }
.dshwc-cell-label { color:var(--dsw-alias-label-tertiary); font-size:11px; }
.dshwc-cell-value { font-size:12px; margin-top:2px; }
.dshwc-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dshwc-btn { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:6px; padding:4px 12px; cursor:pointer; font-size:12px; }
.dshwc-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.dshwc-btn:disabled { opacity:.55; cursor:default; }
.dshwc-btn-primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dshwc-input { flex:1; min-width:160px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:4px 8px; font-size:12px; font-family:inherit; }
.dshwc-dirtext { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
.dshwc-msg { border-radius:6px; padding:6px 8px; font-size:11px; }
.dshwc-msg-ok { background:var(--dsw-alias-bg-layer-2); }
.dshwc-msg-note { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-tertiary); }
.dshwc-msg-error { border:1px solid var(--dsw-alias-state-error-secondary); color:var(--dsw-alias-state-error-primary); }
.dshwc-pane { border:1px solid var(--dsw-alias-settings-card-stroke); border-radius:8px; background:var(--dsw-alias-settings-card-fill); display:flex; flex-direction:column; min-height:0; min-width:0; overflow:hidden; }
.dshwc-pane-left { flex:0 0 38%; }
.dshwc-pane-right { flex:1 1 auto; }
.dshwc-pane-head { display:flex; flex-direction:column; gap:6px; padding:8px; border-bottom:1px solid var(--dsw-alias-settings-card-stroke); }
.dshwc-chips { display:flex; flex-wrap:wrap; gap:4px; }
.dshwc-chip { border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-tertiary); border-radius:999px; padding:1px 8px; font-size:11px; cursor:pointer; font-family:inherit; }
.dshwc-chip[data-active="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); }
.dshwc-scroll { flex:1; min-height:0; overflow:auto; padding:4px; display:flex; flex-direction:column; gap:2px; }
.dshwc-headbtns { gap:6px; flex-wrap:nowrap; }
.dshwc-failmode { gap:6px; padding:0 8px 6px; }
.dshwc-split { flex:1; min-height:0; display:flex; flex-direction:column; gap:6px; padding:0 8px 8px; }
.dshwc-fails, .dshwc-oks { flex:1 1 0; min-height:0; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; overflow:hidden; }
.dshwc-fails { flex:0 0 20%; }
.dshwc-fails-full { flex:1 1 100%; }
.dshwc-minihead { flex:0 0 auto; padding:4px 8px; font-size:11px; color:var(--dsw-alias-label-tertiary); border-bottom:1px solid var(--dsw-alias-border-l2); }
.dshwc-modal { position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center; padding:16px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent); }
.dshwc-modal-card { width:min(520px, 100%); max-height:82vh; overflow:auto; border:1px solid var(--dsw-alias-settings-card-stroke); border-radius:10px; background:var(--dsw-alias-settings-card-fill); display:flex; flex-direction:column; }
.dshwc-modal-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-bottom:1px solid var(--dsw-alias-settings-card-stroke); }
.dshwc-modal-body { padding:12px; display:flex; flex-direction:column; gap:14px; }
.dshwc-setting { display:flex; flex-direction:column; gap:6px; }
.dshwc-setting-head { font-weight:600; font-size:12px; }
.dshwc-item { display:grid; grid-template-columns:46px 40px minmax(0,1fr); column-gap:6px; align-items:center; padding:3px 6px; border-radius:4px; cursor:pointer; }
.dshwc-item:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dshwc-item-selected { background:var(--dsw-alias-bg-layer-2); outline:1px solid var(--dsw-alias-brand-primary); }
.dshwc-method { color:var(--dsw-alias-label-tertiary); font-size:11px; }
.dshwc-status { font-size:11px; }
.dshwc-status-error { color:var(--dsw-alias-state-error-primary); }
.dshwc-item-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshwc-item-sub { grid-column:1 / -1; color:var(--dsw-alias-label-tertiary); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshwc-item-failed .dshwc-method,
.dshwc-item-failed .dshwc-item-name,
.dshwc-item-failed .dshwc-item-sub { color:var(--dsw-alias-state-error-primary); }
.dshwc-btn-small { padding:2px 8px; font-size:11px; }
.dshwc-btn-small[data-on="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dshwc-count { color:var(--dsw-alias-label-tertiary); font-size:11px; white-space:nowrap; text-align:right; }
.dshwc-expand { width:20px; height:20px; padding:0; border:1px solid var(--dsw-alias-border-l2); border-radius:4px; background:transparent; color:var(--dsw-alias-label-tertiary); cursor:pointer; font-size:10px; line-height:1; }
.dshwc-expand:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.dshwc-group { display:flex; flex-direction:column; gap:1px; }
.dshwc-group-head { grid-template-columns:44px minmax(0,1fr) 46px 22px; background:var(--dsw-alias-bg-layer-1); }
.dshwc-group-sub { padding:0 6px 2px 52px; font-size:10px; }
.dshwc-item-nested { margin-left:16px; border-left:1px solid var(--dsw-alias-border-l2); border-radius:0 4px 4px 0; }
.dshwc-children { display:flex; flex-direction:column; gap:1px; }
.dshwc-errorcard { border:1px solid var(--dsw-alias-state-error-secondary); border-radius:8px; padding:8px; display:flex; flex-direction:column; gap:4px; background:var(--dsw-alias-bg-layer-1); }
.dshwc-errorcard-title { color:var(--dsw-alias-state-error-primary); font-size:12px; font-weight:600; word-break:break-all; }
.dshwc-errorcard-meta { color:var(--dsw-alias-label-tertiary); font-size:11px; }
.dshwc-empty { color:var(--dsw-alias-label-tertiary); font-size:11px; padding:10px; line-height:1.7; }
.dshwc-detail { flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; padding:8px; overflow:auto; }
.dshwc-detail-head { display:flex; flex-direction:column; gap:2px; }
.dshwc-detail-title { font-weight:600; font-size:12px; word-break:break-all; }
.dshwc-section { display:flex; flex-direction:column; gap:4px; }
.dshwc-section-head { display:flex; align-items:center; gap:6px; padding:2px 0; border:0; background:transparent; color:var(--dsw-alias-label-tertiary); font-size:11px; font-family:inherit; cursor:pointer; text-align:left; }
.dshwc-section-head:hover { color:var(--dsw-alias-label-primary); }
.dshwc-caret { display:inline-block; width:10px; transition:transform .12s ease; }
.dshwc-caret[data-open="true"] { transform:rotate(90deg); }
.dshwc-section-title { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.dshwc-section-body { display:flex; flex-direction:column; gap:4px; }
.dshwc-pre { background:var(--dsw-alias-bg-layer-1); border-radius:6px; padding:8px; overflow:auto; font-size:11px; white-space:pre-wrap; word-break:break-all; margin:0; max-height:none; }
`))
    }

    // Top-level inject is only `slots`. `sidebarRightTabs` / `sidebarRight` are
    // shell services: putting them here (or reading `ctx.sidebarRightTabs`
    // without inject) throws `cannot get property without inject` and the web
    // boot fails the whole GUI. Register the right-column type with nested
    // `ctx.inject` instead; the open-in-right button uses `ctx.get`.
    const inject = ['slots']
    const name = 'dsh-flowspot'
    /** List id and matching `main` key: the sidebar row and the page share it. */
    const PANEL_ID = 'dsh-flowspot'
    /** Right-column tab type; `sidebarRight.openTab` names this kind. */
    const TAB_KIND = 'flowspot'
    /** Client context, kept so a button can open the same panel in the right column. */
    let clientContext = null

    /**
     * The sidebar row glyph. The shell owns the button, label, tooltip and rail
     * geometry, so this component only draws the glyph at the requested size;
     * `data-dsh-panel-entry` marks it for skin contracts that map rows to plugins.
     */
    function PanelIcon({ size }) {
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M3 5.5h9.5l-2.2-2.2' }),
        h('path', { d: 'M13 10.5H3.5l2.2 2.2' }))
    }

    /** The centre-column page. The layout mounts it only while this panel is selected. */
    function PanelPage() {
      return h('div', { className: 'dshwc-page', 'data-dsh-plugin': PANEL_ID }, h(Panel, { docked: false }))
    }

    /**
     * The same panel, laid out for the narrow right column.
     *
     * One placement rule makes the dock behave like a side column instead of a
     * second full page: if the centre column still shows this plugin's page, hand
     * it back to the Conversation. Otherwise the dock sits beside another copy of
     * itself and reads as "the request list covers the whole window".
     *
     * The shell's own fullscreen toggle is deliberately NOT driven from here: the
     * panel is also fullscreen when the viewport is under 768px, and flipping the
     * manual mode in that state would force the opposite of what the operator
     * sees. The host's ⛶ control stays the one owner of that choice.
     */
    function RightPaneBody() {
      useEffect(() => {
        const layout = getService('layout')
        if (!layout || typeof layout.selectPanel !== 'function') return
        const info = readObservable(layout.panelInfo)
        if (!info || info.activePanelId !== PANEL_ID) return
        try {
          layout.selectPanel(null)
        } catch {
          /* keep the page */
        }
      }, [])
      return h('div', { className: 'dshwc-rightpane', 'data-dsh-plugin': PANEL_ID }, h(Panel, { docked: true }))
    }

    function apply(ctx) {
      clientContext = ctx
      // Registrations live under the effect lifetime, like the host-side plugin:
      // unloading the client entry releases both seats.
      ctx.effect(() => {
        const disposers = []
        // Two seats, one id: the sidebar row selects the keyed `main` entry.
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => '抓包工具',
        }, (ownerProps) => h(PanelIcon, ownerProps || {}))))
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, () => h(PanelPage))))
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* already released */
            }
          }
        }
      }, 'dsh-flowspot: sidebar panel')

      // A tab type plus its body, so the panel also docks in the right column.
      // The `guide` entry is what puts 「抓包工具」 beside 工作区文件 / 新建终端 on
      // the "+" page; clicking it opens this kind.
      ctx.inject(['sidebarRightTabs'], (tabCtx) => {
        tabCtx.effect(() => tabCtx.sidebarRightTabs.register({
          id: PANEL_ID,
          kind: TAB_KIND,
          title: () => '抓包工具',
          guide: [{
            id: 'open',
            order: 30,
            title: () => '抓包工具',
            description: () => '系统级 HTTPS 抓包：开关、CA、请求列表',
          }],
        }), 'dsh-flowspot: right tab type')
      })

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: PANEL_ID,
      }, (ownerProps) => h(RightPaneBody, ownerProps || {}))), 'dsh-flowspot: right tab body')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
