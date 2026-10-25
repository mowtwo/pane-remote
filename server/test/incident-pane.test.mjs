import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initIncidents, onMacEvent, api, flush } from '../incidents.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-incident-pane-'))
initIncidents({ dataDir: dir, noFixer: true, isTestPane: () => true, notify: async () => ({ sent: 0 }) })
after(() => { flush(); fs.rmSync(dir, { recursive: true, force: true }) })

test('native Herdr IDs remain attached to incident reporters and repair updates', async () => {
  onMacEvent({ op: 'report', source: 'agent', pane: 'wA:pB', agent: 'codex', msg: 'Native pane regression', component: 'test' })
  const { incidents } = await api('GET', '', {}, new URLSearchParams('test'))
  const id = incidents[0].id
  const incident = await api('GET', id)
  assert.equal(incident.reporter.pane, 'wA:pB')
  assert.equal(incident.samples[0].ctx.pane, 'wA:pB')
  onMacEvent({ op: 'update', id, status: 'investigating', pane: 'wC:p1' })
  assert.equal((await api('GET', id)).fix.pane, 'wC:p1')
  onMacEvent({ op: 'update', id, status: 'investigating', pane: 'wC:p1;bad' })
  assert.equal((await api('GET', id)).fix.pane, 'wC:p1')
})
