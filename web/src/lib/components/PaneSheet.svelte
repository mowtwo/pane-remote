<script lang="ts">
  import { load } from '$lib/lazy'
  // 会话列表：WezTerm 的 pane（按窗口 / 标签页分组）和 Cursor 的会话（按项目分组）合在一起；点行打开，pane 点 ⋯ 管理。
  // 状态标记统一：等你操作 / 做完了 / 运行中 / 蓝点 = 有新内容
  import { onDestroy, untrack } from 'svelte'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Plus from '@lucide/svelte/icons/plus'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import X from '@lucide/svelte/icons/x'
  import Folder from '@lucide/svelte/icons/folder'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { label, terminalAgentLabel, workspaceLabel, type Pane } from '$lib/api'
  import { ui, loadPanes, pollStates, select, setStatus } from '$lib/session.svelte'
  import { cur, holdCursor, startDraft } from '$lib/cursor/cursor.svelte'
  import { cursorSessions, type SessionStatus } from '$lib/sessions.svelte'
  import CursorIcon from '$lib/cursor/CursorIcon.svelte'
  import { route, go, cursorView } from '$lib/router.svelte'
  import { appConfig } from '$lib/appConfig.svelte'
  import { cn } from '$lib/utils'
  import { t as tt, tr } from '$lib/i18n'

  let { open = $bindable(false), inline = false, onactions, oncreate, onreconnect }: {
    open?: boolean
    /** 电脑版：常驻在左边的侧栏，不是抽屉 */
    inline?: boolean
    onactions: (p: Pane) => void
    onreconnect: () => Promise<void>
    oncreate: (t: { window?: number | string; dir?: string }) => void
  } = $props()

  let loading = $state(false)
  let collapsed = $state<Record<string, boolean>>({})
  // Selecting a pane elsewhere must reveal its containing workspace.
  $effect(() => {
    const pane = ui.current
    untrack(() => {
      const current = ui.panes.find((p) => String(p.pane) === pane)
      if (current) collapsed[String(current.window)] = false
    })
  })
  async function refresh() {
    loading = true
    pollStates()
    try { await loadPanes() } catch (e) { setStatus('err', (e as Error).message) } finally { loading = false }
  }
  // 打开时刷新 pane 列表，并接上 Cursor 的推送连接拿项目 / 会话列表（只要列表，不改电脑那边盯着的会话；没开 Cursor 模块就不接）
  let release: (() => void) | null = null
  const shown = $derived(open || inline)
  $effect(() => {
    if (!shown) return
    untrack(() => { refresh(); if (appConfig.modules.cursor) release = holdCursor('list') })
    // 侧栏一直开着：隔一会儿悄悄刷新一次列表（新开、关掉的 pane）
    const timer = inline ? setInterval(() => loadPanes().catch(() => {}), 15000) : undefined
    return () => { release?.(); release = null; clearInterval(timer) }
  })
  onDestroy(() => release?.())

  const groups = $derived.by(() => {
    const out: { window: number | string; workspace: string; dir: string; tabs: { tab: number | string; title: string; panes: Pane[] }[] }[] = []
    for (const p of ui.panes) {
      let w = out.find((g) => g.window === p.window)
      if (!w) out.push((w = { window: p.window, workspace: p.workspace, dir: p.dir, tabs: [] }))
      let t = w.tabs.find((x) => x.tab === p.tab)
      if (!t) w.tabs.push((t = { tab: p.tab, title: p.tabTitle, panes: [] }))
      t.panes.push(p)
    }
    return out
  })
  const curPane = () => ui.panes.find((p) => String(p.pane) === ui.current)
  const onPane = $derived(route.view.kind === 'pane')
  const onCursor = $derived(route.view.kind === 'cursor')

  function openCursor(id: string) {
    go(cursorView(id))
  }
  function newCursor(project: string) {
    startDraft(project)
    go(cursorView(''))
  }
</script>

{#snippet badge(state: SessionStatus | undefined, unread: boolean, current: boolean)}
  {#if state === 'waiting'}
    <span class="flex-none rounded-full bg-warn/20 px-1.5 py-px text-[11px] font-medium text-warn">{tt('等你操作')}</span>
  {:else if state === 'done'}
    <span class="flex-none rounded-full bg-ok/15 px-1.5 py-px text-[11px] font-medium text-ok">{tt('做完了')}</span>
  {:else if state === 'running'}
    <span class="flex-none rounded-full bg-primary/15 px-1.5 py-px text-[11px] font-medium text-primary">{tt('运行中')}</span>
  {:else if state === 'error'}
    <span class="flex-none rounded-full bg-destructive/15 px-1.5 py-px text-[11px] font-medium text-destructive">{tt('出错')}</span>
  {/if}
  {#if unread && !current}
    <span class="size-2 flex-none rounded-full bg-primary" title={tt('有新内容')}></span>
  {/if}
{/snippet}

<!-- 高度上限 85%，上方始终留一块空白可以点着关闭。以前写的 max-h-[85dvh] 压不过底层组件的全屏上限（那条是 data-[…] 写法，优先级更高），
     会话多了（加上 Cursor 的会话、用量卡片后加载出来）抽屉就长到几乎整屏（894 高的屏幕上 886），上面没地方点，
     往下拖又只能拖很窄的标题栏，有时只能选一个会话才关得掉。另外加了明确的关闭按钮；只让列表自己滚 -->
{#snippet actions()}
        <!-- 手动重连当前 pane（自动重连之外的兜底），顺带刷新列表 -->
        <Button variant="outline" size="sm" class="rounded-full" disabled={!ui.current || loading} onclick={async () => { loading = true; try { await onreconnect(); await refresh() } finally { loading = false } }}>
          <RefreshCw class={cn(loading && 'animate-spin')} /> {tt('重连')}
        </Button>
        <Button size="sm" class="rounded-full" onclick={() => oncreate({ window: curPane()?.window, dir: curPane()?.dir })}>
          <Plus /> {tt('新建')}
        </Button>
{/snippet}

{#snippet list()}
      {#if !ui.panes.length}
        <p class="p-6 text-center text-sm text-muted-foreground">{loading ? tt('读取中…') : tt('没有 pane')}</p>
      {/if}
      {#if ui.panes.some((p) => p.backend === 'herdr')}
        <p class="px-3 pt-3 text-xs font-medium text-muted-foreground">Herdr · {tt('工作区')}</p>
      {/if}
      {#each groups as g, groupIndex (g.window)}
        {@const herdr = g.tabs[0]?.panes[0]?.backend === 'herdr'}
        {@const groupName = workspaceLabel(g.tabs[0].panes[0], groupIndex)}
        {@const members = g.tabs.flatMap((tab) => tab.panes)}
        {@const agents = members.filter((p) => p.terminalAgent).length}
        <section data-workspace-id={g.window} aria-label={groupName}>
        <div class="mt-3 flex items-center justify-between gap-2 border-t px-2.5 pt-3 pb-1 text-xs text-muted-foreground">
          <button class="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" aria-expanded={!collapsed[String(g.window)]} onclick={() => collapsed[String(g.window)] = !collapsed[String(g.window)]}>
            <ChevronDown class={cn('size-3.5 shrink-0 transition-transform', collapsed[String(g.window)] && '-rotate-90')} />
            <Folder class="size-3.5 shrink-0" />
            <span class="min-w-0"><span class="block truncate text-sm font-semibold text-foreground" title={groupName}>{groupName}</span>
              <span class="block text-[11px]">{herdr ? tt('{n} 个 agent · {m} 个终端', { n: agents, m: members.length - agents }) : tt('{n} 个 pane', { n: members.length })}</span>
            </span>
          </button>
          <Button variant="ghost" size="xs" class="text-primary" onclick={() => oncreate({ window: g.window, dir: g.dir })}>{tt('＋ 标签页')}</Button>
        </div>
        {#if !collapsed[String(g.window)]}
        <div class="ml-5 border-l pl-2">
        {#each g.tabs as t, tabIndex (t.tab)}
          {@const namedTab = t.title && !/^\d+$/.test(t.title) && t.title !== String(t.tab)}
          {#if herdr || g.tabs.length > 1 || namedTab}
            <div class="truncate px-4 pt-2 pb-1 text-xs text-muted-foreground" title={t.title}>
              {namedTab ? (herdr ? `${tt('标签页')} · ${t.title}` : t.title) : tt('标签 {tab}', { tab: tabIndex + 1 })}
            </div>
          {/if}
          {#each t.panes as p, paneIndex (p.pane)}
            {@const current = onPane && String(p.pane) === ui.current}
            {@const sameName = t.panes.filter((other) => label(other) === label(p)).length > 1}
            <div class="flex items-stretch gap-1">
              <button
                data-pane-id={p.pane}
                aria-current={current ? 'true' : undefined}
                class={cn('grid min-w-0 flex-1 gap-0.5 rounded-[10px] border-l-2 py-2.5 pr-2.5 pl-4 text-left active:bg-accent', current ? 'border-primary bg-accent' : 'border-transparent')}
                onclick={() => { open = false; select(p.pane) }}
              >
                {#if herdr}
                  <span class="flex min-w-0 items-center gap-1.5 text-[11px]" data-testid="agent-identity">
                    <span class={cn('shrink-0 rounded px-1.5 py-px font-medium', p.terminalAgent ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground')}>{terminalAgentLabel(p)}</span>
                    {#if p.terminalAgent?.name}<span class="min-w-0 flex-1 truncate text-muted-foreground" title={p.terminalAgent.name}>{p.terminalAgent.name}</span>{/if}
                  </span>
                {/if}
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="min-w-0 flex-1 truncate font-semibold" title={label(p)}>{label(p)}{sameName ? ` · ${paneIndex + 1}` : ''}</span>
                  {@render badge(ui.states[p.pane]?.state, !!ui.states[p.pane]?.unread, current)}
                </span>
                <span class="truncate text-xs text-muted-foreground" title={p.cwd}>{p.cwd.length > 48 ? `…/${p.cwd.split('/').filter(Boolean).slice(-2).join('/')}` : p.cwd}</span>
                {#if ui.states[p.pane]?.prompt}
                  <span class="truncate text-xs text-warn">{ui.states[p.pane].prompt}</span>
                {/if}
              </button>
              <button class="grid w-11 place-items-center rounded-[10px] text-muted-foreground active:bg-accent" aria-label={tt('{name} 操作', { name: label(p) })} onclick={() => onactions(p)}>
                <Ellipsis class="size-5" />
              </button>
            </div>
          {/each}
        {/each}
        </div>
        {/if}
        </section>
      {/each}

      <!-- Cursor：电脑上 Cursor IDE 的 Agent 会话，一个项目一组（开了 Cursor 模块才有） -->
      {#if appConfig.modules.cursor}
      <div class="mt-2 flex items-center justify-between gap-2 border-t px-2.5 pt-3.5 pb-1 text-xs text-muted-foreground" data-testid="cursor-group">
        <span class="flex min-w-0 items-center gap-1.5"><CursorIcon class="size-3.5 flex-none text-foreground" /><span class="truncate">Cursor</span>
          {#if cur.conn !== 'ready'}<span class="truncate">· {tr(cur.msg) || (cur.conn === 'not-running' ? tt('电脑上的 Cursor 没有打开') : tt('还没接入 Cursor'))}</span>{/if}
        </span>
        <Button variant="ghost" size="xs" class="text-primary" onclick={() => newCursor('')}>{tt('＋ 新对话')}</Button>
      </div>
      {#if cur.conn !== 'ready'}
        <button class={cn('flex w-full min-w-0 items-center gap-2 rounded-[10px] py-2.5 pr-2.5 pl-[18px] text-left text-sm active:bg-accent', onCursor && 'bg-accent')} onclick={() => go(cursorView(cur.id))}>
          <span class="min-w-0 flex-1 truncate">{tt('打开 Cursor 页')}</span>
        </button>
      {:else}
        {#if shown}
          {#await load(() => import('$lib/cursor/UsageCard.svelte')) then M}<M.default />{/await}
        {/if}
        {#each cur.projects as p (p.id)}
          {#if p.sessions.length || p.uri}
            <div class="flex items-center justify-between gap-2 px-3.5 pt-1.5 pb-0.5 text-xs text-muted-foreground">
              <span class="truncate">{tr(p.label)}</span>
              {#if p.uri}<button class="flex flex-none items-center gap-0.5 rounded px-1.5 py-0.5 text-primary active:bg-accent" onclick={() => newCursor(p.id)}><Plus class="size-3" />{tt('新 Agent')}</button>{/if}
            </div>
            {#each p.sessions as s (s.id)}
              {@const current = onCursor && s.id === cur.id}
              <button class={cn('grid w-full min-w-0 gap-0.5 rounded-[10px] border-l-2 py-2.5 pr-2.5 pl-4 text-left active:bg-accent', current ? 'border-primary bg-accent' : 'border-transparent')} onclick={() => openCursor(s.id)}>
                <span class="flex min-w-0 items-center gap-1.5">
                  <CursorIcon class="size-3.5 flex-none text-muted-foreground" />
                  <span class={cn('truncate', s.unread ? 'font-semibold' : 'font-medium')}>{s.title || tt('无标题')}</span>
                  {@render badge(cursorSessions.status(s.id), !!s.unread, current)}
                  {#if s.active}<span class="flex-none rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">{tt('电脑上开着')}</span>{/if}
                  <span class="ml-auto flex-none text-xs text-muted-foreground">{s.age}</span>
                </span>
              </button>
            {/each}
          {/if}
        {:else}
          <p class="p-4 text-center text-sm text-muted-foreground">{tt('没有会话')}</p>
        {/each}
      {/if}
      {/if}
{/snippet}

{#if inline}
  <aside class="flex w-72 flex-none flex-col border-r bg-card" data-testid="session-sidebar">
    <div class="flex items-center justify-between gap-1.5 border-b px-3 py-2">
      <span class="font-semibold">{tt('会话列表')}</span>
      <div class="flex items-center gap-1.5">{@render actions()}</div>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2" data-testid="session-list">{@render list()}</div>
  </aside>
{:else}
<Drawer.Root bind:open>
  <Drawer.Content class="max-h-[85dvh] data-[vaul-drawer-direction=bottom]:max-h-[85dvh] overflow-hidden">
    <Drawer.Header class="flex-row items-center justify-between border-b py-3">
      <Drawer.Title>{tt('会话列表')}</Drawer.Title>
      <div class="flex items-center gap-1.5">
        {@render actions()}
        <Button variant="ghost" size="icon-sm" class="rounded-full" aria-label={tt('关闭')} onclick={() => (open = false)}><X /></Button>
      </div>
    </Drawer.Header>
    <div data-vaul-no-drag class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-[calc(env(safe-area-inset-bottom)+8px)]" data-testid="session-list">
      {@render list()}
    </div>
  </Drawer.Content>
</Drawer.Root>
{/if}
