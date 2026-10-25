// 问题报告（incident）：把各处发现的异常收到一处，按「指纹」去重计数，必要时推送到手机，并能一键交给 agent 修。
//
// 来源（谁发现的）：
//   server  服务端自己：进程级异常、接口里的程序错误（TypeError 之类、超时、连接断开）、推送失败、扫描循环出错、
//           断言 / 异常模式（同一个 pane 频繁重连、事件到得太晚……）
//   phone   手机端回报的（/api/log）：脚本错误、未处理的 Promise、页面卡住、发送失败
//   mac     电脑端脚本：MCP 工具意外出错、重启并注入失败（经 events.jsonl 的 kind=incident 送来）
//   agent   注入了插件的 agent 用 report_incident 报的（执行结果和预期不符这类，程序自己判断不了的）
//   user    手机上手动「报告问题」
//
// 推送策略：严重的第一次就推；其余在次数到 3 / 10 / 50 / 200 时推；同一个问题 30 分钟内最多一条，全部每小时最多 8 条；
// 忽略 / 静音 / 修复中的不推，测试 workspace 里的不推。
//
// 修复（fix）：按配置交给「绑定的会话」（空闲时把问题发进它的 pane，忙就排队，不在运行就在新标签页恢复它）
// 或者「新开一个 agent」（在 pane-remote 仓库目录，带插件，用和报告方同一家的 agent）。agent 用 incident_get / incident_update 读简报、报进度。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isPaneId, terminalId } from '../lib/terminal-id.mjs'

const MAX = 300 // 最多留这么多条（先删已解决的、最老的）
const SAMPLES = 5
const THRESHOLDS = [3, 10, 50, 200]
const COOLDOWN = 30 * 60000
const HOURLY = 8
const AGENTS = ['claude', 'codex', 'cursor-agent']

let deps = null // { dataDir, notify, bridge, manage, injectCommand, claudeCommand, defaultClaude, isTestPane, paneTitle, listPanes }
let FILE = ''
let list = []
let cfg = { fixer: 'auto', agent: 'auto', bound: null, triage: null, triageUsage: { day: '', n: 0 } }
let saveTimer = null
const pushedAt = [] // 最近一小时推过的时间

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
const now = () => Date.now()

export function initIncidents(d) {
  deps = d
  FILE = path.join(d.dataDir, 'incidents.json')
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    list = Array.isArray(j.incidents) ? j.incidents : []
    if (j.config) cfg = { ...cfg, ...j.config }
  } catch {}
  for (const r of early.splice(0)) record(r)
  if (!cfg.triage) cfg.triage = { enabled: !!d.triageDefault, agent: 'auto', model: '', daily: 20 }
  if (!d.noFixer) setInterval(() => tick().catch((e) => console.error(`incidents: tick ${e.message}`, e)), 15000)
}

function save(sync = false) {
  clearTimeout(saveTimer)
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE + '.tmp', JSON.stringify({ incidents: list, config: cfg }))
      fs.renameSync(FILE + '.tmp', FILE)
    } catch (e) { console.error(`incidents: save ${e.message}`, e) }
  }
  if (sync) write()
  else saveTimer = setTimeout(write, 500)
}

/** 去掉每次都不一样的部分（数字、ID、构建文件名、行列号），同一个问题才能算到一起 */
export function normalize(s) {
  return String(s || '').split('\n')[0]
    .replace(/https?:\/\/[^\s)]+/g, '<url>')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~')
    .replace(/\b[\w-]+-[A-Za-z0-9_-]{8}\.(js|css)\b/g, '<asset>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
// 测试来的单独算：不会累加到同样内容的真问题上、也不会因此触发推送
const fingerprint = (r) => crypto.createHash('sha1').update([r.test ? 'test' : '', r.source, r.component, r.kind, normalize(r.msg || r.title)].join('|')).digest('hex').slice(0, 12)

/** 网络 / 电脑睡着连不上：环境问题，不算 pane-remote 的问题 */
export const isOffline = (m) => /Connection refused|Connection timed out|connect to host|kex_exchange|Connection closed|Connection reset|timed out|No route to host|Network is unreachable|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(String(m))

/**
 * 按日志级别统一捕获：服务端任何地方 console.error 都记成问题报告（网络类除外）。
 * 新代码出错时用 console.error 就会被抓到，不用另写规则。第一个参数当「模块: 说明」，Error 对象的 stack 进详情
 */
export function captureConsoleErrors() {
  const orig = console.error.bind(console)
  let inside = false
  console.error = (...args) => {
    orig(...args)
    if (inside) return
    inside = true
    try {
      const err = args.find((a) => a instanceof Error)
      const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' ').slice(0, 2000)
      if (!isOffline(text)) {
        const m = /^([\w.-]{2,30})[:：]/.exec(text)
        record({ source: 'server', component: 'log', kind: m ? m[1] : 'error', msg: text, detail: err?.stack, severity: err instanceof TypeError || err instanceof ReferenceError ? 'high' : 'normal' })
      }
    } catch {} finally { inside = false }
  }
}

/** 程序错误（要记）和正常的业务拒绝（参数不对、找不到 pane 之类，不记）的分界 */
export function isProgramError(e) {
  if (!e) return false
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError) return true
  // 网络 / 电脑睡着这类是环境问题，不在这里记（到电脑的连接另有 reconnect-failed 检查）
  return /Traceback|maxBuffer|Unexpected token|is not valid JSON|ENOSPC|EMFILE|Cannot read properties|is not a function|is not defined/i.test(String(e.message || e))
}

/**
 * 记一条。r: { source, component, kind, title?, msg, detail?, ctx?, severity?: 'high'|'normal'|'low', reporter? }
 * 返回这条 incident（已经存在的就累加）
 */
const early = [] // 初始化之前记的（比如启动时扩展加载失败），初始化后补上
export function record(r) {
  if (!deps) { if (early.length < 50) early.push(r); return null }
  r = { severity: 'normal', ...r }
  if (r.ctx?.pane != null && deps.isTestPane(r.ctx.pane)) r.test = true
  // 正在修某个问题的会话自己报的：算进那个问题的修复过程，不新开、不推送（不然会越修越多）
  const fixing = r.fixingId ? list.find((x) => x.id === r.fixingId) : r.reporter?.pane != null ? list.find((x) => x.fix?.state === 'running' && String(x.fix.pane) === String(r.reporter.pane)) : null
  if (fixing && r.source !== 'user') {
    note(fixing, { status: 'report', note: `${r.title || r.kind}: ${String(r.msg || '').slice(0, 500)}` })
    save()
    return fixing
  }
  const fp = fingerprint(r)
  const t = now()
  let inc = list.find((x) => x.fp === fp)
  if (!inc) {
    inc = { id: fp, fp, source: r.source, component: r.component, kind: r.kind, title: (r.title || String(r.msg || '').split('\n')[0].trim() || r.kind).slice(0, 120), // 标题用原文，只有指纹用规整过的
      severity: r.severity, count: 0, first: t, last: t, recent: [], samples: [], status: 'open', muted: false, notified: null, reporter: r.reporter || null, fix: null, test: !!r.test }
    list.unshift(inc)
    trim()
    if (!inc.test && inc.source !== 'user') queueTriage(inc)
  } else if (inc.status === 'fixed' || inc.status === 'resolved') {
    // 修好了又出现：重新打开，按严重的处理（第一次就推）
    inc.status = 'open'
    inc.severity = 'high'
    inc.regressed = t
    inc.notified = null
  }
  inc.count++
  inc.last = t
  inc.recent = [...inc.recent.filter((x) => t - x < 3600000), t].slice(-200)
  if (r.severity === 'high') inc.severity = 'high'
  if (r.reporter && !inc.reporter) inc.reporter = r.reporter
  inc.samples = [{ t, msg: String(r.msg || '').slice(0, 2000), detail: r.detail ? String(r.detail).slice(0, 6000) : undefined, ctx: r.ctx }, ...inc.samples].slice(0, SAMPLES)
  maybeNotify(inc)
  save()
  return inc
}

function trim() {
  if (list.length <= MAX) return
  const done = list.filter((x) => x.status === 'resolved' || x.status === 'ignored').sort((a, b) => a.last - b.last)
  while (list.length > MAX && done.length) list.splice(list.indexOf(done.shift()), 1)
  list.sort((a, b) => b.last - a.last)
  list.length = Math.min(list.length, MAX)
}

function maybeNotify(inc) {
  if (inc.muted || inc.status === 'ignored' || inc.fix?.state === 'running' || inc.fix?.state === 'queued' || inc.test || inc.source === 'user') return
  const t = now()
  const first = !inc.notified
  // AI 判成噪音 / 重复的：前面几个阈值不推，到 10 次以上才推
  const hit = (inc.severity === 'high' && first) || THRESHOLDS.some((n) => inc.count >= n && (inc.notified?.atCount || 0) < n && !(inc.aiQuiet && n < 10))
  if (!hit) return
  if (inc.notified && t - inc.notified.t < COOLDOWN) return
  while (pushedAt.length && t - pushedAt[0] > 3600000) pushedAt.shift()
  if (pushedAt.length >= HOURLY) return
  pushedAt.push(t)
  inc.notified = { t, atCount: inc.count }
  const where = { server: '服务端', phone: '手机端', mac: '电脑端', agent: 'agent 报告' }[inc.source] || inc.source
  push({ title: `${inc.regressed && t - inc.regressed < 60000 ? '问题又出现了' : 'pane-remote 发现问题'}：${inc.title}`, body: `${inc.ai?.summary ? `${inc.ai.summary} · ` : ''}${where} · ${inc.component}${inc.count > 1 ? ` · 第 ${inc.count} 次` : ''}。点开看看要不要修`, incident: inc.id })
}
function push(p) {
  deps.notify({ ...p, tag: p.incident ? `incident-${p.incident}` : 'incident' }).then((r) => console.log(`notify(incident) ${p.title} → ${JSON.stringify(r)}`), () => {})
}

function note(inc, u) {
  inc.fix = inc.fix || { state: 'running', started: now(), updates: [] }
  inc.fix.updates = [...(inc.fix.updates || []), { t: now(), ...u }].slice(-40)
}

// ---------- AI 分类：只给新指纹，用便宜模型（Haiku / Codex 轻量模型 / Cursor Composer Fast），每天有上限 ----------
// 判严重程度、是不是和已有问题重复、要不要推，写一句给手机看的摘要。跑在 Mac 上（pane-agent triage），用你 agent 的订阅额度
const triageQueue = []
let triageBusy = false
function queueTriage(inc) {
  if (!cfg.triage?.enabled || !deps.bridgeSlow) return
  triageQueue.push(inc.id)
  runTriage().catch((e) => console.error(`incidents: triage ${e.message}`, e))
}
const today = () => new Date().toLocaleDateString('sv') // YYYY-MM-DD，本地时间
async function runTriage() {
  if (triageBusy) return
  triageBusy = true
  try {
    while (triageQueue.length) {
      const id = triageQueue.shift() // 先取出来再找：写在 find 的回调里会每比较一个就取走一个
      const inc = list.find((x) => x.id === id)
      if (!inc || inc.ai) continue
      const u = cfg.triageUsage.day === today() ? cfg.triageUsage : (cfg.triageUsage = { day: today(), n: 0 })
      if (u.n >= (cfg.triage.daily || 20)) { inc.ai = { skipped: '今天的 AI 分类次数用完了' }; save(); continue }
      u.n++
      const agents = cfg.triage.agent !== 'auto' ? [cfg.triage.agent] : await triageOrder()
      const others = list.filter((x) => x.id !== inc.id && !x.test && x.status !== 'resolved').slice(0, 15).map((x) => `- ${x.id}: [${x.component}/${x.kind}] ${x.title}`).join('\n')
      const s = inc.samples[0] || {}
      const prompt = [
        `New incident ${inc.id} (first seen ${new Date(inc.first).toISOString()}, ${inc.count} time(s)).`,
        `source=${inc.source} component=${inc.component} kind=${inc.kind} rule-severity=${inc.severity}`,
        `title: ${inc.title}`, '', 'message:', String(s.msg || '').slice(0, 1500), s.detail ? `\ndetail:\n${String(s.detail).slice(0, 1500)}` : '',
        s.ctx ? `\ncontext: ${JSON.stringify(s.ctx).slice(0, 300)}` : '', '', 'Other known incidents:', others || '(none)', '',
        'Decide: is this a real pane-remote bug the user should hear about, environment noise (network, sleep, user typo), or a duplicate of one above?',
        'Reply JSON: {"severity":"high|normal|low","duplicate_of":"<id from the list or empty>","push":true|false,"summary":"<one short sentence in Chinese for a phone notification>","likely_cause":"<one short sentence in Chinese>"}',
      ].join('\n')
      // 自动：按 Claude → Codex → cursor-agent 试，登录不上的（经 ssh 读不到钥匙串、没配令牌）换下一家，6 小时内先跳过它
      let r = { ok: false, err: '没有可用的 agent' }
      for (const agent of agents) {
        try { r = JSON.parse(await deps.bridgeSlow(`incident-triage ${b64(JSON.stringify({ agent, model: cfg.triage.agent !== 'auto' ? cfg.triage.model : '', wrapper: deps.defaultClaude(), prompt }))}`)) } catch (e) { r = { ok: false, err: e.message, agent } }
        if (r.ok) break
        if (r.auth) authFail.set(agent, now())
        else break // 不是登录问题（超时、输出不对）：不换家，免得一个问题烧好几份额度
      }
      if (!r.ok) { inc.ai = { error: String(r.err || 'failed').slice(0, 200), agent: r.agent, auth: !!r.auth, at: now() }; save(); continue }
      const o = r.result || {}
      const sev = ['high', 'normal', 'low'].includes(o.severity) ? o.severity : null
      const dup = typeof o.duplicate_of === 'string' && list.some((x) => x.id === o.duplicate_of && x.id !== inc.id) ? o.duplicate_of : ''
      inc.ai = { severity: sev, duplicateOf: dup || undefined, push: o.push !== false, summary: String(o.summary || '').slice(0, 200), cause: String(o.likely_cause || '').slice(0, 200), agent: r.agent, model: r.model, ms: r.ms, at: now() }
      if (dup || (sev === 'low' && o.push === false)) inc.aiQuiet = true
      if (sev === 'high' && inc.severity !== 'high') { inc.severity = 'high'; maybeNotify(inc) }
      console.log(`incident ${inc.id} triaged by ${r.agent}/${r.model} in ${r.ms}ms: ${sev}${dup ? ` dup of ${dup}` : ''} push=${o.push !== false}`)
      save()
    }
  } finally {
    triageBusy = false
  }
}
const authFail = new Map() // agent → 最近一次登录失败的时间
async function triageOrder() {
  let avail = AGENTS
  try { const a = JSON.parse((await deps.bridge('agent available')) || '[]'); if (Array.isArray(a) && a.length) avail = a } catch {}
  const order = ['claude', 'codex', 'cursor-agent'].filter((a) => avail.includes(a))
  const fresh = order.filter((a) => now() - (authFail.get(a) || 0) > 6 * 3600000)
  return fresh.length ? fresh : order
}

// ---------- 来自电脑端（events.jsonl kind=incident）----------
export function onMacEvent(ev) {
  const reporter = { agent: ev.agent || '', pane: isPaneId(ev.pane) ? terminalId(ev.pane) : null, session: ev.session || '', configDir: ev.configDir || '' }
  if (ev.op === 'update') return onUpdate(ev)
  if (ev.op !== 'report') return
  const isAgent = ev.source === 'agent'
  record({
    source: isAgent ? 'agent' : 'mac',
    component: String(ev.component || (isAgent ? 'agent' : 'mac')).slice(0, 60),
    kind: String(ev.ikind || 'report').slice(0, 60), // ev.kind 是事件类型（incident），问题类型在 ikind
    title: ev.title ? String(ev.title).slice(0, 120) : undefined,
    msg: String(ev.msg || ev.title || '').slice(0, 2000),
    detail: ev.detail ? String(ev.detail).slice(0, 6000) : undefined,
    severity: ev.severity === 'high' ? 'high' : ev.severity === 'low' ? 'low' : 'normal',
    ctx: { pane: reporter.pane, agent: reporter.agent },
    reporter: isAgent ? reporter : null,
    fixingId: typeof ev.fixing === 'string' ? ev.fixing : undefined,
  })
}

// agent 修复过程中的进度：investigating / needs-confirm / fixed / failed / wontfix
const UPDATE_STATUS = new Set(['investigating', 'needs-confirm', 'fixed', 'failed', 'wontfix'])
function onUpdate(ev) {
  const inc = list.find((x) => x.id === ev.id)
  if (!inc || !UPDATE_STATUS.has(ev.status)) return
  const u = { status: ev.status, note: String(ev.note || '').slice(0, 2000) }
  if (typeof ev.branch === 'string' && /^[\w./-]{1,100}$/.test(ev.branch)) u.branch = ev.branch
  if (typeof ev.pr === 'string' && /^https:\/\/\S{1,300}$/.test(ev.pr)) u.pr = ev.pr
  note(inc, u)
  if (isPaneId(ev.pane) && inc.fix.pane == null) inc.fix.pane = terminalId(ev.pane)
  if (ev.status === 'fixed') { inc.status = 'fixed'; inc.fix.state = 'done'; inc.fixedAt = now() }
  else if (ev.status === 'wontfix') { inc.status = 'ignored'; inc.fix.state = 'done' }
  else if (ev.status === 'failed') { inc.status = 'open'; inc.fix.state = 'failed' }
  else inc.fix.state = 'running'
  if (ev.status !== 'investigating' && !inc.test) {
    const head = { fixed: '修好了', failed: '没修成', 'needs-confirm': '修复要你确认', wontfix: '不打算修' }[ev.status]
    push({ title: `${head}：${inc.title}`, body: (u.pr ? `${u.pr} · ` : u.branch ? `分支 ${u.branch} · ` : '') + (u.note || '').slice(0, 160), incident: inc.id })
  }
  save()
}

// ---------- 修复 ----------
const cleanCmd = (s) => String(s || '').replace(/[^\w ./~="$-]/g, '')
function brief(inc) {
  const L = [`# pane-remote incident ${inc.id}`, '',
    `- 标题：${inc.title}`, `- 来源：${inc.source} · 模块：${inc.component} · 类型：${inc.kind}`,
    `- 次数：${inc.count}（第一次 ${new Date(inc.first).toISOString()}，最近 ${new Date(inc.last).toISOString()}）${inc.regressed ? '，修好后又出现过' : ''}`,
    inc.reporter ? `- 报告方：${inc.reporter.agent || '?'}（pane ${inc.reporter.pane ?? '?'}）` : '', '',
    '## 最近几次', '']
  for (const s of inc.samples) {
    L.push(`### ${new Date(s.t).toISOString()}`, '', '```', s.msg || '', '```')
    if (s.detail) L.push('', '```', s.detail, '```')
    if (s.ctx) L.push('', `上下文：\`${JSON.stringify(s.ctx)}\``)
    L.push('')
  }
  if (inc.fix?.updates?.length) {
    L.push('## 之前的修复记录', '')
    for (const u of inc.fix.updates) L.push(`- ${new Date(u.t).toISOString()} [${u.status}] ${u.note || ''}${u.branch ? ` 分支 ${u.branch}` : ''}${u.pr ? ` ${u.pr}` : ''}`)
    L.push('')
  }
  L.push('## 要做的', '',
    `按 pane-remote skill 的「Fixing a pane-remote incident」处理：先 incident_update(id="${inc.id}", status="investigating")，`,
    '在单独的分支 / git worktree 上复现、修复、跑测试；部署、推送、开 PR、合并之前都用 ask_phone 问用户；',
    '最后 incident_update 报 fixed（带分支或 PR 链接）/ failed / wontfix，附一句说明。')
  return L.filter((x) => x !== '').join('\n').replace(/\n(#+ )/g, '\n\n$1') + '\n'
}

async function locate(session) {
  try { return JSON.parse((await deps.bridge(`agent locate ${session}`)) || '{}') } catch { return {} }
}
function deliverText(inc, file) {
  return `[pane-remote incident ${inc.id}] 读 ${file}，按 pane-remote skill 的「Fixing a pane-remote incident」处理这个问题。`
}

/** 交给 agent 修。返回 { mode, state, pane? } */
export async function fix(id, opts = {}) {
  const inc = list.find((x) => x.id === id)
  if (!inc) throw new Error('没有这个问题')
  if (deps.noFixer) throw new Error('这个实例不派修复（noFixer）')
  if (inc.fix && (inc.fix.state === 'running' || inc.fix.state === 'queued') && now() - inc.fix.started < 6 * 3600000 && !opts.force) return inc.fix
  const file = (await deps.bridge(`incident-brief ${inc.id} ${b64(brief(inc))}`)).trim()
  if (!file.startsWith('/') || /['\n]/.test(file)) throw new Error('写问题简报失败')
  const mode = opts.mode || (cfg.fixer === 'new' ? 'new' : cfg.fixer === 'bound' || cfg.bound ? 'bound' : 'new')
  inc.status = 'fixing'
  const prevUpdates = inc.fix?.updates || []
  if (mode === 'bound') {
    if (!cfg.bound?.session) throw new Error('还没有绑定修复会话')
    inc.fix = { mode, state: 'queued', started: now(), session: cfg.bound.session, agent: cfg.bound.agent, file, updates: prevUpdates }
    await tryDeliver(inc)
  } else {
    inc.fix = { mode: 'new', state: 'running', started: now(), file, updates: prevUpdates }
    const r = await spawnNew(inc, file)
    Object.assign(inc.fix, r)
  }
  save()
  return inc.fix
}

/** 绑定的会话：空闲就把问题发进去；在干活就继续排队；没在运行就在新标签页恢复它（带插件和这句话） */
async function tryDeliver(inc) {
  const b = cfg.bound
  const loc = await locate(b.session)
  if (loc.pane != null) {
    if (loc.status !== 'idle') { inc.fix.state = 'queued'; inc.fix.pane = loc.pane; return }
    await deps.bridge(`send ${loc.pane} ${b64(deliverText(inc, inc.fix.file))}`)
    await new Promise((r) => setTimeout(r, 150))
    await deps.bridge(`send ${loc.pane} ${b64('\r')}`)
    Object.assign(inc.fix, { state: 'running', pane: loc.pane, deliveredAt: now() })
    console.log(`incident ${inc.id} → bound session pane ${loc.pane}`)
    return
  }
  // 不在运行：在它原来的目录恢复（上下文还在）
  const prompt = deliverText(inc, inc.fix.file)
  const base = b.agent === 'codex' ? `codex resume ${b.session}` : b.agent === 'cursor-agent' ? `cursor-agent --resume ${b.session}` : `${deps.claudeCommand(b.configDir)} --resume ${b.session}`
  const r = await deps.manage('spawn', { window: await someWindow(inc.test), dir: b.cwd, command: `PANE_REMOTE_INCIDENT=${inc.id} ${base} '${prompt}'`, inject: true })
  Object.assign(inc.fix, { state: 'running', pane: r.pane, deliveredAt: now(), resumed: true })
  console.log(`incident ${inc.id} → resumed bound session in pane ${r.pane}`)
}

async function someWindow(test = false) {
  // 测试 workspace 里报的问题，修复也开在测试 workspace 里（自动化测试不碰你正在用的窗口）
  try {
    const p = (await deps.listPanes()).find((x) => (x.workspace === 'pane-remote-test') === test)
    return p ? String(p.window) : 'new'
  } catch { return 'new' }
}

/** 选 agent：配置指定 > 报告方用的那家 > Claude；电脑上没装就按 Claude → Codex → cursor-agent 找装了的 */
async function pickAgent(inc) {
  let avail = AGENTS
  try { const a = JSON.parse((await deps.bridge('agent available')) || '[]'); if (Array.isArray(a) && a.length) avail = a } catch {}
  const want = [cfg.agent !== 'auto' ? cfg.agent : null, inc.reporter?.agent, 'claude', 'codex', 'cursor-agent'].filter((a) => AGENTS.includes(a))
  return want.find((a) => avail.includes(a)) || 'claude'
}

async function spawnNew(inc, file) {
  const agent = await pickAgent(inc)
  const dir = (await deps.bridge('incident-repo')).trim()
  if (!dir.startsWith('/')) throw new Error('找不到 pane-remote 仓库目录')
  const exe = agent === 'claude' ? (inc.reporter?.agent === 'claude' && inc.reporter.configDir ? deps.claudeCommand(inc.reporter.configDir) : deps.defaultClaude()) : agent
  const prompt = deliverText(inc, file)
  const r = await deps.manage('spawn', { window: await someWindow(inc.test), dir, command: `PANE_REMOTE_INCIDENT=${inc.id} ${cleanCmd(exe)} '${prompt}'`, inject: true })
  console.log(`incident ${inc.id} → new ${agent} session in pane ${r.pane}`)
  return { agent, pane: r.pane, dir }
}

async function tick() {
  for (const inc of list) {
    // 新开的修复会话头几分钟停在「信任这个目录吗」：这得你来点，提醒一次
    const f = inc.fix
    if (f?.state === 'running' && f.pane != null && (f.mode === 'new' || f.resumed) && !f.trustNoted && now() - f.started < 180000) {
      const text = await deps.bridge(`text ${f.pane} 30`).catch(() => '')
      if (/Is this a project you created or one you trust|Do you trust the (files|contents)|trust this folder/i.test(text)) {
        f.trustNoted = true
        note(inc, { status: 'needs-confirm', note: `修复会话 #${f.pane} 在等你确认信任这个目录（只需要一次）` })
        if (!inc.test) push({ title: `修复要你确认：${inc.title}`, body: `#${f.pane} 第一次在 pane-remote 仓库里开 agent，要你确认信任这个目录`, incident: inc.id })
        save()
      }
    }
    // 排队期间问题已经被解决 / 忽略 / 修好了：不再发给绑定会话
    if (inc.fix?.state === 'queued' && ['resolved', 'ignored', 'fixed'].includes(inc.status)) {
      inc.fix.state = 'cancelled'
      note(inc, { status: 'cancelled', note: `排队期间问题已经${{ resolved: '标成已解决', ignored: '被忽略', fixed: '修好了' }[inc.status]}，不再交给会话` })
      save()
      continue
    }
    if (inc.fix?.state === 'queued' && inc.fix.mode === 'bound' && cfg.bound?.session === inc.fix.session) {
      // 失败就停在 failed，不在下一轮反复开新标签页
      await tryDeliver(inc).catch((e) => { console.log(`incident deliver ${inc.id}: ${e.message}`); inc.fix.state = 'failed'; inc.status = 'open'; note(inc, { status: 'failed', note: `交给绑定会话失败：${e.message}` }) })
      save()
    }
  }
}

// ---------- API ----------
const summary = (x) => ({ id: x.id, title: x.title, source: x.source, component: x.component, kind: x.kind, severity: x.severity, count: x.count, first: x.first, last: x.last,
  status: x.status, muted: x.muted, test: x.test, ai: x.ai?.summary ? { summary: x.ai.summary, severity: x.ai.severity, duplicateOf: x.ai.duplicateOf } : undefined, fix: x.fix ? { mode: x.fix.mode, state: x.fix.state, pane: x.fix.pane, agent: x.fix.agent, last: x.fix.updates?.at(-1) } : null, lastMsg: x.samples[0]?.msg?.slice(0, 200) })
const visible = (x, test) => test || !x.test
export const openCount = () => list.filter((x) => !x.test && (x.status === 'open' || x.status === 'fixing') && !x.muted).length

export async function api(method, sub, body, query) {
  const test = query?.has?.('test')
  if (method === 'GET' && sub === '') return { open: openCount(), config: { ...cfg, triageUsage: cfg.triageUsage.day === today() ? cfg.triageUsage : { day: today(), n: 0 } }, incidents: query?.has?.('summary') ? undefined : list.filter((x) => visible(x, test)).slice(0, 100).map(summary) }
  if (sub === 'config') {
    if (method === 'GET') return cfg
    const next = { ...cfg }
    if (['auto', 'bound', 'new'].includes(body.fixer)) next.fixer = body.fixer
    if (['auto', ...AGENTS].includes(body.agent)) next.agent = body.agent
    if (body.bound === null) next.bound = null
    else if (body.bound && typeof body.bound === 'object') {
      const b = body.bound
      if (!/^[0-9a-zA-Z-]{8,64}$/.test(String(b.session)) || !AGENTS.includes(b.agent) || typeof b.cwd !== 'string' || !b.cwd.startsWith('/') || /['\n]/.test(b.cwd)) throw new Error('bad bound session')
      next.bound = { session: b.session, agent: b.agent, cwd: b.cwd, configDir: String(b.configDir || ''), label: String(b.label || '').slice(0, 80), at: now() }
    }
    if (body.triage && typeof body.triage === 'object') {
      const t = { ...cfg.triage }
      if (typeof body.triage.enabled === 'boolean') t.enabled = body.triage.enabled
      if (['auto', ...AGENTS].includes(body.triage.agent)) t.agent = body.triage.agent
      if (typeof body.triage.model === 'string' && /^[\w.:-]{0,60}$/.test(body.triage.model)) t.model = body.triage.model
      if (Number.isInteger(body.triage.daily) && body.triage.daily >= 0 && body.triage.daily <= 200) t.daily = body.triage.daily
      next.triage = t
    }
    if (next.fixer === 'bound' && !next.bound) throw new Error('先绑定一个会话')
    cfg = next
    save()
    return cfg
  }
  if (method === 'POST' && sub === 'report') {
    // 手机上手动报告：不推送（就是你自己报的），可以马上点修复
    const title = String(body.title || '').trim().slice(0, 120)
    if (!title) throw new Error('写一句是什么问题')
    const inc = record({ source: 'user', component: String(body.component || 'phone').slice(0, 60), kind: 'manual', title, msg: title, detail: String(body.detail || '').slice(0, 6000), ctx: body.ctx && typeof body.ctx === 'object' ? body.ctx : undefined })
    return summary(inc)
  }
  const m = /^([0-9a-f]{12})(?:\/(action))?$/.exec(sub)
  if (!m) throw new Error('not found')
  const inc = list.find((x) => x.id === m[1])
  if (!inc) throw new Error('没有这个问题')
  if (method === 'GET' && !m[2]) return inc
  if (method === 'POST' && m[2]) {
    const a = body.action
    if (a === 'fix') return { ok: true, fix: await fix(inc.id, { mode: ['bound', 'new'].includes(body.mode) ? body.mode : undefined, force: body.force === true }) }
    if (a === 'triage') { if (!cfg.triage?.enabled) throw new Error('AI 分类没开'); inc.ai = null; triageQueue.push(inc.id); await runTriage(); return { ok: true, ai: inc.ai } }
    if (a === 'cancel-fix') { if (inc.fix) { inc.fix.state = 'cancelled'; note(inc, { status: 'cancelled', note: '手机上取消' }) } inc.status = 'open'; save(); return { ok: true } }
    if ((a === 'ignore' || a === 'resolve') && inc.fix?.state === 'queued') { inc.fix.state = 'cancelled'; note(inc, { status: 'cancelled', note: a === 'resolve' ? '标成已解决，取消排队中的修复' : '忽略了，取消排队中的修复' }) }
    if (a === 'ignore') inc.status = 'ignored'
    else if (a === 'resolve') inc.status = 'resolved'
    else if (a === 'reopen') { inc.status = 'open'; inc.notified = null }
    else if (a === 'mute') inc.muted = true
    else if (a === 'unmute') inc.muted = false
    else throw new Error('bad action')
    save()
    return { ok: true, incident: summary(inc) }
  }
  throw new Error('not found')
}

/** 进程要崩了：同步写盘 */
export function flush() { save(true) }
