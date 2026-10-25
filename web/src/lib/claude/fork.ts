// 分叉会话：带着某个 pane 里 Claude / Codex 会话的全部上下文，在新 pane 里开一个新会话（原会话不受影响）。
// 会话操作面板、pane 菜单、拆分页面都用这里
import { manage } from '$lib/api'
import { prefs } from '$lib/prefs.svelte'

export type Where = 'right' | 'bottom' | 'tab'
export type PaneSession = { agent?: string; session?: string } | null

/** 这个 pane 里能不能分叉（有会话，且 agent 支持） */
export async function paneSession(pane: number | string): Promise<PaneSession> {
  try {
    const r = await fetch(`api/claude?pane=${pane}`, { cache: 'no-store' })
    const d = r.ok ? await r.json() : null
    return d?.session ? d : null
  } catch { return null }
}
export const canFork = (s: PaneSession) => !!s?.session && s.agent !== 'cursor-agent'

export async function forkPane(pane: number | string, where: Where) {
  return manage<{ pane: number | string }>('claude', { pane: pane, mode: 'fork', where, inject: prefs.inject })
}
