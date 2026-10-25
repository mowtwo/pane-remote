#!/usr/bin/env node
// 冒烟测试：改了前端 / 服务端、部署之前跑，不过就别部署。
// 在本机起一个测试用的服务端（local 模式、临时配置和数据目录、TEST_LOGIN、假 Host 的 pane-host），用 headless Chrome 打开手机页面，逐项检查：
//   外壳能启动、页面没有未捕获的异常、没有客户端问题报告；顶号（两个标签页互顶）；WebSocket / EventSource 的包装还是原生对象
//   （noVNC 按原型查属性）；终端页、插件页（运行时载入）、待办能记一条和「会话任务」一栏
// 看屏幕、Cursor 是可选模块，测试配置里不开（会连真的屏幕共享 / Cursor），对应检查跳过。不往真实的 pane 里发任何东西。
//   node scripts/smoke.mjs            （需要先 cd web && npm run build；Chrome 默认在 /Applications，CHROME=… 可改）
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SMOKE_PORT || 18799)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-smoke-'))
const HOSTDIR = fs.mkdtempSync('/tmp/prs-') // unix socket 路径不能太长
let failed = 0
const results = []
const ok = (cond, name, extra = '') => { results.push([!!cond, name]); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra && !cond ? `：${extra}` : ''}`); if (!cond) failed++ }


// ---------- 测试用服务端（local 模式：bridge 和 pane-host 都在本机，pane-host 用假的 Host） ----------
const CONF_DIR = path.join(TMP, 'config')
fs.mkdirSync(CONF_DIR, { recursive: true })
fs.writeFileSync(path.join(CONF_DIR, 'config.json'), JSON.stringify({
  mode: 'local', port: PORT, allowedLogins: ['smoke@test'], serveHosts: ['127.0.0.1'], dataDir: path.join(TMP, 'data'),
  modules: { preview: false, openUrl: false, cursor: false, screen: false, mac: false, plugins: true },
}))
fs.writeFileSync(path.join(CONF_DIR, 'bridge.env'), `NODE=${process.execPath}\n`)
const relayLog = path.join(TMP, 'server.log')
const relay = spawn(process.execPath, [path.join(ROOT, 'server/server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PANE_REMOTE_CONFIG: path.join(CONF_DIR, 'config.json'), TEST_LOGIN: 'smoke@test', ALLOW_HOST_ACCESS: '1', PANE_HOST_DIR: HOSTDIR, PANE_HOST_IMPL: path.join(ROOT, 'host/test/fake-host.mjs'), PANE_REMOTE_STATE: path.join(TMP, 'state'), PANE_HOST_IDLE_EXIT_MS: '60000' },
  stdio: ['ignore', fs.openSync(relayLog, 'w'), fs.openSync(relayLog, 'a')],
})
let chrome = null
async function cleanup() {
  try { chrome?.kill() } catch {} // ignore: 已经退了
  try { relay.kill() } catch {} // ignore: 已经退了
  // 测试里拉起的 pane-host：按 socket 问出 PID，确认是 host/main.mjs 再结束（不碰你自己在跑的 pane-host）
  try {
    const pid = Number(execFileSync('/usr/sbin/lsof', ['-t', path.join(HOSTDIR, 'host.sock')]).toString().trim().split('\n')[0])
    if (pid && execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)]).toString().includes('host/main.mjs')) process.kill(pid, 'SIGTERM')
  } catch {} // ignore: pane-host 已经退了
  await sleep(200)
  fs.rmSync(HOSTDIR, { recursive: true, force: true })
  if (!failed) fs.rmSync(TMP, { recursive: true, force: true })
}

try {
  for (let i = 0; i < 50; i++) { await sleep(200); try { if ((await fetch(`${BASE}/api/version`)).ok) break } catch {} }
  ok((await fetch(`${BASE}/api/version`).then((r) => r.json()).catch(() => ({}))).version, '服务端能启动')
  ok((await fetch(`${BASE}/api/preview/file?id=x`).then((r) => r.status).catch(() => 0)) === 400, '预览下载接口在（坏 id 回 400）')

  // ---------- Chrome ----------
  const profile = path.join(TMP, 'chrome')
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=430,900', 'about:blank'], { stdio: 'ignore' })
  let port
  for (let i = 0; i < 50 && !port; i++) { await sleep(200); try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch {} }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pend = new Map()
  const exceptions = [] // 所有页面（含插件 iframe）里未捕获的异常
  const sockets = [] // 页面开的 WebSocket
  const requests = [] // 页面发的请求
  const sends = [] // 发进 pane 的内容（/api/send 的请求体）
  const herdrPanes = [
    ['wA:pB', 'wA:t1', 'wA', 'project-alpha', '迭代进度与 PR 跟进', 'Leader'],
    ['wA:pC', 'wA:t2', 'wA', 'project-alpha', 'shell', '2'],
    ['wB:p1', 'wB:t1', 'wB', 'task-409', 'TASK-409 优化会话列表与操作体验', '1'],
    ['wB:p2', 'wB:t1', 'wB', 'task-409', 'shell', '1'],
    ['wC:p1', 'wC:t1', 'wC', 'task-495', 'shell', '1'],
    ['wC:p2', 'wC:t1', 'wC', 'task-495', 'shell', '1'],
  ].map(([pane, tab, window, workspace, title, tabTitle]) => ({ pane, tab, window, workspace, title, tabTitle,
    terminalAgent: pane === 'wA:pB' ? { kind: 'codex', name: 'leader' } : pane === 'wB:p1' ? { kind: 'claude', name: 'reviewer' } : null,
    backend: 'herdr', capabilities: { width: false }, cwd: '~/.herdr/worktrees/project-alpha/feature-session-list',
    dir: '/tmp', cols: 120, rows: 40, active: pane === 'wA:pB' }))
  let herdrFixture = false
  let dropChunks = false // 断网那一段：页面分块的请求一律失败
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] || m.params.exceptionDetails.text)
    else if (m.method === 'Network.webSocketCreated') sockets.push(m.params.url)
    else if (m.method === 'Network.requestWillBeSent') { requests.push(m.params.request.url); if (m.params.request.url.includes('/api/send')) sends.push(m.params.request.postData || '') }
    else if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') {
      const s = m.params.sessionId
      cdp('Runtime.enable', {}, s).catch(() => {})
      cdp('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {})
    }
    else if (m.method === 'Fetch.requestPaused' && m.params.request.url.includes('/assets/')) {
      if (dropChunks) cdp('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'InternetDisconnected' }, m.sessionId).catch(() => {})
      else cdp('Fetch.continueRequest', { requestId: m.params.requestId }, m.sessionId).catch(() => {})
    }
    else if (m.method === 'Fetch.requestPaused') {
      // 电脑版那一段：测试中转连不上 Mac（没有 bridge），pane 列表和发送由这里假装回答
      const u = m.params.request.url
      const body = u.includes('/api/panes') ? JSON.stringify(herdrFixture ? herdrPanes : [{ pane: 1, tab: 1, window: 1, workspace: 'default', title: 'zsh', tabTitle: '', cwd: '~', dir: '/tmp', cols: 80, rows: 24, active: true }]) : '{"ok":true}'
      cdp('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(body).toString('base64') }, m.sessionId).catch(() => {})
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
  const cdp = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })) }).then((m) => { if (m.error) throw new Error(`${method}: ${m.error.message}`); return m.result })
  async function openTab(hash = '') {
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
    await cdp('Runtime.enable', {}, sessionId)
    await cdp('Network.enable', {}, sessionId)
    await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId)
    await cdp('Page.navigate', { url: `${BASE}/${hash}` }, sessionId)
    return sessionId
  }
  const ev = async (s, expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value
  const goto = async (s, hash) => { await ev(s, `location.hash = ${JSON.stringify(hash)}`); await sleep(2500); if (process.env.SMOKE_DEBUG) console.log('DBG after', hash, 'kicked=', await ev(s, `!!document.querySelector('[role=alertdialog]')`)) }
  const clientProblems = () => fs.readFileSync(relayLog, 'utf8').split('\n').filter((l) => /\[client\]/.test(l) && /"kind":"(error|rejection|ui-fail)"/.test(l))

  // 1. 外壳
  const A = await openTab()
  await sleep(4000)
  ok(await ev(A, `!!document.querySelector('#app, body > div') && document.body.innerText.length > 0`), '外壳能渲染')
  ok(await ev(A, `!document.querySelector('[role=alertdialog]')`), '打开后在用（没有被当成被顶 / 本机）')

  // 2. WebSocket / EventSource 包装：还是原生对象，带客户端编号
  const w = await ev(A, `(() => {
    const need = ['binaryType', 'protocol', 'readyState', 'close', 'send', 'onerror', 'onmessage', 'onopen', 'onclose']
    const s = new WebSocket(new URL('api/smoke-ws', location.href).href.replace(/^http/, 'ws'))
    const props = [...Object.keys(s), ...Object.getOwnPropertyNames(Object.getPrototypeOf(s))]
    const r = { missing: need.filter((p) => !props.includes(p)), inst: s instanceof WebSocket && WebSocket.OPEN === 1, pc: s.url.includes('_pc=') }
    s.close()
    const es = new EventSource('api/smoke-es'); r.es = es instanceof EventSource && EventSource.CLOSED === 2 && es.url.includes('_pc='); es.close()
    return r })()`)
  ok(!w.missing.length, 'WebSocket 包装过得了 noVNC 的原型检查', w.missing.join(','))
  ok(w.inst && w.es, 'instanceof 和常量照旧')
  ok(w.pc, 'WebSocket / EventSource 带客户端编号')

  // 3. 各个页面
  await goto(A, '#/s/p999999') // 不存在的 pane：只看页面能不能起来，不读真实终端
  ok(await ev(A, `document.body.innerText.length > 0`), '终端页能打开')
  console.log('SKIP 看屏幕、Cursor（可选模块，测试配置里没开）')
  await goto(A, '#/plugin/hello')
  await sleep(1500)
  const { targetInfos } = await cdp('Target.getTargets')
  const hello = targetInfos.find((t) => t.url.includes('/plugins/hello/'))
  ok(!!hello, '插件页（iframe）打开了')
  if (hello) {
    const { sessionId: H } = await cdp('Target.attachToTarget', { targetId: hello.targetId, flatten: true })
    ok(await ev(H, `typeof utools === 'object' && typeof whatevertools === 'object' && typeof utools.dbStorage.getItem === 'function'`), '插件运行时载入了（utools / whatevertools）')
  }
  await goto(A, '#/plugin/todo')
  await sleep(1500)
  const todo = (await cdp('Target.getTargets')).targetInfos.find((t) => t.url.includes('/plugins/todo/'))
  if (todo) {
    const { sessionId: D } = await cdp('Target.attachToTarget', { targetId: todo.targetId, flatten: true })
    await ev(D, `(() => { const i = document.getElementById('addInput'); i.value = '冒烟测试'; i.dispatchEvent(new Event('input')); document.getElementById('addForm').requestSubmit() })()`)
    await sleep(500)
    ok(/冒烟测试/.test(await ev(D, `document.getElementById('list').innerText`)), '待办能记一条')
    await ev(D, `[...document.querySelectorAll('#status button')].find((b) => b.dataset.v === 'cc').click()`)
    await sleep(800)
    ok(await ev(D, `document.getElementById('addForm').hidden && !!document.getElementById('list').firstChild`), '待办的「会话任务」一栏能打开')
    await ev(D, `[...document.querySelectorAll('#status button')].find((b) => b.dataset.v === 'active').click()`)
  } else ok(false, '待办插件打开了')

  // 4. 顶号：第二个标签页打开，第一个显示被顶；第一个点继续顶回来
  const B = await openTab()
  await sleep(4000)
  let kicked = false
  for (let i = 0; i < 20 && !kicked; i++) { kicked = await ev(A, `!!document.querySelector('[role=alertdialog] button')`); if (!kicked) await sleep(250) }
  ok(kicked, '顶号：后打开的把先打开的顶掉')
  await ev(A, `document.querySelector('[role=alertdialog] button')?.click()`)
  await sleep(4000)
  ok(await ev(A, `!document.querySelector('[role=alertdialog]')`) && await ev(B, `!!document.querySelector('[role=alertdialog] button')`), '顶号：点继续可以顶回来')

  // 5. 电脑版（宽屏 + 鼠标）：会话列表常驻左边，终端直接用键盘打字，多行粘贴包成括号粘贴，没有快捷键栏
  // 新开一个标签页，一打开就是电脑尺寸（实际用法：笔记本上直接打开）。放到前台：后台标签页不跑渲染步骤
  const C = await openTab('#/s/p1')
  await cdp('Page.bringToFront', {}, C)
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/panes*' }, { urlPattern: '*/api/send*' }] }, C)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, C)
  // 测终端打字：这个 pane 打开原始画面（有 agent 会话的 pane 默认是对话视图）
  await ev(C, `localStorage.setItem('termViews', JSON.stringify({ 1: 'term' }))`)
  await ev(C, 'location.reload()')
  await sleep(5000)
  ok(await ev(C, `matchMedia('(min-width: 1024px) and (pointer: fine)').matches && !!document.querySelector('[data-testid=session-sidebar] [data-pane-id="1"]')`), '电脑版：会话列表常驻左边', await ev(C, `document.querySelector('[data-testid=session-sidebar]')?.innerText.slice(0, 200) ?? 'no sidebar'`))
  if (process.env.SMOKE_SHOT) fs.writeFileSync(process.env.SMOKE_SHOT, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' }, C)).data, 'base64'))
  const ta = `document.querySelector('.xterm-helper-textarea')`
  await ev(C, `${ta}?.focus()`)
  const sent0 = sends.length
  await cdp('Input.insertText', { text: 'echo smoke' }, C)
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, C)
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, C)
  await sleep(1500)
  const typed = sends.slice(sent0).map((b) => { try { return JSON.parse(b).data } catch { return '' } }).join('')
  ok(typed.includes('echo smoke') && typed.includes('\r'), '电脑版：终端里直接打字发进 pane', JSON.stringify(typed))
  const sent1 = sends.length
  await ev(C, `(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'line1\\nline2'); ${ta}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) })()`)
  await sleep(1500)
  const pasted = sends.slice(sent1).map((b) => { try { return JSON.parse(b).data } catch { return '' } }).join('')
  ok(pasted === '\x1b[200~line1\nline2\x1b[201~', '电脑版：多行粘贴包成括号粘贴', JSON.stringify(pasted))
  ok(await ev(C, `!document.querySelector('[data-testid=keybar]')`), '电脑版：不显示快捷键栏')
  // 窗口拉窄（笔记本开了缩放、PWA 小窗口）：侧栏收起，但还是电脑，键盘照样直接打字（按设备认，不按宽度）
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 2, mobile: false }, C)
  await sleep(1500)
  await ev(C, `${ta}?.focus()`)
  const sent2 = sends.length
  await cdp('Input.insertText', { text: 'narrow' }, C)
  await sleep(1200)
  const narrow = sends.slice(sent2).map((b) => { try { return JSON.parse(b).data } catch { return '' } }).join('')
  ok(!(await ev(C, `!!document.querySelector('[data-testid=session-sidebar]')`)) && narrow.includes('narrow'), '窗口拉窄：侧栏收起，键盘照样打字', JSON.stringify(narrow))
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, C)
  await sleep(1000)

  // Herdr identifiers remain intact through hash routing, pane selection and input.
  herdrFixture = true
  await ev(C, `localStorage.setItem('termViews', JSON.stringify({ 'wA:pB': 'term' })); location.hash = '#/s/pwA:pB'`)
  await ev(C, 'location.reload()')
  await sleep(4000)
  ok(await ev(C, `location.hash === '#/s/pwA:pB' && !!document.querySelector('.xterm') && !!document.querySelector('[data-testid=session-sidebar] [data-pane-id="wA:pB"]')`), 'Herdr：含字母的 pane ID 能路由到终端')
  await ev(C, `${ta}?.focus()`)
  const sentHerdr = sends.length
  await cdp('Input.insertText', { text: 'herdr-input' }, C)
  await sleep(1000)
  const herdrSends = sends.slice(sentHerdr).map((b) => { try { return JSON.parse(b) } catch { return {} } })
  ok(herdrSends.some((b) => b.pane === 'wA:pB' && b.data.includes('herdr-input')), 'Herdr：键盘输入保留原始 pane ID', JSON.stringify(herdrSends))

  const cleanList = await ev(C, `document.querySelector('[data-testid=session-sidebar] [data-testid=session-list]')?.innerText || ''`)
  ok(cleanList.includes('project-alpha') && cleanList.includes('shell · 1') && cleanList.includes('shell · 2') && !/w[A-Z]:[pt]|120×40/.test(cleanList), '会话列表：名称分组、同名序号，隐藏内部 ID 与尺寸', cleanList)
  ok(await ev(C, `document.querySelector('[data-workspace-id="wA"] [data-pane-id="wA:pB"] [data-testid=agent-identity]')?.innerText.includes('Codex') && document.querySelector('[data-workspace-id="wB"] [data-pane-id="wB:p1"] [data-testid=agent-identity]')?.innerText.includes('reviewer')`), 'Herdr：工作区内显示正确的 agent 类型与名称')
  await ev(C, `document.querySelector('[data-workspace-id="wC"] button[aria-expanded]')?.click()`)
  ok(await ev(C, `!document.querySelector('[data-workspace-id="wC"] [data-pane-id]') && !!document.querySelector('[data-workspace-id="wA"] [data-pane-id]')`), '工作区折叠只收起本组会话')
  await ev(C, `document.querySelector('[data-workspace-id="wC"] button[aria-expanded]')?.click()`)
  if (process.env.SMOKE_HERDR_SHOT) fs.writeFileSync(process.env.SMOKE_HERDR_SHOT + '-desktop.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' }, C)).data, 'base64'))
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, C)
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true }, C)
  await ev(C, `location.hash = '#/s/pwA:pB?sheet=sessions'`)
  await sleep(1500)
  ok(await ev(C, `!!document.querySelector('[role=dialog] [data-pane-id="wA:pB"]') && document.documentElement.scrollWidth <= innerWidth`), '手机会话抽屉：显示会话且无横向溢出')
  if (process.env.SMOKE_HERDR_SHOT) fs.writeFileSync(process.env.SMOKE_HERDR_SHOT + '-mobile.png', Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' }, C)).data, 'base64'))
  await ev(C, `document.querySelector('[role=dialog] [data-pane-id="wB:p2"]')?.click()`)
  await sleep(700)
  ok(await ev(C, `location.hash === '#/s/pwB:p2' && !document.querySelector('[role=dialog]')`), '手机会话抽屉：点击名称仍选择正确的原始 ID')
  await ev(C, `location.hash = '#/s/pwA:pB'`)
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: false }, C)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, C)

  // 5b. 打开时网络断了：终端那一块（懒加载的分块）载入失败，网络回来后自己补上，不用重开 App，也不报问题
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/panes*' }, { urlPattern: '*/api/send*' }, { urlPattern: '*/assets/c-TerminalView*' }] }, C)
  await cdp('Network.setCacheDisabled', { cacheDisabled: true }, C)
  dropChunks = true
  await ev(C, 'location.reload()')
  await sleep(3500)
  const blank = await ev(C, `!document.querySelector('.xterm')`)
  dropChunks = false
  await ev(C, `dispatchEvent(new Event('online'))`)
  let back = false
  for (let i = 0; i < 20 && !back; i++) { await sleep(500); back = await ev(C, `!!document.querySelector('.xterm')`) }
  ok(blank && back, '断网时终端分块载入失败，网络回来自己补上', `blank=${blank} back=${back}`)
  await cdp('Network.setCacheDisabled', { cacheDisabled: false }, C)

  // 6. 全程的报错
  const ex = exceptions.filter((e) => !/Failed to fetch|NetworkError|Load failed/.test(e))
  ok(!ex.length, '页面没有未捕获的异常', ex.slice(0, 3).join(' | '))
  const cp = clientProblems()
  ok(!cp.length, '没有客户端问题报告', cp.slice(0, 2).map((l) => l.slice(l.indexOf('{'), l.indexOf('{') + 160)).join(' | '))
} catch (e) {
  ok(false, '冒烟测试本身出错', e.stack || e.message)
} finally {
  await cleanup()
}
console.log(`\n${results.length - failed}/${results.length} 通过${failed ? `；日志在 ${TMP}` : ''}`)
process.exit(failed ? 1 : 0)
