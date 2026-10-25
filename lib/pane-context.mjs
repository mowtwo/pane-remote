// The hook/MCP identity must match the configured terminal server, not its outer terminal.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPaneId } from './terminal-id.mjs'

export function paneContext(env = process.env) {
  const home = env.HOME || os.homedir()
  const file = env.PANE_REMOTE_BRIDGE_ENV || path.join(path.dirname(env.PANE_REMOTE_CONFIG || path.join(home, '.config/pane-remote/config.json')), 'bridge.env')
  const config = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=')
      if (i > 0) config[line.slice(0, i)] = line.slice(i + 1)
    }
  } catch (e) { if (e.code !== 'ENOENT') return { pane: null, allowTty: false } }
  if ((config.TERMINAL_BACKEND || 'wezterm') === 'herdr') {
    const target = config.HERDR_SOCKET || path.join(home, '.config/herdr/herdr.sock')
    const canonical = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
    if (env.HERDR_SOCKET_PATH && canonical(env.HERDR_SOCKET_PATH) !== canonical(target)) return { pane: null, allowTty: false }
    return { pane: isPaneId(env.HERDR_PANE_ID) && env.HERDR_PANE_ID.startsWith('w') ? env.HERDR_PANE_ID : null, allowTty: true }
  }
  return { pane: /^\d{1,6}$/.test(env.WEZTERM_PANE || '') ? Number(env.WEZTERM_PANE) : null, allowTty: true }
}
