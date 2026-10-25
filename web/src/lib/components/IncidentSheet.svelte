<script lang="ts">
  // 问题报告：列表 → 详情（最近几次、上下文、修复进度）→ 修复 / 忽略 / 不再提醒 / 已解决；手动报告；修复交给谁的设置。
  // 推送点进来会直接打开那一条（incidents.focus）。
  import { untrack } from 'svelte'
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import Settings from '@lucide/svelte/icons/settings'
  import { incidents, pollIncidents, getIncident, incidentAction, reportIncident, setFixer, type Incident, type IncidentSummary } from '$lib/incidents.svelte'
  import { ui, select } from '$lib/session.svelte'
  import { cn } from '$lib/utils'
  import { t, tr } from '$lib/i18n'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let view = $state<'list' | 'detail' | 'report' | 'settings'>('list')
  let cur = $state<Incident | null>(null)
  let busy = $state('')
  let showDone = $state(false)
  let title = $state('')
  let detail = $state('')

  // 只跟着 open 走：focus 清空时不能再触发一次（会把刚打开的详情切回列表）
  $effect(() => {
    if (!open) return
    untrack(() => {
      pollIncidents(true)
      const id = incidents.focus
      incidents.focus = ''
      if (id) openDetail(id)
      else view = 'list'
    })
  })
  const active = (x: IncidentSummary) => x.status === 'open' || x.status === 'fixing'
  const shown = $derived(incidents.list.filter((x) => showDone || active(x)))
  const doneCount = $derived(incidents.list.filter((x) => !active(x)).length)

  const SOURCE: Record<string, string> = { server: t('服务端'), phone: t('手机端'), mac: t('电脑端'), agent: t('agent 报告'), user: t('你报告的'), plugin: t('插件') }
  const STATUS: Record<string, string> = { open: t('待处理'), fixing: t('修复中'), fixed: t('已修复'), resolved: t('已解决'), ignored: t('已忽略') }
  const FIX_STATE: Record<string, string> = { queued: t('排队中'), running: t('修复中'), done: t('完成'), failed: t('没修成'), cancelled: t('已取消') }
  function ago(ms: number) {
    const s = Math.round((Date.now() - ms) / 1000)
    return s < 60 ? t('刚刚') : s < 3600 ? t('{n} 分钟前', { n: Math.round(s / 60) }) : s < 86400 ? t('{n} 小时前', { n: Math.round(s / 3600) }) : t('{n} 天前', { n: Math.round(s / 86400) })
  }
  const time = (ms: number) => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  async function openDetail(id: string) {
    view = 'detail'
    cur = null
    try { cur = await getIncident(id) } catch (e) { toast.error(tr((e as Error).message)); view = 'list' }
  }
  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!cur) return
    busy = action
    try {
      const r = await incidentAction(cur.id, action, extra)
      if (action === 'fix') {
        const f = r.fix || {}
        toast(f.state === 'queued' ? t('已排队：绑定的会话空闲后开始修') : f.pane != null ? t('已交给 #{pane} 去修', { pane: f.pane }) : t('已开始修复'))
      }
      cur = await getIncident(cur.id)
      pollIncidents(true)
    } catch (e) {
      toast.error(t('没成功：{msg}', { msg: tr((e as Error).message) }))
    } finally {
      busy = ''
    }
  }
  async function submitReport() {
    if (!title.trim()) return
    busy = 'report'
    try {
      const inc = await reportIncident(title.trim(), detail.trim(), { pane: ui.current, agent: ui.agent || undefined, screen: `${innerWidth}x${innerHeight}`, ua: navigator.userAgent.slice(0, 120) })
      title = ''
      detail = ''
      toast(t('已记下'))
      await openDetail(inc.id)
    } catch (e) {
      toast.error(t('没成功：{msg}', { msg: tr((e as Error).message) }))
    } finally {
      busy = ''
    }
  }
  async function fixer(patch: Parameters<typeof setFixer>[0]) {
    try { await setFixer(patch) } catch (e) { toast.error(tr((e as Error).message)) }
  }
  const chip = (on: boolean) => cn('h-8 rounded-lg border px-3 text-[13px]', on ? 'border-primary bg-primary/10 font-medium text-primary' : 'bg-card')
  const goPane = (p?: number | string) => { if (p == null) return; open = false; select(String(p)) }
</script>

<Drawer.Root bind:open>
  <Drawer.Content class="max-h-[90dvh]">
    <Drawer.Header class="flex flex-row items-center gap-2 border-b py-3 text-left">
      {#if view !== 'list'}<button class="-ml-1 grid size-8 place-items-center rounded-lg active:bg-accent" aria-label={t('返回')} onclick={() => (view = 'list')}><ChevronLeft class="size-5" /></button>{/if}
      <Drawer.Title class="flex-1">{view === 'report' ? t('报告一个问题') : view === 'settings' ? t('修复交给谁') : view === 'detail' ? t('问题详情') : t('问题报告')}</Drawer.Title>
      {#if view === 'list'}<button class="grid size-8 place-items-center rounded-lg active:bg-accent" aria-label={t('修复交给谁')} onclick={() => (view = 'settings')}><Settings class="size-4" /></button>{/if}
    </Drawer.Header>
    <!-- [&>*]:min-w-0：网格的子元素默认不肯比内容窄，上下文里一长串没空格的 JSON 会把整个面板撑得比屏幕宽 -->
    <div data-vaul-no-drag class="grid gap-2.5 overflow-x-hidden overflow-y-auto overscroll-contain p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] [&>*]:min-w-0">
      {#if view === 'list'}
        {#each shown as x (x.id)}
          <button class="grid gap-0.5 rounded-xl border bg-card p-3 text-left active:bg-accent" onclick={() => openDetail(x.id)}>
            <span class="flex items-center gap-2">
              {#if x.severity === 'high'}<span class="size-2 flex-none rounded-full bg-destructive"></span>{/if}
              <span class="min-w-0 flex-1 truncate font-medium">{x.title}</span>
              <span class={cn('flex-none text-xs', x.status === 'open' ? 'text-warn' : x.status === 'fixing' ? 'text-primary' : 'text-muted-foreground')}>{STATUS[x.status]}</span>
            </span>
            {#if x.ai?.summary}<span class="truncate text-[13px]">{x.ai.summary}</span>{/if}
            <span class="truncate text-xs text-muted-foreground">{SOURCE[x.source] || x.source} · {x.component}{x.count > 1 ? ` · ${t('{n} 次', { n: x.count })}` : ''} · {ago(x.last)}{x.muted ? ` · ${t('不再提醒')}` : ''}</span>
            {#if x.fix?.state}<span class="truncate text-xs text-primary">{FIX_STATE[x.fix.state] || x.fix.state}{x.fix.pane != null ? ` · #${x.fix.pane}` : ''}{x.fix.last?.note ? ` · ${x.fix.last.note}` : ''}</span>{/if}
          </button>
        {:else}
          <p class="p-5 text-center text-sm text-muted-foreground">{t('现在没有要处理的问题')}</p>
        {/each}
        {#if doneCount}<button class="text-center text-xs text-muted-foreground" onclick={() => (showDone = !showDone)}>{showDone ? t('只看待处理的') : t('显示已处理的（{n}）', { n: doneCount })}</button>{/if}
        <Button variant="secondary" onclick={() => (view = 'report')}>{t('报告一个问题')}</Button>
      {:else if view === 'detail'}
        {#if !cur}
          <p class="p-5 text-center text-sm text-muted-foreground">…</p>
        {:else}
          <section class="grid gap-1">
            <p class="font-semibold [overflow-wrap:anywhere]">{cur.title}</p>
            <p class="text-xs text-muted-foreground">{SOURCE[cur.source] || cur.source} · {cur.component} · {cur.kind} · {STATUS[cur.status]}{cur.regressed ? ` · ${t('修好后又出现')}` : ''}</p>
            <p class="text-xs text-muted-foreground">{t('{n} 次，第一次 {first}，最近 {last}', { n: cur.count, first: time(cur.first), last: time(cur.last) })}</p>
            {#if cur.ai?.summary}
              <div class="mt-1 rounded-lg bg-primary/5 px-2.5 py-2 text-[13px]">
                <p>{cur.ai.summary}</p>
                {#if cur.ai.cause}<p class="mt-0.5 text-xs text-muted-foreground">{t('可能原因：{c}', { c: cur.ai.cause })}</p>{/if}
                {#if cur.ai.duplicateOf}<button class="mt-0.5 text-xs text-primary" onclick={() => openDetail(cur?.ai?.duplicateOf || '')}>{t('可能和另一个问题重复，点开看')}</button>{/if}
                <p class="mt-0.5 text-[11px] text-muted-foreground">{t('AI 分类：{agent} · {model}', { agent: cur.ai.agent || '?', model: cur.ai.model || '?' })}{cur.ai.severity ? ` · ${cur.ai.severity}` : ''}</p>
              </div>
            {:else if cur.ai?.error || cur.ai?.skipped}
              <p class="text-[11px] text-muted-foreground">{t('AI 分类没做：{why}', { why: tr(cur.ai.skipped || cur.ai.error || '') })}</p>
            {/if}
            {#if cur.reporter?.pane != null}<button class="justify-self-start text-xs text-primary" onclick={() => goPane(cur?.reporter?.pane ?? undefined)}>{t('报告方：{agent} · #{pane}', { agent: cur.reporter.agent || '?', pane: cur.reporter.pane })}</button>{/if}
          </section>
          {#if cur.fix}
            <section class="grid gap-1 rounded-xl border bg-card p-3">
              <span class="flex items-center gap-2 text-sm font-medium">
                {t('修复')}：{FIX_STATE[cur.fix.state || ''] || cur.fix.state}
                {#if cur.fix.pane != null}<button class="text-xs font-normal text-primary" onclick={() => goPane(cur?.fix?.pane)}>#{cur.fix.pane}</button>{/if}
                <span class="text-xs font-normal text-muted-foreground">{cur.fix.mode === 'bound' ? t('绑定的会话') : cur.fix.agent ? t('新开 {agent}', { agent: cur.fix.agent }) : ''}</span>
              </span>
              {#each cur.fix.updates || [] as u, i (i)}
                <p class="text-xs [overflow-wrap:anywhere]"><span class="text-muted-foreground">{time(u.t)}</span> [{u.status}] {u.note}{#if u.branch} · <span class="font-mono">{u.branch}</span>{/if}{#if u.pr} · <a class="text-primary underline" href={u.pr} target="_blank" rel="noreferrer">PR</a>{/if}</p>
              {/each}
            </section>
          {/if}
          <div class="flex flex-wrap gap-1.5">
            {#if cur.status === 'open' || cur.fix?.state === 'failed' || cur.fix?.state === 'cancelled'}
              <Button size="sm" disabled={!!busy} onclick={() => act('fix')}>{busy === 'fix' ? '…' : t('修复')}</Button>
              {#if incidents.config?.bound}<Button size="sm" variant="secondary" disabled={!!busy} onclick={() => act('fix', { mode: 'new' })}>{t('新开 agent 修')}</Button>{/if}
            {/if}
            {#if cur.fix?.state === 'queued' || cur.fix?.state === 'running'}
              <Button size="sm" variant="secondary" disabled={!!busy} onclick={() => act('cancel-fix')}>{t('取消修复')}</Button>
              {#if cur.fix.state === 'queued'}<Button size="sm" variant="secondary" disabled={!!busy} onclick={() => act('fix', { mode: 'new', force: true })}>{t('改为新开 agent')}</Button>{/if}
            {/if}
            {#if cur.status === 'open' || cur.status === 'fixed'}<Button size="sm" variant="secondary" disabled={!!busy} onclick={() => act('resolve')}>{t('已解决')}</Button>{/if}
            {#if cur.status === 'open'}<Button size="sm" variant="secondary" disabled={!!busy} onclick={() => act('ignore')}>{t('忽略')}</Button>{/if}
            {#if cur.status !== 'open' && cur.status !== 'fixing'}<Button size="sm" variant="secondary" disabled={!!busy} onclick={() => act('reopen')}>{t('重新打开')}</Button>{/if}
            {#if incidents.config?.triage?.enabled}<Button size="sm" variant="ghost" disabled={!!busy} onclick={() => act('triage')}>{busy === 'triage' ? t('分类中…') : t('AI 重新分类')}</Button>{/if}
            <Button size="sm" variant="ghost" disabled={!!busy} onclick={() => act(cur?.muted ? 'unmute' : 'mute')}>{cur.muted ? t('恢复提醒') : t('这类不再提醒')}</Button>
          </div>
          <section class="grid gap-2">
            <span class="text-xs text-muted-foreground">{t('最近几次')}</span>
            {#each cur.samples as s, i (i)}
              <details class="rounded-lg border bg-card p-2.5" open={i === 0}>
                <summary class="text-xs text-muted-foreground">{time(s.t)}</summary>
                <pre class="mt-1.5 font-mono text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">{s.msg}{s.detail && s.detail !== s.msg ? `\n\n${s.detail}` : ''}{s.ctx ? `\n\n${JSON.stringify(s.ctx)}` : ''}</pre>
              </details>
            {/each}
          </section>
        {/if}
      {:else if view === 'report'}
        <p class="text-xs text-muted-foreground">{t('pane-remote 哪里不对劲就记一条：会自动带上当前的 pane 和手机信息，之后可以一键交给 agent 修。')}</p>
        <input bind:value={title} placeholder={t('一句话：什么不对')} class="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <textarea bind:value={detail} rows="5" placeholder={t('怎么出现的、看到了什么、本来应该怎样（可选）')} class="rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"></textarea>
        <Button disabled={!title.trim() || busy === 'report'} onclick={submitReport}>{t('记下')}</Button>
      {:else if incidents.config}
        <section class="grid gap-2">
          <span class="text-sm font-medium">{t('交给')}</span>
          <div class="flex flex-wrap gap-1.5">
            <button class={chip(incidents.config.fixer === 'auto')} onclick={() => fixer({ fixer: 'auto' })}>{t('自动')}</button>
            <button class={chip(incidents.config.fixer === 'bound')} disabled={!incidents.config.bound} onclick={() => fixer({ fixer: 'bound' })}>{t('绑定的会话')}</button>
            <button class={chip(incidents.config.fixer === 'new')} onclick={() => fixer({ fixer: 'new' })}>{t('每次新开')}</button>
          </div>
          <p class="text-xs text-muted-foreground">{t('自动：绑定了会话就交给它（它在忙就排队，没在运行就在新标签页恢复它），没绑定就在 pane-remote 仓库新开一个 agent。')}</p>
        </section>
        <section class="grid gap-2">
          <span class="text-sm font-medium">{t('绑定的会话')}</span>
          {#if incidents.config.bound}
            <p class="text-sm">{incidents.config.bound.label || incidents.config.bound.session.slice(0, 8)} <span class="text-xs text-muted-foreground">· {incidents.config.bound.agent}</span></p>
            <Button size="sm" variant="secondary" class="justify-self-start" onclick={() => fixer({ bound: null, fixer: incidents.config?.fixer === 'bound' ? 'auto' : incidents.config?.fixer })}>{t('解除绑定')}</Button>
          {:else}
            <p class="text-xs text-muted-foreground">{t('还没有。在某个 agent 会话的「会话」面板里点「设为修复会话」。')}</p>
          {/if}
        </section>
        {#if incidents.config.triage}
        <section class="grid gap-2">
          <span class="flex items-center gap-2 text-sm font-medium">
            {t('AI 分类')}
            <span class="text-xs font-normal text-muted-foreground">{t('今天 {n}/{max} 次', { n: incidents.config.triageUsage?.n ?? 0, max: incidents.config.triage.daily })}</span>
          </span>
          <div class="flex flex-wrap gap-1.5">
            <button class={chip(incidents.config.triage.enabled)} onclick={() => fixer({ triage: { enabled: !incidents.config?.triage?.enabled } })}>{incidents.config.triage.enabled ? t('开') : t('关')}</button>
            {#each [['auto', t('自动')], ['claude', 'Claude Haiku'], ['codex', 'Codex'], ['cursor-agent', 'Cursor']] as [v, l] (v)}
              <button class={chip(incidents.config.triage.agent === v)} disabled={!incidents.config.triage.enabled} onclick={() => fixer({ triage: { agent: v as 'auto', model: '' } })}>{l}</button>
            {/each}
          </div>
          <p class="text-xs text-muted-foreground">{t('只给第一次出现的新问题用便宜模型分一次类（Claude 用 Haiku，Codex 用账号里最轻的模型，Cursor 用 Composer Fast）：判断严重程度、是不是重复、要不要推，写一句摘要。走你 agent 的订阅额度，每次约 5 千到 1 万 token，每天有上限。')}</p>
          <p class="text-xs text-muted-foreground">{t('中转模式下服务端经 ssh 读不到钥匙串里的 Claude / Cursor 登录：要用它们，在电脑终端里先跑 claude setup-token（或在 Cursor 后台建 API key），再在 pane-remote 目录跑 agent/pane-agent triage-token claude（或 cursor）粘贴进去。没配的话自动模式会换 Codex。')}</p>
        </section>
        {/if}
        <section class="grid gap-2">
          <span class="text-sm font-medium">{t('新开时用哪个 agent')}</span>
          <div class="flex flex-wrap gap-1.5">
            {#each [['auto', t('自动')], ['claude', 'Claude Code'], ['codex', 'Codex'], ['cursor-agent', 'cursor-agent']] as [v, l] (v)}
              <button class={chip(incidents.config.agent === v)} onclick={() => fixer({ agent: v as 'auto' })}>{l}</button>
            {/each}
          </div>
          <p class="text-xs text-muted-foreground">{t('自动：问题是哪家 agent 报的就用哪家，其余用 Claude；电脑上没装就换一个装了的。')}</p>
        </section>
      {/if}
    </div>
  </Drawer.Content>
</Drawer.Root>
