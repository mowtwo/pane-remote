<script lang="ts">
  // 会话栏上的「模型 · 思考」芯片：显示当前模型简称和思考等级，点开底部面板选（上面模型列表、下面思考等级分段按钮），替代手打 /model。
  // pane 里的 agent（Claude / Codex / cursor-agent）和 Cursor IDE 会话（cursor=会话 id）都能切。会话忙时变灰，等这一轮停下再切。
  // 接口见 server.mjs 的 /api/agent/model；按键怎么发、怎么确认见 agent/pane-agent 的 MODEL_UI，Cursor 见 agent/cursor-agent.mjs 的 model-set
  // （老版本电脑端对 Cursor 会话回 readOnly，这时只读显示）
  import * as Drawer from '$lib/components/ui/drawer'
  import { toast } from 'svelte-sonner'
  import Cpu from '@lucide/svelte/icons/cpu'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Check from '@lucide/svelte/icons/check'
  import { tick } from 'svelte'
  import { postJson } from '$lib/api'
  import { t, tr } from '$lib/i18n'
  import { cn } from '$lib/utils'

  type Model = { id: string; label: string; efforts: string[]; default?: string }
  type Info = { agent: string; models: Model[]; current: { model: string; id?: string; effort: string }; busy?: boolean; readOnly?: boolean; global?: boolean; error?: string }

  let { pane = '', cursor = '' }: { pane?: string | number; cursor?: string } = $props()

  let info = $state<Info | null>(null)
  let open = $state(false)
  let loading = $state(false)
  let saving = $state(false)
  let pick = $state('')
  let effort = $state('')
  let err = $state('')

  const key = $derived(cursor ? `cursor=${encodeURIComponent(cursor)}` : pane !== '' ? `pane=${pane}` : '')
  async function load(refresh = false) {
    if (!key) return
    const k = key
    loading = true
    try {
      const r = await fetch(`api/agent/model?${k}${refresh ? '&refresh' : ''}`, { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      if (k !== key) return
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      // 读不到（服务端回 {}：bridge 没输出、老版本）就当没有，不显示芯片
      info = d && typeof d === 'object' && d.current && Array.isArray(d.models) ? d : null
    } catch (e) { if (k === key) err = tr((e as Error).message) }
    finally { if (k === key) loading = false }
  }
  // 换了会话：清掉旧的，重新读
  $effect(() => { key; info = null; err = ''; open = false; load() })

  const EFFORT: Record<string, string> = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限' }
  const effortName = (e: string) => (EFFORT[e] ? t(EFFORT[e]) : e)
  // 芯片上的简称：去掉厂商前缀和括号里的说明
  const short = (s: string) => s.replace(/^(Claude|GPT-)\s*/i, (m) => (/gpt/i.test(m) ? 'GPT-' : '')).replace(/\s*\(.*?\)\s*/g, ' ').trim()
  const curModel = $derived(info?.models.find((m) => m.id === info?.current.id) ?? null)
  const chipText = $derived(info?.current.model ? short(curModel?.label || info.current.model) + (info.current.effort ? ` · ${effortName(info.current.effort)}` : '') : '')
  const busy = $derived(!!info?.busy)
  const sel = $derived(info?.models.find((m) => m.id === pick) ?? null)

  function show() {
    if (!info) return
    pick = info.current.id || ''
    effort = info.current.effort || ''
    err = info.error ? tr(info.error) : ''
    open = true
    // 列表长：把当前模型滚到看得见的地方
    tick().then(() => setTimeout(() => document.querySelector('[data-testid=model-list] [data-current]')?.scrollIntoView({ block: 'center' }), 50))
    load() // 打开时再读一次：忙闲、当前值可能变了
  }
  function choose(m: Model) {
    pick = m.id
    if (!m.efforts.includes(effort)) effort = m.efforts.includes(info?.current.effort || '') ? info!.current.effort : m.default && m.efforts.includes(m.default) ? m.default : ''
  }
  async function apply() {
    if (!info || !sel || saving || busy || info.readOnly) return
    saving = true; err = ''
    try {
      const r = await postJson<{ current: { model: string; effort: string } }>('api/agent/model', { ...(cursor ? { cursor } : { pane: pane }), model: sel.id, effort: sel.efforts.length ? effort : '' })
      toast(t('已切换到 {m}', { m: short(sel.label) + (r.current?.effort ? ` · ${effortName(r.current.effort)}` : '') }))
      open = false
      load()
    } catch (e) {
      err = tr((e as Error).message) // 画面末尾服务端也带了（tail），手机上看「原始画面」更直观，这里只提示原因
    } finally { saving = false }
  }
  const unchanged = $derived(!!info && pick === (info.current.id || '') && (effort || '') === (info.current.effort || ''))
</script>

{#if info && (info.current.model || info.models.length)}
  <button class={cn('flex h-8 min-w-0 max-w-[45vw] items-center gap-1.5 rounded-lg border px-2.5 text-[13px] active:bg-accent', busy && 'opacity-50')}
    aria-label={t('模型和思考等级')} data-testid="model-chip" onclick={show}>
    <Cpu class="size-3.5 flex-none text-primary" /><span class="truncate">{chipText || t('模型')}</span>
  </button>
{/if}

<Drawer.Root bind:open>
  <Drawer.Content>
    {#if info}
      <Drawer.Header class="border-b py-3 !text-left">
        <Drawer.Title class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate">{t('模型 · 思考等级')}</span>
          {#if info.agent === 'claude'}
            <button class="grid size-8 place-items-center rounded-lg active:bg-accent" aria-label={t('重新读取模型列表')} disabled={loading || busy} onclick={() => load(true)}><RefreshCw class={cn('size-4', loading && 'animate-spin')} /></button>
          {/if}
        </Drawer.Title>
        <Drawer.Description>
          {#if info.readOnly}{t('Cursor 会话暂时只能看当前模型，切换请在电脑上操作')}
          {:else if busy}{t('会话正在干活，这一轮停下后再切换')}
          {:else if info.agent === 'claude'}{t('只改这个会话，不改新会话的默认模型')}
          {:else if info.agent === 'codex'}{t('只改这个会话，不改 Codex 的默认配置')}
          {:else if info.agent === 'cursor-ide'}{t('Cursor 会同时把它设成新会话的默认模型')}
          {:else if info.global}{t('cursor-agent 没有「只改这个会话」：会同时改掉它的默认模型')}{/if}
        </Drawer.Description>
      </Drawer.Header>
      {#if info.readOnly}
        <div class="grid gap-1 p-3.5 pb-[calc(env(safe-area-inset-bottom)+14px)] text-[14px]">
          <div>{t('模型')}：<span class="font-medium">{info.current.model || '—'}</span></div>
          <div>{t('思考等级')}：<span class="font-medium">{info.current.effort ? effortName(info.current.effort) : '—'}</span></div>
        </div>
      {:else}
        <!-- 单列：上面模型单选列表（自己限高、自己滚，同会话列表的写法），下面思考等级一排分段按钮 -->
        <div class="px-3.5 pt-3">
          <div class="mb-1.5 text-xs font-medium text-muted-foreground">{t('模型')}</div>
          <div data-vaul-no-drag class="max-h-[42dvh] overflow-y-auto overscroll-contain rounded-xl bg-muted/50 p-1" data-testid="model-list">
            {#each info.models as m (m.id)}
              <button class={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[14px] active:bg-accent', pick === m.id && 'bg-background shadow-sm')} data-current={m.id === info.current.id ? '' : undefined} onclick={() => choose(m)}>
                <span class={cn('grid size-4.5 flex-none place-items-center rounded-full border', pick === m.id ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>{#if pick === m.id}<Check class="size-3" strokeWidth={3} />{/if}</span>
                <span class={cn('min-w-0 flex-1 truncate', pick === m.id && 'font-medium')}>{m.label}</span>
                {#if m.id === info.current.id}<span class="flex-none rounded-full bg-primary/10 px-1.5 py-0.5 text-[10.5px] text-primary">{t('当前')}</span>{/if}
              </button>
            {:else}
              <p class="p-3 text-[13px] text-muted-foreground">{loading ? t('读取中…') : t('没读到模型列表')}</p>
            {/each}
          </div>
        </div>
        <div class="px-3.5 pt-3.5 pb-3">
          <div class="mb-1.5 text-xs font-medium text-muted-foreground">{t('思考等级')}</div>
          {#if sel?.efforts.length}
            <div data-vaul-no-drag class="flex gap-1 overflow-x-auto overscroll-contain rounded-xl bg-muted/50 p-1 [scrollbar-width:none]" data-testid="effort-list">
              {#each sel.efforts as e (e)}
                <button class={cn('relative h-9 min-w-14 flex-[1_0_auto] rounded-lg px-2.5 text-[13.5px] whitespace-nowrap active:bg-accent', effort === e ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')} onclick={() => (effort = e)}>
                  {effortName(e)}
                  {#if sel.id === info.current.id && e === info.current.effort}<span class="absolute top-1 right-1 size-1.5 rounded-full bg-primary" aria-label={t('当前')}></span>{/if}
                </button>
              {/each}
            </div>
          {:else}
            <p class="rounded-xl bg-muted/50 px-3 py-2.5 text-[13px] text-muted-foreground" data-testid="effort-list">{sel ? t('这个模型不能调思考等级') : t('先选模型')}</p>
          {/if}
        </div>
        <div class="grid gap-2 border-t px-3.5 pt-3 pb-[calc(env(safe-area-inset-bottom)+14px)]">
          {#if err}<p class="text-[13px] text-destructive">{err}</p>{/if}
          <button class="h-11 rounded-xl bg-primary text-[14px] font-medium text-primary-foreground active:bg-primary/90 disabled:opacity-50"
            disabled={!sel || saving || busy || unchanged || (sel.efforts.length > 0 && !effort)} onclick={apply}>
            {saving ? t('切换中…') : busy ? t('会话在忙') : t('切换')}
          </button>
        </div>
      {/if}
    {/if}
  </Drawer.Content>
</Drawer.Root>
