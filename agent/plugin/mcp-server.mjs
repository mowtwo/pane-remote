#!/usr/bin/env node
// pane-remote 给 agent 用的 MCP 服务（stdio，零依赖），由启动器 mcp.mjs 在子进程里跑（换了代码自动热替换）。agent 在被手机管着的 pane 里跑时，
// 用这些工具联动手机和这台 Mac。
//   往手机发东西：写一条 kind=agent 的事件到 events.jsonl（和 hook 同一个文件），服务端每 3 秒读一次
//   手机的回答：服务端经 bridge 的 agent-answer 写到 answers/<id>.json，这里轮询
//   本机操作：直接调 agent/bridge（和服务端走同一个入口、同样的参数校验）
// 「要你在手机上确认」只防 agent 手滑，不是安全边界：agent 本来就有 shell。
import { spawnSync, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paneContext } from '../../lib/pane-context.mjs'

const HOME = os.homedir()
const STATE = process.env.PANE_REMOTE_STATE || path.join(HOME, '.local/state/pane-remote')
const EVENTS = path.join(STATE, 'events.jsonl')
const ANSWERS = path.join(STATE, 'agent/answers')
const BRIDGE = process.env.PANE_REMOTE_BRIDGE || path.join(path.dirname(fileURLToPath(import.meta.url)), '../bridge')
const MOUSE_SOCK = path.join(HOME, '.cache/pane-remote/mouse.sock') // 看屏幕模块的鼠标助手
const HOST_SOCK = process.env.PANE_HOST_SOCK || path.join(HOME, '.cache/pane-remote-host/host.sock')
let paneErr = '' // 认 pane 失败的原因（写进启动日志）
// A diagnostic child must not identify as its parent pane or replace its live marker.
const context = process.env.PANE_REMOTE_AGENT === 'canary' ? { pane: null, allowTty: false } : paneContext()
const PANE = context.pane ?? (context.allowTty ? paneFromTty() : null)
const AGENT = process.env.PANE_REMOTE_AGENT || 'claude'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 正常的拒绝（参数不对、没有这个 pane）：照常回给 agent，不算问题；别的出错会自动记成问题报告
class UserError extends Error {}
const FIXING = /^[0-9a-f]{12}$/.test(process.env.PANE_REMOTE_INCIDENT || '') ? process.env.PANE_REMOTE_INCIDENT : null // 这个会话是来修哪个问题的
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')

function bridge(cmd, input) {
  const r = spawnSync(BRIDGE, [], { env: { ...process.env, SSH_ORIGINAL_COMMAND: cmd }, input, encoding: 'utf8', timeout: 20000, maxBuffer: 8 << 20 })
  if (r.status !== 0) throw new Error((r.stdout || r.stderr || `bridge ${cmd.split(' ')[0]} failed`).trim().slice(0, 300))
  return r.stdout
}
// 有的 agent（cursor-agent）启动 MCP 时不传 WEZTERM_PANE：沿父进程往上找到有终端的那个，按 tty 对上所选终端后端的 pane
function paneFromTty() {
  try {
    let pid = process.ppid
    for (let i = 0; i < 6 && pid > 1; i++) {
      const [ppid, tty] = execFileSync('/bin/ps', ['-o', 'ppid=,tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/)
      if (tty && tty !== '??') {
        const p = JSON.parse(bridge('list')).find((x) => String(x.tty_name || '').replace('/dev/', '') === tty)
        return p ? p.pane_id : null
      }
      pid = Number(ppid)
    }
  } catch (e) { paneErr = String(e.message || e).slice(0, 120) }
  return null
}
function emit(op, data, kind = 'agent') {
  fs.mkdirSync(path.dirname(EVENTS), { recursive: true })
  fs.appendFileSync(EVENTS, JSON.stringify({ t: Date.now() / 1000, pane: PANE, agent: AGENT, kind, op, ...data }) + '\n')
}
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

function incident(data) {
  emit('report', data, 'incident')
}
const INCIDENTS = path.join(STATE, 'incidents')

// 在手机上问一句、等回答。服务重启会丢掉还没答的问题，所以每 2 分钟重发一次（同一个 id，服务端按 id 去重）
async function ask(question, options, timeoutSec, extra = {}) {
  const id = crypto.randomBytes(12).toString('hex')
  const file = path.join(ANSWERS, `${id}.json`)
  const deadline = Date.now() + timeoutSec * 1000
  const payload = { id, question, options, expires: Math.round(deadline / 1000), ...extra }
  emit('ask', payload)
  let resent = Date.now()
  try {
    while (Date.now() < deadline) {
      await sleep(1000)
      try {
        const a = JSON.parse(fs.readFileSync(file, 'utf8'))
        return { answered: true, answer: String(a.answer ?? ''), text: a.text ? String(a.text) : '' }
      } catch {}
      if (Date.now() - resent > 120000) { emit('ask', payload); resent = Date.now() }
    }
    return { answered: false }
  } finally {
    emit('cancel', { id })
    try { fs.unlinkSync(file) } catch {}
  }
}
async function confirm(question) {
  const r = await ask(question, ['允许', '拒绝'], 180, { confirm: true })
  return r.answered && r.answer === '允许'
}

function userWhere() {
  let phoneAgo = null
  try { phoneAgo = Math.round((Date.now() - fs.statSync(path.join(HOME, '.cache/pane-remote-active')).mtimeMs) / 1000) } catch {}
  let idle = null
  try {
    const m = /"HIDIdleTime" = (\d+)/.exec(execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 3000 }))
    if (m) idle = Math.round(Number(m[1]) / 1e9)
  } catch {}
  return { phoneActive: phoneAgo != null && phoneAgo < 150, phoneLastSeenSec: phoneAgo, macIdleSec: idle, atMac: idle != null && idle < 60 }
}

function panes() {
  return JSON.parse(bridge('list')).filter((p) => p.workspace !== 'pane-remote-test')
    .map((p) => ({ pane: p.pane_id, title: p.title, cwd: String(p.cwd || '').replace(/^file:\/\/[^/]*/, ''), tab: p.tab_id, window: p.window_id, self: p.pane_id === PANE }))
}

function lockMac() {
  // ctrl+cmd+Q 交给常驻的 mousectl（有辅助功能授权）；它不在时让显示器睡眠（设置了「立即要求密码」时等于锁屏）
  return new Promise((resolve) => {
    const c = net.connect(MOUSE_SOCK)
    c.on('connect', () => { c.end(`k 12 ${0x40000 | 0x100000} 1\nk 12 ${0x40000 | 0x100000} 0\n`); resolve('locked (ctrl+cmd+Q)') })
    c.on('error', () => { spawnSync('/usr/bin/pmset', ['displaysleepnow']); resolve('display put to sleep (mousectl not running)') })
  })
}

// ---------- 插件工具 ----------
// pane-remote 插件在描述文件里声明、preload 里 registerTool 实现的工具（比如待办）：经本机的 pane-host 转给服务端执行
// （服务端查 mcp 权限、起插件的工具运行时，见 platform/tools.mjs）。名字是 plugin_<插件 id>_<工具名>。
// 列表 20 秒内用缓存；变了（pane-host 推过来）就发 tools/list_changed
function hostCall(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = net.connect(HOST_SOCK)
    let buf = '', done = false
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); c.destroy(); fn(v) }
    const timer = setTimeout(() => end(reject, new Error(`pane-host ${method} 超时`)), timeoutMs)
    c.on('connect', () => c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'))
    c.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      let m
      try { m = JSON.parse(buf.slice(0, i)) } catch (e) { return end(reject, e) }
      if (m.error) end(reject, Object.assign(new Error(m.error.message), { code: m.error.code }))
      else end(resolve, m.result)
    })
    c.on('error', (e) => end(reject, new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'pane-host 没在运行' : e.message)))
  })
}
let pluginTools = new Map() // MCP 名字 → { description, inputSchema, outputSchema? }
let pluginToolsAt = 0
let pluginToolsErr = ''
async function refreshPluginTools(maxAgeMs = 20000, timeoutMs = 4000) {
  if (Date.now() - pluginToolsAt < maxAgeMs) return false
  try {
    const r = await hostCall('plugins.tools.list', {}, timeoutMs)
    const next = new Map((r?.tools || []).filter((t) => t && /^[a-zA-Z0-9_-]{1,64}$/.test(t.name) && !TOOLS[t.name]).map((t) => [t.name, { description: String(t.description || ''), inputSchema: t.inputSchema || { type: 'object' }, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}) }]))
    const changed = JSON.stringify([...next]) !== JSON.stringify([...pluginTools])
    pluginTools = next
    pluginToolsAt = Date.now()
    pluginToolsErr = ''
    return changed
  } catch (e) {
    pluginToolsErr = String(e.message || e).slice(0, 200) // 服务端 / pane-host 不在线：先用上次的列表
    pluginToolsAt = Date.now() - maxAgeMs + 5000 // 5 秒后再试
    return false
  }
}
// 这个 agent 的会话 id（Claude Code 的 sessionId 之类）：插件记下它，pane 重启、换了编号后也能找回这个会话。
// 用 bridge 的 agent inspect 查（/clear 之后会变），缓存 1 分钟
let sessionCache = { t: 0, id: null }
function mySession() {
  if (PANE == null) return null
  if (Date.now() - sessionCache.t < 60000) return sessionCache.id
  let id = null
  try { id = JSON.parse(bridge(`agent inspect ${PANE}`) || '{}').session || null } catch {} // ignore: 查不到就不记
  sessionCache = { t: Date.now(), id }
  return id
}
// 插件给这个会话的留言（用户在手机上对它建的待办做了什么）：调 pane-remote 工具时顺便取走，附在结果后面
async function takeNotes() {
  const session = mySession()
  if (!session) return ''
  try {
    const r = await hostCall('sessions.notes.take', { session }, 1500)
    return formatNotes(r?.notes)
  } catch { return '' }
}
const formatNotes = (notes) => (Array.isArray(notes) && notes.length ? `\n\n[pane-remote] Updates for this session since you last heard:\n${notes.map((n) => `- ${n.name || n.plugin}: ${n.text}`).join('\n')}` : '')

async function callPluginTool(name, args) {
  const caller = { agent: AGENT, pane: PANE, cwd: process.cwd(), session: mySession() }
  try {
    return await hostCall('plugins.tools.call', { name, args, caller }, 7 * 60000)
  } catch (e) {
    // 插件 / 权限这类正常的拒绝回给 agent，不记问题报告
    if (['EWTPERM', 'ENOTOOL', 'ETOOL', 'EBADARG', 'ETIMEOUT', -32001].includes(e.code)) throw new UserError(e.message)
    throw e
  }
}

const PANE_SCHEMA = { anyOf: [{ type: 'integer', minimum: 0, maximum: 999999 }, { type: 'string', pattern: '^w[0-9A-HJKMNP-TV-Z]{1,13}:p[0-9A-HJKMNP-TV-Z]{1,13}(?![\\s\\S])' }] }
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false })
const TOOLS = {
  user_whereabouts: {
    description: 'Where the user probably is right now: whether the pane-remote phone app was used in the last 2.5 minutes, and how long the Mac keyboard/mouse has been idle. Use it to decide between waiting in the terminal and reaching out via the phone.',
    inputSchema: S({}),
    run: () => userWhere(),
  },
  notify_phone: {
    description: "Send a push notification to the user's phone. For milestones, finished long jobs, or things the user must know while away. Rate-limited; don't use it for routine progress.",
    inputSchema: S({ title: { type: 'string', maxLength: 60 }, body: { type: 'string', maxLength: 300 } }, ['title', 'body']),
    run: ({ title, body }) => { emit('notify', { title: clip(title, 60), body: clip(body, 300) }); return 'queued; the relay delivers it within a few seconds (it may drop it if you notified very recently)' },
  },
  ask_phone: {
    description: 'Ask the user a question on their phone and wait for the answer (push notification + buttons in the app; the user may also type a free-text reply). Use when you are blocked on a decision and the user is away from the Mac. Returns {answered, answer, text}.',
    inputSchema: S({
      question: { type: 'string', maxLength: 500 },
      options: { type: 'array', items: { type: 'string', maxLength: 40 }, minItems: 1, maxItems: 6 },
      timeout_sec: { type: 'integer', minimum: 30, maximum: 1800, description: 'default 600' },
    }, ['question', 'options']),
    run: ({ question, options, timeout_sec }) => ask(clip(question, 500), options.map((o) => clip(o, 40)).filter(Boolean).slice(0, 6), timeout_sec || 600),
  },
  open_on_phone: {
    description: "Open a URL on the user's phone, in pane-remote's preview (a browser that runs on this Mac, so localhost / LAN dev servers work). Use after starting a dev server or producing an HTML report.",
    inputSchema: S({ url: { type: 'string', maxLength: 2000 } }, ['url']),
    run: ({ url }) => {
      if (!/^(https?|file):\/\//.test(url)) throw new UserError('only http(s):// and file:// URLs')
      fs.appendFileSync(EVENTS, JSON.stringify({ t: Date.now() / 1000, pane: PANE, agent: AGENT, kind: 'open', msg: url }) + '\n')
      return 'sent: opens in the preview if it is open, otherwise shows a prompt / notification on the phone'
    },
  },
  mac_say: {
    description: 'Speak a short text aloud on this Mac (macOS `say`). Only when the user asked for audible alerts.',
    inputSchema: S({ text: { type: 'string', maxLength: 500 } }, ['text']),
    run: ({ text }) => bridge(`mac-say ${b64(JSON.stringify({ text: clip(text, 500) }))}`).trim(),
  },
  mac_perf: {
    description: 'CPU, memory and swap of this Mac plus the top processes (takes ~2 s).',
    inputSchema: S({}),
    run: () => JSON.parse(bridge('mac-perf')),
  },
  mac_lock: {
    description: 'Lock the Mac screen. Asks the user to confirm on the phone first.',
    inputSchema: S({ reason: { type: 'string', maxLength: 200 } }, ['reason']),
    run: async ({ reason }) => (await confirm(`锁定 Mac 屏幕？\n原因：${clip(reason, 200)}`)) ? lockMac() : 'user declined or did not answer; not locked',
  },
  list_panes: {
    description: 'List the panes in pane-remote’s selected terminal backend (pane id, title, cwd). `self: true` is your own pane.',
    inputSchema: S({}),
    run: () => panes(),
  },
  read_pane: {
    description: "Read the last lines of another pane's screen/scrollback as plain text.",
    inputSchema: S({ pane: PANE_SCHEMA, lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'default 80' } }, ['pane']),
    run: ({ pane, lines }) => {
      if (!panes().some((p) => p.pane === pane)) throw new UserError('no such pane')
      return bridge(`text ${pane} ${lines || 80}`).replace(/\n{3,}/g, '\n\n').trimEnd()
    },
  },
  send_to_pane: {
    description: "Type text into another pane (e.g. reply to another agent, run a command in a dev-server pane). Asks the user to confirm on the phone first. Not allowed for your own pane.",
    inputSchema: S({ pane: PANE_SCHEMA, text: { type: 'string', maxLength: 4000 }, enter: { type: 'boolean', description: 'press Enter after the text (default true)' } }, ['pane', 'text']),
    run: async ({ pane, text, enter }) => {
      const p = panes().find((x) => x.pane === pane)
      if (!p) throw new UserError('no such pane')
      if (p.self) throw new UserError('refusing to type into your own pane')
      const ok = await confirm(`往 #${pane} ${clip(p.title, 40)} 发送${enter === false ? '' : '并回车'}：\n${String(text).slice(0, 400)}`)
      if (!ok) return 'user declined or did not answer; nothing sent'
      bridge(`send ${pane} ${b64(text)}`)
      if (enter !== false) { await sleep(60); bridge(`send ${pane} ${b64('\r')}`) }
      return 'sent'
    },
  },
  report_incident: {
    description: "Report a problem with pane-remote itself (not with the user's project): a pane-remote tool failed or returned something wrong, a phone notification or question never arrived, the phone UI or a restart misbehaved, or the user told you pane-remote did something unexpected. The report is stored, deduplicated and may be pushed to the user's phone with an offer to fix it.",
    inputSchema: S({
      title: { type: 'string', maxLength: 120, description: 'one line: what is wrong' },
      what_happened: { type: 'string', maxLength: 3000, description: 'what you did and what actually happened (tool name, arguments, output, error text)' },
      expected: { type: 'string', maxLength: 1000, description: 'what should have happened' },
      component: { type: 'string', maxLength: 60, description: 'e.g. ask_phone, notify_phone, read_pane, restart, phone-ui, preview' },
      severity: { type: 'string', enum: ['high', 'normal', 'low'] },
    }, ['title', 'what_happened']),
    run: ({ title, what_happened, expected, component, severity }) => {
      incident({ source: 'agent', component: clip(component || 'agent', 60), ikind: 'report', title: clip(title, 120), msg: clip(title, 300),
        detail: `${String(what_happened).slice(0, 3000)}${expected ? `\n\n预期：${String(expected).slice(0, 1000)}` : ''}`, severity: severity || 'normal', fixing: FIXING || undefined })
      return FIXING ? `noted on incident ${FIXING} (you are fixing it)` : 'reported; the user can review it on the phone and choose to have it fixed'
    },
  },
  incident_get: {
    description: 'Read the brief of a pane-remote incident you were asked to fix ([pane-remote incident <id>]): samples, context and what to do.',
    inputSchema: S({ id: { type: 'string', pattern: '^[0-9a-f]{12}$' } }, ['id']),
    run: ({ id }) => {
      if (!/^[0-9a-f]{12}$/.test(id)) throw new UserError('bad id')
      try { return fs.readFileSync(path.join(INCIDENTS, `${id}.md`), 'utf8') } catch { throw new UserError('no brief for this incident on this Mac') }
    },
  },
  incident_update: {
    description: 'Report progress on a pane-remote incident you are fixing. status: investigating (started), needs-confirm (waiting for the user, e.g. before deploy/push/PR), fixed (include branch or pr_url), failed, wontfix. The user gets a push for everything except investigating.',
    inputSchema: S({
      id: { type: 'string', pattern: '^[0-9a-f]{12}$' },
      status: { type: 'string', enum: ['investigating', 'needs-confirm', 'fixed', 'failed', 'wontfix'] },
      note: { type: 'string', maxLength: 2000, description: 'one or two sentences: cause, what changed, how it was verified' },
      branch: { type: 'string', maxLength: 100 },
      pr_url: { type: 'string', maxLength: 300 },
    }, ['id', 'status', 'note']),
    run: ({ id, status, note, branch, pr_url }) => {
      if (!/^[0-9a-f]{12}$/.test(id)) throw new UserError('bad id')
      emit('update', { id, status, note: String(note).slice(0, 2000), branch, pr: pr_url }, 'incident')
      return `recorded: ${status}`
    },
  },
}

// ---------- MCP stdio：一行一个 JSON-RPC 消息 ----------
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
async function handle(m) {
  if (m.id === undefined) return // 通知（initialized、cancelled）不用回
  try {
    if (m.method === 'initialize') {
      return out({ id: m.id, result: {
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'pane-remote', version: '1.0.0' },
        instructions: `You are running inside pane-remote: the user controls this terminal (pane ${PANE ?? '?'}) from their phone. These tools reach the phone and this Mac.`
          + ' Tools named plugin_<id>_<tool> come from pane-remote plugins the user installed; plugin_todo_* is the user\'s todo list shared by all their agents and shown on their phone: add items the user should see or act on later (unfinished follow-ups, decisions waiting for them), and check it when they ask what is pending. plugin_todo_list returns only your own items by default; pass project: "all" only when the user explicitly asks about everything. "Your tasks" / "what\'s left" without mentioning todo means your own session task list, not the todo list.',
      } })
    }
    if (m.method === 'ping') return out({ id: m.id, result: {} })
    if (m.method === 'tools/list') {
      await refreshPluginTools()
      initialized = true
      const own = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }))
      return out({ id: m.id, result: { tools: [...own, ...[...pluginTools].map(([name, t]) => ({ name, ...t }))] } })
    }
    if (m.method === 'tools/call') {
      const name = m.params?.name
      if (!TOOLS[name] && !pluginTools.has(name)) await refreshPluginTools(0) // 列表可能还没拉到（刚启动时服务端不在线）
      if (!TOOLS[name] && pluginTools.has(name)) {
        try {
          const r = await callPluginTool(name, m.params.arguments || {})
          const v = r?.value
          const text = (typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 1)) + await takeNotes()
          return out({ id: m.id, result: { content: [{ type: 'text', text }], ...(v && typeof v === 'object' && !Array.isArray(v) && pluginTools.get(name).outputSchema ? { structuredContent: v } : {}) } })
        } catch (e) {
          if (!(e instanceof UserError)) incident({ source: 'mac', component: 'mcp', ikind: 'plugin-tool', msg: `${name}: ${String(e.message || e).slice(0, 500)}`, detail: e.stack, fixing: FIXING || undefined })
          return out({ id: m.id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } })
        }
      }
      const t = TOOLS[name]
      if (!t) return out({ id: m.id, error: { code: -32602, message: `unknown tool ${name}${pluginToolsErr ? `（插件工具列表拿不到：${pluginToolsErr}）` : ''}` } })
      try {
        const r = await t.run(m.params.arguments || {})
        return out({ id: m.id, result: { content: [{ type: 'text', text: (typeof r === 'string' ? r : JSON.stringify(r, null, 1)) + await takeNotes() }] } })
      } catch (e) {
        // 意外的出错（bridge 失败、代码错误）自动记一条问题报告；正常的拒绝（UserError）不记
        if (!(e instanceof UserError)) incident({ source: 'mac', component: 'mcp', ikind: m.params.name, msg: `${m.params.name}: ${String(e.message || e).slice(0, 500)}`, detail: e.stack, fixing: FIXING || undefined })
        return out({ id: m.id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } })
      }
    }
    out({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } })
  } catch (e) {
    out({ id: m.id, error: { code: -32603, message: String(e.message || e) } })
  }
}

// 记下「这个 pane 的 agent 已注入」，手机上据此显示；进程退出时删掉
const LIVE = path.join(STATE, 'agent/live')
// 启动日志（排查用，只留最后 200 行）：哪个 agent、认到的 pane、怎么认到的
try {
  const LOG = path.join(STATE, 'agent/mcp.log')
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-199) } catch {}
  lines.push(`${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} agent=${AGENT} pane=${PANE} via=${process.env.WEZTERM_PANE ? 'env' : 'tty'}${paneErr ? ' err=' + paneErr : ''}`)
  fs.writeFileSync(LOG, lines.join('\n') + '\n')
} catch {}
const liveFile = PANE != null ? path.join(LIVE, `${PANE}.json`) : null
if (liveFile) {
  fs.mkdirSync(LIVE, { recursive: true })
  fs.writeFileSync(liveFile, JSON.stringify({ pid: process.pid, ppid: process.ppid, agent: AGENT, t: Date.now() / 1000 }))
  const bye = () => { try { if (JSON.parse(fs.readFileSync(liveFile, 'utf8')).pid === process.pid) fs.unlinkSync(liveFile) } catch {} process.exit(0) }
  process.on('SIGTERM', bye); process.on('SIGINT', bye); process.on('SIGHUP', bye)
  // stdin 关了（agent 退出，或自检这种一次发完就关的）：等还没回完的请求回完再走（tools/list 要先问插件工具，是异步的），最多 10 秒
  process.stdin.on('end', () => { Promise.race([Promise.allSettled([...inflight]), sleep(10000)]).then(bye) })
}

// 插件工具列表变了（插件装上 / 删掉、权限被禁止）：告诉 agent 重新拉。
// 订阅 pane-host 的 plugins.tools 主题（服务端一改就推过来）；订阅断了 5 秒后重连，另外每 5 分钟兜底刷新一次
let initialized = false
const toolsChanged = async (maxAge) => { if (initialized && await refreshPluginTools(maxAge, 8000)) out({ method: 'notifications/tools/list_changed' }) }
setInterval(() => toolsChanged(290000), 300000).unref()
function watchTools() {
  const c = net.connect(HOST_SOCK)
  let buf = ''
  c.on('connect', () => c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sub', params: { topic: 'plugins.tools' } }) + '\n'))
  c.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try { if (JSON.parse(line).event) toolsChanged(0) } catch {} // ignore: 坏行
    }
  })
  c.on('error', () => {}) // ignore: pane-host 不在，close 里重连
  c.on('close', () => setTimeout(watchTools, 5000).unref())
  c.unref()
}
watchTools()

const inflight = new Set() // 还没回完的请求
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { out({ id: null, error: { code: -32700, message: 'parse error' } }); continue }
    const p = handle(m)
    inflight.add(p)
    p.finally(() => inflight.delete(p))
  }
})
