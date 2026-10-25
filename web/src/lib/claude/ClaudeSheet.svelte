<script lang="ts">
  // Claude 会话操作：分叉当前会话到新 pane（带着上下文开一个新会话）、同目录新开 Claude、常用斜杠命令；
  // 没注入 pane-remote 插件的 Claude 会话可以「重启并注入」（Mac 上先存快照，起来后让它按快照恢复后台任务）
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import { manage, sendRaw, postJson } from '$lib/api'
  import { prefs } from '$lib/prefs.svelte'
  import { incidents, setFixer, pollIncidents } from '$lib/incidents.svelte'
  import { ui, loadPanes, select, agentName } from '$lib/session.svelte'
  import { t, tr } from '$lib/i18n'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let busy = $state('')
  const account = $derived(ui.claude?.agent === 'claude' ? (ui.claude?.configDir || '').split('/').pop()?.replace(/^\.claude-?/, '') || t('默认') : '')
  // 各 agent 的常用斜杠命令（不确定支持的就不放）
  const COMMANDS_BY_AGENT: Record<string, string[]> = {
    claude: ['/compact', '/clear', '/context', '/model', '/cost', '/resume', '/rewind', '/agents'],
    codex: ['/compact', '/new', '/model', '/status', '/diff', '/review', '/init'],
  }
  const COMMANDS = $derived(COMMANDS_BY_AGENT[ui.claude?.agent ?? ''] ?? [])
  const canFork = $derived(ui.claude?.agent !== 'cursor-agent')

  async function spawn(mode: 'fork' | 'new', where: 'right' | 'bottom' | 'tab') {
    if (!ui.current) return
    busy = `${mode}-${where}`
    try {
      const { pane } = await manage<{ pane: number | string }>('claude', { pane: ui.current, mode, where, inject: prefs.inject })
      open = false
      toast(mode === 'fork' ? t('已分叉到新 pane（新会话，带着原来的上下文）') : t('已新开 {agent}', { agent: agentName() }))
      await loadPanes()
      select(pane)
    } catch (e) {
      toast.error(t('没成功：{msg}', { msg: tr((e as Error).message) }))
    } finally {
      busy = ''
    }
  }
  function run(c: string) {
    sendRaw(ui.current, c, false)
    sendRaw(ui.current, '\r', false) // 单独一个请求，Claude Code 不会当成粘贴
    open = false
  }
  const WHERE = [['right', t('右侧拆分')], ['bottom', t('下方拆分')], ['tab', t('新标签')]] as const

  // ---------- 重启并注入 ----------
  type AgentInfo = { agent?: string; session?: string; status?: string; injected?: boolean }
  type RestartStatus = { step?: string; done?: boolean; error?: string; warning?: string; background?: number; crons?: number; tasks?: number; injected?: boolean }
  const RESTARTABLE = ['claude', 'codex', 'cursor-agent']
  let agentInfo = $state<AgentInfo | null>(null)
  let restart = $state<RestartStatus | null>(null)
  let armed = $state(false)
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    if (!open || !ui.current || !RESTARTABLE.includes(ui.claude?.agent || '')) { agentInfo = null; armed = false; return }
    const pane = ui.current
    fetch(`api/agent?pane=${pane}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (ui.current === pane) agentInfo = d }, () => {})
  })
  async function startRestart() {
    if (!armed) { armed = true; return }
    armed = false
    const pane = ui.current
    try {
      await postJson('api/agent/restart', { pane: pane, inject: true, confirm: true })
      restart = { step: t('开始') }
      const poll = async () => {
        const r = await fetch(`api/agent/restart?pane=${pane}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null)
        if (r) restart = r
        if (r?.done) {
          if (r.error) toast.error(t('重启没完成：{msg}', { msg: tr(r.error) }))
          else if (r.warning) toast.warning(tr(r.warning))
          else toast(t('已重启并注入 pane-remote 工具'))
          agentInfo = { ...agentInfo, injected: !!r.injected }
          return
        }
        pollTimer = setTimeout(poll, 1500)
      }
      pollTimer = setTimeout(poll, 1000)
    } catch (e) {
      toast.error(t('没成功：{msg}', { msg: tr((e as Error).message) }))
    }
  }
  $effect(() => () => clearTimeout(pollTimer))

  // 设为问题修复会话：pane-remote 自己出问题时交给这个会话（按会话 ID 认，重启后也认得）
  const isBound = $derived(!!ui.claude?.session && incidents.config?.bound?.session === ui.claude.session)
  $effect(() => { if (open) pollIncidents(false) })
  async function bindFixer() {
    const c = ui.claude
    if (!c?.session) return
    try {
      await setFixer(isBound ? { bound: null, fixer: incidents.config?.fixer === 'bound' ? 'auto' : incidents.config?.fixer } : { bound: { session: c.session, agent: c.agent, cwd: c.cwd, configDir: c.configDir, label: `#${ui.current} ${ui.title || ''}`.trim() } })
      toast(isBound ? t('已设为修复会话') : t('已解除'))
    } catch (e) {
      toast.error(t('没成功：{msg}', { msg: tr((e as Error).message) }))
    }
  }
</script>

<Drawer.Root bind:open>
  <Drawer.Content>
    <Drawer.Header class="border-b py-3 text-left">
      <Drawer.Title>{t('{agent} 会话', { agent: agentName() })}</Drawer.Title>
      {#if ui.claude}
        <Drawer.Description class="flex items-center gap-2 font-mono text-xs">
          <span class="truncate">{ui.claude.session.slice(0, 8)}{account ? ` · ${t('账号 {name}', { name: account })}` : ''}</span>
          <button class="text-primary" onclick={() => navigator.clipboard.writeText(ui.claude!.session).then(() => toast(t('已复制会话 ID')))}>{t('复制 ID')}</button>
        </Drawer.Description>
      {/if}
    </Drawer.Header>
    <div data-vaul-no-drag class="grid gap-4 overflow-y-auto overscroll-contain p-3.5 pb-[calc(env(safe-area-inset-bottom)+14px)]">
      {#if canFork}
      <section class="grid gap-2">
        <span class="text-sm font-medium">{t('分叉当前会话')}<span class="ml-1.5 text-xs font-normal text-muted-foreground">{t('新会话带着现在的全部上下文，原会话不受影响')}</span></span>
        <div class="grid grid-cols-3 gap-1.5">
          {#each WHERE as [w, l] (w)}<Button variant="secondary" disabled={!!busy} onclick={() => spawn('fork', w)}>{busy === `fork-${w}` ? '…' : l}</Button>{/each}
        </div>
      </section>
      {/if}
      <section class="grid gap-2">
        <span class="text-sm font-medium">{t('同目录新开 {agent}', { agent: agentName() })}<span class="ml-1.5 text-xs font-normal text-muted-foreground">{t('全新会话')}</span></span>
        <div class="grid grid-cols-3 gap-1.5">
          {#each WHERE as [w, l] (w)}<Button variant="secondary" disabled={!!busy} onclick={() => spawn('new', w)}>{busy === `new-${w}` ? '…' : l}</Button>{/each}
        </div>
      </section>
      {#if agentInfo && RESTARTABLE.includes(agentInfo.agent || '')}
      <section class="grid gap-2">
        <span class="text-sm font-medium">{t('pane-remote 工具')}<span class="ml-1.5 text-xs font-normal text-muted-foreground">{t('让 agent 能给手机发通知、在手机上问你、打开预览、看别的 pane')}</span></span>
        {#if restart && !restart.done}
          <p class="rounded-[10px] bg-secondary px-3 py-2.5 text-sm">{t('重启中：{step}', { step: tr(restart.step || '') })}</p>
        {:else if agentInfo.injected}
          <p class="text-sm text-ok">{t('✓ 这个会话已经注入')}</p>
        {:else}
          <Button variant={armed ? 'destructive' : 'secondary'} disabled={agentInfo.status !== 'idle'} onclick={startRestart}>
            {agentInfo.status !== 'idle' ? t('agent 正在干活，停下后才能重启') : armed ? t('再点一次：重启并注入') : t('重启并注入')}
          </Button>
          <p class="text-xs text-muted-foreground">{t('同一个会话原地重启，上下文不丢。重启前会记下后台命令、子代理、定时任务，起来后只读的自动重建，会改东西的先问你。输入框里没发出去的字会被清掉。')}</p>
        {/if}
      </section>
      {#if ui.claude?.session && ui.claude.cwd}
      <section class="grid gap-1.5">
        <span class="text-sm font-medium">{t('问题修复')}<span class="ml-1.5 text-xs font-normal text-muted-foreground">{t('pane-remote 自己出问题时交给谁修')}</span></span>
        <Button variant="secondary" onclick={bindFixer}>{isBound ? t('✓ 这是修复会话（点一下解除）') : t('设为修复会话')}</Button>
      </section>
      {/if}
      {/if}
      {#if COMMANDS.length}
      <section class="grid gap-2">
        <span class="text-sm font-medium">{t('常用命令')}<span class="ml-1.5 text-xs font-normal text-muted-foreground">{t('发到当前会话')}</span></span>
        <div class="flex flex-wrap gap-1.5">
          {#each COMMANDS as c (c)}<button class="h-9 rounded-lg border bg-secondary px-3 font-mono text-[13px] active:bg-primary active:text-primary-foreground" onclick={() => run(c)}>{c}</button>{/each}
        </div>
      </section>
      {/if}
    </div>
  </Drawer.Content>
</Drawer.Root>
