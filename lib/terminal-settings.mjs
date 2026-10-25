import fs from 'node:fs'

// Persist both files together from the caller's point of view. If a service
// restart fails, restore the previous selection before trying to recover it.
export function changeTerminal({ backend, configPath, bridgePath, readConfig, write, bridgeText, findWezterm, running, restart }) {
  if (!['herdr', 'wezterm'].includes(backend)) throw new Error('Usage: pane-remote terminal herdr|wezterm')
  const cfg = readConfig()
  if (!cfg) throw new Error('Run pane-remote init first.')
  if (cfg.mode && cfg.mode !== 'local') throw new Error('Terminal switching currently supports local mode only.')
  if ((cfg.terminalBackend || 'wezterm') === backend) return false
  const next = { ...cfg, terminalBackend: backend, paths: { ...cfg.paths } }
  if (backend === 'wezterm' && !next.paths.wezterm) next.paths.wezterm = findWezterm()
  if (backend === 'wezterm' && !next.paths.wezterm) throw new Error('WezTerm was not found. Install it or set paths.wezterm first.')
  const env = bridgeText(next) // validate before changing either file
  const oldConfig = fs.readFileSync(configPath, 'utf8')
  const oldBridge = fs.existsSync(bridgePath) ? fs.readFileSync(bridgePath, 'utf8') : null
  const wasRunning = running()
  try {
    write(configPath, JSON.stringify(next, null, 2) + '\n')
    write(bridgePath, env)
    if (wasRunning) restart()
  } catch (error) {
    try {
      write(configPath, oldConfig)
      if (oldBridge === null) fs.rmSync(bridgePath, { force: true }); else write(bridgePath, oldBridge)
      if (wasRunning) restart()
    } catch (recovery) { throw new Error(`${error.message}; recovery failed: ${recovery.message}. Run pane-remote doctor.`) }
    throw error
  }
  return true
}

export function servedURL(status, port) {
  for (const [hostPort, entry] of Object.entries(status?.Web || {})) {
    if (entry?.Handlers?.['/']?.Proxy?.replace(/\/$/, '') !== `http://127.0.0.1:${port}`) continue
    try {
      const url = new URL(`https://${hostPort}/`)
      if (!url.username && !url.password && url.pathname === '/') return url.href
    } catch {}
  }
  return null
}
