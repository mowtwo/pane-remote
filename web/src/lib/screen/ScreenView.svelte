<script lang="ts">
  // 看屏幕模块：在手机上看 / 操作电脑的屏幕（系统自带的屏幕共享，noVNC 连）：WS api/screen/vnc → 服务端 → bridge → 电脑上的 5900。
  // 画面在电脑上转码（agent/screen/proxy.mjs）：一次只发一块显示器，默认按「点」的分辨率、压成 JPEG（中转服务器带宽小也能用）。
  // 换屏 / 换清晰度发自定义消息 250 给转码代理，不用重新认证；它在整块画面到齐那一帧末尾带个 DesktopName，收到就算加载完。
  // 也能只看某个窗口（252，画面由电脑上的 mousectl 单独录这个窗口，不用切到前台）；第一次点它才切到前台，253 切回原来的前台 app。
  // 两种操作方式：
  //   直接点：轻点 = 在手指处点击；长按 / 双指轻点 = 右键；长按后拖 = 按住左键拖；单指滑 = 滚动；双指 = 本地缩放 / 平移
  //   触控板：手指滑动挪光标，轻点 = 在光标处点击；长按 / 双指轻点 = 右键；长按后拖 = 拖动；双指滑 = 滚动，双指捏 = 缩放（画面跟着光标走）
  //   底栏的鼠标键按钮：点一下让下一次点击变成右键，再点一下变中键（点完一次自动回到左键）
  // 鼠标都直接走 noVNC 内部的发送（坐标相对画布，它按缩放和视口换算），不派发 DOM 鼠标事件：
  // 合成的 mousedown 会触发它的「鼠标捕获」遮罩，之后整个页面的点击都被吃掉。
  // 「横过来」：竖着拿手机时把整个界面转 90°，所有触摸坐标都先换回界面自己的坐标系（toLocal）。
  // 是平台自带的插件「看屏幕」（lib/plugins/builtin，地址 #/plugin/screen，挂在 Shadow DOM 里）：
  //   左上角按钮切到后台（onhide）：连接不断，active = false 时不再向转码代理要画面（它是手机要一帧才发一帧），回前台补要一帧增量，不用重连
  //   后台 30 分钟没回来插件睡眠：组件卸载、连接断开（转码代理照常保留解锁的会话）；看的是哪个窗口、放大到哪存进 localStorage（screenView），重新打开时恢复
  //   「断开连接」「锁屏并离开」才关掉插件（onclose）
  import { onDestroy, tick, untrack } from 'svelte'
  import RFB from '@novnc/novnc'
  import X from '@lucide/svelte/icons/x'
  import Keyboard from '@lucide/svelte/icons/keyboard'
  import Mouse from '@lucide/svelte/icons/mouse'
  import RotateCw from '@lucide/svelte/icons/rotate-cw'
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2'
  import Hand from '@lucide/svelte/icons/hand'
  import AppWindow from '@lucide/svelte/icons/app-window'
  import Lock from '@lucide/svelte/icons/lock'
  import Undo2 from '@lucide/svelte/icons/undo-2'
  import Monitor from '@lucide/svelte/icons/monitor'
  import MonitorUp from '@lucide/svelte/icons/monitor-up'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Maximize from '@lucide/svelte/icons/maximize'
  import RotateCcwSquare from '@lucide/svelte/icons/rotate-ccw-square'
  import Scaling from '@lucide/svelte/icons/scaling'
  import Unplug from '@lucide/svelte/icons/unplug'
  import { Button } from '$lib/components/ui/button'
  import { cn } from '$lib/utils'
  import { t, tr } from '$lib/i18n'
  import { postJson } from '$lib/api'
  import { watchRender } from './renderWatch'
  import LiveInput, { type LiveKey, type Mod } from '$lib/components/LiveInput.svelte'
  import { device, realMouse } from '$lib/device.svelte'

  let { open = $bindable(false), active = true, onhide, onclose }: { open?: boolean; active?: boolean; onhide?: () => void; onclose?: () => void } = $props()

  // 本机记住的设置（用户名、选的屏、清晰 / 触控板 / 横屏），不记密码
  const load = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
  /** GET api/screen/<动作>，出错抛带服务端原因的 Error */
  async function getJson<T>(action: string): Promise<T> {
    const r = await fetch(`api/screen/${action}`, { cache: 'no-store' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(tr(d.error) || `HTTP ${r.status}`)
    return d as T
  }
  const save = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }

  let screen = $state<HTMLDivElement>()
  let stage = $state<HTMLDivElement>()
  let overlay = $state<HTMLDivElement>()
  let rfb: any = null
  let sock: WebSocket | null = null
  let status = $state<'connecting' | 'login' | 'auth' | 'loading' | 'live' | 'closed'>('connecting')
  let reason = $state('')
  let desktop = $state('')
  let received = $state(0)
  let kbOpen = $state(false)
  let kbInput = $state<HTMLInputElement>()
  let username = $state(load('screenUser', ''))
  let password = $state('')
  let needUser = $state(true)
  let authFailed = false
  // Mac 的屏幕共享冷启动后第一个连接整场黑屏，转码代理会报「[r]」让我们马上用同一组用户名密码重连一次（只在内存里留到用掉）
  let lastCreds: { username?: string; password: string } | null = null
  // 加载超过 3 秒多半是屏幕共享冷启动（转码代理在等画面 / 让我们重连），提示一下
  let slowLoad = $state(false)
  let slowTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    clearTimeout(slowTimer)
    slowLoad = false
    if (status === 'loading' || status === 'auth') slowTimer = setTimeout(() => (slowLoad = true), 3000)
  })
  let rotated = $state(load('screenRotate', '0') === '1')
  let pad = $state(load('screenPad', '0') === '1') // 触控板模式
  let hi = $state(load('screenHi', '0') === '1') // 清晰模式：按屏幕的实际像素发（流量大约 4 倍）

  // ---------- 显示器：只用来显示选屏按钮；位置换算在电脑上的转码代理里 ----------
  type Disp = { name: string; x: number; y: number; w: number; h: number } // 位置是系统坐标（点，原点在主屏左下角）
  let displays = $state<Disp[]>([])
  let selected = $state(Number(load('screenDisplay', '0')) || 0)
  async function loadDisplays() {
    try {
      const { displays: ds } = await getJson<{ displays: Disp[] }>('displays')
      // 没接显示器的 Mac（虚拟显示器）系统给的名字是空的：用序号和分辨率代替
      displays = ds.map((d, i) => ({ name: d.name?.trim() || t('屏幕 {n} · {w}×{h}', { n: i + 1, w: d.w, h: d.h }), x: d.x, y: d.y, w: d.w, h: d.h }))
    } catch { displays = [] }
    if (selected >= displays.length) selected = 0
  }
  /** 给转码代理的参数：显示器序号,清晰 0/1（每块屏在整张画面里的位置由它自己校准） */
  const viewArgs = () => `${selected},${hi ? 1 : 0}`
  /** 换屏 / 换清晰度：[250, 显示器序号, 清晰] */
  function sendView() {
    if (!sock || sock.readyState !== 1) return
    sock.send(new Uint8Array([250, selected, hi ? 1 : 0]))
    winView = null
    status = 'loading'
    received = 0
    zoom = 1; pos = { x: 0, y: 0 }; cursor = null
  }
  function pickDisplay(i: number) {
    if ((i === selected && !winView) || !sock) return
    selected = i
    save('screenDisplay', String(i))
    sendView()
  }
  function toggleHi() {
    hi = !hi
    save('screenHi', hi ? '1' : '0')
    if (winView) sendWindow(winView)
    else sendView()
  }
  // ---------- 按窗口看 ----------
  type Win = { id: number; pid: number; app: string; bundle: string; title: string; onScreen: boolean; x?: number; y?: number; w: number; h: number }
  type App = { bundle: string; name: string; running: boolean; tray?: boolean }
  let winView = $state<Win | null>(null) // 正在看的窗口；null = 看整块屏
  let winStale = $state(false)
  let picker = $state(false)
  let pickerEl = $state<HTMLDivElement>()
  let wins = $state<Win[]>([])
  let apps = $state<App[]>([])
  let pickErr = $state('')
  let query = $state('')
  let launching = $state('')
  async function loadWindows() {
    pickErr = ''
    try { wins = (await getJson<{ windows: Win[] }>('windows')).windows } catch (e) { pickErr = (e as Error).message; wins = [] }
  }
  async function openPicker() {
    picker = true
    query = ''
    await loadWindows()
    try { apps = (await getJson<{ apps: App[] }>('apps')).apps } catch { apps = [] }
  }
  /** 看某个窗口：[252, 窗口号 u32, 清晰, 先切到前台] */
  function sendWindow(w: Win) {
    if (!sock || sock.readyState !== 1) return
    const m = new Uint8Array(7)
    m[0] = 252; new DataView(m.buffer).setUint32(1, w.id); m[5] = hi ? 1 : 0
    m[6] = thumb(w) ? 1 : 0 // 台前调度收起来的：先切到前台再录
    sock.send(m)
    winView = w
    status = 'loading'
    received = 0
    zoom = 1; pos = { x: 0, y: 0 }; cursor = null
  }
  function pickWindow(w: Win) { picker = false; sendWindow(w) }
  async function launchApp(a: App) {
    launching = a.bundle
    try {
      // 托盘 app（uTools 这类）已经在跑：按它的唤出快捷键 / 点菜单栏图标；别的：后台打开 / 让它重新开个窗口
      await postJson(`api/screen/${a.tray && a.running ? 'summon' : 'launch'}`, { bundle: a.bundle })
      a.running = true
      // 等它把窗口开出来
      const before = new Set(wins.map((w) => w.id))
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 700))
        await loadWindows()
        // 新开出来的窗口（QQ、微信关掉窗口后点这个会重新打开主窗口）：直接切过去看
        const nw = wins.find((w) => w.bundle === a.bundle && !before.has(w.id) && !thumb(w))
        if (nw) { launching = ''; pickWindow(nw); return }
      }
    } catch (e) { pickErr = tr((e as Error).message) }
    launching = ''
  }
  // 关窗口（点一次）/ 退出 app（点两次：第一次变成「确认退出？」，3 秒内再点才退出；退不掉再给「强制退出」，也要点两次）
  let confirmKey = $state('')
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  let stuck = $state<string[]>([]) // 正常退出 3 秒后还在的 app
  const PROTECTED = new Set(['com.apple.finder', 'com.apple.Spotlight', 'com.apple.dock'])
  function armed(k: string) {
    if (confirmKey === k) { clearTimeout(confirmTimer); confirmKey = ''; return true }
    confirmKey = k
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => (confirmKey = ''), 3000)
    return false
  }
  // ---------- 把窗口挪到另一块显示器（大小不变、放不下就缩；挪完正在看的窗口画面会跟着走） ----------
  let movingId = $state(0) // 哪个窗口在选目标屏（窗口列表里）
  let moveBusy = $state(false)
  /** 窗口中心在哪块屏上：窗口坐标是左上角原点，显示器是左下角原点 */
  function dispOf(w: { x?: number; y?: number; w: number; h: number }) {
    if (w.x == null || w.y == null || !displays.length) return -1
    const mainH = displays[0].h, cx = w.x + w.w / 2, cy = w.y + w.h / 2
    return displays.findIndex((d) => cx >= d.x && cx < d.x + d.w && cy >= mainH - d.y - d.h && cy < mainH - d.y)
  }
  async function moveWin(w: Win, display: number) {
    if (moveBusy) return
    moveBusy = true
    try {
      await postJson('api/screen/move', { id: w.id, display })
      showNote(t('已挪到 {name}', { name: shortName(displays[display]?.name || '') }))
      movingId = 0; moreOpen = false
      await loadWindows()
      const nw = wins.find((x) => x.id === w.id)
      if (nw && winView?.id === w.id) winView = { ...winView, x: nw.x, y: nw.y }
    } catch (e) { const m = tr((e as Error).message); showNote(m); pickErr = m }
    moveBusy = false
  }
  async function closeWin(w: Win) {
    try { await postJson('api/screen/close', { id: w.id }); await new Promise((r) => setTimeout(r, 600)); await loadWindows() } catch (e) { pickErr = tr((e as Error).message) }
  }
  async function quitApp(bundle: string, force = false) {
    if (!armed(`${force ? 'force' : 'quit'}:${bundle}`)) return
    try {
      await postJson('api/screen/quit', { bundle, force })
      await new Promise((r) => setTimeout(r, force ? 1000 : 3000))
      await loadWindows()
      try { apps = (await getJson<{ apps: App[] }>('apps')).apps } catch {}
      const still = wins.some((w) => w.bundle === bundle) || apps.some((a) => a.bundle === bundle && a.running)
      stuck = still && !force ? [...stuck, bundle] : stuck.filter((b) => b !== bundle)
      if (still && force) pickErr = t('强制退出后它还在运行')
    } catch (e) { pickErr = tr((e as Error).message) }
  }

  /** 把之前的前台 app 切回来（看窗口时点过它，它就被切到了前台） */
  function restoreFront() { sock?.readyState === 1 && sock.send(new Uint8Array([253])) }
  // 锁屏并离开（点两次）：Mac 马上锁屏，不保留会话（平时锁着连上、手机解的锁，断开后 Mac 会保持解锁 1 小时，回来不用再输开机密码）
  function lockAndLeave() {
    if (!armed('lock')) return
    moreOpen = false
    if (sock?.readyState === 1) sock.send(new Uint8Array([246]))
    setTimeout(close, 400)
  }
  let note = $state('')
  let noteTimer: ReturnType<typeof setTimeout> | undefined
  function showNote(m: string) { note = m; clearTimeout(noteTimer); noteTimer = setTimeout(() => (note = ''), 4000) }
  // 台前调度收在一边的窗口会被缩成缩略图（侧边那一条就算在当前桌面上也是）
  const thumb = (w: Win) => w.w < 300 && w.h < 200
  const winLabel = (w: Win) => w.title || w.app
  const q = (x: string) => x.toLowerCase().includes(query.trim().toLowerCase())
  const groups = $derived.by(() => {
    const m = new Map<string, Win[]>()
    for (const w of wins) if (!query.trim() || q(w.app) || q(w.title)) m.set(w.app, [...(m.get(w.app) ?? []), w])
    return [...m.entries()]
  })
  const idle = $derived(apps.filter((a) => !wins.some((w) => w.bundle === a.bundle) && (!query.trim() || q(a.name))))

  let moreOpen = $state(false)

  // ---------- 改窗口大小（窗口模式）：拖右边 / 下边 / 右下角的手柄，松手一次设到那个大小；也有占满、半屏、适合手机 ----------
  // 设大小在电脑上用辅助功能直接改（不拖窗口边、不切前台），拖的过程中只在手机上画目标轮廓
  let resizing = $state(false)
  let resizeEl = $state<HTMLDivElement>()
  let winPts = $state<{ w: number; h: number } | null>(null) // 窗口现在的大小（点）
  let drag = $state<{ edge: 'r' | 'b' | 'rb'; x0: number; y0: number; w: number; h: number } | null>(null) // 目标大小（画面像素）
  function sendPlace(mode: number, a = 0, b = 0) {
    if (!sock || sock.readyState !== 1) return
    const m = new Uint8Array(6), v = new DataView(m.buffer)
    m[0] = 247; m[1] = mode; v.setUint16(2, Math.max(0, Math.min(65535, Math.round(a)))); v.setUint16(4, Math.max(0, Math.min(65535, Math.round(b))))
    sock.send(m)
  }
  function startResize() { moreOpen = false; resizing = true; winPts = null; sendPlace(0) }
  function onPlace(r: { m: number; ok: boolean; pw?: number; ph?: number; err?: string }) {
    if (!r.ok) { showNote(r.err ? tr(r.err) : t('没改成')); if (r.m === 0) resizing = false; return }
    winPts = { w: r.pw!, h: r.ph! }
    if (r.m !== 0) showNote(t('窗口改成了 {w}×{h}', { w: r.pw!, h: r.ph! }))
  }
  // 手柄和轮廓的位置：画面（窗口）在舞台里的矩形
  const canvasBox = $derived.by(() => {
    cursorTick
    if (!resizing || !stage || !canvas() || !display()) return null
    const cr = localRect(canvas()!), sr = localRect(stage)
    const d = display()
    const [w, h] = [(d.width - d._viewportLoc.x) * d._scale, (d.height - d._viewportLoc.y) * d._scale]
    return { x: cr.left - sr.left, y: cr.top - sr.top, w: Math.min(w, cr.width), h: Math.min(h, cr.height), scale: d._scale as number, fw: d.width as number, fh: d.height as number }
  })
  function handleDown(e: TouchEvent, edge: 'r' | 'b' | 'rb') {
    e.preventDefault(); e.stopPropagation()
    const b = canvasBox, p = e.touches[0]
    if (!b || !p) return
    const lp = toLocal(p.clientX, p.clientY)
    drag = { edge, x0: lp.x, y0: lp.y, w: b.fw, h: b.fh }
  }
  function handleMove(e: TouchEvent) {
    e.preventDefault(); e.stopPropagation()
    const b = canvasBox, p = e.touches[0]
    if (!drag || !b || !p) return
    const lp = toLocal(p.clientX, p.clientY)
    const dw = drag.edge === 'b' ? 0 : (lp.x - drag.x0) / b.scale, dh = drag.edge === 'r' ? 0 : (lp.y - drag.y0) / b.scale
    drag = { ...drag, w: Math.max(120, b.fw + dw), h: Math.max(90, b.fh + dh) }
  }
  function handleUp(e: TouchEvent) {
    e.preventDefault(); e.stopPropagation()
    const b = canvasBox
    if (drag && b && (Math.abs(drag.w - b.fw) > 2 || Math.abs(drag.h - b.fh) > 2)) sendPlace(1, drag.w, drag.h)
    drag = null
  }
  // 拖动时显示的目标大小（点）：按现在的「点 / 画面像素」比例换算
  const dragPts = $derived(drag && winPts && canvasBox ? { w: Math.round((drag.w * winPts.w) / canvasBox.fw), h: Math.round((drag.h * winPts.h) / canvasBox.fh) } : null)
  /** 画面来源下拉：显示器 / 当前窗口 / 选择窗口… */
  function onSource(e: Event) {
    const el = e.currentTarget as HTMLSelectElement
    const v = el.value
    el.value = winView ? 'win' : `d${selected}` // 「选择窗口…」只是个动作，选完复原
    if (v === 'pick') openPicker()
    else if (v.startsWith('d')) pickDisplay(Number(v.slice(1)))
  }
  const shortName = (n: string) => (/built-?in/i.test(n) ? t('内建屏') : n)

  // ---------- 连接 ----------
  async function connect() {
    if (!screen) return
    disconnect()
    status = 'connecting'
    reason = ''
    received = 0
    await loadDisplays()
    if (!open || !screen) return
    const url = new URL('api/screen/vnc', location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('view', viewArgs())
    const c = new WebSocket(url.href)
    c.binaryType = 'arraybuffer'
    c.addEventListener('message', (e) => { if (sock === c) received += (e.data as ArrayBuffer).byteLength })
    // 服务端在电脑那头一个字节都没给就断开时，用 4001 带上原因（比如屏幕共享没开）
    c.addEventListener('close', (e) => { if (sock === c && e.code === 4001 && e.reason) reason = tr(e.reason) })
    sock = c
    const r = new RFB(screen, c, { shared: true })
    rfb = r
    r.scaleViewport = false
    r.clipViewport = true // 视口由我们控制（缩放、平移），见 applyView
    r.dragViewport = false
    r.focusOnClick = false // 电脑版在鼠标按下时自己给焦点（onMouse）
    r.showDotCursor = false
    r.background = '#111'
    r.qualityLevel = 6
    r.compressionLevel = 2
    // 缩放和视口全归我们管：noVNC 在画面区域尺寸变化、换分辨率时会调这两个，把缩放改回它自己的默认值
    r._updateClip = () => applyView()
    r._updateScale = () => applyView()
    const stopWatch = watchRender(r) // 手机端渲染卡住时跳过坏图、要整屏，并上报（见 renderWatch.ts）
    if (!active) r._enabledContinuousUpdates = true // 在后台连上的（睡眠前就在后台不会这样，保险）
    r.addEventListener('connect', () => { if (rfb !== r) return; if (status !== 'live') status = 'loading'; zoom = 1; pos = { x: 0, y: 0 }; cursor = null })
    r.addEventListener('disconnect', (e: any) => {
      stopWatch()
      if (rfb !== r) return
      rfb = null
      sock = null
      // 密码不对：重新连一次回到登录框，带上提示
      if (authFailed) { authFailed = false; connect().then(() => { reason = t('用户名或密码不对') }); return }
      status = 'closed'
      if (!e.detail?.clean && !reason) reason = t('连接断了')
    })
    r.addEventListener('credentialsrequired', (e: any) => {
      if (rfb !== r) return
      needUser = (e.detail?.types || []).includes('username')
      if (lastCreds) { const c = lastCreds; lastCreds = null; r.sendCredentials(needUser ? c : { password: c.password }); status = 'auth'; return }
      status = 'login'
    })
    r.addEventListener('securityfailure', () => { if (rfb === r) authFailed = true })
    // 转码代理在 ServerInit 里不给名字，整块画面到齐的那一帧才带上：收到名字 = 画面到了
    r.addEventListener('desktopname', (e: any) => {
      if (rfb !== r || !e.detail?.name) return
      const n = String(e.detail.name)
      if (n.startsWith('[k]')) { try { onProbe(JSON.parse(n.slice(3))) } catch {} return } // 输入框探测结果
      if (n.startsWith('[z]')) { try { onPlace(JSON.parse(n.slice(3))) } catch {} return } // 改窗口大小的结果
      if (n === '[r]') { if (lastCreds) { status = 'loading'; connect() } return } // 冷启动黑屏：用刚输的密码马上重连一次（只一次，密码用掉就没了）
      // 转码代理看窗口时报「[w]窗口号」；报回 Mac 的名字说明在看整块屏（窗口关了它会自己退回去）
      if (n.startsWith('[w]')) {
        if (winView?.id !== parseInt(n.slice(3))) winView = null
        winStale = n.endsWith('p') // 切到前台也还是拿不到实时画面（比如最小化了）：只有截图
        if (n.endsWith('f')) showNote(t('窗口不在当前桌面，已把它切到前台'))
      }
      else if (n.startsWith('[x]')) { winView = null; resizing = false; showNote(tr(n.slice(3))) } // 窗口录不到，转码代理退回看屏了
      else { winView = null; resizing = false; desktop = n }
      status = 'live'
      tick().then(applyView)
      restoreView(n)
    })
  }
  function disconnect() {
    const r = rfb
    rfb = null
    sock = null
    try { r?.disconnect() } catch {}
  }
  function login(e: Event) {
    e.preventDefault()
    // 直接读输入框：iPhone 自动填充的用户名 / 密码不一定触发 input 事件，绑定的变量可能还是旧值
    const f = new FormData(e.currentTarget as HTMLFormElement)
    const u = String(f.get('username') ?? username).trim()
    const p = String(f.get('password') ?? password)
    if (!rfb || !p) return
    username = u
    save('screenUser', u)
    reason = ''
    rfb.sendCredentials(needUser ? { username: u, password: p } : { password: p })
    lastCreds = { username: u, password: p }
    setTimeout(() => (lastCreds = null), 20000) // 冷启动黑屏 15 秒内就会发现，之后不再留着
    password = ''
    status = 'auth'
  }
  let closing = false
  function close() {
    closing = true
    try { localStorage.removeItem(VIEW_KEY) } catch {} // 主动断开的不用恢复
    disconnect()
    open = false
    onclose?.()
  }
  $effect(() => {
    if (open) tick().then(connect)
    else disconnect()
  })
  onDestroy(() => { if (!closing) saveView(); disconnect() })

  // ---------- 后台：连接保持，不再要画面 ----------
  // noVNC 每收完一帧就再要一帧（没开 continuous updates 时）；把它当成已开着，它就不再要，转码代理也就不再发。回前台复原，补要一帧增量
  function setLive(on: boolean) {
    const r = rfb
    if (!r) return
    if (!on) { r._enabledContinuousUpdates = true; return }
    if (!r._enabledContinuousUpdates) return
    r._enabledContinuousUpdates = false
    if (status === 'live' || status === 'loading') try { RFB.messages.fbUpdateRequest(r._sock, true, 0, 0, r._fbWidth, r._fbHeight) } catch {}
    tick().then(applyView)
  }
  $effect(() => { const a = active; untrack(() => setLive(a)) })

  // ---------- 睡眠前存、重新打开时恢复：看的窗口、放大和位置（屏、清晰度、操作方式、横过来本来就各自存着） ----------
  const VIEW_KEY = 'screenView'
  type Saved = { win: Win | null; zoom: number; pos: { x: number; y: number }; at: number }
  let restore: Saved | null = (() => { try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); return v && Date.now() - v.at < 2 * 3600000 ? v : null } catch { return null } })()
  function saveView() {
    if (status !== 'live' && !restore) return
    const v: Saved = restore && status !== 'live' ? restore : { win: winView ? $state.snapshot(winView) : null, zoom, pos: { ...pos }, at: Date.now() }
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)) } catch {}
  }
  /** 画面到了（desktopname）：第一次先切回原来看的窗口，再恢复放大 */
  function restoreView(n: string) {
    const r = restore
    if (!r) return
    if (r.win && !n.startsWith('[w]') && !n.startsWith('[x]')) { restore = { ...r, win: null }; sendWindow(r.win); return }
    restore = null
    if (n.startsWith('[x]')) return // 窗口没了，转码代理退回看屏
    zoom = r.zoom || 1
    pos = { ...r.pos }
    tick().then(applyView)
  }

  // ---------- 横过来：界面坐标 ↔ 屏幕坐标 ----------
  /** 屏幕坐标 → 界面坐标（转了 90° 时：界面 x = 屏幕 y，界面 y = 屏幕宽 - 屏幕 x） */
  function toLocal(cx: number, cy: number) {
    return rotated ? { x: cy, y: window.innerWidth - cx } : { x: cx, y: cy }
  }
  /** 元素在界面坐标系里的位置 */
  function localRect(el: Element) {
    const r = el.getBoundingClientRect()
    return rotated ? { left: r.top, top: window.innerWidth - r.right, width: r.height, height: r.width } : { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  function toggleRotate() {
    rotated = !rotated
    save('screenRotate', rotated ? '1' : '0')
    tick().then(() => setTimeout(applyView, 50))
  }
  function togglePad() {
    pad = !pad
    save('screenPad', pad ? '1' : '0')
    cursor = null
  }

  // ---------- 视口：适应屏幕的缩放 × 本地放大 zoom，左上角 pos（画面像素） ----------
  let zoom = $state(1)
  let pos = { x: 0, y: 0 }
  const display = () => rfb?._display
  function fitScale() {
    const d = display()
    if (!d || !stage || !d.width) return 1
    return Math.min(stage.clientWidth / d.width, stage.clientHeight / d.height)
  }
  function applyView() {
    const d = display()
    if (!d || !stage || !d.width) return
    const s = fitScale() * zoom
    const w = Math.min(d.width, stage.clientWidth / s)
    const h = Math.min(d.height, stage.clientHeight / s)
    pos.x = Math.max(0, Math.min(d.width - w, pos.x))
    pos.y = Math.max(0, Math.min(d.height - h, pos.y))
    d.viewportChangeSize(w, h)
    d.scale = s
    const vp = d._viewportLoc
    d.viewportChangePos(pos.x - vp.x, pos.y - vp.y)
    cursorTick++
  }
  // 兜底：定时对一下视口（只比较数字，很便宜）
  $effect(() => {
    if ((status !== 'live' && status !== 'loading') || !active) return
    const ro = new ResizeObserver(() => setTimeout(applyView, 50))
    if (stage) ro.observe(stage)
    const timer = setInterval(() => {
      const d = display()
      if (!d || !stage || !d.width) return
      const s = fitScale() * zoom
      if (Math.abs(d._scale - s) > 1e-6 || Math.abs(d._viewportLoc.w - Math.min(d.width, stage.clientWidth / s)) > 1) applyView()
    }, 500)
    return () => { ro.disconnect(); clearInterval(timer) }
  })
  function resetView() { zoom = 1; pos = { x: 0, y: 0 }; applyView() }

  // ---------- 发鼠标 ----------
  const canvas = () => (rfb?._canvas as HTMLCanvasElement | undefined) || null
  /** 界面坐标 → 相对画布的像素 */
  function onCanvas(lx: number, ly: number) {
    const r = localRect(canvas()!)
    return [lx - r.left, ly - r.top] as const
  }
  /** 画面坐标 → 相对画布的像素 */
  function fbOnCanvas(fx: number, fy: number) {
    const d = display()
    return [(fx - d._viewportLoc.x) * d._scale, (fy - d._viewportLoc.y) * d._scale] as const
  }
  let held = 0 // 现在按着的鼠标键
  function sendAt(p: readonly [number, number], mask: number | null) {
    if (!rfb || !canvas()) return
    if (mask === null) rfb._handleMouseMove(p[0], p[1])
    else { held = mask; rfb._handleMouseButton(p[0], p[1], mask) }
  }
  function clickAt(p: readonly [number, number], m = 1) { sendAt(p, null); sendAt(p, m); sendAt(p, 0) }
  // 滚轮：攒够 50 像素发一格（RFB 里滚轮是按键 4/5，左右 6/7）
  const acc = { x: 0, y: 0 }
  function wheelAt(p: readonly [number, number], dx: number, dy: number) {
    acc.x += dx; acc.y += dy
    const STEP = 50
    // 滚轮「键」按一下马上松开，不记进 held（拖动时按着的左键保持按着）
    const tapBtn = (m: number) => { if (!rfb || !canvas()) return; rfb._handleMouseButton(p[0], p[1], held | m); rfb._handleMouseButton(p[0], p[1], held) }
    while (Math.abs(acc.y) >= STEP) { tapBtn(acc.y > 0 ? 16 : 8); acc.y -= Math.sign(acc.y) * STEP }
    while (Math.abs(acc.x) >= STEP) { tapBtn(acc.x > 0 ? 64 : 32); acc.x -= Math.sign(acc.x) * STEP }
  }

  // ---------- 触控板模式的光标（画面坐标）：挪出视口时画面跟着走 ----------
  let cursor = $state<{ x: number; y: number } | null>(null)
  let cursorTick = $state(0)
  function ensureCursor() {
    const d = display()
    if (!d) return null
    if (!cursor) cursor = { x: d._viewportLoc.x + d._viewportLoc.w / 2, y: d._viewportLoc.y + d._viewportLoc.h / 2 }
    return cursor
  }
  function moveCursor(dx: number, dy: number) {
    const d = display()
    const c = ensureCursor()
    if (!d || !c) return
    const s = d._scale || 1
    const SPEED = 1.4
    const n = { x: Math.max(0, Math.min(d.width - 1, c.x + (dx * SPEED) / s)), y: Math.max(0, Math.min(d.height - 1, c.y + (dy * SPEED) / s)) }
    // 光标挪出看得见的区域：平移画面
    const vp = d._viewportLoc, m = 20 / s
    let moved = false
    if (n.x < vp.x + m) { pos.x = n.x - m; moved = true }
    if (n.x > vp.x + vp.w - m) { pos.x = n.x - vp.w + m; moved = true }
    if (n.y < vp.y + m) { pos.y = n.y - m; moved = true }
    if (n.y > vp.y + vp.h - m) { pos.y = n.y - vp.h + m; moved = true }
    if (moved) applyView()
    cursor = n
    sendAt(fbOnCanvas(n.x, n.y), null)
  }
  const cursorStyle = $derived.by(() => {
    cursorTick
    if (!pad || !cursor || status !== 'live' || !stage || !canvas() || !display()) return null
    const cr = localRect(canvas()!), sr = localRect(stage)
    const [x, y] = fbOnCanvas(cursor.x, cursor.y)
    return `left:${cr.left - sr.left + x}px;top:${cr.top - sr.top + y}px`
  })

  // ---------- 手势 ----------
  type G = 'none' | 'tap' | 'move' | 'hold' | 'drag' | 'two' | 'pinch' | 'scroll2' | 'twoTap' | 'multi' | 'multiDone'
  let g: G = 'none'
  let sx = 0, sy = 0, lx = 0, ly = 0
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let pinch = { d: 1, z: 1, fx: 0, fy: 0, mx: 0, my: 0 }
  // 双指轻点 = 右键（和 Mac 触控板一样）：两指落下后没捏、没滑，很快都抬起
  let two = { t: 0, moved: false, mid: { x: 0, y: 0 } }
  // 下一次点击用哪个键：1 左键 / 4 右键 / 2 中键（RFB 的按钮位）；点完一次回到左键
  let nextBtn = $state(1)
  // 长按认出来了：手指下面画个圈（iPhone 不支持振动，不然不知道已经是右键了）
  let holdMark = $state<{ x: number; y: number } | null>(null)
  // 三指 / 四指：跟 Mac 触控板一样的手势，换成系统快捷键发过去（真的多指事件是系统私有格式，模拟不了也不稳）
  let multi = { n: 0, cx: 0, cy: 0, spread: 1, t: 0 }
  const centroid = (ps: { x: number; y: number }[]) => ({ x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length })
  const spreadOf = (ps: { x: number; y: number }[]) => { const c = centroid(ps); return ps.reduce((a, p) => a + dist(p, c), 0) / ps.length }
  function multiAction(kind: 'up' | 'down' | 'left' | 'right' | 'spread' | 'pinch' | 'tap', n: number) {
    navigator.vibrate?.(10)
    if (kind === 'up') press(K.Up, [K.Control]) // 调度中心
    else if (kind === 'down') press(K.Down, [K.Control]) // 应用程序窗口
    else if (kind === 'left') press(K.Right, [K.Control]) // 手指往左 = 去右边的桌面
    else if (kind === 'right') press(K.Left, [K.Control])
    else if (kind === 'spread' || kind === 'pinch') press(K.F11) // 显示桌面（再捏回来恢复）
    else if (kind === 'tap' && n === 3) press(0x64, [K.Control, K.Command]) // 查询（⌃⌘D）
  }
  const SCROLL = 1.6 // 手指挪 1 像素 → 滚轮多少像素
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) || 1
  const pts = (e: TouchEvent) => [...e.touches].map((t) => toLocal(t.clientX, t.clientY))
  function stageXY(p: { x: number; y: number }) { const r = localRect(stage!); return { x: p.x - r.left, y: p.y - r.top } }
  function offs() {
    const c = canvas()
    if (!c || !stage) return { x: 0, y: 0 }
    const cr = localRect(c), sr = localRect(stage)
    return { x: Math.max(0, cr.left - sr.left), y: Math.max(0, cr.top - sr.top) }
  }
  /** 鼠标该落在哪：直接点模式是手指位置，触控板模式是光标 */
  function target(p: { x: number; y: number }) {
    if (pad) { const c = ensureCursor(); return c ? fbOnCanvas(c.x, c.y) : onCanvas(p.x, p.y) }
    return onCanvas(p.x, p.y)
  }

  // 登录框、重连按钮这些浮层上的触摸照常交给浏览器（浮层跟 noVNC 的画布是兄弟节点，碰不到 noVNC）
  const onOverlay = (e: TouchEvent) => (!!overlay && overlay.contains(e.target as Node)) || (!!pickerEl && pickerEl.contains(e.target as Node)) || (!!bubble && bubble.contains(e.target as Node)) || (!!resizeEl && resizeEl.contains(e.target as Node))

  function onStart(e: TouchEvent) {
    if (onOverlay(e)) return
    // 其它触摸不管什么阶段都别让它落到 noVNC 自己的手势上（它会把双指捏合变成发给 Mac 的 Ctrl+滚轮）
    e.stopPropagation()
    e.preventDefault()
    if (status !== 'live') return
    clearTimeout(holdTimer)
    const ps = pts(e)
    if (ps.length >= 3 || g === 'multi' || g === 'multiDone') {
      if (g === 'drag') sendAt(target({ x: lx, y: ly }), 0)
      if (g === 'multiDone') return
      // 手指陆续落下：以最多时的指数为准，从三指那一刻重新起算
      if (g !== 'multi' || ps.length > multi.n) { const c = centroid(ps); multi = { n: ps.length, cx: c.x, cy: c.y, spread: spreadOf(ps), t: Date.now() } }
      g = 'multi'
      return
    }
    if (ps.length >= 2) {
      if (g === 'drag') sendAt(target({ x: lx, y: ly }), 0)
      const [a, b] = ps
      const m = stageXY({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
      const s = fitScale() * zoom, o = offs()
      // 双指中点下面的画面像素：缩放、平移时让它一直在两指中间
      pinch = { d: dist(a, b), z: zoom, fx: pos.x + (m.x - o.x) / s, fy: pos.y + (m.y - o.y) / s, mx: m.x, my: m.y }
      g = pad ? 'two' : 'pinch'
      two = { t: Date.now(), moved: false, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      holdMark = null
      lx = m.x; ly = m.y
      return
    }
    const p = ps[0]
    sx = lx = p.x; sy = ly = p.y
    g = 'tap'
    probe0 = null
    if (autoKb && !rotated) { const f = fbOf(target(p)); if (f) sendProbe(0, f) }
    holdTimer = setTimeout(() => { if (g === 'tap') { g = 'hold'; navigator.vibrate?.(10); holdMark = stageXY({ x: sx, y: sy }) } }, 450)
  }
  function onMove(e: TouchEvent) {
    if (onOverlay(e)) return
    e.stopPropagation()
    e.preventDefault()
    if (status !== 'live') return
    const ps = pts(e)
    if (g === 'multiDone') return
    if (g === 'multi') {
      if (ps.length < 3) return
      const c = centroid(ps), dx = c.x - multi.cx, dy = c.y - multi.cy, r = spreadOf(ps) / multi.spread
      // 滑够 60 像素或张合超过 35% 就触发，一次手势只触发一次
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 60) { multiAction(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down', multi.n); g = 'multiDone' }
      else if (r > 1.35 || r < 0.65) { multiAction(r > 1 ? 'spread' : 'pinch', multi.n); g = 'multiDone' }
      return
    }
    if (g === 'two' || g === 'pinch' || g === 'scroll2') {
      if (ps.length < 2) return
      const [a, b] = ps
      const m = stageXY({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
      const ratio = dist(a, b) / pinch.d
      if (Math.abs(ratio - 1) > 0.06 || Math.hypot(m.x - pinch.mx, m.y - pinch.my) > 10) two.moved = true
      // 触控板模式：先看是捏还是一起滑，定了就不变
      if (g === 'two') {
        if (Math.abs(ratio - 1) > 0.08) g = 'pinch'
        else if (Math.hypot(m.x - pinch.mx, m.y - pinch.my) > 10) g = 'scroll2'
        else return
      }
      if (g === 'scroll2') {
        const c = ensureCursor()
        if (c) wheelAt(fbOnCanvas(c.x, c.y), (lx - m.x) * SCROLL, (ly - m.y) * SCROLL)
        lx = m.x; ly = m.y
        return
      }
      zoom = Math.min(12, Math.max(1, pinch.z * ratio))
      const s = fitScale() * zoom
      pos = { x: pinch.fx - m.x / s, y: pinch.fy - m.y / s }
      applyView()
      return
    }
    const p = ps[0]
    if (!p) return
    const far = Math.abs(p.x - sx) > 8 || Math.abs(p.y - sy) > 8
    // 长按认出来以后手指难免会飘：放宽到 20 像素才算「长按后拖」，不然想点右键却变成了左键拖动
    const farHold = Math.abs(p.x - sx) > 20 || Math.abs(p.y - sy) > 20
    if (g === 'tap' && far) { clearTimeout(holdTimer); g = 'move' }
    if (g === 'hold' && farHold) { g = 'drag'; holdMark = null; const t0 = target({ x: sx, y: sy }); sendAt(t0, null); sendAt(t0, 1) }
    if (g === 'move') {
      if (pad) moveCursor(p.x - lx, p.y - ly)
      else wheelAt(onCanvas(p.x, p.y), (lx - p.x) * SCROLL, (ly - p.y) * SCROLL)
    } else if (g === 'drag') {
      if (pad) moveCursor(p.x - lx, p.y - ly)
      else sendAt(onCanvas(p.x, p.y), null)
    }
    lx = p.x; ly = p.y
  }
  function onEnd(e: TouchEvent) {
    if (onOverlay(e)) return
    e.stopPropagation()
    e.preventDefault()
    if (status !== 'live') return
    clearTimeout(holdTimer)
    if (g === 'multi' || g === 'multiDone') {
      // 全抬起才算结束；没滑没捏、很快抬起就是多指轻点
      if (e.touches.length) return
      if (g === 'multi' && e.type !== 'touchcancel' && Date.now() - multi.t < 350) multiAction('tap', multi.n)
      g = 'none'
      return
    }
    holdMark = null
    if (e.touches.length) {
      // 两指时抬起一根：没捏没滑、很快抬起的等另一根也抬起，算双指轻点；否则剩下那根不再算新手势
      if ((g === 'pinch' || g === 'two') && !two.moved && Date.now() - two.t < 350) g = 'twoTap'
      else if (g === 'pinch' || g === 'two' || g === 'scroll2') g = 'none'
      return
    }
    if (e.type === 'touchcancel') { if (g === 'drag') sendAt(target({ x: lx, y: ly }), 0); g = 'none'; return }
    if (g === 'twoTap') {
      if (Date.now() - two.t < 500) { navigator.vibrate?.(10); clickAt(target(two.mid), 4) }
      g = 'none'
      return
    }
    if (g === 'tap') {
      const tp = target({ x: sx, y: sy })
      const f = autoKb && !rotated ? fbOf(tp) : null
      // 手指按下时问的结果已经到了、而且是输入框：趁还在手势里弹键盘
      if (f && probe0?.t && Date.now() - probe0.at < 2000 && Math.abs(probe0.x - f.x) < 24 && Math.abs(probe0.y - f.y) < 24) openKb(f)
      const btn = nextBtn
      nextBtn = 1
      clickAt(tp, btn)
      if (f && btn === 1) { kbTarget = f; setTimeout(() => sendProbe(1, f), 250) }
    }
    else if (g === 'hold') clickAt(target({ x: sx, y: sy }), 4) // RFB 里右键是第 3 位
    else if (g === 'drag') sendAt(target({ x: lx, y: ly }), 0)
    g = 'none'
  }
  $effect(() => {
    const el = stage
    if (!el) return
    const opts = { passive: false, capture: true } as AddEventListenerOptions
    el.addEventListener('touchstart', onStart, opts)
    el.addEventListener('touchmove', onMove, opts)
    el.addEventListener('touchend', onEnd, opts)
    el.addEventListener('touchcancel', onEnd, opts)
    return () => {
      el.removeEventListener('touchstart', onStart, opts)
      el.removeEventListener('touchmove', onMove, opts)
      el.removeEventListener('touchend', onEnd, opts)
      el.removeEventListener('touchcancel', onEnd, opts)
    }
  })

  // ---------- 电脑版：真鼠标、真键盘 ----------
  // 鼠标和触摸一样在捕获阶段拦下、走 noVNC 内部的发送（不让 noVNC 自己处理 DOM 鼠标事件）；
  // 按下时把焦点给画布，键盘交给 noVNC 自己的键盘处理（⌘ 发成 Super，Mac 上就是 Command）。
  // 浏览器自己占着的快捷键（⌘W、⌘T、⌘Q）拦不到；中文用底栏的输入栏
  const BTN: Record<number, number> = { 0: 1, 1: 2, 2: 4 }
  function onMouse(e: MouseEvent) {
    if (!rfb || !canvas() || onOverlay(e as unknown as TouchEvent) || !realMouse(e)) return // 手指轻点后浏览器补发的鼠标事件不算：触摸手势另外处理
    e.stopPropagation()
    if (e.type === 'contextmenu') { e.preventDefault(); return }
    const p = onCanvas(e.clientX, e.clientY)
    if (e.type === 'mousemove') return sendAt(p, null)
    const bit = BTN[e.button]
    if (bit == null) return
    e.preventDefault()
    if (e.type === 'mousedown') { rfb.focus(); sendAt(p, null); sendAt(p, held | bit) }
    else sendAt(p, held & ~bit)
  }
  function onWheel(e: WheelEvent) {
    if (!rfb || !canvas() || onOverlay(e as unknown as TouchEvent)) return
    e.stopPropagation(); e.preventDefault()
    const k = e.deltaMode === 1 ? 50 : 1
    wheelAt(onCanvas(e.clientX, e.clientY), e.deltaX * k, e.deltaY * k)
  }
  $effect(() => {
    const el = stage
    if (!el || !device.mouse) return // 有鼠标 / 触控板就接（含 iPhone、iPad 外接的）；每个事件再看是不是真鼠标
    const opts = { passive: false, capture: true } as AddEventListenerOptions
    const evs = ['mousedown', 'mouseup', 'mousemove', 'contextmenu'] as const
    for (const ev of evs) el.addEventListener(ev, onMouse, opts)
    el.addEventListener('wheel', onWheel, opts)
    // 拖到画面外面才松开：画面里的事件已经被上面拦住，到这里的都是外面的，照样松开那个键
    const up = (e: MouseEvent) => { if (held && rfb && canvas()) sendAt(onCanvas(e.clientX, e.clientY), held & ~(BTN[e.button] ?? 0)) }
    window.addEventListener('mouseup', up)
    return () => {
      for (const ev of evs) el.removeEventListener(ev, onMouse, opts)
      el.removeEventListener('wheel', onWheel, opts)
      window.removeEventListener('mouseup', up)
    }
  })

  // ---------- 键盘：手机输入框里打的字逐个发过去；特殊键和修饰键用按钮 ----------
  const K = { BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Shift: 0xffe1, Control: 0xffe3, Option: 0xffe9, Command: 0xffeb, F11: 0xffc8, Delete: 0xffff, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56 }
  const MOD_SYM: Record<Mod, number> = { Meta: K.Command, Alt: K.Option, Control: K.Control, Shift: K.Shift }
  const NAMED: Record<string, number> = { Enter: K.Return, Backspace: K.BackSpace, Tab: K.Tab, Escape: K.Escape, ArrowLeft: K.Left, ArrowRight: K.Right, ArrowUp: K.Up, ArrowDown: K.Down, Delete: K.Delete, Home: K.Home, End: K.End, PageUp: K.PageUp, PageDown: K.PageDown }
  // 快捷键跟终端页的规则一样：第一行放最常用的（正好排满一行不用滑），其余收在「⋯」展开的面板里（自动换行）。
  // ⌘Q 太容易误点退出 app，不放；要用就点 ⌘ 再按 q
  const TOP_KEYS: LiveKey[] = [{ label: '⌘', mod: 'Meta' }, { label: 'Esc', key: 'Escape' }, { label: 'Tab', key: 'Tab' }, { label: '↩', key: 'Enter' }, { label: '⌫', key: 'Backspace' },
    { label: '←', key: 'ArrowLeft' }, { label: '→', key: 'ArrowRight' }, { label: '⌘C', key: 'c', mods: ['Meta'] }, { label: '⌘V', key: 'v', mods: ['Meta'] }]
  const MORE_KEYS: LiveKey[] = [{ label: '⌥', mod: 'Alt' }, { label: '⌃', mod: 'Control' }, { label: '⇧', mod: 'Shift' }, { label: '↑', key: 'ArrowUp' }, { label: '↓', key: 'ArrowDown' }, { label: '⌦', key: 'Delete' },
    { label: 'Home', key: 'Home' }, { label: 'End', key: 'End' }, { label: 'PgUp', key: 'PageUp' }, { label: 'PgDn', key: 'PageDown' },
    { label: '⌘X', key: 'x', mods: ['Meta'] }, { label: '⌘A', key: 'a', mods: ['Meta'] }, { label: '⌘Z', key: 'z', mods: ['Meta'] }, { label: '⌘⇧Z', key: 'z', mods: ['Meta', 'Shift'] },
    { label: '⌘S', key: 's', mods: ['Meta'] }, { label: '⌘F', key: 'f', mods: ['Meta'] }, { label: '⌘W', key: 'w', mods: ['Meta'] }, { label: '⌘T', key: 't', mods: ['Meta'] },
    { label: '⌘Tab', key: 'Tab', mods: ['Meta'] }, { label: '⌘Space', key: ' ', mods: ['Meta'] }]
  // 手机键盘弹着（可视高度明显比窗口矮）：键盘上面露出输入光标
  let kbUp = $state(false)
  $effect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const f = () => (kbUp = window.innerHeight - vv.height > 120)
    f()
    vv.addEventListener('resize', f)
    return () => vv.removeEventListener('resize', f)
  })
  const keysym = (ch: string) => { const cp = ch.codePointAt(0)!; return cp < 0x100 ? cp : 0x01000000 | cp }
  function press(sym: number, extra: number[] = []) {
    if (!rfb) return
    const all = [...new Set(extra)]
    for (const m of all) rfb.sendKey(m, null, true)
    rfb.sendKey(sym, null)
    for (const m of [...all].reverse()) rfb.sendKey(m, null, false)
  }
  /** 输入栏的按键（名字 → keysym） */
  const pressKey = (k: string, mods: Mod[]) => press(NAMED[k] ?? keysym(k), mods.map((m) => MOD_SYM[m]))
  /** 一段文字：[251, 长度, UTF-8] 整段发给转码代理，由电脑上的助手粘贴进去（不受 Mac 输入法影响、顺序不乱） */
  function typeText(s: string) {
    if (!sock || sock.readyState !== 1) { for (const ch of s) press(ch === '\n' ? K.Return : keysym(ch)); return }
    s.split('\n').forEach((part, i) => {
      if (i) press(K.Return)
      if (!part) return
      const u = new TextEncoder().encode(part)
      const m = new Uint8Array(5 + u.length)
      m[0] = 251; new DataView(m.buffer).setUint32(1, u.length); m.set(u, 5)
      sock!.send(m)
    })
  }
  async function toggleKb() {
    kbOpen = !kbOpen
    if (kbOpen) { await tick(); kbInput?.focus() }
  }

  // ---------- 自动键盘：点到电脑上的输入框就弹手机键盘（开关，默认关） ----------
  // 判断在电脑上做（转码代理的 254 探测：系统指针是不是 I 形 + 辅助功能里的焦点控件，都是只读的）。
  // iOS 只允许在手指点的那一下同步弹键盘：手指刚按下就先问一次，抬起时结果到了就当场弹；没赶上就点完再问，
  // 是输入框就在旁边浮一个「⌨」按钮，点它弹键盘。弹出后把输入光标（拿不到就用点的位置）挪到键盘上面
  let autoKb = $state(load('screenAutoKb', '0') === '1')
  function toggleAutoKb() {
    autoKb = !autoKb
    save('screenAutoKb', autoKb ? '1' : '0')
    if (autoKb && rotated) showNote(t('横过来显示时不会自动弹键盘，竖着用才行'))
  }
  let ghost = $state<HTMLInputElement>() // 一直在页面里的隐形输入框：同步 focus 它才能在手势里弹出键盘
  let bubble = $state<HTMLButtonElement>()
  let probe0: { x: number; y: number; t: boolean; at: number } | null = null
  let bubbleAt = $state<{ x: number; y: number } | null>(null)
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined
  let kbTarget: { x: number; y: number } | null = null // 键盘弹出后要露出来的点（画面坐标）
  /** 相对画布的像素 → 画面坐标 */
  function fbOf(p: readonly [number, number]) {
    const d = display()
    return d ? { x: Math.round(d._viewportLoc.x + p[0] / d._scale), y: Math.round(d._viewportLoc.y + p[1] / d._scale) } : null
  }
  function sendProbe(mode: 0 | 1, f: { x: number; y: number }) {
    if (!sock || sock.readyState !== 1) return
    const m = new Uint8Array(6)
    const v = new DataView(m.buffer)
    m[0] = 254; m[1] = mode; v.setUint16(2, Math.max(0, f.x)); v.setUint16(4, Math.max(0, f.y))
    sock.send(m)
  }
  function openKb(target?: { x: number; y: number }) {
    ghost?.focus() // 必须同步（还在手势里）
    if (target) kbTarget = target
    bubbleAt = null
    kbOpen = true
    tick().then(() => kbInput?.focus())
  }
  function onProbe(r: { m: number; t: boolean; x: number; y: number; cx?: number; cy?: number }) {
    if (r.m === 0) { probe0 = { x: r.x, y: r.y, t: r.t, at: Date.now() }; return }
    if (r.cx != null) kbTarget = { x: r.cx, y: r.cy! }
    if (!r.t || !autoKb) return
    // 快捷栏开着但手机键盘其实收起了（输入框没焦点）：还是要给按钮
    // 挂在 Shadow DOM 里：document.activeElement 只能看到宿主，要问 shadow root
    const focused = (kbInput?.getRootNode() as Document | ShadowRoot | undefined)?.activeElement ?? document.activeElement
    const typing = kbOpen && (focused === kbInput || focused === ghost)
    if (typing) { if (kbUp) revealTarget(); return }
    bubbleAt = { x: r.x, y: r.y }
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => (bubbleAt = null), 4000)
  }
  /** 键盘弹着时把要输入的地方挪到看得见的位置：放大到画面跟屏幕一样宽，目标点放在可视区域 60% 高的地方 */
  function revealTarget() {
    const d = display()
    if (!kbTarget || !d || !stage || !d.width) return
    const zw = stage.clientWidth / d.width / fitScale()
    if (zw > zoom) zoom = zw
    const sc = fitScale() * zoom
    pos = { x: kbTarget.x - stage.clientWidth / sc / 2, y: kbTarget.y - (stage.clientHeight / sc) * 0.6 }
    applyView()
  }
  $effect(() => { if (kbUp && kbOpen && kbTarget) setTimeout(revealTarget, 250) })
  const bubbleStyle = $derived.by(() => {
    cursorTick
    if (!bubbleAt || !stage || !canvas() || !display()) return null
    const cr = localRect(canvas()!), sr = localRect(stage)
    const [x, y] = fbOnCanvas(bubbleAt.x, bubbleAt.y)
    return `left:${cr.left - sr.left + x}px;top:${cr.top - sr.top + y + 14}px`
  })

  const fmtMB = (n: number) => (n / 1048576).toFixed(1)
  const bar = 'grid size-9 flex-none place-items-center rounded-lg text-white/80 active:bg-white/15'
  const chip = 'h-7 flex-none rounded-full bg-white/10 px-2.5 text-[12px] text-white/80 active:bg-white/25'
</script>

{#snippet moveChips(w: Win)}
  {@const cur = dispOf(w)}
  <div class="flex flex-wrap gap-1.5 px-2.5 pt-1 pb-2">
    {#each displays as d, i (i)}
      <button class={cn(chip, i === cur && 'bg-primary/30 text-white')} disabled={moveBusy || i === cur} onclick={() => moveWin(w, i)}>{i === 0 ? '★ ' : ''}{shortName(d.name)}{i === cur ? ` · ${t('现在在这')}` : ''}</button>
    {/each}
  </div>
{/snippet}

{#snippet quitBtns(bundle: string)}
  {#if stuck.includes(bundle)}
    <button class={cn(chip, 'flex-none', confirmKey === `force:${bundle}` ? 'bg-red-600 text-white' : 'text-red-300')} onclick={() => quitApp(bundle, true)}>{confirmKey === `force:${bundle}` ? t('确认强制退出？') : t('强制退出')}</button>
  {:else}
    <button class={cn(chip, 'flex-none', confirmKey === `quit:${bundle}` ? 'bg-red-600 text-white' : '')} onclick={() => quitApp(bundle)}>{confirmKey === `quit:${bundle}` ? t('确认退出？') : t('退出')}</button>
  {/if}
{/snippet}

{#if open}
<div
  class="fixed top-0 left-0 z-50 flex flex-col bg-neutral-950 text-white"
  style={rotated ? 'width:100dvh;height:100dvw;transform-origin:top left;transform:rotate(90deg) translateY(-100%)' : 'width:100vw;height:var(--vvh,100dvh);padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)'}
>
  <!-- 顶栏：左边关闭 + 画面来源（下拉）；右边按常用程度：键盘、操作方式、更多（画质、自动键盘、横过来、整块屏、切回前台） -->
  <div class={cn('relative flex items-center gap-1 px-1.5 pb-1', rotated ? 'pt-1' : 'pt-[calc(env(safe-area-inset-top)+4px)]')}>
    <!-- 作为插件时是「切到后台」（连接保持，回来不用重连）；断开在「更多」里 -->
    <button class={bar} aria-label={onhide ? t('切到后台') : t('关闭')} onclick={() => (onhide ? onhide() : close())}><X class="size-5" /></button>
    {#if status === 'live' || status === 'loading'}
      <label class="relative flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-white/10 pr-2 pl-2.5 text-[13px] text-white/90 active:bg-white/20">
        {#if winView}<AppWindow class="size-4 flex-none text-white/60" />{:else}<Monitor class="size-4 flex-none text-white/60" />{/if}
        <span class="min-w-0 flex-1 truncate">{winView ? `${winView.app}${winView.title && winView.title !== winView.app ? ' · ' + winView.title : ''}` : displays.length ? `${selected === 0 ? '★ ' : ''}${shortName(displays[selected]?.name || '')}` : desktop || t('Mac 的屏幕')}</span>
        <ChevronDown class="size-4 flex-none text-white/50" />
        <select class="absolute inset-0 opacity-0" aria-label={t('看哪个画面')} value={winView ? 'win' : `d${selected}`} onchange={onSource}>
          <optgroup label={t('显示器')}>
            {#each displays as d, i (i)}<option value={`d${i}`}>{i === 0 ? '★ ' : ''}{shortName(d.name)}</option>{/each}
          </optgroup>
          <optgroup label={t('窗口')}>
            {#if winView}<option value="win">{winView.app}{winView.title && winView.title !== winView.app ? ' · ' + winView.title : ''}</option>{/if}
            <option value="pick">{t('选择窗口…')}</option>
          </optgroup>
        </select>
      </label>
      {#if zoom > 1.01}
        <button class="h-8 flex-none rounded-lg bg-white/10 px-2 text-[12px] text-white/80 active:bg-white/20" aria-label={t('整块屏')} onclick={resetView}>{zoom.toFixed(1)}×</button>
      {/if}
      <button class={cn(bar, kbOpen && 'bg-white/20')} aria-label={t('键盘')} onclick={toggleKb}><Keyboard class="size-4.5" /></button>
      <!-- 鼠标键：点一下让下一次点击用右键，再点一下用中键，再点回左键（点完一次自动回到左键） -->
      <button class={cn(bar, 'relative', nextBtn !== 1 && 'bg-primary text-primary-foreground')} aria-label={nextBtn === 4 ? t('下一次点击是右键（再点换中键）') : nextBtn === 2 ? t('下一次点击是中键（再点换回左键）') : t('鼠标键：点一下让下一次点击变成右键')} onclick={() => (nextBtn = nextBtn === 1 ? 4 : nextBtn === 4 ? 2 : 1)}>
        <Mouse class="size-4.5" />
        {#if nextBtn !== 1}<span class="absolute -right-0.5 -bottom-0.5 rounded bg-black/70 px-0.5 text-[9px] leading-3 text-white">{nextBtn === 4 ? t('右') : t('中')}</span>{/if}
      </button>
      <button class={bar} aria-label={pad ? t('触控板模式（点一下换成直接点）') : t('直接点模式（点一下换成触控板）')} onclick={togglePad}>
        {#if pad}<MousePointer2 class="size-4.5" />{:else}<Hand class="size-4.5" />{/if}
      </button>
      <button class={cn(bar, moreOpen && 'bg-white/20')} aria-label={t('更多')} onclick={() => (moreOpen = !moreOpen)}><Ellipsis class="size-5" /></button>
    {:else}
      <span class="min-w-0 flex-1 truncate text-[13px] text-white/70">{t('Mac 的屏幕')}</span>
      <button class={cn(bar, rotated && 'bg-white/20')} aria-label={t('横过来显示')} onclick={toggleRotate}><RotateCcwSquare class="size-4.5" /></button>
    {/if}
    {#if moreOpen && (status === 'live' || status === 'loading')}
      <!-- 点面板外面收起 -->
      <button class="fixed inset-0 z-40 cursor-default" aria-label={t('收起')} onclick={() => (moreOpen = false)}></button>
      <div class="absolute top-full right-1.5 z-50 w-64 rounded-xl border border-white/10 bg-neutral-900 p-1.5 text-[13px] shadow-xl">
        <label class="flex items-center gap-2 rounded-lg px-2.5 py-2">
          <span class="flex-1 text-white/80">{t('画质')}</span>
          <select class="rounded-md bg-white/10 px-2 py-1 text-white outline-none" value={hi ? 'hi' : 'lo'} onchange={(e) => { if ((e.currentTarget.value === 'hi') !== hi) toggleHi() }}>
            <option value="lo">{t('省流（按点）')}</option>
            <option value="hi">{t('清晰（按像素，流量约 4 倍）')}</option>
          </select>
        </label>
        <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left active:bg-white/10" onclick={toggleAutoKb}>
          <Keyboard class="size-4 text-white/60" /><span class="flex-1">{t('点到输入框自动弹键盘')}</span>
          <span class={cn('h-5 w-9 rounded-full p-0.5 transition-colors', autoKb ? 'bg-primary' : 'bg-white/20')}><span class={cn('block size-4 rounded-full bg-white transition-transform', autoKb && 'translate-x-4')}></span></span>
        </button>
        <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left active:bg-white/10" onclick={() => { toggleRotate(); moreOpen = false }}>
          <RotateCcwSquare class="size-4 text-white/60" /><span class="flex-1">{t('横过来显示')}</span>{#if rotated}<span class="text-xs text-primary">{t('已开')}</span>{/if}
        </button>
        <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left active:bg-white/10" onclick={() => { resetView(); moreOpen = false }}>
          <Maximize class="size-4 text-white/60" /><span class="flex-1">{t('整块屏（取消放大）')}</span>
        </button>
        {#if winView}
          <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left active:bg-white/10" onclick={startResize}>
            <Scaling class="size-4 text-white/60" /><span class="flex-1">{t('调整窗口大小')}</span>
          </button>
          {#if displays.length > 1}
            <div class="flex items-center gap-2 px-2.5 pt-2 pb-1 text-white/80"><MonitorUp class="size-4 text-white/60" /><span class="flex-1">{t('挪到别的显示器')}</span></div>
            {@render moveChips(winView)}
          {/if}
          <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left active:bg-white/10" onclick={() => { restoreFront(); moreOpen = false }}>
            <Undo2 class="size-4 text-white/60" /><span class="flex-1">{t('切回原来的前台 app')}</span>
          </button>
        {/if}
        {#if onhide}
          <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left active:bg-white/10" onclick={() => { moreOpen = false; close() }}>
            <Unplug class="size-4 text-white/60" /><span class="flex-1">{t('断开连接')}</span>
          </button>
        {/if}
        <button class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left active:bg-white/10" onclick={lockAndLeave}>
          <Lock class="size-4 text-white/60" /><span class="flex-1">{confirmKey === 'lock' ? t('再点一次：锁屏并断开') : t('锁屏并离开')}</span>
        </button>
        <p class="px-2.5 pb-1 text-[11px] leading-snug text-white/40">{t('锁着连上的：直接断开时 Mac 保持解锁 1 小时，回来不用再输开机密码')}</p>
      </div>
    {/if}
  </div>

  <div bind:this={stage} class="relative min-h-0 flex-1 touch-none overflow-hidden">
    {#if holdMark}
      <!-- 长按已认出：松手就是右键（手指不要飘太远，飘远了会变成按住左键拖） -->
      <div class="pointer-events-none absolute z-20 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-primary bg-primary/20 text-[11px] font-semibold text-white shadow" style="left:{holdMark.x}px;top:{holdMark.y}px">{t('右键')}</div>
    {/if}
    <div bind:this={screen} class="absolute inset-0 [&>div]:!overflow-hidden"></div>
    {#if picker}
      <div bind:this={pickerEl} class="absolute inset-0 z-20 flex touch-auto flex-col bg-neutral-950 pt-2">
        <div class="flex items-center gap-2 px-3 pb-2">
          <input bind:value={query} placeholder={t('搜索 app 或窗口')} autocapitalize="off" spellcheck="false" class="h-9 min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 text-sm text-white outline-none placeholder:text-white/40" />
          <button class={bar} aria-label={t('关闭')} onclick={() => (picker = false)}><X class="size-5" /></button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] text-sm">
          <p class="pb-2 text-[11px] text-white/45">{t('只录这一个窗口，不切到前台；第一次点它时才会切到前台')}</p>
          {#if pickErr}<p class="pb-2 text-xs text-red-300">{pickErr}</p>{/if}
          {#each groups as [app, ws] (app)}
            <div class="flex items-center gap-2 pt-2 pb-1">
              <p class="min-w-0 flex-1 truncate text-[12px] font-medium text-white/60">{app}</p>
              {#if !PROTECTED.has(ws[0].bundle)}{@render quitBtns(ws[0].bundle)}{/if}
            </div>
            {#each ws as w (w.id)}
              <div class={cn('flex items-center rounded-lg', winView?.id === w.id ? 'bg-white/15' : 'bg-white/5')}>
                <button class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left active:bg-white/15" onclick={() => pickWindow(w)}>
                  <span class="min-w-0 flex-1 truncate">{w.title || t('（无标题）')}</span>
                  {#if thumb(w)}<span class="flex-none text-[11px] text-white/40">{t('台前调度收起（点了会切到前台）')}</span>
                  {:else if !w.onScreen}<span class="flex-none text-[11px] text-white/40">{t('别的桌面 / 最小化')}</span>{/if}
                </button>
                {#if displays.length > 1 && w.bundle !== 'com.apple.Spotlight'}
                  <button class={cn('grid size-9 flex-none place-items-center rounded-lg text-white/50 active:bg-white/15', movingId === w.id && 'bg-white/15 text-white')} aria-label={t('挪到别的显示器')} onclick={() => (movingId = movingId === w.id ? 0 : w.id)}><MonitorUp class="size-4" /></button>
                {/if}
                {#if w.bundle !== 'com.apple.Spotlight'}
                  <button class="grid size-9 flex-none place-items-center rounded-lg text-white/50 active:bg-white/15" aria-label={t('关闭这个窗口')} onclick={() => closeWin(w)}><X class="size-4" /></button>
                {/if}
              </div>
              {#if movingId === w.id}{@render moveChips(w)}{/if}
            {/each}
          {/each}
          {#if idle.length}
            <p class="pt-4 pb-1 text-[12px] font-medium text-white/60">{t('其它 app')}</p>
            {#each idle as a (a.bundle)}
              <div class="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                <span class="min-w-0 flex-1 truncate text-white/80">{a.name}</span>
              {#if a.running && !PROTECTED.has(a.bundle)}{@render quitBtns(a.bundle)}{/if}
                <button class={cn(chip, 'flex-none')} disabled={!!launching} onclick={() => launchApp(a)}>{launching === a.bundle ? t('打开中…') : a.running ? (a.tray ? t('唤出') : t('开个窗口')) : t('后台打开')}</button>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}
    {#if winView && winStale && status === 'live'}
      <div class="pointer-events-none absolute inset-x-0 bottom-2 z-30 mx-auto w-fit max-w-[92%] rounded-lg bg-amber-500/90 px-3 py-1.5 text-center text-xs text-black">{t('这个窗口拿不到实时画面，可能已经最小化，画面可能不会更新')}</div>
    {/if}
    {#if note}
      <div class="pointer-events-none absolute inset-x-0 top-2 z-30 mx-auto w-fit max-w-[90%] rounded-full bg-black/80 px-3 py-1.5 text-center text-xs text-white">{note}</div>
    {/if}
    <input bind:this={ghost} aria-hidden="true" tabindex="-1" class="pointer-events-none absolute top-0 left-0 size-px opacity-0" />
    {#if bubbleStyle}
      <button bind:this={bubble} class="absolute z-30 -translate-x-1/2 rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-lg" style={bubbleStyle} onclick={() => openKb()}>⌨ {t('打字')}</button>
    {/if}
    {#if resizing && winView && status === 'live'}
      <div bind:this={resizeEl} class="pointer-events-none absolute inset-0 z-30">
        <!-- 工具栏 -->
        <div class="pointer-events-auto absolute inset-x-2 top-2 flex flex-wrap items-center gap-1.5 rounded-xl bg-black/80 p-1.5 text-xs text-white">
          <span class="px-1 text-white/70">{dragPts ? `${dragPts.w}×${dragPts.h}` : winPts ? `${winPts.w}×${winPts.h}` : t('读取中…')}</span>
          <button class={chip} onclick={() => stage && sendPlace(5, stage.clientWidth, stage.clientHeight)}>{t('适合手机')}</button>
          <button class={chip} onclick={() => sendPlace(2)}>{t('占满')}</button>
          <button class={chip} onclick={() => sendPlace(3)}>{t('左半')}</button>
          <button class={chip} onclick={() => sendPlace(4)}>{t('右半')}</button>
          <button class={cn(chip, 'ml-auto bg-primary text-primary-foreground')} onclick={() => (resizing = false)}>{t('完成')}</button>
        </div>
        {#if canvasBox}
          {@const b = canvasBox}
          {#if drag}
            <div class="absolute border-2 border-dashed border-primary bg-primary/10" style="left:{b.x}px;top:{b.y}px;width:{drag.w * b.scale}px;height:{drag.h * b.scale}px"></div>
          {/if}
          {@const w = drag ? drag.w * b.scale : b.w}
          {@const h = drag ? drag.h * b.scale : b.h}
          <div role="presentation" class="pointer-events-auto absolute h-14 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary/80 shadow" style="left:{b.x + w}px;top:{b.y + h / 2}px" ontouchstart={(e) => handleDown(e, 'r')} ontouchmove={handleMove} ontouchend={handleUp} ontouchcancel={handleUp}></div>
          <div role="presentation" class="pointer-events-auto absolute h-5 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary/80 shadow" style="left:{b.x + w / 2}px;top:{b.y + h}px" ontouchstart={(e) => handleDown(e, 'b')} ontouchmove={handleMove} ontouchend={handleUp} ontouchcancel={handleUp}></div>
          <div role="presentation" class="pointer-events-auto absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow" style="left:{b.x + w}px;top:{b.y + h}px" ontouchstart={(e) => handleDown(e, 'rb')} ontouchmove={handleMove} ontouchend={handleUp} ontouchcancel={handleUp}></div>
        {/if}
      </div>
    {/if}
    {#if cursorStyle}
      <div class="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-500/50 shadow" style={cursorStyle}></div>
    {/if}
    {#if status !== 'live'}
      <div bind:this={overlay} class={cn('absolute inset-0 grid place-items-center p-6 text-center text-sm', status === 'loading' ? 'pointer-events-none bg-neutral-950/60' : 'bg-neutral-950/85')}>
        {#if status === 'login'}
          <form class="grid w-full max-w-xs gap-2.5" onsubmit={login}>
            <p class="text-white/80">{t('用 Mac 的用户名和密码登录')}</p>
            {#if needUser}
              <input bind:value={username} name="username" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder={t('用户名')} class="h-11 rounded-lg border border-white/20 bg-white/10 px-3 text-base outline-none focus:border-white/50" />
            {/if}
            <input bind:value={password} type="password" name="password" autocomplete="current-password" placeholder={t('密码')} class="h-11 rounded-lg border border-white/20 bg-white/10 px-3 text-base outline-none focus:border-white/50" />
            {#if reason}<p class="text-xs text-red-300">{reason}</p>{/if}
            <Button type="submit">{t('登录')}</Button>
          </form>
        {:else if status === 'connecting' || status === 'auth' || status === 'loading'}
          <div class="grid justify-items-center gap-3 text-white/75">
            <span class="size-7 animate-spin rounded-full border-2 border-white/25 border-t-white"></span>
            <p>{status === 'connecting' ? t('正在连接 Mac 的屏幕共享…') : status === 'auth' ? t('正在验证…') : slowLoad ? t('屏幕共享正在启动，第一次连接要多等几秒…') : t('正在加载画面…')}</p>
            {#if status === 'loading'}<p class="text-xs text-white/50">{t('已收到 {n} MB', { n: fmtMB(received) })}</p>{/if}
          </div>
        {:else}
          <div class="grid gap-3">
            <p class="text-white/80">{reason || t('已断开')}</p>
            <Button size="sm" onclick={connect}><RotateCw /> {t('重新连接')}</Button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if status === 'live'}
    {#if kbOpen}
      <LiveInput bind:input={kbInput} top={TOP_KEYS} more={MORE_KEYS} onkey={pressKey} ontext={typeText} dark safeBottom={!rotated} placeholder={t('在这里打字，直接发到 Mac')} />
    {:else}
      <p class={cn('px-3 pt-1 text-center text-[11px] text-white/45', rotated ? 'pb-1' : 'pb-[calc(env(safe-area-inset-bottom)+6px)]')}>
        {pad ? t('滑动 = 挪光标 · 轻点 = 点击 · 长按 = 右键 · 长按后拖 = 拖动 · 双指滑 = 滚动 · 双指捏 = 缩放 · 三指上滑 = 调度中心 · 三指左右滑 = 切桌面') : t('轻点 = 点击 · 长按 = 右键 · 长按后拖 = 拖动 · 单指滑 = 滚动 · 双指 = 缩放 / 平移 · 三指上滑 = 调度中心 · 三指左右滑 = 切桌面')}
      </p>
    {/if}
  {/if}
</div>
{/if}
