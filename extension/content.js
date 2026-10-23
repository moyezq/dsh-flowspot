/**
 * Flowspot Bridge 内容脚本：只在 DSH 面板页上工作。
 *
 * manifest 会匹配所有 127.0.0.1/localhost 页面（目标本身也可能是本地开发站），
 * 所以先探测 `/dsh-flowspot/status` 确认这是 DSH 宿主，再上报 origin 并替宿主
 * 长轮询命令。内容脚本活在页面里，不受 MV3 service worker 休眠影响：面板点
 * 「连接浏览器/选择标签页」时一定能唤醒 background。
 */

if (!window.__flowspotBridgeLoaded) {
  window.__flowspotBridgeLoaded = true

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function isDshHost() {
    try {
      const response = await fetch('/dsh-flowspot/status')
      if (!response.ok) return false
      const body = await response.json()
      return Boolean(body && body.ok)
    } catch {
      return false
    }
  }

  async function hello() {
    await chrome.runtime
      .sendMessage({ kind: 'hello', origin: location.origin })
      .catch(() => {})
  }

  async function relayCommands() {
    for (;;) {
      try {
        const response = await fetch('/dsh-flowspot/bridge/poll?wait=15000')
        if (!response.ok) throw new Error(`poll ${response.status}`)
        const body = await response.json()
        if (body && body.command) {
          await chrome.runtime
            .sendMessage({ kind: 'bridge-command', command: body.command })
            .catch(() => {})
        }
      } catch {
        await sleep(1000)
      }
    }
  }

  async function boot() {
    for (;;) {
      if (await isDshHost()) {
        hello()
        setInterval(hello, 10000)
        relayCommands()
        return
      }
      await sleep(2000)
    }
  }

  boot()
}
