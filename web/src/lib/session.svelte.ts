// 当前 pane 的连接状态和画面数据。画面行数可能有几百行，放普通数组里，用回调通知终端组件重画，
// 不走 Svelte 的深度响应式。
import { fetchPanes, label, report, resetSendQueue, onSendNetFail, type Pane } from './api'
import { prefs } from './prefs.svelte'
import { t, tr } from './i18n'

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'nu', 'login', '-zsh', '-bash'])

export type ClaudeInfo = { agent: 'claude' | 'codex' | 'grok' | 'cursor-agent' | string; status?: string; session: string; transcript: string; configDir: string; cwd: string; t: number }
export type Choice = { label: string; send: string[]; selected?: boolean; ask?: { id: string; answer: string } }
/** 注入了 pane-remote 插件的 agent 用 ask_phone 在手机上问的问题；confirm = 允许 / 拒绝 型，不能自由回答 */
export type AgentAsk = { id: string; question: string; options: string[]; confirm: boolean; expires: number }
export type PaneState = { state: 'waiting' | 'running' | 'done' | 'idle'; prompt: string; choices: Choice[]; unread: boolean; asks?: AgentAsk[] }

export const ui = $state({
  panes: [] as Pane[],
  current: null as string | null,
  status: 'idle' as 'idle' | 'live' | 'err',
  statusMsg: '',
  cols: 80,
  rows: 24,
  fg: '',
  title: '',
  // 没有回滚内容（行数不超过可见行数）= 全屏程序（Claude Code fullscreen、vim、less 等）
  alt: false,
  hasFrame: false,
  /** 所有 pane 的状态（服务端每 3 秒扫一次）：waiting / running / idle，unread = 手机上还没看过最新内容 */
  states: {} as Record<string, PaneState>,
  /** 当前 pane 里登记到的 Claude 会话（pane-event hook 记下的），没有就是 null */
  claude: null as ClaudeInfo | null,
  /** 当前 pane 的 claude 查过没有（没查过时不知道该显示对话还是终端，先不急着加载终端） */
  claudeChecked: false,
  /** 前台是哪个 agent（claude / codex / cursor-agent），没有会话记录时也有：输入框同步按它的格式读 */
  agent: '' as string,
  noTranscript: '' as string, // Claude 在跑但没在保存会话记录的原因：child-session / skip-history（空 = 没问题或不知道）
})

/** 别的 pane 里有几个在等你操作 */
export const waitingElsewhere = () => Object.entries(ui.states).filter(([id, s]) => id !== ui.current && s.state === 'waiting').length

// 切 pane 时的缓存：每个 pane 上次的画面（带帧序号）和 Claude 会话信息，切回来立刻显示，再在后台更新
type FrameCache = { lines: string[]; seq: string; cols: number; rows: number; fg: string; title: string; alt: boolean }
const frames = new Map<string, FrameCache>()
const claudeCache = new Map<string, ClaudeInfo | null>()
const agentCache = new Map<string, string>()

export async function refreshClaude() {
  const pane = ui.current
  if (!pane) { ui.claude = null; return }
  try {
    const r = await fetch(`api/claude?pane=${pane}`, { cache: 'no-store' })
    const d = r.ok ? await r.json() : {}
    const info = d?.session && d.transcript ? d : null // Claude / Codex / cursor-agent 都行
    claudeCache.set(pane, info)
    agentCache.set(pane, d?.agent || '')
    if (ui.current === pane) { ui.claude = info; ui.agent = d?.agent || ''; ui.noTranscript = info ? '' : d?.noTranscript || ''; ui.claudeChecked = true }
  } catch { if (ui.current === pane) ui.claudeChecked = true }
}
setInterval(() => { if (document.visibilityState === 'visible') refreshClaude() }, 15000)

export async function pollStates() {
  if (document.visibilityState !== 'visible') return
  try {
    const r = await fetch('api/states', { cache: 'no-store' })
    if (r.ok) ui.states = await r.json()
  } catch {}
}
setInterval(pollStates, 4000)
document.addEventListener('visibilitychange', pollStates)

/** 全屏程序且前台不是 shell：滑动转滚轮、轻点转鼠标点击（shell 收到鼠标序列会当成输入） */
export const mouseMode = () => ui.alt && !!ui.fg && !SHELLS.has(ui.fg)

export const currentPane = () => ui.panes.find((p) => String(p.pane) === ui.current)
export const paneName = () => {
  const p = currentPane()
  if (ui.title) return ui.title
  return p ? label(p) : ui.current ? t('终端') : t('选择 pane')
}

export let lines: string[] = []
type FrameListener = (changed: number[] | null) => void // null = 整屏重画
const listeners = new Set<FrameListener>()
export function onFrame(fn: FrameListener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const emit = (changed: number[] | null) => { for (const fn of listeners) fn(changed) }

function updateAlt() {
  // 全屏程序没有回滚内容，get-text 正常会多出一行；WezTerm 窗口和 mux 的尺寸不同步时屏幕缓冲还会比 pty 多几行
  // （见过 38 行 / 报 36 行，也见过 40 行的 pane 拿到 44 行），没认成全屏的话滑动不转滚轮、高度也不压进屏幕。
  // 有回滚的终端动辄几百行，放宽到 +8 不会误判
  ui.alt = lines.length <= ui.rows + 8
}

export async function loadPanes() {
  ui.panes = await fetchPanes()
  return ui.panes
}

export function setStatus(kind: typeof ui.status, msg = '') {
  ui.status = kind
  ui.statusMsg = msg
}

let es: EventSource | null = null
let seq = '' // 手里这份画面对应的帧序号；重连时带给服务端，对得上就不重发整屏
let lastMsgAt = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retries = 0
// 掉线记录：从第一次发现断开算起，连续重连了几次、多久才恢复，恢复时报给服务端（journal 里 [client] stream-*）
let downSince = 0, downWhy = '', stalls = 0
function markDown(why: string) {
  if (!downSince) { downSince = Date.now(); downWhy = why; report('stream-drop', `${why} pane=${ui.current} idle=${Date.now() - lastMsgAt}ms online=${navigator.onLine}`) }
}

// 选了 pane（列表、待办、提问、新建…）：路由据此把地址切到这个 pane（在预览 / Cursor / 插件页时也会切回来）
let selectHook: (id: string) => void = () => {}
export function onSelect(fn: (id: string) => void) { selectHook = fn }

/** quiet = 只切数据、不动地址（启动时、路由自己切的时候） */
export function select(pane: string | number, opts: { quiet?: boolean } = {}) {
  const id = String(pane)
  if (!opts.quiet) selectHook(id)
  const prev = ui.current
  if (prev && prev !== id && ui.hasFrame) frames.set(prev, { lines, seq, cols: ui.cols, rows: ui.rows, fg: ui.fg, title: ui.title, alt: ui.alt })
  ui.current = id
  prefs.pane = id
  const p = currentPane()
  const cached = frames.get(id)
  if (cached) {
    // 先显示上次的画面；重连时带上帧序号，服务端那边画面没变（通道还保留着）就不重发整屏
    lines = cached.lines; seq = cached.seq
    ui.cols = cached.cols; ui.rows = cached.rows; ui.fg = cached.fg; ui.title = cached.title; ui.alt = cached.alt
    ui.hasFrame = true
  } else {
    if (p) { ui.cols = p.cols; ui.rows = p.rows }
    ui.title = ''; ui.fg = ''; ui.alt = false; ui.hasFrame = false
    lines = []; seq = ''
  }
  emit(null)
  document.title = p ? `${label(p)} · Panes` : 'Pane Remote'
  ui.claude = claudeCache.get(id) ?? null
  ui.agent = agentCache.get(id) ?? ''
  ui.noTranscript = ''
  ui.claudeChecked = claudeCache.has(id)
  refreshClaude()
  if (!paused) connect()
}

function connect() {
  es?.close()
  clearTimeout(retryTimer)
  if (!ui.current) return
  if (!ui.hasFrame) setStatus('idle', t('连接中…'))
  const since = ui.hasFrame && seq ? `&since=${seq}` : ''
  const src = new EventSource(`api/stream?pane=${encodeURIComponent(ui.current)}${since}`)
  es = src
  lastMsgAt = Date.now()
  const alive = (e: Event) => {
    lastMsgAt = Date.now()
    retries = 0
    stalls = 0
    if (downSince) { report('stream-recover', `${downWhy} after=${Date.now() - downSince}ms pane=${ui.current}`); downSince = 0 }
    const id = (e as MessageEvent).lastEventId
    if (id) seq = id
  }
  src.addEventListener('ping', alive)
  src.addEventListener('resume', (e) => { alive(e); setStatus('live', t('已连接')) })
  src.addEventListener('size', (e) => {
    alive(e)
    const d = JSON.parse((e as MessageEvent).data)
    ui.cols = d.cols
    ui.rows = d.rows
    ui.fg = d.fg || ''
    if (d.title) ui.title = d.title
    updateAlt()
  })
  src.addEventListener('full', (e) => {
    alive(e)
    setStatus('live', t('已连接'))
    lines = JSON.parse((e as MessageEvent).data).lines
    ui.hasFrame = true
    updateAlt()
    emit(null)
  })
  src.addEventListener('delta', (e) => {
    alive(e)
    if (ui.status !== 'live') setStatus('live', t('已连接'))
    const d = JSON.parse((e as MessageEvent).data)
    const grew = d.total !== lines.length
    lines.length = d.total
    for (const [i, l] of Object.entries(d.set)) lines[Number(i)] = l as string
    if (grew) { updateAlt(); emit(null) } else emit(Object.keys(d.set).map(Number))
  })
  src.addEventListener('openurl', (e) => openHandler(JSON.parse((e as MessageEvent).data).url))
  src.addEventListener('fail', (e) => setStatus('err', tr(JSON.parse((e as MessageEvent).data).message)))
  src.onerror = () => {
    setStatus('err', t('连接断开，自动重连中'))
    markDown('error')
    // 浏览器自己会按 retry 重连；只有彻底关掉（比如服务端返回错误码）时才手动重连，退避 + 随机抖动
    if (src.readyState === EventSource.CLOSED && es === src) {
      const wait = Math.min(16000, 1000 * 2 ** retries++) * (0.7 + Math.random() * 0.6)
      retryTimer = setTimeout(connect, wait)
    }
  }
}

/** 手动重连（自动重连之外的兜底）：清空卡住的发送队列，让服务端重建这个 pane 的画面通道，再拿一份完整画面 */
export async function reconnectPane() {
  const pane = ui.current
  if (!pane) return { dropped: 0, mac: '' }
  const dropped = resetSendQueue()
  setStatus('idle', t('重连中…'))
  es?.close(); es = null
  clearTimeout(retryTimer); retries = 0
  frames.delete(pane)
  seq = '' // 不带帧序号：服务端一定发整屏
  let mac = ''
  try {
    const r = await fetch('api/reconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pane: pane }), signal: AbortSignal.timeout(15000) })
    mac = (await r.json().catch(() => ({}))).mac || ''
  } catch (e) { mac = (e as Error).message }
  if (ui.current !== pane) return { dropped, mac }
  loadPanes().catch(() => {})
  refreshClaude()
  pollStates()
  if (!paused) connect()
  // 电脑那头好好的（mac ok），8 秒内画面还是没回来：问题在手机这边的连接，直接重载页面（和重开 PWA 一样的效果）
  const started = Date.now()
  if (!paused) setTimeout(() => {
    if (ui.current === pane && lastMsgAt < started && document.visibilityState === 'visible') {
      markDown('manual')
      if (!reloadPage('manual')) setStatus('err', t('还是没连上：{msg}', { msg: mac && mac !== 'ok' ? tr(mac) : t('请检查网络') }))
    }
  }, 8000)
  return { dropped, mac }
}

// 电脑要打开网页（pane-open）时，服务端经画面流发来的 open 事件
let openHandler: (url: string) => void = () => {}
export function onOpenUrl(fn: (url: string) => void) { openHandler = fn }

let paused = false
/** 暂停 / 恢复画面流（切到预览页时暂停） */
export function setPaused(v: boolean) {
  if (paused === v) return
  paused = v
  if (v) { es?.close(); es = null; clearTimeout(retryTimer) }
  else if (ui.current) connect()
}

// 假死检测：服务端每 5 秒发 ping，13 秒什么都没收到就当连接已经断了（iOS 切网络、家里路由器换了 NAT 端口时常见），主动重连
// 连续几次重连都没收到任何消息：先 ping 一下分清是哪一段断了；手机到中转是通的却一直收不到画面，
// 多半是 iOS 把新请求塞进了已经死掉的旧连接（这时只有重开应用才好），就自动重载页面，不用手动杀 PWA
let checking = false
setInterval(async () => {
  if (checking || paused || document.visibilityState !== 'visible' || !ui.current || !es || Date.now() - lastMsgAt <= 13000) return
  markDown('stall')
  stalls++
  if (stalls < 2) { setStatus('err', t('连接没有响应，重连中')); connect(); return }
  checking = true
  const ping = await pingRelay()
  checking = false
  if (Date.now() - lastMsgAt <= 13000) return
  if (!ping) { setStatus('err', t('手机连不上中转（网络或 Tailscale），重连中')); lastMsgAt = Date.now(); connect(); return }
  setStatus('err', t('中转能连上但画面没回来，重新加载页面'))
  reloadPage('stall')
}, 3000)

async function pingRelay(ms = 4000) {
  try { return (await fetch(`api/ping?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(ms) })).ok } catch { return false }
}

/** 自动重载页面：两分钟内最多一次，免得服务端真坏了时不停刷新 */
export function reloadPage(why: string): boolean {
  let last = 0
  try { last = Number(sessionStorage.getItem('pr-reload-at')) || 0 } catch {}
  if (Date.now() - last < 120000) return false
  try { sessionStorage.setItem('pr-reload-at', String(Date.now())) } catch {}
  report('auto-reload', `${why} pane=${ui.current} down=${downSince ? Date.now() - downSince : 0}ms`)
  setTimeout(() => location.reload(), 300)
  return true
}
// 发送碰到网络错误：画面流多半也断了，2 秒内没收到过消息就立刻重连
onSendNetFail(() => {
  if (!paused && ui.current && Date.now() - lastMsgAt > 2000) connect()
})

// 切到后台就断开画面流（服务端据此知道没人在看，才会推送通知），回到前台再连（带上序号，画面没变就不重发）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { es?.close(); es = null }
  else if (!paused && ui.current && (!es || es.readyState === EventSource.CLOSED)) connect()
})
window.addEventListener('online', () => { if (!paused && ui.current && document.visibilityState === 'visible') connect() })
window.addEventListener('pageshow', (e) => { if (!paused && e.persisted && ui.current) connect() })

/** want = 地址里的 pane；没有就用上次看的。返回实际选中的 pane */
export async function boot(want: string | null = prefs.pane): Promise<string | null> {
  try {
    const list = await loadPanes()
    if (!list.length) { setStatus('err', t('没有 pane')); return null }
    const keep = list.find((p) => String(p.pane) === String(want)) || list.find((p) => String(p.pane) === String(prefs.pane))
    select((keep || list.find((p) => p.active) || list[0]).pane, { quiet: true })
    return ui.current
  } catch (e) {
    setStatus('err', t('读取失败：{msg}', { msg: tr((e as Error).message) }))
    report('boot-panes', (e as Error).message)
    return null
  }
}

/** 界面上显示的 agent 名字 */
export const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', 'cursor-agent': 'Cursor' }
export const agentName = () => AGENT_NAMES[ui.claude?.agent || ui.agent || ''] ?? 'Agent'
