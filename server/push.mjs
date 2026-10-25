// 推送通知：定时看所有 pane 最后几行，出现「等你选择/确认」的界面就给订阅过的手机发 Web Push
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import { config } from './config.mjs'
import { detect, choices, dialogSig, stripAnsi } from './prompt-detect.mjs'

const DATA = config.dataDir
const SUBS_FILE = path.join(DATA, 'subscriptions.json')
const VAPID_FILE = path.join(DATA, 'vapid.json')
const SCAN_MS = Number(process.env.SCAN_MS || 3000)
const IDLE_SECONDS = Number(process.env.NOTIFY_IDLE_SECONDS || 120) // 电脑键鼠空闲超过这么久才推（人在电脑前就不打扰手机）

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 })
let vapid
try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) } catch {
  vapid = webpush.generateVAPIDKeys()
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 })
}
webpush.setVapidDetails(config.vapidSubject, vapid.publicKey, vapid.privateKey)

const PREFS_FILE = path.join(DATA, 'prefs.json')
let prefs = { stop: true } // stop：Claude / Codex 一轮做完也推送
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } } catch {}
export const getPrefs = () => prefs
// 发现的问题（推送失败、扫描出错、事件到得太晚）交给服务端记成问题报告（incidents.mjs）
let problem = () => {}
// 电脑睡着 / 断网时 ssh 连不上：正常情况，不算问题
const offline = (m) => /Connection refused|Connection timed out|connect to host|kex_exchange|Connection closed|Connection reset|timed out|Operation timed out|No route to host|Network is unreachable|failed to connect to Socket|connecting to .*wezterm.*sock/i.test(String(m))
export function onProblem(fn) { problem = fn }
/** 电脑键鼠最近一次空闲秒数（tails 扫描时更新）：人在电脑前就不推 */
export const macIdle = () => lastIdle
export function setPrefs(p) {
  if (typeof p?.stop === 'boolean') prefs.stop = p.stop
  fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs), { mode: 0o600 })
  return prefs
}

let subs = []
try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) } catch {}
const saveSubs = () => fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), { mode: 0o600 })

export const publicKey = vapid.publicKey
export function subscribe(sub) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('bad subscription')
  subs = subs.filter((s) => s.endpoint !== sub.endpoint)
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: new Date().toISOString() })
  saveSubs()
}
export function unsubscribe(endpoint) {
  subs = subs.filter((s) => s.endpoint !== endpoint)
  saveSubs()
}
export const hasSub = (endpoint) => subs.some((s) => s.endpoint === endpoint)

// Topic（同一个 tag 的新通知替换旧的）：直接用 tag 时，长度除以 4 余 1 的（比如 incident-<12 位>，21 个字符）
// 苹果当 base64 解不开，回 400 BadWebPushTopic。改成 tag 的哈希：32 位十六进制，长度是 4 的倍数，同一个 tag 还是同一个 Topic
export const pushTopic = (tag) => (tag ? crypto.createHash('sha256').update(String(tag)).digest('hex').slice(0, 32) : undefined)
export async function notify(payload) {
  const body = JSON.stringify(payload)
  const results = await Promise.allSettled(subs.map((s) => webpush.sendNotification(s, body, { TTL: 600, urgency: 'high', topic: pushTopic(payload.tag) })))
  const gone = []
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const code = r.reason?.statusCode
      console.log(`push failed ${code || ''} ${r.reason?.body || r.reason?.message || ''}`.trim())
      if (code === 404 || code === 410) gone.push(subs[i].endpoint) // 订阅过期：正常情况，不算问题
      else problem({ component: 'push', kind: `push-${code || 'error'}`, title: '推送发不出去', msg: `push failed ${code || ''} ${String(r.reason?.body || r.reason?.message || '').slice(0, 300)}` })
    }
  })
  if (gone.length) { subs = subs.filter((s) => !gone.includes(s.endpoint)); saveSubs() }
  return { sent: results.filter((r) => r.status === 'fulfilled').length, failed: results.length - results.filter((r) => r.status === 'fulfilled').length }
}


const state = new Map() // pane → { sig, missing, hash, changedAt, seenAt, prompt, doneAt, inputAt, pushedAt }
const COOLDOWN_MS = 15000 // 同一个 pane 15 秒内只推一次（hook 和画面检测可能同时命中）
const blank = (now) => ({ sig: null, missing: 0, hash: null, changedAt: 0, seenAt: now, prompt: '', doneAt: 0, inputAt: 0, pushedAt: 0 })
/** 手机往 pane 里发了输入：清掉「已完成」 */
export function markInput(pane) {
  const st = state.get(String(pane))
  if (st) st.inputAt = Date.now()
}
const RUNNING_MS = 6000 // 最近这么久画面有变化 = 在跑
/** 所有 pane 的状态：waiting（等你操作）/ running（画面在变）/ idle，以及手机上有没有看过最新内容 */
export function states() {
  const now = Date.now()
  const out = {}
  for (const [pane, st] of state) {
    out[pane] = {
      state: st.prompt ? 'waiting' : now - st.changedAt < RUNNING_MS ? 'running' : st.doneAt > st.inputAt ? 'done' : 'idle',
      prompt: st.prompt || '',
      choices: st.prompt ? st.choices || [] : [],
      unread: st.changedAt > st.seenAt,
    }
  }
  return out
}
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }

let lastList = []
/** WezTerm 里这个 pane 的信息（标题、workspace），最近一次扫描的结果；不认识就是 undefined */
export const paneInfo = (pane) => lastList.find((p) => String(p.pane_id) === String(pane))
export const paneTitle = (pane) => cleanTitle(paneInfo(pane), pane)
let lastIdle = 1e9
const cleanTitle = (info, pane) => (info?.title || `pane ${pane}`).replace(/^[⠀-⣿✳✻✽·◐◓◑◒⠂⠐*]+\s*/, '')

/** 推送前的统一判断：有订阅、不是测试 workspace、手机没在看、人不在电脑前、冷却时间已过 */
const WAIT_WHY = new Set(['screen', 'notify', 'permission'])
async function pushFor(pane, isWatching, payload, why) {
  const st = state.get(pane)
  const info = lastList.find((p) => String(p.pane_id) === pane)
  if (!subs.length || !st) return false
  if (isWatching(pane)) { console.log(`skip ${why} pane ${pane}: viewing on phone`); return true }
  if (lastIdle < IDLE_SECONDS) return false
  // 冷却只挡同一类：「做完了」刚推过，紧跟着的「等你操作」照推（subagent 在后台跑时，主对话先停、几秒后它弹授权，
  // 以前这条被冷却吞掉，画面检测还把它记成推过了）。同一个 tag，新通知会替换旧的
  const wait = WAIT_WHY.has(why)
  if (Date.now() - st.pushedAt < COOLDOWN_MS && !(wait && !st.pushedWait)) return true
  st.pushedAt = Date.now()
  st.pushedWait = wait
  const r = await notify({ ...payload, title: `${cleanTitle(info, pane)} ${payload.title}`, pane, tag: `pane-${pane}` })
  console.log(`notify(${why}) pane ${pane}: ${payload.body} → ${JSON.stringify(r)}`)
  return true
}

// hook（电脑上的 pane-event）记下的事件：回合结束、需要操作、用户发了新输入
let eventsOffset = null
// 读到 events.jsonl 的哪里，存盘：服务重启后从这里接着读，重启那一刻写进来的问题报告、修复进度、agent 提问不会丢
// （以前重启后直接跳到文件末尾，「已修复」这类进度会被跳过）。超过 1 天的存档不用（太旧了，当没有）
const OFFSET_FILE = path.join(DATA, 'events-offset.json')
let savedOffset = null
try { const o = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')); if (Date.now() - o.at < 86400000 && Number.isInteger(o.offset)) savedOffset = o.offset } catch {}
let offsetWritten = -1
function saveOffset() {
  if (eventsOffset === offsetWritten) return
  offsetWritten = eventsOffset
  try { fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset: eventsOffset, at: Date.now() })) } catch {}
}
let lastEventsRead = 0
// pane-host 的 events 订阅生效时为 true：事件由它推（见 attachHost），扫描循环不再轮询 bridge events
let hostLive = false
/** 扫描循环最近 10 秒内读过事件，或 pane-host 正在推事件（自检据此判断该不该等 canary 事件） */
export const eventsFresh = () => hostLive || Date.now() - lastEventsRead < 10000
/** 事件现在从哪来：host（pane-host 推）/ bridge（轮询） */
export const eventsSource = () => (hostLive ? 'host' : 'bridge')
let hooks = {} // startMonitor 传进来的 bridge、isWatching、onOpen…
async function readEvents() {
  const first = eventsOffset === null
  const resume = first && savedOffset !== null
  const from = eventsOffset ?? savedOffset ?? 0
  const out = await hooks.bridge(`events ${from}`)
  if (hostLive) return // 等结果的时候 pane-host 连上了：以它为准
  const nl = out.indexOf('\n')
  const size = Number(out.slice(0, nl < 0 ? undefined : nl))
  const done = eventsOffset ?? -1
  eventsOffset = Math.max(size, eventsOffset ?? 0)
  lastEventsRead = Date.now()
  saveOffset()
  if ((first && !resume) || nl < 0) return // 第一次启动、没有存档：只记下位置
  // 位置往回退了（文件被删了重建，或者旧版 bridge 截断后从头给）：读到的是旧事件，不重放，只记下新位置
  if (size < from) { eventsOffset = size; saveOffset(); return }
  let off = from
  for (const line of out.slice(nl + 1).split('\n')) {
    off += Buffer.byteLength(line) + 1
    if (!line.trim() || off <= done) continue // 已经处理过的（pane-host 断开前推过的）跳过
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    await handleEvent(ev, resume)
  }
}

/** 处理一条事件。replayed：补读的（服务重启后、或 pane-host 重连后补发的），不算「读晚了」，太旧的不补推 */
async function handleEvent(ev, replayed) {
  const { isWatching, onOpen, onAgent, onIncident, onCanary } = hooks
  if (ev.kind === 'open') return onOpen?.(ev.msg)
  if (ev.kind === 'agent') return onAgent?.(ev)
  if (ev.kind === 'incident') return onIncident?.(ev)
  if (ev.kind === 'canary') return onCanary?.(ev.nonce)
  const nowS = Date.now() / 1000
  // 重启后补读的「做完了 / 等你操作」超过 2 分钟就不补推了（只更新状态），免得一重启就推一串旧通知
  const stale = replayed && ev.t && nowS - ev.t > 120
  // agent 的提问、问题报告这类事件该在几秒内被读到：晚了 1 分钟以上说明扫描卡住过（补读的不算）
  if (!replayed && ev.t && nowS - ev.t > 60 && (ev.kind === 'stop' || ev.kind === 'notify')) problem({ component: 'monitor', kind: 'events-late', title: '事件读得太晚', msg: `event ${ev.kind} read ${Math.round(Date.now() / 1000 - ev.t)}s late` })
  const pane = String(ev.pane)
  const st = state.get(pane) || blank(Date.now())
  state.set(pane, st)
  const t = Math.round(ev.t * 1000)
  if (ev.kind === 'prompt') { st.inputAt = t; return }
  if (ev.kind === 'stop' || ev.kind === 'failure') {
    st.doneAt = t
    if (prefs.stop && !stale) await pushFor(pane, isWatching, { title: ev.kind === 'failure' ? '出错停下了' : '做完了', body: ev.msg || '轮到你了' }, ev.kind)
  } else if (ev.kind === 'notify' && /^Elicitation response/i.test(ev.msg || '')) {
    // MCP 确认框答完之后 Claude Code 发的回执（「…: accept」），不是在等人；倒说明刚才那个框处理掉了，下一个同样的框要再推
    st.sig = null
  } else if ((ev.kind === 'notify' || ev.kind === 'permission') && !stale) {
    await pushFor(pane, isWatching, { title: '等你操作', body: ev.msg || '需要你确认' }, ev.kind)
  }
}

/**
 * 事件改由 pane-host 推（host-client.mjs）：连上就从当前偏移订阅 events 主题（序号就是 bridge events 的逻辑偏移，两条路可以互相接上），
 * 断了就回到扫描循环里的 bridge 轮询。每次连上都新订阅一次，用的是这边最新的偏移（断开期间 bridge 可能已经往前读了）
 */
export function attachHost(host) {
  let sub = null
  let queue = Promise.resolve() // 事件按顺序处理（pushFor 是异步的）
  const open = () => {
    sub?.close()
    const since = eventsOffset ?? savedOffset
    sub = host.subscribe('events', {
      since,
      onEvent: (e) => {
        queue = queue.then(async () => {
          if (e.event === 'reset') { eventsOffset = e.seq; saveOffset(); return } // 文件重建 / 截掉的补不了：从这里接着收
          if (eventsOffset !== null && e.seq <= eventsOffset) return
          eventsOffset = e.seq
          lastEventsRead = Date.now()
          saveOffset()
          await handleEvent(e.data, !!e.replay)
        }).catch((err) => console.log(`events(host): ${err.message}`))
      },
      onStatus: (up, r) => {
        if (up !== hostLive) console.log(up ? `events: via pane-host (from ${since ?? 'now'})` : 'events: back to bridge polling')
        hostLive = up
        if (up && r?.seq != null) queue = queue.then(() => { if (eventsOffset === null || r.seq > eventsOffset) { eventsOffset = r.seq; saveOffset() } })
      },
    })
  }
  host.on('up', open)
  host.on('down', () => { if (hostLive) console.log('events: back to bridge polling'); hostLive = false; sub?.close(); sub = null })
  if (host.connected) open()
}

export function startMonitor({ bridge, isWatching, active, onOpen, onAgent, onIncident, onCanary }) {
  hooks = { bridge, isWatching, onOpen, onAgent, onIncident, onCanary }
  let busy = false
  setInterval(async () => {
    // 有推送订阅、或手机最近在用（要看状态列表）才扫，不然不打扰电脑
    if (busy || (subs.length === 0 && !active())) return
    busy = true
    try {
      const out = await bridge('tails')
      const idle = Number((out.match(/^idle (\d+)/) || [])[1] ?? 1e9)
      const [head, ...chunks] = out.split('\x1e')
      const list = JSON.parse(head.replace(/^idle \d+\n/, ''))
      lastList = list
      lastIdle = idle
      const seen = new Set()
      const now = Date.now()
      for (const chunk of chunks) {
        const nl = chunk.indexOf('\n')
        const pane = chunk.slice(0, nl).trim()
        const body = chunk.slice(nl + 1)
        seen.add(pane)
        const q = detect(body)
        const st = state.get(pane) || blank(now)
        // 标题里的转圈动画不算；只比画面文字
        const h = hash(stripAnsi(body))
        if (st.hash !== null && h !== st.hash) st.changedAt = now
        st.hash = h
        st.prompt = q || ''
        st.choices = q ? choices(body) : []
        if (isWatching(pane)) st.seenAt = now
        if (q) {
          st.missing = 0
          // 指纹带上对话框正文：问题文字一样（MCP 每次都问「Run it on project …?」）但内容不同，也算新问题
          const sig = `${q}\n${dialogSig(body)}`
          if (sig !== st.sig && subs.length) {
            state.set(pane, st)
            // 人在电脑前时 pushFor 返回 false：不记下，问题一直挂着的话电脑空闲够久后再推
            if (await pushFor(pane, isWatching, { title: '等你操作', body: q }, 'screen')) st.sig = sig
          }
        } else if (st.sig && ++st.missing >= 2) {
          st.sig = null // 界面消失（已处理）后再出现新问题才会再推
        }
        state.set(pane, st)
      }
      for (const k of state.keys()) if (!seen.has(k)) state.delete(k)
      if (!hostLive) await readEvents().catch((e) => { console.log(`events: ${e.message}`); if (!offline(e.message)) problem({ component: 'monitor', kind: 'events', msg: `events: ${e.message}` }) })
    } catch (e) {
      console.log(`monitor: ${e.message}`)
      if (!offline(e.message)) problem({ component: 'monitor', kind: 'scan', msg: `monitor: ${e.message}` })
    } finally {
      busy = false
    }
  }, SCAN_MS)
}
export { detect } from "./prompt-detect.mjs"
