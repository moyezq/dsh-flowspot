/**
 * dsh-flowspot 的面板侧模块。
 *
 * 在侧边栏面板列表（`sidebar.panellist`）挂一个一级入口，并在中栏（`main`，用同一个
 * id 作 key）挂它的整页——Skills、Memory 两个面板占的也是这两个位置，所以
 * 「抓包工具」跟它们并排，而不是躲进设置里。
 *
 * 数据只走插件自己的 /dsh-flowspot/* 路由，这个模块不碰宿主内部结构。
 *
 * 配色只用宿主主题 token（--dsw-alias-*），而且只用确认存在的那几个：不写色值兜底，
 * 缺 token 时继承上层颜色，而不是把面板悄悄钉死在暗色主题上。
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

    /** CDP 通道一行话，菜单与设置共用。 */
    function cdpTextOf(cdp) {
      if (!cdp) return '未启用'
      if (cdp.connected) {
        const name = (cdp.browser && cdp.browser.name) || '浏览器'
        return `已连接 ${name} · ${(cdp.targets || []).length} 个目标`
      }
      if (cdp.connecting) return '连接中…'
      if (cdp.enabled) return `未连接${cdp.lastError ? `（${cdp.lastError}）` : ''}`
      return '未启用'
    }

    function Cell(props) {
      return h('div', { className: 'dshwc-cell' },
        h('div', { className: 'dshwc-cell-label' }, props.label),
        h('div', { className: 'dshwc-cell-value' }, props.value))
    }

    /**
     * 请求详情里一个可折叠的块。故意用显式 button + 三角箭头而不是 <details>：
     * 这样间距和箭头能跟着宿主的 token 走，展开/收起状态也能在切换 flow 后留着。
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

    /** 类型筛选按钮，顺序照 F12 网络面板那一套排。 */
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
    /** 二级的方法筛选，只在 Fetch/XHR 下出现（它们本来就都是 HTTP 请求）。 */
    const METHOD_TABS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

    /** 头 map → 一行一个头，给 <pre> 块用。 */
    function headerText(map) {
      return Object.entries(map || {})
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n')
    }

    /**
     * 按名字取宿主服务，不经过 inject。在真正的 Cordis context 上直接读
     * `ctx.name` 会抛 `cannot get property … without inject`，当初就是这一抛让整个
     * GUI 起不来（ADR-0008），所以本模块碰到的每个服务都走 `get`。
     * @param {string} name 服务名
     * @returns {object|undefined} 该部署提供了这个服务时才有值
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

    /** 框架的 observable 可能只暴露三种读法之一，挨个试一遍。 */
    function readObservable(source) {
      if (!source) return undefined
      try {
        if (typeof source.getSnapshot === 'function') return source.getSnapshot()
        if (typeof source.get === 'function') return source.get()
        if (typeof source.value !== 'undefined') return source.value
      } catch {
        /* 这个 observable 读不出来 */
      }
      return undefined
    }

    /** 等一帧：中栏正是在这一帧里把会话界面装回去的。 */
    function nextFrame() {
      return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 16)
      })
    }

    /**
     * 等会话界面回位之后，再把页签开进右侧栏。
     *
     * 右侧栏的命令作用于「屏幕上那个会话」，一旦全局中栏面板（也就是本插件的整页）
     * 顶掉了 Conversation，它们就会直接抛错——就是那条很有名的「没有会话在屏幕上」。
     * 先把中栏交还、再跨几帧重试，这次切换才成功。
     * @param {object} right `ctx.sidebarRight`
     * @param {number} attempts 最多重试几帧
     * @returns {Promise<boolean>} 页签是否开出来了
     */
    async function openRightTabWhenReady(right, attempts = 24) {
      for (let i = 0; i < attempts; i++) {
        try {
          right.openTab(TAB_KIND)
          return true
        } catch {
          /* 会话界面还没装回来 */
        }
        await nextFrame()
      }
      return false
    }

    /**
     * 在整页（中栏）和右侧栏之间挪面板，也就是 ⇄ 按钮承诺的事：同一时刻只存在
     * 一份，而不是两边各留一个副本。
     *
     * 每条宿主命令都各自 try 住：部署里没有右侧栏、或屏幕上没有会话（右侧栏命令在
     * 那里会报错）时，应该保持当前位置不动，而不是让一次点击抛出去。
     * @param {boolean} docked 当前是否渲染在右侧栏里
     * @returns {Promise<'page'|'right'|null>} 最终到达的位置
     */
    async function togglePlacement(docked) {
      const layout = getService('layout')
      const right = getService('sidebarRight')
      if (docked) {
        // 右侧栏 → 整页：顺手把自己那个页签也带走。
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
            /* 页签没关掉也无妨，整页已经选上了 */
          }
        }
        return 'page'
      }
      // 整页 → 右侧栏。必须先把中栏交还：我们的整页占着它时屏幕上没有会话，
      // open 一调就抛。
      if (!right || typeof right.openTab !== 'function') return null
      if (layout && typeof layout.selectPanel === 'function') {
        try {
          layout.selectPanel(null)
        } catch {
          /* 真正的失败会由下面的 open 尝试报出来 */
        }
      }
      const opened = await openRightTabWhenReady(right)
      return opened ? 'right' : null
    }

    /** ⇄ 图标：整页与右侧栏互换。 */
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
     * 和 `lib/flows.js` 用的是同一份易变参数集合，故意抄一遍：面板侧 bundle 不能
     * import 宿主代码，而下面的降级路径必须在宿主侧比本 bundle 旧时表现完全一致。
     */
    const VOLATILE_QUERY_PARAMS = new Set([
      't', 'ts', 'timestamp', 'time', '_', '_t', 'nonce', 'rnd', 'random',
      'page', 'pagenum', 'pageno', 'pagesize', 'page_size', 'offset', 'limit',
      'cursor', 'since', 'seq', 'count',
    ])

    /** `normalizeUrl` 在面板侧的镜像实现。 */
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
     * 宿主侧还没有 `listGroups` 时的合并降级（刷新页面会换上新的 bundle，但进程里
     * 跑的仍是它启动时那份宿主代码）。这时 `×N` 只统计本次拉到的这一页，不是整个
     * 环形缓冲。
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
      // 面板的 origin 和宿主的 http 源对不上时，浏览器里的扩展不可能自己找到这个宿主
      // （桌面端界面在 dsh-app:// 里，内容脚本没有落脚处），必须由面板把地址交出去。
      const bridgeBase = (status && status.bridge && status.bridge.base) || ''
      const bridgeNeedsHandoff = Boolean(bridgeBase) && typeof location !== 'undefined' && location.origin !== bridgeBase
      // 宿主跑在 node 子进程（桌面端）时 process.versions.electron 是空的，只能当弱信号。
      const isDesktop = Boolean((status && status.platform && status.platform.electron) || bridgeNeedsHandoff)
      /** 扩展连不上时补一句桌面端该怎么做（web 端没这问题，保持原话）。 */
      const bridgeFailText = useCallback((text) => {
        const base = text || '扩展没有响应：确认已加载并处于启用状态'
        if (!bridgeNeedsHandoff) return base
        return `${base}。先点「在 Chrome 中打开」，再点一下 Chrome 工具栏上的 Flowspot 图标，让扩展认下这个地址`
      }, [bridgeNeedsHandoff])
      const [flows, setFlows] = useState([])
      /** 两个互斥模式：系统抓包 / CDP 抓包；数据各自保留，切换只暂停另一边。 */
      const [mode, setMode] = useState(() => {
        try {
          return localStorage.getItem('dshwc.mode') === 'cdp' ? 'cdp' : 'system'
        } catch {
          return 'system'
        }
      })
      /** CDP 通道的独立开关：不依赖「开始抓包」。 */
      const [cdpArmed, setCdpArmed] = useState(false)
      const [picker, setPicker] = useState({ open: false, loading: false, tabs: [], error: '' })
      const [detail, setDetail] = useState(null)
      /** CDP 直接观测到的请求；和系统 flow 合并在同一个列表里，不单独开页面。 */
      const [cdpFlows, setCdpFlows] = useState([])
      const [cdpDetail, setCdpDetail] = useState(null)
      /** CDP 详情的两个页签：抓到的请求（含调用链）与生成的脚本。 */
      const [cdpDetailTab, setCdpDetailTab] = useState('request')
      const [cdpCode, setCdpCode] = useState(null)
      const [cdpCodeBusy, setCdpCodeBusy] = useState(false)
      const [cdpCopied, setCdpCopied] = useState(false)
      const [body, setBody] = useState(null)
      const [reqBodyText, setReqBodyText] = useState(null)
      const [selected, setSelected] = useState(null)
      const [type, setType] = useState('all')
      const [method, setMethod] = useState('')
      const [keyword, setKeyword] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      /** 设置弹窗：证书与数据目录现在都收在这里。 */
      const [settingsOpen, setSettingsOpen] = useState(false)
      /** 请求列表的分窗归谁主导：成功、失败，还是 8:2。 */
      const [failureView, setFailureView] = useState('split')
      /** 操作者最后一次清空的时刻；比这更旧的失败保持隐藏。 */
      const [errorsClearedAt, setErrorsClearedAt] = useState(0)
      /** 合并：一行一个端点（方法 + URL），可展开看它的每次调用。 */
      const [mergeOn, setMergeOn] = useState(false)
      const [groups, setGroups] = useState([])
      const [openGroups, setOpenGroups] = useState({})
      /** true 表示这些组是本 bundle 自己合的，不是宿主给的。 */
      const [localMerge, setLocalMerge] = useState(false)
      /** 请求详情里的各个块独立折叠；切换 flow 时展开状态仍在。 */
      const [openSections, setOpenSections] = useState({ cdp: true, error: true, req: true, reqBody: true, resp: true, respBody: true })
      /** 请求详情现在显示哪一半：抓到的请求，还是生成的脚本。 */
      const [detailTab, setDetailTab] = useState('request')
      /** CDP 调用链：随详情一起拉；未连接或没配到时 matched=false，参数分析仍然有。 */
      const [chain, setChain] = useState(null)
      /** 调用链点一帧后弹出的源码查看器（只看调用点附近的片段）。 */
      const [sourceView, setSourceView] = useState(null)
      /** 调用链默认显示完整栈（对齐 F12），勾选后只看业务帧。 */
      const [onlyBusinessChain, setOnlyBusinessChain] = useState(false)
      /** 代码语言按钮：偏好存在宿主侧，所以哪个浏览器打开顺序都一样。 */
      const [codePrefs, setCodePrefs] = useState(null)
      const [codeLang, setCodeLang] = useState('')
      const [codeView, setCodeView] = useState(null)
      const [codeBusy, setCodeBusy] = useState(false)
      const [copied, setCopied] = useState(false)
      const mounted = useRef(true)
      /** 始终是最新的筛选条件：3 秒轮询读它，就不必因为筛选变了重开定时器。 */
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
          // 宿主侧偏旧：在本地合并一份，按钮照样能用。
          setGroups(groupLocal(list, false))
          setLocalMerge(true)
        } else {
          setGroups([])
          setLocalMerge(false)
        }
      }, [])

      /** CDP 侧请求：补进同一个列表，只补没配到 flow 的那些。 */
      const loadCdp = useCallback(async () => {
        const s = await api('/dsh-flowspot/cdp/requests?limit=200')
        if (!mounted.current || !s.ok) return
        const typeMap = {
          XHR: 'xhr', Fetch: 'xhr', Document: 'doc', Stylesheet: 'css', Script: 'js',
          Image: 'img', Media: 'media', Font: 'font', WebSocket: 'ws', Manifest: 'manifest', Wasm: 'wasm',
        }
        const list = (Array.isArray(s.requests) ? s.requests : []).map((item) => {
          let host = ''
          let path = item.url
          try {
            const parsed = new URL(item.url)
            host = parsed.host
            path = parsed.pathname + parsed.search
          } catch {
            /* data:/blob: 没有 host */
          }
          return {
            ...item,
            host,
            path,
            ts: item.at,
            cdp: true,
            type: typeMap[item.type] || 'other',
            resourceType: item.type || '',
            initiator: item.initiator || null,
          }
        })
        setCdpFlows(list)
      }, [])

      // 状态 3 秒一轮；请求列表与 CDP 补录都跟着轮询。
      useEffect(() => {
        refresh()
        loadFlows(filtersRef.current)
        loadCdp()
        const timer = setInterval(() => {
          refresh()
          loadFlows(filtersRef.current)
          loadCdp()
        }, 3000)
        return () => clearInterval(timer)
      }, [refresh, loadFlows, loadCdp])

      useEffect(() => {
        try {
          localStorage.setItem('dshwc.mode', mode)
        } catch {
          /* 隐私模式禁用 localStorage 不影响使用 */
        }
      }, [mode])


      // 防抖：关键词框里每敲一个字就发一次请求太浪费。
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
       * 清空两份列表。旧宿主只清请求环形缓冲，所以面板自己记下这一刻，
       * 把清空之前发生的失败在本地藏掉。
       */
      const clearAll = useCallback(() => {
        setErrorsClearedAt(Date.now())
        // 先把列表和“最近错误”清掉再发请求：否则清空的一瞬间旧失败行还会用红色
        // 重绘一帧，看起来像闪出一条红字，也会因为一次渲染上千行而卡一下。
        setFlows([])
        setGroups([])
        setSelected(null)
        setDetail(null)
        setChain(null)
        setBody(null)
        setReqBodyText(null)
        setCodeView(null)
        setStatus((prev) => (prev && prev.proxy ? { ...prev, proxy: { ...prev.proxy, lastError: null } } : prev))
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

      /** CDP 模式自己的清空：只清 CDP 索引，不动系统 flow。 */
      const clearCdp = useCallback(() => {
        setCdpFlows([])
        setSelected(null)
        setCdpDetail(null)
        setDetail(null)
        return act(async () => post('/dsh-flowspot/cdp', { action: 'clear' }), 'CDP 请求已清空')
      }, [act])


      /**
       * 请宿主弹原生目录选择框（或者清掉已存的选择），再把结果落到数据目录上。
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

      // 只负责请求详情本身：选中、拉详情、拉两份体。切换请求时不清空上一份，
      // 等新数据回来再替换；清空只由「清空」按钮负责。
      const detailSeq = useRef(0)
      const openDetail = useCallback(async (id) => {
        setSelected(id)
        const seq = ++detailSeq.current
        const d = await api(`/dsh-flowspot/detail?id=${encodeURIComponent(id)}`)
        if (!mounted.current || seq !== detailSeq.current) return
        if (!d.ok) { setMessage({ kind: 'error', text: d.error || '读取失败' }); return }
        setDetail(d.flow)
        setCdpDetail(null)
        setReqBodyText(null)
        // 调用链与详情并行拉：CDP 没连、或这条请求不是浏览器发的，都只是
        // matched=false，不该拖慢请求页。旧 chain 先留着，新结果回来再换。
        api(`/dsh-flowspot/cdp/chain?id=${encodeURIComponent(id)}&source=0`)
          .then((result) => {
            if (mounted.current && seq === detailSeq.current && result.ok) setChain(result)
          })
          .catch(() => {})
        const b = await api(`/dsh-flowspot/body?id=${encodeURIComponent(id)}&side=response&limit=4000`)
        if (mounted.current && seq === detailSeq.current && b.ok) setBody(b)
        // 请求体只在 flow 确实有时才去拉，两边各自放进自己的可折叠块里显示。
        if (d.flow && d.flow.reqBody) {
          const rb = await api(`/dsh-flowspot/body?id=${encodeURIComponent(id)}&side=request&limit=4000`)
          if (mounted.current && seq === detailSeq.current && rb.ok) setReqBodyText(rb)
        }
      }, [])


      /** CDP 补录的请求没有 proxy flow：仍在同一个详情窗口里展示。 */
      const openCdp = useCallback(async (item) => {
        setSelected(item.id)
        const result = await api(`/dsh-flowspot/cdp/request?id=${encodeURIComponent(item.id)}`)
        if (!mounted.current) return
        if (!result.ok) {
          setMessage({ kind: 'error', text: result.error || '读取 CDP 请求失败' })
          return
        }
        setDetail(null)
        setCdpDetail(result.request)
        setChain(null)
      }, [])


      /** 点调用链里的一帧：按行取源码窗口，放在弹窗里。 */
      /**
       * 复制到剪贴板：先走 Clipboard API，失败了退到临时 textarea（老浏览器/无 HTTPS 的宿主）。
       * F12 的调用链没法复制，所以这一步是本插件要补的实际动作。
       */
      const copyText = useCallback(async (text, label = '') => {
        const value = String(text || '')
        if (!value) {
          setMessage({ kind: 'error', text: '没有可复制的内容' })
          return
        }
        const done = () => setMessage({ kind: 'ok', text: `已复制${label ? ` ${label}` : ''}` })
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value)
            done()
            return
          }
        } catch {
          /* 落到下面的兜底 */
        }
        try {
          const area = document.createElement('textarea')
          area.value = value
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          if (ok) done()
          else setMessage({ kind: 'error', text: '复制失败：浏览器拒绝了剪贴板访问' })
        } catch (err) {
          setMessage({ kind: 'error', text: `复制失败：${err.message || err}` })
        }
      }, [])

      /**
       * 源码查看器：只给调用点附近的片段。
       *
       * 压缩过的 bundle 整份只有一行，宿主按列切一段并展开成多行（`lines`），
       * 这里只负责显示；普通文件仍按行给上下文（`text`）。同名方法在一个文件里不唯一，
       * 所以带上帧的函数名，宿主数出所有同名位置，面板用「上一处/下一处」翻。
       * `hitIndex` 为 -1 表示「这一帧自己的调用点」（默认）。
       */
      const loadSource = useCallback(async (frame, { hitIndex = -1 } = {}) => {
        if (!frame) return
        const named = frame.needle
          || (frame.functionName && frame.functionName !== '(anonymous)' ? frame.functionName : '')
        const needle = String(named || '').trim()
        const meta = {
          title: `${(frame.url || '(inline)').split('/').pop()}:${frame.lineNumber ?? '?'}:${frame.columnNumber ?? '?'}`,
          url: frame.url || '',
          name: frame.functionName || frame.name || '',
          line: frame.lineNumber ?? frame.line ?? null,
          column: frame.columnNumber ?? frame.column ?? null,
          scriptKey: frame.scriptKey || '',
          scriptId: frame.scriptId || '',
          sessionId: frame.sessionId || '',
          needle,
        }
        if (!frame.scriptKey && !frame.scriptId) {
          setSourceView({ ...meta, loading: false, error: '这一帧没有 scriptId（内联脚本或预加载请求），拿不到源码', text: '' })
          return
        }
        setSourceView({ ...meta, loading: true, error: null, text: '', lines: null })
        const params = [
          `key=${encodeURIComponent(frame.scriptKey || '')}`,
          `scriptId=${encodeURIComponent(frame.scriptId || '')}`,
          `sessionId=${encodeURIComponent(frame.sessionId || '')}`,
          `url=${encodeURIComponent(frame.url || '')}`,
          `line=${Math.max(0, (Number(frame.lineNumber) || 1) - 1)}`,
          `column=${Math.max(1, Number(frame.columnNumber) || 1)}`,
          'context=10',
          'chars=1200',
          `needle=${encodeURIComponent(needle)}`,
          `hit=${Number(hitIndex) || 0}`,
        ]
        const result = await api(`/dsh-flowspot/cdp/source?${params.join('&')}`)
        if (!mounted.current) return
        if (!result.ok) {
          setSourceView({ ...meta, loading: false, error: result.error || '读取源码失败', text: '', lines: null })
          return
        }
        setSourceView({
          ...meta,
          loading: false,
          error: null,
          text: result.text || '',
          lines: Array.isArray(result.lines) ? result.lines : null,
          mark: result.mark || null,
          truncated: Boolean(result.truncated),
          mode: result.mode || '',
          hits: result.hits || null,
          totalChars: result.totalChars ?? 0,
          totalLines: result.totalLines ?? 0,
          startLine: result.startLine ?? null,
          endLine: result.endLine ?? null,
          highlightLine: result.highlightLine ?? null,
        })
      }, [])

      const openSource = useCallback((frame) => {
        loadSource(frame)
      }, [loadSource])

      /**
       * 在资源管理器里选中某个落盘的脚本（不给 key 就打开整个源码目录）。
       * 想拿整份 JS 自己分析时，比在面板里复制更顺手。
       */
      const revealSource = useCallback(async (frame) => {
        const key = typeof frame === 'string' ? frame : (frame && frame.scriptKey) || ''
        try {
          const result = await post('/dsh-flowspot/cdp/reveal', { key })
          if (!mounted.current) return
          if (!result || result.ok === false) {
            setMessage({ kind: 'error', text: (result && result.error) || '打开源码位置失败' })
            return
          }
          if (result.file) {
            setMessage({ kind: 'ok', text: `已在资源管理器选中 ${String(result.file).split('\\').pop()}` })
          } else {
            setMessage({ kind: 'ok', text: `已打开源码目录${result.missing ? '（这个脚本没落盘）' : ''}：${result.dir}` })
          }
        } catch (err) {
          setMessage({ kind: 'error', text: `打开源码位置失败：${err.message || err}` })
        }
      }, [])

      /**
       * 让宿主在浏览器里打开「扩展连接页」：扩展借此记住宿主真实的 http 地址。
       * 桌面端（dsh-app://）没有内容脚本可跑，这是唯一能自动交接地址的入口。
       */
      const openBridgeHello = useCallback(async () => {
        const base = bridgeBase
        const result = await post('/dsh-flowspot/bridge/open-hello', { base })
        if (!mounted.current) return
        if (!result || result.ok === false) {
          setMessage({
            kind: 'error',
            text: (result && result.error) || `没打开浏览器；手动在 Chrome 里打开 ${base}/dsh-flowspot/bridge/hello`,
          })
          return
        }
        setMessage({ kind: 'ok', text: `已在浏览器打开连接页；扩展会记住 ${base}，那页可以关掉` })
      }, [bridgeBase])

      /**
       * 代码语言按钮来自宿主侧的偏好文件，而不是这个 bundle 里的常量，这样整页和
       * 右侧栏显示的顺序一致。
       */
      const loadCodePrefs = useCallback(async () => {
        const result = await api('/dsh-flowspot/code-prefs')
        if (!mounted.current || !result.ok) return
        setCodePrefs(result)
        setCodeLang((current) => {
          const visible = (result.langs || []).filter((lang) => !lang.hidden).map((lang) => lang.id)
          return current && visible.includes(current) ? current : visible[0] || 'curl'
        })
      }, [])

      useEffect(() => {
        loadCodePrefs()
      }, [loadCodePrefs])

      // 按需生成：只有代码视图可见、且选了语言时才拉，所以平时切 flow 不会给
      // 请求页添多余的调用。
      useEffect(() => {
        if (detailTab !== 'code' || !selected || !codeLang) return undefined
        let alive = true
        // 清空放在这里，不放在 openDetail：重复点同一行时屏幕上已有的代码不能变空，
        // 而换了另一行时也不能继续显示上一条请求的脚本。
        setCodeView(null)
        setCodeBusy(true)
        api(`/dsh-flowspot/code?id=${encodeURIComponent(selected)}&lang=${encodeURIComponent(codeLang)}`)
          .then((result) => {
            if (!alive || !mounted.current) return
            if (result.ok) setCodeView(result)
            else setMessage({ kind: 'error', text: result.error || '生成代码失败' })
          })
          .finally(() => {
            if (alive && mounted.current) setCodeBusy(false)
          })
        return () => {
          alive = false
        }
      }, [detailTab, selected, codeLang])

      // CDP 详情也有一条代码页：同一个生成器、同一个语言偏好，只是请求来自标签页观测。
      useEffect(() => {
        if (cdpDetailTab !== 'code' || !cdpDetail || !codeLang) return undefined
        let alive = true
        setCdpCode(null)
        setCdpCodeBusy(true)
        api(`/dsh-flowspot/cdp/code?id=${encodeURIComponent(cdpDetail.id)}&lang=${encodeURIComponent(codeLang)}`)
          .then((result) => {
            if (!alive || !mounted.current) return
            if (result.ok) setCdpCode(result)
            else setMessage({ kind: 'error', text: result.error || '生成代码失败' })
          })
          .finally(() => {
            if (alive && mounted.current) setCdpCodeBusy(false)
          })
        return () => {
          alive = false
        }
      }, [cdpDetailTab, cdpDetail ? cdpDetail.id : '', codeLang])

      const copyCdpCode = useCallback(async () => {
        if (!cdpCode || !cdpCode.code) return
        try {
          await navigator.clipboard.writeText(cdpCode.code)
          setCdpCopied(true)
          setTimeout(() => mounted.current && setCdpCopied(false), 1500)
        } catch {
          setMessage({ kind: 'error', text: '复制失败：浏览器拒绝了剪贴板访问' })
        }
      }, [cdpCode])

      const copyCode = useCallback(async () => {
        if (!codeView || !codeView.code) return
        try {
          await navigator.clipboard.writeText(codeView.code)
          setCopied(true)
          setTimeout(() => {
            if (mounted.current) setCopied(false)
          }, 1500)
        } catch {
          setMessage({ kind: 'error', text: '复制失败：浏览器不允许写剪贴板，请手动选中代码复制' })
        }
      }, [codeView])

      const saveCodePrefs = useCallback(async (next) => {
        setBusy(true)
        try {
          const result = await post('/dsh-flowspot/code-prefs', next)
          if (!mounted.current) return
          if (!result.ok) {
            setMessage({ kind: 'error', text: result.error || '保存代码语言偏好失败' })
            return
          }
          setCodePrefs(result)
          setCodeLang((current) => {
            const visible = (result.langs || []).filter((lang) => !lang.hidden).map((lang) => lang.id)
            return current && visible.includes(current) ? current : visible[0] || 'curl'
          })
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [])


      /** 在资源管理器里打开 logs/；失败时把原因说在面板里。 */
      const openLogsDir = useCallback(async () => {
        const result = await post('/dsh-flowspot/logs/open')
        if (!mounted.current) return
        if (result.ok === false) setMessage({ kind: 'error', text: result.error || '打开日志目录失败' })
      }, [])

      /**
       * 扩展桥：面板不再和内容脚本说话，直接让宿主把命令排进扩展的长轮询队列。
       * 扩展已加载与否看 /status 里的 cdp.extension（最近 45 秒内轮询过）。
       */
      const runBridge = useCallback(async (action, tabId) => {
        setBusy(true)
        try {
          if (action !== 'detach' && status && status.proxy && status.proxy.running) {
            const stopped = await post('/dsh-flowspot/serve', { action: 'stop' })
            if (stopped && stopped.ok === false) {
              setMessage({ kind: 'error', text: stopped.error || '停止系统抓包失败' })
              return
            }
          }
          const result = await post('/dsh-flowspot/bridge/command', { action, tabId })
          if (!mounted.current) return
          if (!result.ok) {
            setMessage({ kind: 'error', text: bridgeFailText(result.error) })
          } else {
            setCdpArmed(action !== 'detach')
            if (action !== 'detach') setMode('cdp')
            await refresh()
          }
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [refresh, status])

      const attachBridge = useCallback(() => runBridge('attach-last'), [runBridge])

      /** 扩展最近 45 秒内轮询过宿主才算在线；面板按钮据此置灰。 */
      const bridgeReady = Boolean(status && status.cdp && status.cdp.extension && status.cdp.extension.connected)
      /** 只要扩展曾经连上过就允许点：短暂休眠可以由下一次轮询/唤醒接回来。 */
      const bridgeKnown = Boolean(status && status.cdp && status.cdp.extension && status.cdp.extension.seenAt)

      /** 打开标签页选择弹窗；列表来自扩展（tabs 命令）。 */
      const openPicker = useCallback(async () => {
        setPicker({ open: true, loading: true, tabs: [], error: '' })
        const result = await post('/dsh-flowspot/bridge/command', { action: 'tabs' })
        if (!mounted.current) return
        if (!result.ok) {
          setPicker({ open: true, loading: false, tabs: [], error: bridgeFailText(result.error) })
          return
        }
        const tabs = result.result && Array.isArray(result.result.tabs) ? result.result.tabs : []
        setCdpArmed(true)
        setPicker({ open: true, loading: false, tabs, error: '' })
      }, [])

      const takeover = useCallback(async (tabId) => {
        setBusy(true)
        setPicker((prev) => ({ ...prev, loading: true, error: '' }))
        try {
          if (status && status.proxy && status.proxy.running) {
            const stopped = await post('/dsh-flowspot/serve', { action: 'stop' })
            if (stopped && stopped.ok === false) {
              setMessage({ kind: 'error', text: stopped.error || '停止系统抓包失败' })
              return
            }
          }
          const result = await post('/dsh-flowspot/bridge/command', { action: 'attach-tab', tabId })
          if (!mounted.current) return
          if (!result.ok) {
            setPicker((prev) => ({ ...prev, loading: false, error: result.error || '接管失败' }))
            return
          }
          setPicker({ open: false, loading: false, tabs: [], error: '' })
          setCdpArmed(true)
          setMode('cdp')
          await refresh()
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [refresh, status])

      /**
       * 「连接浏览器」：先让扩展接上当前活动页（等同点扩展图标），再列出标签页。
       * 这样通道是真的连着，而不是只唤醒扩展；选完可以重新选择。
       */
      const connectBrowser = useCallback(async () => {
        setBusy(true)
        try {
          if (status && status.proxy && status.proxy.running) {
            const stopped = await post('/dsh-flowspot/serve', { action: 'stop' })
            if (stopped && stopped.ok === false) {
              setMessage({ kind: 'error', text: stopped.error || '停止系统抓包失败' })
              return
            }
          }
          const result = await post('/dsh-flowspot/bridge/command', { action: 'attach-last' })
          if (!mounted.current) return
          if (!result.ok) {
            setMessage({ kind: 'error', text: bridgeFailText(result.error) })
            // 当前页没接上也不挡着选别的页面：继续列标签页。
            await openPicker()
            return
          }
          setCdpArmed(true)
          setMode('cdp')
          await refresh()
          await openPicker()
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [refresh, openPicker, status])

      /** 关闭 CDP：断开扩展调试，不影响系统抓包，也不清请求详情。 */
      const closeCdp = useCallback(async () => {
        await runBridge('detach')
        setCdpArmed(false)
      }, [runBridge])


      const running = Boolean(status && status.proxy && status.proxy.running)
      const port = status && status.proxy ? status.proxy.port : null
      const portNote = status && status.proxy ? status.proxy.portNote : null
      const caInstalled = Boolean(status && status.ca && status.ca.installed)
      const sysOn = Boolean(status && status.systemProxy && status.systemProxy.enabled)
      const total = status && status.flows ? status.flows.total : 0
      const lastError = status && status.proxy ? status.proxy.lastError : null
      const cdp = (status && status.cdp) || null
      const bridgeTab = cdp && cdp.bridge ? cdp.bridge : null
      const cdpPaused = Boolean(cdp && cdp.bridgePaused)
      const chainFrames = chain && chain.initiator && Array.isArray(chain.initiator.frames)
        ? chain.initiator.frames.filter((frame) => !onlyBusinessChain || !frame.noise)
        : []
      const cdpChainFrames = cdpDetail && cdpDetail.initiator && Array.isArray(cdpDetail.initiator.frames)
        ? cdpDetail.initiator.frames.filter((frame) => !onlyBusinessChain || !frame.noise)
        : []
      /** 业务方法名（可点开源码）：这是 F12 Initiator 左侧最该先看的东西。 */
      const namesOf = (frames) => {
        const names = []
        for (const frame of frames) {
          const name = frame.functionName
          if (!frame.noise && name && name !== '(anonymous)' && !names.includes(name)) names.push(name)
        }
        return names
      }
      const chainBusinessNames = namesOf(chainFrames)
      const cdpBusinessNames = namesOf(cdpChainFrames)
      /**
       * 帧列表：段号变大时插一条 Continue async 分隔，和 F12 的 Initiator 对齐。
       * 每帧右侧单独一个复制按钮——点帧是打开源码，复制方法名是另一件事。
       */
      const chainFrameRows = (frames, limit = 60) => {
        const rows = []
        const multi = frames.some((frame) => (frame.asyncLevel || 0) > 0)
        let level = 0
        frames.slice(0, limit).forEach((frame, index) => {
          const asyncLevel = frame.asyncLevel || 0
          if (multi && asyncLevel > level) {
            rows.push(h('div', { key: `sep:${index}`, className: 'dshwc-chainsep' }, `Continue async（第 ${asyncLevel} 段）`))
          }
          level = asyncLevel
          rows.push(h('div', { key: `row:${index}`, className: 'dshwc-chainrow' },
            h('button', {
              className: `dshwc-chainframe${frame.noise ? ' dshwc-chainframe-noise' : ''}`,
              type: 'button',
              title: frame.url || '(inline)',
              onClick: () => openSource(frame),
            },
              h('span', { className: 'dshwc-chainfn' }, `${frame.noise ? '[壳] ' : ''}${frame.functionName}`),
              h('span', { className: 'dshwc-chainloc' }, `${frame.url ? frame.url.split('/').pop() : '(inline)'}:${frame.lineNumber ?? '?'}`)),
            h('button', {
              className: 'dshwc-iconbtn dshwc-chaincopy',
              type: 'button',
              title: '复制方法名',
              onClick: () => copyText(frame.functionName, frame.functionName),
            }, '⧉'),
            h('button', {
              className: 'dshwc-iconbtn dshwc-chaincopy',
              type: 'button',
              title: '在资源管理器里打开这个脚本（自己拷走分析）',
              onClick: () => revealSource(frame),
            }, '📂')))
        })
        return rows
      }
      /** 一段帧的规模：多少帧、几段、几个壳。 */
      const chainSize = (initiator) => {
        if (!initiator) return ''
        const parts = [`${initiator.totalFrames || 0} 帧`]
        if (initiator.asyncLevels) parts.push(`${initiator.asyncLevels} 段`)
        if (initiator.filteredFrames) parts.push(`${initiator.filteredFrames} 个壳`)
        return parts.join(' · ')
      }
      const recentErrors = (status && status.proxy && status.proxy.recentErrors) || []
      // 旧宿主清空后仍保留失败摘要。这里把早于清空时刻的条目在本地藏掉，让「清空」
      // 看起来确实生效了；之后新发生的失败照样显示。
      const visibleErrors = errorsClearedAt
        ? recentErrors.filter((item) => (item.ts || 0) > errorsClearedAt)
        : recentErrors
      // 面板 bundle 跟着页面刷新，宿主代码却要重启进程才换。从不报 `build` 的
      // 宿主就是老版本。
      const hostStale = Boolean(status) && !status.build
      const paths = status && status.paths ? status.paths : null
      const dirText = paths
        ? `数据目录：${paths.dir}${paths.pending ? `（已选择 ${paths.pending}，重启后生效）` : ''}`
        : '数据目录：—'

      /**
       * 模式切换 = 暂停另一边：
       * 系统→CDP 先停系统代理；CDP→系统只暂停事件接收，调试图和 CDP 列表都保留。
       */
      const switchMode = async (next) => {
        if (next === mode) return
        setBusy(true)
        try {
          if (next === 'cdp') {
            if (running) {
              const stopped = await post('/dsh-flowspot/serve', { action: 'stop' })
              if (stopped && stopped.ok === false) {
                setMessage({ kind: 'error', text: stopped.error || '停止系统抓包失败，未切换模式' })
                return
              }
            }
            if (bridgeTab && cdpPaused) {
              const resumed = await post('/dsh-flowspot/cdp', { action: 'resume' })
              if (resumed && resumed.ok === false) {
                setMessage({ kind: 'error', text: resumed.error || '恢复 CDP 失败' })
                return
              }
            }
          } else if (bridgeTab && !cdpPaused) {
            const paused = await post('/dsh-flowspot/cdp', { action: 'pause' })
            if (paused && paused.ok === false) {
              setMessage({ kind: 'error', text: paused.error || '暂停 CDP 失败，未切换模式' })
              return
            }
          }
          setMode(next)
          setType('all')
          setMethod('')
          setKeyword('')
          setSelected(null)
          setDetail(null)
          setCdpDetail(null)
          await refresh()
          await loadFlows(filtersRef.current)
          await loadCdp()
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      /** 开始系统抓包前先把 CDP 暂停，保证启动状态互斥。 */
      const toggleServe = () => act(async () => {
        if (!running && bridgeTab && !cdpPaused) {
          const paused = await post('/dsh-flowspot/cdp', { action: 'pause' })
          if (paused && paused.ok === false) return paused
        }
        return post('/dsh-flowspot/serve', { action: running ? 'stop' : 'start' })
      }, running ? '已停止代理并恢复系统代理' : '代理已启动，系统代理已指向本机')

      // 两个模式各自一套数据，但共用同一套列表/合并/筛选逻辑。
      const needle = keyword.trim().toLowerCase()
      const cdpFiltered = cdpFlows.filter((item) => {
        if (type !== 'all' && item.type !== type) return false
        if (method && item.method !== method) return false
        if (needle && !item.url.toLowerCase().includes(needle)) return false
        return true
      })
      const cdpGroups = mergeOn ? groupLocal(cdpFiltered, false) : []
      const activeFlows = mode === 'cdp' ? cdpFiltered : flows
      const activeGroups = mode === 'cdp' ? cdpGroups : groups
      const listSource = activeFlows
      const totalShown = listSource.length
      const showGroups = mergeOn && activeGroups.length > 0

      const toggleSection = (key) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
      const toggleGroup = (key) => setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }))

      const allLangs = (codePrefs && codePrefs.langs) || []
      const visibleLangs = allLangs.filter((lang) => !lang.hidden)

      /**
       * 代码页：语言 chips + 生成结果 + 复制 + 提示。
       * 系统抓包与 CDP 抓包两处详情共用，避免两套详情功能分叉。
       */
      const codePane = ({ busy, view, copied: done, onCopy }) => h('div', { className: 'dshwc-codepane' },
        h('div', { className: 'dshwc-chips' }, visibleLangs.map((lang) => h('button', {
          key: lang.id,
          className: 'dshwc-chip',
          type: 'button',
          title: lang.note,
          'data-active': codeLang === lang.id ? 'true' : 'false',
          onClick: () => setCodeLang(lang.id),
        }, lang.label))),
        busy ? h('div', { className: 'dshwc-note' }, '生成中…') : null,
        view && view.ok
          ? h('div', { className: 'dshwc-codewrap' },
            h('div', { className: 'dshwc-row dshwc-codeactions' },
              h('span', { className: 'dshwc-note' }, view.note || ''),
              h('button', { className: 'dshwc-btn dshwc-btn-small', type: 'button', onClick: onCopy }, done ? '已复制' : '复制代码')),
            h('pre', { className: 'dshwc-pre dshwc-code' }, view.code),
            view.notes && view.notes.length
              ? h('div', { className: 'dshwc-notes' }, view.notes.map((note, index) => h('div', { className: 'dshwc-note', key: index }, `· ${note}`)))
              : null)
          : h('div', { className: 'dshwc-note' }, busy ? '正在生成…' : '选一条请求，这里会生成对应语言的脚本。'))

      /**
       * 把一种代码语言在设置列表里挪一格，并把整份顺序存下去。这份顺序同时也是
       * 代码视图上按钮的顺序。
       */
      const moveLang = (index, delta) => {
        const target = index + delta
        if (target < 0 || target >= allLangs.length) return
        const next = allLangs.slice()
        const [item] = next.splice(index, 1)
        next.splice(target, 0, item)
        saveCodePrefs({
          order: next.map((lang) => lang.id),
          hidden: next.filter((lang) => lang.hidden).map((lang) => lang.id),
        })
      }

      /** 显示或隐藏一种代码语言按钮；最后一个可见的不能隐藏。 */
      const toggleLang = (id) => {
        const current = allLangs.find((lang) => lang.id === id)
        if (!current) return
        if (!current.hidden && allLangs.filter((lang) => !lang.hidden).length <= 1) {
          setMessage({ kind: 'error', text: '至少保留一种代码语言' })
          return
        }
        const next = allLangs.map((lang) => (lang.id === id ? { ...lang, hidden: !lang.hidden } : lang))
        saveCodePrefs({
          order: next.map((lang) => lang.id),
          hidden: next.filter((lang) => lang.hidden).map((lang) => lang.id),
        })
      }

      /**
       * 设置里「代码语言」这一节：一个可见性勾选框，加朴素的上下移动。为六行数据
       * 写一套拖放的 pointer 处理不值得。
       */
      const codeSettings = h('div', { className: 'dshwc-setting' },
        h('div', { className: 'dshwc-setting-head' }, '代码语言'),
        h('div', { className: 'dshwc-note' }, '接口详情「代码」页显示哪些语言、按什么顺序；至少保留一种。'),
        h('div', { className: 'dshwc-langlist' },
          allLangs.map((lang, index) => h('div', { className: 'dshwc-langrow', key: lang.id },
            h('label', { className: 'dshwc-langname' },
              h('input', {
                type: 'checkbox',
                checked: !lang.hidden,
                disabled: busy || (!lang.hidden && visibleLangs.length <= 1),
                onChange: () => toggleLang(lang.id),
              }),
              h('span', null, lang.label)),
            h('button', {
              className: 'dshwc-iconbtn',
              type: 'button',
              title: '上移',
              disabled: busy || index === 0,
              onClick: () => moveLang(index, -1),
            }, '↑'),
            h('button', {
              className: 'dshwc-iconbtn',
              type: 'button',
              title: '下移',
              disabled: busy || index === allLangs.length - 1,
              onClick: () => moveLang(index, 1),
            }, '↓')))))

      /** 一条抓到的请求。失败的行走同一套结构，只是标红。 */
      const rowOf = (f, nested = false, failed = Boolean(f.error)) => h('div', {
        key: f.id,
        className: `dshwc-item${nested ? ' dshwc-item-nested' : ''}${failed ? ' dshwc-item-failed' : ''}${selected === f.id ? ' dshwc-item-selected' : ''}`,
        title: f.url,
        onClick: () => (f.cdp ? openCdp(f) : openDetail(f.id)),
      },
        h('span', { className: 'dshwc-method' }, f.method),
        h('span', { className: `dshwc-status${failed ? ' dshwc-status-error' : ''}` }, f.error ? 'ERR' : (f.status || '…')),
        h('span', { className: 'dshwc-item-name' }, `${f.host}${f.path}`),
        h('span', { className: 'dshwc-item-sub' },
          `${fmtTime(f.ts)} · ${fmtBytes(f.respBytes)} · ${f.type || '—'}${f.errorCode ? ` · ${f.errorCode}` : ''}`))

      /**
       * 一个合并后的端点：用最新一次调用代表整组，`×N` 说明一共几次，箭头按时间
       * 顺序列出每一次。状态分布放在副行，把整行宽度留给 URL。
       */
      const groupOf = (g) => {
        const open = Boolean(openGroups[g.key])
        const latest = g.latest
        const statusText = latest.error ? `ERR${latest.errorCode ? ` ${latest.errorCode}` : ''}` : (latest.status || '…')
        return h('div', { key: g.key, className: 'dshwc-group' },
          h('div', {
            className: `dshwc-item dshwc-group-head${g.errors ? ' dshwc-item-failed' : ''}${selected === latest.id ? ' dshwc-item-selected' : ''}`,
            title: `${g.url}\n共 ${g.count} 次，最新 ${fmtTime(latest.ts)}`,
            onClick: () => (latest.cdp ? openCdp(latest) : openDetail(latest.id)),
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

      /** 某一档视图的行：全部、只看失败、只看成功。 */
      const listRows = (kind) => {
        if (showGroups) {
          const picked = kind === 'failed' ? activeGroups.filter((g) => g.errors > 0)
            : kind === 'ok' ? activeGroups.filter((g) => !g.errors)
              : activeGroups
          return picked.map(groupOf)
        }
        const picked = kind === 'failed' ? listSource.filter((f) => f.error)
          : kind === 'ok' ? listSource.filter((f) => !f.error)
            : listSource
        if (!picked.length) {
          return h('div', { className: 'dshwc-empty' },
            kind === 'failed' ? '还没有失败的请求。'
              : kind === 'ok' ? '还没有成功的请求。'
                : (totalShown > 0
                  ? `没有匹配的请求。共 ${totalShown} 条，换一个类型或清空关键词试试。`
                  : '还没有请求。点「开始抓包」，然后在浏览器里正常操作，这里会实时出现。'))
        }
        return picked.map((f) => rowOf(f, false, Boolean(f.error)))
      }

      const failedCount = showGroups ? activeGroups.filter((g) => g.errors > 0).length : listSource.filter((f) => f.error).length
      const okCount = showGroups ? activeGroups.filter((g) => !g.errors).length : listSource.filter((f) => !f.error).length

      /** CDP 补录的请求：同一个详情窗口，只是数据来源没有 proxy flow。 */
      const cdpDetailView = cdpDetail
        ? h('div', { className: 'dshwc-detail' },
          h('div', { className: 'dshwc-detail-head' },
            h('div', { className: 'dshwc-detail-title' }, `${cdpDetail.method} ${cdpDetail.url}`),
            h('div', { className: 'dshwc-note' },
              `状态 ${cdpDetail.status ?? '—'} · ${cdpDetail.resourceType || '—'}${cdpDetail.fromCache ? ' · 缓存/Service Worker' : ''}`),
            h('div', { className: 'dshwc-note' }, 'CDP 模式：这条请求来自标签页观测，展示浏览器侧的头/POST 体/调用链；「代码」页与系统抓包共用同一批生成器。'),
            cdpDetail.documentURL
              ? h('div', { className: 'dshwc-note dshwc-dirtext' }, `页面：${cdpDetail.documentURL}`)
              : null),
          // 两个页签与系统抓包详情对齐：抓到的请求 / 生成的脚本。
          h('div', { className: 'dshwc-detail-tabs' },
            h('button', {
              className: 'dshwc-tab',
              type: 'button',
              'data-active': cdpDetailTab === 'request' ? 'true' : 'false',
              onClick: () => setCdpDetailTab('request'),
            }, '请求'),
            h('button', {
              className: 'dshwc-tab',
              type: 'button',
              'data-active': cdpDetailTab === 'code' ? 'true' : 'false',
              onClick: () => setCdpDetailTab('code'),
            }, '代码')),
          cdpDetailTab === 'request'
            ? h('div', { className: 'dshwc-detail-body' },
              h(Section, { id: 'req', title: '请求头', open: openSections.req, onToggle: toggleSection },
                cdpDetail.requestHeaders
                  ? h('pre', { className: 'dshwc-pre' }, headerText(cdpDetail.requestHeaders))
                  : h('div', { className: 'dshwc-note' }, '（CDP 没有给出请求头）')),
              cdpDetail.postData
                ? h(Section, { id: 'reqBody', title: '请求体', open: openSections.reqBody, onToggle: toggleSection },
                  h('pre', { className: 'dshwc-pre' }, cdpDetail.postData.slice(0, 4000)))
                : null,
              h(Section, { id: 'resp', title: '响应头', open: openSections.resp, onToggle: toggleSection },
                cdpDetail.responseHeaders
                  ? h('pre', { className: 'dshwc-pre' }, headerText(cdpDetail.responseHeaders))
                  : h('div', { className: 'dshwc-note' }, '（CDP 没有给出响应头）')),
              h(Section, { id: 'cdp', title: '调用链', open: openSections.cdp, onToggle: toggleSection },
                h('div', { className: 'dshwc-row' },
                  h('button', {
                    className: 'dshwc-chip',
                    type: 'button',
                    'data-active': onlyBusinessChain ? 'true' : 'false',
                    onClick: () => setOnlyBusinessChain((value) => !value),
                  }, onlyBusinessChain ? '只看业务帧' : '显示完整栈'),
                  cdpDetail.initiator && cdpDetail.initiator.totalFrames
                    ? h('span', { className: 'dshwc-note' }, chainSize(cdpDetail.initiator))
                    : null),
                cdpBusinessNames.length
                  ? h('div', { className: 'dshwc-chainnames' },
                    h('span', { className: 'dshwc-note' }, '业务方法'),
                    cdpBusinessNames.slice(0, 16).map((name) => h('button', {
                      key: name,
                      className: 'dshwc-chainname',
                      type: 'button',
                      title: '打开这个方法附近的源码',
                      onClick: () => {
                        const frame = cdpChainFrames.find((item) => item.functionName === name && item.scriptKey)
                        if (frame) openSource(frame)
                      },
                    }, name)),
                    h('button', {
                      className: 'dshwc-chip',
                      type: 'button',
                      title: '复制全部业务方法名（一行一个）',
                      onClick: () => copyText(cdpBusinessNames.join('\n'), '全部业务方法'),
                    }, '复制全部'))
                  : null,
                cdpChainFrames.length
                  ? h('div', { className: 'dshwc-chainframes' }, chainFrameRows(cdpChainFrames))
                  : h('div', { className: 'dshwc-note' }, '没有可展示的帧；可以切到「显示完整栈」再看。')))
            : codePane({ busy: cdpCodeBusy, view: cdpCode, copied: cdpCopied, onCopy: copyCdpCode }))
        : null


      return h('div', { className: 'dshwc-root', 'data-docked': docked ? 'true' : 'false' },
        // 第 1 块 —— 菜单：抓包状态和所有开关。
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
            h('div', { className: 'dshwc-modes' },
              [['system', '系统抓包'], ['cdp', 'CDP 抓包']].map(([value, label]) => h('button', {
                key: value,
                className: 'dshwc-mode',
                'data-active': mode === value ? 'true' : 'false',
                disabled: busy,
                onClick: () => switchMode(value),
              }, label))),
            mode === 'system'
              ? h('div', null,
                h('div', { className: 'dshwc-note' },
                  '把 Windows 系统代理指向本机 MITM 代理，自动签发每个域名的证书；适合先全局找接口。'),
                h('div', { className: 'dshwc-grid' },
                  h(Cell, { label: '代理', value: running ? `运行中 :${port}` : '未运行' }),
                  h(Cell, { label: 'CA', value: caInstalled ? '已信任' : '未安装' }),
                  h(Cell, { label: '系统代理', value: sysOn ? '已指向本机' : '未开启' }),
                  h(Cell, { label: '已捕获', value: `${total} 条` })),
                h('div', { className: 'dshwc-row' },
                  h('button', {
                    className: 'dshwc-btn dshwc-btn-primary',
                    disabled: busy,
                    onClick: toggleServe,
                  }, running ? '停止抓包' : '开始抓包'),
                  h('button', { className: 'dshwc-btn', disabled: busy, onClick: clearAll }, '清空')))
              : h('div', null,
                h('div', { className: 'dshwc-note' },
                  '接管一个 Chrome 标签页，只记录这个页面的请求；和系统抓包互斥，切换时另一边暂停、数据保留。'),
                h('div', { className: 'dshwc-cdprow' },
                  h('span', { className: 'dshwc-note' },
                    `通道：${bridgeTab ? (cdpPaused ? '已暂停（数据保留）' : '监控中') : cdpArmed ? '已连接（浏览器）' : '未连接'}`),
                  cdpArmed || bridgeTab
                    ? h('button', { className: 'dshwc-btn dshwc-btn-small', disabled: busy, onClick: closeCdp }, '关闭 CDP')
                    : null),
                bridgeTab
                  ? h('div', { className: 'dshwc-note' }, `当前标签页：${bridgeTab.title || bridgeTab.url || bridgeTab.tabId}`)
                  : null,
                isDesktop && bridgeBase
                  ? h('div', { className: 'dshwc-gap' },
                    h('div', { className: 'dshwc-row' },
                      h('span', { className: 'dshwc-note' }, `扩展连接地址：${bridgeBase}`),
                      h('button', {
                        className: 'dshwc-chip', type: 'button', title: '复制这个地址',
                        onClick: () => copyText(bridgeBase, '扩展连接地址'),
                      }, '复制'),
                      h('button', {
                        className: 'dshwc-btn dshwc-btn-small', type: 'button', title: '在 Chrome 里打开一次连接页',
                        onClick: openBridgeHello,
                      }, '在 Chrome 中打开')),
                    h('div', { className: 'dshwc-note' },
                      '打开后点一下 Chrome 工具栏上的 Flowspot 图标——扩展会认下这个地址（之后端口不变就不用再来一次）。'))
                  : (bridgeBase && !bridgeTab
                    ? h('div', { className: 'dshwc-note dshwc-gap' }, `扩展连接地址：${bridgeBase}（一般不用管；扩展没响应时可在 Chrome 里打开 ${bridgeBase}/dsh-flowspot/bridge/hello）`)
                    : null),
                cdp && cdp.sources && cdp.sources.scripts
                  ? h('div', { className: 'dshwc-note dshwc-gap' },
                    `源码已落盘 ${cdp.sources.scripts} 个 / ${(Number(cdp.sources.chars || 0) / 1048576).toFixed(1)}MB`
                    + '（只存业务接口用到的脚本；点「清空 CDP」连磁盘一起清）')
                  : null,
                // 两行两列，和「连接浏览器 / 断开」同一套按钮样式，和上面的说明文本留出间距。
                h('div', { className: 'dshwc-btnrow' },
                  h('button', {
                    className: 'dshwc-btn',
                    disabled: busy,
                    title: '在资源管理器里打开源码目录（自己拷走整份 JS 分析）',
                    onClick: () => revealSource(''),
                  }, '打开源码目录'),
                  h('button', {
                    className: 'dshwc-btn',
                    disabled: busy || cdpFlows.length === 0,
                    onClick: clearCdp,
                  }, '清空 CDP')),
                h('div', { className: 'dshwc-btnrow' },
                  h('button', {
                    className: 'dshwc-btn dshwc-btn-primary',
                    disabled: busy,
                    title: bridgeKnown ? '从浏览器标签页列表里选一个接管' : '点击会尝试唤醒扩展并接管当前页',
                    onClick: cdpArmed || bridgeTab ? openPicker : connectBrowser,
                  }, bridgeTab ? '重新选择标签页' : cdpArmed ? '选择标签页' : '连接浏览器'),
                  h('button', {
                    className: 'dshwc-btn',
                    disabled: busy || !(bridgeTab || cdpArmed),
                    onClick: closeCdp,
                  }, '断开')),
                bridgeTab && cdpPaused
                  ? h('div', { className: 'dshwc-btnrow' },
                    h('button', { className: 'dshwc-btn', disabled: busy, onClick: () => runBridge('resume') }, '恢复 CDP'))
                  : null,
                h('div', { className: 'dshwc-note' },
                  bridgeReady
                    ? cdpPaused
                      ? '当前已暂停：切回 CDP 模式会继续接收，旧列表还在。'
                      : '扩展已连接；这个模式的列表和系统抓包分开，只有详情会多调用链。'
                    : bridgeKnown
                      ? '扩展在休眠：点「连接浏览器」会把它唤醒，最多等十几秒。'
                      : '扩展未检测到：点「连接浏览器」会尝试唤醒；仍失败去设置里加载扩展。'),
                !bridgeTab && cdpFlows.length
                  ? h('div', { className: 'dshwc-note' }, `CDP 已断开：列表里 ${cdpFlows.length} 条是断开前抓到的，只有点「清空 CDP」才会清掉。`)
                  : null),
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
        // 第 2、3 块 —— 请求列表和请求详情，各自带标题栏。
        h('div', { className: 'dshwc-main' },
          h('div', { className: 'dshwc-pane dshwc-pane-left' },
            h('div', { className: 'dshwc-panel-head' },
              h('span', { className: 'dshwc-panel-title' }, showGroups
                ? `请求列表（${mode === 'cdp' ? 'CDP' : '系统'} · 合并 ${activeGroups.length} 组 · 共 ${totalShown} 条）`
                : `请求列表（${mode === 'cdp' ? `CDP ${totalShown}` : `系统 ${totalShown}`} 条）`),
              h('button', {
                className: 'dshwc-btn dshwc-btn-small',
                'data-on': mergeOn ? 'true' : 'false',
                title: mergeOn
                  ? '同「方法 + 完整 URL」的请求合成一行；再点一次恢复平铺'
                  : '把「方法 + 完整 URL」相同的请求合成一行，轮询接口只占一行',
                onClick: () => setMergeOn((value) => !value),
              }, mergeOn ? '合并：开' : '合并')),
            mode === 'system' && localMerge
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
            // 分窗开关只在列表放得下两栏的地方出现。
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
            // 只控宽度：窄栏里两份列表共用一个滚动区，行仍按时间顺序排（失败的标红）。
            docked
              ? h('div', { className: 'dshwc-scroll' }, listRows('all'))
              : h('div', { className: 'dshwc-split' },
                failureView !== 'failures'
                  ? h('div', { className: 'dshwc-oks' },
                    h('div', { className: 'dshwc-minihead' }, `成功 ${okCount} ${showGroups ? '组' : '条'}`),
                    h('div', { className: 'dshwc-scroll' }, listRows('ok')))
                  : null,
                // 失败排在成功下面；空出一条 20% 的空白只会变成噪音，所以只在实际有东西
                // 可显示、或操作者明确要看失败时才出现。
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
                    // 同一条 flow 的两个视图：抓到的请求（跟以前面板显示的完全一样）和
                    // 生成的脚本。切页签不会藏起、也不会重排原来那些详情块。
                    h('div', { className: 'dshwc-detail-tabs' },
                      h('button', {
                        className: 'dshwc-tab',
                        type: 'button',
                        'data-active': detailTab === 'request' ? 'true' : 'false',
                        onClick: () => setDetailTab('request'),
                      }, '请求'),
                      h('button', {
                        className: 'dshwc-tab',
                        type: 'button',
                        'data-active': detailTab === 'code' ? 'true' : 'false',
                        onClick: () => setDetailTab('code'),
                      }, '代码')),
                    detailTab === 'request'
                      ? h('div', { className: 'dshwc-detail-body' },
                        detail.error
                      ? h('div', { className: 'dshwc-errorcard' },
                        h('div', { className: 'dshwc-errorcard-title' }, `请求失败：${detail.error}`),
                        h('div', { className: 'dshwc-errorcard-meta' },
                          [detail.errorCode, detail.errorPhase ? `阶段 ${detail.errorPhase}` : ''].filter(Boolean).join(' · ') || '没有错误码'),
                        detail.errorHint ? h('div', { className: 'dshwc-note' }, detail.errorHint) : null)
                      : null,
                    h(Section, {
                      id: 'cdp',
                      title: '调用链',
                      open: openSections.cdp,
                      onToggle: toggleSection,
                    },
                      !chain
                        ? h('div', { className: 'dshwc-note' }, '读取中…（上一份调用链保留到新结果返回）')
                        : !chain.matched
                          ? h('div', { className: 'dshwc-note' },
                            '没有配到浏览器调用链：这条请求可能不是当前接管的标签页发出的，或浏览器索引已经滚掉。'
                            + '系统抓包的请求头/请求体/响应体仍可正常查看。')
                          : h('div', { className: 'dshwc-chain' },
                            chain.target
                              ? h('div', { className: 'dshwc-note' }, `目标：${chain.target.title || chain.target.url || chain.target.targetId}（${chain.target.type || 'target'}）`)
                              : null,
                            chain.request && chain.request.documentURL
                              ? h('div', { className: 'dshwc-note dshwc-dirtext' }, `页面：${chain.request.documentURL}`)
                              : null,
                            h('div', { className: 'dshwc-row' },
                              h('button', {
                                className: 'dshwc-chip',
                                type: 'button',
                                'data-active': onlyBusinessChain ? 'true' : 'false',
                                onClick: () => setOnlyBusinessChain((value) => !value),
                              }, onlyBusinessChain ? '只看业务帧' : '显示完整栈'),
                              chain.initiator && chain.initiator.totalFrames
                                ? h('span', { className: 'dshwc-note' }, chainSize(chain.initiator))
                                : null),
                            chainBusinessNames.length
                              ? h('div', { className: 'dshwc-chainnames' },
                                h('span', { className: 'dshwc-note' }, '业务方法'),
                                chainBusinessNames.slice(0, 16).map((name) => h('button', {
                                  key: name,
                                  className: 'dshwc-chainname',
                                  type: 'button',
                                  title: '打开这个方法附近的源码',
                                  onClick: () => {
                                    const frame = chainFrames.find((item) => item.functionName === name && item.scriptKey)
                                    if (frame) openSource(frame)
                                  },
                                }, name)),
                                h('button', {
                                  className: 'dshwc-chip',
                                  type: 'button',
                                  title: '复制全部业务方法名（一行一个）',
                                  onClick: () => copyText(chainBusinessNames.join('\n'), '全部业务方法'),
                                }, '复制全部'))
                              : null,
                            chainFrames.length
                              ? h('div', { className: 'dshwc-chainframes' }, chainFrameRows(chainFrames))
                              : h('div', { className: 'dshwc-note' }, '没有可展示的帧；可以切到「显示完整栈」或看 agent 的 webcap_chain 输出。'),
                            chain.params && chain.params.length
                              ? h('div', { className: 'dshwc-chainparams' }, chain.params.slice(0, 20).map((param) => h('div', {
                                key: `${param.where}:${param.name}`,
                                className: 'dshwc-chainparam',
                              },
                                h('span', { className: 'dshwc-chainpname' }, param.name),
                                h('span', { className: 'dshwc-chainpval' }, param.value),
                                h('span', { className: 'dshwc-chip', 'data-active': param.stability === 'dynamic' ? 'true' : 'false' }, param.stability === 'dynamic' ? '动态' : '静态'))))
                              : null)),
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
                      : codePane({ busy: codeBusy, view: codeView, copied, onCopy: copyCode }))
                  : cdpDetail
                    ? cdpDetailView
                    : h('div', { className: 'dshwc-empty' }, '点左侧一条请求，这里显示它的错误原因、请求头、响应头与响应体；「代码」页还能生成 cURL / Python / Go / Rust / JavaScript / Node.js 脚本。'))),
        picker.open
          ? h('div', { className: 'dshwc-modal', onClick: () => setPicker({ open: false, loading: false, tabs: [], error: '' }) },
            h('div', { className: 'dshwc-modal-card dshwc-pickercard', onClick: (event) => event.stopPropagation() },
              h('div', { className: 'dshwc-modal-head' },
                h('span', { className: 'dshwc-panel-title' }, '选择要接管的标签页'),
                h('div', { className: 'dshwc-row' },
                  h('button', { className: 'dshwc-btn dshwc-btn-small', disabled: picker.loading, onClick: openPicker }, '刷新'),
                  h('button', {
                    className: 'dshwc-iconbtn',
                    title: '关闭',
                    onClick: () => setPicker({ open: false, loading: false, tabs: [], error: '' }),
                  }, '✕'))),
              h('div', { className: 'dshwc-modal-body' },
                picker.loading
                  ? h('div', { className: 'dshwc-note' }, '读取浏览器标签页…')
                  : picker.error
                    ? h('div', { className: 'dshwc-msg dshwc-msg-error' }, picker.error)
                    : picker.tabs.length
                      ? h('div', { className: 'dshwc-tablist' }, picker.tabs.map((tab) => h('button', {
                        key: tab.id,
                        className: 'dshwc-tabrow',
                        type: 'button',
                        disabled: busy,
                        title: tab.url,
                        onClick: () => takeover(tab.id),
                      },
                        h('span', { className: 'dshwc-tabrow-title' }, `${tab.active ? '● ' : ''}${tab.title || '(无标题)'}`),
                        h('span', { className: 'dshwc-tabrow-url' }, tab.url),
                        h('span', { className: 'dshwc-tabrow-go' }, bridgeTab && bridgeTab.tabId === tab.id ? '已接管' : '接管'))))
                      : h('div', { className: 'dshwc-note' }, '没有可接管的网页标签页。先打开目标页面再刷新。'))))
          : null,
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
                // 菜单的内容被遮罩挡在后面，所以在弹窗里、用户正看着的地方再放一遍
                // 上一次操作的结果。
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
                    }, '恢复默认'))),
                h('div', { className: 'dshwc-setting' },
                  h('div', { className: 'dshwc-setting-head' }, '浏览器扩展（接管当前页）'),
                  h('div', { className: 'dshwc-note' },
                    '接管当前浏览器要靠配套扩展（Chrome ≥136 不允许对默认 profile 开调试端口）。装一次即可；之后在「标签页 CDP」里选择页面，或在目标页点扩展图标。'),
                  h('div', { className: 'dshwc-note' },
                    `扩展：${bridgeReady ? '已连接' : bridgeKnown ? '休眠（点击会唤醒）' : '未检测到'}${bridgeTab ? ` · 已接管 ${bridgeTab.title || bridgeTab.url || bridgeTab.tabId}` : ''}`),
                  h('div', { className: 'dshwc-row' },
                    h('a', {
                      className: 'dshwc-btn',
                      href: '/dsh-flowspot/extension/zip',
                      download: 'dsh-flowspot-bridge.zip',
                      style: { textDecoration: 'none' },
                    }, '下载扩展 zip'),
                    h('button', {
                      className: 'dshwc-btn',
                      disabled: busy,
                      onClick: () => act(() => post('/dsh-flowspot/extension/open'), '已打开扩展目录'),
                    }, '打开扩展目录')),
                  h('div', { className: 'dshwc-note' },
                    '安装：1）解压或打开目录；2）chrome://extensions 打开开发者模式；3）「加载已解压的扩展程序」选 extension 目录；4）刷新 DSH 页面。'),
                  h('div', { className: 'dshwc-row' },
                    h('button', { className: 'dshwc-btn', disabled: busy, onClick: openPicker }, bridgeTab ? '重新选择标签页' : '选择标签页'),
                    bridgeTab
                      ? h('button', { className: 'dshwc-btn', disabled: busy, onClick: closeCdp }, '断开接管')
                      : h('button', { className: 'dshwc-btn', disabled: busy, onClick: attachBridge }, '接管最近页'))),
                h('div', { className: 'dshwc-setting' },
                  h('div', { className: 'dshwc-setting-head' }, '运行日志'),
                  h('div', { className: 'dshwc-note dshwc-dirtext' }, `目录：${paths ? paths.log : '—'}`),
                  h('div', { className: 'dshwc-note' },
                    '只记非请求事件（端口、系统代理、CA、数据目录、CDP 连接）。日志给 agent 的 webcap_logs 读；面板只提供打开目录。'),
                  h('div', { className: 'dshwc-row' },
                    h('button', { className: 'dshwc-btn', onClick: openLogsDir }, '打开日志文件夹'))),
                codeSettings)))
          : null,
        // 点调用链里的一帧后弹的源码查看器；和「设置」共用同一套遮罩样式。
        sourceView
          ? h('div', { className: 'dshwc-modal', onClick: () => setSourceView(null) },
              h('div', { className: 'dshwc-modal-card dshwc-sourcecard', onClick: (event) => event.stopPropagation() },
                h('div', { className: 'dshwc-modal-head' },
                  h('span', { className: 'dshwc-panel-title', title: sourceView.url || '' }, sourceView.title || '源码'),
                  h('div', { className: 'dshwc-row' },
                    h('button', {
                      className: 'dshwc-chip', type: 'button', title: '复制这个方法名，粘到 F12 里搜',
                      onClick: () => copyText(sourceView.name, sourceView.name),
                    }, '复制方法名'),
                    h('button', {
                      className: 'dshwc-chip', type: 'button', title: '复制 文件:行:列',
                      onClick: () => copyText(`${sourceView.url}:${sourceView.line}:${sourceView.column}`, '位置'),
                    }, '复制位置'),
                    h('button', {
                      className: 'dshwc-chip', type: 'button', title: '在资源管理器里选中这个 .js，自己拷走分析',
                      onClick: () => revealSource(sourceView.scriptKey),
                    }, '打开文件夹'),
                    h('button', { className: 'dshwc-iconbtn', title: '关闭', onClick: () => setSourceView(null) }, '✕'))),
                h('div', { className: 'dshwc-modal-body' },
                  sourceView.loading
                    ? h('div', { className: 'dshwc-note' }, '读取中…')
                    : sourceView.error
                      ? h('div', { className: 'dshwc-msg dshwc-msg-error' }, sourceView.error)
                      : h('div', { className: 'dshwc-sourceview' },
                        h('div', { className: 'dshwc-row dshwc-sourcebar' },
                          h('span', { className: 'dshwc-note' },
                            `${sourceView.mode === 'column'
                              ? `第 ${sourceView.line} 行第 ${sourceView.column} 列（已展开）`
                              : `第 ${sourceView.line || '?'} 行附近`}`
                            + ` · 脚本共 ${sourceView.totalChars || 0} 字符 / ${sourceView.totalLines || 0} 行`
                            + (sourceView.truncated ? ' · 片段已截断' : '')
                            + (sourceView.hits && sourceView.hits.needle
                              ? ` · 同名 ${sourceView.hits.total} 处${sourceView.hits.index >= 0 ? `（第 ${sourceView.hits.index + 1} 处）` : '（当前是调用点）'}`
                              : '')),
                          sourceView.hits && sourceView.hits.total > 1
                            ? [
                              h('button', {
                                key: 'prev', className: 'dshwc-chip', type: 'button', title: '上一个同名位置',
                                onClick: () => {
                                  const hits = sourceView.hits
                                  const total = hits.total
                                  const next = hits.index < 0 ? hits.prev : (hits.index - 1 + total) % total
                                  loadSource(sourceView, { hitIndex: next })
                                },
                              }, '上一处'),
                              h('button', {
                                key: 'next', className: 'dshwc-chip', type: 'button', title: '下一个同名位置',
                                onClick: () => {
                                  const hits = sourceView.hits
                                  const total = hits.total
                                  const next = hits.index < 0 ? hits.next : (hits.index + 1) % total
                                  loadSource(sourceView, { hitIndex: next })
                                },
                              }, '下一处'),
                            ]
                            : null,
                          sourceView.hits && sourceView.hits.index >= 0
                            ? h('button', {
                              className: 'dshwc-chip', type: 'button', title: '回到这一帧自己的调用点',
                              onClick: () => loadSource(sourceView, { hitIndex: -1 }),
                            }, '回到调用点')
                            : null,
                          h('button', {
                            className: 'dshwc-chip', type: 'button', title: '复制当前显示的源码',
                            onClick: () => copyText(
                              sourceView.lines
                                ? sourceView.lines.map((line) => `${'  '.repeat(line.indent)}${line.text}`).join('\n')
                                : sourceView.text,
                              '这段源码',
                            ),
                          }, '复制这段')),
                        sourceView.lines
                          ? h('pre', { className: 'dshwc-pre dshwc-sourcecode' }, sourceView.lines.map((line, index) => {
                            const marked = sourceView.mark && sourceView.mark.line === index ? sourceView.mark : null
                            return h('div', { key: index, className: 'dshwc-srcline', style: { paddingLeft: `${line.indent * 14}px` } },
                              marked ? [
                                h('span', { key: 'a' }, line.text.slice(0, marked.start)),
                                h('mark', { key: 'm', className: 'dshwc-sourcehit' }, line.text.slice(marked.start, marked.end)),
                                h('span', { key: 'b' }, line.text.slice(marked.end)),
                              ] : line.text)
                          }))
                          : h('pre', { className: 'dshwc-pre dshwc-sourcecode' }, sourceView.text || '（空）')))))
          : null,
        // 面板样式：颜色一律取宿主主题 token（--dsw-alias-*），不写死任何色值，
        // 这样换浅色/深色主题都不用动这里。
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
.dshwc-sourcecard { width:min(1100px, 96vw); max-height:88vh; overflow:hidden; }
.dshwc-sourcecard .dshwc-modal-body { flex:1; min-height:0; gap:8px; }
.dshwc-sourceview { display:flex; flex-direction:column; gap:6px; min-height:0; }
.dshwc-sourcebar { flex-wrap:wrap; gap:6px; }
.dshwc-sourcecode { flex:1; min-height:0; max-height:64vh; overflow:auto; cursor:text; user-select:text; }
.dshwc-srcline { min-height:1.35em; white-space:pre-wrap; word-break:break-all; }
.dshwc-sourcehit { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); color:var(--dsw-alias-label-primary); border-radius:3px; }
.dshwc-chainrow { display:flex; align-items:stretch; gap:2px; }
.dshwc-chainrow .dshwc-chainframe { flex:1 1 auto; min-width:0; }
.dshwc-chaincopy { flex:0 0 auto; align-self:stretch; }
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
.dshwc-detail-tabs { display:flex; gap:4px; padding-bottom:4px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.dshwc-tab { border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-tertiary); border-radius:6px; padding:2px 10px; font-size:11px; cursor:pointer; font-family:inherit; }
.dshwc-tab[data-active="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); }
.dshwc-detail-body { display:flex; flex-direction:column; gap:8px; }
.dshwc-codepane { display:flex; flex-direction:column; gap:8px; }
.dshwc-codewrap { display:flex; flex-direction:column; gap:6px; }
.dshwc-codeactions { justify-content:space-between; }
.dshwc-code { max-height:none; }
.dshwc-notes { display:flex; flex-direction:column; gap:2px; }
.dshwc-langlist { display:flex; flex-direction:column; gap:4px; }
.dshwc-langrow { display:flex; align-items:center; gap:6px; }
.dshwc-langname { flex:1; display:flex; align-items:center; gap:6px; font-size:12px; }
.dshwc-cdprow { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dshwc-gap { margin-top:6px; }
.dshwc-btnrow { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px; margin:8px 0; }
.dshwc-btnrow .dshwc-btn { width:100%; }
.dshwc-divider { height:1px; background:var(--dsw-alias-border-l2); margin:6px 0; }
.dshwc-modes { display:flex; gap:4px; }
.dshwc-mode { flex:1; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-tertiary); border-radius:6px; padding:5px 8px; font-size:11px; font-family:inherit; cursor:pointer; }
.dshwc-mode[data-active="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); }
.dshwc-pickercard { width:min(640px, 92vw); }
.dshwc-tablist { display:flex; flex-direction:column; gap:4px; max-height:50vh; overflow:auto; }
.dshwc-tabrow { display:flex; flex-direction:column; align-items:flex-start; gap:2px; width:100%; text-align:left; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:6px; padding:6px 8px; cursor:pointer; font-family:inherit; }
.dshwc-tabrow:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dshwc-tabrow-title { font-size:12px; font-weight:600; }
.dshwc-tabrow-url { font-size:11px; color:var(--dsw-alias-label-tertiary); word-break:break-all; }
.dshwc-tabrow-go { align-self:flex-end; font-size:11px; color:var(--dsw-alias-brand-primary); }
.dshwc-chain { display:flex; flex-direction:column; gap:6px; }
.dshwc-chainframes { display:flex; flex-direction:column; gap:2px; }
.dshwc-chainnames { display:flex; flex-wrap:wrap; align-items:center; gap:4px; }
.dshwc-chainname { border:1px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-brand-primary); border-radius:10px; padding:1px 7px; font-size:11px; font-family:inherit; cursor:pointer; }
.dshwc-chainfn { font-weight:600; font-size:11px; }
.dshwc-chainloc { font-size:10px; color:var(--dsw-alias-label-tertiary); }
.dshwc-chainframe { display:flex; flex-direction:column; align-items:flex-start; gap:1px; text-align:left; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:4px; padding:3px 6px; font-size:11px; cursor:pointer; font-family:inherit; overflow:hidden; }
.dshwc-chainframe:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dshwc-chainframe-noise { opacity:.55; }
.dshwc-chainsep { margin:2px 0; padding:1px 0 1px 6px; border-left:2px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-tertiary); font-size:10px; }
.dshwc-chainparams { display:flex; flex-direction:column; gap:2px; }
.dshwc-chainparam { display:flex; gap:6px; align-items:center; font-size:11px; }
.dshwc-chainpname { color:var(--dsw-alias-label-tertiary); }
.dshwc-chainpval { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:55%; }
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

    // 顶层 inject 只放 `slots`。`sidebarRightTabs` / `sidebarRight` 是宿主服务：
    // 把它们写进这里（或者不声不响直接读 `ctx.sidebarRightTabs`）会抛
    // `cannot get property without inject`，web 一启动整个 GUI 就挂掉。右栏页签类型
    // 改用嵌套的 `ctx.inject` 注册，右栏的打开动作则走 `ctx.get`。
    const inject = ['slots']
    const name = 'dsh-flowspot'
    /** 列表 id，同时也是 `main` 的 key：侧栏那一行和它的整页靠这个对上。 */
    const PANEL_ID = 'dsh-flowspot'
    /** 右侧栏的页签类型；`sidebarRight.openTab` 打开的就是这个 kind。 */
    const TAB_KIND = 'flowspot'
    /** 留一份 client context，按钮才能把同一个面板开进右侧栏。 */
    let clientContext = null

    /**
     * 侧栏那一行的图标。按钮、文字、tooltip 和轨道几何都由宿主负责，这个组件只按
     * 传进来的尺寸画图形；`data-dsh-panel-entry` 是给那些按行映射插件的皮肤契约
     * 认的标记。
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

    /** 中栏那个整页。只有这个面板被选中时宿主才挂它。 */
    function PanelPage() {
      return h('div', { className: 'dshwc-page', 'data-dsh-plugin': PANEL_ID }, h(Panel, { docked: false }))
    }

    /**
     * 同一个面板，按右侧栏的窄宽度重新排版。
     *
     * 一条摆放规则让停靠真的像一列侧栏，而不是第二个整页：如果中栏还在显示本插件
     * 的整页，就先把它交还给 Conversation。否则停靠面板会紧挨着它自己的另一份副本，
     * 看起来就成了「请求列表占满整个窗口」。
     *
     * 宿主自带的全屏开关故意不从这里驱动：视口小于 768px 时面板也是全屏，这时去翻
     * 手动模式，会强行变成操作者眼前相反的状态。这个选择只归宿主那个 ⛶ 按钮管。
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
          /* 交还失败就留在整页 */
        }
      }, [])
      return h('div', { className: 'dshwc-rightpane', 'data-dsh-plugin': PANEL_ID }, h(Panel, { docked: true }))
    }

    function apply(ctx) {
      clientContext = ctx
      // 一共注册四处：侧栏入口、它在中栏的整页、右栏页签类型、右栏页签内容。
      // 注册都挂在 effect 生命周期里，跟宿主侧插件一样：卸载 client 条目就把几个
      // 座位一起释放。
      ctx.effect(() => {
        const disposers = []
        // 两个座位共用一个 id：侧栏那一行选中的就是同 key 的 `main` 条目。
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
              /* 早就释放过了 */
            }
          }
        }
      }, 'dsh-flowspot: sidebar panel')

      // 一个页签类型加它的内容，面板才能停靠进右侧栏。`guide` 那一条就是让
      // 「抓包工具」出现在「+」页的工作区文件 / 新建终端旁边，点它打开的就是这个
      // kind。
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
