<script lang="ts">
  // 新建标签页 / 拆分：全屏页面（不是底部抽屉），高度跟着键盘走，目录建议列表占满键盘上方的剩余空间。
  // 正在填目录时，位置和启动命令两栏先收起来，给建议列表腾地方。
  // 目录下有 Claude 会话时，底下列出最近的几个：点一条就改成恢复那个会话（已经开在某个 pane 里的直接切过去）。
  import { untrack } from 'svelte'
  import X from '@lucide/svelte/icons/x'
  import Folder from '@lucide/svelte/icons/folder'
  import History from '@lucide/svelte/icons/history'
  import Check from '@lucide/svelte/icons/check'
  import { Button } from '$lib/components/ui/button'
  import { manage, fetchSessions, workspaceLabel, label, type CreateTarget, type ClaudeSession } from '$lib/api'
  import { prefs } from '$lib/prefs.svelte'
  import { ui, loadPanes, select } from '$lib/session.svelte'
  import { cn } from '$lib/utils'
  import { paneSession, canFork, forkPane } from '$lib/claude/fork'
  import { appConfig } from '$lib/appConfig.svelte'
  import { t, tr, isEn } from '$lib/i18n'

  let { open = $bindable(false), target, ondone }: { open?: boolean; target: CreateTarget; ondone: () => void } = $props()

  // 启动命令：服务端配置里的（init 时按本机装了哪些 agent 生成），前后加上「只开 shell」和「自定义」
  const PRESETS = $derived([
    { v: '', label: t('只开 shell') },
    ...appConfig.presets.map((p) => ({ v: p.command, label: tr(p.label) })),
    { v: '__custom', label: t('自定义…') },
  ])
  let known = $state<{ dir: string; t: number }[]>([])
  let where = $state('')
  let dir = $state('')
  let cmd = $state('')
  let custom = $state('')
  let err = $state('')
  let busy = $state(false)
  let dirFocus = $state(false)
  // 拆分的那个 pane 里有会话时，多一个「分叉这个会话」：不用填目录，新 pane 跟原会话在同一目录
  let forkable = $state(false)
  const presets = $derived(forkable ? [{ v: '__fork', label: t('分叉这个会话') }, ...PRESETS] : PRESETS)
  const isFork = $derived(cmd === '__fork' && forkable && !!target.split)
  let sessions = $state<ClaudeSession[]>([])
  let resume = $state<string | null>(null)

  const windows = $derived([...new Set(ui.panes.map((p) => p.window))])
  const home = $derived((ui.panes.find((p) => p.dir && p.cwd.startsWith('~'))?.dir || '').replace(/^(\/Users\/[^/]+).*/, '$1'))
  const dirs = $derived.by(() => {
    const d = [...new Set([target.dir, ...ui.panes.map((p) => p.dir), ...known.map((k) => k.dir)].filter(Boolean) as string[])]
    if (home && !d.includes(home)) d.push(home)
    return d
  })
  const short = (d: string) => (home && d.startsWith(home) ? '~' + d.slice(home.length) : d)
  const full = (d: string) => (home && (d === '~' || d.startsWith('~/')) ? home + d.slice(1) : d.trim())
  const matches = $derived.by(() => {
    const q = dir.trim().toLowerCase().replace(/^~/, '')
    const exact = dirs.some((d) => short(d).toLowerCase() === dir.trim().toLowerCase())
    return (q && !exact ? dirs.filter((d) => d.toLowerCase().includes(q) || short(d).toLowerCase().includes(q)) : dirs).slice(0, 60)
  })

  // 目录下最近的 Claude 会话：目录变了停 300ms 再查（打字时不连发），回来的结果和当前目录对得上才用
  let sessTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const d = open && !isFork ? full(dir) : ''
    clearTimeout(sessTimer)
    if (!d.startsWith('/')) { sessions = []; resume = null; return }
    sessTimer = setTimeout(() => {
      const done = (s: ClaudeSession[]) => {
        if (full(dir) !== d) return
        sessions = s
        if (resume && !s.some((x) => x.id === resume)) resume = null
      }
      fetchSessions(d).then(done, () => done([]))
    }, 300)
  })
  function pickSession(s: ClaudeSession) {
    if (s.pane != null && ui.panes.some((p) => p.pane === s.pane)) {
      open = false
      ondone()
      select(s.pane)
      return
    }
    resume = resume === s.id ? null : s.id
  }
  // 今天的只显示时间，昨天的带「昨天」，更早的显示日期
  function when(sec: number) {
    const d = new Date(sec * 1000)
    const loc = isEn ? 'en-US' : 'zh-CN'
    const hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const days = Math.round((day(new Date()) - day(d)) / 86400000)
    return days === 0 ? hm : days === 1 ? t('昨天 {time}', { time: hm }) : d.toLocaleDateString(loc, { month: 'numeric', day: 'numeric' })
  }
  const sessionNote = (s: ClaudeSession) =>
    s.pane != null ? t('已在 #{pane} 打开，点一下切过去', { pane: s.pane }) : s.running ? t('在别处运行中，恢复时会分叉一个新会话') : ''

  // 每次打开按目标重置表单（只跟 open 走：目录列表、pane 列表后到时不能冲掉正在填的内容）
  $effect(() => { if (open) untrack(reset) })
  function reset() {
    fetch('api/dirs', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).then((d) => (known = d), () => {})
    where = target.split ? 'split' : target.window != null ? `w${target.window}` : windows[0] != null ? `w${windows[0]}` : 'new'
    dir = short(target.dir || dirs[0] || '')
    const last = prefs.lastCmd
    const preset = PRESETS.some((p) => p.v === last && p.v !== '__custom')
    cmd = preset ? last : last ? '__custom' : ''
    custom = preset ? '' : last
    err = ''
    dirFocus = false
    forkable = false
    sessions = []
    resume = null
    const split = target.split?.pane
    if (split != null) paneSession(split).then((s) => { if (target.split?.pane === split) forkable = canFork(s) })
  }

  async function go() {
    if (isFork) {
      busy = true
      try {
        const { pane } = await forkPane(target.split!.pane, target.direction === 'bottom' ? 'bottom' : 'right')
        open = false
        ondone()
        await loadPanes()
        select(pane)
      } catch (e) { err = t('分叉失败：{msg}', { msg: tr((e as Error).message) }) } finally { busy = false }
      return
    }
    const command = cmd === '__custom' ? custom.trim() : cmd
    const body: Record<string, unknown> = resume ? { dir: full(dir), resume } : { dir: full(dir), command }
    body.inject = prefs.inject
    let action: 'spawn' | 'split' = 'spawn'
    if (where === 'split' && target.split) { action = 'split'; body.pane = target.split.pane; body.direction = target.direction }
    else body.window = where === 'new' ? 'new' : where.slice(1)
    busy = true
    try {
      const { pane } = await manage<{ pane: number | string }>(action, body)
      if (!resume) prefs.lastCmd = command
      open = false
      ondone()
      await loadPanes()
      select(pane)
    } catch (e) {
      err = t('创建失败：{msg}', { msg: tr((e as Error).message) })
    } finally {
      busy = false
    }
  }
  function pick(d: string) {
    dir = short(d)
    dirFocus = false
    ;(document.activeElement as HTMLElement)?.blur()
  }

  const chip = (on: boolean) => cn('h-9 rounded-full border px-3.5 text-sm', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-foreground active:bg-accent')
  const herdr = $derived(ui.panes.some((p) => p.backend === 'herdr'))
  const places = $derived(target.split
    ? [{ v: 'split', label: t(target.direction === 'right' ? '拆分「{name}」（右侧）' : '拆分「{name}」（下方）', { name: label(target.split) }) }]
    : [...windows.map((w, i) => ({ v: `w${w}`, label: t('{name} · 新标签页', { name: workspaceLabel(ui.panes.find((p) => p.window === w)!, i) }) })), { v: 'new', label: t(herdr ? '新工作区' : '新窗口') }])
</script>

{#if open}
  <div class="fixed inset-x-0 top-0 z-50 flex flex-col bg-background pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]" style:height="var(--vvh, 100dvh)">
    <header class="flex flex-none items-center gap-2 border-b bg-card px-2 pt-[calc(env(safe-area-inset-top)+6px)] pb-2">
      <button class="grid size-9 place-items-center rounded-lg active:bg-accent" aria-label={t('取消')} onclick={() => (open = false)}><X class="size-5" /></button>
      <strong class="flex-1 text-center">{target.split ? t('拆分 pane') : t('新建标签页')}</strong>
      <Button size="sm" class="h-9 px-4" disabled={busy || (!isFork && !dir.trim())} onclick={go}>{busy ? t('创建中…') : isFork ? t('分叉') : resume ? t('恢复会话') : t('创建')}</Button>
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-3.5">
      {#if !dirFocus}
        <section class="grid gap-2">
          <span class="text-xs text-muted-foreground">{t('位置')}</span>
          <div class="flex flex-wrap gap-1.5">
            {#each places as p (p.v)}<button class={chip(where === p.v)} onclick={() => (where = p.v)}>{p.label}</button>{/each}
          </div>
        </section>
        <section class="grid gap-2">
          <span class="text-xs text-muted-foreground">{t('启动')}</span>
          <div class="flex flex-wrap gap-1.5">
            {#each presets as p (p.v)}<button class={chip(cmd === p.v && !resume)} onclick={() => { cmd = p.v; resume = null }}>{p.label}</button>{/each}
          </div>
          {#if cmd === '__custom' && !resume}
            <input bind:value={custom} placeholder={t('例如 cursor-agent、grok、npm run dev')} autocapitalize="off" spellcheck="false" class="h-10 rounded-[10px] border bg-background px-3 font-mono outline-none focus:ring-2 focus:ring-ring" />
          {/if}
          {#if cmd || resume || isFork}
            <!-- 只对认得的 agent 生效（服务端按启动命令判断），别的命令原样执行 -->
            <label class="flex items-center gap-2 text-[13px]">
              <input type="checkbox" bind:checked={prefs.inject} class="size-4 accent-primary" />
              <span>{t('注入 pane-remote 工具')}<span class="ml-1 text-xs text-muted-foreground">{t('手机通知 / 提问、预览、跨 pane')}</span></span>
            </label>
          {/if}
        </section>
      {/if}

      {#if isFork}
        <p class="rounded-[10px] bg-secondary px-3 py-2.5 text-sm text-muted-foreground">{t('新 pane 会在 #{pane} 的会话目录里，带着它现在的全部上下文开一个新会话；原会话不受影响。', { pane: target.split?.pane })}</p>
      {:else}
      <section class="flex min-h-0 flex-1 flex-col gap-2">
        <span class="text-xs text-muted-foreground">{t('目录')}</span>
        <div class="flex gap-2">
          <input
            bind:value={dir}
            onfocus={() => (dirFocus = true)}
            placeholder={t('搜索，或直接输入路径（~/ 开头也行）')}
            autocapitalize="off"
            spellcheck="false"
            enterkeyhint="done"
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); dirFocus = false } }}
            class="h-10 min-w-0 flex-1 rounded-[10px] border bg-background px-3 font-mono outline-none focus:ring-2 focus:ring-ring"
          />
          {#if dirFocus}<Button variant="secondary" class="h-10" onclick={() => { dirFocus = false; (document.activeElement as HTMLElement)?.blur() }}>{t('完成')}</Button>{/if}
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[10px] border bg-card">
          {#each matches as d (d)}
            <button
              class={cn('flex w-full items-center gap-2 border-b px-3 py-2.5 text-left last:border-b-0 active:bg-accent', short(d) === dir.trim() && 'bg-accent')}
              onpointerdown={(e) => e.preventDefault()}
              onclick={() => pick(d)}
            >
              <Folder class="size-4 flex-none text-muted-foreground" />
              <span class="min-w-0 truncate font-mono text-[13px]">{short(d)}</span>
            </button>
          {:else}
            <p class="p-4 text-center text-sm text-muted-foreground">{t('没有匹配的目录，直接用输入的路径')}</p>
          {/each}
        </div>
        {#if sessions.length && !dirFocus}
          <span class="mt-1 text-xs text-muted-foreground">{t('最近的 Claude 会话')}</span>
          <div class="max-h-52 flex-none overflow-y-auto overscroll-contain rounded-[10px] border bg-card">
            {#each sessions as s (s.id)}
              {@const note = sessionNote(s)}
              <button
                class={cn('flex w-full items-center gap-2.5 border-b px-3 py-2 text-left last:border-b-0 active:bg-accent', resume === s.id && 'bg-accent')}
                onclick={() => pickSession(s)}
              >
                <History class="size-4 flex-none text-muted-foreground" />
                <span class="grid min-w-0 flex-1">
                  <span class="truncate text-sm">{s.title}</span>
                  <span class="truncate text-xs text-muted-foreground">{when(s.t)}{s.branch && s.branch !== 'HEAD' ? ` · ${s.branch}` : ''}</span>
                  <!-- 状态单独一行：和分支挤一行时总被截掉，而这正是点之前最该看到的 -->
                  {#if note}<span class="text-xs text-primary">{note}</span>{/if}
                </span>
                {#if resume === s.id}<Check class="size-4 flex-none text-primary" />{/if}
              </button>
            {/each}
          </div>
        {/if}
        {#if err}<p class="text-sm text-destructive">{err}</p>{/if}
      </section>
      {/if}
      {#if isFork && err}<p class="text-sm text-destructive">{err}</p>{/if}
    </div>
  </div>
{/if}
