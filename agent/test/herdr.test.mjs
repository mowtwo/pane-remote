// Exercise the real bridge, hook, host and HTTP server against a private protocol fixture.
// These tests never connect to the user's Herdr socket or start a real Herdr session.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { isPaneId, isWindowId, terminalId } from '../../lib/terminal-id.mjs'
import { paneContext } from '../../lib/pane-context.mjs'
import { HostClient } from '../../server/host-client.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const tmp = fs.mkdtempSync('/tmp/pr-herdr-')
const sock = path.join(tmp, 'herdr.sock')
const config = path.join(tmp, 'config.json')
const bridgeEnv = path.join(tmp, 'bridge.env')
const env = { ...process.env, HOME: tmp, PANE_REMOTE_CONFIG: config, PANE_REMOTE_BRIDGE_ENV: bridgeEnv, HERDR_PANE_ID: '', HERDR_SOCKET_PATH: '', WEZTERM_PANE: '', PANE_HOST: '0', TEST_LOGIN: 'test@example.com', ALLOW_HOST_ACCESS: '1' }
const b64 = (s) => Buffer.from(s).toString('base64')
const bridge = (cmd, overrides = {}) => run(path.join(root, 'agent/bridge'), [], { env: { ...env, ...overrides, SSH_ORIGINAL_COMMAND: cmd }, timeout: 8000 })
const requests = []
let screen = '\x1b[32m你好\x1b[0m\n$ '
let rejectNext = false
let shellPid = 424242
const pane = { pane_id: 'w1:p2', terminal_id: 'term_fixture', workspace_id: 'w1', tab_id: 'w1:t3', focused: true, agent_status: 'idle', revision: 1, cwd: tmp, foreground_cwd: path.join(tmp, '100% done'), title: 'shell', label: '开发', agent: 'codex' }
const snapshot = { version: '0.9.5', protocol: 22, focused_pane_id: pane.pane_id, workspaces: [{ workspace_id: 'w1', label: '项目' }], tabs: [{ tab_id: 'w1:t3', label: '测试' }], panes: [pane], layouts: [{ panes: [{ pane_id: pane.pane_id, rect: { width: 100, height: 30, x: 0, y: 0 } }] }], agents: [{ pane_id: pane.pane_id, agent: 'codex', name: 'reviewer' }] }
const server = net.createServer((conn) => {
  conn.on('error', () => {})
  let buf = ''
  conn.setEncoding('utf8')
  conn.on('data', (chunk) => {
    buf += chunk
    if (!buf.includes('\n')) return
    const request = JSON.parse(buf.split('\n')[0]); requests.push(request)
    const { method, params, id } = request
    let result
    if (rejectNext) { rejectNext = false; conn.end(JSON.stringify({ id, error: { code: 'pane_not_found', message: 'fixture gone' } }) + '\n'); return }
    switch (method) {
      case 'session.snapshot': result = { type: 'session_snapshot', snapshot }; break
      case 'pane.process_info': result = { type: 'pane_process_info', process_info: { pane_id: params.pane_id, tty: null, shell_pid: shellPid, foreground_process_group_id: 424242, foreground_processes: [{ pid: 424242, name: 'zsh', cmdline: '/bin/zsh' }] } }; break
      case 'pane.get': result = { type: 'pane_info', pane }; break
      case 'pane.read': result = { type: 'pane_read', read: { text: screen } }; break
      case 'workspace.create': case 'tab.create': result = { type: method === 'tab.create' ? 'tab_created' : 'workspace_created', root_pane: { ...pane, pane_id: 'w2:p1' } }; break
      case 'pane.split': result = { type: 'pane_info', pane: { ...pane, pane_id: 'w1:p4' } }; break
      case 'pane.send_text': case 'pane.focus': case 'pane.close': case 'tab.rename': result = { type: 'ok' }; break
      default: conn.end(JSON.stringify({ id, error: { code: 'unknown_method', message: method } }) + '\n'); return
    }
    conn.end(JSON.stringify({ id, result }) + '\n')
  })
})
let httpServer, base, log = ''
const children = new Set()
function child(file, args, options) { const p = spawn(file, args, options); children.add(p); p.once('exit', () => children.delete(p)); return p }
async function waitFor(fn) {
  for (let i = 0; i < 240; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timeout: ' + log)
}
async function post(route, body) {
  const r = await fetch(base + route, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
before(async () => {
  fs.writeFileSync(bridgeEnv, `TERMINAL_BACKEND=herdr\nHERDR_SOCKET=${sock}\nWEZTERM=/does-not-exist\nNODE=${process.execPath}\n`)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve) })
  fs.writeFileSync(config, JSON.stringify({ mode: 'local', port: 0, serveHosts: ['127.0.0.1'], allowedLogins: ['test@example.com'], dataDir: path.join(tmp, 'data'), paneHost: false, modules: { preview: false, plugins: false, cursor: false, screen: false, mac: false } }))
  httpServer = child(process.execPath, ['server/server.mjs'], { cwd: root, env: { ...env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  httpServer.stdout.on('data', (d) => { log += d }); httpServer.stderr.on('data', (d) => { log += d })
  // server logs the requested port (0), so ask lsof for this test process's actual listener.
  await waitFor(async () => {
    try {
      const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(httpServer.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'])
      const m = stdout.match(/n127\.0\.0\.1:(\d+)/)
      if (m) { base = `http://127.0.0.1:${m[1]}`; return true }
    } catch {}
    return false
  })
})
after(async () => {
  await Promise.all([...children].map((p) => { const done = once(p, 'exit'); p.kill(); return done }))
  await new Promise((r) => server.close(r))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('opaque IDs reject whitespace, shell syntax and wrong resource kinds', () => {
  for (const id of [0, 12, 'w1:p2', 'w100:p1234567', 'wA:pB', 'w0:pZ']) assert.ok(isPaneId(id))
  for (const id of ['', null, {}, 'w1', 'w1:t2', 'w1:p2\n', 'w1:p2;id', 'wI:p1', 'w1:pU', 'w1:pO', '1 2', -1]) assert.equal(isPaneId(id), false, String(id))
  assert.ok(isWindowId('w1')); assert.equal(isWindowId('w1:p2'), false)
  assert.equal(terminalId('12'), 12); assert.equal(terminalId('w1:p2'), 'w1:p2')
})

test('bridge list maps workspace/tab/geometry and percent-containing cwd without WezTerm', async () => {
  const list = JSON.parse((await bridge('list')).stdout)
  assert.equal(list[0].pane_id, 'w1:p2'); assert.equal(list[0].window_id, 'w1')
  assert.equal(list[0].tab_title, '测试'); assert.equal(list[0].title, '开发')
  assert.deepEqual(list[0].size, { cols: 100, rows: 30 })
  assert.equal(fileURLToPath(list[0].cwd), pane.foreground_cwd)
  assert.equal(list[0].capabilities.width, false)
  assert.deepEqual(list[0].terminal_agent, { kind: 'codex', name: 'reviewer' })
  assert.equal((await bridge('mode')).stdout.trim(), 'herdr')
})

test('agent identity follows the pane, with unnamed agents and ordinary terminals kept distinct', async () => {
  const savedAgent = pane.agent
  const savedAgents = snapshot.agents
  try {
    snapshot.agents = [{ pane_id: 'w2:p2', agent: 'claude', name: 'other-workspace' }]
    assert.deepEqual(JSON.parse((await bridge('list')).stdout)[0].terminal_agent, { kind: 'codex', name: '' })
    delete pane.agent
    assert.equal(JSON.parse((await bridge('list')).stdout)[0].terminal_agent, null)
  } finally { pane.agent = savedAgent; snapshot.agents = savedAgents }
})

test('raw UTF-8 input preserves Enter, escape keys, NUL and bracketed-paste boundaries', async () => {
  const text = '你好\r\x1b[A\x00\x1b[200~multi\nline\x1b[201~'
  await bridge(`send w1:p2 ${b64(text)}`)
  assert.deepEqual(requests.at(-1).params, { pane_id: 'w1:p2', text })
  assert.equal(requests.at(-1).method, 'pane.send_text')
  await bridge(`send wA:pB ${b64(text)}`)
  assert.equal(requests.at(-1).params.pane_id, 'wA:pB')
  assert.equal((await bridge('ansi w1:p2 300')).stdout, screen)
  assert.deepEqual(requests.at(-1).params, { pane_id: 'w1:p2', source: 'recent', lines: 300, format: 'ansi', strip_ansi: false })
})

test('plain text snapshots stay passive and strip terminal formatting', async () => {
  const previous = screen
  try {
    screen = '\x1b[32m你好\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\n$ '
    assert.equal((await bridge('text w1:p2 200')).stdout, '你好 link\n$ ')
    assert.deepEqual(requests.at(-1).params, { pane_id: 'w1:p2', source: 'recent', lines: 200, format: 'ansi', strip_ansi: false })
  } finally { screen = previous }
})

test('TTY and exact dimensions recover from shell_pid when Herdr returns tty:null', async () => {
  const helper = child('/usr/bin/python3', ['-u', '-c', `import pty, os, sys, json, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    print(os.ttyname(0), flush=True)
    os.execl('/bin/sleep', 'sleep', '60')
try:
    tty = os.read(fd, 256).decode().strip()
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 29, 101, 0, 0))
    print(json.dumps({'pid': pid, 'tty': tty}), flush=True)
    sys.stdin.read()
finally:
    os.kill(pid, 15)
    os.waitpid(pid, 0)
    os.close(fd)
`], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; helper.stdout.on('data', (d) => { output += d })
  try {
    await waitFor(() => output.includes('\n'))
    const fixture = JSON.parse(output.trim())
    shellPid = fixture.pid
    const list = JSON.parse((await bridge('list')).stdout)
    assert.equal(list[0].tty_name, fixture.tty)
    assert.deepEqual(list[0].size, { cols: 101, rows: 29 })
  } finally {
    shellPid = 424242
    const ended = once(helper, 'exit'); helper.stdin.end(); await ended
  }
})

test('explicit workspace creation, tabs, splits, rename, focus and close', async () => {
  assert.equal((await bridge(`spawn new ${b64(tmp)}`)).stdout.trim(), 'w2:p1')
  assert.deepEqual(requests.at(-1).params, { cwd: tmp, focus: false })
  await bridge(`spawn w1 ${b64(tmp)}`)
  assert.deepEqual(requests.at(-1).params, { workspace_id: 'w1', cwd: tmp, focus: false })
  assert.equal((await bridge(`split w1:p2 bottom ${b64(tmp)}`)).stdout.trim(), 'w1:p4')
  assert.deepEqual(requests.at(-1).params, { target_pane_id: 'w1:p2', direction: 'down', cwd: tmp, focus: false })
  await bridge(`title w1:p2 ${b64('标题')}`)
  assert.deepEqual(requests.at(-1).params, { tab_id: 'w1:t3', label: '标题' })
  for (const [cmd, method] of [['focus', 'pane.focus'], ['kill', 'pane.close']]) {
    await bridge(`${cmd} w1:p2`); assert.equal(requests.at(-1).method, method)
    assert.deepEqual(requests.at(-1).params, { pane_id: 'w1:p2' })
  }
})

test('bad arguments cause no socket request; failed mutations are not retried', async () => {
  for (const cmd of ['kill 12', 'kill w1:p2 extra', 'send w1:p2 !!!', 'text w1:p2 -1', `split w1:p2 left ${b64(tmp)}`, 'width w1:p2 eq', 'server.stop']) {
    const count = requests.length
    await assert.rejects(bridge(cmd)); assert.equal(requests.length, count, cmd)
  }
  rejectNext = true
  const count = requests.length
  await assert.rejects(bridge(`send w1:p2 ${b64('x')}`), /fixture gone/)
  assert.equal(requests.length, count + 1)
})

test('watch emits initial frame and later deltas and exits when its consumer closes', async () => {
  const p = child(path.join(root, 'agent/bridge'), [], { env: { ...env, SSH_ORIGINAL_COMMAND: 'watch w1:p2 200' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; p.stdout.on('data', (d) => { output += d })
  await waitFor(() => output.includes('\x1d'))
  assert.equal(output, screen + '\x1d')
  screen = 'changed\n$ '
  await waitFor(() => output.includes(screen + '\x1d'))
  p.stdout.destroy(); screen = 'closed'
  await waitFor(() => p.exitCode !== null)
  screen = 'ready\n$ '
})

test('hook and MCP choose the configured inner pane and reject another Herdr server', async () => {
  const nested = { ...env, HERDR_PANE_ID: 'w1:p2', HERDR_SOCKET_PATH: sock, WEZTERM_PANE: '7' }
  assert.equal(paneContext(nested).pane, 'w1:p2')
  const input = JSON.stringify({ session_id: 'test-session', message: 'done', cwd: tmp })
  const hook = (extra) => new Promise((resolve, reject) => {
    const p = child('/usr/bin/python3', ['agent/pane-event', 'stop'], { cwd: root, env: { ...nested, ...extra }, stdio: ['pipe', 'ignore', 'pipe'] })
    p.on('error', reject); p.on('exit', (code) => code ? reject(new Error(`hook: ${code}`)) : resolve()); p.stdin.end(input)
  })
  await hook({})
  const events = path.join(tmp, '.local/state/pane-remote/events.jsonl')
  assert.equal(JSON.parse(fs.readFileSync(events, 'utf8').trim()).pane, 'w1:p2')
  const previous = fs.readFileSync(events, 'utf8')
  await hook({ HERDR_SOCKET_PATH: '/tmp/unrelated.sock' })
  assert.equal(fs.readFileSync(events, 'utf8'), previous)
  assert.deepEqual(paneContext({ ...nested, HERDR_SOCKET_PATH: '/tmp/unrelated.sock' }), { pane: null, allowTty: false })
  const wez = path.join(tmp, 'wez.env'); fs.writeFileSync(wez, 'TERMINAL_BACKEND=wezterm\n')
  assert.equal(paneContext({ ...nested, PANE_REMOTE_BRIDGE_ENV: wez }).pane, 7)
  await hook({ PANE_REMOTE_BRIDGE_ENV: wez })
  assert.equal(JSON.parse(fs.readFileSync(events, 'utf8').trim().split('\n').at(-1)).pane, 7)
})

test('HTTP list, input, spawn, split, session and reconnect preserve Herdr IDs', async () => {
  const list = await (await fetch(base + '/api/panes')).json()
  assert.equal(list[0].pane, 'w1:p2'); assert.equal(list[0].dir, pane.foreground_cwd)
  assert.deepEqual(list[0].terminalAgent, { kind: 'codex', name: 'reviewer' })
  let response = await post('/api/send', { pane: 'w1:p2', data: '中文\r' })
  assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(requests.at(-1).params.text, '中文\r')
  response = await post('/api/pane/spawn', { window: 'w1', dir: tmp })
  assert.deepEqual(response.body, { pane: 'w2:p1' })
  response = await post('/api/pane/split', { pane: 'w1:p2', direction: 'right', dir: tmp })
  assert.deepEqual(response.body, { pane: 'w1:p4' })
  response = await post('/api/reconnect', { pane: 'w1:p2' }); assert.equal(response.status, 200)
  assert.equal((await fetch(base + '/api/claude?pane=w1:p2')).status, 200)
  response = await post('/api/send', { pane: 'w1:p2;id', data: 'bad' }); assert.equal(response.status, 400)
})

test('pane-host adapter uses the same bridge configuration', async () => {
  const code = `const {createHost} = await import('./host/hosts/macos/index.mjs'); const h=createHost(); console.log(JSON.stringify({panes:await h.terminals.list(), text:await h.terminals.text('w1:p2')}))`
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env })
  const result = JSON.parse(stdout)
  assert.equal(result.panes[0].pane, 'w1:p2'); assert.equal(result.panes[0].dir, pane.foreground_cwd)
  assert.deepEqual(result.panes[0].terminalAgent, { kind: 'codex', name: 'reviewer' })
  assert.equal(result.text, screen)
})


test('session transcripts and pane-host subscriptions accept letter-bearing IDs', async () => {
  const transcript = path.join(tmp, 'claude.jsonl')
  const record = (id, text) => JSON.stringify({ type: 'assistant', uuid: id, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  fs.writeFileSync(transcript, record('first', 'Herdr transcript'))
  const state = path.join(tmp, '.local/state/pane-remote')
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, 'panes.json'), JSON.stringify({ 'wA:pB': { agent: 'claude', session: 'fixture-session', transcript, cwd: tmp } }))
  const messages = JSON.parse((await bridge('transcript wA:pB 60')).stdout)
  assert.equal(messages.messages[0].parts[0].text, 'Herdr transcript')
  const inspect = JSON.parse((await bridge('agent inspect wA:pB')).stdout)
  assert.equal(inspect.pane, 'wA:pB')
  const hostEnv = { ...env, PANE_HOST_DIR: path.join(tmp, 'host'), PANE_REMOTE_STATE: state }
  const host = child(process.execPath, ['host/main.mjs'], { cwd: root, env: hostEnv, stdio: 'ignore' })
  await waitFor(() => fs.existsSync(path.join(tmp, 'host/host.sock')))
  const client = new HostClient({ spawn: () => child(process.execPath, ['host/connect.mjs'], { cwd: root, env: hostEnv, stdio: ['pipe', 'pipe', 'pipe'] }), log: () => {} })
  try {
    client.start(); await waitFor(() => client.connected)
    const result = await client.call('transcript.get', { pane: 'wA:pB', n: 60 })
    assert.equal(result.session.session, 'fixture-session')
    assert.equal(result.messages[0].parts[0].text, 'Herdr transcript')
    const events = []
    const subscription = client.subscribe('transcript:wA:pB:60', { since: 0, onEvent: (e) => events.push(e) })
    await waitFor(() => subscription.live && events.some((e) => e.data?.full?.length === 1))
    fs.appendFileSync(transcript, record('second', 'pushed update'))
    await waitFor(() => events.some((e) => JSON.stringify(e.data).includes('pushed update')))
    subscription.close()
  } finally {
    client.stop(); const exited = once(host, 'exit'); host.kill(); await exited
  }
})

test('config refresh persists backend and socket without requiring WezTerm', async () => {
  const dir = path.join(tmp, 'refresh'); fs.mkdirSync(dir)
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ terminalBackend: 'herdr', paths: { herdrSocket: sock } }))
  await run(process.execPath, ['lib/cli.mjs', 'refresh', 'bridge-env'], { cwd: root, env: { ...env, PANE_REMOTE_CONFIG: file } })
  const result = fs.readFileSync(path.join(dir, 'bridge.env'), 'utf8')
  assert.ok(result.includes('TERMINAL_BACKEND=herdr\n'))
  assert.ok(result.includes(`HERDR_SOCKET=${sock}\n`))
  fs.writeFileSync(file, JSON.stringify({ terminalBackend: 'herdr', paths: { herdrSocket: 'relative.sock' } }))
  await assert.rejects(run(process.execPath, ['lib/cli.mjs', 'refresh', 'bridge-env'], { cwd: root, env: { ...env, PANE_REMOTE_CONFIG: file } }), /absolute path/)
  assert.equal(fs.readFileSync(path.join(dir, 'bridge.env'), 'utf8'), result)
})


test('Herdr MCP ask events reach the phone and answers return to the originating request', async () => {
  await fetch(base + '/api/states?test')
  await waitFor(() => fs.existsSync(path.join(tmp, 'data/events-offset.json')))
  const id = 'a'.repeat(24)
  const events = path.join(tmp, '.local/state/pane-remote/events.jsonl')
  fs.mkdirSync(path.dirname(events), { recursive: true })
  fs.appendFileSync(events, JSON.stringify({ t: Date.now() / 1000, kind: 'agent', op: 'ask', pane: 'w1:p2', id,
    question: 'Continue fixture?', options: ['Continue', 'Cancel'], expires: Date.now() / 1000 + 30 }) + '\n')
  await waitFor(async () => (await (await fetch(base + '/api/states?test')).json())['w1:p2']?.asks?.some((a) => a.id === id))
  const reply = await post('/api/agent/answer', { id, answer: 'Continue' })
  assert.equal(reply.status, 200)
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.local/state/pane-remote/agent/answers', id + '.json'), 'utf8'))
  assert.equal(saved.answer, 'Continue')
})

test('diagnostic MCP does not overwrite an inherited live Herdr pane marker', async () => {
  const live = path.join(tmp, '.local/state/pane-remote/agent/live/w1:p2.json')
  fs.mkdirSync(path.dirname(live), { recursive: true })
  fs.writeFileSync(live, JSON.stringify({ pid: 123, agent: 'codex' }))
  const p = child(process.execPath, ['agent/plugin/mcp-server.mjs'], { cwd: root,
    env: { ...env, PANE_REMOTE_AGENT: 'canary', HERDR_PANE_ID: 'w1:p2', HERDR_SOCKET_PATH: sock }, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; p.stdout.on('data', (d) => { output += d })
  p.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
  await waitFor(() => output.includes('"result"'))
  await waitFor(() => p.exitCode !== null)
  assert.equal(JSON.parse(fs.readFileSync(live, 'utf8')).pid, 123)
})

test('MCP launcher resolves Node from PANE_REMOTE_CONFIG without a bridge override', async () => {
  const dir = path.join(tmp, 'custom-mcp'); fs.mkdirSync(dir)
  const node = path.join(dir, 'node-stub')
  fs.writeFileSync(node, '#!/bin/sh\nprintf configured-node\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'bridge.env'), 'NODE=' + node + '\n')
  const { stdout } = await run(path.join(root, 'agent/plugin/bin/mcp'), [], {
    env: { ...env, PATH: '/usr/bin:/bin', PANE_REMOTE_BRIDGE_ENV: '', PANE_REMOTE_CONFIG: path.join(dir, 'config.json') } })
  assert.equal(stdout, 'configured-node')
})


test('URL forwarding records the selected Herdr pane instead of an outer WezTerm pane', async () => {
  await run(path.join(root, 'agent/pane-open'), ['https://example.com/herdr'], {
    env: { ...env, PANE_OPEN_FORCE: 'phone', HERDR_PANE_ID: 'wA:pB', HERDR_SOCKET_PATH: sock, WEZTERM_PANE: '7' } })
  const event = JSON.parse(fs.readFileSync(path.join(tmp, '.local/state/pane-remote/events.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.equal(event.pane, 'wA:pB')
  assert.equal(event.kind, 'open')
  assert.equal(event.msg, 'https://example.com/herdr')
})


test('MCP tool schemas accept native IDs and read_pane returns passive plaintext', async () => {
  const p = child(process.execPath, ['agent/plugin/mcp-server.mjs'], { cwd: root,
    env: { ...env, PANE_REMOTE_AGENT: 'canary' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; p.stdout.on('data', (d) => { output += d })
  const responses = () => output.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  try {
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
    await waitFor(() => output.endsWith('\n') && responses().some((r) => r.id === 1))
    const tools = responses().find((r) => r.id === 1).result.tools
    for (const name of ['read_pane', 'send_to_pane']) {
      const schema = tools.find((t) => t.name === name).inputSchema.properties.pane
      assert.ok(schema.anyOf.some((s) => s.type === 'integer'))
      const native = schema.anyOf.find((s) => s.type === 'string')
      assert.ok(new RegExp(native.pattern).test('wA:pB'))
      assert.equal(new RegExp(native.pattern).test('wA:pB\n'), false)
    }
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_pane', arguments: { pane: 'w1:p2', lines: 80 } } }) + '\n')
    await waitFor(() => output.endsWith('\n') && responses().some((r) => r.id === 2))
    const read = responses().find((r) => r.id === 2).result
    assert.ok(!read.isError, JSON.stringify(read))
    assert.equal(read.content[0].text, screen.trimEnd())
    assert.ok(requests.some((r) => r.method === 'pane.read' && r.params.pane_id === 'w1:p2' && r.params.format === 'ansi'))
  } finally {
    const ended = once(p, 'exit'); p.stdin.end(); await ended
  }
})
