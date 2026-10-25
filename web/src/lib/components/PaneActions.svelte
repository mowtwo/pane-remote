<script lang="ts">
  import * as Drawer from '$lib/components/ui/drawer'
  import { toast } from 'svelte-sonner'
  import { label, terminalAgentLabel, manage, type Pane } from '$lib/api'
  import { ui, loadPanes, select } from '$lib/session.svelte'
  import { cn } from '$lib/utils'
  import { paneSession, canFork, forkPane, type PaneSession, type Where } from '$lib/claude/fork'
  import { t, tr } from '$lib/i18n'

  let { open = $bindable(false), pane, onopen, onsplit, onrename, onwidth }: {
    open?: boolean
    pane: Pane | null
    onopen: () => void
    onsplit: (p: Pane, direction: 'right' | 'bottom') => void
    onrename: (p: Pane) => void
    onwidth: (p: Pane) => void
  } = $props()

  let armed = $state(false)
  let session = $state<PaneSession>(null)
  let forking = $state('')
  $effect(() => {
    if (!open || !pane) return
    armed = false
    session = null
    const id = pane.pane
    paneSession(id).then((s) => { if (pane?.pane === id) session = s })
  })

  async function fork(where: Where) {
    const p = pane
    if (!p) return
    forking = where
    try {
      const { pane: id } = await forkPane(p.pane, where)
      open = false
      toast(t('已分叉到新 pane（新会话，带着原来的上下文）'))
      await loadPanes()
      select(id)
    } catch (e) { toast.error(t('分叉失败：{msg}', { msg: tr((e as Error).message) })) }
    finally { forking = '' }
  }

  async function act(kind: string) {
    const p = pane
    if (!p) return
    try {
      if (kind === 'open') { open = false; onopen(); select(p.pane) }
      else if (kind === 'right' || kind === 'bottom') { open = false; onsplit(p, kind) }
      else if (kind === 'rename') { open = false; onrename(p) }
      else if (kind === 'width') { open = false; onwidth(p) }
      else if (kind === 'focus') { await manage('focus', { pane: p.pane }); open = false; toast(t('已在电脑上切到这个 pane')) }
      else if (kind === 'kill') {
        // 二次确认：第一次点变红，再点才关（不用系统弹窗）
        if (!armed) { armed = true; return }
        await manage('kill', { pane: p.pane })
        open = false
        toast(t('#{pane} 已关闭', { pane: p.pane }))
        await loadPanes()
        if (String(p.pane) === ui.current && ui.panes[0]) select(ui.panes[0].pane)
      }
    } catch (e) { toast.error(t('操作失败：{msg}', { msg: tr((e as Error).message) })) }
  }

  const item = 'rounded-[10px] px-2.5 py-3 text-left active:bg-accent'
</script>

<Drawer.Root bind:open>
  <Drawer.Content>
    {#if pane}
      <Drawer.Header class="border-b py-3 text-left">
        <Drawer.Title class="truncate">{label(pane)}</Drawer.Title>
        {#if pane.backend === 'herdr'}<p class="text-xs text-muted-foreground">Herdr · {pane.workspace} · {terminalAgentLabel(pane)}{pane.terminalAgent?.name ? ` · ${pane.terminalAgent.name}` : ''}</p>{/if}
        <Drawer.Description class="break-all text-xs">{pane.cwd}</Drawer.Description>
        <p class="font-mono text-xs text-muted-foreground">ID {pane.pane} · {pane.cols}×{pane.rows}</p>
      </Drawer.Header>
      <div class="grid px-2 pt-1 pb-[calc(env(safe-area-inset-bottom)+8px)]">
        {#if canFork(session)}
          <div class="grid gap-1.5 border-b px-2.5 pt-2 pb-3">
            <span class="text-sm">{t('分叉这个会话')}<span class="ml-1.5 text-xs text-muted-foreground">{t('新会话带着全部上下文，原会话不受影响')}</span></span>
            <div class="grid grid-cols-3 gap-1.5">
              {#each [['right', t('右侧')], ['bottom', t('下方')], ['tab', t('新标签')]] as [w, l] (w)}
                <button class="h-9 rounded-lg border bg-secondary text-[13px] active:bg-accent disabled:opacity-50" disabled={!!forking} onclick={() => fork(w as Where)}>{forking === w ? '…' : l}</button>
              {/each}
            </div>
          </div>
        {/if}
        <button class={item} onclick={() => act('open')}>{t('打开')}</button>
        <button class={item} onclick={() => act('right')}>{t('向右拆分')}</button>
        <button class={item} onclick={() => act('bottom')}>{t('向下拆分')}</button>
        {#if pane.capabilities?.width !== false}
        <button class={item} onclick={() => act('width')}>{t('调整电脑上的宽度')}<span class="ml-1.5 text-xs text-muted-foreground">{t('{n} 列', { n: pane.cols })}</span></button>
        {/if}
        <button class={item} onclick={() => act('rename')}>{t('重命名标签页')}</button>
        <button class={item} onclick={() => act('focus')}>{t('在电脑上切到这里')}</button>
        <button class={cn(item, 'text-destructive', armed && 'bg-destructive text-white active:bg-destructive')} onclick={() => act('kill')}>
          {armed ? t('再点一次确认关闭（里面的程序会被结束）') : t('关闭这个 pane')}
        </button>
      </div>
    {/if}
  </Drawer.Content>
</Drawer.Root>
