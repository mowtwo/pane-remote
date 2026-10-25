// 和 server.mjs 的接口一一对应
import { t, tr } from './i18n'
export type Pane = {
  pane: number | string
  backend?: 'wezterm' | 'herdr'
  terminalAgent?: { kind: string; name: string } | null
  capabilities?: { width?: boolean }
  tab: number | string
  window: number | string
  workspace: string
  title: string
  tabTitle: string
  cwd: string
  dir: string
  cols: number
  rows: number
  active: boolean
}

async function parse(r: Response) {
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

export async function postJson<T = any>(url: string, body?: unknown): Promise<T> {
  return parse(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }))
}

export async function fetchPanes(): Promise<Pane[]> {
  return parse(await fetch('api/panes', { cache: 'no-store' }))
}

export type ManageAction = 'spawn' | 'split' | 'kill' | 'title' | 'focus' | 'claude' | 'width'
export const manage = <T = any>(action: ManageAction, body: unknown) => postJson<T>(`api/pane/${action}`, body)

export type CreateTarget = { window?: number | string; dir?: string; split?: Pane; direction?: 'right' | 'bottom' }

// 某个目录下最近的 Claude 会话（新建页面「恢复会话」用）。running：还开着；pane：开在哪个 pane（不在 WezTerm 里就没有）
export type ClaudeSession = { id: string; title: string; t: number; branch: string; configDir: string; running: boolean; pane?: number | string }
export async function fetchSessions(dir: string): Promise<ClaudeSession[]> {
  return parse(await fetch(`api/sessions?dir=${encodeURIComponent(dir)}`, { cache: 'no-store' }))
}

/** 回答 agent 在手机上问的问题：answer 是选项之一；text 是自由回答（确认类问题不接受） */
export const answerAsk = (id: string, answer: string, text = '') => postJson('api/agent/answer', { id, answer, text })

export const label = (p: Pane) => p.title || (p.tabTitle && !/^\d+$/.test(p.tabTitle) ? p.tabTitle : '') || t('终端')

export const terminalAgentLabel = (p: Pane) => {
  const kind = p.terminalAgent?.kind
  return kind ? ({ claude: 'Claude Code', codex: 'Codex', 'cursor-agent': 'Cursor', cursor: 'Cursor' }[kind] || kind) : t('终端')
}
export const workspaceLabel = (p: Pane, index: number) => p.workspace && p.workspace !== 'default' && p.workspace !== String(p.window)
  ? p.workspace : p.backend === 'herdr' ? t('工作区 {n}', { n: index + 1 }) : t('窗口 {w}', { w: p.window })

// 报错 / 诊断发回服务端（pane-remote logs 里搜 client）。以前用 sendBeacon：手机连不上中转的时候发的全丢了，
// 偏偏最想知道的就是那段时间出了什么错。现在发不出去就存在本机（最多 200 条），下次连上（启动、切回前台、网络恢复、
// 任何一次发送成功）按顺序补发，带上原来的时间和 queued 标记
const QKEY = 'pr-log-queue'
const readQ = (): any[] => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]') } catch { return [] } }
const writeQ = (q: any[]) => { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-200))) } catch {} }
// 带超时：手机拿着死连接发请求时 fetch 既不成功也不失败，不设超时这条就既没发出去也没存下来
const post = (e: object) => fetch('api/log', { method: 'POST', body: JSON.stringify(e), keepalive: true, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(10000) }).then((r) => { if (!r.ok) throw new Error(String(r.status)) })
let flushing = false
export async function flushReports() {
  if (flushing) return
  flushing = true
  try {
    for (let q = readQ(); q.length; q = readQ()) {
      await post({ ...q[0], queued: true, late: Date.now() - (q[0].t || Date.now()) })
      writeQ(readQ().slice(1))
    }
  } catch {} finally { flushing = false }
}
export const pendingReports = () => readQ().length
export function report(kind: string, msg: unknown, extra: Record<string, unknown> = {}) {
  const e = { kind, msg: String(msg).slice(0, 3000), t: Date.now(), ...extra }
  post(e).then(() => { if (readQ().length) flushReports() }, () => writeQ([...readQ(), e]))
}
if (typeof window !== 'undefined') {
  addEventListener('online', () => flushReports())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flushReports() })
}

// ---------- 发送队列 ----------
// 一次只发一个请求；在途期间新按的键攒起来，下一次合并发出（快速滑动、长按方向键不会排长队）
// 文字和它后面的回车必须分两次发：合成一次的话 Claude Code 会当成粘贴，回车变换行
type Item = { pane: string; data: string; merge: boolean }
const outbox: Item[] = []
let sending = false
let onError: (msg: string) => void = () => {}
export function onSendError(fn: (msg: string) => void) { onError = fn }

// 每次尝试最多等 6 秒（正常几百毫秒）。iOS 主屏应用切后台、换网络后，在途的请求有时既不成功也不失败，一直挂着；
// 不设超时的话后面所有按键都卡在它后面，界面却照常刷新
const SEND_TIMEOUT = 6000
// 网络断了（Load failed）或超时就带同一个 rid 重发，服务端按 rid 去重，不会发两遍。
// iPhone 唤醒 / 换网络后 Tailscale 线路要十几秒才恢复，所以间隔逐渐拉长、总共试到 20 秒；
// 再不行就放弃并提示（不在网络恢复后补发：卡了很久的按键突然发出去反而危险）
const RETRY_WAIT = [300, 1000, 2000, 3000, 4000, 5000]
const SEND_WINDOW = 20000
let sendingSince = 0
let inflight: AbortController | null = null
const dropped = new WeakSet<AbortController>() // 手动重连主动放弃的请求：不报「发送超时」
let onNetFail: () => void = () => {}
/** 发送碰到网络错误时回调（画面流多半也已经失效，让它立刻重连，不用等心跳超时） */
export function onSendNetFail(fn: () => void) { onNetFail = fn }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pump() {
  if (sending || !outbox.length) return
  sending = true
  const { pane, data } = outbox.shift()!
  const rid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  let ctl: AbortController | null = null
  const started = Date.now()
  try {
    await warming // 刚切回前台：等预热请求先把断掉的连接试出来
    for (let attempt = 0; ; attempt++) {
      sendingSince = Date.now()
      ctl = new AbortController()
      inflight = ctl
      const c = ctl
      const timer = setTimeout(() => c.abort(), Math.max(1500, Math.min(SEND_TIMEOUT, started + SEND_WINDOW - Date.now())))
      try {
        const r = await fetch('api/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pane: pane, data, rid }),
          signal: c.signal,
        })
        if (!r.ok) { const err = (await r.json().catch(() => ({}))).error; onError(err ? tr(err) : t('发送失败 {status}', { status: r.status })) }
        if (attempt) report('send-retry-ok', `attempt=${attempt + 1} len=${data.length}`)
        break
      } catch (e) {
        if (dropped.has(c)) return
        const why = c.signal.aborted ? 'timeout' : (e as Error).message
        if (attempt === 0) onNetFail()
        const wait = RETRY_WAIT[attempt]
        // 中间的失败只记日志（send-retry）；整个窗口都失败了才算一次发送失败（会记成问题报告）
        if (wait == null || Date.now() + wait - started > SEND_WINDOW) {
          report('send-fail', `${why} attempt=${attempt + 1} after=${Math.round((Date.now() - started) / 1000)}s len=${data.length}`)
          onError(c.signal.aborted ? t('发送超时，这一下可能没发出去，看一眼再决定要不要重发') : tr((e as Error).message))
          break
        }
        report('send-retry', `${why} attempt=${attempt + 1} len=${data.length}`)
        await sleep(wait)
        if (dropped.has(c)) return
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    if (inflight === ctl) { inflight = null; sending = false }
    pump()
  }
}
// 切回前台的预热：后台超过 5 秒再回来，先发一个最轻的请求（最多试 3 次、6 秒内），断掉的旧连接在它身上暴露，
// 之后的按键走新连接。预热期间按的键排在后面等它（pump 里 await warming）
let warming: Promise<void> = Promise.resolve()
let hiddenAt = 0
async function warmup() {
  const end = Date.now() + 6000
  for (let i = 0; i < 3 && Date.now() < end; i++) {
    const c = new AbortController()
    const timer = setTimeout(() => c.abort(), Math.max(800, Math.min(2500, end - Date.now())))
    try { const r = await fetch('api/ping', { cache: 'no-store', signal: c.signal }); if (r.ok) return } catch {} finally { clearTimeout(timer) }
    await sleep(400)
  }
}
// iPhone 主屏应用从后台回来常常整页重新加载：加载时也预热一次
warming = warmup()
// 回到前台时，挂起期间计时器可能没跑：发现卡住的请求直接放弃，接着发后面的
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
  if (sending && Date.now() - sendingSince > SEND_TIMEOUT) inflight?.abort()
  if (hiddenAt && Date.now() - hiddenAt > 5000) warming = warmup()
})

/** 手动重连时清空发送队列：放弃卡住的请求和还没发出去的输入（卡了很久的按键突然一起发出去反而危险），返回丢掉了几个 */
export function resetSendQueue() {
  const n = outbox.length + (sending ? 1 : 0)
  outbox.length = 0
  if (inflight) { dropped.add(inflight); inflight.abort() }
  return n
}

export function sendRaw(pane: string | null, data: string, merge = true) {
  if (!pane) return
  const last = outbox[outbox.length - 1]
  if (merge && last && last.merge && last.pane === pane) last.data += data
  else outbox.push({ pane, data, merge })
  pump()
}
