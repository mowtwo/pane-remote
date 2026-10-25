import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { changeTerminal, servedURL } from '../../lib/terminal-settings.mjs'
const exec = promisify(execFile)

function fixture(t, running = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-menu-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const configPath = path.join(dir, 'config.json'), bridgePath = path.join(dir, 'bridge.env')
  const config = { mode: 'local', terminalBackend: 'herdr', port: 8787, modules: { plugins: true }, allowedLogins: ['fixture'], paths: { herdrSocket: '/private/test.sock', chrome: '/private/Chrome' } }
  fs.writeFileSync(configPath, JSON.stringify(config)); fs.writeFileSync(bridgePath, 'ORIGINAL\n')
  let restarts = 0
  return { dir, config, configPath, bridgePath, readConfig: () => JSON.parse(fs.readFileSync(configPath)),
    write: (p, s) => fs.writeFileSync(p, s), bridgeText: c => `TERMINAL_BACKEND=${c.terminalBackend}\n`,
    findWezterm: () => '/Applications/WezTerm.app/Contents/MacOS/wezterm', running: () => running,
    restart: () => { restarts++ }, get restarts() { return restarts } }
}
test('switching a stopped service preserves unrelated settings and does not start it', t => {
  const f = fixture(t)
  assert.equal(changeTerminal({ ...f, backend: 'wezterm' }), true)
  const changed = f.readConfig()
  assert.deepEqual(changed.modules, f.config.modules); assert.deepEqual(changed.allowedLogins, f.config.allowedLogins)
  assert.equal(changed.paths.herdrSocket, f.config.paths.herdrSocket)
  assert.equal(changed.paths.chrome, f.config.paths.chrome)
  assert.match(fs.readFileSync(f.bridgePath, 'utf8'), /wezterm/)
  assert.equal(f.restarts, 0)
})
test('a running service applies the backend through restart; same selection is a no-op', t => {
  const f = fixture(t, true)
  changeTerminal({ ...f, backend: 'wezterm' }); assert.equal(f.restarts, 1)
  assert.equal(changeTerminal({ ...f, backend: 'wezterm' }), false); assert.equal(f.restarts, 1)
})
test('failed restart restores both files and restarts the previous configuration', t => {
  const f = fixture(t, true); let calls = 0
  assert.throws(() => changeTerminal({ ...f, backend: 'wezterm', restart: () => { if (++calls === 1) throw new Error('launch failed') } }), /launch failed/)
  assert.deepEqual(f.readConfig(), f.config); assert.equal(fs.readFileSync(f.bridgePath, 'utf8'), 'ORIGINAL\n'); assert.equal(calls, 2)
})
test('failed second write restores the original config', t => {
  const f = fixture(t); let failed = false
  assert.throws(() => changeTerminal({ ...f, backend: 'wezterm', write: (p, s) => {
    if (p === f.bridgePath && !failed) { failed = true; throw new Error('disk failure') }
    fs.writeFileSync(p, s)
  } }), /disk failure/)
  assert.deepEqual(f.readConfig(), f.config); assert.equal(f.restarts, 0)
})
test('reject missing WezTerm and invalid backend before changing files', t => {
  const f = fixture(t)
  assert.throws(() => changeTerminal({ ...f, backend: 'wezterm', findWezterm: () => '' }), /not found/)
  assert.throws(() => changeTerminal({ ...f, backend: 'other' }), /Usage/)
  assert.deepEqual(f.readConfig(), f.config)
})
test('find the actual Serve mapping, including nondefault HTTPS ports', () => {
  assert.equal(servedURL({ Web: { 'other.test:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } }, 'ours.test:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787/' } } } } }, 8787), 'https://ours.test:8443/')
  assert.equal(servedURL({}, 8787), null)
})
test('CLI JSON status probes the static page, without touching any /api activity endpoint', async t => {
  const f = fixture(t); const requests = []
  const server = http.createServer((req, res) => { requests.push([req.method, req.url]); res.writeHead(200); res.end() })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close())
  fs.writeFileSync(f.configPath, JSON.stringify({ ...f.config, port: server.address().port }))
  const launchctl = path.join(f.dir, 'launchctl'); fs.writeFileSync(launchctl, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const { stdout } = await exec(process.execPath, ['lib/cli.mjs', 'status', '--json'], { env: { ...process.env, PANE_REMOTE_CONFIG: f.configPath, PANE_REMOTE_LAUNCHCTL: launchctl } })
  const status = JSON.parse(stdout)
  assert.equal(status.loaded, false); assert.equal(status.response, 200); assert.equal(status.backend, 'herdr')
  assert.deepEqual(requests, [['GET', '/']]); assert.ok(!stdout.includes('allowedLogins'))
})

test('CLI backend change restarts host and server through launchctl and persists bridge settings', async t => {
  const f = fixture(t)
  fs.writeFileSync(f.configPath, JSON.stringify({ ...f.config, paths: { ...f.config.paths, wezterm: '/fixture/wezterm' } }))
  const launchctl = path.join(f.dir, 'launchctl'), calls = path.join(f.dir, 'calls')
  fs.writeFileSync(launchctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_LAUNCH_CALLS"\nexit 0\n', { mode: 0o700 })
  await exec(process.execPath, ['lib/cli.mjs', 'terminal', 'wezterm'], { env: { ...process.env, PANE_REMOTE_CONFIG: f.configPath, PANE_REMOTE_LAUNCHCTL: launchctl, TEST_LAUNCH_CALLS: calls } })
  const operations = fs.readFileSync(calls, 'utf8')
  assert.match(operations, /kickstart -k gui\/\d+\/local.pane-remote.host/)
  assert.match(operations, /kickstart -k gui\/\d+\/local.pane-remote.server/)
  assert.match(fs.readFileSync(f.bridgePath, 'utf8'), /TERMINAL_BACKEND=wezterm\nWEZTERM=\/fixture\/wezterm/)
})
test('CLI reports stop/restart launchctl failures instead of false success', async t => {
  const f = fixture(t), launchctl = path.join(f.dir, 'launchctl')
  fs.writeFileSync(launchctl, '#!/bin/sh\nif [ "$1" = print ]; then exit 0; fi\necho "fixture denied" >&2\nexit 1\n', { mode: 0o700 })
  for (const command of ['stop', 'restart']) {
    await assert.rejects(exec(process.execPath, ['lib/cli.mjs', command], { env: { ...process.env, PANE_REMOTE_CONFIG: f.configPath, PANE_REMOTE_LAUNCHCTL: launchctl } }), error => error.code === 1 && error.stderr.includes('fixture denied'))
  }
})

test('CLI JSON status uses the server default port for configs that omit port', async t => {
  const f = fixture(t), launchctl = path.join(f.dir, 'launchctl'), preload = path.join(f.dir, 'http-fixture.mjs')
  const { port, ...config } = f.config
  fs.writeFileSync(f.configPath, JSON.stringify(config))
  fs.writeFileSync(launchctl, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  // Intercept the real CLI request without binding the user's actual default port.
  fs.writeFileSync(preload, `import http from 'node:http'; import { EventEmitter } from 'node:events'; import assert from 'node:assert/strict';
    http.request = (options, done) => {
      assert.equal(options.port, 8787); assert.equal(options.path, '/');
      const req = new EventEmitter(); req.end = () => done({ resume() {}, statusCode: 200 }); return req;
    };`)
  const { stdout } = await exec(process.execPath, ['--import', preload, 'lib/cli.mjs', 'status', '--json'], { env: { ...process.env, PANE_REMOTE_CONFIG: f.configPath, PANE_REMOTE_LAUNCHCTL: launchctl } })
  const status = JSON.parse(stdout)
  assert.equal(status.loaded, true); assert.equal(status.response, 200)
})
