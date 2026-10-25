import { isPaneId, isWindowId, terminalId } from '../lib/terminal-id.mjs'
// pane-remote 服务：手机网页（PWA）的后端。只监听 127.0.0.1，由 `tailscale serve` 对 tailnet 提供 HTTPS。
// 两种部署（见 config.mjs）：
//   local  跑在电脑上，直接执行 agent/bridge
//   relay  跑在中转服务器上，经 SSH 反向隧道执行电脑上的 bridge（authorized_keys 里的 forced command）
//   GET  /api/panes              pane 列表
//   GET  /api/stream?pane=N[&since=序号]  SSE：size（列数行数）、full（全部行）、delta（只含变化的行）、resume（手里的画面已是最新）、ping
//                                每帧带递增序号（SSE id）；重连时带上 since 或 Last-Event-ID，序号对得上就不重发整屏
//   POST /api/send {pane, data, rid?}  把 data 原样发进 pane（方向键、回车等用控制序列）
//   POST /api/pane/{spawn|split|kill|title|focus}  管理：新标签页/拆分（可带启动命令，或带 resume 恢复某个 Claude 会话）、关闭、改标题、电脑上切过去
//   GET  /api/push/key、POST /api/push/subscribe|unsubscribe|status|test  推送订阅（见 push.mjs）
//   GET  /api/ping               最轻的请求：手机切回前台时预热连接
//   GET  /api/states             每个 pane 的状态：waiting / running / idle、等待的问题、有没有未读；agent 在手机上问的问题（asks）也挂在对应 pane 上
//   GET  /api/agent?pane=N        pane 里的 agent：会话、忙/闲、有没有注入 pane-remote 插件
//   GET|POST /api/agent/restart   重启并注入：POST {pane, inject?, force?} 开始（先存快照，见 agent/pane-agent），GET ?pane=N 看进度
//   GET  /api/agent/model?pane=N[&refresh] | ?cursor=会话  模型 · 思考等级：{agent, models:[{id,label,efforts}], current:{model,id,effort}, busy, global?}
//   POST /api/agent/model {pane | cursor, model, effort?}  切换（agent 空闲、输入框空着时才做，见 agent/pane-agent model-set；Cursor 会话见 agent/cursor-agent.mjs model-set，要开 Cursor 模块）；失败带 tail（画面末尾）
//   POST /api/agent/answer {id, answer, text?}  回答 agent 用 ask_phone 问的问题（交给电脑上等着的 MCP 服务）
//   GET  /api/claude?pane=N      这个 pane 里 Claude 会话的信息（会话 ID、账号、目录），没有就是 {}
//   GET  /api/transcript?pane=N  这个 pane 里 Claude 会话最近的对话消息（对话视图用）
//   GET  /api/transcript/stream?pane=N[&n=条数]  SSE：对话消息的推送（pane-host 盯着会话记录）：full {seq, messages}、delta {seq, drop, keep, tail}、ping；
//                                pane-host 不在线时回 503，断了推 down 后结束，前端回到轮询 /api/transcript
//   POST /api/reconnect {pane}     手动重连：重建这个 pane 的画面通道、清缓存；relay 模式下电脑不通时重建 ssh 共享连接
//   GET  /api/crons?pane=N[&fresh]  这个 pane 里 Claude 会话的定时任务（还在的、最近停掉的、上次结果）
//   POST /api/pane/claude {pane, mode: fork|new, where: right|bottom|tab}  分叉当前会话 / 同目录新开 Claude
//   GET  /api/ls?path=…          列目录（预览地址栏的路径提示，只允许家目录和 /tmp）
//   GET  /api/dirs               新建 pane 可选的目录：当前开着的、以前见过的、Claude 项目里的，按最近排序
//   GET  /api/sessions?dir=…     这个目录下最近的 Claude 会话（新建页面「恢复会话」用）：标题、时间、分支、是否正在运行、在哪个 pane
//   GET  /api/config             给前端的配置：新建 pane 的启动命令、开了哪些模块
//   GET|POST /api/push/prefs     推送偏好：{stop} 回合结束是否也推
//   WS   /api/preview             预览：电脑上无界面 Chrome 的画面（二进制 JPEG，前面一条 JSON 帧头）和操作通道
//   GET  /api/preview/file?id=…  预览里的下载 / 「保存当前页」存下的文件（附件），手机存到本地
//   GET|POST /api/screen/…、WS /api/screen/vnc  看屏幕模块（可选，见 screen.mjs）
//   GET|POST /api/mac/…                         mac 模块：性能、念一段话（可选，见 mac.mjs）
//   POST /api/upload?name=…      请求体是文件原始字节（最大 25MB），存到电脑的 ~/Downloads/pane-remote/，返回 {path}
//   /api/plugins*、/plugins/*、WS /api/platform/ws  插件平台（见 platform/index.mjs）
// 身份：只认 tailscale serve 注入的 Tailscale-User-Login，且必须在 allowedLogins 里；local 模式还要求 Host 是 serveHosts 之一。
import http from 'node:http'
import http2 from 'node:http2'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as push from './push.mjs'
import * as incidents from './incidents.mjs'
incidents.captureConsoleErrors() // 越早越好：启动阶段（扩展加载）的 console.error 也要抓到
import { initCursor, cursorStream, cursorCmd, cursorSummary } from './cursor.mjs'
import { createScreen } from './screen.mjs'
import { createMac } from './mac.mjs'
import { WebSocketServer } from 'ws'
import { HostClient } from './host-client.mjs'
import { apply as applyDelta } from '../host/delta.mjs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { config, APP_DIR, CONFIG_PATH } from './config.mjs'
import { startTunnelHeal } from './tunnel-heal.mjs'
import { createLease, createHostCheck, deviceName, validClient } from './lease.mjs'

const PORT = config.port
const ALLOWED = new Set(config.allowedLogins)
const LINES = Number(config.scrollbackLines) || 300
const HOME = process.env.HOME
const PUBLIC = path.join(APP_DIR, 'public') // 前端构建产物
// 系统版本：根目录 package.json 的 version 是唯一来源（前端构建时也从这里读），改动记录在 CHANGELOG.md
const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || '0.0.0' } catch { return '0.0.0' } })()
const RELAY = config.mode === 'relay'
const BRIDGE = path.join(APP_DIR, 'agent/bridge')

// relay 模式：经反向隧道 ssh 到电脑，命令由那边的 forced command（agent/bridge）执行
const SSH_ARGS = RELAY ? [
  '-F', '/dev/null',
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${HOME}/.ssh/known_hosts`,
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${HOME}/.ssh/cm-pane-remote-%C`,
  '-o', 'ControlPersist=10m',
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=15',
  '-i', config.relay.identity,
  '-p', String(config.relay.port),
  config.relay.target,
] : []
if (RELAY && !/^[\w.-]+@[\w.:-]+$/.test(config.relay.target || '')) throw new Error('relay 模式要在配置里写 relay.target（电脑上的用户名@127.0.0.1）')

// local 模式直接执行 bridge，命令放在 SSH_ORIGINAL_COMMAND 里（跟 forced command 的接口一致，bridge 不用区分两种模式）
const BRIDGE_ENV = { ...process.env, PANE_REMOTE_BRIDGE_ENV: path.join(path.dirname(CONFIG_PATH), 'bridge.env') }
function bridgeProc(command, stdio) {
  return RELAY
    ? spawn('ssh', [...SSH_ARGS, command], { stdio })
    : spawn(BRIDGE, [], { stdio, env: { ...BRIDGE_ENV, SSH_ORIGINAL_COMMAND: command } })
}
function bridge(command, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const done = (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop()))
      else resolve(stdout)
    }
    const opts = { maxBuffer: 8 << 20, timeout }
    if (RELAY) execFile('ssh', [...SSH_ARGS, command], opts, done)
    else execFile(BRIDGE, [], { ...opts, env: { ...BRIDGE_ENV, SSH_ORIGINAL_COMMAND: command } }, done)
  })
}

// pane-host（电脑上的常驻服务，见 host/）：经 bridge 的 host 指令保持一条长连接（local 模式是本机子进程，relay 模式是一条 ssh），
// 对话记录和事件优先走它（推送，不轮询），插件平台的 AI、剪贴板、只读文件也走它；不在线时对话和事件自动回到上面的 bridge 老路。
// 配置 paneHost: false 或环境变量 PANE_HOST=0 关掉。电脑上的 bridge 还是旧版（不认 host）时 5 分钟才重试一次
const host = new HostClient({
  spawn: () => bridgeProc('host', ['pipe', 'pipe', 'pipe']),
  backoffFor: (err) => (/unsupported command/.test(err) ? 300000 : null),
})
if (config.paneHost !== false && process.env.PANE_HOST !== '0') host.start()

// 见过的 pane 目录记下来（重启不丢），新建 pane 时能选回以前开过的目录
const DIRS_FILE = path.join(config.dataDir, 'dirs.json')
let seenDirs = {}
try { seenDirs = JSON.parse(fs.readFileSync(DIRS_FILE, 'utf8')) } catch {}
let dirsDirty = false
function noteDirs(list) {
  const now = Math.floor(Date.now() / 1000)
  for (const p of list) if (p.dir?.startsWith('/')) { seenDirs[p.dir] = now; dirsDirty = true }
}
setInterval(() => {
  if (!dirsDirty) return
  dirsDirty = false
  const keep = Object.entries(seenDirs).sort((a, b) => b[1] - a[1]).slice(0, 200)
  seenDirs = Object.fromEntries(keep)
  fs.writeFile(DIRS_FILE, JSON.stringify(seenDirs), { mode: 0o600 }, () => {})
}, 30000)
let macDirs = { at: 0, list: [] }
async function allDirs() {
  if (Date.now() - macDirs.at > 5 * 60000) {
    try { macDirs = { at: Date.now(), list: JSON.parse(await bridge('dirs')) } } catch (e) { console.error(`dirs: ${e.message}`) }
  }
  const now = Math.floor(Date.now() / 1000)
  const merged = {}
  const put = (d, t) => { if (d && (!merged[d] || merged[d] < t)) merged[d] = t }
  for (const x of macDirs.list) put(x.dir, x.t)
  for (const [d, t] of Object.entries(seenDirs)) put(d, t)
  for (const p of await listPanes()) put(p.dir, now + 1) // 当前开着的排最前
  return Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([dir, t]) => ({ dir, t }))
}

async function listPanes() {
  const raw = JSON.parse(await bridge('list'))
  const out = raw.map((p) => ({
    pane: p.pane_id,
    backend: p.backend || 'wezterm',
    terminalAgent: p.terminal_agent || null,
    capabilities: p.capabilities || {},
    tab: p.tab_id,
    window: p.window_id,
    workspace: p.workspace,
    title: p.title,
    tabTitle: p.tab_title,
    cwd: (p.cwd || '').replace(/^file:\/\/[^/]*/, '').replace(/^\/Users\/[^/]+/, '~'),
    dir: decodeURIComponent((p.cwd || '').replace(/^file:\/\/[^/]*/, '')),
    cols: p.size?.cols,
    rows: p.size?.rows,
    active: p.is_active,
    cursor: { x: p.cursor_x, y: p.cursor_y, visible: p.cursor_visibility === 'Visible' },
  }))
  noteDirs(out)
  return out
}

// ---------- 画面同步 ----------
// 每个有人看的 pane 开一个常驻的 bridge watch（在电脑本机轮询，有变化才发一帧），
// 这里把每行处理成自带颜色状态的独立行，和上一帧逐行比较，只把变了的行推给手机。

const SGR_RE = /\x1b\[([0-9;:]*)m/g
// 每行开头补上前面几行遗留的样式，这样任何一行都能单独重画
function normalize(frame) {
  const raw = frame.replace(/\r/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '').split('\n')
  let carry = []
  return raw.map((line) => {
    const prefix = carry.length ? `\x1b[${carry.join(';')}m` : ''
    for (const m of line.matchAll(SGR_RE)) {
      const p = m[1]
      if (p === '' || p === '0') carry = []
      else if (p.startsWith('0;')) carry = [p.slice(2)]
      else carry.push(p)
      if (carry.length > 12) carry = carry.slice(-12)
    }
    return prefix + line
  })
}

const watchers = new Map()
// /api/send 收到过的请求 id（手机重发去重），留 2 分钟
const sentRids = new Map()
setInterval(() => { const old = Date.now() - 120000; for (const [k, v] of sentRids) if (v.at < old) sentRids.delete(k) }, 30000)
function startWatcher(pane) {
  const w = { pane, clients: new Set(), lines: null, seq: 0, proc: null, buf: '', size: null, stopped: false, restartTimer: null }
  const launch = () => {
    if (w.stopped) return
    const proc = bridgeProc(`watch ${pane} ${LINES}`, ['ignore', 'pipe', 'pipe'])
    w.proc = proc
    let err = ''
    proc.stderr.on('data', (d) => { err += d })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      w.buf += chunk.replace(/\x1f/g, '')
      let i
      while ((i = w.buf.indexOf('\x1d')) >= 0) {
        const frame = w.buf.slice(0, i)
        w.buf = w.buf.slice(i + 1)
        onFrame(w, frame)
      }
    })
    proc.on('close', () => {
      w.proc = null
      w.buf = ''
      if (w.stopped) return
      broadcast(w, 'fail', { message: err.trim().split('\n').pop() || '连接中断，重连中' })
      w.restartTimer = setTimeout(launch, 1500)
    })
  }
  launch()
  refreshSize(w)
  w.sizeTimer = setInterval(() => refreshSize(w), 4000)
  return w
}
function stopWatcher(w) {
  w.stopped = true
  clearTimeout(w.restartTimer)
  clearInterval(w.sizeTimer)
  w.proc?.kill()
  watchers.delete(w.pane)
}
async function refreshSize(w) {
  try {
    const p = (await listPanes()).find((x) => String(x.pane) === w.pane)
    if (!p) return broadcast(w, 'fail', { message: 'pane 已关闭' })
    const fg = (await bridge(`fg ${w.pane}`).catch(() => '')).trim()
    const size = { cols: p.cols, rows: p.rows, title: p.title, fg }
    if (!w.size || ['cols', 'rows', 'title', 'fg'].some((k) => w.size[k] !== size[k])) {
      w.size = size
      broadcast(w, 'size', size)
    }
  } catch {}
}
function onFrame(w, frame) {
  const lines = normalize(frame)
  const prev = w.lines
  w.lines = lines
  if (!prev) return pushFrame(w, 'full', { lines })
  const set = {}
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== prev[i]) { set[i] = lines[i]; n++ }
  }
  if (n === 0 && lines.length === prev.length) return
  // 变了一大半（比如滚动了一屏）就直接发全量
  if (n > lines.length * 0.6) return pushFrame(w, 'full', { lines })
  pushFrame(w, 'delta', { total: lines.length, set })
}
function watch(pane, res, since) {
  let w = watchers.get(pane)
  const c = { res, blocked: false, dirty: false }
  if (!w) {
    w = startWatcher(pane)
    watchers.set(pane, w)
  } else {
    if (w.size) send(res, 'size', w.size)
    // 手机手里的画面就是最新一帧（切后台再回来、网络抖一下）：不重发整屏
    if (w.lines) since === String(w.seq) ? send(res, 'resume', { seq: w.seq }, w.seq) : send(res, 'full', { lines: w.lines }, w.seq)
  }
  w.clients.add(c)
  clearTimeout(w.lingerTimer)
  lingering.delete(w)
  res.on('close', () => {
    w.clients.delete(c)
    if (w.clients.size === 0) linger(w)
  })
}
// 没人看了先别关：保留 45 秒，手机切回来直接接上（不用重新建通道、重新抓整屏）。
// 最多同时保留 3 个（relay 模式下免得占满电脑 sshd 的并发会话上限，默认 10）
const lingering = new Set()
function linger(w) {
  lingering.add(w)
  w.lingerTimer = setTimeout(() => { lingering.delete(w); if (w.clients.size === 0) stopWatcher(w) }, 45000)
  while (lingering.size > 3) {
    const oldest = lingering.values().next().value
    lingering.delete(oldest)
    clearTimeout(oldest.lingerTimer)
    if (oldest.clients.size === 0) stopWatcher(oldest)
  }
}
function send(res, event, data, id) {
  return res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
// 背压：网络慢的手机写不进去时不再给它攒增量，等缓冲区排空后直接补一帧最新整屏（像 mosh 一样只同步最新状态）
function deliver(w, c, event, data, id) {
  if (c.blocked) { c.dirty = true; return }
  if (send(c.res, event, data, id)) return
  c.blocked = true
  c.res.once('drain', () => {
    c.blocked = false
    if (c.dirty && w.lines) { c.dirty = false; deliver(w, c, 'full', { lines: w.lines }, w.seq) }
  })
}
function pushFrame(w, event, data) {
  w.seq++
  for (const c of w.clients) deliver(w, c, event, data, w.seq)
}
function broadcast(w, event, data) {
  for (const c of w.clients) deliver(w, c, event, data)
}

// ---------- 手动重连 ----------
// 手机上点「重连」：自动重连之外的兜底。关掉这个 pane 的画面通道（在看的手机会自动连回来、拿到一个全新的通道），
// 清掉对话记录和定时任务缓存；relay 模式下电脑那边连不通时再把 ssh 共享连接整个重建
// 同一个 pane 5 分钟里重连超过 8 次：画面流有问题（断言 / 异常模式检测）
const reconnects = new Map()
function noteReconnect(pane, mac) {
  const t = Date.now()
  const r = [...(reconnects.get(pane) || []).filter((x) => t - x < 300000), t]
  reconnects.set(pane, r)
  if (r.length > 8) incidents.record({ source: 'server', component: 'stream', kind: 'reconnect-storm', title: '画面流频繁重连', msg: `pane ${pane} 5 分钟内重连 ${r.length} 次（mac ${mac}）`, ctx: { pane: terminalId(pane) } })
  // 手机在用、却恢复不了到电脑的连接（电脑睡着时也会这样：只按次数推，不算严重）
  if (!mac.startsWith('ok') && !mac.endsWith('→ ok')) incidents.record({ source: 'server', component: 'tunnel', kind: 'reconnect-failed', title: '到电脑的连接恢复不了', msg: `reconnect: mac ${mac}` })
}
async function reconnect(pane) {
  const w = watchers.get(pane)
  if (w) {
    clearTimeout(w.lingerTimer)
    lingering.delete(w)
    stopWatcher(w)
    for (const c of w.clients) c.res.end()
  }
  transcripts.delete(pane)
  cronCache.delete(pane)
  let mac = 'ok'
  try {
    await Promise.race([bridge('list'), sleepMs(4000).then(() => { throw new Error('timeout') })])
  } catch (e) {
    mac = `reset (${e.message})`
    if (RELAY) await new Promise((r) => execFile('ssh', [...SSH_ARGS.slice(0, -1), '-O', 'exit', SSH_ARGS.at(-1)], { timeout: 5000 }, () => r()))
    try { await bridge('list'); mac += ' → ok' } catch (e2) { mac += ` → still failing: ${e2.message}` }
  }
  console.log(`reconnect pane ${pane}: watcher ${w ? 'restarted' : 'none'}, mac ${mac}`)
  noteReconnect(pane, mac)
  return { ok: true, mac }
}

// ---------- pane 管理 ----------
// Claude 账号目录 → 启动命令（不同账号用不同的 wrapper，分叉时必须用同一个账号，不然找不到会话）
const CLAUDE_WRAPPERS = config.claudeWrappers
const claudeCommand = (configDir) => CLAUDE_WRAPPERS[path.basename(configDir || '')] || 'claude'
function agentCommand(info, mode) {
  const id = info.session
  switch (info.agent) {
    case 'claude': {
      const w = claudeCommand(info.configDir)
      return mode === 'fork' ? `${w} --resume ${id} --fork-session` : w
    }
    case 'codex': return mode === 'fork' ? `codex fork ${id}` : 'codex'
    case 'grok': return mode === 'fork' ? `grok --resume ${id} --fork-session` : 'grok'
    case 'cursor-agent': return mode === 'fork' ? '' : 'cursor-agent'
    default: return ''
  }
}
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
const isId = isPaneId
const isSessionId = (v) => typeof v === 'string' && /^[0-9a-zA-Z-]{8,64}$/.test(v)
const isDir = (v) => typeof v === 'string' && v.startsWith('/') && v.length <= 1024 && !/[\r\n]/.test(v)
const dirSessions = async (dir) => JSON.parse((await bridge(`sessions ${b64(dir)}`)) || '[]')
// 恢复某个 Claude 会话的启动命令：会话信息以电脑上查到的为准（不信前端），用它所在账号的 wrapper。
// 会话还开在别处（另一个 pane、Claude 桌面应用）时两个进程会往同一个记录里写，改成带着上下文分叉一个新会话
async function resumeCommand(dir, id) {
  const s = (await dirSessions(dir)).find((x) => x.id === id)
  if (!s) throw new Error('找不到这个会话')
  return `${claudeCommand(s.configDir)} --resume ${id}${s.running ? ' --fork-session' : ''}`
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
// 注入 pane-remote 插件：认得的 agent 命令前面加上 with-tools（agent/plugin/bin/with-tools，init 在 Mac 上链接到
// 下面这个固定位置：中转模式下服务端不知道 Mac 上仓库在哪），各家加载插件的参数由它加；别的命令原样执行
const WITH_TOOLS = '~/.local/share/pane-remote/with-tools'
// 启动命令开头可以有环境变量（多账号的 CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude）：with-tools 放在它们后面
const AGENT_CMD_RE = /^((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)(\S+)(.*)$/s
function injectCommand(cmd) {
  const m = AGENT_CMD_RE.exec(cmd)
  if (!m || !/^(claude(-[\w-]+)?|codex|cursor-agent)$/.test(m[2])) return cmd
  return `${m[1]}${WITH_TOOLS} ${m[2]}${m[3]}`
}
async function manage(action, b) {
  if (action === 'spawn' || action === 'split') {
    if (typeof b.dir !== 'string' || !b.dir.startsWith('/') || b.dir.length > 1024) throw new Error('bad dir')
    if (b.resume != null && !isSessionId(b.resume)) throw new Error('bad session')
    // 先查好恢复命令再开 pane：会话找不到时不留下一个空 pane
    let cmd = b.resume != null ? await resumeCommand(b.dir, b.resume) : typeof b.command === 'string' ? b.command.trim() : ''
    if (b.inject === true && cmd) cmd = injectCommand(cmd)
    // 开 Claude：先去掉继承来的 CLAUDE_CODE_CHILD_SESSION（WezTerm 在 Claude 里打开时会一路传下来，Claude 看到就不写会话记录）
    if (/(^|[\s/])claude(-[\w-]+)?(\s|$)/.test(cmd) && !cmd.includes(WITH_TOOLS)) cmd = `unset CLAUDE_CODE_CHILD_SESSION; ${cmd}`
    let out
    if (action === 'spawn') {
      if (b.window !== 'new' && !isWindowId(b.window)) throw new Error('bad window')
      out = await bridge(`spawn ${b.window} ${b64(b.dir)}`)
    } else {
      if (!isId(b.pane) || !['right', 'bottom', 'left', 'top'].includes(b.direction)) throw new Error('bad split')
      out = await bridge(`split ${b.pane} ${b.direction} ${b64(b.dir)}`)
    }
    const pane = out.trim()
    if (!isId(pane)) throw new Error(`unexpected: ${pane.slice(0, 80)}`)
    // 启动命令：等 shell 起来后像人一样敲进去（文字和回车分两次，跟手机发送一致）
    if (cmd) {
      if (cmd.length > 500 || /[\r\n]/.test(cmd)) throw new Error('bad command')
      await sleepMs(900)
      await bridge(`send ${pane} ${b64(cmd)}`)
      await sleepMs(60)
      await bridge(`send ${pane} ${b64('\r')}`)
    }
    return { pane: terminalId(pane) }
  }
  if (action === 'claude') {
    // 分叉当前会话（带着上下文开新会话）/ 同目录新开。各 agent 的命令不同；Claude 要用同一个账号的 wrapper 才找得到会话
    if (!isId(b.pane) || !['fork', 'new'].includes(b.mode) || !['right', 'bottom', 'tab'].includes(b.where)) throw new Error('bad request')
    const info = JSON.parse((await bridge(`session ${b.pane}`)) || '{}')
    if (!info.session && b.mode === 'fork') throw new Error('这个 pane 里还没找到会话')
    if (info.session && !isSessionId(info.session)) throw new Error('bad session')
    const command = b.inject === true ? injectCommand(agentCommand(info, b.mode)) : agentCommand(info, b.mode)
    if (!command) throw new Error(`${info.agent || '这个 agent'} 不支持分叉会话`)
    const pane = (await listPanes()).find((p) => String(p.pane) === String(b.pane))
    const dir = info.cwd || pane?.dir
    if (b.where === 'tab') return manage('spawn', { window: pane?.window ?? 'new', dir, command })
    return manage('split', { pane: b.pane, direction: b.where, dir, command })
  }
  if (!isId(b.pane)) throw new Error('bad pane')
  if (action === 'kill') { await bridge(`kill ${b.pane}`); return { ok: true } }
  if (action === 'focus') { await bridge(`focus ${b.pane}`); return { ok: true } }
  if (action === 'width') {
    // 从手机调 pane 宽度：电脑上把它拖窄了，手机上看就挤成一条
    const w = b.width === 'eq' ? 'eq' : Number(b.width)
    if (w !== 'eq' && !(Number.isInteger(w) && w >= 12 && w <= 999)) throw new Error('bad width')
    const cols = Number((await bridge(`width ${b.pane} ${w}`)).trim().split('\n').pop())
    return { cols: Number.isFinite(cols) ? cols : null }
  }
  if (action === 'title') {
    const t = typeof b.title === 'string' ? b.title.trim() : ''
    if (t.length > 80 || /[\r\n]/.test(t)) throw new Error('bad title')
    await bridge(t ? `title ${b.pane} ${b64(t)}` : `title ${b.pane}`)
    return { ok: true }
  }
  throw new Error('unknown action')
}

// ---------- 对话记录缓存 ----------
// 每个 pane 记住上次的结果和记录文件标识（路径:大小）；1.5 秒内的重复请求直接回缓存，
// 之后只让电脑比一下文件大小，没变就不重新解析（会话记录动辄几十 MB）
const transcripts = new Map() // pane → { key, n, messages, at, pending }
async function transcript(pane, n) {
  // pane-host 正推着这个 pane 的对话（手机开着对话视图）：直接用它的，不再走 bridge
  const live = liveTranscripts.get(pane)
  if (live?.messages && live.sub.live && live.n >= n) return live.n === n ? live.messages : live.messages.slice(-n)
  const c = transcripts.get(pane)
  if (c && c.n >= n && Date.now() - c.at < 1500) return c.messages
  if (c?.pending) return c.pending
  const job = (async () => {
    const known = c && c.n >= n ? ` ${b64(c.key)}` : ''
    const d = JSON.parse((await bridge(`transcript ${pane} ${n}${known}`)) || '{}')
    if (d.unchanged && c) { c.at = Date.now(); return c.messages }
    const entry = { key: d.key || '', n, messages: d.messages || [], at: Date.now(), pending: null }
    transcripts.set(pane, entry)
    return entry.messages
  })()
  if (c) c.pending = job
  try { return await job } finally { if (c) c.pending = null }
}

// ---------- 对话推送（pane-host） ----------
// 每个有人看的 pane 一份：订阅 pane-host 的 transcript:<pane>:<条数>，手里留一份全量（新连上的手机先拿全量），
// 之后的增量原样转给所有手机。最后一个手机走后 60 秒退订。pane-host 断了就结束所有推送（前端回到轮询）
const liveTranscripts = new Map() // pane → { n, messages, seq, clients: Set<res>, sub, lingerTimer }
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
function openLiveTranscript(pane, n) {
  const lt = { n, messages: null, seq: 0, clients: new Set(), sub: null, lingerTimer: null }
  const subscribe = () => {
    lt.sub?.close()
    lt.sub = host.subscribe(`transcript:${pane}:${n}`, {
      since: 0, // 从头要：先来一条 reset 全量
      onEvent: (e) => {
        if (e.event === 'reset' || e.data?.full) {
          lt.messages = e.data?.full || []
          lt.seq = e.seq
          for (const c of lt.clients) sse(c, 'full', { seq: lt.seq, messages: lt.messages })
          return
        }
        const next = lt.messages && applyDelta(lt.messages, e.data)
        if (!next) { lt.messages = null; return subscribe() } // 对不上（不该发生）：重新要全量
        lt.messages = next
        lt.seq = e.seq
        for (const c of lt.clients) sse(c, 'delta', { seq: e.seq, ...e.data })
      },
    })
  }
  subscribe()
  liveTranscripts.set(pane, lt)
  return lt
}
function closeLiveTranscript(pane, lt) {
  clearTimeout(lt.lingerTimer)
  lt.sub?.close()
  for (const c of lt.clients) { sse(c, 'down', {}); c.end() }
  if (liveTranscripts.get(pane) === lt) liveTranscripts.delete(pane)
}
host.on('down', () => { for (const [pane, lt] of liveTranscripts) closeLiveTranscript(pane, lt) })
function transcriptStream(req, res, pane, n) {
  if (!host.connected) return json(res, 503, { error: 'pane-host offline' })
  let lt = liveTranscripts.get(pane)
  if (lt && lt.n !== n) { closeLiveTranscript(pane, lt); lt = null }
  lt ??= openLiveTranscript(pane, n)
  clearTimeout(lt.lingerTimer)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  res.write('retry: 3000\n\n')
  if (lt.messages) sse(res, 'full', { seq: lt.seq, messages: lt.messages })
  lt.clients.add(res)
  const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15000)
  res.on('close', () => {
    clearInterval(ping)
    lt.clients.delete(res)
    if (!lt.clients.size) lt.lingerTimer = setTimeout(() => closeLiveTranscript(pane, lt), 60000)
  })
}

// ---------- 定时任务 ----------
// Claude 会话里的定时任务要扫整个会话记录（可能上百 MB，约 0.4 秒），10 秒内的重复请求回缓存
const cronCache = new Map() // pane → { at, data, pending }
async function crons(pane, fresh) {
  const c = cronCache.get(pane)
  if (c?.pending) return c.pending
  if (c && !fresh && Date.now() - c.at < 10000) return c.data
  const job = bridge(`crons ${pane}`).then((o) => JSON.parse(o || '{}'))
  cronCache.set(pane, { at: c?.at || 0, data: c?.data, pending: job })
  try {
    const data = await job
    cronCache.set(pane, { at: Date.now(), data, pending: null })
    return data
  } catch (e) {
    cronCache.set(pane, { at: c?.at || 0, data: c?.data, pending: null })
    throw e
  }
}

// ---------- 上传 ----------
const UPLOAD_MAX = 25 << 20
function upload(req, name) {
  return new Promise((resolve, reject) => {
    const proc = bridgeProc(`put ${b64(name)}`, ['pipe', 'pipe', 'pipe'])
    let out = '', err = '', size = 0, done = false
    const finish = (fn, v) => { if (!done) { done = true; fn(v) } }
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('close', (code) => code === 0 ? finish(resolve, out.trim()) : finish(reject, new Error((err.trim().split('\n').pop() || `exit ${code}`).replace(/^error: /, ''))))
    req.on('data', (c) => {
      size += c.length
      if (size > UPLOAD_MAX) { finish(reject, new Error('文件超过 25MB')); proc.kill(); req.destroy() }
    })
    req.pipe(proc.stdin)
  })
}

// ---------- 手机在看时别让电脑睡着 ----------
let lastApi = 0
// 同时告诉电脑「手机在用」：电脑上要打开网址时（pane-open），据此改在手机的预览面板里打开
// 有手机正连着的画面流（保留中、没人看的不算）
const viewing = () => [...watchers.values()].some((w) => w.clients.size > 0)
function phoneInUse() { return viewing() || !!previews.chrome.client || !!previews.cursor.client || Date.now() - lastApi < 120000 }
setInterval(() => {
  if (phoneInUse()) bridge('awake').catch((e) => console.error(`awake: ${e.message}`))
}, 60000)

// ---------- 预览 ----------
// 每个来源一个 preview 代理（ssh 常驻）：chrome = 电脑上自己的无界面 Chrome；cursor = 接管 Cursor IDE 的内置浏览器。
// 同一来源同一时间只服务一个手机连接，新连接顶掉旧的。手机断开 60 秒后关掉代理（停推流）；
// chrome 来源 20 分钟没人用再把预览用的 Chrome 关掉省内存（cursor 来源不关任何东西，那是用户自己的 Cursor）。
const PREVIEW_IN = new Set(['refresh', 'open', 'viewport', 'tap', 'hover', 'scroll', 'text', 'key', 'back', 'forward', 'reload', 'ack', 'tabs', 'switch', 'close', 'new', 'save'])
function makePreview(source, command) {
  const pv = { source, proc: null, client: null, buf: '', idleTimer: null, gcTimer: null, last: {} }
  // 预览用的 Chrome 脱离服务单独跑，没人看 20 分钟后关掉。服务刚起来时也排上一次：上一个服务进程排的回收
  // 随它一起没了（重启、崩溃），不排的话那个 Chrome 会一直挂着，直到下次有人用完预览
  const gcLater = () => {
    if (source !== 'chrome') return
    clearTimeout(pv.gcTimer)
    pv.gcTimer = setTimeout(() => bridge('preview-stop').then((o) => console.log(`preview gc: ${o.trim()}`), () => {}), 20 * 60000)
  }
  pv.start = () => {
    if (pv.proc) return
    const proc = bridgeProc(command, ['pipe', 'pipe', 'pipe'])
    pv.proc = proc
    pv.buf = ''
    let err = ''
    proc.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000) })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      pv.buf += chunk
      let i
      while ((i = pv.buf.indexOf('\n')) >= 0) {
        const line = pv.buf.slice(0, i)
        pv.buf = pv.buf.slice(i + 1)
        let m
        try { m = JSON.parse(line) } catch { continue }
        const c = pv.client
        if (m.t === 'frame') {
          if (c?.readyState === 1) {
            c.send(JSON.stringify({ t: 'frame', seq: m.seq, w: m.w, h: m.h, desktop: !!m.desktop }))
            c.send(Buffer.from(m.data, 'base64'))
          } else proc.stdin.write(JSON.stringify({ t: 'ack', seq: m.seq }) + '\n') // 没人看也要 ack，免得卡住
          continue
        }
        if (m.t === 'nav' || m.t === 'tabs') pv.last[m.t] = m // 新连上的手机先拿到当前地址和标签页
        if (c?.readyState === 1) c.send(line)
      }
    })
    proc.on('close', (code) => {
      if (pv.proc === proc) pv.proc = null
      const msg = err.trim().split('\n').filter((l) => !l.startsWith('[preview]')).pop()
      if (pv.client?.readyState === 1) pv.client.send(JSON.stringify({ t: 'closed', msg: code ? msg || `预览代理退出（${code}）` : '' }))
    })
  }
  pv.send = (m) => { if (pv.proc) pv.proc.stdin.write(JSON.stringify(m) + '\n') }
  pv.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 << 10 })
  pv.wss.on('connection', (ws) => {
    clearTimeout(pv.idleTimer)
    clearTimeout(pv.gcTimer)
    if (pv.client && pv.client !== ws) { try { pv.client.close(4000, '另一台设备打开了预览') } catch {} }
    pv.client = ws
    pv.start()
    for (const m of Object.values(pv.last)) ws.send(JSON.stringify(m))
    pv.send({ t: 'refresh' }) // 上一个手机可能有一帧没 ack 就断了：让代理马上补一帧给新手机
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let m
      try { m = JSON.parse(String(data)) } catch { return }
      if (!PREVIEW_IN.has(m?.t)) return
      lastApi = Date.now()
      pv.send(m)
    })
    ws.on('close', () => {
      if (pv.client !== ws) return
      pv.client = null
      pv.idleTimer = setTimeout(() => { pv.proc?.stdin.end(); pv.last = {} }, 60000)
      gcLater()
    })
  })
  gcLater()
  return pv
}
const previews = { chrome: makePreview('chrome', 'preview'), cursor: makePreview('cursor', 'preview-cursor') }

// 预览里的下载 → 手机：bridge 的 preview-get 先回一行 JSON（name、size），后面是文件内容，原样转给手机（附件）
const DL_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', zip: 'application/zip', json: 'application/json', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', html: 'text/html; charset=utf-8' }
function previewFile(req, res, id) {
  const proc = bridgeProc(`preview-get ${id}`, ['ignore', 'pipe', 'pipe'])
  let head = Buffer.alloc(0), started = false, err = ''
  proc.stderr.on('data', (d) => { err += d })
  proc.stdout.on('data', (chunk) => {
    if (started) return
    head = Buffer.concat([head, chunk])
    const i = head.indexOf(10)
    if (i < 0) { if (head.length > 4096) proc.kill(); return }
    started = true
    let meta
    try { meta = JSON.parse(head.subarray(0, i).toString('utf8')) } catch { proc.kill(); return json(res, 502, { error: 'bad header' }) }
    const name = String(meta.name || 'download')
    const ext = name.toLowerCase().split('.').pop()
    res.writeHead(200, {
      'content-type': DL_TYPES[ext] || 'application/octet-stream',
      'content-length': meta.size,
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.write(head.subarray(i + 1))
    proc.stdout.pipe(res)
  })
  proc.on('close', (code) => {
    if (!started && !res.headersSent) json(res, code ? 404 : 502, { error: (err.trim().split('\n').pop() || `exit ${code}`).replace(/^error: /, '') })
    else if (code) res.destroy() // 传到一半断了：别让手机以为文件是完整的
  })
  res.on('close', () => { if (proc.exitCode == null) proc.kill() })
}
const preview = previews.chrome
const previewSend = preview.send

const gzCache = new Map()
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

// 对话记录动辄几百 KB、手机每 2 秒拉一次：没变就回 304，变了也 gzip 再发（VPS 出口只有约 0.48MB/s，
// 以前长会话一直全量重发，把同一条线路上的画面流和输入都挤卡了）。消息数组没变时对象不变，按它缓存
const transcriptBodies = new WeakMap()
function sendTranscript(req, res, messages) {
  let b = transcriptBodies.get(messages)
  if (!b) {
    const raw = Buffer.from(JSON.stringify(messages))
    b = { raw, gz: zlib.gzipSync(raw, { level: 6 }), etag: `"${crypto.createHash('sha1').update(raw).digest('base64url')}"` }
    transcriptBodies.set(messages, b)
  }
  const head = { 'content-type': 'application/json', 'cache-control': 'no-store', etag: b.etag }
  if (req.headers['if-none-match'] === b.etag) { res.writeHead(304, head); return res.end() }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(200, { ...head, 'content-encoding': 'gzip', 'content-length': b.gz.length, vary: 'accept-encoding' })
    return res.end(b.gz)
  }
  res.writeHead(200, { ...head, 'content-length': b.raw.length })
  res.end(b.raw)
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 64 << 10) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 身份校验：tailscale serve 会把访问者的 Tailscale 登录名放进 Tailscale-User-Login（访问者带不进这个头，serve 会覆盖）。
// local 模式下服务和别的程序在同一台电脑上，再校验 Host 必须是 tailscale serve 的主机名：
// 挡住电脑上浏览器里的网页借 localhost / DNS 重绑定来调接口（这类请求的 Host 不会是 xxx.ts.net）
const SERVE_HOSTS = new Set(config.serveHosts.map((h) => h.toLowerCase()))
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin) { try { return new URL(origin).host === req.headers.host } catch { return false } }
  return req.headers['sec-fetch-site'] === 'same-origin'
}
function authorized(req) {
  const login = req.headers['tailscale-user-login']
  if (!login || !ALLOWED.has(login)) return false
  if (RELAY) return true
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
  return SERVE_HOSTS.has(host)
}

// ---------- 插件平台（platform/，可选模块 plugins，默认开）：依赖是 npm 上的 @whatevertools/*（install.sh 装），没装就只是没有插件功能 ----------
let platform = null
// 插件的 platform.sessions：在跑 agent 的 pane（pane 列表 + 每个 pane 的 agent inspect，5 秒缓存）、往 pane 里发一段话
let sessionsCache = null
const agentSessions = {
  async list() {
    if (sessionsCache && Date.now() - sessionsCache.t < 5000) return sessionsCache.p
    const p = (async () => {
      const panes = (await listPanes()).filter((x) => x.workspace !== 'pane-remote-test')
      const infos = await Promise.all(panes.map(async (x) => { try { return { x, a: JSON.parse((await bridge(`agent inspect ${x.pane}`)) || '{}') } } catch { return null } }))
      return infos.filter((i) => i?.a?.agent).map(({ x, a }) => ({
        pane: x.pane, agent: a.agent, session: a.session || null, cwd: a.cwd || x.dir || '', title: x.title || '', status: a.status || '', configDir: a.configDir || null,
        startedAt: a.startedAt ? Math.round(a.startedAt * 1000) : null,
      }))
    })()
    sessionsCache = { t: Date.now(), p }
    p.catch(() => { sessionsCache = null })
    return p
  },
  // 多行按粘贴发（和输入框一样），停一下再回车：Claude Code 正忙时会排进队列
  async send(pane, text) {
    const b64 = (t) => Buffer.from(t, 'utf8').toString('base64')
    await bridge(`send ${pane} ${b64(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text)}`)
    await new Promise((r) => setTimeout(r, 150))
    await bridge(`send ${pane} ${b64('\r')}`)
    push.markInput(String(pane))
    sessionsCache = null
  },
}
if (config.modules.plugins !== false) try {
  const { createPlatform } = await import('../platform/index.mjs')
  platform = createPlatform({
    dataDir: config.dataDir,
    pluginsDir: process.env.PLUGINS_DIR || path.join(APP_DIR, 'plugins'),
    WebSocketServer,
    notify: (p) => push.notify(p).then((r) => { console.log(`notify(plugin) ${p.plugin} → ${JSON.stringify(r)}`); return r }),
    recordIncident: (r) => incidents.record(r),
    host, // AI、电脑剪贴板 / 打开网址、只读文件走 pane-host
    version: APP_VERSION,
    sessions: agentSessions,
  })
} catch (e) { console.log(`plugins: platform disabled (${e.message})`) }

// 反向通道：pane-host 连上就开一条 relay.serve 流，电脑上的本机程序（agent 的 MCP）经它请服务端办事——
// 现在是插件工具（plugins.tools.list / plugins.tools.call，见 platform/tools.mjs）和给会话的留言（sessions.notes.take）。流里带 rid 的片段是请求，s.reply 回结果。
// local 和 relay 两种模式一样：都是 pane-host 的这条连接
let relayServe = null
function openRelayServe() {
  relayServe?.cancel()
  if (!platform) return
  const s = host.stream('relay.serve', {}, (c) => {
    if (c?.rid == null) return
    Promise.resolve().then(() => {
      if (c.op === 'plugins.tools.list') return { tools: platform.agentTools.list() }
      if (c.op === 'plugins.tools.call') return platform.agentTools.call({ name: String(c.name || ''), args: c.args, caller: c.caller })
      if (c.op === 'sessions.notes.take') return { notes: platform.takeSessionNotes(c.session) }
      throw Object.assign(new Error(`unknown op ${c.op}`), { code: 'EBADOP' })
    }).then((value) => s.reply(c.rid, { ok: true, value }), (e) => {
      if (!e.code) console.log(`relay.serve ${c.op}: ${e.message}`)
      s.reply(c.rid, { ok: false, error: { message: String(e.message || e).slice(0, 4000), code: typeof e.code === 'string' ? e.code : undefined } })
    })
  })
  relayServe = s
  // ignore: 断线时流跟着结束（重连后 up 再开）；旧版 pane-host 没有 relay.serve，插件工具就用不了
  s.done.catch((e) => { if (e.code === -32601) console.log('relay.serve: pane-host 太旧，插件工具不可用') })
}
host.on('up', openRelayServe)
if (host.connected) openRelayServe()
// 插件工具列表变了（插件装上 / 改了 / 删掉、权限改成禁止）：告诉 pane-host，它再推给订阅着的 agent MCP，agent 马上看到。每 5 秒比一次
let toolsSig = ''
setInterval(() => {
  if (!platform || !host.connected) return
  let sig
  try { sig = crypto.createHash('sha1').update(JSON.stringify(platform.agentTools.list())).digest('hex').slice(0, 16) } catch { return }
  if (sig === toolsSig) return
  const first = !toolsSig
  toolsSig = sig
  if (!first) host.call('plugins.tools.changed', { sig }).catch(() => { toolsSig = '' }) // 没送到：下次再送
}, 5000).unref()

async function onRequest(req, res) {
  if (!authorized(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('forbidden')
  }
  const url = new URL(req.url, 'http://x')
  if (url.pathname.includes('/api/')) lastApi = Date.now()
  // 插件 iframe（sandbox 没有 allow-same-origin）发的请求 Origin 是 null：插件只能经前端的 postMessage 调平台，不许直接碰任何接口
  if (req.headers.origin === 'null' && url.pathname.includes('/api/')) return json(res, 403, { error: 'bad origin' })
  // 所有会改东西的请求（非 GET）都必须来自本站页面：挡住别的网页借浏览器里的登录身份发表单 / 跨站请求
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'bad origin' })
  if (url.pathname.startsWith('/api/')) {
    const local = hostCheck.isHost(req)
    const client = clientOf(req, url)
    if (url.pathname === '/api/lease' && req.method === 'GET') return json(res, 200, { local, active: !!client && lease.isHolder(client), ...lease.info() })
    if (url.pathname === '/api/claim' && req.method === 'POST') {
      if (local) return json(res, 403, { error: 'local-host' })
      if (!client) return json(res, 400, { error: 'bad client' })
      return json(res, 200, { ok: true, ...lease.claim(client, deviceName(req, req.paneNode)) })
    }
    if (!LEASE_FREE.has(url.pathname)) {
      if (local) return json(res, 403, { error: 'local-host' })
      if (client && !lease.isHolder(client)) {
        // SSE（EventSource 读不到状态码）：发一条 kicked 事件再关
        if (String(req.headers.accept || '').includes('text/event-stream')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
          return res.end(`retry: 3600000\nevent: kicked\ndata: ${JSON.stringify(lease.info())}\n\n`)
        }
        return json(res, 409, { error: 'kicked', ...lease.info() })
      }
      // 在用的客户端开着的 SSE：被顶时发 kicked 再断
      if (client && String(req.headers.accept || '').includes('text/event-stream')) {
        const untrack = lease.track(client, (i) => { if (!res.writableEnded) { res.write(`event: kicked\ndata: ${JSON.stringify(i)}\n\n`); res.end() } })
        res.on('close', untrack)
      }
    }
  }
  try {
    if (url.pathname === '/api/version' && req.method === 'GET') return json(res, 200, { version: APP_VERSION, plugin_api: platform?.apiVersion || null })
    if (url.pathname === '/api/changelog' && req.method === 'GET') {
      let md = ''
      try { md = fs.readFileSync(path.join(APP_DIR, 'CHANGELOG.md'), 'utf8') } catch { return json(res, 404, { error: 'no changelog' }) }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' })
      return res.end(md)
    }
    // 插件平台（可选模块 plugins，默认开）：插件列表、插件自己的文件
    if (platform && (url.pathname.startsWith('/plugins/') || url.pathname.startsWith('/api/plugins'))) {
      if (await platform.handle(req, res, url, async () => JSON.parse((await readBody(req, 64 << 10)) || '{}'))) return
    }
    // Cursor 模块（可选，pane-remote enable cursor）：映射 Cursor IDE 的会话
    if (url.pathname.startsWith('/api/cursor/')) {
      if (url.pathname === '/api/cursor/summary') return json(res, 200, config.modules.cursor ? cursorSummary() : { conn: 'disabled', waiting: [], unread: 0 })
      if (!config.modules.cursor) return json(res, 404, { error: 'Cursor 模块没开（pane-remote enable cursor）' })
      if (url.pathname === '/api/cursor/stream' && req.method === 'GET') return cursorStream(req, res, url)
      if (url.pathname === '/api/cursor/cmd' && req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
        return json(res, 200, await cursorCmd(JSON.parse((await readBody(req, 64 << 10)) || '{}')))
      }
    }
    // 看屏幕模块（可选，macOS，pane-remote enable screen）：手机上看 / 操作电脑屏幕
    if (url.pathname.startsWith('/api/screen/')) {
      if (!config.modules.screen) return json(res, 404, { error: '看屏幕模块没开（pane-remote enable screen）' })
      let body = {}
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
        body = JSON.parse((await readBody(req, 4 << 10)) || '{}')
      }
      try { return json(res, 200, await screen.http(req.method, url.pathname.slice('/api/screen/'.length), body)) } catch (e) { return json(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }) }
    }
    // mac 模块（可选，macOS，pane-remote enable mac）：这台电脑的性能、用 say 念一段话
    if (url.pathname.startsWith('/api/mac/')) {
      if (!config.modules.mac) return json(res, 404, { error: 'mac 模块没开（pane-remote enable mac）' })
      let body = {}
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
        body = JSON.parse((await readBody(req, 16 << 10)) || '{}')
      }
      try { return json(res, 200, await macApi.http(req.method, url.pathname.slice('/api/mac/'.length), body)) } catch (e) { return json(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }) }
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, { presets: config.presets, modules: config.modules })
    }
    if (url.pathname === '/api/panes' && req.method === 'GET') {
      return json(res, 200, await listPanes())
    }
    if (url.pathname === '/api/stream' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      if (!isPaneId(pane)) return json(res, 400, { error: 'bad pane' })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      // 重连间隔带点随机，几台设备不会同时砸过来
      res.write(`retry: ${1500 + Math.floor(Math.random() * 1500)}\n\n`)
      // 具名 ping 事件：前端据此判断连接是不是假死（注释行 JS 收不到）
      // 5 秒一次：手机网络换了出口（路由器 NAT 端口变了）后旧连接会悄悄失效，要尽快发现
      const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 5000)
      res.on('close', () => clearInterval(ping))
      return watch(pane, res, url.searchParams.get('since') || req.headers['last-event-id'] || null)
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
      // 只接受同源 JSON，挡住跨站表单
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
      const origin = req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'bad origin' })
      const { pane, data, rid } = JSON.parse(await readBody(req))
      if (!isPaneId(pane) || typeof data !== 'string' || !data) return json(res, 400, { error: 'bad request' })
      // 手机网络抖动时会带同一个 rid 重发：已经收到过的不再发进 pane，等第一次的结果
      const key = typeof rid === 'string' && /^[\w-]{8,40}$/.test(rid) ? rid : null
      if (key && sentRids.has(key)) { await sentRids.get(key).p.catch(() => {}); return json(res, 200, { ok: true, dup: true }) }
      const p = bridge(`send ${pane} ${Buffer.from(data, 'utf8').toString('base64')}`)
      if (key) { sentRids.set(key, { p, at: Date.now() }); p.catch(() => sentRids.delete(key)) }
      await p
      if (/\r|^[0-9yn]$/.test(data)) push.markInput(pane) // 回车或回答提示：清掉「已完成」
      return json(res, 200, { ok: true })
    }
    if (url.pathname.startsWith('/api/pane/') && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
      const origin = req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'bad origin' })
      const b = JSON.parse((await readBody(req, 16 << 10)) || '{}')
      return json(res, 200, await manage(url.pathname.slice('/api/pane/'.length), b))
    }
    if (url.pathname === '/api/claude' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      if (!isPaneId(pane)) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, JSON.parse((await bridge(`session ${pane}`)) || '{}'))
    }
    if (url.pathname === '/api/transcript' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      const n = Math.min(200, Number(url.searchParams.get('n')) || 60)
      if (!isPaneId(pane)) return json(res, 400, { error: 'bad pane' })
      return sendTranscript(req, res, await transcript(pane, n))
    }
    if (url.pathname === '/api/transcript/stream' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      const n = Math.min(200, Number(url.searchParams.get('n')) || 60)
      if (!isPaneId(pane)) return json(res, 400, { error: 'bad pane' })
      return transcriptStream(req, res, pane, n)
    }
    if (url.pathname === '/api/reconnect' && req.method === 'POST') {
      const { pane } = JSON.parse((await readBody(req, 1024)) || '{}')
      if (!isPaneId(pane)) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, await reconnect(String(pane)))
    }
    if (url.pathname === '/api/crons' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      if (!isPaneId(pane)) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, await crons(pane, url.searchParams.has('fresh')))
    }
    if (url.pathname === '/api/ls' && req.method === 'GET') {
      const p = (url.searchParams.get('path') || '').slice(0, 1000)
      if (!/^[~/]/.test(p)) return json(res, 400, { error: 'bad path' })
      return json(res, 200, JSON.parse((await bridge(`ls ${b64(p)}`)) || '[]'))
    }
    if (url.pathname === '/api/dirs' && req.method === 'GET') return json(res, 200, await allDirs())
    if (url.pathname === '/api/preview/file' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      if (!/^[0-9a-f]{32}$/.test(id)) return json(res, 400, { error: 'bad id' })
      return previewFile(req, res, id)
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const dir = url.searchParams.get('dir')
      if (!isDir(dir)) return json(res, 400, { error: 'bad dir' })
      return json(res, 200, await dirSessions(dir))
    }
    if (url.pathname === '/api/states' && req.method === 'GET') {
      return json(res, 200, withAsks(push.states(), url.searchParams.has('test')))
    }
    if (url.pathname === '/api/incidents' || url.pathname.startsWith('/api/incidents/')) {
      const sub = url.pathname.slice('/api/incidents'.length).replace(/^\//, '')
      const b = req.method === 'POST' ? JSON.parse((await readBody(req, 16 << 10)) || '{}') : {}
      try { return json(res, 200, await incidents.api(req.method, sub, b, url.searchParams)) } catch (e) { return json(res, e.message === 'not found' ? 404 : 400, { error: e.message }) }
    }
    if (url.pathname === '/api/agent' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      if (!isId(pane)) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, JSON.parse((await bridge(`agent inspect ${pane}`)) || '{}'))
    }
    if (url.pathname === '/api/agent/restart' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      if (!isId(pane)) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, JSON.parse((await bridge(`agent restart-status ${pane}`)) || '{}'))
    }
    if (url.pathname === '/api/agent/restart' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 4 << 10)) || '{}')
      if (!isId(b.pane)) return json(res, 400, { error: 'bad pane' })
      // 必须显式确认（手机上点两次才发 confirm: true），误发的请求不会重启任何会话
      if (b.confirm !== true) return json(res, 400, { error: 'need confirm' })
      // 用这个会话所在账号的 wrapper 重新打开（不同账号的会话只有同一个 wrapper 找得到）
      const info = JSON.parse((await bridge(`agent inspect ${b.pane}`)) || '{}')
      if (!['claude', 'codex', 'cursor-agent'].includes(info.agent) || !info.session) return json(res, 400, { error: '这个 pane 里没有认得的 agent 会话' })
      if (info.status !== 'idle' && b.force !== true) return json(res, 409, { error: 'agent 正在干活，等这一轮停下再重启' })
      const opts = { wrapper: claudeCommand(info.configDir), inject: b.inject !== false, force: b.force === true }
      await bridge(`agent restart ${b.pane} ${b64(JSON.stringify(opts))}`)
      console.log(`agent restart pane ${b.pane} inject=${opts.inject}`)
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/api/agent/model' && req.method === 'GET') {
      const cursor = url.searchParams.get('cursor')
      if (cursor) {
        if (!config.modules.cursor) return json(res, 404, { error: 'Cursor 模块没开（pane-remote enable cursor）' })
        if (!/^[0-9a-f-]{8,64}$/i.test(cursor)) return json(res, 400, { error: 'bad cursor' })
        const r = await cursorCmd({ t: 'model', id: cursor })
        return r.ok ? json(res, 200, r.data || {}) : json(res, 502, { error: r.error || '电脑那边没有回应' })
      }
      const pane = url.searchParams.get('pane')
      if (!isId(pane)) return json(res, 400, { error: 'bad pane' })
      // Claude 第一次要把选择器翻一遍（十几秒），之后读缓存
      return json(res, 200, JSON.parse((await bridge(`agent model ${pane}${url.searchParams.has('refresh') ? ' refresh' : ''}`, 40000)) || '{}'))
    }
    if (url.pathname === '/api/agent/model' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 4 << 10)) || '{}')
      if (b.cursor != null && !/^[0-9a-f-]{8,64}$/i.test(String(b.cursor))) return json(res, 400, { error: 'bad cursor' })
      if (!b.cursor && !isId(b.pane)) return json(res, 400, { error: 'bad pane' })
      if (typeof b.model !== 'string' || !/^[\w .()[\]:@/+-]{1,80}$/.test(b.model)) return json(res, 400, { error: 'bad model' })
      const effort = b.effort == null ? '' : String(b.effort)
      if (effort && !/^[a-z]{1,12}$/.test(effort)) return json(res, 400, { error: 'bad effort' })
      // Cursor IDE 会话：电脑那边打开会话、操作输入框下方的模型选择器，再读回确认
      if (b.cursor) {
        if (!config.modules.cursor) return json(res, 404, { error: 'Cursor 模块没开（pane-remote enable cursor）' })
        const r = await cursorCmd({ t: 'model-set', id: String(b.cursor), model: b.model, effort })
        if (!r.ok) return json(res, /正在生成|正在切换/.test(r.error || '') ? 409 : 400, { error: r.error || '切换失败' })
        console.log(`cursor model ${String(b.cursor).slice(0, 8)} → ${b.model}${effort ? ` @${effort}` : ''}`)
        return json(res, 200, { ok: true, ...(r.data || {}) })
      }
      const r = JSON.parse((await bridge(`agent model-set ${b.pane} ${b64(JSON.stringify({ model: b.model, effort }))}`, 40000)) || '{}')
      if (!r.ok) return json(res, /正在干活|正在切换/.test(r.error || '') ? 409 : 400, { error: r.error || '切换失败', tail: r.tail || '' })
      console.log(`agent model pane ${b.pane} → ${b.model}${effort ? ` @${effort}` : ''}`)
      return json(res, 200, r)
    }
    if (url.pathname === '/api/agent/answer' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 8 << 10)) || '{}')
      return json(res, 200, await answerAsk(b))
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const name = (url.searchParams.get('name') || 'file').slice(0, 200)
      return json(res, 200, { path: await upload(req, name) })
    }
    if (url.pathname === '/api/push/prefs' && req.method === 'GET') return json(res, 200, push.getPrefs())
    if (url.pathname === '/api/push/key' && req.method === 'GET') {
      return json(res, 200, { key: push.publicKey })
    }
    if (url.pathname.startsWith('/api/push/') && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
      const body = JSON.parse((await readBody(req, 16 << 10)) || '{}')
      const action = url.pathname.slice('/api/push/'.length)
      if (action === 'subscribe') { push.subscribe(body.subscription); return json(res, 200, { ok: true }) }
      if (action === 'unsubscribe') { push.unsubscribe(body.endpoint); return json(res, 200, { ok: true }) }
      if (action === 'status') return json(res, 200, { subscribed: push.hasSub(body.endpoint) })
      if (action === 'prefs') return json(res, 200, push.setPrefs(body))
      if (action === 'test') return json(res, 200, await push.notify({ title: 'Pane Remote', body: '测试通知：能看到这条说明推送通了', tag: 'test' }))
      return json(res, 404, { error: 'not found' })
    }
    // 手机切回前台时先打一下：iOS 唤醒后旧连接常常已经断了，让它先暴露出来，不让你按的第一个键去试错
    if (url.pathname === '/api/ping') return json(res, 200, { ok: 1 })
    if (url.pathname === '/api/log' && req.method === 'POST') {
      // 手机端把报错发回来，记进服务日志
      const body = (await readBody(req, 16 << 10)).slice(0, 4000)
      console.log(`[client] ${req.headers['user-agent'] || ''} ${body.replace(/\s+/g, ' ')}`)
      // 脚本错误、未处理的 Promise、页面卡住、发送失败记成问题报告（发送失败常是网络抖动：只按次数阈值推）
      try {
        const c = JSON.parse(body)
        // ui-fail：界面上弹出的错误提示（「xx 失败」）。queued：手机当时连不上、事后补发的，消息里带上晚了多久
        const sev = { error: 'normal', rejection: 'normal', stuck: 'high', 'send-fail': 'low', 'ui-fail': 'low' }[c.kind]
        if (sev && c.queued) c.msg = `${c.msg}（手机连不上时发生，晚 ${Math.round((Number(c.late) || 0) / 1000)} 秒补报）`
        // 经本机隧道访问的（自动化测试的浏览器，Host 是 127.0.0.1 / localhost；真手机走 tailscale 不会是这个）只算测试问题，不推送
        const viaTest = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(req.headers.host || ''))
        if (sev) incidents.record({ test: viaTest, source: 'phone', component: c.kind === 'send-fail' ? 'send' : c.kind === 'ui-fail' ? 'ui' : 'web', kind: c.kind, msg: String(c.msg || '').split('\n')[0], detail: String(c.msg || ''), severity: sev, ctx: { ua: String(req.headers['user-agent'] || '').slice(0, 160), ...(isPaneId(c.pane) ? { pane: terminalId(c.pane) } : {}) } })
      } catch {}
      return json(res, 200, { ok: true })
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method' })
    const root = PUBLIC
    let rel = url.pathname
    if (rel.endsWith('/')) rel += 'index.html'
    let file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    // 手机缓存里的旧首页可能引用已经不在的旧构建（index-xxxx.js / .css）：给它最新的同类文件，不然整页白屏
    if (file.startsWith(root) && !fs.existsSync(file) && /[/\\]assets[/\\]index-[\w-]+\.(js|css)$/.test(file)) {
      const ext = path.extname(file)
      const dir = path.dirname(file)
      const latest = fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith(ext))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
      if (latest) { console.log(`asset fallback ${path.basename(file)} → ${latest.f}`); file = path.join(dir, latest.f) }
    }
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' })
    // 带 Content-Length 和 ETag，一律 no-cache（每次向服务端确认，没变就 304）。
    // 以前 assets 用 immutable 且没有 Content-Length：iPhone 唤醒时下载中断，Safari 把半截脚本当成完整文件缓存一年，
    // 之后每次打开都用坏文件，清 SW 缓存也没用（那是浏览器的 HTTP 缓存），表现为部署后白屏、怎么重载都白屏
    const st = fs.statSync(file)
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); return res.end() }
    const type = TYPES[path.extname(file)] || 'application/octet-stream'
    // 文本类文件 gzip 后再发（800KB 的脚本压到 230KB 左右，手机唤醒时下载被打断的机会小很多），压缩结果按 ETag 缓存
    if (/^(text\/|application\/(json|manifest))/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size > 1024) {
      let gz = gzCache.get(file)
      if (!gz || gz.etag !== etag) { gz = { etag, buf: zlib.gzipSync(fs.readFileSync(file), { level: 9 }) }; gzCache.set(file, gz) }
      res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'content-length': gz.buf.length, vary: 'accept-encoding', etag, 'cache-control': 'no-cache' })
      return res.end(gz.buf)
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, etag, 'cache-control': 'no-cache' })
    fs.createReadStream(file).pipe(res)
  } catch (e) {
    // 程序错误（不是参数不对这类正常拒绝）记成问题报告
    if (incidents.isProgramError(e)) incidents.record({ source: 'server', component: `api ${url.pathname.replace(/\/[0-9a-f]{12}(?=\/|$)/, '/:id')}`, kind: e.name || 'Error', msg: e.message, detail: e.stack, severity: e instanceof TypeError || e instanceof ReferenceError ? 'high' : 'normal' })
    json(res, 502, { error: e.message })
  }
}

// 电脑上要打开网址（pane-open 写的 open 事件）：预览开着就直接打开并提示；否则发给正在看终端的手机，再推一条通知
function onOpen(url) {
  if (!/^(https?|file):\/\//.test(url)) return
  if (preview.client?.readyState === 1) {
    previewSend({ t: 'open', url })
    preview.client.send(JSON.stringify({ t: 'opened', url }))
    return
  }
  // 手机正开着终端页：页面里弹提示就够了，不再推通知
  if (viewing()) { for (const w of watchers.values()) broadcast(w, 'openurl', { url }); return }
  push.notify({ title: '电脑要打开一个网页', body: url.slice(0, 200), tag: 'open-url', url })
    .then((r) => console.log(`notify(open) ${url} → ${JSON.stringify(r)}`))
}

// ---------- 注入了 pane-remote 插件的 agent（agent/plugin/mcp.mjs）发来的请求 ----------
// ask：在手机上问一句（推送 + 状态里挂出来，回答经 bridge agent-answer 交回）；cancel：不等了；notify：推一条通知
const asks = new Map() // id → { id, pane, question, options, confirm, expires, t }
const agentNotify = { byPane: new Map(), recent: [] }
const askId = (v) => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v)
const testPane = (pane) => { const i = push.paneInfo(pane); return !i || i.workspace === 'pane-remote-test' } // 不认识的 pane 也不推
function onAgent(ev) {
  const pane = isPaneId(ev.pane) ? String(ev.pane) : null
  if (ev.op === 'cancel') { if (askId(ev.id)) asks.delete(ev.id); return }
  if (!pane) return
  if (ev.op === 'ask') {
    if (!askId(ev.id) || typeof ev.question !== 'string' || !Array.isArray(ev.options)) return
    const options = ev.options.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.slice(0, 40)).slice(0, 6)
    if (!options.length) return
    const fresh = !asks.has(ev.id)
    asks.set(ev.id, { id: ev.id, pane, question: ev.question.slice(0, 500), options, confirm: !!ev.confirm, expires: Number(ev.expires) || Date.now() / 1000 + 600, t: ev.t })
    if (!fresh || testPane(pane)) return
    const title = `${push.paneTitle(pane)} ${ev.confirm ? '要你确认' : '问你'}`
    push.notify({ title, body: ev.question.slice(0, 200), pane, tag: `ask-${ev.id}` }).then((r) => console.log(`notify(ask) pane ${pane} → ${JSON.stringify(r)}`))
    return
  }
  if (ev.op === 'notify') {
    // agent 自己决定要推的：不看「人在不在电脑前」，但限频（同一个 pane 20 秒一条、全部每小时 20 条）
    const now = Date.now()
    agentNotify.recent = agentNotify.recent.filter((t) => now - t < 3600000)
    if (testPane(pane) || now - (agentNotify.byPane.get(pane) || 0) < 20000 || agentNotify.recent.length >= 20) return console.log(`notify(agent) pane ${pane} dropped`)
    agentNotify.byPane.set(pane, now)
    agentNotify.recent.push(now)
    const title = `${push.paneTitle(pane)} ${String(ev.title || '').slice(0, 60)}`
    push.notify({ title, body: String(ev.body || '').slice(0, 300), pane, tag: `agent-${pane}` }).then((r) => console.log(`notify(agent) pane ${pane} → ${JSON.stringify(r)}`))
  }
}
/** 状态里挂上还没答的问题：该 pane 显示成「等你操作」，选项变成按钮（Inbox 里也能直接答） */
function withAsks(states, includeTest = false) {
  const now = Date.now() / 1000
  for (const a of asks.values()) {
    if (a.expires < now) { asks.delete(a.id); continue }
    if (!includeTest && testPane(a.pane)) continue // 自动化测试的问题不出现在手机上
    const s = (states[a.pane] ||= { state: 'idle', prompt: '', choices: [], unread: false })
    ;(s.asks ||= []).push({ id: a.id, question: a.question, options: a.options, confirm: a.confirm, expires: a.expires })
    s.state = 'waiting'
    s.prompt = a.question
    s.choices = a.options.map((o) => ({ label: o, send: [], ask: { id: a.id, answer: o } }))
  }
  return states
}
async function answerAsk(b) {
  // 插件在手机上问的（platform.agent.ask）：平台自己收
  if (askId(b.id) && platform?.answerAsk(b.id, b.answer, b.text)) return { ok: true }
  const a = askId(b.id) && asks.get(b.id)
  if (!a) throw new Error('这个问题已经过期或被回答了')
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 1000) : ''
  if (!a.options.includes(b.answer) && !(text && !a.confirm)) throw new Error('bad answer')
  const answer = a.options.includes(b.answer) ? b.answer : ''
  await bridge(`agent-answer ${a.id} ${b64(JSON.stringify({ answer, text, t: Date.now() / 1000 }))}`)
  asks.delete(a.id)
  console.log(`agent answer pane ${a.pane}: ${answer || '(text)'}`)
  return { ok: true }
}

// Cursor 模块：电脑上常驻一个 cursor-agent；做完 / 在等你时推送（遵守「一轮做完也推」开关，人在电脑前不推）
if (config.modules.cursor) initCursor({
  dataDir: config.dataDir,
  spawnBridge: (cmd) => bridgeProc(cmd, ['pipe', 'pipe', 'pipe']),
  notify: (p) => {
    if (p.kind === 'stop' && !push.getPrefs().stop) return
    if (push.macIdle() < 120) return
    push.notify({ title: p.title, body: p.body, tag: p.tag, cursor: p.cursor }).then((r) => console.log(`notify(cursor) ${p.title} → ${JSON.stringify(r)}`))
  },
})

incidents.initIncidents({
  dataDir: config.dataDir,
  notify: push.notify,
  bridge,
  manage,
  listPanes,
  injectCommand,
  claudeCommand,
  defaultClaude: () => Object.values(CLAUDE_WRAPPERS)[0] || 'claude',
  isTestPane: testPane,
  bridgeSlow: (cmd) => bridge(cmd, 130000), // AI 分类：便宜模型也要十几秒
  triageDefault: config.incidentTriage === true, // AI 分类默认关：会用你 agent 的订阅额度，要用就在手机上打开，或在配置里写 incidentTriage: true
})
// 进程级异常：先同步写盘再按原样退出（systemd / launchd 会拉起来）；未处理的 Promise 只记不退
process.on('uncaughtException', (e) => {
  incidents.record({ source: 'server', component: 'process', kind: 'uncaughtException', msg: e?.message || String(e), detail: e?.stack, severity: 'high' })
  incidents.flush()
  try { platform?.flush() } catch {}
  console.log(e)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.log('unhandledRejection', e) // 下面单独记（带 stack），这里不走 console.error 免得记两遍
  incidents.record({ source: 'server', component: 'process', kind: 'unhandledRejection', msg: e?.message || String(e), detail: e?.stack, severity: 'high' })
})
push.onProblem((p) => incidents.record({ source: 'server', ...p }))

// ---------- 定时自检（canary）：每 10 分钟走一遍关键链路，坏了记成问题报告。电脑睡着 / 断网时跳过 ----------
// 新功能要纳入自检就在这里加一步（和问题报告一样不消耗 token）
const canaryWaits = new Map()
async function canary() {
  const fail = (kind, title, msg) => incidents.record({ source: 'server', component: 'canary', kind, title, msg: String(msg).slice(0, 1000) })
  let panes
  try { panes = JSON.parse(await bridge('list')) } catch (e) { if (!incidents.isOffline(e.message)) fail('list', '自检：读不到 pane 列表', e.message); return }
  const real = panes.find((p) => p.workspace !== 'pane-remote-test')
  if (real) await bridge(`text ${real.pane_id} 3`).catch((e) => { if (!incidents.isOffline(e.message)) fail('text', '自检：读不到 pane 画面', e.message) })
  const nonce = crypto.randomBytes(8).toString('hex')
  const got = new Promise((r) => { canaryWaits.set(nonce, r); setTimeout(() => r(false), 25000) })
  let r
  try { r = JSON.parse(await bridge(`canary ${nonce}`)) } catch (e) { canaryWaits.delete(nonce); if (!incidents.isOffline(e.message)) fail('mac', '自检：电脑端自检脚本出错', e.message); return }
  if (!r.mcp?.ok) fail('mcp', '自检：MCP 服务起不来或工具不全', JSON.stringify(r.mcp))
  if (!r.agents?.length) fail('agents', '自检：电脑上找不到 Claude / Codex / cursor-agent', JSON.stringify(r))
  // 事件通道：扫描循环在跑（有推送订阅或手机在用）时，Mac 写的事件应该 20 秒内被读到
  const fresh = push.eventsFresh()
  const read = r.event && fresh ? await got : null
  if (read === false) fail('events', '自检：事件通道不通', `canary event ${nonce} not read within 25s`)
  canaryWaits.delete(nonce)
  // pane-host 在不在线：只报告（它不在时一切走 bridge 老路，照样能用），不记成问题
  const hostState = host.connected ? await host.call('ping', {}, { timeout: 5000 }).then((p) => `ok (pid ${p.pid}, up ${p.uptime}s)`, (e) => `ping failed: ${e.message}`) : `offline${host.lastError ? ` (${host.lastError})` : ''}`
  console.log(`canary: mcp ${r.mcp?.ok ? 'ok' : 'FAIL'} (${r.mcp?.tools ?? 0} tools), agents ${r.agents?.length || 0}, events ${read === null ? 'skipped' : read ? 'ok' : 'FAIL'} via ${push.eventsSource()}, pane-host ${hostState}`)
}
if (RELAY) startTunnelHeal({ port: config.relay.port, dataDir: config.dataDir, onStuck: (msg) => incidents.record({ source: 'server', component: 'tunnel-heal', kind: 'stuck', msg, severity: 'high' }) }) // 隧道卡死时自动清掉占着端口的旧会话
setTimeout(() => canary().catch((e) => console.error(`canary: ${e.message}`, e)), 60000)
setInterval(() => canary().catch((e) => console.error(`canary: ${e.message}`, e)), 600000)

push.startMonitor({
  onOpen,
  onAgent,
  onIncident: incidents.onMacEvent,
  onCanary: (nonce) => { canaryWaits.get(nonce)?.(true) },
  bridge,
  isWatching: (pane) => (watchers.get(String(pane))?.clients.size || 0) > 0,
  active: () => viewing() || Date.now() - lastApi < 120000,
})
push.attachHost(host)
// 单客户端在线 + 挡住被遥控电脑自己访问（见 lease.mjs）。local 模式经 tailscale serve 进来的请求对端都是回环，
// 只认代理带的 X-Forwarded-For，不把「回环 = 本机」当真
const lease = createLease({ file: path.join(config.dataDir, 'lease.json') })
const hostCheck = createHostCheck({ allow: process.env.ALLOW_HOST_ACCESS === '1', loopbackIsHost: RELAY })
const onHostIds = (r) => { if (hostCheck.update(r)) console.log(`host-check: 被遥控电脑的地址 ${hostCheck.addrs().join(' ')}`) }
host.on('up', onHostIds)
host.on('ping', onHostIds)
// WebSocket 关闭原因最多 123 字节（中文一个字 3 字节）：设备名太长就截
const kickReason = () => {
  const i = lease.info()
  let d = i.device
  while (Buffer.byteLength(JSON.stringify({ ...i, device: d })) > 120) d = d.slice(0, -1)
  return JSON.stringify({ ...i, device: d })
}
const LEASE_FREE = new Set(['/api/lease', '/api/claim', '/api/log', '/api/version', '/api/changelog']) // 被顶 / 本机时也能用：查状态、接管、上报问题
const clientOf = (req, url) => { const c = req.headers['x-pane-client'] || url.searchParams.get('_pc'); return validClient(c) ? c : '' }
const kickWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 })

const screen = createScreen({ bridge, bridgeProc })
const macApi = createMac({ bridge })

// WebSocket 升级不经过上面的请求处理，身份和来源要在这里单独查
function onUpgrade(req, socket, head) {
  // 升级前后客户端断开（ECONNRESET）会在这个裸 socket 上发 error：没有监听就是未捕获异常，整个服务端退出
  socket.on('error', () => {})
  const url = new URL(req.url, 'http://x')
  const origin = req.headers.origin
  const isScreen = url.pathname === '/api/screen/vnc'
  const platformWs = !!platform && url.pathname === '/api/platform/ws'
  const okPath = isScreen ? !!config.modules.screen : platformWs || (url.pathname === '/api/preview' && (url.searchParams.get('source') === 'cursor' ? !!config.modules.cursor : config.modules.preview))
  // Origin 可能是 null（沙盒 iframe）或乱写的：new URL 会抛错，在这里抛就是未捕获异常、整个进程退出
  const badOrigin = origin && (() => { try { return new URL(origin).host !== req.headers.host } catch { return true } })()
  if (!authorized(req) || !okPath || badOrigin) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  if (hostCheck.isHost(req)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
  const client = clientOf(req, url)
  if (client && !lease.isHolder(client)) {
    // 握手失败浏览器拿不到原因：先接受再用 4409 关掉，原因里带上是谁在用（不用 4001：看屏幕的转码代理拿它表示「电脑连不上」）
    return kickWss.handleUpgrade(req, socket, head, (ws) => ws.close(4409, kickReason()))
  }
  if (client) { const untrack = lease.track(client, () => socket.destroy()); socket.on('close', untrack) }
  if (isScreen) return screen.upgrade(req, socket, head, url)
  if (platformWs) return platform.upgrade(req, socket, head, url)
  const pv = url.searchParams.get('source') === 'cursor' ? previews.cursor : previews.chrome
  pv.wss.handleUpgrade(req, socket, head, (ws) => pv.wss.emit('connection', ws, req))
}

// TEST_LOGIN（只给本机测试用，比如 scripts/smoke.mjs）：本机回环来的、没带身份头的请求当成这个用户。正式环境不设
const testLogin = (req) => { if (process.env.TEST_LOGIN && !req.headers['tailscale-user-login'] && /^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress || '')) req.headers['tailscale-user-login'] = process.env.TEST_LOGIN }
const server = http.createServer((req, res) => { testLogin(req); onRequest(req, res) })
server.on('upgrade', (req, socket, head) => { testLogin(req); onUpgrade(req, socket, head) })

if (!ALLOWED.size) console.log('警告：allowedLogins 是空的，所有请求都会被拒绝（跑 pane-remote init 配置）')
if (!RELAY && !SERVE_HOSTS.size) console.log('警告：serveHosts 是空的，local 模式下所有请求都会被拒绝（跑 pane-remote init 配置）')
server.listen(PORT, '127.0.0.1', () => console.log(`pane-remote v${APP_VERSION} (${config.mode}) on 127.0.0.1:${PORT}, ${ALLOWED.size} allowed login(s)`))

// 可选：直接在 tailnet 地址上开 HTTPS（config.tls，见 docs/advanced.md「不经 tailscale serve」），不经 tailscale serve。
// serve 在 tailscaled 的用户态网络栈里收发，它已经忘掉的连接再收到包时直接丢掉、不回 RST。手机睡一晚醒来还拿着睡前的连接发请求，
// 包全被丢掉、请求一直挂着，重开 App 也复用同一批死连接，看起来就是「整体断开、重连不上」。系统内核的 TCP 会立刻回 RST，手机马上换新连接。
// 身份：serve 注入的 Tailscale-User-Login 改成按来源 IP 问本机 tailscaled（whois），客户端带来的同名头一律丢掉
if (config.tls.listen) {
  const [tlsHost, tlsPort] = config.tls.listen.split(/:(?=\d+$)/)
  const creds = () => ({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) })
  const tlsServer = http2.createSecureServer({ ...creds(), allowHTTP1: true }) // WebSocket 走 HTTP/1.1
  // 证书由 tailscale cert 定期续期（docs/advanced.md「不经 tailscale serve」），这里定时重读
  setInterval(() => { try { tlsServer.setSecureContext(creds()) } catch (e) { console.log(`tls: reload cert failed: ${e.message}`) } }, 6 * 3600e3).unref()
  const ident = async (req) => {
    delete req.headers['tailscale-user-login']
    if (!req.headers.host && req.headers[':authority']) req.headers.host = req.headers[':authority']
    const who = await whois(req.socket.remoteAddress)
    if (who.login) req.headers['tailscale-user-login'] = who.login
    req.paneNode = who.node
  }
  tlsServer.on('request', (req, res) => { ident(req).then(() => onRequest(req, res)) })
  tlsServer.on('upgrade', (req, socket, head) => { ident(req).then(() => onUpgrade(req, socket, head)) })
  tlsServer.on('error', (e) => console.log(`tls: ${e.message}`))
  tlsServer.listen(Number(tlsPort), tlsHost, () => console.log(`pane-remote tls on ${config.tls.listen}`))
}
// 来源 IP → Tailscale 登录名。Linux 上直接问 tailscaled 的 LocalAPI（unix socket）；没有这个 socket（macOS 的 Tailscale App）就用 tailscale whois 命令
const TS_SOCK = '/run/tailscale/tailscaled.sock'
const TS_CLI = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
const whoisCache = new Map() // ip → { login, node, at }
async function whois(addr) {
  const ip = String(addr || '').replace(/^::ffff:/, '')
  const hit = whoisCache.get(ip)
  if (hit && Date.now() - hit.at < 60000) return hit
  let body = ''
  if (fs.existsSync(TS_SOCK)) body = await new Promise((resolve) => {
    const r = http.get({ socketPath: TS_SOCK, path: `/localapi/v0/whois?addr=${encodeURIComponent(ip)}`, headers: { host: 'local-tailscaled.sock' }, timeout: 3000 }, (res) => {
      let b = ''
      res.on('data', (d) => { b += d })
      res.on('end', () => resolve(res.statusCode === 200 ? b : ''))
    })
    r.on('timeout', () => r.destroy())
    r.on('error', () => resolve(''))
  })
  else for (const cli of TS_CLI) {
    body = await new Promise((resolve) => execFile(cli, ['whois', '--json', ip], { timeout: 3000 }, (e, out) => resolve(e ? '' : String(out))))
    if (body) break
  }
  let login = '', node = null
  try {
    const w = JSON.parse(body)
    login = w.UserProfile?.LoginName || ''
    // 设备名给顶号提示用（「已在 xx 上打开」）
    node = { name: w.Node?.Hostinfo?.Hostname || w.Node?.ComputedName || '', os: w.Node?.Hostinfo?.OS || '' }
  } catch {} // ignore: 查不到就当没登录，拒绝
  const fresh = { login, node, at: Date.now() }
  whoisCache.set(ip, fresh)
  return fresh
}
